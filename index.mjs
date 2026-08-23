#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "./package.json" with { type: "json" };
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { requiredConfiguration } from "./runtime/config.mjs";
import { GIT_REMOTE_OPERATIONS, gitRemoteSchema } from "./runtime/schemas.mjs";
import {
  createOfficialContainerCleanup,
  officialContainerName,
} from "./runtime/lifecycle.mjs";

const VERSION = packageJson.version;
const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.join(SERVER_ROOT, "runtime");
const RUNTIME_DOCKERFILE = path.join(RUNTIME_DIR, "Dockerfile");
const GITHUB_IMAGE = "ghcr.io/github/github-mcp-server";
const CONTAINER_PEM_PATH = "/secrets/github-app.pem";
const TOOLSETS = "context,issues,pull_requests,actions,projects";

const MAX_OUTPUT_BYTES = 256 * 1024;
const OFFICIAL_CONTAINER_NAME = officialContainerName(
  process.pid,
  randomBytes(8).toString("hex")
);

const server = new Server(
  { name: "github-app-mcp", version: VERSION },
  { capabilities: { tools: {} } }
);

let githubClient;
let githubTransport;
let officialToolsPromise;
let runtimeImagePromise;
let shutdownPromise;

const cleanupOfficialContainer = createOfficialContainerCleanup({
  getTransport: () => githubTransport,
  clearTransport: () => {
    githubTransport = undefined;
    githubClient = undefined;
    officialToolsPromise = undefined;
  },
  removeContainer: async () => {
    await runProcess("docker", ["rm", "--force", OFFICIAL_CONTAINER_NAME], {
      timeoutMs: 15_000,
    });
  },
});

function runProcess(command, args, { input = "", timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const capture = (target, chunk, stream) => {
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if ((stream === "stdout" ? stdoutBytes : stderrBytes) <= MAX_OUTPUT_BYTES) {
        target.push(chunk);
      }
      if (stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", (chunk) => capture(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(stderr, chunk, "stderr"));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        overflow: stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES,
      });
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdin.end(input || undefined);
  });
}

async function discoverWorkspaceRoot() {
  let result;
  try {
    result = await server.listRoots();
  } catch (error) {
    throw new Error(
      "The MCP client did not provide workspace roots. Open exactly one local Git workspace.",
      { cause: error }
    );
  }

  const roots = result?.roots ?? [];
  if (roots.length !== 1) {
    throw new Error(
      `github-app-mcp requires exactly one workspace root; received ${roots.length}.`
    );
  }

  const rootUrl = new URL(roots[0].uri);
  if (rootUrl.protocol !== "file:") {
    throw new Error("github-app-mcp supports only a local file: workspace root.");
  }

  const workspace = fs.realpathSync.native(fileURLToPath(rootUrl));
  if (!fs.statSync(workspace).isDirectory()) {
    throw new Error("The workspace root is not a directory.");
  }
  if (path.normalize(workspace) === path.normalize(path.parse(workspace).root)) {
    throw new Error("Refusing to mount an entire filesystem root.");
  }

  const gitMetadata = path.join(workspace, ".git");
  if (!fs.existsSync(gitMetadata)) {
    throw new Error("The selected workspace does not expose real .git metadata.");
  }
  return workspace;
}

function runtimeImageName() {
  const digest = createHash("sha256")
    .update(fs.readFileSync(RUNTIME_DOCKERFILE))
    .update(fs.readFileSync(path.join(RUNTIME_DIR, "git-helper.mjs")))
    .update(fs.readFileSync(path.join(SERVER_ROOT, "package.json")))
    .digest("hex")
    .slice(0, 12);
  return `github-app-mcp-runtime:${VERSION}-${digest}`;
}

async function ensureRuntimeImage() {
  if (!runtimeImagePromise) {
    runtimeImagePromise = (async () => {
      const image = runtimeImageName();
      const inspect = await runProcess("docker", ["image", "inspect", image], {
        timeoutMs: 30_000,
      });
      if (inspect.code === 0) return image;

      const build = await runProcess(
        "docker",
        ["build", "--file", RUNTIME_DOCKERFILE, "--tag", image, SERVER_ROOT],
        { timeoutMs: 10 * 60_000 }
      );
      if (build.code !== 0 || build.overflow) {
        throw new Error("Unable to build the trusted Git runtime image.");
      }
      return image;
    })().catch((error) => {
      runtimeImagePromise = undefined;
      throw error;
    });
  }
  return runtimeImagePromise;
}

function workspaceMount(workspace) {
  return `type=bind,source=${workspace},target=/workspace`;
}

