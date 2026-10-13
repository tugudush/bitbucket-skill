---
name: bitbucket-cloud
description: Read-only access to Bitbucket Cloud (bitbucket.org) through a bundled CLI script, replacing the bitbucket-mcp server. Use this whenever the user mentions Bitbucket, pastes a bitbucket.org URL (pull request, repo, commit, branch), or asks about pull requests, PR comments or review threads, diffs, branches, tags, commits, pipelines or build failures, repository files, code search across a workspace, or issues hosted on Bitbucket. Also use it for "review this PR", "what did reviewers say", "why did the pipeline fail", "show me file X on branch Y", or "find where Z is used in our workspace", even if the user never says "Bitbucket" explicitly but the repo is hosted there. Strictly read-only; it cannot create, comment on, approve or merge anything.
---

# Bitbucket Cloud (read-only)

This skill gives you the same read access the `bitbucket-mcp` server provided (PRs, comments, diffs, branches, commits, tags, pipelines and logs, issues, files, code search, users), but through one dependency-free Node script, `scripts/bb.mjs`, that you call with the Bash tool. No MCP server needs to be running.

The script lives next to this file. Resolve it from this skill's base directory:

```bash
node "<skill-base-dir>/scripts/bb.mjs" <command> [args] [flags]
```

Below, `bb` is shorthand for that full command. Run `bb help` for the full command list or `bb help <command>` for one command.

## Before the first call: check credentials

Run `bb check`. It reports whether `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN` are set (never their values) and, if so, which account they authenticate as.

If they are not set, tell the user to create an Atlassian API token (id.atlassian.com → Security → API tokens → "Create API token with scopes" → Bitbucket, read scopes) and set the two variables in their own environment (e.g. Windows "Edit environment variables for your account", or their shell profile), then open a new terminal. Optionally `BITBUCKET_WORKSPACE` sets a default workspace.

Why this matters: credentials must never pass through the chat. Do not ask the user to paste a token, do not write one into a command, a file, or a prompt, and do not echo or print environment variables. If a token is pasted anyway, don't repeat it, tell them to revoke and rotate it and to report it through the Information Security incident process. The script reads the environment itself and only ever sends credentials to the Bitbucket API host.

Without credentials only public repositories work; private ones return 404 (the error hint says so).

## Read-only by design

The script only issues HTTP GET. There is no command to comment, approve, merge, decline, create branches, trigger pipelines, or edit anything, and you should not try to work around that with `curl` or other tools. When the user asks for a write action, say it is out of scope for this skill, and instead offer to draft the comment/description text so they can post it themselves. This mirrors the policy that production-adjacent systems are read-only for Claude Code.

## Naming repositories and PRs

Repo-scoped commands take `<workspace>/<repo>` as the first argument. A Bitbucket URL works too, and for PR commands the URL carries the PR id:

```bash
bb pr https://bitbucket.org/acme/webapp/pull-requests/42
bb pr-comments acme/webapp 42
bb branches webapp          # works only if BITBUCKET_WORKSPACE is set
```

When the user gives you a URL, pass it through unchanged rather than picking it apart.

## Which command for which question

| The user wants… | Start with |
|---|---|
| The full picture of a PR in one shot | `pr-context <url>` (add `--full` for description, per-file stats, 20 comments; or `<ws>/<repo> --branch NAME` to find the open PR for a branch) |
| PR title, description, reviewers, state | `pr` |
| What reviewers said | `pr-comments <ws>/<repo> <id> --all`, then `comment-thread … <comment-id>` to follow one discussion |
| Whether a PR is approved / what happened | `pr-activity` |
| What a PR changes | `pr-diffstat` first, then `pr-diff --path <file>` for the files that matter |
| Build / CI result for a PR or commit | `pr-statuses`, `commit-statuses` |
| Why a pipeline failed | `pipelines` → `pipeline-steps <uuid>` → `pipeline-step-log <pipeline-uuid> <step-uuid>` (the tail of the log is shown, which is where failures are) |
| A file's contents | `file <ws>/<repo> <path> --ref <branch|tag|sha>` (line-numbered; `--start/--limit` to page; `--raw` for plain text) |
| What is in a directory | `browse <ws>/<repo> [path] --ref …` |
| History of a file | `file-history <ws>/<repo> <branch> <path>` |
| Compare two refs | `diffstat` / `diff <ws>/<repo> <a>..<b>`; `merge-base <a>..<b>` |
| Branches, tags, commits | `branches`, `branch`, `tags`, `tag`, `commits --branch X`, `commit <sha>` |
| Find a repo / find code | `search-repos <ws> <query>`, `search-code <ws> <query> [--repo --language --extension]` |
| Issues, users, workspaces | `issues`, `issue`, `user`, `me`, `workspaces`, `workspace` |
| Anything else in the v2.0 API | `get repositories/<ws>/<repo>/…` (see Gotchas) |

