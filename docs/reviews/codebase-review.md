# Codebase review: `bitbucket-cloud` skill

Reviewed: 2026-10-13
Scope: every file in the skill (about 960 lines in total).

| File | Lines | Role |
|---|---|---|
| [SKILL.md](../../SKILL.md) | 98 | Skill manifest and instructions Claude follows (trigger description, credential flow, command routing, workflows, gotchas) |
| [scripts/bb.mjs](../../scripts/bb.mjs) | 773 | The implementation: a dependency-free, GET-only Bitbucket Cloud CLI (Node 18+) with 40 commands |
| [references/bbql.md](../../references/bbql.md) | 42 | Bitbucket query language cheat sheet for `--q` and `--sort` |
| [references/mcp-tool-map.md](../../references/mcp-tool-map.md) | 52 | Old `bb_*` MCP tool names mapped to `bb` commands, plus behavioural differences |

## How this review was done

- Full read of all four files.
- Offline checks only: `node --check` (syntax OK on Node v24.12.0), `bb help`, and the error paths that fail before any network call (unknown command, missing repo, MSYS-rewritten `get` path, flag typos). All behaved as described below.
- **Nothing was run against the live Bitbucket API.** Findings that depend on Bitbucket's server behaviour are marked *(unverified)* and need a quick manual check.
- A grep confirms the only HTTP method in the code is `GET` ([bb.mjs:137](../../scripts/bb.mjs#L137)).

## Summary

This is a well-built skill. The design is small and coherent, the read-only and credential-handling guarantees are real (they are in the code, not just the prose), and the output shaping suits an LLM consumer. I found no critical issues.

The main weaknesses are:

1. The `get` escape hatch is broader than the policy intent.
2. A few robustness gaps in the HTTP layer (hung body reads, opaque network errors).
3. Silent error swallowing in `pr-context`.
4. One documentation claim that the code does not back up.
5. No tests.

## Architecture

```
SKILL.md ──(tells Claude to run)──▶ node scripts/bb.mjs <command> [args] [flags]
                                        │
   parseArgs ─▶ command registry C{} ─▶ run(ctx) ─▶ { data, text }
                                        │                │
                    repoCtx / prCtx     │       --select / --json / text, --max-chars
                    (ws/repo or URL)    ▼
                    getList / getJson / getText ─▶ rawGet (GET only, timeout, retry 429/5xx, origin check)
```

Key design points in [bb.mjs](../../scripts/bb.mjs):

- **Command registry.** `def(name, usage, summary, run)` ([bb.mjs:322-323](../../scripts/bb.mjs#L322-L323)) fills one table `C`. Each command returns `{ data, text }`, so `--json`, `--select` and text output come from one code path ([bb.mjs:755-761](../../scripts/bb.mjs#L755-L761)). `help` is generated from the same table, so it cannot drift from the commands.
- **Target parsing.** `parseRepoToken`, `repoCtx` and `prCtx` accept `ws/repo`, a bare `repo` (with `BITBUCKET_WORKSPACE`) or any bitbucket.org URL. A PR URL also yields the PR id ([bb.mjs:207-244](../../scripts/bb.mjs#L207-L244)).
- **Ref resolution.** `resolveRef` tries branch, then tag, then commit, and swallows only 404s ([bb.mjs:260-271](../../scripts/bb.mjs#L260-L271)). This is what makes branch names containing `/` work for `file` and `browse`.
- **Paging.** `getList` handles `--page`, `--pagelen` (capped at 100), `--all` (capped at 20 pages) and merges `--q` and `--sort` into the request ([bb.mjs:181-203](../../scripts/bb.mjs#L181-L203)).
- **Output shaping.** Compact text by default. `--select` projects dotted fields. `--max-chars` truncates. Files are line-numbered and paged. Pipeline logs are tail-truncated.

### Strengths

- **Read-only is enforced by construction.** There is no code path for any other HTTP verb. `get` is GET-only too.
- **Credentials are handled well.**
  - They are read from the environment, never printed (`check` reports only set/NOT SET) and sent only to the configured origin ([bb.mjs:92-96](../../scripts/bb.mjs#L92-L96)). The origin check also covers pagination `next` URLs, because every request goes through `rawGet`.
  - SKILL.md tells Claude explicitly not to take tokens through chat, and says what to do if one leaks (revoke, rotate, report through the InfoSec incident process). This matches the managed policy.
- **Good error UX.** Status-specific hints distinguish "no creds" from "bad creds" from "missing scope", and a private repo 404 is explained as a likely credentials problem ([bb.mjs:107-124](../../scripts/bb.mjs#L107-L124)).
- **Context-economy features.** `--select`, `--q`/`--sort`, diffstat-before-diff, `pr-context`, line-numbered paged files and log tails all reduce token use.
- **SKILL.md is well written.** The trigger description is specific, there is a question-to-command table, the workflows are concrete, and the Git Bash `/` rewriting pitfall is covered (and also guarded in code, [bb.mjs:349](../../scripts/bb.mjs#L349)).
- **Zero dependencies** and a small, readable surface.

## Findings

Severity: **Medium** is worth fixing soon. **Low** is polish or hardening.

### Medium

#### M1. `get` can read data the rest of the skill deliberately avoids (policy)

[bb.mjs:347-357](../../scripts/bb.mjs#L347-L357) accepts any v2.0 path and prints the raw JSON into the conversation. Depending on token scopes, that includes endpoints such as:

- webhooks (`…/hooks`, which SKILL.md itself uses as an example; webhook URLs can embed tokens)
- deploy and SSH keys
- repository pipeline variables (non-secured values are returned in clear)
- repository and workspace access-token metadata

The managed policy says secrets and credentials must not enter prompts. Today the only barrier is the token's scope, and SKILL.md recommends read scopes of `repository, pullrequest, pipeline, issue`, which mostly avoids this. But the code adds no defence in depth, and SKILL.md advertises `hooks` as the example.

**Suggestion:**
- Add a denylist in `get` for sensitive path segments (`hooks`, `deploy-keys`, `ssh-keys`, `variables`, `access-tokens`, `/user/emails`, `addon`).
- Or restrict `get` to an allowlist of read-only resource roots.
- Change the `hooks` example in SKILL.md and the `get` help text to something harmless.

#### M2. Request timeout does not cover reading the response body

`clearTimeout(timer)` runs at [bb.mjs:142](../../scripts/bb.mjs#L142), before `await res.text()` at line 143. If the server sends headers and then stalls, the body read has no deadline and the process hangs until the tool-level timeout. Large diffs and pipeline logs are the likely victims.

**Suggestion:** move `clearTimeout` into a `finally` that runs after the body is fully read.

#### M3. Network-level failures are opaque and not retried

- A DNS, TLS, connection-reset or proxy failure makes `fetch` throw `TypeError: fetch failed`. The real reason is in `e.cause`, but [bb.mjs:764-772](../../scripts/bb.mjs#L764-L772) prints only `e.message`. The user and Claude see `Error: fetch failed` with no clue.
- These errors are rethrown at once ([bb.mjs:171](../../scripts/bb.mjs#L171)), so only timeouts and 429/5xx are retried. A transient `ECONNRESET` fails the command.
- Node's built-in `fetch` does not honour `HTTP_PROXY`/`HTTPS_PROXY` by default. On a corporate network that needs a proxy this would show up as `fetch failed`. Recent Node releases can enable proxy support (`NODE_USE_ENV_PROXY=1`), but nothing in SKILL.md mentions it. *(unverified for this network)*

**Suggestion:**
- Include `e.cause?.code`/`e.cause?.message` in the error output.
- Treat `ECONNRESET`, `ETIMEDOUT` and `EAI_AGAIN` as retryable.
- Add a line to the setup notes about proxies.

#### M4. SKILL.md claims branch names with `/` are handled for `commits --branch` and `branch`, but the code does not resolve refs there

[SKILL.md:90](../../SKILL.md#L90) says branch names such as `feature/SSP-1024` are fine for `file`, `browse`, `branch` and `commits --branch` "because the script resolves refs to commit SHAs". Only `file` and `browse` call `resolveRef`.

- `commits` interpolates the raw flag into the path with no encoding: `/commits/${ctx.flags.branch}` ([bb.mjs:494](../../scripts/bb.mjs#L494)).
- `branch` percent-encodes the name ([bb.mjs:476](../../scripts/bb.mjs#L476)) but does not resolve it.

Whether Bitbucket accepts a slash branch in `/commits/{revision}` is *(unverified)*. Either way, the stated reason is wrong, and a branch name containing `#` or `?` would corrupt the URL in `commits`.

**Suggestion:** call `resolveRef` in `commits` (and `diff`/`diffstat`/`merge-base`, see L1), or correct the Gotchas text.

#### M5. `pr-context` hides API errors as "nothing found"

The `soft()` wrapper ([bb.mjs:627](../../scripts/bb.mjs#L627)) turns every failure of the diffstat, statuses and comments calls into `null`. The output then says "No diffstat available.", "No build statuses found." or "No comments.". A 403 (missing `pipeline` scope), a 429 or a timeout is therefore indistinguishable from an empty result. In a "should I merge this?" briefing, "No build statuses found" is a materially wrong answer when the truth is "could not read statuses".

**Suggestion:** have `soft` record the error and print `Build status: unavailable (403 …)` instead.

### Low

#### L1. Several path and query values are built without escaping

- `pr-context --branch` ([bb.mjs:619](../../scripts/bb.mjs#L619)), `issues --state/--kind` ([bb.mjs:685-686](../../scripts/bb.mjs#L685-L686)) and `search-repos` ([bb.mjs:394](../../scripts/bb.mjs#L394), which escapes `"` but not `\`) interpolate user text into BBQL. A quote or backslash in a branch name breaks or alters the query.
- `diff`, `diffstat` and `merge-base` put `spec` straight into the path ([bb.mjs:512](../../scripts/bb.mjs#L512), [527](../../scripts/bb.mjs#L527), [534](../../scripts/bb.mjs#L534)). `?` or `#` changes the request, and `..` segments are normalised by `new URL`, so the request can reach a different path on the same origin.
- The impact is contained: it is GET-only and the origin check holds. These are correctness and robustness issues rather than a security hole.

**Suggestion:** one `bbqlString(s)` helper that escapes `\` and `"`, and a `rangeSpec()` helper that validates `<rev>` or `<rev>..<rev>` and encodes each part.

#### L2. `--max-chars` works against the tail-first design of log output

`pipeline-step-log` deliberately keeps the end of the log because failures are at the end ([bb.mjs:675-678](../../scripts/bb.mjs#L675-L678)). But `--max-chars` keeps the **head** of the final output ([bb.mjs:759-760](../../scripts/bb.mjs#L759-L760)). Combining them silently cuts off the failure. Use `--tail` for logs, not `--max-chars`. SKILL.md does not say so.

**Suggestion:** add a one-line note in SKILL.md, or make `--max-chars` keep the tail when the command is `pipeline-step-log`.

The whole log is also downloaded and sliced locally. Pipeline logs support HTTP range requests *(unverified)*, which would avoid pulling megabytes to show 50 KB.

#### L3. The pipeline log endpoint may need a different `Accept` header *(unverified)*

`getText` always sends `Accept: text/plain` ([bb.mjs:178](../../scripts/bb.mjs#L178)). As far as I recall, Bitbucket serves step logs as `application/octet-stream`, and a strict server could answer 406. Worth a one-off live test. If it fails, send `Accept: */*` for that call (as `get` already does).

#### L4. `comment-thread` silently stops at 2,000 comments

It calls `getList` with `all: true` ([bb.mjs:571](../../scripts/bb.mjs#L571)) and ignores the `truncated` flag. A reply beyond the cap is simply missing from the thread. Any user-supplied `--page` or `--pagelen` also leaks into that internal call because `ctx.flags` is spread. Both are unlikely in practice, but the first is a silent wrong answer.

#### L5. `pr-context` totals count only the first diffstat page

It requests one page of 100 entries ([bb.mjs:629](../../scripts/bb.mjs#L629)) and sums them. A PR with more than 100 changed files reports wrong totals with no "more" note (unlike `pr-diffstat`, which appends `pageNote`).

#### L6. Argument parsing is permissive

- Unknown flags are silently ignored. `--pagelenn 5` or `--branchh x` does nothing, and the user gets a plausible but wrong default result.
- A value flag swallows the next token even if it is another flag (`--ref --raw` sets `ref` to `--raw`).
- `-h` is not recognised.

**Suggestion:** keep a per-command set of known flags and reject others with a "did you mean" hint.

#### L7. No HTTPS enforcement on `BITBUCKET_API_BASE`

The origin check compares against `BASE` itself ([bb.mjs:92-96](../../scripts/bb.mjs#L92-L96)). If the environment variable is set to an `http://` URL, Basic-auth credentials are sent in clear. This is a self-inflicted configuration, but a one-line guard would remove it.

#### L8. Smaller robustness points

- `search-code` assumes `content_matches` is always an array ([bb.mjs:707](../../scripts/bb.mjs#L707)). A path-only match would throw a `TypeError`.
- `diffstatText` sums `lines_added`/`lines_removed` without defaults ([bb.mjs:291-292](../../scripts/bb.mjs#L291-L292)). A binary file entry with missing counts would produce `NaN`.
- A 200 response that is not JSON (a corporate proxy or login page) surfaces as `Unexpected token <` from `JSON.parse`, with no mention that the body was HTML.
- `fileResult` splits on `\n`, so CRLF files keep a trailing `\r` on every line. Binary files are decoded as text.
- 429 handling ignores the `Retry-After` header and always sleeps 1s then 2s ([bb.mjs:155](../../scripts/bb.mjs#L155)).
- `defaultBranch` swallows every error and falls back to `'main'` ([bb.mjs:250-257](../../scripts/bb.mjs#L250-L257)). A repo whose default is `master`, hit during an outage, produces a misleading "could not resolve ref 'main'".
- `resolveRef` makes up to three sequential calls per ref, so a plain `file` costs up to five requests (default branch, three resolution attempts, content). A cheap pre-check could skip straight to `/commit/` for a 40-character hex string.
- `parseRepoToken` accepts any `http(s)` URL and takes the first two path segments. An API URL such as `https://api.bitbucket.org/2.0/repositories/ws/repo` would parse as workspace `2.0`, repo `repositories`. It does no network I/O on that URL, so this is a UX issue only.

### Documentation issues

| Where | Issue |
|---|---|
| [SKILL.md:55](../../SKILL.md#L55) | `<branch\|tag\|sha>` has unescaped pipes inside a Markdown table row, so renderers split the cell. [mcp-tool-map.md](../../references/mcp-tool-map.md) escapes its pipes correctly; this one needs the same. |
| [SKILL.md:73](../../SKILL.md#L73) | `--all` is documented as "capped at 20 pages", but the cap is tunable via `--max-pages`, which only appears in `bb help`. |
| [SKILL.md:93](../../SKILL.md#L93) | Retries are described as covering 429 and 5xx. Timeouts are also retried (undocumented), and network errors are not (see M3). |
| [SKILL.md:90](../../SKILL.md#L90) | See M4. |
| [SKILL.md:62](../../SKILL.md#L62) and [bb.mjs:347](../../scripts/bb.mjs#L347) | The `hooks` example conflicts with M1. |
| Whole skill | No README, changelog or version marker. The user-agent string is hard-coded as `bitbucket-cloud-skill/1.0` ([bb.mjs:21](../../scripts/bb.mjs#L21)). |

## Testing and maintainability

- **No tests of any kind.** `main()` runs on import ([bb.mjs:764](../../scripts/bb.mjs#L764)) and nothing is exported, so the pure helpers (`parseRepoToken`, `parseArgs`, `project`, `diffstatText`, `duration`, `fileResult`) cannot be unit-tested without spawning the CLI. A small refactor would unlock `node --test`:
  - Guard the entry point: `if (import.meta.url === pathToFileURL(process.argv[1]).href) main()`.
  - Export the pure helpers.
  - Add a mock for `fetch` so the retry, paging and `resolveRef` logic can be tested offline.
- **Dense one-line formatters.** Many `text:` values are 200+ character single lines ([bb.mjs:404](../../scripts/bb.mjs#L404), [542](../../scripts/bb.mjs#L542), [656](../../scripts/bb.mjs#L656), [688](../../scripts/bb.mjs#L688)). They work, but they are hard to review and diff.
- **Repeated patterns.**
  - The commit-list formatter appears in `commits`, `pr-commits` and `file-history`.
  - The "header, map, page note, or none" shape repeats in about 15 commands.
  - Small helpers such as `listText(title, r, fmt)` and `commitLine(c)` would shorten the file by roughly 10%.
- **Mixed responsibilities in `getList`.** It owns paging, filter merging and sorting. That is fine today, but `search-code` also runs through it and picks up `--q`, which does not apply to that endpoint.

## Policy alignment (managed settings)

| Policy item | Status |
|---|---|
| Production systems read-only; no deploy, merge, approve | **Met.** GET-only client with no write commands. SKILL.md instructs Claude to decline write requests and offer draft text instead. |
| No credentials or secrets in prompts | **Met for the skill's own flow.** Credentials come from the environment and are never echoed. The weak spot is `get` (M1), which can fetch secret-bearing config into context. |
| Customer data must not be entered into prompts | **Partly mitigated.** SKILL.md warns that PRs, logs and issues can contain customer data and says to summarise rather than dump. This is guidance only; the CLI has no redaction. Pipeline logs (`pipeline-step-log`) are the likeliest place for sensitive output. |
| Incident reporting for accidental disclosure | **Addressed** in the credentials section of SKILL.md. |

## Recommended order of work

1. **M1.** Tighten `get` (denylist or allowlist) and drop the `hooks` example.
2. **M2 and M3.** Fix the timeout scope and surface `e.cause`, with retry on transient network codes.
3. **M5.** Stop `pr-context` from reporting errors as empty results.
4. **M4, L1 and the documentation table.** Fix the inaccurate `commits`/`branch` claim, add escaping helpers, and correct SKILL.md.
5. **Tests.** Make `bb.mjs` importable and add `node --test` coverage for the pure helpers and the paging/retry logic.
6. **Live verification** of the *(unverified)* items: slash branches in `commits`, the `Accept` header on step logs, range requests, and proxy behaviour on the corporate network.
