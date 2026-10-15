import { Container, type StopParams } from "@cloudflare/containers";
import type { OneOf } from "@chiballc/types";
import {
  applyTraffic, classifyHealthStatus, decideWatchdog, isBackstopDue, isLightweightPath, restoreWatchdogState, withinStartupGrace,
  PROXY_TIMEOUT_MS, WATCHDOG, WATCHDOG_STATE_KEY,
  type ProbeFailure, type ProbeResult, type ProxyTraffic, type WatchdogAction,
} from "./watchdog.js";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Optional Slack-compatible incoming webhook for watchdog recoveries and escalations. */
      BAO_WATCHDOG_ALERT_URL?: string;
    }
  }
}

// Keep constants unexported: workerd rejects non-handler values exported by the entry module.
const BAO_PORT = 8200;
const ALARM_RETRY_MS = 30_000;
const ALERT_TIMEOUT_MS = 5_000;
// The Go runtime answers SIGQUIT by printing every goroutine stack to stderr and
// exiting, even when OpenBao's own shutdown path is wedged.
const SIGQUIT = 3;

export interface RecoveryReport {
  quit: boolean;
  killed: boolean;
  started: boolean;
  healthyAfter: boolean;
  failure?: "destroy" | "destroy_timeout" | "start" | "start_timeout";
}

export interface WatchdogReport {
  healthy: boolean;
  action: WatchdogAction;
  reason?: ProbeFailure;
  recovery?: RecoveryReport;
}

type Outcome<T> = { done: true; value: T } | { done: false };

