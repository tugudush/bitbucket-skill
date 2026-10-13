# bitbucket-cloud skill

A Claude Code skill that gives Claude **read-only** access to Bitbucket Cloud (bitbucket.org): pull requests, review comments, diffs, branches, tags, commits, pipelines and build logs, issues, repository files and workspace code search.

It replaces the `bitbucket-mcp` server. Instead of a running MCP server, Claude calls one dependency-free Node script, [scripts/bb.mjs](scripts/bb.mjs), through the Bash tool.

Version: **1.1.0** (`bb check` and `bb help` print the version you have; see [CHANGELOG.md](CHANGELOG.md)).

## Read-only by design

The script only ever issues HTTP `GET`. There is no command to comment, approve, merge, decline, create branches or trigger pipelines, and none can be added without changing the script. If you ask Claude for a write action, it will decline and offer to draft the text for you to post yourself.

Credentials are read from environment variables, are never printed, and are only sent to the configured Bitbucket API host over HTTPS.

## Requirements

- Node.js 20 or newer, tested on Node 24 (the script uses the built-in `fetch`; no `npm install` needed)
- A Bitbucket Cloud account and an Atlassian API token

## Setup

### 1. Install the skill

Claude Code loads personal skills from `~/.claude/skills/<skill-name>/`. This repository is meant to live at:

```
~/.claude/skills/bitbucket-cloud/        (Windows: C:\Users\<you>\.claude\skills\bitbucket-cloud)
├── SKILL.md
├── scripts/bb.mjs
└── references/
```

```bash
git clone <this-repo-url> ~/.claude/skills/bitbucket-cloud
```

To share it with a team through a single project instead, put it under `<project>/.claude/skills/bitbucket-cloud/`. Restart Claude Code (or start a new session) so it picks the skill up.

### 2. Create an Atlassian API token

1. Go to <https://id.atlassian.com> → **Security** → **API tokens**.
2. Choose **Create API token with scopes** and select **Bitbucket**.
3. Grant read scopes only:
   - `read:repository:bitbucket`: repositories, files, branches, tags, commits, diffs, code search
   - `read:pullrequest:bitbucket`: pull requests, comments, activity, PR statuses
   - `read:pipeline:bitbucket`: pipelines, steps and logs
   - `read:issue:bitbucket`: issues
   - `read:workspace:bitbucket`: `workspaces`, `workspace`
   - `read:user:bitbucket`: `me`, `user`, and the account check in `bb check`
4. Copy the token once; Atlassian will not show it again.

### 3. Set environment variables

Set these in your own environment, **not in the chat, in a command line, or in a file in this repository**:

| Variable | Required | Purpose |
|---|---|---|
| `BITBUCKET_EMAIL` | yes | Your Atlassian account email |
| `BITBUCKET_API_TOKEN` | yes | The API token from step 2 |
| `BITBUCKET_WORKSPACE` | no | Default workspace, so you can write `webapp` instead of `acme/webapp`. Used by repo-scoped commands and `repos`; `workspace`, `search-repos` and `search-code` still need the workspace as an argument |
| `BITBUCKET_API_BASE` | no | API base URL. Default `https://api.bitbucket.org/2.0`. Must be `https://` (plain `http://` only for loopback addresses such as `localhost`, used by the tests) |
| `BITBUCKET_REQUEST_TIMEOUT` | no | Timeout in ms for each request attempt. Default `30000` |

- **Windows:** Start menu → "Edit environment variables for your account" → add the variables under *User variables*.
- **macOS / Linux:** export them from your shell profile (`~/.zshrc`, `~/.bashrc`) or a secrets manager.

Then open a **new terminal** (and restart Claude Code) so the variables are visible.

### 4. Verify

```bash
node ~/.claude/skills/bitbucket-cloud/scripts/bb.mjs check
```

`check` shows whether the variables are set (never their values) and which account they authenticate as. Without credentials only public repositories are reachable; private ones return 404.

## Using it

Just ask Claude in natural language. The skill triggers whenever you mention Bitbucket or paste a bitbucket.org URL. Examples:

- "Review https://bitbucket.org/acme/webapp/pull-requests/42"
- "What did reviewers say on PR 42 in acme/webapp?"
- "Why did the last pipeline on `main` fail in acme/webapp?"
- "Show me `src/config.ts` on the `release/2.1` branch"
- "Find where `parseInvoice` is used across the acme workspace"

You can also run the script directly. `bb` below stands for `node <skill-dir>/scripts/bb.mjs`:

