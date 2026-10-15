import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTraffic, classifyHealthStatus, decideWatchdog, initialWatchdogState, isBackstopDue, isLightweightPath,
  restoreWatchdogState, withinStartupGrace, WATCHDOG, type ProbeResult, type WatchdogState,
} from "../src/watchdog.ts";

const healthy: ProbeResult = { healthy: true };
const wedged: ProbeResult = { healthy: false, reason: "timeout" };
const minute = 60_000;

function run(state: WatchdogState, probes: ProbeResult[], start: number, step = minute) {
  const actions: string[] = [];
  let now = start;
  for (const probe of probes) {
    const decision = decideWatchdog(state, probe, now);
    state = decision.state;
    actions.push(decision.action);
    now += step;
  }
  return { state, actions, now };
}

test("health status classification uses OpenBao's unparameterized /v1/sys/health codes", () => {
  assert.deepEqual(classifyHealthStatus(200), { healthy: true });
  assert.deepEqual(classifyHealthStatus(503), { healthy: false, reason: "sealed" });
  assert.deepEqual(classifyHealthStatus(501), { healthy: false, reason: "uninitialized" });
  for (const status of [429, 472, 473]) assert.deepEqual(classifyHealthStatus(status), { healthy: false, reason: "standby" });
  for (const status of [204, 404, 500, 502]) assert.deepEqual(classifyHealthStatus(status), { healthy: false, reason: "unexpected_status" });
});

test("one failed probe is tolerated; consecutive failures trigger exactly one reset", () => {
  const { state, actions } = run(initialWatchdogState(), [wedged, wedged], 1_000_000);
  assert.deepEqual(actions, ["none", "recover"]);
  assert.equal(state.armed, false);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastRecoveryAt, 1_000_000 + minute);
});

test("a failure that persists after the reset escalates at a bounded rate instead of looping", () => {
  const start = 5_000_000;
  const { actions } = run(initialWatchdogState(), Array(40).fill(wedged), start);
  assert.equal(actions.filter(action => action === "recover").length, 1);
  const escalations = actions.flatMap((action, i) => action === "escalate" ? [i] : []);
  assert.deepEqual(escalations, [3, 18, 33]); // first post-reset threshold, then every 15 minutes
  assert.equal(WATCHDOG.escalationRepeatMs, 15 * minute);
});

test("only an observed healthy probe re-arms recovery, and never within 30 minutes of the last reset", () => {
  const start = 9_000_000;
  // Reset, recovers briefly, then wedges again within 30 minutes: escalate, do not reset again.
  const flap = run(initialWatchdogState(), [wedged, wedged, healthy, wedged, wedged], start);
  assert.deepEqual(flap.actions, ["none", "recover", "none", "none", "escalate"]);
  // Once healthy and past the interval, a new incident gets its own single reset.
  const later = run(flap.state, [healthy, wedged, wedged], start + WATCHDOG.minRecoveryIntervalMs + 10 * minute);
  assert.deepEqual(later.actions, ["none", "none", "recover"]);
});

test("persisted watchdog state is validated rather than trusted", () => {
  assert.deepEqual(restoreWatchdogState(undefined), initialWatchdogState());
  assert.deepEqual(restoreWatchdogState("garbage"), initialWatchdogState());
  assert.deepEqual(restoreWatchdogState({ consecutiveFailures: -4, armed: "yes", lastRecoveryAt: 1.5, lastProbeAt: 7, lastEscalationAt: null, lastStartAt: "x" }), {
    consecutiveFailures: 0, armed: true, lastProbeAt: 7, lastFailureAt: null, lastStartAt: null, lastRecoveryAt: null, lastEscalationAt: null,
  });
});

