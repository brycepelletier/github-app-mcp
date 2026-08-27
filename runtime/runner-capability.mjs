import http from "node:http";
import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60_000;

export function createRunnerCapabilityBroker({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const capabilities = new Map();
  let server;
  let origin;

  async function ensureListening() {
    if (origin) return origin;
    server = http.createServer((request, response) => {
      const match = request.url?.match(/^\/runner-registration\/([a-f0-9]{64})$/);
      if (request.method !== "POST" || !match) { response.writeHead(404).end(); return; }
      const entry = capabilities.get(match[1]);
      capabilities.delete(match[1]);
      if (!entry || entry.expiresAt <= now()) { response.writeHead(410).end(); return; }
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ token: entry.token }));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    origin = `http://127.0.0.1:${address.port}`;
    return origin;
  }

  return {
    async issue(token) {
      if (typeof token !== "string" || token.length < 20) throw new Error("Runner registration token is invalid.");
      const id = randomBytes(32).toString("hex");
      capabilities.set(id, { token, expiresAt: now() + ttlMs });
      return `${await ensureListening()}/runner-registration/${id}`;
    },
    async close() {
      capabilities.clear();
      if (server) await new Promise(resolve => server.close(resolve));
      server = undefined; origin = undefined;
    },
  };
}