async function invokeGit(mode, payload) {
  const workspace = await discoverWorkspaceRoot();
  const image = await ensureRuntimeImage();
  const dockerArgs = [
    "run",
    "--interactive",
    "--rm",
    "--init",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--mount",
    workspaceMount(workspace),
    "--workdir",
    "/workspace",
  ];

  if (mode === "local") {
    dockerArgs.push("--network", "none");
  } else {
    const config = requiredConfiguration();
    dockerArgs.push(
      "--mount",
      `type=bind,source=${config.pemPath},target=${CONTAINER_PEM_PATH},readonly`,
      "--env",
      `GITHUB_APP_ID=${config.appId}`,
      "--env",
      `GITHUB_APP_INSTALLATION_ID=${config.installationId}`,
      "--env",
      `GITHUB_APP_PRIVATE_KEY_PATH=${CONTAINER_PEM_PATH}`
    );
  }

  dockerArgs.push(image, mode);
  const result = await runProcess("docker", dockerArgs, {
    input: JSON.stringify(payload),
    timeoutMs: 10 * 60_000,
  });

  let response;
  try {
    response = JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error("The trusted Git runtime returned an invalid response.");
  }
  if (result.code !== 0 || response.ok !== true) {
    throw new Error(response.error || "Git operation failed inside the trusted runtime.");
  }

  if (mode === "remote" && payload.operation === "pull") {
    if (response.result?.exit_code !== 0) return response.result;
    const mergeResult = await invokeGit("local", {
      operation: "pull_merge",
      remote: payload.remote,
      branch: payload.branch,
    });
    return {
      fetch: response.result,
      merge: mergeResult,
      exit_code: mergeResult.exit_code,
    };
  }
  return response.result;
}

async function connectOfficialGithub() {
  if (officialToolsPromise) return officialToolsPromise;
  officialToolsPromise = (async () => {
    const config = requiredConfiguration();
    githubClient = new Client(
      { name: "github-app-mcp-facade", version: VERSION },
      { capabilities: {} }
    );
    githubTransport = new StdioClientTransport({
      command: "docker",
      args: [
        "run",
        "-i",
        "--rm",
        "--name",
        OFFICIAL_CONTAINER_NAME,
        "--label",
        "com.brycepelletier.github-app-mcp.role=official-server",
        "--stop-timeout",
        "5",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--mount",
        `type=bind,source=${config.pemPath},target=${CONTAINER_PEM_PATH},readonly`,
        "-e",
        `GITHUB_APP_ID=${config.appId}`,
        "-e",
        `GITHUB_APP_INSTALLATION_ID=${config.installationId}`,
        "-e",
        `GITHUB_APP_PRIVATE_KEY_PATH=${CONTAINER_PEM_PATH}`,
        "-e",
        `GITHUB_TOOLSETS=${TOOLSETS}`,
        GITHUB_IMAGE,
      ],
      stderr: "pipe",
    });
    // Drain child diagnostics without forwarding them to the MCP channel or host
    // logs. The official server is an authentication boundary and may know secrets.
    githubTransport.stderr?.on("data", () => {});
    await githubClient.connect(githubTransport);
    const listed = await githubClient.listTools();
    return listed.tools ?? [];
  })().catch(async (error) => {
    await cleanupOfficialContainer();
    throw error;
  });
  return officialToolsPromise;
}

const gitLocalSchema = z.object({
  operation: z.enum([
    "status", "diff", "log", "show", "branch_list", "branch_create",
    "switch", "add", "commit", "merge", "rebase", "cherry_pick", "tag_create",
    "stash_push", "stash_pop",
  ]),
  paths: z.array(z.string().min(1).max(4096)).max(128).optional(),
  revision: z.string().min(1).max(256).optional(),
  branch: z.string().min(1).max(256).optional(),
  message: z.string().min(1).max(16_384).optional(),
  staged: z.boolean().optional(),
  max_count: z.number().int().min(1).max(200).optional(),
});

const customTools = [
  {
    name: "git_local",
    description: "Run one structured local Git operation with real .git, no credentials, and no network.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: gitLocalSchema.shape.operation.options },
        paths: { type: "array", items: { type: "string" }, maxItems: 128 },
        revision: { type: "string" },
        branch: { type: "string" },
        message: { type: "string" },
        staged: { type: "boolean" },
        max_count: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "git_remote",
    description: "Run a structured GitHub remote operation with internal, ephemeral GitHub App authentication.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: GIT_REMOTE_OPERATIONS },
        remote: { type: "string" },
        branch: { type: "string" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
];

function textResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...customTools, ...(await connectOfficialGithub())],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs = {} } = request.params;
  if (name === "git_local") {
    return textResult(await invokeGit("local", gitLocalSchema.parse(rawArgs)));
  }
  if (name === "git_remote") {
    return textResult(await invokeGit("remote", gitRemoteSchema.parse(rawArgs)));
  }

  const tools = await connectOfficialGithub();
  if (!tools.some((tool) => tool.name === name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return githubClient.callTool({ name, arguments: rawArgs });
});

function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    try {
      await cleanupOfficialContainer();
      await server.close();
    } catch {
      exitCode = 1;
    } finally {
      process.exit(exitCode);
    }
  })();

  return shutdownPromise;
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown());
process.stdin.once("end", () => void shutdown());
process.stdin.once("close", () => void shutdown());
process.stdin.once("error", () => void shutdown(1));
process.stdout.once("error", () => void shutdown(1));
process.on("uncaughtException", () => void shutdown(1));
process.on("unhandledRejection", () => void shutdown(1));

await server.connect(new StdioServerTransport());
