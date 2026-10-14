# Recover, deploy and roll back

Use this runbook when the OpenBao behind this Worker stops answering, and when deploying or
rolling back the Worker. It covers the existing Cloudflare Container only: it is not a
database reset or an application redeploy. The
[13 October 2026 report](../incidents/2026-10-13-openbao-container-outage.md) records the
failure it is written for.

## Automatic recovery comes first

The wrapper's [liveness watchdog](../../README.md#container-liveness) probes OpenBao every
minute and performs one bounded recovery per incident: `SIGQUIT`, a process-only `destroy()`
if needed, and one unchanged start. Before acting manually, read the Worker's
`bao_watchdog` events in Workers Observability:

- `healthy` appears at most every 30 minutes and proves the watchdog runs.
- `starting_stopped` followed by `started`: the container had stopped (for example during a
  deploy's rollout) and was started without signals. No action is needed.
- `recovering` followed by `recovered`: confirm health (positive checks below). No manual
  action is needed.
- `escalate`, `recovery_failed` or `start_failed`: the automatic reset or start did not
  restore health within 20 seconds of polling. The watchdog will not reset again until it
  observes a healthy probe, so manual steps cannot trigger a second automatic reset. Confirm
  current health first: a slow recovery may have completed since.
- No `bao_watchdog` events at all while OpenBao is down, or no `healthy` heartbeat for over
  an hour: cron, the Worker or the Durable Object itself is failing. Check Cloudflare's
  status page and the Worker's deployment.

After an automatic recovery, the Go goroutine dump printed on `SIGQUIT` is in the
container's logs at the recovery time. It shows where OpenBao was wedged. Keep it private,
like other raw logs.

An automatic recovery can take up to about two minutes. If a `recovering` event has no
outcome yet, wait for it: the wrapper holds proxied requests during the recovery, but an
operator action can still race it.

## Preservation gates

Before any manual stop or start:

1. Confirm the Worker, the `BaoContainer` class and the fixed `BAO_CONTAINER` actor are the
   ones you intend to repair, and inspect the deployed image and container settings.
2. Confirm OpenBao still stores its data in the external D1 database and uses the existing
   `BAO_D1_*` settings and `BAO_STATIC_SEAL_KEY`. The container's ephemeral disk must not
   hold the only copy of any required state.
3. Preserve the image, environment, entrypoint, D1 records and Durable Object storage. Do
   not run OpenBao initialization, delete the Durable Object namespace, call
   `ctx.storage.deleteAll()`, delete or restore D1, generate or replace keys, or redeploy
   broadly as a restart tactic.
4. Collect a bounded window of logs and the current health. A lifecycle state of `healthy` is
   not proof that port 8200 answers.

The procedure briefly interrupts a shared secrets service. Perform at most one graceful stop
and start and one forced process reset per diagnosis, and never loop resets to conceal a
persistent storage or startup error.

## Manual recovery

This repository ships no operator helper, because the watchdog performs the same steps. If
it cannot (for example because the Worker or Durable Object is itself failing), the
available levers are the public methods of `BaoContainer`, which a temporary Worker bound
to the same Durable Object class can call over RPC: `stop()` sends `SIGTERM`, `destroy()`
kills the process and resets the SDK lifecycle state without touching Durable Object
storage or D1, and `startAndWaitForPorts([8200])` starts the unchanged image. Calls made
this way bypass the wrapper's recovery gate and 30-second proxy deadline. Delete the
temporary Worker afterwards, and never leave it as an undocumented admin interface.

Try the graceful stop and start first. Use `destroy()` only if the process is still
unresponsive, and record the outcome in a new incident report.

## Positive checks

After any recovery, confirm:

- `GET /v1/sys/health` returns `200` with `initialized: true` and `sealed: false`. The first
  response after a start can take about 15 seconds while post-unseal setup finishes.
- A current authorized KV read succeeds. Do not print its contents.
- Each application that depends on this service can sign in or fetch its configuration.

## Deploy and roll back

Deploying restarts the OpenBao container when the container settings or image change, which
starts a Containers rollout. Expect 15 to 30 seconds of interruption, or longer if capacity
must be provisioned. A deploy builds the image from the fork's `REPO_BRANCH` (default
`main`, see `build.sh`), so a code-only deploy also picks up new commits on that branch.
Deploy only from reviewed, merged code at a quiet time.

