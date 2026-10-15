# cloudflare-openbao

A Cloudflare Worker that runs [OpenBao](https://openbao.org) in a
[Cloudflare Container](https://developers.cloudflare.com/containers/). The Worker forwards
every HTTP request to one fixed `BAO_CONTAINER` instance of the `BaoContainer` Durable
Object. The container runs the `PrimalDjinn/openbao` fork with Cloudflare D1 as its storage
backend and a static seal, both configured in `config/config.hcl` and the Worker's secrets.

| Path | Purpose |
| --- | --- |
| `src/index.ts` | `BaoContainer` (proxy, watchdog, alarm guard) and the Worker handlers. |
| `src/watchdog.ts` | Pure liveness policy: probe classification, failure spacing, recovery limits. |
| `config/config.hcl` | OpenBao server configuration baked into the image. |
| `Dockerfile`, `build.sh` | Build the OpenBao binary and image from the fork. |
| `tests/` | Unit tests with a recorded fake SDK, an export check and a workerd smoke test. |
| `docs/` | Incident report and the recovery, deploy and rollback runbook. |

## Configuration

Provision these as Worker secrets (`pnpm wrangler secret put <NAME>`), or in `.dev.vars` for
local development (see `.dev.vars.example`):

- `BAO_STATIC_SEAL_KEY`: the static seal key. Losing it makes the vault unreadable.
- D1 access, either `BAO_D1_CONNECTION_URL` (`https://<AccountID>:<APIToken>@<DatabaseID>`)
  or all of `BAO_D1_ACCOUNT_ID`, `BAO_D1_DATABASE_ID` and `BAO_D1_TOKEN`.
- Optional `BAO_WATCHDOG_ALERT_URL`: an HTTPS Slack-compatible webhook for watchdog
  recoveries and escalations. Treat the URL as a credential.

The container receives only the seal and D1 settings. Missing settings fail the Durable
Object constructor with a message that names no values.

## Development

```sh
pnpm install
pnpm test          # builds the Worker bundle, then runs every test on Node's runner
pnpm typecheck     # tsc over src
pnpm build:worker  # the Worker bundle only (dist/index.js)
pnpm build         # bundle plus the container image (needs Docker, git and network)
```

Tests need Node 24 or newer. The unit tests replace only the `@cloudflare/containers` base
class, so every SDK call the wrapper makes is recorded and asserted. The workerd test runs
the built bundle in Miniflare with the container binding replaced by a Durable Object double,
and the export test guards against exporting a plain value from the entry module, which
workerd rejects at upload time.

## Container liveness

The Containers SDK marks the container `healthy` once, when port 8200 first answers, and
never re-checks it. Its alarm only checks that the process exists, and it proxies requests
without a deadline. A wedged OpenBao therefore stays "healthy" and hangs callers until
someone kills the process (see the [incident report](docs/incidents/2026-10-13-openbao-container-outage.md)).
The wrapper owns liveness instead:

- **Watchdog.** The `* * * * *` cron calls `watchdog()` on the fixed `BaoContainer` actor.
  It probes `GET /v1/sys/health` on port 8200 with a 5-second bound. Bodyless proxied
  requests to a running container that time out while no storage-backed request is answered
  also count as a failure, because health can answer while storage stalls; answers from
  `sys/health`, `sys/seal-status` and `sys/leader` do not count as evidence. Failures count
  only when at least 45 seconds apart, so bunched cron events cannot turn one blip into
  two. Failures within two minutes of the container entering `running` (booting) or
  `healthy` (post-unseal setup) are neutral; a stopped container always counts. While the
  container runs, the SDK alarm loop runs the same probe as a backstop when cron probes
  stop arriving.
- **Stopped container.** Two counted `not_running` failures start it, with no signals and
  without using up the reset reserved for a wedge. That is what the next request would do
  anyway, for example after a deploy's rollout. A container that stops again within 30
  minutes is escalated instead.
- **Bounded recovery.** Two counted failures of a running container trigger one recovery:
  `SIGQUIT` (Go prints every goroutine stack to stderr, which lands in the container logs),
  a process-only `destroy()` if the process is still running after 10 seconds, then one
  `startAndWaitForPorts([8200])` with no image, environment or entrypoint overrides, a
  45-second port budget and a 60-second overall bound. Proxied requests wait during the
  stop and start, within their own deadline, so traffic cannot auto-start a second
  container. Up to 20 seconds of health polling follows. The Durable Object's existing
  storage, the D1 database and the static seal are untouched; the watchdog adds only its own
  `bao_watchdog` key. The attempt is persisted durably before the first signal. A further
  failure in the same incident escalates instead of resetting again; only an observed
  healthy probe re-arms recovery, and never within 30 minutes of the previous reset.
- **Fail fast.** Proxied requests are bounded at 30 seconds to response headers. A timeout
  returns `504` with `{"errors":[...]}` and aborts the upstream request. Callers can no
  longer choose another container port with the `cf-container-target-port` header, which
  the SDK would otherwise honour, so a caller could have reached any container port,
  including a cluster listener such as OpenBao's 8201 if one is running.
- **Always warm.** Activity expiry renews the timer instead of stopping the container. A
  shared secrets service gains nothing from sleeping, and the SDK's in-flight counter leaks
  on cancelled requests anyway. Restarts belong to the watchdog.
- **Alarm guard.** The SDK alarm can write storage after the runtime resets the Durable
  Object. The wrapper logs that as a sanitized warning instead of an unhandled exception.

Worker logs carry `bao_watchdog` events (`healthy` heartbeat at most every 30 minutes,
`unhealthy`, `starting_stopped`, `started`, `start_failed`, `recovering`, `recovered`,
`recovery_failed`, `escalate`, `alert_failed`, `watchdog_error`) and `bao_alarm` warnings,
with reasons from a fixed vocabulary and no request data. Alert on `escalate`,
`recovery_failed` and a missing `healthy` heartbeat for more than an hour, or set
`BAO_WATCHDOG_ALERT_URL`. Only HTTPS targets are accepted, delivery is bounded at 5 seconds,
redirects are not followed, and failures are logged without the URL. The in-Worker watchdog
cannot report a failure of the Worker or Durable Object itself, so also run an uptime check
outside Cloudflare Workers against `/v1/sys/health`.

The container uses the `basic` instance type (1/4 vCPU, 1 GiB), four times the nominal
`lite` allocation. If you deploy to a different account, check that `basic` capacity and
pricing suit you; the watchdog does not depend on it.

## Operations

- [Recover, deploy and roll back](docs/operations/container-recovery.md)
- [13 October 2026: a wedged OpenBao container, cause analysis and automatic recovery](docs/incidents/2026-10-13-openbao-container-outage.md)
