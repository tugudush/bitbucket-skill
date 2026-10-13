#!/usr/bin/env node
/**
 * bb.mjs — read-only Bitbucket Cloud CLI (no dependencies, Node 18+).
 *
 * Skill-based replacement for the bitbucket-mcp server: same endpoints, same
 * read-only guarantee (only HTTP GET is ever issued), credentials come from the
 * environment and are never printed.
 *
 *   BITBUCKET_EMAIL, BITBUCKET_API_TOKEN   Atlassian email + API token (Basic auth)
 *   BITBUCKET_WORKSPACE                    optional default workspace
 *   BITBUCKET_API_BASE                     optional, default https://api.bitbucket.org/2.0
 *   BITBUCKET_REQUEST_TIMEOUT              optional, ms, default 30000
 *
 * Run `node bb.mjs help` for the command list.
 */

const BASE = (process.env.BITBUCKET_API_BASE || 'https://api.bitbucket.org/2.0').replace(/\/+$/, '');
const TIMEOUT = Number(process.env.BITBUCKET_REQUEST_TIMEOUT) || 30000;
const RETRIES = 3;
const MAX_PAGELEN = 100;
const UA = 'bitbucket-cloud-skill/1.0';

// ---------------------------------------------------------------- utilities

class CliError extends Error {}
const die = msg => {
  throw new CliError(msg);
};

const BOOLEAN_FLAGS = new Set(['json', 'all', 'full', 'raw', 'ignore-whitespace', 'topic', 'help']);

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let val = eq === -1 ? undefined : a.slice(eq + 1);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = val === undefined ? true : val !== 'false';
      } else {
        if (val === undefined) {
          val = argv[++i];
          if (val === undefined) die(`--${key} needs a value`);
        }
        flags[key] = val;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

const num = v => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) die(`Expected a number, got "${v}"`);
  return n;
};

const enc = encodeURIComponent;
const encPath = p => p.split('/').map(enc).join('/');
const braces = u => (u.startsWith('{') && u.endsWith('}') ? u : `{${u}}`);
const first = s => (s || '').split('\n')[0];
const short = h => (h || '').slice(0, 8);
const who = u => u?.display_name || u?.nickname || u?.raw || 'unknown';
const commitAuthor = c => c?.author?.user?.display_name || c?.author?.raw || 'unknown';

function buildUrl(path, params = {}) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// ---------------------------------------------------------------- HTTP (GET only)

function authHeaders() {
  const email = process.env.BITBUCKET_EMAIL;
  const token = process.env.BITBUCKET_API_TOKEN;
  if (!email || !token) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64') };
}

const hasCreds = () => Boolean(process.env.BITBUCKET_EMAIL && process.env.BITBUCKET_API_TOKEN);

// Credentials are only ever sent to the configured API origin.
function assertAllowedUrl(url) {
  if (new URL(url).origin !== new URL(BASE).origin) {
    die(`Refusing to call ${new URL(url).origin}: only ${new URL(BASE).origin} is allowed.`);
  }
}

class ApiError extends Error {
  constructor(status, statusText, detail, url) {
    super(`Bitbucket API error: ${status} ${statusText}${detail ? ` - ${detail}` : ''}`);
    this.status = status;
    this.detail = detail;
    this.url = url;
  }
}

function explain(status) {
  switch (status) {
    case 401:
      return hasCreds()
        ? 'Credentials were rejected. The API token may be expired or lack Bitbucket read scopes.'
        : 'No credentials configured: set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN in the environment (outside the chat).';
    case 403:
      return 'Access denied. The token may be missing a read scope (repository, pullrequest, pipeline, issue) or you lack access to this resource.';
    case 404:
      return hasCreds()
        ? 'Not found. Check workspace/repo/ref spelling and that your account can see it.'
        : 'Not found. Private repositories look like 404 without credentials; set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN.';
    case 429:
      return 'Rate limited by Bitbucket. Wait a bit and retry with fewer or narrower requests.';
    default:
      return '';
  }
}

/** A DNS, TLS, connection or proxy failure below HTTP (fetch threw before or while reading a response). */
class NetworkError extends Error {
  constructor(message, code, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

// Failures that usually clear up on their own; everything else (DNS not found, bad certificate) is not retried.
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
const proxyConfigured = () => PROXY_VARS.some(v => process.env[v]);
const proxyIgnored = () => proxyConfigured() && !['1', 'true'].includes(process.env.NODE_USE_ENV_PROXY);

/** Underlying error behind fetch's generic "fetch failed" TypeError (may sit inside an AggregateError). */
function rootCause(e) {
  let c = e.cause ?? e;
  while (c.cause && !c.code) c = c.cause;
  if (Array.isArray(c.errors) && c.errors.length) c = c.errors[0];
  return c;
}

function networkHint(code) {
  const hints = [];
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    hints.push('DNS lookup failed. Check the network connection and BITBUCKET_API_BASE.');
  } else if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code || '')) {
    hints.push('TLS certificate was not trusted, typically a corporate TLS-inspecting proxy. Set NODE_EXTRA_CA_CERTS to the company CA file (or NODE_USE_SYSTEM_CA=1) in the environment.');
  }
  if (proxyIgnored()) {
    hints.push('A proxy variable is set but Node ignores it unless NODE_USE_ENV_PROXY=1 is also set in the environment.');
  } else if (!hints.length) {
    hints.push('Check connectivity, firewall and proxy settings (Node needs NODE_USE_ENV_PROXY=1 plus HTTPS_PROXY to use a proxy).');
  }
  return hints.join(' ');
}

function toNetworkError(e, url) {
  const c = rootCause(e);
  const code = c.code || e.code;
  const reason = [code, c.message && c.message !== e.message ? c.message : ''].filter(Boolean).join(': ');
  const host = new URL(url).host;
  return new NetworkError(`Network error contacting ${host}: ${reason || e.message}`, code, networkHint(code));
}

