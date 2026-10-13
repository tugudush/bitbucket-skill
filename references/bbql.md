# Bitbucket query language (BBQL) for `--q` and `--sort`

`--q` is passed to Bitbucket as the `q` parameter on list endpoints, so filtering happens on the server and you don't page through everything. Quote string values with double quotes; wrap the whole expression in single quotes in the shell.

**Which commands take it** (checked live with a filter that matches nothing): `repos`, `search-repos`, `branches`, `tags`, `prs`, `pr-comments`, `pr-statuses`, `commit-statuses` and `file-history` honour `--q`. Bitbucket accepts but silently ignores it on `commits`, `pr-commits`, `pr-activity`, `pr-diffstat`, `diffstat`, `pipelines` and `pipeline-steps`, so those commands reject it rather than return an unfiltered list. `--sort` is honoured everywhere `--q` is plus `pipelines` and `pipeline-steps` (not checkable on `pr-statuses`, `commit-statuses` and `workspaces`, which return one result), and ignored by `commits`, `pr-commits`, `pr-activity`, `pr-diffstat` and `diffstat`.

## Operators

`=`, `!=`, `>`, `>=`, `<`, `<=` · `~` (contains, case-insensitive) · `!~` (doesn't contain) · `AND`, `OR`, `NOT` · `field = null` / `field != null`. Parentheses group.

## Examples

```bash
# Open PRs by one author, newest activity first
bb prs acme/webapp --q 'author.nickname="dana"' --state OPEN --sort -updated_on

# PRs whose title mentions an SSP ticket
bb prs acme/webapp --state MERGED --q 'title ~ "SSP-2715"' --all

# PR for a given source branch
bb prs acme/webapp --q 'source.branch.name="bugfix/SSP-2715-federation"'

# Repos updated recently
bb repos acme --q 'updated_on > 2026-09-01T00:00:00+00:00' --sort -updated_on

# Branches matching a ticket key
bb branches acme/webapp --q 'name ~ "SSP-2715"'

# Latest tags first
bb tags acme/webapp --sort -target.date

```

## Common filterable fields

- Pull requests: `state`, `title`, `description`, `author.nickname`, `author.account_id`, `source.branch.name`, `destination.branch.name`, `created_on`, `updated_on`, `reviewers.account_id`. For a person use `account_id` (read it with `--select author.account_id`): `author.display_name` and `reviewers.display_name` answer `400 … does not support filtering`, and `author.nickname` is not the name shown in the output (live: `Ian (Flo) Flory` against `Ian Flory`), so a nickname typed from the output can match nothing
- Repositories: `name`, `description`, `language`, `is_private`, `created_on`, `updated_on`
- Branches/tags: `name`, `target.date`
- Issues: `state`, `kind`, `priority`, `title`, `reporter.nickname`, `assignee.nickname` (the issue tracker has been removed, so `bb issues` answers 410 Gone and these fields cannot be queried any more)
- Pipelines: sort with `-created_on` (already the default in `pipelines`)

Sort fields take a `-` prefix for descending. If a field isn't supported for an endpoint Bitbucket answers 400 with an explanation; read it and adjust rather than guessing repeatedly. For anything BBQL can't express, fetch with `--select` to trim fields and filter the small result yourself.
