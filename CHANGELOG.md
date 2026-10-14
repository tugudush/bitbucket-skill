# Changelog

## Unreleased

Documentation only, no change to `bb.mjs`: the skill is now written for any agent that supports Agent Skills, in particular Claude Code and GitHub Copilot in VS Code.

- README: install table for both agents (`~/.claude/skills`, `~/.copilot/skills`, `.claude/skills`, `.github/skills`), a note that VS Code also reads `.claude/skills` so one clone serves both, and a fallback through `.github/copilot-instructions.md`.
- SKILL.md: "Bash tool" and "Claude Code" replaced by agent-neutral wording, how to find the skill's base directory in any agent, and a note on PowerShell quoting and pipes.

## 1.2.12 (2026-10-13)

Fixes from an eleventh review run (#678, 40 files, merged; notes in `test-skill/otg-keycloak-ui-pr-678-review-run11.md`, issues 1-3):

- **Invisible characters in fetched text were printed as they are.** The description of #678 ends in U+200C and every text view showed a blank line. The same channel can carry bidi controls and Unicode tag characters (U+E0000-E007F, readable by a model and invisible to people). The text views now write each format character (Unicode category Cf) as `<U+XXXX>` and print once on stderr `Note: this text contains invisible character(s) (…)`. A leading U+FEFF and a U+200D after an emoji are left alone. `--json`, `--select` and `file --raw` are the payload (or the file's own bytes, for a pipe), so their stdout is unchanged; they print the same note on stderr (`this output contains …; JSON output, --raw included, prints them as they are`). SKILL.md's untrusted-content section says so.
- **How to see what a push changed was not written down, and the default range misleads after a rebase.** SKILL.md's `pr-activity` row now says: `diffstat <ws>/<repo> <new>..<old> --two-dot` for the real difference between two pushes (the default form compares against the merge base and lists the whole PR after a rebase), and `merge-base <old>..<new>` to tell a rebase from a plain push.
- **`tag <unknown>` gave the generic spelling hint.** It now says `No tag 'NAME' in <ws>/<repo>`, that the tag may have been deleted or renamed, and prints the `tags --q 'name~"NAME"'` search (without credentials the private-repository hint stays).
- Still open, on purpose: run 6 issue 2 and run 3 / run 10 issue 1.
- Tests: 180 to 183 (the helper, the text view against `--json` and `--raw` on a file with a zero-width, a bidi and two tag characters, and the `tag` hint with and without credentials).

## 1.2.11 (2026-10-13)

Fixes from a tenth review run, on another PR by another author (#683, 25 files; notes in `test-skill/otg-keycloak-ui-pr-683-review-run10.md`, issues 2-5):

- **The "before" side of a PR could not be reached from what `pr` and `pr-context` print.** Both printed the full source commit and no base. A file the PR removes is not at the source commit, and `file --ref <source>` answered `check spelling and case`, which blames the path. `pr` and `pr-context` now print `Destination commit: <full sha>` (the API carries 12 characters; it is completed the way the source's is, `(abbreviated)` when it cannot be, no line when the PR records none), which reads the removed file and the old version of a changed one (live: it was the source commit's parent on a merged PR). The 404 hint for a missing path (`file`, `file-history`, `browse`, `get`) adds a second line: if the file was deleted at this ref, read it at a commit before the deletion. `file-history` of a removed file on `develop` fails; from the destination commit it lists its history.
- **A source branch deleted by the merge got hints that blamed spelling or a rewritten history.** Live, `feature/SSP-2668-…` of a merged PR (`close_source_branch`) no longer exists. `branch` said `Check workspace/repo/ref spelling`, `commits --branch` and `browse` `Use "branches" or "tags"`, `diffstat <name>..develop` the old-PR hint about a force-push. Every unresolved ref (`file`, `browse`, `commits --branch`, `file-history`) now adds `A branch is usually deleted when its PR is merged: find the PR with node bb.mjs prs <ws>/<repo> --state ALL --q 'source.branch.name="NAME"'` and use its source commit; `branch` says `No branch 'NAME' in <ws>/<repo>` with the same line (without credentials the private-repository hint stays); and a `diff`, `diffstat` or `merge-base` range that Bitbucket cannot resolve says `cannot find a ref or commit that 'a..b' needs` and gives the search for each end that is not a commit hash. The PR commands keep the old-PR hint.
- **`file --raw | grep`, the documented way to keep a file out of the conversation, could print far more than the matches.** On a generated GraphQL file two matching lines were about 4,000 characters each. SKILL.md now writes `| grep -n PATTERN | cut -c1-200` and says why.
- **A directory in `--path` read as a typo.** `pr-diff --path src/shared/hooks` printed `No changes found … matching --path …`, correct but not saying that `--path` takes files. A path with no extension now adds `--path matches file paths only, so a directory matches nothing`; SKILL.md says it too.
- Not changed, on purpose: run 10 issue 1 (`pipeline` hides `state.result.error.message`, with run 3 issue 1) and its two pipeline nits. CI for this repository is Jenkins, so Bitbucket Pipelines output is of no use here; the finding stays in the notes for a repository that uses them.
- Tests: 174 to 180 (the destination commit in `pr` and `pr-context`, the deleted-branch note on four commands and on `branch`, the range hint, the deleted-file line, and the directory `--path` note). The test server has a destination commit on PRs 7 and 8, a range with an end that is gone, and a directory path that matches nothing.

## 1.2.10 (2026-10-13)

Fixes from a ninth review run, on a different PR (#688, by another author; notes in `test-skill/otg-keycloak-ui-pr-688-review-run9.md`, issues 1-6):

- **A pasted URL that was not a PR URL failed vaguely, or was answered for the wrong place.** SKILL.md said to pass a URL through unchanged, but only PR URLs carry what a command needs. `commit <url>/commits/<sha>`, `file <url>/src/<ref>/<path>` and `branch <url>/branch/<name>` failed with `Expected 1 more argument(s) after the repository`, and `browse <url>/src/develop/src/shared/utils/` **listed the root of the default branch** (`@ master  /`), dropping the `develop` ref and the directory without a word. `parseRepoToken` now reads `/commits/<sha>` (also `/commit/`), `/branch/<name>` and `/commits/branch/<name>`, and `/src/<ref>/<path>` (also `/raw/`), and each command fills in what it is missing from them: `commit`, `commit-statuses`, `diff` and `diffstat` take the hash, `branch` the name, `file` and `browse` the ref and path, `file-history` both, `commits` the branch. An argument or `--ref` typed on the line wins. A part the command cannot use is reported on stderr (`Warning: the URL also names ref main and path two.txt, which repo does not use; only ws/repo was taken from it.`), so nothing is dropped silently. Each segment is decoded on its own, so a branch with a `/` (Bitbucket writes `%2F`) stays one ref; a ref written with a bare `/` cannot be told from the start of the path and is cut at the first segment, and when such a ref does not resolve the error says where it came from and to pass `--ref`. I could not fetch a page to see which form Bitbucket writes for a slash in a branch name; `%2F` is from memory of its URLs, so the note stays. PR URLs, plain `<ws>/<repo>` and a URL without a scheme (still refused) are unchanged.
- **`pr-activity` hid that someone pushed.** An update that changed nothing but the source branch printed only `state=OPEN title="…"`. Live, PR #688 went `fd587c1a` → `950a63cc` → `1e6de21d` and the text showed none of it (`pr-commits` lists only the last commit). Each update's source commit is now compared with the previous update's, by date (the list is not in strict time order), and a change prints as `source commit fd587c1a -> 950a63cc`; the oldest update in view has nothing to compare with and prints as before. This also fixes a latent fold: two pushes next to each other by the same author, with the same state and title, were taken for Bitbucket's duplicated opening update and shown as one line, so the key that decides what counts as a duplicate now includes the source commit.
- **`file` on a directory printed the raw listing as if it were a file** (`File: src/shared/utils @ develop (lines 1-1 of 1)` and one line of JSON: 9,924 characters where `browse` needs 442). A JSON listing from the `src` endpoint now ends in `src/shared/utils is a directory at ref 'develop', not a file. List it with: node bb.mjs browse <ws>/<repo> src/shared/utils --ref develop`. A file, and `browse` on either, are unchanged.
- **`user` was hard to use right and failed with the wrong hint.** `user "Ian Flory"` and `user "<nickname>"` answered `404 Not Found - Ian Flory` with the hint about workspace/repo/ref spelling, and `user` alone said only `Missing user.`. Live, an account id and a UUID in braces work and names do not (I did not try other username forms, so the usage no longer says "username"). The usage is now `user <account-id-or-uuid>`, a 404 on it says to use an id or a UUID, not a name, and how to read someone's id (`prs <ws>/<repo> --state ALL --select author.display_name,author.account_id`), and `Missing user.` carries the same line.
- **A `--q` on a person was easy to get wrong.** `author.display_name` and `reviewers.display_name` answered `400 … Field "user..display_name" does not support filtering` with no hint, and `author.nickname="Ian Flory"` returned `No pull requests found.` because that person's nickname is `Ian (Flo) Flory`; `author.account_id` found their 254 merged PRs. That 400 now has a hint (a display name is not filterable; use `author.account_id` or `reviewers.account_id`, read with `--select author.account_id`; the fields are in `references/bbql.md`), and an empty `prs` result for a `--q` on a nickname says the nickname can differ from the displayed name and to match on `author.account_id`. SKILL.md and `bbql.md` say the same.
- Nits: `search-code --extension ts,tsx` with no match no longer suggests `--extension ts,tsx` (it says every extension in the list was tried); SKILL.md notes that `file` and `browse` read the repository's default branch (`master` in the repository tried), which may not be the branch its PRs target, so pass `--ref`.
- Tests: 163 to 174 (URL parsing, what each command fills in from a URL, the ignored-part warning, the unresolved-ref note, pushes in `pr-activity`, `file` on a directory, `user`, the BBQL hint and note, and the extension note). The test server has a PR whose source commit changes twice in a row, a directory behind a file path, users, and the 400 on a display name.
- Not changed: run 6 issue 2 (the empty-range hint on a merge commit) and run 3 issue 1 (`pipeline` and the failure reason), still open.

## 1.2.9 (2026-10-13)

Fixes from an eighth review run of the same PR (notes in `test-skill/otg-keycloak-ui-pr-691-review-run8.md`, issues 1-5):

- **`file --raw` stopped at 1,000 lines without saying so, so the documented `--raw | grep` check could miss matches.** Live, a 1,455-line file gave 0 matches for a string that occurs 43 times (the first at line 1,196) over the default `--raw`; the numbered view had a "455 more lines" footer, the raw view nothing. `--raw` is for pipes, so it now starts from the 10,000-line maximum (the numbered view keeps its 1,000 default), and when lines are still left out (a longer file, or a smaller `--limit` you gave) it writes `Warning: --raw printed lines 1-1000 of 1455; 455 line(s) are not in this output, so a grep over it can miss matches. Add --limit 1455 to read to the end, or continue with --start 1001.` on **stderr**, so the piped stdout stays the file. Past 10,000 lines it says `--limit` is capped and to read the rest in pieces. A command result can now carry a `warn` text that `main` prints to stderr. SKILL.md says an empty grep proves nothing when that warning appears, and not to discard stderr on that command.
- **A PR whose commits no longer exist got the "PR id is the likeliest typo" hint although the PR was right there.** Live, an old PR (a 2024 `develop → qc` merge) loads with `pr`, but `pr-diff`, `pr-diffstat` and `pr-commits` answer `404 … The source or destination could not be found for spec: …` because the history was rewritten. That message now gets its own hint (the PR exists; a commit it points to is gone, typically after a force-push or a rewritten branch; `pr`, `pr-activity` and `pr-statuses` still work; read code with `file --ref <sha>` on a commit that still exists; for a range you typed, check both ends) and no longer the PR-id one. In `pr-context` the diffstat section shows the same error and hint, and the message's own trailing period is no longer doubled (`…20.. Hint:` is now `…20. Hint:`).
- **`pr-context` was slow on a huge PR and hid the real file count.** Live, a PR with 2,295 files took 35 s (20 sequential diffstat pages) and printed `2000 file(s) changed` with a warning that told the reader to pass `--max-pages N` without saying what N was. The API reports the total on the first page, so the headline now says `2295 file(s) changed; first 500 summed: +… -…`, and the briefing reads at most 5 pages (500 files; about 7 s instead of 35 s), since exact sums at that scale are of little use. The warning gives the whole command for the rest, with the page count worked out (`pr-diffstat <ws>/<repo> <id> --all --max-pages 23`; `--all` alone when it fits in the default 20 pages). A PR of up to 500 files reads exactly as before. `pr-diffstat` and `diffstat` say `first 100 file(s) of 2295 (more exist)` instead of leaving out the total.
- **No warning for a huge diff.** Live, a PR of 8 files made a 1,869,672-character diff (42,729 lines), almost all of it `package-lock.json` and `yarn.lock`. `diff` and `pr-diff` now print `Warning: large diff, N characters (L lines)` on stderr past 200,000 characters (about 50,000 tokens), naming lock files as the usual cause and the diffstat-then-`--path` workflow (or, when `--path` was already given, narrower paths and `--context`). The diff is still printed whole, on stdout; the warning is skipped when `--max-chars` is set.
- **`--max-chars` could cut an emoji in half**, leaving a lone surrogate that prints as `�` (U+FFFD). The head cut now drops a dangling high surrogate and the tail cut (used for `pipeline-step-log`, with `--max-chars` and `--tail`) a dangling low one, so the text can be one unit shorter than N. Checked with a string and a mock file, not live: no live file with such a character was found.
- Tests: 149 to 163 (the new `file --raw` limits and warnings, the commit-gone hint on all three commands and in `pr-context`, the diffstat cap and its headline, the large-diff warning with its skips, and the emoji cuts). The test server has files of any line count, an old PR with rewritten history, a PR with 2,295 files, and a 252,500-character diff.

## 1.2.8 (2026-10-13)

Fixes from a seventh review run of the same PR (notes in `test-skill/otg-keycloak-ui-pr-691-review-run7.md`, issues 1-4):

- **`prs --all` and `pr-activity --all` failed with `400 Invalid pagelen`, and the hint blamed `--page`.** Those two endpoints take at most 50 per page, not 100 (live: 50 works, 51 fails; I probed the other 16 list commands at 100 and 51 and all take 100; `pipeline-steps` was not probed). `--all` asked for 100 and so did `--pagelen 100`, and the 400 got the "opaque tokens, `--page N` is not supported" hint because its pattern, `invalid page`, also matches `Invalid pagelen`. The recommended workaround for an ignored `--q`/`--sort` on `pr-activity` ("fetch with `--all`") failed the same way. `def` has a new `maxPagelen` option, set to 50 for `prs` and `pr-activity`: `--all` now reads 50 per page there (so the default cap of 20 pages is 1,000 PRs), and `--pagelen 100` is clamped with a warning that names the command (`… maximum of 50 for prs; using 50`). Other commands are unchanged, with the old warning. `Invalid pagelen` now has its own hint (a page size the endpoint does not take; 50 is the limit on `prs` and `pr-activity`), which is what a raw `get …?pagelen=100` shows, and the `Invalid page` hint no longer matches it. `help` says `--pagelen (up to 50)` for the two commands and in the global flags.
- **Resolved review threads looked the same as open ones.** On PR #509, 5 of 11 comments are resolved, and `pr-comments`, `pr-comment`, `comment-thread`, `pr-context --full` and `pr-activity` showed no difference. A resolved comment carries a `resolution` key (`{}` in a list, a full object with the resolver and date from the single-comment endpoint), so the comment line now ends `[resolved]`, or `[resolved by NAME DATE]` where the response says who. `inline.outdated` is only in the single-comment endpoint, so `[outdated]` appears from `pr-comment` and for the root of `comment-thread`, not in lists. `--json` is unchanged. SKILL.md tells the review workflow to treat a resolved thread as done unless the user says otherwise.
- **Mentions were printed as raw account ids** (`@{712020:…}`), so a reader could not tell who was addressed, and the ids, which are personal identifiers, went into the transcript. The comment's HTML has `<span class="ap-mention" data-atlassian-id="ID">@Name</span>`, so the text view now writes `@Name` (HTML entities decoded) without another request. An id the HTML does not name, and a comment with no HTML, keep the raw text; `--json` keeps it too.
- SKILL.md says `pr-activity` is in Bitbucket's order, not strictly by the printed time (live: on #509 a comment created at 10:12 sits between the 11:59 and 11:58 entries; the printed time is the creation time), so a PR's story should be sorted by those times first.
- Tests: 145 to 149 (page-size cap, the `Invalid pagelen` hint, resolved and outdated markers, mentions). The test server now answers 400 `Invalid pagelen` above 50 on `prs` and on `pr-activity`, like the real endpoints.

## 1.2.7 (2026-10-13)

Fix from a sixth review run of the same PR (notes in `test-skill/otg-keycloak-ui-pr-691-review-run6.md`, issue 1):

- **`search-code --extension ts` silently left out `.tsx` files.** The filter is an exact match, and SKILL.md and `help` recommended `--extension ts` with no caveat. Live, on a React repo, `invalidateQueries` with `--extension ts` found only the test file, `tsx` only the component, and no filter found both, so a reviewer could conclude there was one caller when there were two. `--extension ts,tsx` (a comma list) now sends one `extension:` clause per entry. I checked first that this is what the index does with repeated clauses: `ts` plus `tsx` returned the union (1 + 1 = 2 files), `graphql`, `ts` and `tsx` together returned 6 (1 + 4 + 1), a repeated or unknown extension changed nothing, and `ts OR tsx` returned nothing, so the comma list is the only way to ask for two. A space inside an entry (`"ts tsx"`) is refused before any request, because it would add search terms to the query instead of another extension, and so is a value with no extension in it (`,`). Before, `--extension ts,tsx` returned `No code matches found.` with a note blaming the main-branch index.
- **An empty result with `--extension` set now says the filter is an exact match** (`ts` does not cover `tsx`, nor `js` `jsx`) and how to add more, before the existing branch-index note. The `--language` note now suggests `--extension ts,tsx` instead of `ts`. SKILL.md, `help search-code` and the README say the same, with a troubleshooting row.
- Tests: 143 to 145 (comma list, refusal, and the empty-result note). The test that pinned the `--language` note's old wording was updated.

## 1.2.6 (2026-10-13)

Fixes from a fifth review run of the same PR (notes in `test-skill/otg-keycloak-ui-pr-691-review-run5.md`, issues 1-4):

- **`--all --page N` quietly skipped the early pages.** Live, `branches --all --page 3` returned 124 entries under `Branches in … (324 total):`, with nothing saying the first 200 were missing. `--all` reads from the first page, so the combination has no sensible reading and is now refused, with what to do instead. Likewise **`--max-pages` without `--all`**, which was accepted and did nothing, is refused (`--max-pages only applies together with --all`). Each flag alone, and `--all` with `--max-pages`, work as before.
- The message for an ignored `--q`/`--sort` (1.2.5) recommended `--all` without its cost. It now says `--max-pages N` caps the number of requests, and for `commits` that a long history is slow (measured: about 2 s per 100 commits, 48 s for 1,959).
- **A command printed in a hint is quoted for the shell.** The `browse` suggestion for a missing path printed `browse ws/repo dir with space --ref x`, which splits into extra arguments if pasted. A directory or ref with a space or shell character is now single-quoted (`'dir with space'`), plain ones are left alone, and the `prs … --q '…'` command from `pr-context --branch` uses the same quoting, so an apostrophe in a branch name cannot break it.
- A timeout now has a hint: `Tried 3 times, 30000 ms each. For a slow network or a large response raise BITBUCKET_REQUEST_TIMEOUT …`. Before, only network errors had one.
- SKILL.md and the README note the cost of `--all` on long histories and the two refused combinations.
- Tests: 134 to 143. `shq` is exported for the tests.

## 1.2.5 (2026-10-13)

Fixes from a fourth review run of the same PR (notes in `test-skill/otg-keycloak-ui-pr-691-review-run4.md`, issues 1-4):

- **`--q` and `--sort` were silently ignored by several list commands.** Bitbucket accepts the parameter and returns the plain list with no error, even for a nonsense field, so `commits --q 'author.raw ~ "Ian"'` returned commits by someone else. I ran a filter that matches nothing against every list command and compared counts. **Ignored `--q`:** `commits`, `pr-commits`, `pr-activity`, `pr-diffstat`, `diffstat`, `pipelines`, `pipeline-steps`. **Ignored `--sort`:** `commits`, `pr-commits`, `pr-activity`, `pr-diffstat`, `diffstat`. Those commands now reject the flag before any request, say what to do instead (fetch with `--all` and `--select` and filter yourself; `--branch` or `file-history` for commits; `--path` for diffstats; `--sort` works on `pipelines` and `pipeline-steps`), and `help <command>` says which of the two each command takes. **Honoured, checked live:** `--q` on `repos`, `search-repos`, `branches`, `tags`, `prs`, `pr-comments`, `pr-statuses`, `commit-statuses`, `file-history`; `--sort` on `repos`, `search-repos`, `branches`, `tags`, `prs`, `pr-comments`, `file-history`, `pipelines`, `pipeline-steps`. **Not checkable here** (one result, so no visible order or filtering): `--sort` on `pr-statuses` and `commit-statuses`, and both flags on `workspaces`; they stay allowed. **This corrects the run 3 notes**, which said `commits` and `pr-commits` honour both. The tests use a new `ignores` option on `def`.
- **A mistyped boolean flag gave `--ful needs a value`** instead of `Unknown flag --ful. Did you mean --full?`, because the parser runs before the command is known and assumes any flag outside its boolean list takes a value. A flag that no command has is now reported as unknown with the nearest flag from all commands, at the end of the line or before another flag. A real value flag without a value (`--ref`, `--path`) still says it needs one.
- `search-code --language` with no matches now says the names are the index's own (live: `c#` matches 9 results on a C# repo, `csharp` none; case does not matter; no name matched a TypeScript repo) and suggests `--extension`, which does not have the problem. The note comes before the branch-index one, which would have blamed the wrong thing.
- `--pagelen` above 100 is clamped with a warning instead of silently. A bare repo name without `BITBUCKET_WORKSPACE` now says to set that variable.
- `help` is exported for the tests. Tests: 123 to 134.

## 1.2.4 (2026-10-13)

Fixes from a third review run of the same PR (notes in `test-skill/otg-keycloak-ui-pr-691-review-run3.md`, issues 2-6):

- **`file` and `browse` no longer download a huge or binary file to refuse it.** Live, `file` on a 97 MB committed binary took 15.7 s to say `looks like a binary file`. The body is now read as a stream: a NUL byte in the first 8000 bytes stops the download after the first chunk, and a file over the limit (10 MB, `BITBUCKET_MAX_FILE_BYTES` to change it, validated like the other numeric settings) is cancelled the same way. The notice carries the size when the server sends a Content-Length: `looks like a binary file (contains NUL bytes, 32.0 MB)`, or `is 32.0 MB, over the 10.0 MB limit, so it was not downloaded` with how to raise the limit. `--json` gets `binary`/`too_large`, `size` and `max_bytes`. Files under the limit read exactly as before, with no extra request. A test server that streams 32 MB with backpressure checks that the client really hangs up early.
- `browse <repo> .` and `./` list the repository root (before, `.` was rejected as an invalid path segment). A `.` anywhere else is still refused.
- An empty `diff` or `diffstat` of a `<source>..<dest>` range now says which way round Bitbucket reads it and prints the reverse range to try (`No changes found for empty..main in ws/repo. Bitbucket reads <source>..<dest> the reverse of git diff (what <source> has that <dest> lacks): if you expected changes, try "main..empty".`). A single commit and the PR commands get no such note.
- A 404 on a PR command (`pr`, `pr-comments`, `pr-comment`, `comment-thread`, `pr-diff`, `pr-context`, ...) now hints at the PR id first, the likeliest typo, before the workspace/repo spelling. Without credentials the private-repository hint is kept, and other commands keep the generic one.
- SKILL.md: the gotcha that slash-named branches in ranges "can be ambiguous" is loosened. Live, `bugfix/SSP-2715-...` and its sha gave identical results. SKILL.md and the README also say what `file` does with binary and huge files.
- Tests: 114 to 123.

## 1.2.3 (2026-10-13)

Fixes from a second review run of the same PR (notes in `test-skill/otg-keycloak-ui-pr-691-review-run2.md`):

- **`file-history` printed `unknown undefined`.** The live `filehistory` endpoint returns only `{ path, size, commit: { hash } }` per entry, with no message, author or date; the test mock had a richer shape, which hid it (the same cause as 1.2.1's `--page` fix). The command now looks up each commit (4 at a time) for the first 25 entries of a page and prints the usual message, author and date. An entry whose lookup fails, or that is past the 25th, shows its hash only, and a footer says so. `--json` and `--select` see the full commit objects. I first meant to switch to `commits/<ref>?path=`, which returns full commits, but checked it live: it does **not** follow renames (11 entries against 2 for a file renamed from `.ts` to `.tsx`), so the `filehistory` endpoint stays. An entry from before a rename shows `as <old path>`.
- `file-history` on a path that is not in the ref now gets the browse hint (live message `No such file: <path>`), like `file` and `browse` since 1.2.2.
- **`issues` and `issue` no longer work.** Every issue endpoint answers `410 Gone - CHANGE-3071 - Functionality has been deprecated`, including on repos with `has_issues: false`. Bitbucket's changelog (20 Aug 2026, "Removal of native Bitbucket Cloud Issue tracker", which links CHANGE-3071) says the issue endpoints are fully removed. The commands stay (an account could still see something other than 410), but the error now says what happened and points to Jira. Any other `410` gets a generic hint with the changelog link. SKILL.md, the README and the tool map say the issue commands are gone, and "issues" is gone from the skill's description, so it no longer triggers on them.
- `pr-context --branch` with no open PR says that merged, declined and superseded PRs are not searched and prints the ready `prs <ws>/<repo> --state ALL --q 'source.branch.name="<branch>"'` command (it found the merged PR #691 first time).
- A `--path` that matches nothing is named in the empty result of `diff`, `diffstat`, `pr-diff` and `pr-diffstat` (`No changes found for PR #691 matching --path src/nope.ts. Check the paths against pr-diffstat without --path.`), so a mistyped path no longer reads as an empty change. Without `--path` the wording is as before, except `pr-diff` now says `No changes found for PR #n.` (was `in PR #n`).
- The `--select` warning explains the common slip on a list command: `values.full_name` should be `full_name`, because paths apply to each item.
- SKILL.md: pipe `file --raw` into `grep` to check a symbol at a ref without reading the whole file (there is no repo-wide search at a ref); prefer `author.user.display_name` over `author.raw`, which is `Name <email>`.
- Tests: 103 to 114 (the `file-history` mock now has the live shape, with a renamed entry, a failing lookup and a 27-entry page for the cap).

## 1.2.2 (2026-10-13)

Fixes from using 1.2.1 on a second PR (notes in `test-skill/otg-keycloak-ui-pr-691-review-run1.md`):

- `help pr-diff` and `help pr-diffstat` show `--path FILE[,FILE]` and say the value can be a comma-separated list (it already could be; `help` said `FILE`). `help` for a PR command says that the PR URL can replace `<ws>/<repo> <id>`, and the full command list says so once. SKILL.md, the README and the tool map show the list form for `pr-diff`.
- A 404 that says `No such file or directory` no longer gets the hint about workspace/repo/ref spelling. Live, the src endpoint gives that message only when the ref exists and the path does not (a wrong ref gives `Commit not found`). `file` and `browse` now print the `browse` command for the path's directory at that ref; `get` gives the same advice with placeholders.
- `search-code` with no matches now explains why, instead of only `No code matches found.`. The index may cover only each repository's main branch, and code search may be off. It points to `file --ref` and `pr-diff`. Live, code that was only on `develop` was not found, while older code on `master` (the main branch) was. SKILL.md says the same.
- `pr-activity` prints the PR state next to Bitbucket's internal status words: `status open -> fulfilled (merged)`, `open -> rejected (declined)`. Both words were seen live. `--json` is unchanged.
- The test file's header said to run `node --test tests/`, which fails on Node 24 (a directory argument is treated as a test file). It now says `node --test` or `npm test`, like the README.
- Tests: 99 to 103.

## 1.2.1 (2026-10-13)

Fixes from using 1.2.0 on a real PR (notes in `test-skill/PR-239-review.md`):

- `pr` and `pr-context` print the **full 40-character** source commit sha. The PR object carries only a 12-character hash (no other field has the full one). That value does work as `--ref`, but each `file`/`browse` call then spent two extra lookups (branch, tag) before finding the commit. If the full sha cannot be looked up, the line says `(abbreviated)`.
- `pr-context` prints `Approved by:` (`none` when nobody has) and, when applicable, `Changes requested by:`. Before, a briefing gave no sign of review state. `pr` no longer prints an approval twice (`(approved) [approved]`).
- `pr-activity` folds adjacent updates that changed nothing and agree on author, state and title. Bitbucket records the opening of every PR as two identical updates 0.1 s apart; they now show as one line marked `(listed 2 times by Bitbucket)`. `--json` is unchanged.
- **Fix to 1.2.0's L18:** `--page N` does not work on directory listings, `pr-commits` or `file-history`: Bitbucket pages them with opaque tokens (`page=ByUK`) and answers a number with `400 Invalid page`. The "more results" footer now takes its advice from the real `next` link (`--page N` only when that link has a number, otherwise `--all` or `--pagelen`), and a `400 Invalid page` gets a hint. `browse` no longer advertises `--page`.
- SKILL.md says that `search-code` is index-based, that Atlassian does not document which branches the index covers, and that it must not be used to learn what an unmerged PR changes.
- Live checks done against real Bitbucket, read-only: the M6 range order and `--two-dot` (`topic=false`), comma-separated `--path` on `pr-diff` and `diffstat`, and `--q` on `state` (it does override the default OPEN filter, so L19's four-state workaround is harmless but was not needed). See the review's Resolution section.
- Tests: 93 to 99.

## 1.2.0 (2026-10-13)

Fixes from [docs/reviews/codebase-review.md](docs/reviews/codebase-review.md) (reviewed at `92850ef`). Nothing was run against live Bitbucket; see the review's "Resolution" section for what still needs a live check.

Security:

- **M5.** `BITBUCKET_API_BASE` is limited to `https://api.bitbucket.org` (plus loopback, for tests). Any other host, a non-HTTPS URL or a URL with a user name or password is refused before any request, so an injected `BITBUCKET_API_BASE=https://attacker.example` cannot collect the token. Credentials are also refused while `NODE_TLS_REJECT_UNAUTHORIZED=0`. `check` validates the base before printing it.
- **M1.** `get` refuses endpoints that can hold secrets: webhooks, deploy keys, SSH keys, pipeline variables (repository, workspace, deployment), access tokens and account emails. The path is decoded and dot-collapsed first, so `%68ooks`, `%2e%2e` and full URLs are covered.

Wrong answers made visible:

- **M6.** `diff`/`diffstat` document Bitbucket's range order, which is the reverse of `git diff` (`feature..main` is what `feature` adds to `main`), in `help`, SKILL.md, the README and the tool map. Usage now names the parts `<source>..<dest>`. **Breaking:** `--topic`, which sent the default value and did nothing, is replaced by `--two-dot` (sends `topic=false`: compare the two tips directly). `--topic` is rejected with a message saying so. `--two-dot` on a single commit is an error.
- **L13.** `--select` maps through arrays (`reviewers.display_name` returns a list), shows absent fields as `null`, and warns on stderr when a path matched nothing.
- **L14.** A path rewritten by Git Bash (`C:/Program Files/Git/...`) is explained, not sent, for `file`, `browse`, `file-history` and `--path` on `diff`, `diffstat`, `pr-diff` and `pr-diffstat`. Leading slashes are stripped from those paths.
- **L15.** A diffstat that shows only the first page says so in its headline ("first 100 file(s) (more exist), +a -b so far").
- **L16.** `git@bitbucket.org:ws/repo.git`, `ssh://git@bitbucket.org/ws/repo.git` and `.git` suffixes work as the repository. A malformed PR id in a URL (`pull-requests/12abc`) is named in the error.
- **L17.** `pr-context` rejects an id together with `--branch` instead of ignoring `--branch`.
- **L18.** `browse` takes `--page`, `--pagelen` and `--all` and prints the usual "more results" footer, so a directory of more than 100 entries can be read. `--limit` now means lines of a file only; for a directory it is an error that points to `--pagelen`.
- **L19.** `prs --state` takes a comma-separated list or `ALL` (sent as a repeated parameter). A `--q` that filters on `state` now sends every state explicitly, so the result does not depend on how Bitbucket combines it with its default OPEN filter.
- **L20.** `--max-chars` and `--select` are validated before the request, not after. An empty `--select` or `--max-chars` is an error.

Smaller:

- A flag given twice (`--path a --path b`) is an error instead of keeping the last value. `--path` takes a comma-separated list on the four diff commands (sent as a repeated parameter).
- `commit` tolerates a missing message. `search-code` prints a line covered by two matches once. The tool map lists `search-code --files`.
- `BITBUCKET_RETRY_BASE_MS` (undocumented in the README on purpose) sets the first retry delay, so tests do not sit through real backoff.
- The version in `bb.mjs`, `package.json`, the README and this file is checked by a test.

Tests: 46 to 93. New coverage: retries (5xx backoff, 429 with a short and an over-long `Retry-After`), dropped connections, timeouts, HTML instead of JSON, `--all` over several pages and the `--max-pages` footer, `comment-thread` replies and its page cap, `--select` and `--max-chars`, `Authorization` sent to the API origin, a bare repo name with `BITBUCKET_WORKSPACE`, and one test per finding above.

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

Documentation audit of README.md and SKILL.md against `bb.mjs`:

- SKILL.md tells Claude to treat fetched PR, comment, issue, file and log content as untrusted data, and not to use `get` for secret-bearing configuration (M2). The `get` examples in SKILL.md and `help` now use `default-reviewers` instead of `hooks` (part of M1). The `get` denylist is not implemented yet.
- Added the commands the docs omitted (`repo`, `repos`, `pr-comment`, `pr-commits`, `pipeline`, `diffstat`, `branch`, `tag`, `check`) and the `diff`/`diffstat` flags `--ignore-whitespace` and `--topic`.
- Corrected page-size, `--json`, `--max-chars`, `BITBUCKET_WORKSPACE`, proxy and `NODE_USE_SYSTEM_CA` statements.

Fixes found while test-reviewing a real PR:

- `search-code` prints snippet text verbatim. It used to wrap matched terms in `[[...]]`, which made snippets look like altered source. Matching lines are now marked with `>` in the gutter, lines the index left out are shown as `...`, and a footer says snippets can be incomplete.
- `search-code` has a `--files` flag (paths and match counts only). When an unquoted query contains spaces, `-`, `.`, `:` or `/`, the output reminds that words are matched separately and shows the quoted form for an exact match.
- `pr-activity` says what each update changed (status, reviewers added or removed, other fields by name) instead of only the PR state. The entry written when a PR is opened still shows state and title.
- `pr-commits` labels merge commits `(merge commit)`, so a merged PR's merge commit is not mistaken for its source commit.
- `pr-context` prints the source commit sha, which the review workflow uses as `--ref`. With `--full` it always prints the description section, showing `(none)` when the description is empty.

## 1.0.0

Initial release.