```bash
bb help                                   # all commands
bb help pr-diff                           # one command
bb pr-context https://bitbucket.org/acme/webapp/pull-requests/42 --full
bb pr-comments acme/webapp 42 --all
bb pr-diffstat acme/webapp 42
bb pr-diff acme/webapp 42 --path src/app.ts
bb pipelines acme/webapp
bb file acme/webapp src/app.ts --ref main --start 100 --limit 50
bb search-code acme "parseInvoice" --extension ts
bb search-code acme '"Ocean-SessionToken"' --files   # quoted phrase, paths only
bb prs acme/webapp --q 'state="OPEN" AND author.nickname="dana"' --sort -updated_on
```

### Common commands

| Goal | Command |
|---|---|
| Check setup | `check` |
| One-shot PR briefing | `pr-context` |
| List PRs (open only unless `--state`) | `prs` |
| PR details / comments / activity | `pr`, `pr-comments`, `pr-comment`, `comment-thread`, `pr-activity` |
| What a PR changes | `pr-diffstat`, then `pr-diff --path <file>`; `pr-commits` for its commits |
| CI status | `pr-statuses`, `commit-statuses` |
| Failed build | `pipelines` → `pipeline-steps` → `pipeline-step-log` (`pipeline` for one run's details) |
| Files and history | `file`, `browse`, `file-history` |
| Repositories | `repo`, `repos` |
| Refs and commits | `branches`, `branch`, `tags`, `tag`, `commits`, `commit`, `diff`, `diffstat`, `merge-base` |
| Search | `search-repos`, `search-code` |
| Issues, users, workspaces | `issues`, `issue`, `user`, `me`, `workspaces`, `workspace` |
| Any other v2.0 endpoint | `get repositories/<ws>/<repo>/...` |

### Output options

Output is a compact text summary by default. Flags on every command:

- `--json`: structured result instead of the text view. Raw API payload for most commands; `file`, `diff`, `pr-diff`, `pipeline-step-log` and `comment-thread` return a small wrapper object, and `pr-context` a combined one
- `--select a,b.c`: JSON with only those (dotted) fields per item
- `--max-chars N`: last-resort truncation (keeps the start; the text view of `pipeline-step-log` keeps the end)

Flags on list commands only (marked `[list]` in `bb help`; elsewhere they are rejected rather than ignored):

- `--pagelen N`, `--page N`, `--all`: paging (the API's 10 per page by default, 100 max; some commands such as statuses, pipeline steps and diffstats already ask for 100, and so does `--all`, which follows up to 20 pages, raise that with `--max-pages N`)
- `--q` and `--sort`: server-side filtering and sorting; see [references/bbql.md](references/bbql.md) (not for `search-code`)

[references/mcp-tool-map.md](references/mcp-tool-map.md) maps each old `bb_*` MCP tool to its command. Full behaviour notes, workflows and gotchas for Claude are in [SKILL.md](SKILL.md).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `404 Not found` on a repo that exists | Credentials missing or not visible to the process, or a typo in workspace/repo. Run `bb check`. |
| `401` | Token expired, revoked or wrong email. `bb check` exits 1. |
| `403` | Token is missing a read scope (see step 2). On `bb check`, a 403 means the credentials work but lack `read:user:bitbucket`. |
| `429` / `5xx` | Retried automatically (3 attempts). If it persists, narrow the request. |
| `Network error contacting api.bitbucket.org: ENOTFOUND: …` | DNS or connectivity problem; the error includes a hint |
| Certificate errors behind a corporate proxy | Set `NODE_EXTRA_CA_CERTS` to your company CA file, or `NODE_USE_SYSTEM_CA=1` (recent Node only: 22.15+/23.8+, not verified here) |
| Proxy seems ignored | Node ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is also set. That needs a recent Node (24+ was tested); older versions have no built-in proxy support for `fetch`. `bb check` shows whether the proxy is honoured. |
| `bb get /repositories/...` fails with "looks like it was rewritten by Git Bash" (the path became `C:/Program Files/Git/...`) | Git Bash rewrites a leading `/`. Omit it: `bb get repositories/...` |
| `Unknown flag --pagelenn` | Flags are validated; the error suggests the closest match |
| `Unexpected argument "develop"` | Extra arguments are rejected; the error suggests the flag you probably meant (`--branch develop`) |
| `Refusing to follow a redirect to …` | The API redirected off api.bitbucket.org; only the pipeline log endpoint may do that (and it gets no credentials) |
| `search-code` returns nothing | Code search must be enabled for the account at bitbucket.org/search |

## Development

Tests use only Node built-ins (`node:test`, `node:http`). They run the CLI against loopback mock servers and never contact Bitbucket:

```bash
node --test        # or: npm test
```

## Security notes

- Never paste a token into the chat or write it into a command, file or prompt. If one is exposed, revoke it, create a new one, and report it through the Information Security incident process.
- PRs, logs and issues can contain customer data. Ask for what you need rather than dumping large raw payloads into the conversation.
- Use the narrowest token scopes that work: read-only, and only for the workspaces you need.