test("proxied requests that time out with no answers count as unhealthy even if health answers", () => {
  assert.deepEqual(applyTraffic(healthy, { answered: 0, timedOut: 3 }), { healthy: false, reason: "requests_timing_out" });
  assert.deepEqual(applyTraffic(healthy, { answered: 1, timedOut: 20 }), healthy);
  assert.deepEqual(applyTraffic(healthy, { answered: 0, timedOut: 2 }), healthy);
  assert.deepEqual(applyTraffic(wedged, { answered: 0, timedOut: 9 }), wedged);
});

test("the alarm backstop only probes when cron probes have stopped arriving", () => {
  const state = { ...initialWatchdogState(), lastProbeAt: 1_000 };
  assert.equal(isBackstopDue(initialWatchdogState(), 1_000), true);
  assert.equal(isBackstopDue(state, 1_000 + minute), false);
  assert.equal(isBackstopDue(state, 1_000 + WATCHDOG.backstopAfterMs), true);
});

test("startup grace only follows a recent transition to healthy and never hides a stopped container", () => {
  const now = 50_000_000;
  assert.deepEqual(withinStartupGrace(wedged, now - 30_000, now), { healthy: false, reason: "starting" });
  assert.deepEqual(withinStartupGrace(wedged, now - WATCHDOG.startupGraceMs, now), wedged);
  assert.deepEqual(withinStartupGrace(wedged, null, now), wedged);
  assert.deepEqual(withinStartupGrace({ healthy: false, reason: "not_running" }, now - 1_000, now), { healthy: false, reason: "not_running" });
  assert.deepEqual(withinStartupGrace(healthy, now - 1_000, now), healthy);
  const state = { ...initialWatchdogState(), consecutiveFailures: 1 };
  const decision = decideWatchdog(state, { healthy: false, reason: "starting" }, now);
  assert.deepEqual(decision, { state: { ...state, lastProbeAt: now }, action: "none" });
});

test("bunched cron events cannot turn one short blip into two counted failures", () => {
  const start = 70_000_000;
  let state = initialWatchdogState();
  const at = (offset: number, probe: ProbeResult) => {
    const decision = decideWatchdog(state, probe, start + offset);
    state = decision.state;
    return decision.action;
  };
  assert.equal(at(0, wedged), "none");
  assert.equal(at(5_000, wedged), "none", "a delayed and an on-time event seconds apart count once");
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(at(44_000, wedged), "none");
  assert.equal(at(WATCHDOG.minFailureSpacingMs, wedged), "recover");
  assert.equal(WATCHDOG.minFailureSpacingMs, 45_000);
});

test("a stopped container is started without spending the reset reserved for a wedge", () => {
  const stopped: ProbeResult = { healthy: false, reason: "not_running" };
  const start = 80_000_000;
  const first = run(initialWatchdogState(), [stopped, stopped], start);
  assert.deepEqual(first.actions, ["none", "start"]);
  assert.equal(first.state.armed, true);
  assert.equal(first.state.lastRecoveryAt, null);
  // A wedge right afterwards still gets its one reset.
  assert.deepEqual(run(first.state, [healthy, wedged, wedged], first.now).actions, ["none", "none", "recover"]);
  // A container that keeps stopping is started once per 30 minutes, then escalated.
  const again = run(first.state, [stopped, stopped], first.now);
  assert.deepEqual(again.actions, ["none", "escalate"]);
  // The streak continues, so the first probe after the interval starts it again.
  const later = run(again.state, [stopped], start + WATCHDOG.minRecoveryIntervalMs + 5 * minute);
  assert.deepEqual(later.actions, ["start"]);
});

test("health-style endpoints are recognised so they cannot mask stalled storage requests", () => {
  for (const path of ["/v1/sys/health", "/v1/sys/seal-status", "/v1/sys/leader", "/v1/sys/health/"]) assert.equal(isLightweightPath(path), true);
  for (const path of ["/v1/myapp/data/production/public", "/v1/auth/approle/login", "/v1/sys/healthz", "/v1/sys/policies/acl"]) {
    assert.equal(isLightweightPath(path), false);
  }
});
