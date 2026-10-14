import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel } from "miniflare";

// Run the built bundle in workerd. Containers are unavailable there, so the BaoContainer
// binding points at a Durable Object double that records what the Worker asks of it.
function runtime() {
  return new Miniflare({
    log: new Log(LogLevel.NONE),
    workers: [{
      name: "wrapper", modules: true,
      scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      compatibilityDate: "2026-07-01", compatibilityFlags: ["global_fetch_strictly_public"],
      durableObjects: { BAO_CONTAINER: { className: "ContainerDouble", scriptName: "container-double", useSQLite: true } },
    }, {
      name: "container-double", modules: true, compatibilityDate: "2026-07-01",
      script: `import { DurableObject } from "cloudflare:workers";
        export class ContainerDouble extends DurableObject {
          probes = 0;
          async fetch(request) {
            const { pathname } = new URL(request.url);
            if (pathname === "/__probes") return Response.json({ probes: this.probes });
            return Response.json({
              actor: this.ctx.id.name, path: pathname, method: request.method,
              token: request.headers.get("X-Vault-Token"), body: await request.text(),
            });
          }
          async watchdog() { this.probes++; return { healthy: true, action: "none" }; }
        }
        export default { fetch() { return new Response("unused"); } };`,
    }],
  });
}

test("workerd: the bundle loads and proxies requests to the fixed actor", async t => {
  const mf = runtime();
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch("http://localhost/v1/auth/approle/login", {
    method: "POST", headers: { "X-Vault-Token": "caller" }, body: "payload",
  });
  assert.deepEqual(await response.json(), {
    actor: "BAO_CONTAINER", path: "/v1/auth/approle/login", method: "POST", token: "caller", body: "payload",
  });
});

test("workerd: the cron trigger asks the fixed actor for exactly one watchdog probe", async t => {
  const mf = runtime();
  t.after(() => mf.dispose());
  const worker = await mf.getWorker("wrapper");
  const result = await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now() });
  assert.equal(result.outcome, "ok");
  const probes = await (await mf.dispatchFetch("http://localhost/__probes")).json();
  assert.deepEqual(probes, { probes: 1 });
});
