import assert from "node:assert/strict";
import test from "node:test";
import {
  baseGitArgs,
  parseGithubRemoteUrl,
  remoteArgs,
  remoteUrl,
  safeRef,
  safeRemote,
  scrub,
  stripDiffHunkCoordinates,
  verifyRepositoryAccess,
} from "../runtime/git-helper.mjs";
import { gitRemoteSchema } from "../runtime/schemas.mjs";

const validIdentity = {
  url: "https://github.com/owner/repository.git",
  owner: "owner",
  repository: "repository",
  configured_scheme: "https",
};
const resolveValidRemote = async () => validIdentity;

test("Git diff output omits source line coordinates", () => {
  const diff = [
    "diff --git a/example.txt b/example.txt",
    "@@ -12,2 +12,3 @@ section",
    " context",
    "-old",
    "+new",
  ].join("\n");
  const result = stripDiffHunkCoordinates(diff);
  assert.equal(result.includes("-12,2 +12,3"), false);
  assert.match(result, /^@@ section$/m);
  assert.match(result, /^ context$/m);
});

test("auth_check and push_dry_run are bounded remote operations", async () => {
  assert.equal(gitRemoteSchema.parse({ operation: "auth_check" }).operation, "auth_check");
  assert.equal(gitRemoteSchema.parse({ operation: "push_dry_run", branch: "main" }).operation, "push_dry_run");
  assert.deepEqual(await remoteArgs({ operation: "auth_check", remote: "origin" }, resolveValidRemote), []);
  assert.deepEqual(
    await remoteArgs({ operation: "push_dry_run", remote: "origin", branch: "main" }, resolveValidRemote),
    ["push", "--dry-run", "https://github.com/owner/repository.git", "main"]
  );
});

test("push_dry_run requires a safe explicit branch", async () => {
  assert.throws(() => gitRemoteSchema.parse({ operation: "push_dry_run" }));
  await assert.rejects(() => remoteArgs({ operation: "push_dry_run", remote: "origin" }, resolveValidRemote));
  for (const branch of ["--force", ":main", "main..other", "bad branch", "refs/heads/main:refs/heads/other"]) {
    await assert.rejects(() => remoteArgs({ operation: "push_dry_run", remote: "origin", branch }, resolveValidRemote));
  }
});

test("remote and ref validation reject injection primitives", () => {
  for (const remote of ["--upload-pack=evil", "origin;sh", "origin name", "https://github.com/o/r"]) {
    assert.throws(() => safeRemote(remote));
  }
  for (const ref of ["-f", ":main", "a~1", "a^1", "a b", "a:b"]) {
    assert.throws(() => safeRef(ref, "branch"));
  }
});

test("remote URL canonicalizes credential-free GitHub HTTPS and SSH", async () => {
  const runner = (url) => async () => ({ exit_code: 0, stdout: `${url}\n` });
  assert.deepEqual(await remoteUrl("origin", runner("https://github.com/owner/repository.git")), {
    url: "https://github.com/owner/repository.git", owner: "owner", repository: "repository",
    configured_scheme: "https",
  });
  for (const url of [
    "git@github.com:owner/repository.git",
    "ssh://git@github.com/owner/repository.git",
  ]) {
    assert.deepEqual(await remoteUrl("origin", runner(url)), {
      url: "https://github.com/owner/repository.git", owner: "owner", repository: "repository",
      configured_scheme: "ssh",
    });
  }
  for (const url of [
    "git@gitlab.com:owner/repository.git",
    "ssh://other@github.com/owner/repository.git",
    "https://gitlab.com/owner/repository.git",
    "https://x-access-token:secret@github.com/owner/repository.git",
  ]) await assert.rejects(() => remoteUrl("origin", runner(url)));
});

test("GitHub SSH parsing never changes the configured remote", () => {
  const identity = parseGithubRemoteUrl("git@github.com:owner/repository.git");
  assert.equal(identity.configured_scheme, "ssh");
  assert.equal(identity.url, "https://github.com/owner/repository.git");
  assert.equal(Object.hasOwn(identity, "configured_url"), false);
});

test("base Git environment disables hooks, signing, file transport, and submodules", () => {
  const args = baseGitArgs(["status"]);
  for (const setting of ["core.hooksPath=/dev/null", "commit.gpgSign=false", "tag.gpgSign=false", "protocol.file.allow=never", "submodule.recurse=false"]) {
    assert.ok(args.includes(setting));
  }
});

test("redaction covers GitHub token classes, exact secrets, and credential URLs", () => {
  const exact = "dynamic-token-with-an-unusual-format";
  const values = [
    "ghs_12345678901234567890", "gho_12345678901234567890",
    "ghp_12345678901234567890", "ghu_12345678901234567890", exact,
    "https://x-access-token:FAKE_SECRET@github.com/owner/repository.git",
  ];
  const output = scrub(values.join("\n"), [exact]);
  for (const value of values) assert.ok(!output.includes(value));
  assert.equal(output.split("\n").every((value) => value === "[REDACTED]"), true);
});

test("repository verification returns fixed data and never consumes a response body", async () => {
  let bodyRead = false;
  const result = await verifyRepositoryAccess(validIdentity, "fake-token", async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer fake-token");
    return { ok: true, json: () => { bodyRead = true; } };
  });
  assert.equal(bodyRead, false);
  assert.deepEqual(result, {
    authenticated: true, repository_authorized: true, repository: "owner/repository",
    remote_scheme: "https", configured_remote_scheme: "https",
    permissions: { contents: "write", workflows: "write" },
    credential_exposed: false,
  });
});

test("authentication failures are sanitized", async () => {
  await assert.rejects(
    () => verifyRepositoryAccess(validIdentity, "ghs_12345678901234567890", async () => { throw new Error("ghs_12345678901234567890"); }),
    (error) => error.message === "GitHub App authentication failed" && !error.message.includes("ghs_")
  );
  await assert.rejects(
    () => verifyRepositoryAccess(validIdentity, "fake", async () => ({ ok: false })),
    { message: "installation cannot access repository" }
  );
});

test("structured construction exposes no arbitrary command or host path fields", async () => {
  const input = {
    operation: "push_dry_run", remote: "origin", branch: "main",
    executable: "sh", shell: "rm -rf /", args: ["--force"], docker_args: ["--privileged"],
    workspace: "C:\\secret", pem_path: "/secret.pem",
  };
  assert.deepEqual(await remoteArgs(input, resolveValidRemote), ["push", "--dry-run", "https://github.com/owner/repository.git", "main"]);
  for (const field of ["executable", "shell", "args", "docker_args", "workspace", "pem_path"]) {
    assert.throws(() => gitRemoteSchema.parse({ operation: "auth_check", [field]: input[field] }));
  }
});

test("auth diagnostics expose only allowlisted HTTP/network metadata", async () => {
  const { safeAuthFailure } = await import('../runtime/git-helper.mjs');
  assert.equal(safeAuthFailure({status:401,message:'SECRET',request:{headers:{authorization:'SECRET'}}}), 'GitHub App authentication failed (HTTP 401)');
  assert.equal(safeAuthFailure({cause:{code:'ENOTFOUND'},message:'SECRET'}), 'GitHub App authentication failed (network ENOTFOUND)');
  assert.equal(safeAuthFailure({code:'SECRET',message:'SECRET'}), 'GitHub App authentication failed');
});
