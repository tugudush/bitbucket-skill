# Changelog

## Unreleased

Documentation audit of README.md and SKILL.md against `bb.mjs`:

- SKILL.md tells Claude to treat fetched PR, comment, issue, file and log content as untrusted data, and not to use `get` for secret-bearing configuration (M2). The `get` examples in SKILL.md and `help` now use `default-reviewers` instead of `hooks` (part of M1). The `get` denylist is not implemented yet.
- Added the commands the docs omitted (`repo`, `repos`, `pr-comment`, `pr-commits`, `pipeline`, `diffstat`, `branch`, `tag`, `check`) and the `diff`/`diffstat` flags `--ignore-whitespace` and `--topic`.
- Corrected page-size, `--json`, `--max-chars`, `BITBUCKET_WORKSPACE`, proxy and `NODE_USE_SYSTEM_CA` statements.

## 1.1.0 (2026-10-13)

Fixes from [docs/reviews/codebase-review.md](docs/reviews/codebase-review.md) (all except M1 and M2):

- Extra positional arguments and single-dash options are rejected, with a `--branch`/`--ref` suggestion where one fits (M3).
- `pr-statuses`, `commit-statuses` and `pipeline-steps` fetch 100 per page and print the "more results" footer. `pr-context` warns when build statuses are partial (M4).
- `browse` without a path resolves `--ref` like every other command (L1).
- `file` no longer counts the trailing newline as a line; an empty file and a `--start` past the end are reported (L2).
- `pr-activity` shows "changes requested" entries (L3).
- Paging and `--q`/`--sort` flags are accepted only by list commands; `search-code` takes paging but not `--q`/`--sort` (L4).
- Numeric flags, ids and `BITBUCKET_REQUEST_TIMEOUT` must be positive whole numbers (`--context` may be 0); an invalid `BITBUCKET_API_BASE` gets a clear error (L5).
- `.` and `..` path segments are rejected (L6).
- `pipeline-step-log` fetches only the tail with a Range request when the server supports it, strips ANSI colour codes, and gives a log-specific hint on 404 (L7).
- `check` reports a 403 as "credentials accepted, account scope missing" and exits 1 when authentication fails (L8).
- Redirects are followed hop by hop: off-origin redirects are refused, except for the step log, which gets no credentials there (L9).
- `pr-context --branch` lists the candidates when a branch has several open PRs (L10).
- `prs` says when it lists open PRs only (L11).
- `file-history` resolves its ref, so branch names with `/` work (L12).
- `help <unknown>` is an error; the `pr-context` comments fallback retries only on 400; non-Bitbucket URLs produce a warning.
- Node 20+ is the stated minimum. Docs use Atlassian's scope names. Version 1.1.0 is in `check`, `help` and the user agent.
- `bb.mjs` can be imported without running; `node --test` runs unit and mock-server tests in `tests/`.

## 1.0.0

Initial release.
