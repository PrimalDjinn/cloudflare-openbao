import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Exercise the real Worker handlers with only the container runtime replaced.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@cloudflare/containers") {
      return { url: "data:text/javascript,export class Container {}", shortCircuit: true };
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
const { default: worker, BaoContainer } = await import("../src/index.ts");

function binding(handler: (name: string, options: object) => object) {
  return { BAO_CONTAINER: { getByName: handler } } as never;
}

test("every HTTP request is proxied to the fixed primary-only container actor", async () => {
  for (const path of ["/v1/sys/health", "/v1/auth/token/renew-accessor", "/__scheduled", "/cdn-cgi/local/scheduled", "/?bao_url=https://evil.example"]) {
    const request = new Request(`https://wrapper.example${path}`, { headers: { "X-Vault-Token": "caller-token", Origin: "https://caller.example" } });
    const response = new Response("container");
    const env = binding((name, options) => {
      assert.equal(name, "BAO_CONTAINER");
      assert.deepEqual(options, { routingMode: "primary-only" });
      return { fetch(forwarded: Request) { assert.equal(forwarded, request); return response; } };
    });
    assert.equal(await worker.fetch(request, env, {} as never), response);
  }
});

test("the scheduled handler runs the watchdog on the fixed actor with no arguments", async () => {
  let probes = 0;
  await worker.scheduled({ cron: "* * * * *" } as never, binding((name, options) => {
    assert.equal(name, "BAO_CONTAINER");
    assert.deepEqual(options, { routingMode: "primary-only" });
    return { async watchdog(...args: unknown[]) { assert.deepEqual(args, []); probes++; } };
  }));
  assert.equal(probes, 1);
});

test("the container receives only its storage and seal settings", () => {
  const container = new BaoContainer({} as never, {
    BAO_STATIC_SEAL_KEY: "seal", BAO_D1_CONNECTION_URL: "connection",
    BAO_WATCHDOG_ALERT_URL: "https://hooks.example/secret-path",
  } as never);
  assert.deepEqual(container.envVars, {
    BAO_STATIC_SEAL_KEY: "seal", BAO_D1_CONNECTION_URL: "connection",
    BAO_D1_ACCOUNT_ID: "", BAO_D1_DATABASE_ID: "", BAO_D1_TOKEN: "",
    BAO_ADDR: "http://0.0.0.0:8200", SKIP_SETCAP: "true",
  });
});

test("separate D1 account, database and token settings are accepted", () => {
  const container = new BaoContainer({} as never, {
    BAO_STATIC_SEAL_KEY: "seal", BAO_D1_ACCOUNT_ID: "account", BAO_D1_DATABASE_ID: "database", BAO_D1_TOKEN: "token",
  } as never);
  assert.deepEqual(container.envVars, {
    BAO_STATIC_SEAL_KEY: "seal", BAO_D1_CONNECTION_URL: "",
    BAO_D1_ACCOUNT_ID: "account", BAO_D1_DATABASE_ID: "database", BAO_D1_TOKEN: "token",
    BAO_ADDR: "http://0.0.0.0:8200", SKIP_SETCAP: "true",
  });
});

test("missing settings fail the constructor without attaching credentials to the error", () => {
  const env = { BAO_STATIC_SEAL_KEY: "sentinel-seal", BAO_D1_TOKEN: "sentinel-token" };
  assert.throws(() => new BaoContainer({} as never, env as never), error => {
    assert.match(String(error), /could not find the variables/);
    assert.equal((error as Error).cause, undefined);
    assert.doesNotMatch(JSON.stringify(error, Object.getOwnPropertyNames(error)), /sentinel/);
    return true;
  });
  assert.throws(() => new BaoContainer({} as never, { BAO_D1_CONNECTION_URL: "connection" } as never), /BAO_STATIC_SEAL_KEY/);
});
