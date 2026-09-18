#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAppAuth } from "@octokit/auth-app";

const WORKSPACE = "/workspace";
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const REF = /^(?!-)(?!.*\.\.)(?!.*[@{~^:?*\\\[\x00-\x20])(?!.+\.$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fail(message) {
  const error = new Error(message);
  error.exposed = true;
  throw error;
}

async function readPayload() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) fail("Git request exceeds the input limit.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    fail("Git request is not valid JSON.");
  }
}

export function safeRef(value, field) {
  if (typeof value !== "string" || !REF.test(value)) fail(`${field} is not a safe Git ref.`);
  return value;
}

export function safeRemote(value = "origin") {
  if (!REMOTE.test(value)) fail("remote is not a safe Git remote name.");
  return value;
}

function safePaths(values = []) {
  if (!Array.isArray(values) || values.length > 128) fail("paths must be a bounded array.");
  return values.map((value) => {
    if (typeof value !== "string" || !value || value.includes("\0")) fail("A path is invalid.");
    const resolved = path.resolve(WORKSPACE, value);
    if (resolved !== WORKSPACE && !resolved.startsWith(`${WORKSPACE}/`)) fail("A path escapes the workspace.");
    return path.relative(WORKSPACE, resolved) || ".";
  });
}

function localArgs(input) {
  const paths = safePaths(input.paths);
  switch (input.operation) {
    case "status": return ["status", "--short", "--branch", ...(paths.length ? ["--", ...paths] : [])];
    case "diff": return ["diff", ...(input.staged ? ["--cached"] : []), ...(input.revision ? [safeRef(input.revision, "revision")] : []), ...(paths.length ? ["--", ...paths] : [])];
    case "log": return ["log", `--max-count=${Math.min(input.max_count || 20, 200)}`, "--decorate", "--oneline", ...(input.revision ? [safeRef(input.revision, "revision")] : [])];
    case "show": return ["show", "--stat", "--oneline", safeRef(input.revision || "HEAD", "revision")];
    case "branch_list": return ["branch", "--list", "--verbose"];
    case "branch_create": return ["branch", safeRef(input.branch, "branch"), ...(input.revision ? [safeRef(input.revision, "revision")] : [])];
    case "switch": return ["switch", safeRef(input.branch, "branch")];
    case "add": if (!paths.length) fail("add requires paths."); return ["add", "--", ...paths];
    case "commit": if (!input.message) fail("commit requires message."); return ["commit", "--message", input.message];
    case "merge": return ["merge", "--no-edit", safeRef(input.branch || input.revision, "branch")];
    case "rebase": return ["rebase", safeRef(input.branch || input.revision, "branch")];
    case "cherry_pick": return ["cherry-pick", safeRef(input.revision, "revision")];
    case "tag_create": if (!input.message) fail("tag_create requires message."); return ["tag", "--annotate", safeRef(input.branch, "tag"), "--message", input.message, ...(input.revision ? [safeRef(input.revision, "revision")] : [])];
    case "stash_push": return ["stash", "push", ...(input.message ? ["--message", input.message] : []), ...(paths.length ? ["--", ...paths] : [])];
    case "stash_pop": return ["stash", "pop"];
    case "pull_merge": {
      safeRemote(input.remote);
      if (input.branch) safeRef(input.branch, "branch");
      return ["merge", "--ff-only", "FETCH_HEAD"];
    }
    default: fail("Unsupported local Git operation.");
  }
}

export function stripDiffHunkCoordinates(output) {
  return String(output).replace(
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm,
    "@@"
  );
}

export function baseGitArgs(args) {
  return [
    "-c", `safe.directory=${WORKSPACE}`,
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "credential.helper=",
    "-c", "protocol.file.allow=never",
    "-c", "submodule.recurse=false",
    ...args,
  ];
}

export function scrub(text, secrets = []) {
  let result = String(text || "");
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  result = result
    .replace(/gh[opsu]_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/https:\/\/x-access-token:[^@\s]+@github\.com\/[^\s]+/gi, "[REDACTED]")
    .replace(/x-access-token:[^@\s]+@/gi, "[REDACTED]");
  return result;
}

function runGit(args, { env = {}, secrets = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", baseGitArgs(args), {
      cwd: WORKSPACE,
      shell: false,
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp/github-app-mcp",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        GIT_MERGE_AUTOEDIT: "no",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes <= MAX_OUTPUT_BYTES) stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { bytes += chunk.length; if (bytes <= MAX_OUTPUT_BYTES) stderr.push(chunk); });
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exit_code: code ?? -1,
        signal: signal ?? null,
        stdout: scrub(Buffer.concat(stdout).toString("utf8"), secrets),
        stderr: scrub(Buffer.concat(stderr).toString("utf8"), secrets),
        truncated: bytes > MAX_OUTPUT_BYTES,
      });
    });
  });
}

export function parseGithubRemoteUrl(value) {
  const scpMatch = value.match(
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
  );
  if (scpMatch) {
    const [, owner, repository] = scpMatch;
    return {
      url: `https://github.com/${owner}/${repository}.git`,
      owner,
      repository,
      configured_scheme: "ssh",
    };
  }

  let parsed;
  try { parsed = new URL(value); } catch { fail("Remote must be a GitHub HTTPS or SSH URL."); }
  const scheme = parsed.protocol === "https:"
    ? "https"
    : parsed.protocol === "ssh:"
      ? "ssh"
      : null;
  const validAuthentication = scheme === "https"
    ? !parsed.username && !parsed.password
    : parsed.username === "git" && !parsed.password;
  if (
    !scheme ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    !validAuthentication
  ) {
    fail("Remote must be a credential-free GitHub HTTPS or SSH URL.");
  }
  const match = parsed.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
  );
  if (!match) fail("Remote URL must identify one GitHub owner/repository.");
  const [, owner, repository] = match;
  return {
    url: `https://github.com/${owner}/${repository}.git`,
    owner,
    repository,
    configured_scheme: scheme,
  };
}