/** Hint line for any error that has one, or ''. */
const hintFor = e => (e instanceof NetworkError ? e.hint : explain(e.status));

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Low-level GET with timeout + retry on 429/5xx and transient network errors. Returns { body, contentType }. */
async function rawGet(url, accept = 'application/json') {
  assertAllowedUrl(url);
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'GET', // read-only by construction: no other method is ever used
        redirect: 'follow',
        headers: { Accept: accept, 'User-Agent': UA, ...authHeaders() },
        signal: ctrl.signal,
      });
      // Timer stays armed until the body is fully read, so a stalled body aborts too.
      const body = await res.text();
      if (!res.ok) {
        let detail = body.slice(0, 300);
        try {
          const j = JSON.parse(body);
          detail = j.error?.message ? j.error.message + (j.error.detail ? ` (${j.error.detail})` : '') : j.message || detail;
        } catch {
          /* keep raw text */
        }
        const err = new ApiError(res.status, res.statusText, detail, url);
        if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
          lastErr = err;
          await sleep(2 ** (attempt - 1) * 1000);
          continue;
        }
        throw err;
      }
      return { body, contentType: res.headers.get('content-type') || '' };
    } catch (e) {
      if (e.name === 'AbortError') {
        lastErr = new Error(`Request timed out after ${TIMEOUT}ms: ${url}`);
        if (attempt < RETRIES) {
          await sleep(2 ** (attempt - 1) * 1000);
          continue;
        }
        throw lastErr;
      }
      if (e instanceof ApiError || !e.cause) throw e;
      lastErr = toNetworkError(e, url);
      if (TRANSIENT_NET_CODES.has(lastErr.code) && attempt < RETRIES) {
        await sleep(2 ** (attempt - 1) * 1000);
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('Request failed');
}

const getJson = async url => JSON.parse((await rawGet(url)).body);
const getText = async url => (await rawGet(url, 'text/plain')).body;

/** One page, or every page with --all (capped), of a list endpoint. */
async function getList(ctx, path, params = {}) {
  const { flags } = ctx;
  const all = Boolean(flags.all);
  const page = num(flags.page);
  const pagelen = num(flags.pagelen) ?? params.pagelen ?? (all ? MAX_PAGELEN : undefined);
  const extra = { ...params, pagelen: pagelen && Math.min(pagelen, MAX_PAGELEN), page };
  if (flags.q) extra.q = extra.q ? `(${extra.q}) AND (${flags.q})` : flags.q;
  if (flags.sort) extra.sort = flags.sort;
  let url = buildUrl(path, extra);
  if (!all) return getJson(url);
  const maxPages = num(flags['max-pages']) ?? 20;
  const values = [];
  let size;
  let pages = 0;
  while (url && pages < maxPages) {
    const r = await getJson(url);
    values.push(...(r.values || []));
    size = r.size ?? size;
    url = r.next;
    pages++;
  }
  return { values, size: size ?? values.length, ...(url ? { next: url, truncated: true } : {}) };
}

// ---------------------------------------------------------------- targets

function parseRepoToken(tok) {
  if (!tok) die('Missing repository. Use <workspace>/<repo> (or set BITBUCKET_WORKSPACE and pass just <repo>).');
  if (/^https?:\/\//.test(tok)) {
    const u = new URL(tok);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) die(`Cannot find workspace/repo in URL: ${tok}`);
    const out = { ws: parts[0], repo: parts[1] };
    const i = parts.indexOf('pull-requests');
    if (i !== -1 && parts[i + 1]) out.prId = Number(parts[i + 1]);
    return out;
  }
  const parts = tok.split('/').filter(Boolean);
  if (parts.length === 2) return { ws: parts[0], repo: parts[1] };
  if (parts.length === 1 && process.env.BITBUCKET_WORKSPACE) return { ws: process.env.BITBUCKET_WORKSPACE, repo: parts[0] };
  return die(`Cannot parse repository "${tok}". Use <workspace>/<repo> or a Bitbucket URL.`);
}

/** Resolve "<target> [rest...]" for repo-scoped commands. */
function repoCtx(ctx, needs = 0) {
  const t = parseRepoToken(ctx.pos[0]);
  const rest = ctx.pos.slice(1);
  if (rest.length < needs) die(`Expected ${needs} more argument(s) after the repository. See: node bb.mjs help ${ctx.cmd}`);
  return { ...t, rest, base: `/repositories/${enc(t.ws)}/${enc(t.repo)}` };
}

/** PR commands accept "<ws>/<repo> <id>" or a PR URL. */
function prCtx(ctx, extra = 0) {
  const t = repoCtx(ctx, 0);
  let id = t.prId;
  let rest = t.rest;
  if (id === undefined) {
    id = num(rest[0]);
    rest = rest.slice(1);
  }
  if (!id) die('Missing pull request id (pass "<ws>/<repo> <id>" or the PR URL).');
  if (rest.length < extra) die(`Missing argument. See: node bb.mjs help ${ctx.cmd}`);
  return { ...t, id, rest, pr: `${t.base}/pullrequests/${id}` };
}

// ---------------------------------------------------------------- ref resolution

const isNotFound = e => e instanceof ApiError && e.status === 404;

async function defaultBranch(base) {
  try {
    const r = await getJson(buildUrl(base));
    return r.mainbranch?.name || 'main';
  } catch {
    return 'main';
  }
}

