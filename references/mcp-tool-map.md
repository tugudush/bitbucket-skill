# bitbucket-mcp tool → bb.mjs command

`bb` = `node "<skill-base-dir>/scripts/bb.mjs"`. Repo-scoped commands take `<ws>/<repo>` (or a Bitbucket URL) first.

| MCP tool | Command |
|---|---|
| `bb_list_workspaces` | `bb workspaces` |
| `bb_get_workspace` | `bb workspace <ws>` |
| `bb_list_repositories` | `bb repos <ws>` |
| `bb_get_repository` | `bb repo <ws>/<repo>` |
| `bb_search_repositories` | `bb search-repos <ws> <query> [--sort -updated_on]` |
| `bb_browse_repository` | `bb browse <ws>/<repo> [path] [--ref R] [--pagelen N] [--all]` (`--limit` is lines, for a file) |
| `bb_get_file_content` | `bb file <ws>/<repo> <path> [--ref R] [--start N] [--limit N] [--raw]` (`--raw` is plain text for pipes: it reads up to 10,000 lines by default and warns on stderr if some are left out) |
| `bb_get_file_history` | `bb file-history <ws>/<repo> <commit-or-branch> <path>` (follows renames; message, author and date are looked up for the first 25 entries) |
| `bb_get_pull_requests` | `bb prs <ws>/<repo> [--state OPEN\|MERGED\|DECLINED\|SUPERSEDED\|ALL]` (open only when `--state` is omitted and `--q` does not mention `state`; several states as a comma-separated list) |
| `bb_get_pull_request` | `bb pr <ws>/<repo> <id>` or `bb pr <url>` |
| `bb_get_pull_request_comments` | `bb pr-comments <ws>/<repo> <id> [--all]` |
| `bb_get_pull_request_comment` | `bb pr-comment <ws>/<repo> <id> <comment-id>` |
| `bb_get_comment_thread` | `bb comment-thread <ws>/<repo> <id> <comment-id>` |
| `bb_get_pull_request_activity` | `bb pr-activity <ws>/<repo> <id>` |
| `bb_get_pull_request_diff` | `bb pr-diff <ws>/<repo> <id> [--path F[,F]] [--context N]` |
| `bb_get_pull_request_diffstat` | `bb pr-diffstat <ws>/<repo> <id> [--path F[,F]]` |
| `bb_get_pr_commits` | `bb pr-commits <ws>/<repo> <id>` |
| `bb_get_pr_statuses` | `bb pr-statuses <ws>/<repo> <id>` |
| `bb_get_context` | `bb pr-context <url \| ws/repo id \| ws/repo --branch B> [--full]` |
| `bb_get_branches` | `bb branches <ws>/<repo>` |
| `bb_get_branch` | `bb branch <ws>/<repo> <name>` |
| `bb_get_commits` | `bb commits <ws>/<repo> [--branch B]` |
| `bb_get_commit` | `bb commit <ws>/<repo> <hash>` |
| `bb_get_commit_statuses` | `bb commit-statuses <ws>/<repo> <hash>` |
| `bb_get_merge_base` | `bb merge-base <ws>/<repo> <a>..<b>` |
| `bb_get_tags` | `bb tags <ws>/<repo>` |
| `bb_get_tag` | `bb tag <ws>/<repo> <name>` |
| `bb_get_diff` | `bb diff <ws>/<repo> <hash>\|<source>..<dest> [--path F[,F]] [--context N] [--ignore-whitespace] [--two-dot]` (range order is Bitbucket's, the reverse of `git diff`: `feature..main` = what `feature` adds to `main`; `--two-dot` replaces `--topic`, which was a no-op) |
| `bb_get_diffstat` | `bb diffstat <ws>/<repo> <hash>\|<source>..<dest> [--path F[,F]] [--ignore-whitespace] [--two-dot]` (same range order) |
| `bb_list_pipelines` | `bb pipelines <ws>/<repo>` |
| `bb_get_pipeline` | `bb pipeline <ws>/<repo> <uuid>` |
| `bb_get_pipeline_steps` | `bb pipeline-steps <ws>/<repo> <uuid>` |
| `bb_get_pipeline_step_log` | `bb pipeline-step-log <ws>/<repo> <pipeline-uuid> <step-uuid> [--tail CHARS]` |
| `bb_get_issues` | `bb issues <ws>/<repo> [--state S] [--kind K]` (**no longer works**: Bitbucket removed its issue tracker, 410 Gone) |
| `bb_get_issue` | `bb issue <ws>/<repo> <id>` (**no longer works**, same reason) |
| `bb_search_code` | `bb search-code <ws> <query> [--repo R] [--language L] [--extension E] [--files]` |
| `bb_get_user` | `bb user <account-id-or-uuid>` (a name or nickname does not work) |
| `bb_get_current_user` | `bb me` |

Differences from the MCP:

- `output_format=json` → `--json`; `output_format=toon` has no equivalent (use `--select` to keep output small); `filter` (JMESPath) → `--select` (dotted field list) and `--q` (server-side).
- `--all` follows pagination on every list command (up to 20 pages, `--max-pages N` to raise it); the MCP only did that internally for comment threads. Non-list commands reject it.
- Issue `state`/`kind` filters are sent as a proper `q` query (the MCP sent them as plain parameters, which Bitbucket ignores).
- New: `check` (verify setup), `get` (generic read-only GET for any other v2.0 endpoint), `--q`/`--sort` on list commands.
- Comment output includes comment ids and reply links, which the MCP text view omitted.
