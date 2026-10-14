import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// workerd rejects the whole upload ("Incorrect type for map entry") when the entry module
// exports anything but handlers and Durable Object classes, such as a plain constant.
test("the built entry module exports only the handlers and the container class", async () => {
  const entry = await import("../dist/index.js");
  assert.deepEqual(Object.keys(entry).sort(), ["BaoContainer", "default"]);
  assert.equal(typeof entry.BaoContainer, "function");
  assert.equal(typeof entry.default.fetch, "function");
  assert.equal(typeof entry.default.scheduled, "function");
});