/** branch -> tag -> commit, suppressing only 404s (names with "/" only work this way). */
async function resolveRef(base, ref) {
  for (const p of [`${base}/refs/branches/${enc(ref)}`, `${base}/refs/tags/${enc(ref)}`, `${base}/commit/${enc(ref)}`]) {
    try {
      const r = await getJson(buildUrl(p));
      const h = r?.target?.hash || r?.hash;
      if (h) return h;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  return null;
}

// ---------------------------------------------------------------- formatters

const listHeader = (title, r) => `${title} (${r.size ?? r.values.length} total):\n`;
function pageNote(r, ctx) {
  if (r.truncated) return '\n(stopped at --max-pages; more results exist — raise --max-pages or narrow with --q)';
  if (r.next) return `\n(more results — rerun with --page ${(num(ctx.flags.page) || 1) + 1} or --all)`;
  return '';
}
const none = what => `No ${what} found.`;

function statusLines(values) {
  return values
    .map(s => `- ${s.state}  ${s.name || s.key}${s.description ? ` — ${s.description}` : ''}${s.url ? `\n    ${s.url}` : ''}`)
    .join('\n');
}

function diffstatText(label, r) {
  if (!r.values?.length) return `No changes found for ${label}.`;
  const added = r.values.reduce((s, e) => s + e.lines_added, 0);
  const removed = r.values.reduce((s, e) => s + e.lines_removed, 0);
  const lines = r.values.map(e => {
    const st = (e.status || '').toUpperCase();
    return e.status === 'renamed'
      ? `  ${st}: ${e.old?.path} -> ${e.new?.path}  (+${e.lines_added} -${e.lines_removed})`
      : `  ${st}: ${e.new?.path || e.old?.path}  (+${e.lines_added} -${e.lines_removed})`;
  });
  return `Diffstat for ${label}: ${r.values.length} file(s), +${added} -${removed}\n\n${lines.join('\n')}`;
}

function commentLine(c) {
  const where = c.inline ? ` [${c.inline.path}:${c.inline.to ?? c.inline.from ?? '?'}]` : '';
  const reply = c.parent ? ` (reply to #${c.parent.id})` : '';
  const del = c.deleted ? ' [deleted]' : '';
  return `#${c.id} ${who(c.user)} ${c.created_on}${where}${reply}${del}\n  ${(c.content?.raw || '(no content)').split('\n').join('\n  ')}`;
}

function pipelineState(s) {
  return s?.result?.name || s?.stage?.name || s?.name || 'UNKNOWN';
}
function duration(sec) {
  if (sec == null) return 'n/a';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m ${sec % 60}s`;
}

// ---------------------------------------------------------------- commands
// Each command: { usage, summary, run(ctx) -> { data, text } }

const C = {};
const def = (name, usage, summary, run) => (C[name] = { usage, summary, run });

// --- setup / meta
def('check', 'check', 'Verify configuration and credentials (never prints secrets)', async () => {
  const lines = [
    `API base: ${BASE}`,
    `BITBUCKET_EMAIL: ${process.env.BITBUCKET_EMAIL ? 'set' : 'NOT SET'}`,
    `BITBUCKET_API_TOKEN: ${process.env.BITBUCKET_API_TOKEN ? 'set' : 'NOT SET'}`,
    `BITBUCKET_WORKSPACE: ${process.env.BITBUCKET_WORKSPACE || '(not set)'}`,
    `Proxy: ${proxyConfigured() ? (proxyIgnored() ? 'HTTPS_PROXY/HTTP_PROXY set but NODE_USE_ENV_PROXY=1 is missing, so Node ignores it' : 'set and honoured') : 'none configured'}`,
  ];
  if (!hasCreds()) {
    lines.push('', 'No credentials: only public repositories are reachable. Set the two variables in your OS/user environment (not in chat), then open a new terminal.');
    return { data: { authenticated: false }, text: lines.join('\n') };
  }
  try {
    const u = await getJson(buildUrl('/user'));
    lines.push('', `Authenticated as: ${who(u)} (${u.account_id || u.uuid || 'id unavailable'})`);
    return { data: { authenticated: true, user: u }, text: lines.join('\n') };
  } catch (e) {
    lines.push('', `Auth check failed: ${e.message}`, hintFor(e));
    return { data: { authenticated: false }, text: lines.join('\n') };
  }
});

def('get', 'get <api-path-or-url>', 'Generic read-only GET for any v2.0 endpoint not covered below, e.g. get repositories/ws/repo/hooks (no leading slash: Git Bash on Windows rewrites it). JSON or text is auto-detected.', async ctx => {
  const target = ctx.pos[0] || die('Missing API path or URL.');
  if (/^[A-Za-z]:[\\/]/.test(target)) die('That path looks like it was rewritten by Git Bash (MSYS). Pass it without a leading slash, e.g. get repositories/ws/repo.');
  const url = /^https?:\/\//.test(target) ? target : BASE + (target.startsWith('/') ? target : `/${target}`);
  const { body, contentType } = await rawGet(url, '*/*');
  if (contentType.includes('json')) {
    const data = JSON.parse(body);
    return { data, text: JSON.stringify(data, null, 2) };
  }
  return { data: { text: body }, text: body };
});

// --- workspaces & users
def('workspaces', 'workspaces', 'List workspaces you can access', async ctx => {
  const r = await getList(ctx, '/workspaces');
  const text = r.values.length
    ? listHeader('Workspaces', r) + r.values.map(w => `- ${w.slug}  (${w.name})`).join('\n') + pageNote(r, ctx)
    : none('workspaces');
  return { data: r, text };
});

def('workspace', 'workspace <workspace>', 'Workspace details', async ctx => {
  const w = await getJson(buildUrl(`/workspaces/${enc(ctx.pos[0] || die('Missing workspace.'))}`));
  return { data: w, text: `Workspace: ${w.name} (${w.slug})\nUUID: ${w.uuid}\nCreated: ${w.created_on || 'unknown'}` };
});

def('me', 'me', 'The authenticated user', async () => {
  const u = await getJson(buildUrl('/user'));
  return { data: u, text: `User: ${who(u)}${u.nickname ? ` (@${u.nickname})` : ''}\nAccount ID: ${u.account_id}\nUUID: ${u.uuid}` };
});

def('user', 'user <username-or-uuid>', 'Look up a user (UUID in braces or account id)', async ctx => {
  const u = await getJson(buildUrl(`/users/${enc(ctx.pos[0] || die('Missing user.'))}`));
  return { data: u, text: `User: ${who(u)}${u.nickname ? ` (@${u.nickname})` : ''}\nAccount ID: ${u.account_id || 'n/a'}\nUUID: ${u.uuid || 'n/a'}\nLocation: ${u.location || 'n/a'}` };
});

// --- repositories
const repoLine = r => `- ${r.full_name}  [${r.language || '?'}, ${r.is_private ? 'private' : 'public'}, updated ${r.updated_on}]${r.description ? `\n    ${first(r.description)}` : ''}`;

def('repos', 'repos <workspace>', 'List repositories in a workspace (supports --q, --sort)', async ctx => {
  const r = await getList(ctx, `/repositories/${enc(ctx.pos[0] || process.env.BITBUCKET_WORKSPACE || die('Missing workspace.'))}`);
  return { data: r, text: (r.values.length ? listHeader('Repositories', r) + r.values.map(repoLine).join('\n') + pageNote(r, ctx) : none('repositories')) };
});

def('search-repos', 'search-repos <workspace> <query>', 'Find repositories by name/description (server-side BBQL)', async ctx => {
  const ws = ctx.pos[0] || die('Missing workspace.');
  const query = ctx.pos[1] || die('Missing query.');
  const esc = query.replace(/"/g, '\\"');
  const r = await getList(ctx, `/repositories/${enc(ws)}`, { q: `name ~ "${esc}" OR description ~ "${esc}"`, pagelen: MAX_PAGELEN });
  return { data: r, text: r.values.length ? listHeader(`Repositories matching "${query}"`, r) + r.values.map(repoLine).join('\n') + pageNote(r, ctx) : none('matching repositories') };
});

def('repo', 'repo <ws>/<repo>', 'Repository details (includes default branch)', async ctx => {
  const t = repoCtx(ctx);
  const r = await getJson(buildUrl(t.base));
  return {
    data: r,
    text: [`Repository: ${r.full_name}`, `Description: ${r.description || 'none'}`, `Language: ${r.language || 'n/a'}`, `Private: ${r.is_private}`, `Default branch: ${r.mainbranch?.name || 'n/a'}`, `Created: ${r.created_on}`, `Updated: ${r.updated_on}`, `Size: ${r.size ?? 'n/a'} bytes`, `Clone/HTML: ${r.links?.html?.href || 'n/a'}`].join('\n'),
  };
});

def('browse', 'browse <ws>/<repo> [path] [--ref REF] [--limit N]', 'List a directory (or show a file if path is a file)', async ctx => {
  const t = repoCtx(ctx);
  const path = (t.rest[0] || '').replace(/^\/+|\/+$/g, '');
  const ref = ctx.flags.ref || (await defaultBranch(t.base));
  const limit = Math.min(num(ctx.flags.limit) ?? 50, MAX_PAGELEN);
  let r;
  if (!path) {
    r = await getJson(buildUrl(`${t.base}/src`, { at: ref, pagelen: limit }));
  } else {
    const sha = await resolveRef(t.base, ref);
    if (!sha) die(`Could not resolve ref '${ref}' in ${t.ws}/${t.repo}. Use "branches" or "tags" to list refs.`);
    const dirUrl = buildUrl(`${t.base}/src/${sha}/${encPath(path)}/`, { pagelen: limit });
    try {
      const res = await rawGet(dirUrl);
      if (!res.contentType.includes('json')) return fileResult(res.body, path, ref, ctx);
      r = JSON.parse(res.body);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      // not a directory — maybe a file
      return fileResult(await getText(buildUrl(`${t.base}/src/${sha}/${encPath(path)}`)), path, ref, ctx);
    }
  }
  const items = (r.values || []).map(i => `${i.type === 'commit_directory' ? 'd' : 'f'}  ${i.path}${i.size ? `  (${i.size} bytes)` : ''}`);
  return { data: r, text: `${t.ws}/${t.repo} @ ${ref}  /${path}\n${items.join('\n') || '(empty)'}${r.next ? '\n(more entries — raise --limit up to 100, or browse a subdirectory)' : ''}` };
});

function fileResult(content, path, ref, ctx) {
  const lines = content.split('\n');
  const start = Math.max(1, num(ctx.flags.start) ?? 1);
  const limit = Math.min(num(ctx.flags.limit) ?? 1000, 10000);
  const end = Math.min(start + limit - 1, lines.length);
  const slice = lines.slice(start - 1, end);
  const data = { file_path: path, ref, total_lines: lines.length, start, end, content: slice.join('\n') };
  if (ctx.flags.raw) return { data, text: data.content };
  const body = slice.map((l, i) => `${start + i}: ${l}`).join('\n');
  const more = end < lines.length ? `\n(… ${lines.length - end} more lines; use --start ${end + 1})` : '';
  return { data, text: `File: ${path} @ ${ref} (lines ${start}-${end} of ${lines.length})\n\n${body}${more}` };
}

def('file', 'file <ws>/<repo> <path> [--ref REF] [--start N] [--limit N] [--raw]', 'Read a file (line-numbered; paginated, default 1000 lines)', async ctx => {
  const t = repoCtx(ctx, 1);
  const path = t.rest[0].replace(/^\/+/, '');
  const ref = ctx.flags.ref || (await defaultBranch(t.base));
  const sha = await resolveRef(t.base, ref);
  if (!sha) die(`Could not resolve ref '${ref}' in ${t.ws}/${t.repo}. If you have the PR head commit SHA, pass it as --ref.`);
  const content = await getText(buildUrl(`${t.base}/src/${sha}/${encPath(path)}`));
  return fileResult(content, path, ref, ctx);
});

def('file-history', 'file-history <ws>/<repo> <commit-or-branch> <path>', 'Commits that touched a file', async ctx => {
  const t = repoCtx(ctx, 2);
  const [commit, path] = t.rest;
  const r = await getList(ctx, `${t.base}/filehistory/${enc(commit)}/${encPath(path)}`);
  const text = r.values.length
    ? `History of ${path} from ${commit}:\n` + r.values.map(e => `- ${short(e.commit.hash)} ${first(e.commit.message)}\n    ${commitAuthor(e.commit)}  ${e.commit.date}${e.size != null ? `  (${e.size} bytes)` : ''}`).join('\n') + pageNote(r, ctx)
    : none('history');
  return { data: r, text };
});

// --- branches, tags, commits
def('branches', 'branches <ws>/<repo>', 'List branches (supports --q, --sort)', async ctx => {
  const t = repoCtx(ctx);
  const r = await getList(ctx, `${t.base}/refs/branches`);
  return { data: r, text: r.values.length ? listHeader(`Branches in ${t.ws}/${t.repo}`, r) + r.values.map(b => `- ${b.name}  ${short(b.target.hash)}  ${b.target.date}`).join('\n') + pageNote(r, ctx) : none('branches') };
});

def('branch', 'branch <ws>/<repo> <name>', 'Branch details (head commit, merge strategies)', async ctx => {
  const t = repoCtx(ctx, 1);
  const b = await getJson(buildUrl(`${t.base}/refs/branches/${enc(t.rest[0])}`));
  return { data: b, text: [`Branch: ${b.name}`, `Head: ${b.target.hash}`, `Date: ${b.target.date}`, `Author: ${commitAuthor(b.target)}`, `Message: ${first(b.target.message)}`, b.merge_strategies ? `Merge strategies: ${b.merge_strategies.join(', ')}` : ''].filter(Boolean).join('\n') };
});

def('tags', 'tags <ws>/<repo>', 'List tags (supports --q, --sort e.g. --sort -target.date)', async ctx => {
  const t = repoCtx(ctx);
  const r = await getList(ctx, `${t.base}/refs/tags`);
  return { data: r, text: r.values.length ? listHeader(`Tags in ${t.ws}/${t.repo}`, r) + r.values.map(g => `- ${g.name}  ${short(g.target.hash)}  ${g.target.date}`).join('\n') + pageNote(r, ctx) : none('tags') };
});

def('tag', 'tag <ws>/<repo> <name>', 'Tag details', async ctx => {
  const t = repoCtx(ctx, 1);
  const g = await getJson(buildUrl(`${t.base}/refs/tags/${enc(t.rest[0])}`));
  return { data: g, text: [`Tag: ${g.name}`, `Commit: ${g.target.hash}`, `Date: ${g.target.date}`, `Author: ${commitAuthor(g.target)}`, g.message ? `Tag message: ${g.message.trim()}` : ''].filter(Boolean).join('\n') };
});

def('commits', 'commits <ws>/<repo> [--branch NAME]', 'Commit history (default branch unless --branch)', async ctx => {
  const t = repoCtx(ctx);
  const r = await getList(ctx, `${t.base}/commits${ctx.flags.branch ? `/${ctx.flags.branch}` : ''}`);
  return { data: r, text: r.values.length ? `Commits in ${t.ws}/${t.repo}${ctx.flags.branch ? ` (${ctx.flags.branch})` : ''}:\n` + r.values.map(c => `- ${short(c.hash)} ${first(c.message)}\n    ${commitAuthor(c)}  ${c.date}`).join('\n') + pageNote(r, ctx) : none('commits') };
});

def('commit', 'commit <ws>/<repo> <hash>', 'Commit details', async ctx => {
  const t = repoCtx(ctx, 1);
  const c = await getJson(buildUrl(`${t.base}/commit/${enc(t.rest[0])}`));
  return { data: c, text: [`Commit: ${c.hash}`, `Author: ${commitAuthor(c)}`, `Date: ${c.date}`, `Parents: ${(c.parents || []).map(p => short(p.hash)).join(', ') || 'none'}`, '', c.message.trim()].join('\n') };
});

def('commit-statuses', 'commit-statuses <ws>/<repo> <hash>', 'CI/build statuses for a commit', async ctx => {
  const t = repoCtx(ctx, 1);
  const r = await getList(ctx, `${t.base}/commit/${enc(t.rest[0])}/statuses`);
  return { data: r, text: r.values.length ? `Build statuses for ${short(t.rest[0])}:\n${statusLines(r.values)}` : none('build statuses') };
});

def('merge-base', 'merge-base <ws>/<repo> <rev1>..<rev2>', 'Common ancestor of two refs', async ctx => {
  const t = repoCtx(ctx, 1);
  const m = await getJson(buildUrl(`${t.base}/merge-base/${t.rest[0]}`));
  return { data: m, text: `Merge base of ${t.rest[0]}: ${m.hash}\n${m.date || ''}${m.message ? `\n${first(m.message)}` : ''}` };
});

// --- diffs
function diffParams(ctx, withContext) {
  const p = { path: ctx.flags.path };
  if (withContext) p.context = num(ctx.flags.context);
  return p;
}

def('diff', 'diff <ws>/<repo> <spec> [--path FILE] [--context N] [--ignore-whitespace] [--topic]', 'Unified diff for a commit ("<hash>") or range ("<a>..<b>")', async ctx => {
  const t = repoCtx(ctx, 1);
  const spec = t.rest[0];
  const p = { ...diffParams(ctx, true), ignore_whitespace: ctx.flags['ignore-whitespace'] || undefined, topic: ctx.flags.topic || undefined };
  const diff = await getText(buildUrl(`${t.base}/diff/${spec}`, p));
  return { data: { diff }, text: diff.trim() ? diff : `No changes found for ${spec}.` };
});

def('diffstat', 'diffstat <ws>/<repo> <spec> [--path FILE]', 'Per-file change summary for a commit or range', async ctx => {
  const t = repoCtx(ctx, 1);
  const spec = t.rest[0];
  const r = await getList(ctx, `${t.base}/diffstat/${spec}`, { path: ctx.flags.path, ignore_whitespace: ctx.flags['ignore-whitespace'] || undefined, topic: ctx.flags.topic || undefined, pagelen: MAX_PAGELEN });
  return { data: r, text: diffstatText(`${spec} in ${t.ws}/${t.repo}`, r) + pageNote(r, ctx) };
});

// --- pull requests
def('prs', 'prs <ws>/<repo> [--state OPEN|MERGED|DECLINED|SUPERSEDED] [--q BBQL]', 'List pull requests', async ctx => {
  const t = repoCtx(ctx);
  const r = await getList(ctx, `${t.base}/pullrequests`, { state: ctx.flags.state && ctx.flags.state.toUpperCase() });
  return { data: r, text: r.values.length ? listHeader(`Pull requests in ${t.ws}/${t.repo}`, r) + r.values.map(p => `- #${p.id} [${p.state}] ${p.title}\n    ${who(p.author)}  ${p.source.branch.name} -> ${p.destination.branch.name}  created ${p.created_on}`).join('\n') + pageNote(r, ctx) : none('pull requests') };
});

def('pr', 'pr <ws>/<repo> <id>   |   pr <PR-URL>', 'Pull request details (description, reviewers, participants)', async ctx => {
  const t = prCtx(ctx);
  const p = await getJson(buildUrl(t.pr));
  const parts = (p.participants || []).map(x => `${who(x.user)}${x.approved ? ' (approved)' : ''}${x.state ? ` [${x.state}]` : ''}`);
  return {
    data: p,
    text: [`PR #${p.id}: ${p.title}`, `State: ${p.state}`, `Author: ${who(p.author)}`, `Branch: ${p.source.branch.name} -> ${p.destination.branch.name}`, `Source commit: ${p.source.commit?.hash || 'n/a'}`, `Created: ${p.created_on}`, `Updated: ${p.updated_on}`, `Reviewers: ${(p.reviewers || []).map(who).join(', ') || 'none'}`, `Participants: ${parts.join(', ') || 'none'}`, `Comments: ${p.comment_count ?? 'n/a'}`, '', 'Description:', p.description || '(none)'].join('\n'),
  };
});

def('pr-comments', 'pr-comments <ws>/<repo> <id> [--all]', 'All comments on a PR (with ids and reply links)', async ctx => {
  const t = prCtx(ctx);
  const r = await getList(ctx, `${t.pr}/comments`);
  return { data: r, text: r.values.length ? `Comments on PR #${t.id} (${r.size ?? r.values.length} total):\n\n${r.values.map(commentLine).join('\n\n')}${pageNote(r, ctx)}` : none('comments') };
});

def('pr-comment', 'pr-comment <ws>/<repo> <id> <comment-id>', 'A single PR comment', async ctx => {
  const t = prCtx(ctx, 1);
  const c = await getJson(buildUrl(`${t.pr}/comments/${num(t.rest[0])}`));
  return { data: c, text: commentLine(c) };
});

def('comment-thread', 'comment-thread <ws>/<repo> <id> <comment-id>', 'A comment plus all nested replies', async ctx => {
  const t = prCtx(ctx, 1);
  const rootId = num(t.rest[0]);
  const root = await getJson(buildUrl(`${t.pr}/comments/${rootId}`));
  const all = await getList({ ...ctx, flags: { ...ctx.flags, all: true, q: undefined, sort: undefined } }, `${t.pr}/comments`, { pagelen: MAX_PAGELEN });
  const walk = (pid, depth) => all.values.filter(c => c.parent?.id === pid).flatMap(c => [{ c, depth }, ...walk(c.id, depth + 1)]);
  const replies = walk(rootId, 1);
  const fmt = (c, d) => commentLine(c).split('\n').map(l => '  '.repeat(d) + l).join('\n');
  const text = [`Thread for comment #${rootId} on PR #${t.id}`, '', fmt(root, 0), ...replies.map(({ c, depth }) => `\n${fmt(c, depth)}`)].join('\n');
  return { data: { root, replies: replies.map(x => x.c) }, text };
});

def('pr-activity', 'pr-activity <ws>/<repo> <id>', 'Reviews, approvals, comments, updates on a PR', async ctx => {
  const t = prCtx(ctx);
  const r = await getList(ctx, `${t.pr}/activity`);
  const lines = r.values.map(a => {
    if (a.comment) return `- comment by ${who(a.comment.user)} (${a.comment.created_on}): ${first(a.comment.content?.raw)}`;
    if (a.approval) return `- approval by ${who(a.approval.user)} (${a.approval.date})`;
    if (a.update) return `- update by ${who(a.update.author)} (${a.update.date}): state=${a.update.state}${a.update.title ? ` title="${a.update.title}"` : ''}`;
    return `- ${Object.keys(a).join(', ')}`;
  });
  return { data: r, text: lines.length ? `Activity on PR #${t.id}:\n${lines.join('\n')}${pageNote(r, ctx)}` : none('activity') };
});

def('pr-diff', 'pr-diff <ws>/<repo> <id> [--path FILE] [--context N]', 'Unified diff of a PR (use --path for one file; check pr-diffstat first on big PRs)', async ctx => {
  const t = prCtx(ctx);
  const diff = await getText(buildUrl(`${t.pr}/diff`, diffParams(ctx, true)));
  return { data: { diff }, text: diff.trim() ? diff : `No changes found in PR #${t.id}.` };
});

def('pr-diffstat', 'pr-diffstat <ws>/<repo> <id> [--path FILE]', 'Per-file +/- summary of a PR', async ctx => {
  const t = prCtx(ctx);
  const r = await getList(ctx, `${t.pr}/diffstat`, { path: ctx.flags.path, pagelen: MAX_PAGELEN });
  return { data: r, text: diffstatText(`PR #${t.id} in ${t.ws}/${t.repo}`, r) + pageNote(r, ctx) };
});

def('pr-commits', 'pr-commits <ws>/<repo> <id>', 'Commits in a PR', async ctx => {
  const t = prCtx(ctx);
  const r = await getList(ctx, `${t.pr}/commits`);
  return { data: r, text: r.values.length ? `Commits in PR #${t.id}:\n` + r.values.map(c => `- ${short(c.hash)} ${first(c.message)}\n    ${commitAuthor(c)}  ${c.date}`).join('\n') + pageNote(r, ctx) : none('commits') };
});

def('pr-statuses', 'pr-statuses <ws>/<repo> <id>', 'CI/build statuses for a PR', async ctx => {
  const t = prCtx(ctx);
  const r = await getList(ctx, `${t.pr}/statuses`);
  return { data: r, text: r.values.length ? `Build statuses for PR #${t.id}:\n${statusLines(r.values)}` : none('build statuses') };
});

def('pr-context', 'pr-context <PR-URL | ws/repo id | ws/repo --branch NAME> [--full]', 'One-shot PR briefing: metadata, diffstat totals, build status, recent comments', async ctx => {
  const t = repoCtx(ctx);
  let id = t.prId ?? num(t.rest[0]);
  if (!id && ctx.flags.branch) {
    const s = await getJson(buildUrl(`${t.base}/pullrequests`, { q: `source.branch.name="${ctx.flags.branch}" AND state="OPEN"`, pagelen: 1 }));
    id = s.values?.[0]?.id;
    if (!id) return { data: { found: false }, text: `No open pull request found for branch "${ctx.flags.branch}" in ${t.ws}/${t.repo}.` };
  }
  if (!id) die('Provide a PR URL, "<ws>/<repo> <id>", or "<ws>/<repo> --branch NAME".');
  const full = Boolean(ctx.flags.full);
  const pr = `${t.base}/pullrequests/${id}`;
  const p = await getJson(buildUrl(pr));
  const soft = f => f().catch(() => null);
  const [ds, st, cm] = await Promise.all([
    soft(() => getJson(buildUrl(`${pr}/diffstat`, { pagelen: MAX_PAGELEN }))),
    soft(() => getJson(buildUrl(`${pr}/statuses`))),
    // newest first; fall back to the default order if the server rejects sorting
    soft(() => getJson(buildUrl(`${pr}/comments`, { pagelen: full ? 20 : 3, sort: '-created_on' })).catch(() => getJson(buildUrl(`${pr}/comments`, { pagelen: full ? 20 : 3 })))),
  ]);
  const L = [`=== PR #${p.id}: ${p.title} ===`, `State: ${p.state}`, `Author: ${who(p.author)}`, `Branch: ${p.source.branch.name} -> ${p.destination.branch.name}`, `Created: ${p.created_on}  Updated: ${p.updated_on}`];
  if (p.reviewers?.length) L.push(`Reviewers: ${p.reviewers.map(who).join(', ')}`);
  if (full && p.description) L.push('', '--- Description ---', p.description);
  L.push('', '--- Diffstat ---');
  if (ds?.values?.length) {
    const a = ds.values.reduce((s, e) => s + e.lines_added, 0);
    const r = ds.values.reduce((s, e) => s + e.lines_removed, 0);
    L.push(`${ds.values.length} file(s) changed, +${a} -${r}`);
    if (full) L.push(...diffstatText('', ds).split('\n').slice(2));
  } else L.push('No diffstat available.');
  L.push('', '--- Build status ---', st?.values?.length ? statusLines(st.values) : 'No build statuses found.');
  L.push('', '--- Comments ---');
  if (cm?.values?.length) {
    L.push(`${cm.size ?? cm.values.length} comment(s) total; showing newest ${cm.values.length}:`, ...cm.values.map(commentLine));
  } else L.push('No comments.');
  return { data: { pull_request: p, diffstat: ds, statuses: st, comments: cm }, text: L.join('\n') };
});

// --- pipelines
def('pipelines', 'pipelines <ws>/<repo>', 'Recent pipeline runs (newest first)', async ctx => {
  const t = repoCtx(ctx);
  const r = await getList(ctx, `${t.base}/pipelines`, { sort: '-created_on' });
  return { data: r, text: r.values.length ? listHeader(`Pipelines in ${t.ws}/${t.repo}`, r) + r.values.map(p => `- #${p.build_number} ${pipelineState(p.state)}  ${p.target?.ref_name || 'n/a'}  ${p.trigger?.name || ''}  ${duration(p.duration_in_seconds)}  ${p.created_on}\n    ${p.uuid}`).join('\n') + pageNote(r, ctx) : none('pipelines') };
});

def('pipeline', 'pipeline <ws>/<repo> <uuid>', 'Pipeline run details', async ctx => {
  const t = repoCtx(ctx, 1);
  const p = await getJson(buildUrl(`${t.base}/pipelines/${enc(braces(t.rest[0]))}`));
  return { data: p, text: [`Pipeline #${p.build_number}  ${pipelineState(p.state)}`, `Branch: ${p.target?.ref_name || 'n/a'}`, `Commit: ${short(p.target?.commit?.hash)} ${first(p.target?.commit?.message)}`, `Trigger: ${p.trigger?.name || 'n/a'}  Creator: ${who(p.creator)}`, `Duration: ${duration(p.duration_in_seconds)}`, `Created: ${p.created_on}${p.completed_on ? `  Completed: ${p.completed_on}` : ''}`, `UUID: ${p.uuid}`].join('\n') };
});

def('pipeline-steps', 'pipeline-steps <ws>/<repo> <pipeline-uuid>', 'Steps of a pipeline run', async ctx => {
  const t = repoCtx(ctx, 1);
  const r = await getList(ctx, `${t.base}/pipelines/${enc(braces(t.rest[0]))}/steps`);
  return { data: r, text: r.values.length ? 'Pipeline steps:\n' + r.values.map((s, i) => `- ${s.name || `Step ${i + 1}`}: ${pipelineState(s.state)}  ${duration(s.duration_in_seconds)}\n    ${s.uuid}`).join('\n') : none('steps') };
});

def('pipeline-step-log', 'pipeline-step-log <ws>/<repo> <pipeline-uuid> <step-uuid> [--tail CHARS]', 'Build log of a step (last 50000 chars by default — failures are at the end)', async ctx => {
  const t = repoCtx(ctx, 2);
  const log = await getText(buildUrl(`${t.base}/pipelines/${enc(braces(t.rest[0]))}/steps/${enc(braces(t.rest[1]))}/log`));
  if (!log.trim()) return { data: { log: '' }, text: 'No log output found for this step.' };
  const tail = num(ctx.flags.tail) ?? 50000;
  const truncated = log.length > tail;
  const out = truncated ? log.slice(-tail) : log;
  return { data: { log: out, truncated }, text: `${truncated ? `(showing last ${tail} of ${log.length} chars)\n` : ''}${out}` };
});

// --- issues
def('issues', 'issues <ws>/<repo> [--state S] [--kind K] [--q BBQL]', 'Issue tracker entries', async ctx => {
  const t = repoCtx(ctx);
  const clauses = [];
  if (ctx.flags.state) clauses.push(`state="${ctx.flags.state}"`);
  if (ctx.flags.kind) clauses.push(`kind="${ctx.flags.kind}"`);
  const r = await getList(ctx, `${t.base}/issues`, clauses.length ? { q: clauses.join(' AND ') } : {});
  return { data: r, text: r.values.length ? listHeader(`Issues in ${t.ws}/${t.repo}`, r) + r.values.map(i => `- #${i.id} [${i.state}/${i.kind}/${i.priority}] ${i.title}\n    reporter ${who(i.reporter)}, assignee ${i.assignee ? who(i.assignee) : 'unassigned'}, created ${i.created_on}`).join('\n') + pageNote(r, ctx) : none('issues') };
});

def('issue', 'issue <ws>/<repo> <id>', 'Issue details', async ctx => {
  const t = repoCtx(ctx, 1);
  const i = await getJson(buildUrl(`${t.base}/issues/${num(t.rest[0])}`));
  return { data: i, text: [`Issue #${i.id}: ${i.title}`, `State: ${i.state}  Kind: ${i.kind}  Priority: ${i.priority}`, `Reporter: ${who(i.reporter)}  Assignee: ${i.assignee ? who(i.assignee) : 'unassigned'}`, `Created: ${i.created_on}  Updated: ${i.updated_on}`, '', i.content?.raw || '(no content)'].join('\n') };
});

// --- code search
def('search-code', 'search-code <workspace> <query> [--repo SLUG] [--language L] [--extension EXT]', 'Code search across a workspace (needs code search enabled at bitbucket.org/search)', async ctx => {
  const ws = ctx.pos[0] || die('Missing workspace.');
  let q = ctx.pos[1] || die('Missing query.');
  if (ctx.flags.repo) q += ` repo:${ctx.flags.repo}`;
  if (ctx.flags.language) q += ` language:${ctx.flags.language}`;
  if (ctx.flags.extension) q += ` extension:${ctx.flags.extension}`;
  const r = await getList(ctx, `/workspaces/${enc(ws)}/search/code`, { search_query: q });
  const text = r.values?.length
    ? `Code search "${q}" in ${ws} (${r.size ?? r.values.length} files):\n\n` +
      r.values.map(v => `${v.file.path} (${v.content_match_count} matches)\n` + v.content_matches.flatMap(m => m.lines.map(l => `    ${l.line}: ${l.segments.map(s => (s.match ? `[[${s.text}]]` : s.text)).join('')}`)).join('\n')).join('\n\n') + pageNote(r, ctx)
    : none('code matches');
  return { data: r, text };
});

// ---------------------------------------------------------------- output / main

/** --select a.b,c : project fields from each item of `values` (or from a single object). */
function project(data, select) {
  const paths = select.split(',').map(s => s.trim()).filter(Boolean);
  const pick = o => Object.fromEntries(paths.map(p => [p, p.split('.').reduce((v, k) => (v == null ? v : v[k]), o)]));
  if (Array.isArray(data?.values)) {
    const { values, ...meta } = data;
    return { ...meta, values: values.map(pick) };
  }
  return pick(data);
}

function help(name) {
  if (name && C[name]) return `node bb.mjs ${C[name].usage}\n  ${C[name].summary}`;
  const rows = Object.values(C).map(c => `  ${c.usage.padEnd(78)} ${c.summary}`);
  return [
    'Read-only Bitbucket Cloud CLI.  node bb.mjs <command> [args] [flags]',
    '',
    'Repo-scoped commands take <workspace>/<repo> (or a Bitbucket URL; or just <repo> if BITBUCKET_WORKSPACE is set).',
    '',
    ...rows,
    '',
    'Global flags:',
    '  --json            raw API JSON instead of the compact text view',
    '  --select a,b.c    JSON output limited to these (dotted) fields per item; implies --json',
    '  --page N --pagelen N (max 100)   paging for list commands',
    '  --all [--max-pages N]            follow every page (default cap 20 pages)',
    '  --q BBQL --sort FIELD            server-side filter / sort for list commands (e.g. --q \'state="OPEN"\' --sort -updated_on)',
    '  --max-chars N     truncate output to N characters',
  ].join('\n');
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift();
  if (!cmd || cmd === 'help' || flags.help) {
    console.log(help(cmd === 'help' ? pos[0] : cmd));
    return;
  }
  const command = C[cmd];
  if (!command) die(`Unknown command "${cmd}". Run: node bb.mjs help`);
  const { data, text } = await command.run({ cmd, pos, flags });
  let out;
  if (flags.select) out = JSON.stringify(project(data, flags.select), null, 2);
  else if (flags.json) out = JSON.stringify(data, null, 2);
  else out = text;
  const max = num(flags['max-chars']);
  if (max && out.length > max) out = `${out.slice(0, max)}\n… [truncated at ${max} of ${out.length} chars]`;
  console.log(out);
}

main().catch(e => {
  console.error(`Error: ${e.message}`);
  const hint = hintFor(e);
  if (hint) console.error(`Hint: ${hint}`);
  process.exit(1);
});
