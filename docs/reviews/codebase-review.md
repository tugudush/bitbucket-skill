# Codebase review: `bitbucket-cloud` skill

Reviewed: 2026-10-13
Scope: every file in the skill (about 960 lines in total).

| File                                                           | Lines | Role                                                                                                                       |
| -------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| [SKILL.md](../../SKILL.md)                                     | 98    | Skill manifest and instructions Claude follows (trigger description, credential flow, command routing, workflows, gotchas) |
| [scripts/bb.mjs](../../scripts/bb.mjs)                         | 773   | The implementation: a dependency-free, GET-only Bitbucket Cloud CLI (Node 18+) with 40 commands                            |
| [references/bbql.md](../../references/bbql.md)                 | 42    | Bitbucket query language cheat sheet for `--q` and `--sort`                                                                |
| [references/mcp-tool-map.md](../../references/mcp-tool-map.md) | 52    | Old `bb_*` MCP tool names mapped to `bb` commands, plus behavioural differences                                            |

## How this review was done

- Full read of all four files.
- Offline checks only: `node --check` (syntax OK on Node v24.12.0), `bb help`, and the error paths that fail before any network call (unknown command, missing repo, MSYS-rewritten `get` path, flag typos). All behaved as described below.
- **Nothing was run against the live Bitbucket API.** Findings that depend on Bitbucket's server behaviour are marked _(unverified)_ and need a quick manual check.
- A grep confirms the only HTTP method in the code is `GET` ([bb.mjs:137](../../scripts/bb.mjs#L137)).
- Line numbers refer to `bb.mjs` as reviewed. The M2 and M3 fixes added about 60 lines to `bb.mjs`, so references below line 126 are now stale.

## Summary

This is a well-built skill. The design is small and coherent, the read-only and credential-handling guarantees are real (they are in the code, not just the prose), and the output shaping suits an LLM consumer. I found no critical issues.

The main weaknesses are:

1. The `get` escape hatch is broader than the policy intent.
2. A few robustness gaps in the HTTP layer (hung body reads and opaque network errors; both now fixed as M2 and M3).
3. Silent error swallowing in `pr-context`.
4. One documentation claim that the code did not back up (now fixed as M4).
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

#### M2. Request timeout does not cover reading the response body — RESOLVED 2026-10-13

`clearTimeout(timer)` ran before `await res.text()`. If the server sent headers and then stalled, the body read had no deadline and the process hung until the tool-level timeout. Large diffs and pipeline logs were the likely victims.

**Resolution:** the early `clearTimeout` and the one in the `catch` were removed, and `clearTimeout(timer)` now runs in a `finally` after the body is fully read ([bb.mjs:142-143](../../scripts/bb.mjs#L142-L143), [bb.mjs:171-173](../../scripts/bb.mjs#L171-L173)). A stalled body now aborts at the deadline and goes through the existing timeout/retry path. Checked with `node --check` only; not tested against a live stalled response.

#### M3. Network-level failures are opaque and not retried — RESOLVED 2026-10-13

- A DNS, TLS, connection-reset or proxy failure made `fetch` throw `TypeError: fetch failed`. The real reason is in `e.cause`, but `main()` printed only `e.message`, so the user and Claude saw `Error: fetch failed` with no clue.
- These errors were rethrown at once, so only timeouts and 429/5xx were retried. A transient `ECONNRESET` failed the command.
- Node's built-in `fetch` does not honour `HTTP_PROXY`/`HTTPS_PROXY` by default (`NODE_USE_ENV_PROXY=1` enables it), and nothing in SKILL.md mentioned it. _(still unverified for this network)_

**Resolution:**

- New `NetworkError` class, built by `toNetworkError()` from the root cause (unwrapping `e.cause` and `AggregateError`). The message now reads like `Network error contacting host: ENOTFOUND: getaddrinfo ENOTFOUND host`, with a `Hint:` line chosen by `networkHint()` for DNS, untrusted-certificate (`NODE_EXTRA_CA_CERTS` / `NODE_USE_SYSTEM_CA=1`) and proxy cases.
- `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE` and the undici socket/timeout codes are retried with the same 3-attempt backoff. `ENOTFOUND`, `ECONNREFUSED` and certificate errors fail at once.
- `bb check` now prints a `Proxy:` line (never the proxy value, which can contain credentials), and warns when a proxy variable is set without `NODE_USE_ENV_PROXY=1`. SKILL.md gotchas and setup notes document the proxy settings.
- Checked offline against a local server that resets the first two connections (succeeded on the third after about 3 s), a refused port, an unresolvable host and the proxy warning. Not tested through a real corporate proxy.

#### M4. SKILL.md claims branch names with `/` are handled for `commits --branch` and `branch`, but the code does not resolve refs there — RESOLVED 2026-10-13

[SKILL.md:90](../../SKILL.md#L90) says branch names such as `feature/SSP-1024` are fine for `file`, `browse`, `branch` and `commits --branch` "because the script resolves refs to commit SHAs". Only `file` and `browse` call `resolveRef`.

- `commits` interpolates the raw flag into the path with no encoding: `/commits/${ctx.flags.branch}` ([bb.mjs:494](../../scripts/bb.mjs#L494)).
- `branch` percent-encodes the name ([bb.mjs:476](../../scripts/bb.mjs#L476)) but does not resolve it.

Whether Bitbucket accepts a slash branch in `/commits/{revision}` is _(unverified)_. Either way, the stated reason is wrong, and a branch name containing `#` or `?` would corrupt the URL in `commits`.

**Suggestion:** call `resolveRef` in `commits` (and `diff`/`diffstat`/`merge-base`, see L1), or correct the Gotchas text.

**Resolution:**

- `commits --branch` now calls `resolveRef` (branch, then tag, then commit, each URL-encoded) and requests `/commits/{sha}`. The raw flag no longer reaches the URL, so `/`, `#` and `?` in the name are safe, and the slash question for `/commits/{revision}` no longer matters. An unknown ref fails with `Could not resolve ref '…'` instead of a bare 404. The cost is one to three extra lookups when `--branch` is given.
- `branch` already worked the same way as `resolveRef`'s first step (`/refs/branches/{encoded name}`), so its code is unchanged. The SKILL.md gotcha now says which commands resolve to a SHA and that `branch` relies on URL encoding.
- `diff`/`diffstat`/`merge-base` ranges are left for L1.
- Checked offline against a local mock API: `feature/SSP-1024` resolved through `refs/branches/feature%2FSSP-1024`, then `/commits/<sha>`; no `--branch` still hits `/commits`; `nope#x?y` was encoded in all three lookups and failed with the resolve error. Not tested against live Bitbucket.

#### M5. `pr-context` hides API errors as "nothing found" — RESOLVED 2026-10-13

The `soft()` wrapper ([bb.mjs:627](../../scripts/bb.mjs#L627)) turns every failure of the diffstat, statuses and comments calls into `null`. The output then says "No diffstat available.", "No build statuses found." or "No comments.". A 403 (missing `pipeline` scope), a 429 or a timeout is therefore indistinguishable from an empty result. In a "should I merge this?" briefing, "No build statuses found" is a materially wrong answer when the truth is "could not read statuses".

**Suggestion:** have `soft` record the error and print `Build status: unavailable (403 …)` instead.

**Resolution:**

- `soft(key, f)` now records the failure in an `errors` map (the error message plus the `hintFor()` line, e.g. the 403 scope hint) and still returns `null`, so the rest of the briefing is produced.
- Each section prints `Unavailable: <error>` when its call failed, and keeps "No diffstat available." / "No build statuses found." / "No comments." only for a genuinely empty result.
- `errors` is also included in the `--json` output, so scripted callers can tell the cases apart.
- Checked offline against a local mock API (statuses returned 403, diffstat OK, comments empty): the build-status section read `Unavailable: Bitbucket API error: 403 Forbidden … Hint: Access denied …`, the diffstat printed normally and comments still said "No comments.". Not tested against live Bitbucket.

### Low

#### L1. Several path and query values are built without escaping — RESOLVED 2026-10-13

- `pr-context --branch` ([bb.mjs:619](../../scripts/bb.mjs#L619)), `issues --state/--kind` ([bb.mjs:685-686](../../scripts/bb.mjs#L685-L686)) and `search-repos` ([bb.mjs:394](../../scripts/bb.mjs#L394), which escapes `"` but not `\`) interpolate user text into BBQL. A quote or backslash in a branch name breaks or alters the query.
- `diff`, `diffstat` and `merge-base` put `spec` straight into the path ([bb.mjs:512](../../scripts/bb.mjs#L512), [527](../../scripts/bb.mjs#L527), [534](../../scripts/bb.mjs#L534)). `?` or `#` changes the request, and `..` segments are normalised by `new URL`, so the request can reach a different path on the same origin.
- The impact is contained: it is GET-only and the origin check holds. These are correctness and robustness issues rather than a security hole.

**Suggestion:** one `bbqlString(s)` helper that escapes `\` and `"`, and a `rangeSpec()` helper that validates `<rev>` or `<rev>..<rev>` and encodes each part.

**Resolution:** added `bbqlString()` (escapes `\` then `"`, and adds the quotes) and `rangeSpec()` (rejects empty parts, dot-only parts and more than one `..`, then `encodeURIComponent`s each part) next to `enc` in `bb.mjs`. `search-repos`, `pr-context --branch` and `issues --state/--kind` use the first; `diff`, `diffstat` and `merge-base` use the second. Checked with `node --check` and by running `diff` with `../x` and `a..b..c` (both rejected locally) and `x?y#z` (stays in the path and reaches the API as a normal 404). Not tested against a live repository.

#### L2. `--max-chars` works against the tail-first design of log output — RESOLVED 2026-10-13

`pipeline-step-log` deliberately keeps the end of the log because failures are at the end ([bb.mjs:675-678](../../scripts/bb.mjs#L675-L678)). But `--max-chars` keeps the **head** of the final output ([bb.mjs:759-760](../../scripts/bb.mjs#L759-L760)). Combining them silently cuts off the failure. Use `--tail` for logs, not `--max-chars`. SKILL.md does not say so.

**Suggestion:** add a one-line note in SKILL.md, or make `--max-chars` keep the tail when the command is `pipeline-step-log`.

The whole log is also downloaded and sliced locally. Pipeline logs support HTTP range requests _(unverified)_, which would avoid pulling megabytes to show 50 KB.

**Resolution:**

- `pipeline-step-log` now returns `keepTail: true`. In text mode, `main` then applies `--max-chars` to the end of the output (with a `… [truncated: showing last N of M chars]` line first) instead of the start. `--json` and `--select` output stays head-truncated, because a tail slice of JSON would not parse.
- SKILL.md and `help` now say that `--max-chars` keeps the end for this command, and that `--tail CHARS` is the preferred control for logs.
- Checked offline against a local mock server: `--max-chars 60` kept the final `FAILURE: assertion failed` line; with `--json` the head was kept. Not tested against live Bitbucket.
- **Not done:** the range-request idea. It is unverified that the log endpoint supports it, and it needs a live test first.

#### L3. The pipeline log endpoint rejects `Accept: text/plain` — RESOLVED 2026-10-13

`getText` always sent `Accept: text/plain`. A live test confirmed that Bitbucket answers that with **406 Not Acceptable** on `/pipelines/{uuid}/steps/{uuid}/log`. As a result, `pipeline-step-log` failed on every step, whether or not the log still existed. This was a real functional break, not just a theoretical risk.

Live results on two steps (all requests were GETs, read-only):

| `Accept`                   | Result                                                     |
| -------------------------- | ---------------------------------------------------------- |
| `text/plain`               | 406 `{"code": 406, "message": "HTTP 406 Not Acceptable"}`  |
| `application/json`         | 406                                                        |
| `application/octet-stream` | 404 `Log in step {…} does not exist.` (passed negotiation) |
| `*/*`                      | 404, same (passed negotiation)                             |

The 404s are genuine. The newest pipeline run in the workspace is from 2024-10, and Bitbucket had already expired those logs. Following redirects made no difference.

**Resolution:** `getText` now takes an optional `accept` argument, which still defaults to `text/plain` ([bb.mjs:252](../../scripts/bb.mjs#L252)). `pipeline-step-log` passes `application/octet-stream` ([bb.mjs:761-762](../../scripts/bb.mjs#L761-L762)). Re-running the command now reaches the real 404 instead of the 406. `diff` and `file` were re-checked live and still work with `text/plain`, so they are unchanged.

- **Not verified:** a 200 response with real log content, because no unexpired log was available. Re-check the next time a pipeline runs in any repo.
- **Follow-up (not done):** an expired log gets the generic "Check workspace/repo/ref spelling" hint, which is misleading. A 404 from this endpoint could instead say that the log may have expired.

#### L4. `comment-thread` silently stops at 2,000 comments — RESOLVED 2026-10-13

It calls `getList` with `all: true` ([bb.mjs:652](../../scripts/bb.mjs#L652)) and ignores the `truncated` flag. A reply beyond the cap is simply missing from the thread. Any user-supplied `--page` or `--pagelen` also leaks into that internal call because `ctx.flags` is spread. Both are unlikely in practice, but the first is a silent wrong answer.

**Resolution:**

- The internal `getList` call now gets a fresh flags object (`all` and `max-pages` only), so `--page`, `--pagelen`, `--max-pages`, `--q` and `--sort` from the user no longer leak in.
- The page cap is lifted to `THREAD_MAX_PAGES` (1000 pages, i.e. 100,000 comments) instead of the default 20.
- If even that cap is hit, the text output ends with a `WARNING` line and the JSON gets `truncated: true`, so a missing reply is never silent.
- Checked offline against a local mock API (3 comment pages, the only reply on page 3): with `--page 2 --pagelen 1 --max-pages 1 --q foo` the reply was still found, and the mock saw one `pagelen=100` request followed by pages 2 and 3. The truncation warning path was not exercised. Not tested against live Bitbucket.

#### L5. `pr-context` totals count only the first diffstat page — RESOLVED 2026-10-13

It requested one page of 100 entries and summed them. A PR with more than 100 changed files reported wrong totals with no "more" note (unlike `pr-diffstat`, which appends `pageNote`).

**Resolution:**

- The diffstat call in `pr-context` now goes through `getList` with `all: true` and a fresh flags object, so it follows every page and ignores any `--page`, `--pagelen`, `--q` or `--sort` the user passed. The default 20-page cap (2,000 files) still applies.
- If that cap is hit, the diffstat section adds a `WARNING` line saying the totals are partial and pointing to `pr-diffstat --all --max-pages N`. The count and totals therefore cover every file Bitbucket returned, and are never silently short.
- Checked offline against a local mock API: a 250-file PR (3 pages) reported `250 file(s) changed, +500 -250` even with `--page 2 --pagelen 5`; a 2,500-file PR reported 2,000 files plus the warning. Not tested against live Bitbucket.

#### L6. Argument parsing is permissive — RESOLVED 2026-10-13

- Unknown flags are silently ignored. `--pagelenn 5` or `--branchh x` does nothing, and the user gets a plausible but wrong default result.
- A value flag swallows the next token even if it is another flag (`--ref --raw` sets `ref` to `--raw`).
- `-h` is not recognised.

**Suggestion:** keep a per-command set of known flags and reject others with a "did you mean" hint.

**Resolution:**

- `checkFlags()` runs in `main` before the command. A command's known flags are the `--name` tokens in its own usage string plus a `GLOBAL_FLAGS` list (`json`, `select`, `max-chars`, `help`, `page`, `pagelen`, `all`, `max-pages`, `q`, `sort`). Anything else fails with `Unknown flag --x. Did you mean --y?` (edit distance of 2 or less). Using the usage string as the source means the flag list and `help` cannot drift apart. A check of every `flags.*` read in the code found one gap, `diffstat` (it reads `--ignore-whitespace` and `--topic`), and its usage string now lists them.
- A value flag whose next token starts with `--` now fails with `--ref needs a value, but the next argument is "--raw"`. `--flag=--value` is the escape for a value that really starts with `--`. Single-dash values such as `--sort -updated_on` are unaffected.
- `-h` is an alias for `--help`. `help` output documents all three behaviours, and SKILL.md has a matching gotcha.
- **Side effect:** a flag that a command reads but does not list in its usage string would now be rejected, so new flags must be added to the usage string (that is also what puts them in `help`).
- Checked offline: `--pagelenn`, `--reff`, `--branchh` and `--ref --raw` fail with exit 1 and the hint; `-h` prints command help with exit 0; valid combinations (`--state --q --sort --pagelen --json`, `--tail --max-chars`) get past the check and reach the network layer. Not tested against live Bitbucket.

#### L7. No HTTPS enforcement on `BITBUCKET_API_BASE` — RESOLVED 2026-10-13

The origin check compares against `BASE` itself ([bb.mjs:92-96](../../scripts/bb.mjs#L92-L96)). If the environment variable is set to an `http://` URL, Basic-auth credentials are sent in clear. This is a self-inflicted configuration, but a one-line guard would remove it.

**Resolution:**

- `assertAllowedUrl()` now also refuses a `BASE` that is not `https:`, with a message naming `BITBUCKET_API_BASE`. Every request goes through `rawGet`, so the check covers all commands, `get` with an absolute URL and pagination `next` links.
- Loopback hosts (`localhost`, `127.x.x.x`, `[::1]`) are exempt, because the offline checks in this review use local mock servers. They cannot leak credentials off the machine.
- The check lives in `assertAllowedUrl` and not at module load, so the error is a normal `CliError` (exit 1, no stack trace) and `bb check` and `bb help` still work with a bad value.
- SKILL.md setup notes now say the base must be `https://`.
- Checked: `http://example.com/2.0` fails before any request; `http://localhost` and `http://127.0.0.1` reach the network layer (refused port); the default HTTPS base still works. Not checked: a proxy that terminates TLS and re-serves over http, which is unsupported by design.

#### L8. Smaller robustness points — RESOLVED 2026-10-13

All eight points were investigated against the code and confirmed real. Original findings, then the resolution below.

- `search-code` assumes `content_matches` is always an array ([bb.mjs:707](../../scripts/bb.mjs#L707)). A path-only match would throw a `TypeError`.
- `diffstatText` sums `lines_added`/`lines_removed` without defaults ([bb.mjs:291-292](../../scripts/bb.mjs#L291-L292)). A binary file entry with missing counts would produce `NaN`.
- A 200 response that is not JSON (a corporate proxy or login page) surfaces as `Unexpected token <` from `JSON.parse`, with no mention that the body was HTML.
- `fileResult` splits on `\n`, so CRLF files keep a trailing `\r` on every line. Binary files are decoded as text.
- 429 handling ignores the `Retry-After` header and always sleeps 1s then 2s ([bb.mjs:155](../../scripts/bb.mjs#L155)).
- `defaultBranch` swallows every error and falls back to `'main'` ([bb.mjs:250-257](../../scripts/bb.mjs#L250-L257)). A repo whose default is `master`, hit during an outage, produces a misleading "could not resolve ref 'main'".
- `resolveRef` makes up to three sequential calls per ref, so a plain `file` costs up to five requests (default branch, three resolution attempts, content). A cheap pre-check could skip straight to `/commit/` for a 40-character hex string.
- `parseRepoToken` accepts any `http(s)` URL and takes the first two path segments. An API URL such as `https://api.bitbucket.org/2.0/repositories/ws/repo` would parse as workspace `2.0`, repo `repositories`. It does no network I/O on that URL, so this is a UX issue only.

**Resolution:**

- **`search-code`:** every level (`content_matches`, `lines`, `segments`) is now optional, and `content_match_count` falls back to the number of hits. A path-only match prints its header line with no body.
- **`diffstatText` and `pr-context`:** a `lineCount()` helper treats missing or non-numeric counts as 0, so totals can no longer become `NaN`.
- **Non-JSON 200:** new `parseJson()` is used by `getJson`, `get` and `browse`. It reports `Expected JSON from <host> but got an HTML page (content-type: …). A proxy, firewall or login page is probably intercepting the request.` and never echoes the body.
- **`fileResult`:**
  - Splits on `\r?\n`, so CRLF files no longer leave a `\r` on every line. `--json` and `--raw` content is rejoined with the file's own line ending.
  - A NUL byte in the first 8000 characters (git's own heuristic) now prints `looks like a binary file; content not shown` instead of decoded garbage. Binary files are still downloaded in full before that check.
- **429/5xx:** `Retry-After` (seconds or an HTTP date) is honoured. A request to wait more than 30 s (`MAX_RETRY_WAIT`) fails at once with the wait named in the error, rather than stalling the CLI. Without the header the old 1 s, 2 s backoff applies.
- **`defaultBranch`:** no longer swallows errors. An outage, 403 or 404 now surfaces as the real API error with its hint, not a made-up `main`. A repo with no `mainbranch` (empty repo) still gets `main`.
- **`resolveRef`:** a 40-character hex ref is tried as `/commit/` first, so a `file --ref <sha>` is two requests (resolve, content) instead of four. Other refs keep the branch, tag, commit order, and a 40-hex name that is really a branch still resolves via the fallback.
- **`parseRepoToken`:** `/2.0/repositories/<ws>/<repo>/…` API URLs are unwrapped, and `/pullrequests/<id>` is recognised as well as `/pull-requests/<id>`. A `/2.0/…` URL that is not a repository path fails with a pointer to `get`.
- Checked offline against a local mock API: path-only and normal `search-code` matches, a diffstat entry without counts (`+0 -0`, totals `+2 -1`), an HTML 200 through `repo` (error) and `get` (raw text still printed), a 429 with `Retry-After: 3` (waited about 3 s, then succeeded), `Retry-After: 600` (failed in under 100 ms), CRLF and binary files, 40-hex versus default-branch request sequences, a 404 repo (single request, real 404 hint), and API URL parsing. Not tested against live Bitbucket.

#### L9. Error exits crash with a libuv assertion on Windows — RESOLVED 2026-10-13

Found while testing M4. On Node 24 on Windows, any command that failed after making a request printed its error, then aborted with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` and exited with code 127 instead of 1. The cause was `process.exit(1)` in the top-level `catch`, which tore the process down while `fetch`'s sockets were still closing.

**Resolution:** the `catch` now sets `process.exitCode = 1` and lets the process exit naturally. Checked offline against local mock servers: a failed ref resolution, a 404, an unknown command, a missing repo argument, a refused connection and a request timeout (after retries) all exit 1 promptly with no assertion, and a successful command still exits 0.

#### L10. `workspaces` returns 404 on live Bitbucket — RESOLVED 2026-10-13

Found while testing L3. `workspaces` called `GET /workspaces`, and live Bitbucket now answers 404 "There is no API hosted at this URL". `GET /user/workspaces` works. Its `values` are `workspace_access` objects, so the formatter must read `v.workspace.slug` instead of `v.slug`. `workspace <slug>` and `/workspaces/{ws}/search/code` use separate endpoints and are not affected.

**Resolution:**

- `workspaces` now calls `/user/workspaces` ([bb.mjs:503-509](../../scripts/bb.mjs#L503-L509)) and reads `v.workspace.slug`.
- The nested `workspace` object has only `type`, `uuid`, `slug` and `links`, with **no `name`**, so the old `(name)` suffix would have printed `(undefined)`. The line now shows the slug, plus `(administrator)` when `administrator` is true. `workspace <slug>` still gives the name and details.
- Checked live (GET only): `workspaces` lists the one accessible workspace and exits 0, and `workspace <slug>` still works. Not checked: a user with more than one workspace, or paging through `/user/workspaces`.

### Documentation issues

| Where                                                                         | Issue                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [SKILL.md:55](../../SKILL.md#L55)                                             | `<branch\|tag\|sha>` has unescaped pipes inside a Markdown table row, so renderers split the cell. [mcp-tool-map.md](../../references/mcp-tool-map.md) escapes its pipes correctly; this one needs the same. |
| [SKILL.md:73](../../SKILL.md#L73)                                             | `--all` is documented as "capped at 20 pages", but the cap is tunable via `--max-pages`, which only appears in `bb help`.                                                                                    |
| [SKILL.md:93](../../SKILL.md#L93)                                             | Retries are described as covering 429 and 5xx. Timeouts are also retried (undocumented), and network errors are not (see M3).                                                                                |
| [SKILL.md:90](../../SKILL.md#L90)                                             | See M4 (fixed).                                                                                                                                                                                              |
| [SKILL.md:62](../../SKILL.md#L62) and [bb.mjs:347](../../scripts/bb.mjs#L347) | The `hooks` example conflicts with M1.                                                                                                                                                                       |
| Whole skill                                                                   | No README, changelog or version marker. The user-agent string is hard-coded as `bitbucket-cloud-skill/1.0` ([bb.mjs:21](../../scripts/bb.mjs#L21)).                                                          |

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

| Policy item                                             | Status                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production systems read-only; no deploy, merge, approve | **Met.** GET-only client with no write commands. SKILL.md instructs Claude to decline write requests and offer draft text instead.                                                                                                                                  |
| No credentials or secrets in prompts                    | **Met for the skill's own flow.** Credentials come from the environment and are never echoed. The weak spot is `get` (M1), which can fetch secret-bearing config into context.                                                                                      |
| Customer data must not be entered into prompts          | **Partly mitigated.** SKILL.md warns that PRs, logs and issues can contain customer data and says to summarise rather than dump. This is guidance only; the CLI has no redaction. Pipeline logs (`pipeline-step-log`) are the likeliest place for sensitive output. |
| Incident reporting for accidental disclosure            | **Addressed** in the credentials section of SKILL.md.                                                                                                                                                                                                               |

## Recommended order of work

1. **M1.** Tighten `get` (denylist or allowlist) and drop the `hooks` example.
2. ~~**M2 and M3.** Timeout scope, and `e.cause` surfaced with retry on transient network codes.~~ Done.
3. ~~**M5.** Stop `pr-context` from reporting errors as empty results.~~ Done.
4. ~~**M4.** Fix the inaccurate `commits`/`branch` claim.~~ Done.
   4a. ~~**L1.** Escaping helpers.~~ Done. **Documentation table:** correct SKILL.md.
   4b. ~~**L4.** `comment-thread` page cap and flag leakage.~~ Done.
5. **Tests.** Make `bb.mjs` importable and add `node --test` coverage for the pure helpers and the paging/retry logic.
6. **Live verification** of the _(unverified)_ items: ~~the `Accept` header on step logs~~ (done, L3; still needs a 200 on an unexpired log), range requests, and proxy behaviour on the corporate network.
7. ~~**L10.** Move `workspaces` to `/user/workspaces`.~~ Done.