export async function remoteUrl(remote, gitRunner = runGit) {
  const result = await gitRunner(["remote", "get-url", remote]);
  if (result.exit_code !== 0) fail("Git remote does not exist.");
  return parseGithubRemoteUrl(result.stdout.trim());
}

export function safeAuthFailure(error) {
  // Never expose upstream bodies, headers, URLs, request objects, or credentials.
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return `GitHub App authentication failed (HTTP ${status})`;
  const code = error?.cause?.code || error?.code;
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) return `GitHub App authentication failed (network ${code})`;
  return 'GitHub App authentication failed';
}

async function installationToken(repository) {
  const appId = Number(process.env.GITHUB_APP_ID);
  const installationId = Number(process.env.GITHUB_APP_INSTALLATION_ID);
  const pemPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId || !installationId || pemPath !== "/secrets/github-app.pem") fail("required GitHub App configuration is missing");
  const privateKey = await fsp.readFile(pemPath, "utf8");
  const auth = createAppAuth({ appId, privateKey });
  try {
    const result = await auth({
      type: "installation",
      installationId,
      repositoryNames: [repository],
      permissions: { contents: "write", workflows: "write" },
    });
    return result.token;
  } catch (error) {
    fail(safeAuthFailure(error));
  }
}

export async function remoteArgs(input, urlResolver = remoteUrl) {
  const remote = safeRemote(input.remote);
  const identity = await urlResolver(remote);
  const transportUrl = identity.url;
  switch (input.operation) {
    case "fetch": return input.branch
      ? ["fetch", "--no-tags", transportUrl, safeRef(input.branch, "branch")]
      : ["fetch", "--no-tags", "--prune", transportUrl, `+refs/heads/*:refs/remotes/${remote}/*`];
    case "pull": return ["fetch", "--no-tags", transportUrl, ...(input.branch ? [safeRef(input.branch, "branch")] : [])];
    case "push": return ["push", transportUrl, safeRef(input.branch, "branch")];
    case "push_dry_run": return ["push", "--dry-run", transportUrl, safeRef(input.branch, "branch")];
    case "ls_remote": return ["ls-remote", transportUrl, ...(input.branch ? [safeRef(input.branch, "branch")] : [])];
    case "auth_check": return [];
    default: fail("Unsupported remote Git operation.");
  }
}

export async function verifyRepositoryAccess(identity, token, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repository)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch (error) {
    fail(safeAuthFailure(error));
  }
  if (!response.ok) fail(`installation cannot access repository${Number.isInteger(response.status) ? ` (HTTP ${response.status})` : ""}`);
  return {
    authenticated: true,
    repository_authorized: true,
    repository: `${identity.owner}/${identity.repository}`,
    remote_scheme: "https",
    configured_remote_scheme: identity.configured_scheme,
    permissions: { contents: "write", workflows: "write" },
    credential_exposed: false,
  };
}

async function main() {
  if (process.platform !== "linux" || process.cwd() !== WORKSPACE) fail("Invalid Git runtime environment.");
  const mode = process.argv[2];
  const input = await readPayload();

  if (mode === "local") {
    const result = await runGit(localArgs(input));
    if (input.operation === "diff") {
      result.stdout = stripDiffHunkCoordinates(result.stdout);
    }
    process.stdout.write(JSON.stringify({ ok: true, result }));
    return;
  }
  if (mode !== "remote") fail("Invalid Git trust mode.");

  const remote = safeRemote(input.remote);
  const identity = await remoteUrl(remote);
  const token = await installationToken(identity.repository);
  if (input.operation === "auth_check") {
    const result = await verifyRepositoryAccess(identity, token);
    process.stdout.write(JSON.stringify({ ok: true, result }));
    return;
  }
  const askpass = "/tmp/github-app-mcp/askpass.sh";
  await fsp.mkdir(path.dirname(askpass), { recursive: true, mode: 0o700 });
  await fsp.writeFile(askpass, "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' x-access-token;; *) printf '%s\\n' \"$GITHUB_APP_TOKEN\";; esac\n", { mode: 0o700 });

  const gitResult = await runGit(await remoteArgs(input), {
    env: { GIT_ASKPASS: askpass, GITHUB_APP_TOKEN: token },
    secrets: [token],
  });

  const result = input.operation === "push_dry_run"
    ? {
        authenticated: gitResult.exit_code === 0,
        transport: "https",
        dry_run: true,
        operation_completed: "push_dry_run",
        requested_push_completed: false,
        ...gitResult,
        credential_exposed: false,
        summary: gitResult.exit_code === 0
          ? "Authenticated push dry run succeeded; no refs were changed. If a real push was requested, call push next, then ls_remote to verify it."
          : "Authenticated push dry run failed; no refs were changed.",
      }
    : gitResult;

  process.stdout.write(JSON.stringify({ ok: true, result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: error?.exposed ? error.message : "Git operation failed inside the trusted runtime." }));
    if (!error?.exposed) console.error("github-app-mcp git runtime failure");
    process.exitCode = 1;
  });
}
