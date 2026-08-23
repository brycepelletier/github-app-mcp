# `@brycepelletier/github-app-mcp`

A single MCP stdio facade for the GitHub Operator role. It combines bounded Git
operations over the active workspace with GitHub API tools delegated to GitHub's
official MCP server. It never returns a GitHub App private key or installation
token.

## Architecture and responsibility split

```text
Software Engineer                    GitHub Operator
       |                                    |
agent-env-mcp                         github-app-mcp
       |                         /-----------+-----------\
source/build/edit            ephemeral Git runtime   official GitHub MCP
.git masked                  real .git               GitHub API
no GitHub credentials        local: no network       fixed toolsets
                             remote: App auth
```

`agent-env-mcp` remains the engineering capability surface. Its engineering
container physically masks `.git` and receives no GitHub credential. This package
is the sole intended model-facing Git/GitHub surface for `github-operator.agent.md`.

The facade discovers the workspace with MCP `roots/list`, requires exactly one
local `file:` root, rejects filesystem roots, and requires real `.git` metadata.
No model tool parameter can select a host path, PEM, image, toolset, or Docker
argument.

## Trust boundaries and Docker behavior

```text
MCP client
   | stdio
host-side trusted launcher (may control Docker; no Docker socket is mounted)
   |-- git_local  -> ephemeral container, workspace mount, network=none, no PEM
   |-- git_remote -> ephemeral container, workspace + read-only PEM, GitHub HTTPS
   `-- API tools  -> ghcr.io/github/github-mcp-server, read-only PEM
```

Local Git and remote Git have different execution modes. `git_local` exposes an
operation enum and typed fields rather than a shell or arbitrary Git argument
array. Its container has real `.git`, but no network and no credential material.

`git_remote` accepts only `fetch`, fast-forward-only `pull`, `push`, and
`ls_remote`, with bounded remote/ref fields. It requires a credential-free
`https://github.com/owner/repository` remote, derives repository identity from
that configured remote, and requests an installation token restricted to that
repository with `contents:write` and `workflows:write`. The token is minted inside
the ephemeral runtime, supplied to Git through a private askpass helper, redacted
from output, and discarded with the container. `pull` performs authenticated
fetch first, followed by a credential-free `--ff-only` merge.

Git hooks, global/system configuration, file transport, submodule recursion,
interactive editors, GPG signing, and terminal credential prompts are disabled.
Output is bounded and scrubbed for GitHub token patterns and credential-bearing
URLs.

GitHub Issues, pull requests, reviews, Actions, Projects, and searches are not
reimplemented. They are proxied over MCP to:

```text
ghcr.io/github/github-mcp-server
```

The official server receives exactly:

```text
GITHUB_TOOLSETS=context,issues,pull_requests,actions,projects
```

No unrelated toolsets are silently enabled.

## Configuration and provenance

The launcher recognizes:

- `GITHUB_APP_ID` — defaults to `4618233`.
- `GITHUB_APP_INSTALLATION_ID` — defaults to `154276908`.
- `GITHUB_APP_PRIVATE_KEY_PATH` — required absolute or resolvable host path.

The two numeric defaults are documented working values from the user's existing
VS Code GitHub MCP configuration and earlier compose setup for GitHub App
`bp-agent-github-app`. They are defaults, not unexplained package-wide secrets,
and may be overridden. The GitHub installation/settings page remains the source
of truth for repository access. The App was originally installed for
`brycepelletier/environment-controller`.

The package deliberately has no default host PEM filename. Earlier material only
establishes that it was somewhere below `C:/Users/bryce/.ssh/`; that is not enough
to guess safely. The configured host file is mounted read-only at the fixed
container path `/secrets/github-app.pem`. The key is never copied into the npm
package, printed, accepted as tool input, or returned through MCP.

## Host prerequisites and MCP lifecycle

- Node.js 24 LTS or compatible Node 24 release
- Docker with Linux-container support
- GitHub App PEM readable by the trusted host-side launcher
- One local Git workspace supplied through MCP roots
- Network access from the remote Git and official GitHub containers

The official GitHub child server starts lazily when tools are listed or an API
tool is called. Git runtime images build lazily on the first Git operation and are
reused by a package-version/content-derived local tag; Git operation containers
are ephemeral (`--rm`). SIGINT/SIGTERM closes the official child transport.

## Local linking

From Git Bash in this package directory:

```bash
npm run link
```

Unlink with:

```bash
npm run unlink
```

## VS Code configuration

Provide the host PEM path as environment configuration and expose one MCP entry:

```json
{
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "@brycepelletier/github-app-mcp@0.1.0"],
      "env": {
        "GITHUB_APP_PRIVATE_KEY_PATH": "<exact-host-path-to-existing-pem>"
      }
    }
  }
}
```

The working App and installation IDs need not be repeated unless overriding the
documented defaults.

## Migration from `github-token-broker`

The old private broker listened on `0.0.0.0:8080` and returned installation
tokens from `GET /credential` in Git credential-helper format. That architecture
is retired: this package has no HTTP listener, credential endpoint, or token
response. Existing broker source is retained for audit/migration history but is
not shipped by this package.

After this package is operational, follow up in `agent-env-mcp` by removing its
Git service and public `git_command`. That is intentionally outside this change.
The engineering service must continue masking real `.git` and must never receive
the PEM, installation tokens, or GitHub MCP tools.
