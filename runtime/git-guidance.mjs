const SAFE_REF_MESSAGE = /(?:revision|branch|tag) is not a safe Git ref/i;

export class GuidedGitError extends Error {
  constructor(guidance) {
    super(guidance.summary);
    this.name = "GuidedGitError";
    this.guidance = guidance;
  }
}

function action(tool, arguments_, purpose) {
  return { tool, arguments: arguments_, purpose };
}

function baseGuidance(code, summary, category, nextActions, observed = undefined) {
  return {
    ok: false,
    error: {
      code,
      summary,
      category,
      recoverable: category !== "external_blocker",
      retry_policy: {
        retry_same_call: false,
        requirement: "Complete and observe a listed prerequisite or another concrete state change before retrying.",
      },
      next_actions: nextActions,
      ...(observed ? { observed } : {}),
    },
  };
}

export function classifyGitFailure({ mode, operation, payload = {}, message = "", result } = {}) {
  const detail = `${message}\n${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
  const remote = payload.remote || "origin";
  const branch = payload.branch;

  if (SAFE_REF_MESSAGE.test(detail)) {
    const leadingColon = [payload.branch, payload.revision].some(value => typeof value === "string" && value.startsWith(":"));
    return baseGuidance(
      leadingColon ? "LEADING_COLON_GIT_REF" : "UNSAFE_GIT_REF",
      leadingColon
        ? "Git branch and revision arguments must not begin with a colon. The request was rejected before Git ran."
        : "The revision/branch argument was rejected before Git ran.",
      "recoverable_input",
      [
        action("github/git_local", { operation: "status" }, "Observe the current branch and worktree."),
        action("github/git_local", { operation: "branch_list" }, "Choose an exact local branch name."),
        action("github/git_local", { operation: "log", max_count: 20 }, "Choose an exact observed commit ID when a revision is required."),
      ]
    );
  }

  if (/bad revision|unknown revision|ambiguous argument|not a valid object name|bad object/i.test(detail)) {
    return baseGuidance(
      "REVISION_NOT_FOUND",
      "The requested commit or ref is not present in the local object database.",
      "recoverable_repository_state",
      [
        action("github/git_remote", { operation: "fetch", remote, ...(branch ? { branch } : {}) }, "Fetch the branch that contains the commit."),
        action("github/git_local", { operation: "log", max_count: 20 }, "Observe an exact fetched commit ID."),
        action("github/git_local", { operation: "cherry_pick", revision: "<observed-commit-id>" }, "Apply that one observed commit to the current branch."),
      ]
    );
  }

  if (/non-fast-forward|fetch first|rejected.*behind|tip of your current branch is behind/i.test(detail)) {
    return baseGuidance(
      "NON_FAST_FORWARD",
      "The remote branch advanced and the push was rejected without changing remote state.",
      "recoverable_repository_state",
      [
        action("github/git_remote", { operation: "fetch", remote }, "Refresh remote branch objects."),
        action("github/git_local", { operation: "rebase", branch: branch ? `${remote}/${branch}` : "<observed-remote-branch>" }, "Replay local commits after the observed remote branch."),
        action("github/git_remote", { operation: "push", remote, ...(branch ? { branch } : {}) }, "Retry only after status and history confirm the rebase result."),
      ]
    );
  }

  if (/local changes.*would be overwritten|would be overwritten by (?:merge|checkout)|please commit your changes or stash/i.test(detail)) {
    return baseGuidance(
      "DIRTY_WORKTREE_BLOCKS_OPERATION",
      "Uncommitted work prevents the requested branch operation.",
      "recoverable_repository_state",
      [
        action("github/git_local", { operation: "status" }, "Inventory staged, unstaged, and untracked work."),
        action("github/git_local", { operation: "diff" }, "Inspect unstaged changes before choosing a preservation strategy."),
        action("github/git_local", { operation: "diff", staged: true }, "Inspect staged changes before choosing a preservation strategy."),
      ]
    );
  }

  if (/conflict|after resolving the conflicts|cherry-pick is now empty/i.test(detail)) {
    return baseGuidance(
      "GIT_CONFLICT",
      "Git stopped because the operation requires conflict resolution.",
      "implementation_required",
      [
        action("github/git_local", { operation: "status" }, "Observe conflicted paths and operation state."),
        action("Software Engineer", {}, "Resolve source conflicts through the engineering workspace, then return explicit paths for staging."),
      ]
    );
  }

  if (/could not read from remote repository|repository not found|authentication failed|installation cannot access repository/i.test(detail)) {
    return baseGuidance(
      "REMOTE_AUTHORIZATION_FAILED",
      "GitHub authentication or repository authorization failed.",
      "external_blocker",
      [action("github/git_remote", { operation: "auth_check", remote }, "Re-run the authoritative repository authorization gate after the authorization or network prerequisite changes.")],
      { diagnostic: detail.match(/\(HTTP [45]\d{2}\)|\(network [A-Z_]+\)/)?.[0] || "No safe upstream status available" }
    );
  }

  return baseGuidance(
    "GIT_OPERATION_FAILED",
    `The structured ${mode || "Git"} operation '${operation || "unknown"}' failed.`,
    "recoverable_unknown",
    [
      action("github/git_local", { operation: "status" }, "Re-establish repository state."),
      ...(mode === "remote" ? [action("github/git_remote", { operation: "auth_check", remote }, "Re-establish remote authorization.")] : []),
    ],
    detail.trim().slice(0, 2048) || undefined
  );
}

export function guidedGitError(input) {
  return new GuidedGitError(classifyGitFailure(input));
}

export function gitErrorResult(error) {
  const body = error instanceof GuidedGitError
    ? error.guidance
    : error?.name === "ZodError"
      ? baseGuidance(
        "GIT_REQUEST_INVALID",
        "The Git tool request did not match the structured schema.",
        "recoverable_input",
        [action("github/git_local", { operation: "status" }, "Re-establish repository state, then retry with only documented fields.")]
      )
      : baseGuidance(
        "GIT_INFRASTRUCTURE_FAILED",
        "The trusted Git runtime could not complete the structured operation.",
        "external_blocker",
        []
      );
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  };
}

function toolText(result) {
  return (result?.content ?? [])
    .filter(item => item?.type === "text")
    .map(item => item.text)
    .join("\n");
}

export function classifyGithubToolFailure(tool, payload, result) {
  const detail = toolText(result);
  if (!result?.isError && !/failed|validation failed|no commits between/i.test(detail)) return null;

  if (tool === "create_pull_request" && /no commits between/i.test(detail)) {
    return baseGuidance(
      "PR_HEAD_HAS_NO_UNIQUE_COMMITS",
      "GitHub rejected replacement PR creation. Locate and update the existing PR head branch instead of creating another branch or PR.",
      "recoverable_repository_state",
      [
        action("github/search_pull_requests", { query: `is:pr is:open base:${payload.base}` }, "Locate the existing pull request and observe its exact head branch."),
        action("github/git_local", { operation: "status" }, "Verify the current local branch and preserve worktree state."),
        action("github/git_local", { operation: "branch_list" }, "Determine whether the existing PR head already exists locally."),
        action("github/git_remote", { operation: "ls_remote", remote: "origin", branch: "<observed-existing-pr-head>" }, "Verify the existing PR head before updating it."),
      ]
    );
  }

  if (tool === "create_pull_request" && /pull request already exists|already a pull request/i.test(detail)) {
    return baseGuidance(
      "PR_ALREADY_EXISTS",
      "A pull request already exists for this head/base relationship.",
      "recoverable_repository_state",
      [
        action("github/search_pull_requests", { query: `head:${payload.head} base:${payload.base}` }, "Locate the existing pull request."),
        action("github/update_pull_request", { pullNumber: "<observed-pr-number>" }, "Update only the observed existing pull request when required."),
      ]
    );
  }

  if (tool === "create_pull_request" && /head.*(?:invalid|not found)|unprocessable entity/i.test(detail)) {
    return baseGuidance(
      "PR_HEAD_NOT_AVAILABLE",
      "GitHub could not resolve the proposed remote head branch.",
      "recoverable_repository_state",
      [
        action("github/git_remote", { operation: "ls_remote", remote: "origin", branch: payload.head }, "Verify the exact head branch on GitHub."),
        action("github/git_local", { operation: "status" }, "Verify the intended local branch."),
      ]
    );
  }

  return null;
}

export function githubToolErrorResult(guidance) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(guidance, null, 2) }],
  };
}
