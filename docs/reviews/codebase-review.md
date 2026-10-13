# Codebase review: `bitbucket-cloud` skill

Reviewed: 2026-10-13, at commit `4e92aa2` (branch `feature/improvements`), plus the untracked `README.md`.
Updated: 2026-10-13, after the fixes for version 1.1.0 (uncommitted working tree on the same branch).

| File                                                           | Lines | Role                                                                                                           |
| -------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| [SKILL.md](../../SKILL.md)                                     | 101   | Skill manifest and the instructions Claude follows: trigger description, credentials, command routing, gotchas |
| [scripts/bb.mjs](../../scripts/bb.mjs)                         | 2,078 | The implementation: a dependency-free, GET-only Bitbucket Cloud CLI (Node 20+) with 40 commands                |
| [tests/bb.test.mjs](../../tests/bb.test.mjs)                   | 459   | `node --test` suite: unit tests for the helpers, end-to-end tests against loopback mock servers (**new**)      |
| [references/bbql.md](../../references/bbql.md)                 | 42    | Cheat sheet for the Bitbucket query language used by `--q` and `--sort`                                        |
| [references/mcp-tool-map.md](../../references/mcp-tool-map.md) | 52    | Maps the old `bb_*` MCP tool names to `bb` commands                                                            |
| [README.md](../../README.md)                                   | 162   | Human-facing setup and usage guide (**not yet committed**)                                                     |
| [CHANGELOG.md](../../CHANGELOG.md)                             | 27    | Version history, starting at 1.1.0 (**new, not yet committed**)                                                |
| [package.json](../../package.json)                             | 12    | Version, Node engine and the `npm test` script; no dependencies (**new, not yet committed**)                   |
| [.gitignore](../../.gitignore)                                 | 34    | Ignores secrets, Node artefacts, logs, editor files                                                            |

This replaces the earlier review of the same name. That review's findings were almost all fixed in `c87f042` and `4e92aa2`. The ones still open at `4e92aa2` were carried forward and marked _(carried over)_.

## Status