async function within<T>(work: Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settled = work.then(value => ({ done: true, value }) as const);
  settled.catch(() => {}); // A late rejection after the deadline is not actionable.
  const expired = new Promise<Outcome<T>>(resolve => { timer = setTimeout(() => resolve({ done: false }), ms); });
  try {
    return await Promise.race([settled, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
}

function isTimeout(error: unknown): boolean {
  return (error instanceof Error || error instanceof DOMException) && /abort|timeout/i.test(`${error.name} ${error.message}`);
}

function gatewayTimeout(): Response {
  return Response.json(
    { errors: [`OpenBao did not respond within ${PROXY_TIMEOUT_MS / 1000} seconds`] },
    { status: 504, headers: { "Cache-Control": "no-store" } },
  );
}

function log(level: "warn" | "error", fields: Record<string, unknown>): void {
  console[level](JSON.stringify({ event: "bao_watchdog", ...fields }));
}

export interface D1EnvVariables {
  BAO_D1_ACCOUNT_ID: string;
  BAO_D1_DATABASE_ID: string;
  BAO_D1_TOKEN: string;
}

export interface D1EnvUrl {
  BAO_D1_CONNECTION_URL: string;
}

function ensureD1Variables<T extends OneOf<[D1EnvUrl, D1EnvVariables]>>(
  env: Record<string, any>,
): asserts env is T {
  if (typeof env != "object") {
    throw new Error("Passed env is not an object");
  }

  if (env.BAO_D1_ACCOUNT_ID && env.BAO_D1_DATABASE_ID && env.BAO_D1_TOKEN) {
    return;
  }

  // Format: https://<AccountID>:<APIToken>@<DatabaseID>
  if (env.BAO_D1_CONNECTION_URL) {
    return;
  }

  // Never attach env as the cause: it holds the seal key and D1 credentials, and
  // the runtime logs the cause of a failing constructor.
  throw new Error("We could not find the variables to access openbao");
}

export class BaoContainer extends Container {
  defaultPort = BAO_PORT;
  // The service never sleeps (see onActivityExpired); this only sets how often the SDK asks.
  sleepAfter = "1h";
  #traffic: ProxyTraffic = { answered: 0, timedOut: 0 };
  #watchdog: Promise<WatchdogReport> | undefined;
  #recovering: Promise<void> | undefined;
  #lastHeartbeatAt = 0;

  constructor(ctx: DurableObjectState<{}>, env: Cloudflare.Env) {
    if (!env.BAO_STATIC_SEAL_KEY) {
      throw new Error(
        "You need to set a BAO_STATIC_SEAL_KEY environment variable",
      );
    }

    ensureD1Variables(env);

    super(ctx, env);
    this.envVars = {
      BAO_D1_CONNECTION_URL: env.BAO_D1_CONNECTION_URL || "",
      BAO_STATIC_SEAL_KEY: env.BAO_STATIC_SEAL_KEY, // The driver uses this for static unsealing
      BAO_D1_ACCOUNT_ID: env.BAO_D1_ACCOUNT_ID || "",
      BAO_D1_DATABASE_ID: env.BAO_D1_DATABASE_ID || "",
      BAO_D1_TOKEN: env.BAO_D1_TOKEN || "",
      BAO_ADDR: "http://0.0.0.0:8200",
      SKIP_SETCAP: "true",
    };
  }

  override onStart() {
    console.log("OpenBao container successfully started");
    super.onStart();
  }

  override onStop(params: StopParams) {
    console.log("OpenBao container successfully shut down", params);
    super.onStop(params);
  }

  override onError(error: unknown) {
    console.log("OpenBao container error:", error);
    super.onError(error);
  }

  // A shared secrets service stays warm: sleeping only adds cold starts. Restarts
  // belong to the watchdog.
  override async onActivityExpired(): Promise<void> {
    this.renewActivityTimeout();
  }

  // The SDK proxies without a deadline, so a wedged process held callers for up to
  // 18 minutes. Fail fast and close the upstream request instead.
  override async fetch(request: Request): Promise<Response> {
    const deadline = new AbortController();
    const forwarded = new Request(request, { signal: AbortSignal.any([request.signal, deadline.signal]) });
    // Callers must not choose another container port, such as OpenBao's cluster listener.
    forwarded.headers.delete("cf-container-target-port");
    // Cold starts and slow uploads are not evidence of a wedge, and health-style
    // endpoints answering is not evidence that storage-backed requests work.
    const countsTowardsStall = request.body === null && this.ctx.container?.running === true;
    const lightweight = isLightweightPath(new URL(request.url).pathname);
    const outcome = await within(this.#proxy(forwarded), PROXY_TIMEOUT_MS);
    if (outcome.done) {
      if (!lightweight) this.#traffic.answered++;
      return outcome.value;
    }
    deadline.abort();
    if (countsTowardsStall) this.#traffic.timedOut++;
    return gatewayTimeout();
  }

  // While the watchdog restarts OpenBao, wait for it rather than letting the SDK
  // auto-start a second container that the recovery would mistake for the wedged one.
  async #proxy(request: Request): Promise<Response> {
    if (this.#recovering) await this.#recovering;
    return super.fetch(request);
  }

  // The SDK alarm sleeps for up to three minutes, then writes storage. When the
  // runtime resets this instance meanwhile, that write throws "no longer active".
  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#watchdogBackstop();
    try {
      await super.alarm(alarmInfo);
    } catch (error) {
      const inactive = error instanceof Error && /no longer active/i.test(error.message);
      console.warn(JSON.stringify({ event: "bao_alarm", outcome: "failed", reason: inactive ? "instance_inactive" : "error" }));
      try {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
      } catch {
        // This instance was reset; its replacement schedules alarms in its constructor.
      }
    }
  }

  /** Probe OpenBao and apply bounded recovery. Invoked by cron and the alarm backstop; never throws. */
  async watchdog(): Promise<WatchdogReport> {
    this.#watchdog ??= this.#runWatchdog().finally(() => { this.#watchdog = undefined; });
    return this.#watchdog;
  }

  async #watchdogBackstop(): Promise<void> {
    try {
      const state = restoreWatchdogState(await this.ctx.storage.get(WATCHDOG_STATE_KEY));
      if (isBackstopDue(state, Date.now())) await this.watchdog();
    } catch {
      // The SDK alarm loop must continue even when the backstop cannot run.
    }
  }

  async #runWatchdog(): Promise<WatchdogReport> {
    try {
      const traffic = this.#takeTraffic();
      const lifecycle = await this.getState();
      const bootingSince = lifecycle.status === "running" || lifecycle.status === "healthy" ? lifecycle.lastChange : null;
      const observed = applyTraffic(await this.#probe(WATCHDOG.probeTimeoutMs), traffic);
      const probe = withinStartupGrace(observed, bootingSince, Date.now());
      const previous = restoreWatchdogState(await this.ctx.storage.get(WATCHDOG_STATE_KEY));
      const { state, action } = decideWatchdog(previous, probe, Date.now());
      // Persist durably before acting so an interrupted recovery is never repeated.
      await this.ctx.storage.put(WATCHDOG_STATE_KEY, state);
      await this.ctx.storage.sync();
      const report: WatchdogReport = probe.healthy ? { healthy: true, action } : { healthy: false, action, reason: probe.reason };

      if (action === "none") {
        if (!probe.healthy) log("warn", { outcome: "unhealthy", reason: probe.reason, consecutiveFailures: state.consecutiveFailures });
        else this.#heartbeat();
        return report;
      }
      if (action === "escalate") {
        const attempted = report.reason === "not_running" ? "start" : "reset";
        log("error", { outcome: "escalate", reason: report.reason, lastRecoveryAt: state.lastRecoveryAt, lastStartAt: state.lastStartAt });
        await this.#alert(`OpenBao is still unhealthy (${report.reason}) after an automatic ${attempted}; manual recovery is required.`, report);
        return report;
      }

      const wedged = action === "recover";
      log(wedged ? "error" : "warn", { outcome: wedged ? "recovering" : "starting_stopped", reason: report.reason });
      report.recovery = await this.#gated(wedged ? this.#restart() : this.#startOnly());
      if (report.recovery.started) report.recovery.healthyAfter = await this.#awaitHealthy(WATCHDOG.verifyTimeoutMs);
      if (!wedged) {
        log(report.recovery.healthyAfter ? "warn" : "error", { outcome: report.recovery.healthyAfter ? "started" : "start_failed", ...report.recovery });
        return report;
      }
      log("error", { outcome: report.recovery.healthyAfter ? "recovered" : "recovery_failed", ...report.recovery });
      await this.#alert(report.recovery.healthyAfter
        ? `OpenBao was unhealthy (${report.reason}); the watchdog reset the container and health is restored.`
        : `OpenBao was unhealthy (${report.reason}); the automatic reset did not restore health.`, report);
      return report;
    } catch {
      log("error", { outcome: "watchdog_error" });
      return { healthy: false, action: "none" };
    }
  }

  #takeTraffic(): ProxyTraffic {
    const traffic = this.#traffic;
    this.#traffic = { answered: 0, timedOut: 0 };
    return traffic;
  }

  // Real OpenBao health on port 8200, not the SDK's cached lifecycle state.
  async #probe(timeoutMs: number): Promise<ProbeResult> {
    const container = this.ctx.container;
    if (!container?.running) return { healthy: false, reason: "not_running" };
    try {
      const health = container.getTcpPort(BAO_PORT).fetch("http://bao/v1/sys/health", { signal: AbortSignal.timeout(timeoutMs) });
      const outcome = await within(health, timeoutMs + 1_000);
      if (!outcome.done) return { healthy: false, reason: "timeout" };
      await outcome.value.body?.cancel();
      return classifyHealthStatus(outcome.value.status);
    } catch (error) {
      return { healthy: false, reason: isTimeout(error) ? "timeout" : "unreachable" };
    }
  }

  // Post-unseal setup can briefly answer 503 or hold health, so poll until healthy.
  async #awaitHealthy(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (let remaining = ms; remaining > 0; remaining = deadline - Date.now()) {
      if ((await this.#probe(Math.min(WATCHDOG.probeTimeoutMs, remaining))).healthy) return true;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    return false;
  }

  // Low-frequency proof that the watchdog runs; healthy probes are otherwise silent.
  #heartbeat(): void {
    const now = Date.now();
    if (now - this.#lastHeartbeatAt < WATCHDOG.heartbeatMs) return;
    this.#lastHeartbeatAt = now;
    console.log(JSON.stringify({ event: "bao_watchdog", outcome: "healthy" }));
  }

  // Proxied requests wait while the container is replaced; health verification runs after.
  async #gated(work: Promise<RecoveryReport>): Promise<RecoveryReport> {
    this.#recovering = work.then(() => {}, () => {});
    try {
      return await work;
    } finally {
      this.#recovering = undefined;
    }
  }

  // One diagnostic SIGQUIT, a process-only kill if it does not exit, and one start with
  // the unchanged image, environment and entrypoint. The fixed actor, external D1 and the
  // static seal are untouched, and no existing Durable Object storage is modified.
  async #restart(): Promise<RecoveryReport> {
    const report: RecoveryReport = { quit: false, killed: false, started: false, healthyAfter: false };
    const container = this.ctx.container;
    if (container?.running) {
      try {
        await this.stop(SIGQUIT);
        report.quit = true;
      } catch {
        // The process-only kill below still applies.
      }
      await waitFor(() => !container.running, WATCHDOG.exitGraceMs);
      if (container.running) {
        try {
          const destroyed = await within(this.destroy(), WATCHDOG.destroyTimeoutMs);
          if (!destroyed.done) return { ...report, failure: "destroy_timeout" };
          report.killed = true;
        } catch {
          // The process may have exited between the check and the kill.
          if (container.running) return { ...report, failure: "destroy" };
        }
      }
    }
    return this.#start(report);
  }

  // A stopped container is only started. It is never signalled, even if a request
  // started it in the meantime.
  async #startOnly(): Promise<RecoveryReport> {
    return this.#start({ quit: false, killed: false, started: false, healthyAfter: false });
  }

  async #start(report: RecoveryReport): Promise<RecoveryReport> {
    try {
      const options = { abort: AbortSignal.timeout(WATCHDOG.startTimeoutMs), portReadyTimeoutMS: WATCHDOG.portReadyTimeoutMs };
      const started = await within(this.startAndWaitForPorts([BAO_PORT], options), WATCHDOG.startTimeoutMs + 5_000);
      if (!started.done) return { ...report, failure: "start_timeout" };
      return { ...report, started: true };
    } catch {
      return { ...report, failure: "start" };
    }
  }

  async #alert(text: string, report: WatchdogReport): Promise<void> {
    const configured = this.env.BAO_WATCHDOG_ALERT_URL;
    if (!configured) return;
    try {
      const target = new URL(configured);
      if (target.protocol !== "https:") throw new Error("Alert URL must use HTTPS");
      const response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, event: { service: "cloudflare-openbao", ...report } }),
        redirect: "manual",
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Alert rejected");
    } catch {
      // The URL embeds a credential; never log it or the provider response.
      log("error", { outcome: "alert_failed" });
    }
  }
}

function baoContainer(env: Cloudflare.Env) {
  return env.BAO_CONTAINER.getByName("BAO_CONTAINER", { routingMode: "primary-only" });
}

export default {
  // The only cron trigger is the liveness watchdog.
  async scheduled(_: ScheduledController, env: Cloudflare.Env) {
    await baoContainer(env).watchdog();
  },
  async fetch(request: Request, env: Cloudflare.Env, _: ExecutionContext) {
    return baoContainer(env).fetch(request);
  },
};
