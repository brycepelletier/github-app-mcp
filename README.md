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

`git_local` diff output preserves file headers and verbatim context/change lines
but removes numeric hunk coordinates. No source line is prefixed with generated
line-position metadata that could be mistaken for editable file content.

`git_remote` accepts only `fetch`, fast-forward-only `pull`, `push`, `ls_remote`,
`auth_check`, and `push_dry_run`, with bounded remote/ref fields. It requires a credential-free
GitHub HTTPS or SSH remote, derives repository identity from that configured
remote, canonicalizes SSH forms to credential-free HTTPS internally without
changing `.git/config`, and requests an installation token restricted to that
repository with `contents:write` and `workflows:write`. The token is minted inside
the ephemeral runtime, supplied to Git through a private askpass helper, redacted
from output, and discarded with the container. `pull` performs authenticated
fetch first, followed by a credential-free `--ff-only` merge.

Git hooks, global/system configuration, file transport, submodule recursion,
interactive editors, GPG signing, and terminal credential prompts are disabled.
Output is bounded and scrubbed for GitHub token patterns and credential-bearing
URLs.

## Authentication verification

`git ls-remote` is not proof of authentication: it can succeed anonymously for
a public repository. `auth_check` instead mints a repository-restricted
installation token and calls GitHub's authenticated repository endpoint. Its
fixed response confirms App authentication and repository authorization without
returning the API response or any credential:

```json
{ "operation": "auth_check", "remote": "origin" }
```

```json
{
  "authenticated": true,
  "repository_authorized": true,
  "repository": "owner/repository",
  "remote_scheme": "https",
  "permissions": { "contents": "write", "workflows": "write" },
  "credential_exposed": false
}
```

`push_dry_run` additionally proves that authenticated Git HTTPS transport can
negotiate a push. The runtime always inserts `--dry-run`; callers cannot supply
Git arguments, force flags, or deletion refspecs. GitHub evaluates the proposed
update, but neither local nor remote refs are changed.

```json
{ "operation": "push_dry_run", "remote": "origin", "branch": "main" }
```

```json
{
  "authenticated": true,
  "transport": "https",
  "dry_run": true,
  "exit_code": 0,
  "signal": null,
  "stdout": "",
  "stderr": "Everything up-to-date\n",
  "truncated": false,
  "credential_exposed": false,
  "summary": "Authenticated push dry run succeeded; no refs were changed."
}
```

These checks require an installed App with the requested `contents:write` and
`workflows:write` permissions, repository access, network access, and an exact
configured PEM path. They do not prove that unrelated repositories are
authorized and do not inspect branch-protection outcomes beyond GitHub's dry-run
response.

Run automated checks with `npm test` or the full local package validation with
`npm run validate`. Optional live verification should record the remote branch
object ID with `git ls-remote` before and after `auth_check` and `push_dry_run`,
then confirm the IDs match and all returned `credential_exposed` fields are
false. Never substitute a normal push.

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

The facade additionally exposes
`actions_issue_runner_registration_capability`. It requests a repository runner
registration token internally, stores it behind a random five-minute loopback
capability, and returns only that single-use opaque reference. The Docker MCP
consumes the reference with one POST; a second or expired exchange returns
`410 Gone`. The App installation must grant repository administration write
permission for GitHub's runner-registration endpoint in addition to the
existing content/workflow permissions.

## Configuration and provenance

The launcher requires all three external configuration values and fails closed
before starting an authenticated container if any is absent or invalid:

- `GITHUB_APP_ID` — positive numeric GitHub App identifier.
- `GITHUB_APP_INSTALLATION_ID` — positive numeric installation identifier.
- `GITHUB_APP_PRIVATE_KEY_PATH` — required absolute or resolvable host path.

The known working values `GITHUB_APP_ID=4618233` and
`GITHUB_APP_INSTALLATION_ID=154276908` come from the user's existing VS Code
GitHub MCP configuration and earlier compose setup for GitHub App
`bp-agent-github-app`. They are documented provenance for this deployment, not
package defaults. Every installation must provide its own values. The GitHub
installation/settings page remains the source of truth for repository access.
The App was originally installed for `brycepelletier/environment-controller`.

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

The official GitHub container has a unique infrastructure-generated name for
each facade process. MCP stdin EOF/close, SIGINT, SIGTERM, SIGHUP, and fatal
process errors trigger idempotent cleanup: the facade closes the child transport
and then explicitly removes its own named container as a fallback. Container
names and cleanup targets are never accepted from MCP tool input, and concurrent
VS Code sessions do not share a cleanup target.

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
      "args": ["--yes", "@brycepelletier/github-app-mcp@0.3.0"],
      "env": {
        "GITHUB_APP_ID": "4618233",
        "GITHUB_APP_INSTALLATION_ID": "154276908",
        "GITHUB_APP_PRIVATE_KEY_PATH": "<exact-host-path-to-existing-pem>"
      }
    }
  }
}
```

All three values are mandatory. The numeric identifiers select the caller's App
and installation; the package never supplies a tenant-specific identity.

## Migration from `github-token-broker`

The old private broker listened on `0.0.0.0:8080` and returned installation
tokens from `GET /credential` in Git credential-helper format. That architecture
is retired: this package has no HTTP listener, credential endpoint, or token
response. Existing broker source is retained for audit/migration history but is
not shipped by this package.

As of `agent-env-mcp` 0.4.0, its Git service and public `git_command` have been
removed. The engineering service continues masking real `.git` and never
receives the PEM, installation tokens, or GitHub MCP tools.

## License

MIT. See `LICENSE`.