### Private deploy credential

Deploying needs only `CLOUDFLARE_API_TOKEN`. Keep it in a regular file owned by you, mode
0600, containing exactly one line, `CLOUDFLARE_API_TOKEN=<value>`, and never pass the value
on a command line. Run every Cloudflare command through an empty environment from a fresh
worktree, which has no `.dev.vars` or `.env`:

```sh
set -euo pipefail
REPO=/path/to/checkout
CRED=/secure/path/cloudflare-deploy.env
cf() { env -i PATH="$PATH" HOME="$HOME" bash -c 'set -a; . "$0"; set +a; exec "$@"' "$CRED" "$@"; }
```

Use the absolute credential path: with a bare filename, `.` would search `PATH`. If your
network needs an egress proxy, add its variables to the allow-list in `cf`.

### Deploy

```sh
git -C "$REPO" fetch origin
DEPLOY=$(mktemp -d)/deploy
git -C "$REPO" worktree add --detach "$DEPLOY" origin/main
cd "$DEPLOY"
git log -1 --format='%H %s'               # confirm the intended commit
pnpm install --frozen-lockfile
pnpm test && pnpm typecheck
cf pnpm wrangler deployments list          # record the active version ID: the rollback target
cf pnpm wrangler containers list           # record the current container settings
cf pnpm build                              # bundle, fork checkout and local image build (Docker)
cf pnpm wrangler deploy
```

Check that `wrangler containers list` succeeds before deploying: a token without Containers
write permission can activate the new Worker version and then fail the container rollout,
leaving new code on the old instance type.

After deploying:

- Run the positive checks above.
- Confirm the container application reports the `basic` instance type.
- Confirm the Worker has the `* * * * *` cron trigger (dashboard Triggers tab).
- Within about two minutes Workers Observability should show the first `bao_watchdog`
  `healthy` heartbeat. A `starting_stopped` and `started` pair right after the rollout is
  expected.
- Watch `bao_watchdog` and `bao_alarm` events for 24 to 72 hours and container memory for 14
  days.

### Roll back

Cron triggers are not part of a Worker version, and neither are container settings.
**Never run `wrangler rollback` on its own.** The code before this change has no
`scheduled` handler, so a leftover per-minute cron would make every scheduled invocation
fail. That is noise rather than load, but it hides real errors. Remove the cron first. An
empty `crons` list removes all schedules, whereas omitting the key leaves existing ones in
place. Both paths below preserve the fixed actor, D1, the seal and the secrets; the leftover
`bao_watchdog` storage key is harmless.

**Full rollback.** Redeploy the last commit before the watchdog change (`affb3cf`) with the
cron removed. This restores the old code and the `lite` instance type, and the instance
change starts another rollout restart. To keep `basic`, also add
`"instance_type": "basic"` to the container entry.

```sh
ROLLBACK=$(mktemp -d)/rollback
git -C "$REPO" worktree add --detach "$ROLLBACK" affb3cf
cd "$ROLLBACK"
# In wrangler.jsonc add: "triggers": { "crons": [] }
pnpm install --frozen-lockfile
cf pnpm build
cf pnpm wrangler deploy
```

**Fast rollback, keeping `basic`.** Remove the cron, then roll back to the version recorded
before the deploy. In that order the old code never receives a minute event, and the new
code runs briefly on its alarm backstop alone.

```sh
cd "$DEPLOY"
# In wrangler.jsonc set: "triggers": { "crons": [] }
cf pnpm wrangler triggers deploy
cf pnpm wrangler rollback <PREVIOUS_VERSION_ID> --message "Roll back OpenBao watchdog" --yes
```

After either path, confirm in the dashboard that no cron trigger remains, then run the
positive checks. Remove the temporary worktrees with `git -C "$REPO" worktree remove <path>`.

## API references

Re-check these contracts when upgrading the SDK:

- [Cloudflare Container class and lifecycle methods](https://developers.cloudflare.com/containers/api/container-class/)
- [Cloudflare Container lifecycle](https://developers.cloudflare.com/containers/concepts/lifecycle/)
- [Containers rollouts](https://developers.cloudflare.com/containers/platform-details/rollouts/)
- [Durable Object RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
