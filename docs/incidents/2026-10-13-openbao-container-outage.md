# A wedged OpenBao container: 13 October 2026

This report comes from a sibling deployment of this wrapper: the same Worker design, the
same `@cloudflare/containers` SDK, a fork of the same OpenBao codebase, and the default
`lite` container instance. This repository's own deployment was not measured. It shares the
conditions described below, so the fixes were ported here. Account, resource and consumer
identifiers are omitted on purpose.

## Impact and recovery

A shared OpenBao service stopped answering for about 43 minutes. Health requests hung
without a body, and every application that reads its configuration from the service failed
with a `503`. It was the third outage of the same shape in two weeks: one began on 30 September and
ended on 1 October, and one on 7 October ended only after two dashboard redeployments
restarted the container.

The Durable Object reported `healthy` with a four-day-old last change while port 8200 did
not answer. A graceful `SIGTERM` changed nothing and the following start timed out. One
process-only `destroy()` followed by an unchanged start restored service within seconds.
The external D1 database, the static seal key, the configuration, the image, the bindings
and the Durable Object storage were preserved.

## Cause

### Established

**The container was undersized, and OpenBao grew into its ceiling before every outage.** No
`instance_type` was set, so the application ran on the default 1/16 vCPU and 256 MiB.
Container metrics showed the same cycle in every process lifetime since 20 September. Memory
started near 190 MB and grew by about 50 to 60 MB a day. Within 3.5 to 5 days it reached a
hard plateau of about 425 to 440 MB, above the nominal allocation and identical in each
lifetime. CPU per unit of traffic rose with memory: about 0.1 of the allocation after a
start, about 0.8 on the plateau for similar request rates. Every outage began on that
plateau.

**At the onset OpenBao stopped doing anything visible while its process kept running.** D1
normally received about 34 reads and 60 to 110 writes a minute from OpenBao. It received 81
queries in the first minute of the outage and none for the next 40 minutes. D1's own query
time stayed near 1 ms at p90 before and after, so D1 was healthy and OpenBao had stopped
calling it. OpenBao wrote no log line after the onset. It did not answer the SDK's readiness
ping on `/`, a path that takes no OpenBao core lock. It printed nothing after `SIGTERM`,
whereas a platform `SIGTERM` days earlier had produced a complete clean shutdown in under a
second. Container CPU stayed at 2 to 4 times the allocation throughout. A `SIGKILL` and fresh
start restored service immediately, with memory back at 190 MB.

**The wrapper turned a wedged process into a 43-minute outage that needed a human.**

- *State stays `healthy`.* `@cloudflare/containers` records `healthy` once, when ports first
  answer after a start, and never re-checks. Its alarm loop only checks that the container
  process exists and whether the activity timer expired, so the alarm completed with
  outcome `ok` every three minutes through the outage.
- *Requests have no deadline.* The SDK's `containerFetch` awaits the container with no
  timeout, and the wrapper added none. Callers either gave up (thousands of requests ended
  `canceled`) or waited until the connection dropped. One health request held for 1,099
  seconds before ending in a `500`.
- *Nothing applies `SIGKILL`.* The wrapper's lifecycle hooks only logged. `stop()` only
  delivers a signal, and a wedged OpenBao cannot finish its graceful shutdown. Only
  `destroy()`, which kills the process, recovered it, and only an operator could invoke it.

### Inferred

**The mechanism inside the process.** Two explanations fit the evidence, and both start from
the same starved process. No goroutine dump exists, so neither is proved; the watchdog
captures one before killing the process next time.

- *Memory exhaustion.* At the ceiling the kernel reclaims the binary's pages and the Go
  collector runs constantly, so the process burns CPU without progress. This best explains
  the unanswered lock-free probe and the silent `SIGTERM`.
- *Storage lock convoy.* A D1 backend that calls the D1 REST API through an HTTP client with
  no timeout can stall while holding barrier or core read locks. Go's writer-preferring
  locks then queue every later request behind the next writer.

**What drives the memory growth.** In a one-hour sample, consumers performed about 1,180
AppRole logins (about 20 a minute, or about 28,000 a day). Each login creates a token and a
lease that OpenBao persists to D1 and tracks in memory until it expires, and few leases
expired in the observed windows. A few kilobytes per login matches both the daily growth and
the write rate. This was not verified against OpenBao's lease metrics.

### Specific questions

**Why does the SDK alarm throw "this Durable Object instance is no longer active"?** The SDK
alarm deliberately sleeps for up to three minutes inside the handler to keep the object
alive. When the platform's control connection to the container drops, the runtime resets
the object instance, and the sleeping alarm then wakes and writes storage on the dead
instance. The exceptions are noisy but harmless, and the replacement instance reschedules
alarms in its constructor. Upstream tracks the same defect as
[cloudflare/containers#261](https://github.com/cloudflare/containers/issues/261).

**What about `sleepAfter`?** It was inert. Traffic never idles for minutes, and the SDK leaks
its in-flight counter whenever a caller cancels a proxied request
([cloudflare/containers#241](https://github.com/cloudflare/containers/issues/241)), which
pins the activity timer. The container ran continuously until the operator killed it.

**Is this a known SDK issue fixed in a newer release?** In part. `@cloudflare/containers`
0.3.5 and 0.3.7 fix stale lifecycle state after failed starts and a start/stop race that
persisted `stopped` for a running container. No release adds liveness probing, request
deadlines, an alarm-reset guard or an in-flight leak fix, so the wrapper handles those.

**Was there a platform incident?** Cloudflare's status page showed no Containers, Durable
Objects or D1 incident overlapping the onset.

## Prevention in this repository

See [Container liveness](../../README.md#container-liveness) for the behaviour. In short:

- A per-minute watchdog probes real OpenBao health and performs one bounded recovery per
  incident, escalating instead of looping.
- Proxied requests fail after 30 seconds with a `504` and abort upstream, and callers can no
  longer select another container port.
- The singleton stays warm and the SDK alarm's reset write is guarded.
- The container moves to the `basic` instance type, four times the nominal `lite`
  allocation and about 2.4 times the roughly 430 MB plateau. If memory keeps growing at the
  observed rate it could approach 1 GiB in about two weeks, and the watchdog would then
  be the restart mechanism. Track container memory for 14 days after deploying.
- `@cloudflare/containers` stays on 0.3.7.

Deploying restarts the container once. The [runbook](../operations/container-recovery.md)
covers the deploy and the rollback.

## Follow-up

- Fix the memory growth at its source: issue batch tokens (no lease, no storage write) or
  short-TTL tokens to consumer AppRoles, and make consumers reuse a token for its lifetime
  and revoke it after one-shot reads instead of logging in per request or isolate. First
  confirm the live lease count and AppRole TTLs with an authorized read.
- In the OpenBao fork's D1 backend, set an HTTP client timeout and a per-operation deadline.
- Add an uptime check outside Cloudflare Workers against `/v1/sys/health` with a 10-second
  timeout, alerting after two consecutive failures.
- Track the two upstream SDK issues above and remove the wrapper's guards once they are
  fixed.
- Keep D1 backups and static seal-key custody current. Never reinitialize OpenBao to recover
  service.
