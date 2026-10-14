import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";

// Replace only the SDK base class: every call it would make is recorded by the fixture.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@cloudflare/containers") {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(`
          export class Container {
            constructor(ctx, env) { this.ctx = ctx; this.env = env; }
            fetch(request) { return globalThis.sdk.fetch(request); }
            alarm(info) { return globalThis.sdk.alarm(info); }
            stop(signal) { return globalThis.sdk.stop(signal); }
            destroy() { return globalThis.sdk.destroy(); }
            startAndWaitForPorts(...args) { return globalThis.sdk.start(...args); }
            getState() { return globalThis.sdk.getState(); }
            renewActivityTimeout() { globalThis.sdk.calls.push(["renew"]); }
            onStart() {} onStop() {} onError() {}
          }`),
      };
    }
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
    }
    if (specifier.startsWith("./") && specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { BaoContainer } = await import("../src/index.ts");
const { PROXY_TIMEOUT_MS, WATCHDOG, WATCHDOG_STATE_KEY } = await import("../src/watchdog.ts");

type Call = [string, ...unknown[]];
type Health = (init?: RequestInit) => Promise<Response>;

function fixture(t: TestContext, options: { alertUrl?: string } = {}) {
  const calls: Call[] = [];
  const stored = new Map<string, unknown>();
  let health: Health = async () => new Response("{}", { status: 200 });
  const runtime = {
    running: true,
    getTcpPort(port: number) {
      calls.push(["tcpPort", port]);
      return { fetch: (url: string, init?: RequestInit) => { calls.push(["probe", new URL(url).pathname]); return health(init); } };
    },
  };
  const sdk = {
    calls,
    fetch: async (_: Request): Promise<Response> => new Response("from-openbao"),
    alarm: async (_?: unknown) => {},
    stop: async (signal: number) => { calls.push(["stop", signal]); },
    destroy: async () => { calls.push(["destroy"]); runtime.running = false; },
    start: async (...args: unknown[]) => { calls.push(["start", ...args]); runtime.running = true; },
    getState: async () => ({ status: "healthy", lastChange: 1 }),
  };
  Object.assign(globalThis, { sdk });
  const storage = {
    get: async (key: string) => structuredClone(stored.get(key)),
    put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
    setAlarm: async (time: number) => { calls.push(["setAlarm", time]); },
    sync: async () => { calls.push(["sync"]); },
  };
  const env = {
    BAO_STATIC_SEAL_KEY: "sentinel-seal", BAO_D1_CONNECTION_URL: "https://acct:sentinel-d1@db",
    ...(options.alertUrl ? { BAO_WATCHDOG_ALERT_URL: options.alertUrl } : {}),
  };
  const logs: string[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  }
  const container = new BaoContainer({ container: runtime, storage } as never, env as never);
  return {
    container, runtime, sdk, calls, stored, storage, logs,
    setHealth(next: Health) { health = next; },
    count: (name: string) => calls.filter(call => call[0] === name).length,
  };
}

const timeout = async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };

// Drive mocked timers until a promise settles; real I/O never runs here.
async function drive<T>(t: TestContext, work: Promise<T>, stepMs = 250): Promise<T> {
  let settled = false;
  work.then(() => { settled = true; }, () => { settled = true; });
  for (let step = 0; !settled; step++) {
    if (step > 10_000) throw new Error("work is waiting on something other than mocked timers");
    await new Promise(resolve => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(stepMs);
  }
  return work;
}

const immediate = () => new Promise(resolve => setImmediate(resolve));

test("a proxied request that OpenBao never answers fails fast with 504 and aborts upstream", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  let upstream: Request | undefined;
  f.sdk.fetch = request => { upstream = request; return new Promise(() => {}); };
  const pending = f.container.fetch(new Request("https://bao.example/v1/auth/approle/login", { method: "POST", body: "payload" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstream?.signal.aborted, false);
  assert.equal(await upstream?.text(), "payload");
  t.mock.timers.tick(PROXY_TIMEOUT_MS);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { errors: ["OpenBao did not respond within 30 seconds"] });
  assert.equal(upstream?.signal.aborted, true);
});

test("answered requests pass through unchanged", async t => {
  const f = fixture(t);
  const response = await f.container.fetch(new Request("https://bao.example/v1/sys/health"));
  assert.equal(await response.text(), "from-openbao");
});

test("activity expiry keeps the shared singleton running", async t => {
  const f = fixture(t);
  await f.container.onActivityExpired();
  assert.deepEqual(f.calls, [["renew"]]);
});

test("an alarm on a reset instance never escapes as an unhandled exception", async t => {
  const f = fixture(t);
  f.stored.set(WATCHDOG_STATE_KEY, { lastProbeAt: Date.now() }); // cron is current; no backstop probe
  f.sdk.alarm = async () => {
    throw new Error("Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.");
  };
  const before = Date.now();
  await f.container.alarm({ isRetry: false, retryCount: 0 });
  const [, time] = f.calls.find(call => call[0] === "setAlarm") as [string, number];
  assert.ok(time >= before + 30_000 && time <= Date.now() + 30_000);
  assert.ok(f.logs.some(line => line.includes('"event":"bao_alarm"') && line.includes('"reason":"instance_inactive"')));
  assert.equal(f.count("probe"), 0);

  // Even the reschedule can fail on a dead instance; the replacement instance reschedules.
  f.storage.setAlarm = async () => { throw new Error("no longer active"); };
  await f.container.alarm();
});

test("the alarm backstop probes OpenBao when cron probes stop arriving", async t => {
  const f = fixture(t);
  await f.container.alarm();
  assert.equal(f.count("probe"), 1);
  await f.container.alarm();
  assert.equal(f.count("probe"), 1);
});

test("a healthy container is left alone", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.container.watchdog(), { healthy: true, action: "none" });
  assert.deepEqual(f.calls.filter(call => call[0] === "probe"), [["probe", "/v1/sys/health"]]);
  assert.deepEqual(f.calls.filter(call => call[0] === "tcpPort"), [["tcpPort", 8200]]);
  assert.equal(f.count("stop") + f.count("destroy") + f.count("start"), 0);
});

test("a wedged process gets SIGQUIT, a process-only kill and one unchanged start, then escalation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);

  assert.deepEqual(await drive(t, f.container.watchdog()), { healthy: false, action: "none", reason: "timeout" });
  assert.equal(f.count("stop"), 0);

  // SIGQUIT is ignored (still running), so destroy follows after the grace period.
  f.sdk.start = async (...args: unknown[]) => {
    f.calls.push(["start", ...args]);
    f.runtime.running = true;
    f.setHealth(async () => new Response("{}", { status: 200 }));
  };
  t.mock.timers.tick(60_000);
  const report = await drive(t, f.container.watchdog());
  assert.equal(report.action, "recover");
  assert.deepEqual(report.recovery, { quit: true, killed: true, started: true, healthyAfter: true });
  assert.deepEqual(f.calls.filter(call => ["stop", "destroy"].includes(call[0])), [["stop", 3], ["destroy"]]);
  const start = f.calls.find(call => call[0] === "start")!;
  assert.deepEqual(start[1], [8200]);
  assert.equal(start.length, 3, "no start overrides for image, environment or entrypoint");
  const options = start[2] as { abort: AbortSignal; portReadyTimeoutMS: number };
  assert.ok(options.abort instanceof AbortSignal);
  assert.equal(options.portReadyTimeoutMS, 45_000, "the 60-second start budget is not cut to the SDK's 20-second port default");
  assert.equal((f.stored.get(WATCHDOG_STATE_KEY) as { armed: boolean }).armed, false);
  const names = f.calls.map(call => call[0]);
  assert.ok(names.lastIndexOf("sync", names.indexOf("stop")) !== -1, "state is synced before the first signal");

  // The wedge returns: no second reset inside the incident, only rate-limited escalation.
  f.setHealth(timeout);
  const actions: string[] = [];
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(60_000);
    actions.push((await drive(t, f.container.watchdog())).action);
  }
  assert.equal(f.count("destroy"), 1);
  assert.equal(f.count("start"), 1);
  assert.deepEqual(actions.flatMap((action, i) => action === "escalate" ? [i] : []), [1, 16]);
  assert.ok(f.logs.some(line => line.includes('"outcome":"escalate"')));
  for (const line of f.logs) assert.doesNotMatch(line, /sentinel/);
});

test("a process that exits on SIGQUIT is not killed again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);
  f.sdk.stop = async (signal: number) => { f.calls.push(["stop", signal]); f.runtime.running = false; };
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(60_000);
  const report = await drive(t, f.container.watchdog());
  assert.deepEqual(report.recovery, { quit: true, killed: false, started: true, healthyAfter: false });
  assert.equal(f.count("destroy"), 0);
});

test("a stopped container is started without signals", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.runtime.running = false;
  assert.equal((await drive(t, f.container.watchdog())).reason, "not_running");
  t.mock.timers.tick(60_000);
  const report = await drive(t, f.container.watchdog());
  assert.equal(report.action, "start");
  assert.deepEqual(report.recovery, { quit: false, killed: false, started: true, healthyAfter: true });
  assert.equal(f.count("stop") + f.count("destroy"), 0);
  assert.equal((f.stored.get(WATCHDOG_STATE_KEY) as { armed: boolean }).armed, true, "a plain start keeps the wedge reset available");
  assert.ok(f.logs.some(line => line.includes('"outcome":"started"')));
});

test("stalled proxied requests make the watchdog act even when health answers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.sdk.fetch = () => new Promise(() => {});
  for (let i = 0; i < 3; i++) {
    const pending = f.container.fetch(new Request("https://bao.example/v1/myapp/data/production/public"));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(PROXY_TIMEOUT_MS);
    assert.equal((await pending).status, 504);
  }
  assert.deepEqual(await f.container.watchdog(), { healthy: false, action: "none", reason: "requests_timing_out" });
  // Counters reset after each probe; healthy traffic is judged afresh.
  assert.deepEqual(await f.container.watchdog(), { healthy: true, action: "none" });
});

test("concurrent watchdog calls share one probe", async t => {
  const f = fixture(t);
  let release!: () => void;
  f.setHealth(() => new Promise(resolve => { release = () => resolve(new Response("{}", { status: 200 })); }));
  const first = f.container.watchdog();
  const second = f.container.watchdog();
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ healthy: true, action: "none" }, { healthy: true, action: "none" }]);
  assert.equal(f.count("probe"), 1);
});

test("alerts post a sanitized summary to an HTTPS webhook and never throw", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const posted: { url: string; body: unknown }[] = [];
  let reject = false;
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    if (reject) throw new Error("network down https://hooks.example/secret-path");
    posted.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response("ok");
  });
  const f = fixture(t, { alertUrl: "https://hooks.example/secret-path" });
  f.setHealth(timeout);
  f.sdk.stop = async () => { f.runtime.running = false; };
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(60_000);
  await drive(t, f.container.watchdog());
  assert.equal(posted.length, 1);
  const body = posted[0]!.body as { text: string; event: { service: string; action: string; reason: string } };
  assert.match(body.text, /automatic reset did not restore health/);
  assert.equal(body.event.service, "cloudflare-openbao");
  assert.equal(body.event.action, "recover");
  assert.equal(body.event.reason, "timeout");
  assert.doesNotMatch(JSON.stringify(body), /sentinel/);

  reject = true;
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(60_000); await drive(t, f.container.watchdog()); }
  assert.ok(f.logs.some(line => line.includes('"outcome":"alert_failed"')));
  for (const line of f.logs) assert.doesNotMatch(line, /secret-path|sentinel/);
});

test("non-HTTPS alert targets are refused", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("ok"));
  const f = fixture(t, { alertUrl: "http://hooks.example/plain" });
  f.setHealth(timeout);
  f.sdk.stop = async () => { f.runtime.running = false; };
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(60_000);
  await drive(t, f.container.watchdog());
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.ok(f.logs.some(line => line.includes('"outcome":"alert_failed"')));
});

test("callers cannot redirect a request to another container port", async t => {
  const f = fixture(t);
  let upstream: Request | undefined;
  f.sdk.fetch = async request => { upstream = request; return new Response("ok"); };
  await f.container.fetch(new Request("https://bao.example/v1/sys/health", { headers: { "cf-container-target-port": "8201" } }));
  assert.equal(upstream?.headers.has("cf-container-target-port"), false);
});

test("uploads and cold starts that time out are not counted as a wedge", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.sdk.fetch = () => new Promise(() => {});
  const timeOut = async (request: Request) => {
    const pending = f.container.fetch(request);
    await immediate();
    t.mock.timers.tick(PROXY_TIMEOUT_MS);
    assert.equal((await pending).status, 504);
  };
  for (let i = 0; i < 3; i++) await timeOut(new Request("https://bao.example/v1/auth/approle/login", { method: "POST", body: "{}" }));
  f.runtime.running = false;
  for (let i = 0; i < 3; i++) await timeOut(new Request("https://bao.example/v1/sys/health"));
  f.runtime.running = true;
  assert.deepEqual(await f.container.watchdog(), { healthy: true, action: "none" });
});

test("proxied requests wait for an in-progress recovery instead of auto-starting another container", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);
  f.sdk.stop = async (signal: number) => { f.calls.push(["stop", signal]); f.runtime.running = false; };
  let release = () => {};
  t.after(() => release());
  f.sdk.start = (...args: unknown[]) => new Promise<void>(resolve => {
    f.calls.push(["start", ...args]);
    release = () => { f.runtime.running = true; f.setHealth(async () => new Response("{}", { status: 200 })); resolve(); };
  });
  let proxied = 0;
  f.sdk.fetch = async () => { proxied++; return new Response("from-openbao"); };
  await f.container.watchdog();
  t.mock.timers.tick(60_000);
  const recovering = f.container.watchdog();
  while (f.count("start") === 0) await immediate();
  const during = f.container.fetch(new Request("https://bao.example/v1/myapp/data/production/public"));
  for (let i = 0; i < 5; i++) await immediate();
  assert.equal(proxied, 0, "no request reaches the SDK (and its auto-start) mid-recovery");
  release();
  assert.equal((await recovering).recovery?.healthyAfter, true);
  assert.equal(await (await during).text(), "from-openbao");
  assert.equal(proxied, 1);
  assert.equal(f.count("start"), 1);
});

test("health that is briefly sealed during post-unseal setup still counts as recovered", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);
  f.sdk.stop = async () => { f.runtime.running = false; };
  f.sdk.start = async () => {
    f.runtime.running = true;
    let answers = 0;
    f.setHealth(async () => new Response("{}", { status: ++answers < 3 ? 503 : 200 }));
  };
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(60_000);
  const report = await drive(t, f.container.watchdog());
  assert.deepEqual(report.recovery, { quit: true, killed: false, started: true, healthyAfter: true });
});

test("failures within two minutes of becoming healthy are neutral", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);
  f.sdk.getState = async () => ({ status: "healthy", lastChange: Date.now() - 30_000 });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await drive(t, f.container.watchdog()), { healthy: false, action: "none", reason: "starting" });
    t.mock.timers.tick(20_000);
  }
  assert.equal((f.stored.get(WATCHDOG_STATE_KEY) as { consecutiveFailures: number }).consecutiveFailures, 0);
  // A stopped state never qualifies, so a loop of failed starts is still counted.
  f.sdk.getState = async () => ({ status: "stopped_with_code", lastChange: Date.now(), exitCode: 1 });
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(60_000);
  assert.equal((await drive(t, f.container.watchdog())).action, "recover");
});

test("a kill that fails because the process already exited still starts OpenBao", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);
  f.sdk.destroy = async () => { f.runtime.running = false; throw new Error("container is not running"); };
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(60_000);
  const report = await drive(t, f.container.watchdog());
  assert.equal(report.recovery?.started, true);
  assert.equal(report.recovery?.failure, undefined);
});

test("a kill that fails while the process still runs is reported without starting", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);
  f.sdk.destroy = async () => { throw new Error("destroy failed"); };
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(60_000);
  const report = await drive(t, f.container.watchdog());
  assert.deepEqual(report.recovery, { quit: true, killed: false, started: false, healthyAfter: false, failure: "destroy" });
  assert.equal(f.count("start"), 0);
  assert.equal(WATCHDOG.failureThreshold, 2);
});

test("a container still booting is not killed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);
  f.sdk.getState = async () => ({ status: "running", lastChange: Date.now() - 10_000 });
  for (let i = 0; i < 3; i++) {
    assert.equal((await drive(t, f.container.watchdog())).reason, "starting");
    t.mock.timers.tick(30_000);
  }
  assert.equal(f.count("stop") + f.count("destroy") + f.count("start"), 0);
});

test("bunched cron events seconds apart do not trigger a reset", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(5_000);
  assert.equal((await drive(t, f.container.watchdog())).action, "none");
  assert.equal(f.count("stop"), 0);
  t.mock.timers.tick(55_000);
  assert.equal((await drive(t, f.container.watchdog())).action, "recover");
});

test("a probe whose fetch ignores its abort signal still times out", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(() => new Promise(() => {}));
  assert.deepEqual(await drive(t, f.container.watchdog()), { healthy: false, action: "none", reason: "timeout" });
});

test("a kill that never returns is reported and no start is attempted", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);
  f.sdk.destroy = () => new Promise(() => {});
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(60_000);
  const report = await drive(t, f.container.watchdog());
  assert.deepEqual(report.recovery, { quit: true, killed: false, started: false, healthyAfter: false, failure: "destroy_timeout" });
  assert.equal(f.count("start"), 0);
});

test("a start that never returns is reported as a start timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setHealth(timeout);
  f.sdk.stop = async () => { f.runtime.running = false; };
  f.sdk.start = () => new Promise(() => {});
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(60_000);
  const report = await drive(t, f.container.watchdog());
  assert.deepEqual(report.recovery, { quit: true, killed: false, started: false, healthyAfter: false, failure: "start_timeout" });
  assert.ok(f.logs.some(line => line.includes('"outcome":"recovery_failed"')));
});

for (const failing of ["put", "sync"] as const) {
  test(`a failed state ${failing} sends no signal`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
    const f = fixture(t);
    f.setHealth(timeout);
    await drive(t, f.container.watchdog());
    t.mock.timers.tick(60_000);
    f.storage[failing] = async () => { throw new Error("storage unavailable"); };
    assert.deepEqual(await drive(t, f.container.watchdog()), { healthy: false, action: "none" });
    assert.equal(f.count("stop") + f.count("destroy") + f.count("start"), 0);
    assert.ok(f.logs.some(line => line.includes('"outcome":"watchdog_error"')));
  });
}

test("a stopped container is started, never signalled, even if a request started it meanwhile", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.runtime.running = false;
  await drive(t, f.container.watchdog());
  t.mock.timers.tick(60_000);
  // The probe saw "not running"; a request starts the container before the action runs.
  const put = f.storage.put;
  f.storage.put = async (key: string, value: unknown) => { await put(key, value); f.runtime.running = true; };
  const report = await drive(t, f.container.watchdog());
  assert.equal(report.action, "start");
  assert.equal(report.recovery?.started, true);
  assert.equal(f.count("stop") + f.count("destroy"), 0);
});

test("health answers do not hide stalled storage requests", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.sdk.fetch = async request => new URL(request.url).pathname === "/v1/sys/health"
    ? new Response("{}", { status: 200 })
    : new Promise(() => {});
  for (let i = 0; i < 3; i++) {
    await f.container.fetch(new Request("https://bao.example/v1/sys/health"));
    const pending = f.container.fetch(new Request("https://bao.example/v1/myapp/data/production/public"));
    await immediate();
    t.mock.timers.tick(PROXY_TIMEOUT_MS);
    assert.equal((await pending).status, 504);
  }
  assert.equal((await f.container.watchdog()).reason, "requests_timing_out");
});

test("healthy probes log a heartbeat at most every 30 minutes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  const heartbeats = () => f.logs.filter(line => line.includes('"outcome":"healthy"')).length;
  await drive(t, f.container.watchdog());
  assert.equal(heartbeats(), 1);
  for (let i = 0; i < 29; i++) { t.mock.timers.tick(60_000); await drive(t, f.container.watchdog()); }
  assert.equal(heartbeats(), 1);
  t.mock.timers.tick(60_000);
  await drive(t, f.container.watchdog());
  assert.equal(heartbeats(), 2);
});
