import http from "node:http";
import fs from "node:fs";
import { createAppAuth } from "@octokit/auth-app";

const appId = Number(process.env.GITHUB_APP_ID);
const installationId = Number(process.env.GITHUB_APP_INSTALLATION_ID);
const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const repository = process.env.GITHUB_REPOSITORY ?? "environment-controller";

if (!appId || !installationId || !privateKeyPath) {
  throw new Error("Missing required GitHub App configuration.");
}

const privateKey = fs.readFileSync(privateKeyPath, "utf8");

const auth = createAppAuth({
  appId,
  privateKey
});

async function getCredential() {
  const result = await auth({
    type: "installation",
    installationId,
    repositoryNames: [repository],
    permissions: {
      contents: "write",
      workflows: "write"
    }
  });

  return [
    "username=x-access-token",
    `password=${result.token}`,
    ""
  ].join("\n");
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" || req.url !== "/credential") {
    res.writeHead(404);
    res.end();
    return;
  }

  try {
    const credential = await getCredential();

    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store"
    });

    res.end(credential);
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end("credential generation failed\n");
  }
});

server.listen(8080, "0.0.0.0", () => {
  console.log("GitHub token broker listening on port 8080");
});