`references/mcp-tool-map.md` maps every old `bb_*` MCP tool name to its command, in case the user refers to the old tool names or old workflows.

## Keeping output small and useful

Big responses cost context and bury the answer, so shape them before reading:

- **Default output is a compact text summary**, already trimmed to what you usually need. Prefer it.
- **`--select a,b.c`** returns JSON with only those dotted fields per item, e.g. `bb prs acme/webapp --select id,title,author.display_name,state`. This replaces the MCP's JMESPath `filter`. Use it when you need to process many items.
- **`--json`** gives the raw API payload; use it only when a field you need isn't in the text view.
- **Lists are paged** (10 per page by default). Use `--pagelen 100`, `--page N`, or `--all` (follows every page, capped at 20 pages) when completeness matters, for instance when counting comments or looking for a particular reply. A `(more results …)` footer tells you the list is incomplete.
- **Filter and sort server-side** with `--q` (Bitbucket query language) and `--sort`: `--q 'state="OPEN" AND author.nickname="dana"'`, `--sort -updated_on`. See `references/bbql.md` for syntax. This beats fetching everything and filtering locally.
- **Diffs can be huge.** Look at the diffstat, then fetch diffs per file with `--path`, optionally with `--context N`. `--max-chars N` is a last-resort truncation.

## Workflows worth knowing

**Reviewing a PR.** `pr-context <url> --full` → `pr-diffstat` → `pr-diff --path` for the risky files → `file --ref <source commit sha>` when a diff needs surrounding code. The PR's source commit sha is printed by `pr`; use the sha rather than the branch name as `--ref` because it can't drift as new commits land.

**Triaging a red build.** `pr-statuses` (or `pipelines` for a repo) → note the failing pipeline UUID → `pipeline-steps` → `pipeline-step-log`. Quote the actual failing assertion/error from the log in your answer rather than paraphrasing.

**Addressing review feedback.** `pr-comments --all`; inline comments show `[path:line]`, replies show `(reply to #id)`. Use `comment-thread` for the whole conversation on one comment. Work in the local checkout if the repo is cloned; this skill only reads the remote.

**Locating code in a workspace.** `search-code` needs code search enabled for the account at bitbucket.org/search; if it returns nothing or errors, say so rather than concluding the code doesn't exist.

## Gotchas

- **Git Bash on Windows rewrites arguments that start with `/`** (it turns `/repositories/x` into `C:/Program Files/Git/repositories/x`). For `get`, omit the leading slash: `bb get repositories/acme/webapp/hooks`.
- **Branch names containing `/`** (e.g. `feature/SSP-1024`) are fine for `file`, `browse`, `branch`, `commits --branch` because the script resolves refs to commit SHAs. In `diff`/`diffstat`/`merge-base` ranges they can be ambiguous; get the SHA via `branch` and use `sha1..sha2`.
- **Pipeline UUIDs** work with or without braces.
- **Rate limits (429) and 5xx** are retried automatically with backoff (3 attempts). If it still fails, narrow the request instead of hammering.
- **Network failures** (DNS, TLS, connection reset, proxy) are reported with the underlying cause, e.g. `Network error contacting api.bitbucket.org: ENOTFOUND`, plus a hint. Transient ones (reset, timeout, temporary DNS) are retried automatically. On a network that needs a proxy, Node ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set too; `bb check` shows whether a proxy is configured and honoured.
- **Errors** are printed on stderr with a `Hint:` line; exit code is non-zero. A 404 on something that should exist usually means missing credentials or a typo in workspace/repo; a 403 usually means the token lacks a read scope (repository, pullrequest, pipeline, issue).
- Customer data can appear in PRs, logs and issues. Summarise what's needed to answer the question rather than dumping large raw payloads into the conversation or into files outside the task.

## Setup notes (for the human, not for every run)

Requires Node 18+ (uses built-in `fetch`). Optional environment variables: `BITBUCKET_API_BASE` (default `https://api.bitbucket.org/2.0`), `BITBUCKET_REQUEST_TIMEOUT` (ms, default 30000). Behind a corporate proxy, set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` (Node 24+; for a TLS-inspecting proxy also `NODE_EXTRA_CA_CERTS` or `NODE_USE_SYSTEM_CA=1`) in your user environment.
