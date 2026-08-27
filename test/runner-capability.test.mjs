import assert from "node:assert/strict";
import test from "node:test";
import { createRunnerCapabilityBroker } from "../runtime/runner-capability.mjs";

test("runner capabilities are opaque and single use", async () => {
  const broker = createRunnerCapabilityBroker();
  try {
    const reference = await broker.issue("secret-runner-token-value");
    assert.equal(reference.includes("secret-runner-token-value"), false);
    const first = await fetch(reference, { method: "POST" });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { token: "secret-runner-token-value" });
    assert.equal((await fetch(reference, { method: "POST" })).status, 410);
  } finally { await broker.close(); }
});

test("expired runner capabilities cannot be consumed", async () => {
  let timestamp = 1;
  const broker = createRunnerCapabilityBroker({ ttlMs: 10, now: () => timestamp });
  try {
    const reference = await broker.issue("secret-runner-token-value");
    timestamp = 12;
    assert.equal((await fetch(reference, { method: "POST" })).status, 410);
  } finally { await broker.close(); }
});
