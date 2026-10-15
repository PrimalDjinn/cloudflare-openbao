// Application-owned liveness policy for the singleton OpenBao container.
// The Containers SDK marks a container "healthy" once, when its port first answers,
// and never re-checks it. These rules decide from real OpenBao health probes.

// Bounds proxied requests to response headers. OpenBao's own max_request_duration is 90 seconds.
export const PROXY_TIMEOUT_MS = 30_000;
export const WATCHDOG_STATE_KEY = "bao_watchdog";

export const WATCHDOG = {
  probeTimeoutMs: 5_000,
  verifyTimeoutMs: 20_000,
  failureThreshold: 2,
  // Delayed and on-time cron events can arrive seconds apart; one blip must not count twice.
  minFailureSpacingMs: 45_000,
  // Skip the alarm backstop while cron probes are arriving.
  backstopAfterMs: 150_000,
  minRecoveryIntervalMs: 30 * 60_000,
  escalationRepeatMs: 15 * 60_000,
  // Booting containers and OpenBao's post-unseal setup (about 13 seconds observed).
  startupGraceMs: 120_000,
  heartbeatMs: 30 * 60_000,
  exitGraceMs: 10_000,
  destroyTimeoutMs: 15_000,
  startTimeoutMs: 60_000,
  portReadyTimeoutMs: 45_000,
  // Health can still answer while every proxied request stalls behind storage.
  stalledRequestThreshold: 3,
} as const;

export type ProbeFailure =
  | "starting"
  | "not_running"
  | "timeout"
  | "unreachable"
  | "sealed"
  | "uninitialized"
  | "standby"
  | "unexpected_status"
  | "requests_timing_out";

export type ProbeResult = { healthy: true } | { healthy: false; reason: ProbeFailure };

export type WatchdogAction = "none" | "start" | "recover" | "escalate";

export interface WatchdogState {
  consecutiveFailures: number;
  // One automatic reset per incident; only a healthy probe re-arms it.
  armed: boolean;
  lastProbeAt: number | null;
  lastFailureAt: number | null;
  lastStartAt: number | null;
  lastRecoveryAt: number | null;
  lastEscalationAt: number | null;
}

export interface ProxyTraffic {
  answered: number;
  timedOut: number;
}

export function initialWatchdogState(): WatchdogState {
  return {
    consecutiveFailures: 0, armed: true,
    lastProbeAt: null, lastFailureAt: null, lastStartAt: null, lastRecoveryAt: null, lastEscalationAt: null,
  };
}

// Persisted values come from older code or manual edits; never trust their shape.
export function restoreWatchdogState(value: unknown): WatchdogState {
  const fallback = initialWatchdogState();
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const count = (field: unknown) => Number.isSafeInteger(field) && Number(field) >= 0 ? Number(field) : 0;
  const time = (field: unknown) => Number.isSafeInteger(field) && Number(field) > 0 ? Number(field) : null;
  return {
    consecutiveFailures: count(record.consecutiveFailures),
    armed: typeof record.armed === "boolean" ? record.armed : fallback.armed,
    lastProbeAt: time(record.lastProbeAt),
    lastFailureAt: time(record.lastFailureAt),
    lastStartAt: time(record.lastStartAt),
    lastRecoveryAt: time(record.lastRecoveryAt),
    lastEscalationAt: time(record.lastEscalationAt),
  };
}

// Status codes of an unparameterized GET /v1/sys/health.
export function classifyHealthStatus(status: number): ProbeResult {
  if (status === 200) return { healthy: true };
  if (status === 503) return { healthy: false, reason: "sealed" };
  if (status === 501) return { healthy: false, reason: "uninitialized" };
  if (status === 429 || status === 472 || status === 473) return { healthy: false, reason: "standby" };
  return { healthy: false, reason: "unexpected_status" };
}

// These answer from memory even while storage stalls, so they are not evidence of health.
export function isLightweightPath(pathname: string): boolean {
  return /^\/v1\/sys\/(health|seal-status|leader)\/?$/.test(pathname);
}

export function applyTraffic(result: ProbeResult, traffic: ProxyTraffic): ProbeResult {
  if (result.healthy && traffic.answered === 0 && traffic.timedOut >= WATCHDOG.stalledRequestThreshold) {
    return { healthy: false, reason: "requests_timing_out" };
  }
  return result;
}

// Failures shortly after the container entered "running" (booting) or "healthy" (ports
// answer, post-unseal setup may continue) are neutral: they neither count nor re-arm.
// A stopped container never qualifies, so a loop of failed starts is still counted.
export function withinStartupGrace(result: ProbeResult, bootingSince: number | null, now: number): ProbeResult {
  if (!result.healthy && result.reason !== "not_running" && bootingSince !== null && now - bootingSince < WATCHDOG.startupGraceMs) {
    return { healthy: false, reason: "starting" };
  }
  return result;
}

export function decideWatchdog(previous: WatchdogState, probe: ProbeResult, now: number): { state: WatchdogState; action: WatchdogAction } {
  if (probe.healthy) {
    return { state: { ...previous, consecutiveFailures: 0, armed: true, lastProbeAt: now }, action: "none" };
  }
  const observed = { ...previous, lastProbeAt: now };
  if (probe.reason === "starting") return { state: observed, action: "none" };
  const bunched = previous.consecutiveFailures > 0 && previous.lastFailureAt !== null &&
    now - previous.lastFailureAt < WATCHDOG.minFailureSpacingMs;
  if (bunched) return { state: observed, action: "none" };
  const state = { ...observed, consecutiveFailures: previous.consecutiveFailures + 1, lastFailureAt: now };
  if (state.consecutiveFailures < WATCHDOG.failureThreshold) return { state, action: "none" };

  if (probe.reason === "not_running") {
    // Starting a stopped container is what the next request would do anyway (for example
    // after a deploy's rollout), so it does not use up the reset reserved for a wedge.
    const startedRecently = state.lastStartAt !== null && now - state.lastStartAt < WATCHDOG.minRecoveryIntervalMs;
    if (!startedRecently) return { state: { ...state, consecutiveFailures: 0, lastStartAt: now }, action: "start" };
  } else {
    const recoveredRecently = state.lastRecoveryAt !== null && now - state.lastRecoveryAt < WATCHDOG.minRecoveryIntervalMs;
    if (state.armed && !recoveredRecently) {
      return { state: { ...state, consecutiveFailures: 0, armed: false, lastRecoveryAt: now }, action: "recover" };
    }
  }
  if (state.lastEscalationAt === null || now - state.lastEscalationAt >= WATCHDOG.escalationRepeatMs) {
    return { state: { ...state, lastEscalationAt: now }, action: "escalate" };
  }
  return { state, action: "none" };
}

export function isBackstopDue(state: WatchdogState, now: number): boolean {
  return state.lastProbeAt === null || now - state.lastProbeAt >= WATCHDOG.backstopAfterMs;
}
