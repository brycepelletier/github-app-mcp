import assert from "node:assert/strict";
import test from "node:test";
import {
  createOfficialContainerCleanup,
  officialContainerName,
} from "../runtime/lifecycle.mjs";

test("official container names are unique-session infrastructure values", () => {
  assert.equal(
    officialContainerName(1234, "a1b2c3d4"),
    "github-app-mcp-official-1234-a1b2c3d4"
  );
  assert.throws(() => officialContainerName(1234, "model supplied/name"));
});

test("official container cleanup closes transport then removes exactly once", async () => {
  const events = [];
  let transport = { close: async () => events.push("close") };
  const cleanup = createOfficialContainerCleanup({
    getTransport: () => transport,
    clearTransport: () => {
      transport = undefined;
      events.push("clear");
    },
    removeContainer: async () => events.push("remove"),
  });

  await Promise.all([cleanup(), cleanup(), cleanup()]);
  assert.deepEqual(events, ["clear", "close", "remove"]);
});

test("official container cleanup removes after transport close failure", async () => {
  const events = [];
  const cleanup = createOfficialContainerCleanup({
    getTransport: () => ({ close: async () => { throw new Error("close failed"); } }),
    clearTransport: () => events.push("clear"),
    removeContainer: async () => events.push("remove"),
  });

  await cleanup();
  assert.deepEqual(events, ["clear", "remove"]);
});
