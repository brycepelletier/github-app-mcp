import assert from "node:assert/strict";
import test from "node:test";
import { classifyGitFailure, classifyGithubToolFailure, gitErrorResult, guidedGitError } from "../runtime/git-guidance.mjs";

test("unsafe refs return discovery tools instead of an MCP exception", () => {
  const result = classifyGitFailure({ mode: "local", operation: "show", message: "revision is not a safe Git ref." });
  assert.equal(result.error.code, "UNSAFE_GIT_REF");
  assert.deepEqual(result.error.next_actions.map(value => value.tool), ["github/git_local", "github/git_local", "github/git_local"]);
  assert.equal(JSON.stringify(result).includes("revision is not a safe Git ref"), false);
});

test("missing commits explain fetch, observe, and cherry-pick", () => {
  const result = classifyGitFailure({ mode: "local", operation: "cherry_pick", payload: { branch: "topic" }, result: { stderr: "fatal: bad object abc" } });
  assert.equal(result.error.code, "REVISION_NOT_FOUND");
  assert.deepEqual(result.error.next_actions.map(value => value.arguments.operation), ["fetch", "log", "cherry_pick"]);
});

test("non-fast-forward errors return a bounded recovery sequence", () => {
  const result = classifyGitFailure({ mode: "remote", operation: "push", payload: { remote: "origin", branch: "topic" }, result: { stderr: "rejected (non-fast-forward)" } });
  assert.equal(result.error.code, "NON_FAST_FORWARD");
  assert.deepEqual(result.error.next_actions[1].arguments, { operation: "rebase", branch: "origin/topic" });
});

test("guided failures are returned as MCP tool errors", () => {
  const response = gitErrorResult(guidedGitError({ mode: "local", operation: "show", message: "revision is not a safe Git ref." }));
  assert.equal(response.isError, true);
  assert.equal(JSON.parse(response.content[0].text).error.code, "UNSAFE_GIT_REF");
});

test("unexpected runtime failures are not mislabeled as input errors", () => {
  const response = gitErrorResult(new Error("Docker unavailable"));
  assert.equal(JSON.parse(response.content[0].text).error.code, "GIT_INFRASTRUCTURE_FAILED");
});

test("a leading-colon branch forbids blind retries", () => {
  const result = classifyGitFailure({ mode: "remote", operation: "push", payload: { branch: ":agent/topic" }, message: "branch is not a safe Git ref." });
  assert.equal(result.error.code, "LEADING_COLON_GIT_REF");
  assert.equal(result.error.retry_policy.retry_same_call, false);
  assert.equal(JSON.stringify(result.error.next_actions).includes(":agent/topic"), false);
});

test("PRs without unique commits route back to branch evidence", () => {
  const result = classifyGithubToolFailure(
    "create_pull_request",
    { head: "agent/topic-new", base: "main" },
    { content: [{ type: "text", text: "failed to create pull request: Validation Failed: No commits between main and agent/topic-new" }] }
  );
  assert.equal(result.error.code, "PR_HEAD_HAS_NO_UNIQUE_COMMITS");
  assert.equal(result.error.retry_policy.retry_same_call, false);
  assert.deepEqual(result.error.next_actions.map(value => value.tool), ["github/search_pull_requests", "github/git_local", "github/git_local", "github/git_remote"]);
});