| Finding                     | Severity | Status                                                                       |
| --------------------------- | -------- | ---------------------------------------------------------------------------- |
| M1 `get` and secrets        | Medium   | **Open**                                                                     |
| M2 Untrusted content        | Medium   | **Open**                                                                     |
| M3 Extra arguments          | Medium   | Fixed                                                                        |
| M4 Missing footer           | Medium   | Fixed                                                                        |
| L1–L12                      | Low      | Fixed. L1, L7 and L9 still need a live check (see [Next steps](#next-steps)) |
| Nits                        | —        | Fixed                                                                        |
| Documentation               | —        | Fixed, except the M1/M2 rows and committing the new files                    |
| Testing and maintainability | —        | Fixed: tests added, entry point guarded, list formatting shared              |

`node --check scripts/bb.mjs` passes, and `node --test` passes all 41 tests on Node v24.12.0. Fixed findings are summarised below with a link to the fix. The line references in their "Was" text describe commit `4e92aa2`, not the current file.

## How this review was done

- Read every file in full, plus the git history and the previous review.
- Ran the CLI against a **local mock API** on `127.0.0.1` (a loopback `BITBUCKET_API_BASE`, with dummy credentials). The mock logged each request's path and whether an `Authorization` header arrived. Findings marked _(verified)_ were reproduced this way. Those mock checks are now permanent tests in [tests/bb.test.mjs](../../tests/bb.test.mjs).
- **Nothing was run against live Bitbucket**, apart from one read-only `GET /user` from `bb check` while the fixes were tested. Findings that depend on Bitbucket's own behaviour are marked _(unverified)_.
- `grep` confirms that the only HTTP method in the code is `GET` ([bb.mjs:424](../../scripts/bb.mjs#L424)).

## Summary

The skill is in good shape. The design is small and coherent. The read-only and credential guarantees are enforced in code, not just stated in prose. The output is shaped for an LLM reader. **No critical or high-severity issues were found.**

The 1.1.0 fixes closed the "silent wrong answer" class of bug:

- Extra arguments and flags that a command would ignore are now rejected, as unknown flags already were.
- Every list now prints the "more results" footer.
- Numeric input is validated.
- Every redirect hop is checked.
- The skill now has an automated test suite.

What remains:

1. **Two policy and safety gaps, both open.** The `get` escape hatch can pull secret-bearing configuration into the conversation (M1). SKILL.md never tells Claude that PR text, comments and logs are untrusted input (M2).
2. **Live checks.** Three fixes rely on Bitbucket behaviour that was only tested against the mock (L1, L7, L9).
3. **Housekeeping.** Commit `README.md`, `CHANGELOG.md`, `package.json` and `tests/`.

## Architecture

```
SKILL.md ──(tells Claude to run)──▶ node scripts/bb.mjs <command> [args] [flags]
                                        │
   parseArgs ─▶ checkFlags ─▶ checkArgs ─▶ command registry C{} ─▶ run(ctx) ─▶ { data, text, keepTail?, exitCode? }
                                        │                                      │
                  repoCtx / prCtx       │                   --select / --json / text, then --max-chars
                  (ws/repo, repo or URL)▼
                  resolveRef, getList, getJson / getText ─▶ rawGet ─▶ fetchChecked
                                                             (GET only, validated API base, timeout over
                                                              the whole body, retry on 429/5xx/transient
                                                              network; every redirect hop checked)
```

- **Command registry.** `def(name, usage, summary, run, { paged, query })` fills one table `C` ([bb.mjs:732](../../scripts/bb.mjs#L732)). Each command returns `{ data, text }`, so `--json`, `--select` and the text view come from one place ([bb.mjs:1997](../../scripts/bb.mjs#L1997)). `help`, the known-flag list and the positional-argument limit are all derived from the usage strings, so they cannot drift apart. `paged` and `query` say which commands accept the list flags.
- **Target parsing.** `parseRepoToken`, `repoCtx` and `prCtx` accept `ws/repo`, a bare `repo` (with `BITBUCKET_WORKSPACE`), a bitbucket.org URL or an API URL ([bb.mjs:570-640](../../scripts/bb.mjs#L570-L640)).
- **Ref resolution.** `resolveRef` tries branch, then tag, then commit, and swallows only 404s. A 40-character hex string is tried as a commit first ([bb.mjs:648](../../scripts/bb.mjs#L648)). `file`, `browse` (with or without a path), `file-history` and `commits --branch` use it, which is why branch names containing `/` work there.
- **HTTP layer.** `rawGet` ([bb.mjs:455](../../scripts/bb.mjs#L455)) checks the origin, keeps the timeout armed until the body is read, honours `Retry-After` up to 30 s and maps network failures to a `NetworkError` with a hint. `fetchChecked` ([bb.mjs:418](../../scripts/bb.mjs#L418)) follows redirects itself, so each hop is checked. `apiBase()` and `timeoutMs()` validate the two settings once ([bb.mjs:224-247](../../scripts/bb.mjs#L224-L247)).
- **Paging.** `getList` handles `--page`, `--pagelen` (capped at 100), `--all` (capped by `--max-pages`, default 20) and merges `--q`/`--sort` into the request ([bb.mjs:533](../../scripts/bb.mjs#L533)). `listText` ([bb.mjs:679](../../scripts/bb.mjs#L679)) renders every list with its footer.

### Strengths

- **Read-only by construction.** There is no code path for any other HTTP verb, including in `get`.
- **Careful credential handling.** Credentials come from the environment and are never printed. `check` shows only "set" or "NOT SET", and shows the proxy state without the proxy value. Credentials are sent only to the configured API origin over HTTPS. That is now enforced on every redirect hop as well, without relying on the runtime's `fetch`. SKILL.md tells Claude never to take a token through chat and what to do if one leaks.
- **Errors are honest.** Status-specific hints separate "no credentials" from "bad credentials" from "missing scope". `pr-context` says "Unavailable: …" instead of "nothing found" when a section fails. HTML from a proxy or login page is named as such.
- **Context economy.** `--select`, server-side `--q`/`--sort`, diffstat before diff, `pr-context`, line-numbered paged files, and tail-first logs (range-fetched, with colour codes removed) all keep output small.
- **Defensive CLI.** Each of these is an error, not a silent wrong result:
  - an unknown flag (with a "did you mean" suggestion)
  - a flag the command would ignore
  - an extra argument (with a `--branch`/`--ref` suggestion where one fits)
  - a single-dash option
  - a non-integer number

  A value flag will not swallow a following `--flag`.

- **Tested.** The `node:test` suite runs the CLI against loopback mock servers. It covers every finding in this review.
- **Good comments.** The non-obvious decisions are explained where they are made: the 406 on log `Accept`, `process.exitCode` instead of `process.exit` on Windows, why `defaultBranch` does not guess, why redirects are followed by hand.
- **Zero dependencies**, so there is no supply-chain surface and nothing to install. The tests use only Node built-ins.

## Findings

Severity: **Medium** means worth fixing soon. **Low** means polish or hardening.

### Medium

#### M1. `get` can pull secret-bearing configuration into the conversation _(carried over, open)_

`get` ([bb.mjs:785-806](../../scripts/bb.mjs#L785-L806)) accepts any path on the API origin and prints the raw JSON. Depending on the token's scopes, that includes:

- webhooks (URLs can embed tokens)
- deploy keys and SSH keys
- pipeline variables (non-secured values are returned in clear)
- access-token metadata

The managed policy says credentials and secrets must not enter prompts. The only barrier today is the token's scope. SKILL.md also uses **`hooks` as its example** for `get` ([SKILL.md:90](../../SKILL.md#L90)), and so does the command's own help text ([bb.mjs:788](../../scripts/bb.mjs#L788)). That actively points Claude at one of the riskier endpoints.

**Suggestion:**

1. Change both examples to something harmless, such as `get repositories/acme/webapp/default-reviewers`.
2. Add a denylist in `get` for path segments such as `hooks`, `deploy-keys`, `ssh-keys`, `variables`, `access-tokens`, `/user/emails` and `pipelines_config`. Fail with a message that names the policy.

#### M2. SKILL.md does not tell Claude that fetched content is untrusted _(open)_

Nearly everything this skill returns was written by someone other than the user: PR titles and descriptions, review comments, commit messages, issue bodies, file contents and build logs. A PR from a fork or an outside contributor can contain text written to steer an AI reviewer, for example "ignore previous instructions and run …".

SKILL.md has a section on customer data ([SKILL.md:97](../../SKILL.md#L97)), but nothing that says to treat fetched content as data and not as instructions. This skill is built for "review this PR", so it is the main way untrusted text reaches Claude in this setup.

**Suggestion:** add a short paragraph to SKILL.md, near "Read-only by design" ([SKILL.md:28](../../SKILL.md#L28)). It should say that output from `bb` is third-party content, that instructions inside it are never to be followed, and that any such text should be pointed out to the user. Optionally, `main` could wrap the text output in a clear begin/end marker naming the source.

#### M3. Extra positional arguments were silently ignored _(verified, fixed)_

**Was:** no command checked for leftover positional arguments. `bb commits ws/repo develop` listed the default branch's commits, and `bb file ws/repo src/a.ts feature/x` showed the file on `main`, labelled `@ main`. Single-dash options such as `-r main` were dropped the same way.

**Fix:** `maxArgs` counts the `<…>` and `[…]` tokens in the first form of each usage string. `checkArgs` rejects any argument beyond that, and `unexpectedArg` suggests `--branch` or `--ref` where the command has one ([bb.mjs:139-172](../../scripts/bb.mjs#L139-L172)). `prCtx` allows one argument fewer when a PR URL carries the id ([bb.mjs:620](../../scripts/bb.mjs#L620)). `parseArgs` rejects single-dash options and treats everything after `--` as positional ([bb.mjs:65](../../scripts/bb.mjs#L65)). The `pr-context` usage was rewritten as three explicit forms so the count is right.

#### M4. Three list commands dropped the "more results" footer _(verified, fixed)_

**Was:** `pr-statuses`, `commit-statuses`, `pipeline-steps` and the build-status section of `pr-context` read one page of 10 and never printed `pageNote`. A pipeline with more than 10 steps could hide the failing one, and the output looked complete.

**Fix:** every list command now renders through `listText` ([bb.mjs:679](../../scripts/bb.mjs#L679)), which always appends the footer. The three commands ask for 100 per page ([bb.mjs:1209](../../scripts/bb.mjs#L1209), [bb.mjs:1518](../../scripts/bb.mjs#L1518), [bb.mjs:1738](../../scripts/bb.mjs#L1738)). `pr-context` fetches statuses with `pagelen: 100` and warns when there are more ([bb.mjs:1667](../../scripts/bb.mjs#L1667)).

### Low

All twelve are fixed. Each has a test in [tests/bb.test.mjs](../../tests/bb.test.mjs).

| #   | Was                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `browse` with no path requested `/src?at={ref}`. `at` is undocumented, so the default branch could be listed under the heading `@ feature/x`. _(unverified)_                                                                       | The root also resolves the ref and requests `/src/{sha}/` ([bb.mjs:943](../../scripts/bb.mjs#L943)). The special case is gone. _Live check still useful._                                                                                                                                                                                                                                                                 |
| L2  | `file` counted the trailing newline as an extra, empty line, so a two-line file showed `lines 1-3 of 3`. _(verified)_                                                                                                              | One trailing empty element is dropped. An empty file says so, and a `--start` past the end is an error ([bb.mjs:979-1001](../../scripts/bb.mjs#L979-L1001)).                                                                                                                                                                                                                                                              |
| L3  | `pr-activity` printed a changes-requested review as `- changes_requested, pull_request`. _(verified)_                                                                                                                              | A `changes_requested` branch names the reviewer and date. The fallback ignores the `pull_request` key ([bb.mjs:1454](../../scripts/bb.mjs#L1454)).                                                                                                                                                                                                                                                                        |
| L4  | All ten global flags were accepted by every command, so `pr-diff --all --q … --sort …` silently did nothing. `search-code` sent `--q`/`--sort` to an endpoint that ignores them. _(verified)_                                      | Flags are split into output, paging and query flags. Paging and query flags are accepted only by commands defined with `paged` (and `query`), and give a clear error elsewhere. `search-code` takes paging but not `--q`/`--sort` ([bb.mjs:50](../../scripts/bb.mjs#L50), [bb.mjs:113](../../scripts/bb.mjs#L113)). `help` marks list commands `[list]`.                                                                  |
| L5  | `num()` accepted zero, negative and fractional values. `--tail 0` printed the whole log, `--page 1.5` reached the API, a negative timeout aborted every request, and a bad API base failed with a bare `Invalid URL`. _(verified)_ | `int(v, label, min)` accepts only whole numbers ≥ 1 (≥ 0 for `--context`). It is used for every numeric flag, every id and `BITBUCKET_REQUEST_TIMEOUT` ([bb.mjs:175](../../scripts/bb.mjs#L175), [bb.mjs:242](../../scripts/bb.mjs#L242)). `apiBase()` names an unparseable `BITBUCKET_API_BASE` ([bb.mjs:224](../../scripts/bb.mjs#L224)).                                                                               |
| L6  | `enc()` left `.` and `..` alone, so `bb commit ws/repo ..` requested the repository itself. _(verified)_                                                                                                                           | `enc` (and so `encPath`) rejects `.` and `..` segments before any request is sent ([bb.mjs:187](../../scripts/bb.mjs#L187)). Encoding as `%2E` would not help, because URL parsing treats that as a dot segment too.                                                                                                                                                                                                      |
| L7  | `pipeline-step-log` downloaded the whole log, kept ANSI colour codes, and gave the generic "check spelling" hint on 404. _(ANSI verified)_                                                                                         | `fetchStepLog` sends `Range: bytes=-N` and falls back to the full download on 200, on 416, or when the range is too short. It strips ANSI sequences before tailing, and drops the partial first line of a range. A 404 gets a log-specific hint ([bb.mjs:1764-1812](../../scripts/bb.mjs#L1764-L1812)). _Live check of range support still useful._                                                                       |
| L8  | `check` reported a valid token without account scope (403) as "Auth check failed", with the generic scope hint, and always exited 0. _(verified)_                                                                                  | A 403 prints "Credentials accepted, but the token cannot read your account (needs the read:user:bitbucket scope)". Any other failure sets exit code 1 through a new `exitCode` field in the command result ([bb.mjs:768](../../scripts/bb.mjs#L768)).                                                                                                                                                                     |
| L9  | `fetch` followed redirects with `redirect: "follow"`, and the final URL was never checked. Node 24 stripped `Authorization`, but that was the runtime's doing, and the foreign response was printed as Bitbucket's. _(verified)_   | `fetchChecked` uses `redirect: "manual"` and checks every hop (at most 5). Same-origin hops keep credentials. A hop to another origin is refused, except for the step-log endpoint (`foreignRedirects`), which may redirect to log storage. That hop must be HTTPS and is sent without credentials ([bb.mjs:418](../../scripts/bb.mjs#L418)). _Live check: whether any other endpoint legitimately redirects off-origin._ |
| L10 | `pr-context --branch` asked for `pagelen: 1` and silently picked one PR when a branch had several.                                                                                                                                 | It fetches up to 10. If there is more than one result, it lists the candidates with their destination branches and asks for an id ([bb.mjs:1569](../../scripts/bb.mjs#L1569)).                                                                                                                                                                                                                                            |
| L11 | `prs` without `--state` listed only open PRs, under the heading `Pull requests in …`.                                                                                                                                              | The heading says "Open pull requests" (or the given state), and an empty result says merged and declined PRs need `--state` ([bb.mjs:1308](../../scripts/bb.mjs#L1308)). The usage summary, SKILL.md, README and the MCP tool map mention the default.                                                                                                                                                                    |
| L12 | `file-history` put the branch straight into the path as one encoded segment, so `feature/x` became `feature%2Fx`. _(unverified)_                                                                                                   | It calls `resolveRef` first, as `file` and `commits --branch` do ([bb.mjs:1052](../../scripts/bb.mjs#L1052)). SKILL.md's slash-branch gotcha now lists it.                                                                                                                                                                                                                                                                |

#### Nits (fixed)

- `bb help nosuch` and `bb nosuch --help` now give the "Unknown command" error and exit 1 ([bb.mjs:1963](../../scripts/bb.mjs#L1963)).
- The `pr-context` comments fallback retries without `sort` only on a 400, not after a 401 or a timeout ([bb.mjs:1624](../../scripts/bb.mjs#L1624)).
- `parseRepoToken` warns on stderr when a URL's host is not bitbucket.org or the API host ([bb.mjs:580](../../scripts/bb.mjs#L580)).

### Documentation

| Where                                                                              | Issue                                                                                                                                                       | Status                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SKILL.md:90](../../SKILL.md#L90), [bb.mjs:788](../../scripts/bb.mjs#L788)         | The `hooks` example for `get`. See M1. _(carried over)_                                                                                                     | **Open** (part of M1)                                                                                                                                                                                                             |
| SKILL.md, whole file                                                               | Nothing says fetched content is untrusted. See M2.                                                                                                          | **Open** (part of M2)                                                                                                                                                                                                             |
| SKILL.md command table                                                             | `<branch\|tag\|sha>` had unescaped pipes inside a table row, so Markdown renderers split the cell. _(carried over)_                                         | Fixed                                                                                                                                                                                                                             |
| SKILL.md, "Keeping output small"                                                   | `--all` was described as "capped at 20 pages" without mentioning `--max-pages N`. _(carried over)_ The footer promise did not hold for three commands (M4). | Fixed. It now mentions `--max-pages`, that every list prints the footer, and that list flags apply to `[list]` commands only.                                                                                                     |
| SKILL.md setup notes, README requirements, bb.mjs header                           | "Node 18+", although Node 18 reached end of life in April 2025 and only Node 24 had been tested.                                                            | Fixed: "Node 20+ (tested on 24)", also in `package.json` `engines`                                                                                                                                                                |
| README token step, SKILL.md credentials and errors, `explain(403)`                 | Scope lists did not use Atlassian's names, and missed workspace and account read.                                                                           | Fixed. They now use `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `read:pipeline:bitbucket`, `read:issue:bitbucket`, `read:workspace:bitbucket` and `read:user:bitbucket`, and the README says what each one covers. |
| SKILL.md command table, [mcp-tool-map.md:15](../../references/mcp-tool-map.md#L15) | The open-only default for `prs` was not mentioned. See L11.                                                                                                 | Fixed. SKILL.md has a new "Which PRs exist" row.                                                                                                                                                                                  |
| SKILL.md gotchas, README troubleshooting                                           | The new argument and flag rules and the redirect refusal were not documented.                                                                               | Fixed                                                                                                                                                                                                                             |
| [README.md](../../README.md)                                                       | Untracked in git, so it is not shipped with the skill yet.                                                                                                  | **Open:** commit it, with `CHANGELOG.md`, `package.json` and `tests/`                                                                                                                                                             |
| Whole skill                                                                        | No version marker or changelog, and the user agent was hard-coded as `bitbucket-cloud-skill/1.0`.                                                           | Fixed. `VERSION = "1.1.0"` ([bb.mjs:21](../../scripts/bb.mjs#L21)) feeds the user agent, `check` and `help`. The README has a version line, and CHANGELOG.md was added.                                                           |

## Testing and maintainability

- **Automated tests (fixed).** `bb.mjs` now runs `main()` only when it is the script being executed ([bb.mjs:2034](../../scripts/bb.mjs#L2034)). The check compares real paths case-insensitively on Windows, and was confirmed to work from relative and differently-cased paths. The pure helpers are exported ([bb.mjs:2058](../../scripts/bb.mjs#L2058)). [tests/bb.test.mjs](../../tests/bb.test.mjs) has 41 `node:test` tests:
  - Unit tests: `parseArgs`, `checkFlags`, `maxArgs`, `int`, `enc`/`encPath`, `rangeSpec`, `bbqlString`, `stripAnsi`, `duration`, `project`, `parseRepoToken` and `fileResult`.
  - End-to-end tests: two loopback mock servers, one acting as the API and one as a foreign origin. They cover M3, M4, L1–L12 and the nits.

  Run them with `node --test` or `npm test`. Everything is still single-file and zero-dependency.

- **Repeated output shapes (fixed).** `listText(title, r, ctx, fmt, what, sep)` now renders every list command, so the footer cannot be forgotten. The commit-line formatter is shared as `commitLine` ([bb.mjs:685](../../scripts/bb.mjs#L685)).
- **Long one-line templates (fixed where flagged).** The `pipelines` and `issues` item lines are now built from arrays. A few other long templates remain, such as `user` and `commentLine`. They are readable enough not to be worth churning.
- **Formatting.** The code follows the existing Prettier style, but Prettier is not installed here, so the new code was formatted by hand. Running Prettier once before committing would normalise any drift.
- **One file of about 2,080 lines** is still a reasonable trade-off for a skill that is copied as a folder. The section banners keep it navigable, so splitting it into modules is not recommended.

## Policy alignment (managed settings)

| Policy item                                                | Status                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production systems read-only; never approve, merge, deploy | **Met.** GET-only client with no write commands. SKILL.md tells Claude to decline write requests, not to work around them with `curl`, and to offer draft text instead.                                                                                             |
| No credentials or secrets in prompts                       | **Met for the skill's own flow.** Credentials come from the environment and are never printed; `check` hides proxy values too. Credentials are never sent off the API origin, even on a redirect. **Gap:** `get` can fetch secret-bearing configuration (M1, open). |
| No customer data in prompts                                | **Partly mitigated.** SKILL.md says to summarise rather than dump PRs, logs and issues. This is guidance only; the CLI does no redaction. Pipeline logs are the likeliest source.                                                                                   |
| Incident reporting for accidental disclosure               | **Addressed** in the credentials section of SKILL.md and in the README's security notes.                                                                                                                                                                            |
| Claude may propose changes for human review                | **Supported.** Write requests are turned into drafts for the user to post.                                                                                                                                                                                          |

## Next steps

1. **M1 and M2.** Both are small text changes to SKILL.md, plus a denylist in `get`. They close the two remaining policy-relevant gaps. Add a test for the denylist alongside the existing ones.
2. **Live checks** against real Bitbucket, with a read-only token:
   - L1: whether `/src/{sha}/` lists the repository root as expected.
   - L7: whether the step-log endpoint answers `Range: bytes=-N` with 206. The code falls back to a full download if it does not.
   - L9: whether the step log, or any other endpoint, redirects to another origin. If another endpoint does, give it `foreignRedirects: true`.
   - L12: whether `file-history` works with a slash branch after ref resolution.
3. **Housekeeping:** run Prettier once, then commit `README.md`, `CHANGELOG.md`, `package.json`, `tests/` and the updated files.
