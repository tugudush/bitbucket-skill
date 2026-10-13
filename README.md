# bitbucket-cloud skill

A Claude Code skill that gives Claude **read-only** access to Bitbucket Cloud (bitbucket.org): pull requests, review comments, diffs, branches, tags, commits, pipelines and build logs, repository files and workspace code search. (Bitbucket removed its issue tracker, so `issues` and `issue` no longer work.)

It replaces the `bitbucket-mcp` server. Instead of a running MCP server, Claude calls one dependency-free Node script, [scripts/bb.mjs](scripts/bb.mjs), through the Bash tool.

Version: **1.2.12** (`bb check` and `bb help` print the version you have; see [CHANGELOG.md](CHANGELOG.md)).

## Read-only by design

The script only ever issues HTTP `GET`. There is no command to comment, approve, merge, decline, create branches or trigger pipelines, and none can be added without changing the script. If you ask Claude for a write action, it will decline and offer to draft the text for you to post yourself.

Credentials are read from environment variables, are never printed, and are only sent to `api.bitbucket.org` over HTTPS. The script refuses any other API host, and refuses to send credentials while `NODE_TLS_REJECT_UNAUTHORIZED=0` turns certificate checking off.

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
   - `read:issue:bitbucket`: issues (Bitbucket removed its issue tracker, so this scope no longer gets you anything; harmless to omit)
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
| `BITBUCKET_API_BASE` | no | API base URL. Default `https://api.bitbucket.org/2.0`, and the only host accepted besides loopback addresses such as `localhost` (plain `http://` is allowed there only; the tests use it). Anything else is refused, so a stray or injected value cannot redirect your token |
| `BITBUCKET_REQUEST_TIMEOUT` | no | Timeout in ms for each request attempt. Default `30000` |
| `BITBUCKET_MAX_FILE_BYTES` | no | Largest file `file` and `browse` will download, in bytes. Default `10000000` (10 MB). Binary files are never downloaded in full, whatever the limit |

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
bb pr-diff acme/webapp 42 --path src/app.ts,src/util.ts   # one file or a comma-separated list
bb pipelines acme/webapp
bb file acme/webapp src/app.ts --ref main --start 100 --limit 50
bb search-code acme "parseInvoice" --extension ts,tsx   # exact extensions, so ts alone leaves out .tsx
bb search-code acme '"Ocean-SessionToken"' --files   # quoted phrase, paths only
bb prs acme/webapp --q 'state="OPEN" AND author.nickname="dana"' --sort -updated_on
```

### Common commands

| Goal | Command |
|---|---|
| Check setup | `check` |
| One-shot PR briefing (3 newest comments; `--full` adds the description, per-file stats and 20 comments) | `pr-context` |
| List PRs (open only unless `--state` is given or `--q` mentions `state`; `--state ALL` or `MERGED,DECLINED` for more) | `prs` |
| PR details / comments / activity | `pr`, `pr-comments`, `pr-comment`, `comment-thread`, `pr-activity` |
| What a PR changes | `pr-diffstat`, then `pr-diff --path <file>[,<file>]` (`--context N` sets the lines of context); `pr-commits` for its commits |
| CI status | `pr-statuses`, `commit-statuses` |
| Failed build | `pipelines` → `pipeline-steps` → `pipeline-step-log` (`pipeline` for one run's details; `--tail CHARS` sets how much of the log's end is shown, 50,000 by default) |
| Files and history | `file`, `browse`, `file-history` (follows renames; message, author and date for the first 25 entries) |
| Repositories | `repo`, `repos` |
| Refs and commits | `branches`, `branch`, `tags`, `tag`, `commits`, `commit`, `diff`, `diffstat`, `merge-base` |
| Compare two refs | `diff <ws>/<repo> <source>..<dest>`: **Bitbucket's order, the reverse of `git diff`**. It shows what `<source>` has that `<dest>` lacks, so "what does `feature` add to `main`" is `feature..main`. `--two-dot` compares the two tips directly instead of against the merge base. `diff` and `diffstat` also take `--ignore-whitespace`, and `diff` takes `--context N` |
| Search | `search-repos`, `search-code` |
| Users, workspaces | `user`, `me`, `workspaces`, `workspace` |
| Issues | `issues`, `issue`: **no longer work**, Bitbucket removed its issue tracker and answers `410 Gone` |
| Any other v2.0 endpoint | `get repositories/<ws>/<repo>/...` (refuses webhooks, deploy and SSH keys, pipeline variables, access tokens and account emails) |

### Output options

Output is a compact text summary by default. Flags on every command:

- `--json`: structured result instead of the text view. Raw API payload for most commands; `file`, `diff`, `pr-diff`, `pipeline-step-log` and `comment-thread` return a small wrapper object, `pr-context` a combined one, `check` `{authenticated, user}`, and `file-history` the raw list with each entry's commit details filled in. `browse` on a file behaves like `file`, and `get` on a non-JSON response returns `{text}`
- `--select a,b.c`: JSON with only those (dotted) fields per item. A path through an array returns one value per element (`reviewers.display_name` gives `["A", "B"]`), a field that is absent is shown as `null`, and a path that matched nothing anywhere prints a warning on stderr
- `--max-chars N`: last-resort truncation (keeps the start; the text view of `pipeline-step-log` keeps the end; never cuts a character such as an emoji in half, so it can show one unit less than N)

Flags on list commands only (marked `[list]` in `bb help`; elsewhere they are rejected rather than ignored):

- `--pagelen N`, `--page N`, `--all`: paging (`--page N` is refused by endpoints that page with tokens, namely `browse`, `pr-commits` and `file-history`; the footer says which to use; the API's 10 per page by default, 100 max, and 50 max for `prs` and `pr-activity`, where `--all` also reads 50 per page; some commands such as statuses, pipeline steps and diffstats already ask for 100, and so does `--all`, which follows up to 20 pages, raise or lower that with `--max-pages N`, which needs `--all`; `--all` cannot be combined with `--page`)
- `--q` and `--sort`: server-side filtering and sorting; see [references/bbql.md](references/bbql.md). Not for `search-code` or `browse`, and not where Bitbucket accepts but ignores them: `commits`, `pr-commits`, `pr-activity`, `pr-diffstat` and `diffstat` reject both, and `pipelines` and `pipeline-steps` reject `--q` (their `--sort` works). A rejected flag tells you what to do instead; `bb help <command>` lists what each takes

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
| "looks like a path that Git Bash (MSYS) rewrote" (the path became `C:/Program Files/Git/...`) | Git Bash rewrites an argument that starts with `/`, including `--path=/src/a.ts`. Omit the leading slash: `bb get repositories/...`, `bb file ws/repo src/a.ts` |
| `Refusing to use BITBUCKET_API_BASE …` | Only `https://api.bitbucket.org` (or loopback, for tests) may receive credentials. Unset the variable |
| `Refusing to send credentials while NODE_TLS_REJECT_UNAUTHORIZED=0` | Unset it. Behind a TLS-inspecting proxy set `NODE_EXTRA_CA_CERTS` instead |
| `Unknown flag --pagelenn` | Flags are validated; the error suggests the closest match, also for a misspelled flag that has no value (`--ful` gives `Did you mean --full?`) |
| `--q is not supported by commits: Bitbucket's endpoint ignores it …` | The endpoint would return the unfiltered list with no error, so the command refuses. Fetch with `--all --select …` and filter yourself, as the message says |
| `Warning: --pagelen 500 is above Bitbucket's maximum` | Bitbucket allows at most 100 per page, and 50 for `prs` and `pr-activity` (the warning names the command); the request used the maximum. Use `--all` to read every page |
| `400 … Invalid pagelen` | A page size above what that endpoint takes. `prs` and `pr-activity` take 50 (before 1.2.8 `--all` and `--pagelen 100` failed on them, with a hint about `--page`); the commands now stay within it. Only a raw `get …?pagelen=100` still reaches the limit: use 50 |
| `[resolved]` / `[outdated]` after a comment | The thread was resolved in Bitbucket (`[resolved by NAME DATE]` from `pr-comment` and `comment-thread`); `[outdated]` means the line it was on has since changed, and only those two commands know it |
| `--page cannot be combined with --all` / `--max-pages only applies together with --all` | `--all` reads every page from the first, so `--page N` has no meaning with it (before 1.2.6 it silently skipped the early pages), and `--max-pages` only caps what `--all` reads. Use one or the other |
| `Request timed out after …ms` | The request was tried 3 times. For a slow network or a large response raise `BITBUCKET_REQUEST_TIMEOUT` (ms) in your environment; otherwise check connectivity and the proxy |
| `commits --all` takes a minute | Each page of 100 is one request, about 2 s for `commits`: 48 s for 1,959 commits. Cap it with `--max-pages N` and keep the output small with `--select` |
| `search-code --language X` finds nothing | `--language` takes the index's own names (`c#` works, `csharp` does not). Use `--extension` instead |
| `search-code --extension ts` finds fewer files than expected, or `Nothing matched with --extension …` | `--extension` is an exact match on the file extension, so `ts` leaves out `.tsx` (and `js` leaves out `.jsx`). Give several with commas: `--extension ts,tsx` (live, `ts` found 1 file, `tsx` 1, and `ts,tsx` both). A space between extensions is refused |
| `Unexpected argument "develop"` | Extra arguments are rejected; the error suggests the flag you probably meant (`--branch develop`) |
| `Refusing to follow a redirect to …` | The API redirected off api.bitbucket.org; only the pipeline log endpoint may do that (and it gets no credentials) |
| `search-code` returns nothing | Code search must be enabled for the account at bitbucket.org/search, and the index may cover only the main branch (in a live check, code only on `develop` was not found). Read the file with `file --ref` or use `pr-diff` instead |
| `404 … No such file or directory: <path>` (or `No such file: <path>` from `file-history`) | The ref resolved; only the path is wrong. The hint gives the `browse` command for its directory at that ref |
| `File: … is … over the … limit, so it was not downloaded` / `looks like a binary file` | `file` and `browse` do not download binary files or files over 10 MB (they stop after the first chunk). Set `BITBUCKET_MAX_FILE_BYTES` in your environment to read a larger text file |
| `No changes found for a..b` on a range | Bitbucket reads `<source>..<dest>` the opposite way to `git diff`; the message prints the reverse range to try |
| 404 on a PR command | With credentials the hint points at the PR id (or comment id) first, then the workspace/repo spelling |
| `Warning: the URL also names ref main and path …, which repo does not use` (stderr) | Pasted commit, branch and file URLs work: `/commits/<sha>` for `commit`, `commit-statuses`, `diff` and `diffstat`, `/branch/<name>` for `branch`, `/commits/branch/<name>` for `commits`, `/src/<ref>/<path>` for `file`, `browse` and `file-history`. The command takes what it can use from the URL when you leave that argument out, and says what it ignored. A branch with a `/` is written `%2F` in these URLs; a bare `/` is read as the start of the path, so pass `--ref` then. Before 1.2.10 such URLs failed with `Expected 1 more argument`, and `browse` listed the root of the default branch |
| `<path> is a directory at ref …, not a file` | `file` reads files. Use the `browse` command the message prints |
| `user "Ian Flory"` gives 404 | Bitbucket looks users up by account id or UUID in braces, not by name or nickname. Read an id with `prs <ws>/<repo> --state ALL --select author.display_name,author.account_id` |
| `400 … Field "user..display_name" does not support filtering` / `--q 'author.nickname="…"'` finds nothing | A person's display name cannot be filtered, and the nickname is not the name shown in the output. Filter on `author.account_id` or `reviewers.account_id` |
| `pr-activity` line `source commit A -> B` | Someone pushed to the PR's branch between those two updates. `pr-commits` lists only the commits in the final state |
| `404 … The source or destination could not be found for spec: …` on `pr-diff`, `pr-diffstat` or `pr-commits` (and `Unavailable` in the `pr-context` diffstat) | The PR exists (`pr`, `pr-activity` and `pr-statuses` still work) but a commit it points to is gone from the repository, typically an old PR after a force-push or a rewritten branch, so its diff cannot be computed. Read code with `file --ref <sha>` on a commit that still exists |
| `Warning: --raw printed lines 1-1000 of N` (stderr) | `--raw` is plain text for pipes, and starts from the 10,000-line maximum (before 1.2.9 it stopped at 1,000 without a word, so `--raw \| grep` could miss matches). The warning appears only if lines are still left out: add `--limit N` or continue with `--start`. `--limit` is capped at 10,000 |
| `Warning: large diff, N characters` (stderr) | `diff` and `pr-diff` print the whole diff, and past 200,000 characters (about 50,000 tokens) they say so. Lock files (`package-lock.json`, `yarn.lock`) are the usual cause: run `pr-diffstat` and fetch the source files with `--path a,b`. Not shown with `--max-chars` |
| `pr-context` says `2295 file(s) changed; first 500 summed` | The briefing reads at most 5 diffstat pages (500 files) so a huge PR does not take 35 s. The total is real; the `+`/`-` sums cover only the files read. The warning prints the `pr-diffstat … --all` command for all of them (with `--max-pages N` added past 2,000 files, where `--all` alone stops at its 20-page cap) |
| `410 Gone - CHANGE-3071 …` on `issues` / `issue` | Bitbucket removed its issue tracker (UI and API). Nothing to fix on your side; use Jira. Any other 410 means Bitbucket removed that endpoint: see its changelog |
| `file-history` shows only a hash for some entries | Message, author and date are looked up for the first 25 entries of a page; the footer says so. Use `commit <hash>` for the rest, or a smaller `--pagelen` |
| `--select` warns `matched nothing` on a list | On a list the paths apply to each item: `full_name`, not `values.full_name` |

## Development

Tests use only Node built-ins (`node:test`, `node:http`). They run the CLI against loopback mock servers and never contact Bitbucket:

```bash
node --test        # or: npm test
```

## Security notes

- Never paste a token into the chat or write it into a command, file or prompt. If one is exposed, revoke it, create a new one, and report it through the Information Security incident process.
- PRs, logs and issues can contain customer data. Ask for what you need rather than dumping large raw payloads into the conversation.
- Use the narrowest token scopes that work: read-only, and only for the workspaces you need.
