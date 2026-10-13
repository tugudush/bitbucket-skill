#!/usr/bin/env node
/**
 * bb.mjs — read-only Bitbucket Cloud CLI (no dependencies, Node 20+, tested on 24).
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

import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const VERSION = "1.1.0"
const BASE = (
  process.env.BITBUCKET_API_BASE || "https://api.bitbucket.org/2.0"
).replace(/\/+$/, "")
const DEFAULT_TIMEOUT = 30000
const RETRIES = 3
const MAX_PAGELEN = 100
const MAX_REDIRECTS = 5
const THREAD_MAX_PAGES = 1000 // comment-thread must see every comment; far above the default --max-pages
const UA = `bitbucket-cloud-skill/${VERSION}`

// ---------------------------------------------------------------- utilities

class CliError extends Error {}
const die = (msg) => {
  throw new CliError(msg)
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "all",
  "full",
  "raw",
  "ignore-whitespace",
  "topic",
  "help",
])

// Accepted by every command; a command's own flags come from its usage string.
const OUTPUT_FLAGS = ["json", "select", "max-chars", "help"]
// Accepted only by list commands (def(..., { paged: true })); elsewhere they would be silently ignored.
const PAGING_FLAGS = ["page", "pagelen", "all", "max-pages"]
const QUERY_FLAGS = ["q", "sort"]

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") {
      pos.push(...argv.slice(i + 1))
      break
    } else if (a === "-h") {
      flags.help = true
    } else if (/^-[A-Za-z]/.test(a)) {
      // Treating "-r main" as two arguments would drop the option and give a plausible wrong result.
      die(
        `Unknown option ${a}. Flags use two dashes (e.g. --ref). To pass an argument that starts with "-", put it after "--".`,
      )
    } else if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=")
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq)
      let val = eq === -1 ? undefined : a.slice(eq + 1)
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = val === undefined ? true : val !== "false"
      } else {
        if (val === undefined) {
          val = argv[++i]
          if (val === undefined) die(`--${key} needs a value`)
          if (val.startsWith("--"))
            die(
              `--${key} needs a value, but the next argument is "${val}". To pass a value that starts with "--", write --${key}=${val}`,
            )
        }
        flags[key] = val
      }
    } else {
      pos.push(a)
    }
  }
  return { pos, flags }
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    prev = cur
  }
  return prev[b.length]
}

const usageFlags = (usage) =>
  (usage.match(/--[a-z][a-z-]*/g) || []).map((f) => f.slice(2))

/** Reject flags the command does not know (a typo would otherwise be ignored and give a plausible wrong result). */
function checkFlags(command, flags) {
  const own = usageFlags(command.usage)
  const known = new Set([
    ...OUTPUT_FLAGS,
    ...(command.paged ? PAGING_FLAGS : []),
    ...(command.query ? QUERY_FLAGS : []),
    ...own,
  ])
  for (const key of Object.keys(flags)) {
    if (known.has(key)) continue
    if (PAGING_FLAGS.includes(key) || QUERY_FLAGS.includes(key))
      die(
        command.paged
          ? `--${key} is not supported by ${command.name} (the endpoint does not take BBQL filters or sorting).`
          : `--${key} does not apply to ${command.name}: it is not a list command, so the flag would be ignored.`,
      )
    const near = [...known]
      .filter((k) => editDistance(key, k) <= 2)
      .sort((a, b) => editDistance(key, a) - editDistance(key, b))[0]
    die(
      `Unknown flag --${key}.${near ? ` Did you mean --${near}?` : ""} See: node bb.mjs help ${command.name}`,
    )
  }
}

/** How many positional arguments a usage string allows: its <…> and [path]-style tokens, first form only. */
function maxArgs(usage) {
  const tokens = []
  let cur = ""
  let depth = 0
  for (const ch of usage) {
    if (ch === "<" || ch === "[") depth++
    else if (ch === ">" || ch === "]") depth--
    if (/\s/.test(ch) && depth === 0) {
      if (cur) tokens.push(cur)
      cur = ""
    } else cur += ch
  }
  if (cur) tokens.push(cur)
  const end = tokens.indexOf("|")
  return (end === -1 ? tokens : tokens.slice(0, end))
    .slice(1)
    .filter(
      (t) => !t.startsWith("[--") && (t.includes("<") || t.startsWith("[")),
    ).length
}

/** Reject leftover positional arguments, which would otherwise be ignored (e.g. "commits ws/repo develop"). */
function checkArgs(command, pos) {
  const max = maxArgs(command.usage)
  if (pos.length <= max) return
  die(unexpectedArg(command, pos[max]))
}

function unexpectedArg(command, arg) {
  const flag = ["ref", "branch"].find((f) =>
    usageFlags(command.usage).includes(f),
  )
  return `Unexpected argument "${arg}".${flag ? ` Did you mean --${flag} ${arg}?` : ""} See: node bb.mjs help ${command.name}`
}

/** Whole number >= min (flags, ids, env settings); anything else is an error rather than a surprising request. */
function int(v, label, min = 1) {
  if (v === undefined || v === "") return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < min)
    die(
      `${label} must be ${min === 0 ? "a whole number (0 or more)" : "a positive whole number"}, got "${v}".`,
    )
  return n
}

// "." and ".." are not encoded by encodeURIComponent (nor is "%2e" safe), so URL parsing would collapse them
// and the request would reach a different endpoint.
function enc(s) {
  const v = String(s)
  if (v === "." || v === "..")
    die(`Invalid path segment "${v}": "." and ".." are not allowed.`)
  return encodeURIComponent(v)
}
const encPath = (p) => p.split("/").map(enc).join("/")
// Quote a value for a BBQL string literal: escape backslashes first, then quotes.
const bbqlString = (s) =>
  `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
// Validate "<rev>" or "<rev>..<rev>" and encode each part so it stays one path segment.
function rangeSpec(spec) {
  const parts = String(spec).split("..")
  if (parts.length > 2 || parts.some((p) => !p || /^\.+$/.test(p)))
    die(`Invalid revision spec "${spec}". Use "<rev>" or "<rev>..<rev>".`)
  return parts.map(enc).join("..")
}
const braces = (u) => (u.startsWith("{") && u.endsWith("}") ? u : `{${u}}`)
// Diffstat entries for binary files can lack the counts; treat missing as 0 so sums never become NaN.
const lineCount = (n) => (Number.isFinite(n) ? n : 0)
const first = (s) => (s || "").split("\n")[0]
const short = (h) => (h || "").slice(0, 8)
const who = (u) => u?.display_name || u?.nickname || u?.raw || "unknown"
const commitAuthor = (c) =>
  c?.author?.user?.display_name || c?.author?.raw || "unknown"
// CI logs are full of colour codes: they cost tokens and make quoted error lines hard to read.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const stripAnsi = (s) => s.replace(ANSI, "")

// ---------------------------------------------------------------- configuration

// Plain http is only accepted for loopback hosts (local mock servers), never for a real API.
const isLoopback = (h) =>
  h === "localhost" || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h)

let apiBaseUrl
/** BITBUCKET_API_BASE, parsed and checked once: it must be a valid https:// URL (http only for loopback). */
function apiBase() {
  if (apiBaseUrl) return apiBaseUrl
  let u
  try {
    u = new URL(BASE)
  } catch {
    die(
      `BITBUCKET_API_BASE "${BASE}" is not a valid URL. Unset it, or use e.g. https://api.bitbucket.org/2.0.`,
    )
  }
  if (u.protocol !== "https:" && !isLoopback(u.hostname))
    die(
      `Refusing to use BITBUCKET_API_BASE ${u.origin}: it must be an https:// URL, because credentials are sent with every request.`,
    )
  return (apiBaseUrl = u)
}

let timeoutValue
function timeoutMs() {
  timeoutValue ??=
    int(process.env.BITBUCKET_REQUEST_TIMEOUT, "BITBUCKET_REQUEST_TIMEOUT") ??
    DEFAULT_TIMEOUT
  return timeoutValue
}

function buildUrl(path, params = {}) {
  apiBase()
  const u = new URL(BASE + path)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "")
      u.searchParams.set(k, String(v))
  }
  return u.toString()
}

// ---------------------------------------------------------------- HTTP (GET only)

function authHeaders() {
  const email = process.env.BITBUCKET_EMAIL
  const token = process.env.BITBUCKET_API_TOKEN
  if (!email || !token) return {}
  return {
    Authorization:
      "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
  }
}

const hasCreds = () =>
  Boolean(process.env.BITBUCKET_EMAIL && process.env.BITBUCKET_API_TOKEN)

// Credentials are only ever sent to the configured API origin, and only over HTTPS.
function assertAllowedUrl(url) {
  const { origin } = apiBase()
  if (new URL(url).origin !== origin) {
    die(`Refusing to call ${new URL(url).origin}: only ${origin} is allowed.`)
  }
}

class ApiError extends Error {
  constructor(status, statusText, detail, url) {
    super(
      `Bitbucket API error: ${status} ${statusText}${detail ? ` - ${detail}` : ""}`,
    )
    this.status = status
    this.detail = detail
    this.url = url
  }
}

function explain(status) {
  switch (status) {
    case 401:
      return hasCreds()
        ? "Credentials were rejected. The API token may be expired or lack Bitbucket read scopes."
        : "No credentials configured: set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN in the environment (outside the chat)."
    case 403:
      return "Access denied. The token may be missing a read scope (read:repository:bitbucket, read:pullrequest:bitbucket, read:pipeline:bitbucket, read:issue:bitbucket, read:workspace:bitbucket) or you lack access to this resource."
    case 404:
      return hasCreds()
        ? "Not found. Check workspace/repo/ref spelling and that your account can see it."
        : "Not found. Private repositories look like 404 without credentials; set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN."
    case 429:
      return "Rate limited by Bitbucket. Wait a bit and retry with fewer or narrower requests."
    default:
      return ""
  }
}

/** A DNS, TLS, connection or proxy failure below HTTP (fetch threw before or while reading a response). */
class NetworkError extends Error {
  constructor(message, code, hint) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

// Failures that usually clear up on their own; everything else (DNS not found, bad certificate) is not retried.
const TRANSIENT_NET_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
const proxyConfigured = () => PROXY_VARS.some((v) => process.env[v])
const proxyIgnored = () =>
  proxyConfigured() && !["1", "true"].includes(process.env.NODE_USE_ENV_PROXY)

/** Underlying error behind fetch's generic "fetch failed" TypeError (may sit inside an AggregateError). */
function rootCause(e) {
  let c = e.cause ?? e
  while (c.cause && !c.code) c = c.cause
  if (Array.isArray(c.errors) && c.errors.length) c = c.errors[0]
  return c
}

function networkHint(code) {
  const hints = []
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    hints.push(
      "DNS lookup failed. Check the network connection and BITBUCKET_API_BASE.",
    )
  } else if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code || "")) {
    hints.push(
      "TLS certificate was not trusted, typically a corporate TLS-inspecting proxy. Set NODE_EXTRA_CA_CERTS to the company CA file (or NODE_USE_SYSTEM_CA=1) in the environment.",
    )
  }
  if (proxyIgnored()) {
    hints.push(
      "A proxy variable is set but Node ignores it unless NODE_USE_ENV_PROXY=1 is also set in the environment.",
    )
  } else if (!hints.length) {
    hints.push(
      "Check connectivity, firewall and proxy settings (Node needs NODE_USE_ENV_PROXY=1 plus HTTPS_PROXY to use a proxy).",
    )
  }
  return hints.join(" ")
}

function toNetworkError(e, url) {
  const c = rootCause(e)
  const code = c.code || e.code
  const reason = [code, c.message && c.message !== e.message ? c.message : ""]
    .filter(Boolean)
    .join(": ")
  const host = new URL(url).host
  return new NetworkError(
    `Network error contacting ${host}: ${reason || e.message}`,
    code,
    networkHint(code),
  )
}

/** Hint line for any error that has one, or ''. A command can set e.hint to replace the generic status hint. */
const hintFor = (e) => e.hint || explain(e.status)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Longest Retry-After we will sit through; a larger ask fails fast instead of stalling the CLI.
const MAX_RETRY_WAIT = 30000

/** Milliseconds the server asked us to wait (Retry-After as seconds or an HTTP date), or undefined. */
function retryAfterMs(res) {
  const v = (res.headers.get("retry-after") || "").trim()
  if (!v) return undefined
  const ms = /^\d+(\.\d+)?$/.test(v)
    ? Number(v) * 1000
    : Date.parse(v) - Date.now()
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/** Parse a 200 body as JSON; a proxy or login page gets named as such instead of "Unexpected token <". */
function parseJson(body, contentType, url) {
  try {
    return JSON.parse(body)
  } catch {
    const html = /^\s*<(!doctype|html)/i.test(body)
    die(
      `Expected JSON from ${new URL(url).host} but got ${html ? "an HTML page" : "a body that is not valid JSON"}${contentType ? ` (content-type: ${contentType})` : ""}.${html ? " A proxy, firewall or login page is probably intercepting the request." : ""}`,
    )
  }
}

/**
 * GET that follows redirects itself so every hop is checked: same-origin hops keep credentials; another
 * origin is refused unless the caller allows it (foreignRedirects), and then it must be HTTPS and gets no
 * credentials. Relying on fetch's own following would leave both to the runtime.
 */
async function fetchChecked(url, { accept, headers, foreignRedirects }, signal) {
  const { origin } = apiBase()
  let target = url
  for (let hop = 0; ; hop++) {
    const own = new URL(target).origin === origin
    const res = await fetch(target, {
      method: "GET", // read-only by construction: no other method is ever used
      redirect: "manual",
      headers: {
        Accept: accept,
        "User-Agent": UA,
        ...headers,
        ...(own ? authHeaders() : {}),
      },
      signal,
    })
    const location = res.headers.get("location")
    if (res.status < 300 || res.status > 399 || !location) return res
    await res.body?.cancel().catch(() => {})
    if (hop >= MAX_REDIRECTS) die(`Too many redirects starting from ${url}`)
    const next = new URL(location, target)
    if (next.origin !== origin) {
      if (!foreignRedirects)
        die(
          `Refusing to follow a redirect to ${next.origin}: only ${origin} is allowed.`,
        )
      if (next.protocol !== "https:" && !isLoopback(next.hostname))
        die(`Refusing to follow a redirect to non-HTTPS ${next.origin}.`)
    }
    target = next.href
  }
}

/**
 * Low-level GET with timeout + retry on 429/5xx and transient network errors.
 * Returns { body, contentType, status, headers }.
 */
async function rawGet(
  url,
  { accept = "application/json", headers = {}, foreignRedirects = false } = {},
) {
  assertAllowedUrl(url)
  const timeout = timeoutMs()
  let lastErr
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const res = await fetchChecked(
        url,
        { accept, headers, foreignRedirects },
        ctrl.signal,
      )
      // Timer stays armed until the body is fully read, so a stalled body aborts too.
      const body = await res.text()
      if (!res.ok) {
        let detail = body.slice(0, 300)
        try {
          const j = JSON.parse(body)
          detail = j.error?.message
            ? j.error.message + (j.error.detail ? ` (${j.error.detail})` : "")
            : j.message || detail
        } catch {
          /* keep raw text */
        }
        const err = new ApiError(res.status, res.statusText, detail, url)
        if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
          const asked = retryAfterMs(res)
          if (asked > MAX_RETRY_WAIT) {
            err.message += ` (server asked to wait ${Math.ceil(asked / 1000)}s via Retry-After; not retrying)`
            throw err
          }
          lastErr = err
          await sleep(asked ?? 2 ** (attempt - 1) * 1000)
          continue
        }
        throw err
      }
      return {
        body,
        contentType: res.headers.get("content-type") || "",
        status: res.status,
        headers: res.headers,
      }
    } catch (e) {
      if (e.name === "AbortError") {
        lastErr = new Error(`Request timed out after ${timeout}ms: ${url}`)
        if (attempt < RETRIES) {
          await sleep(2 ** (attempt - 1) * 1000)
          continue
        }
        throw lastErr
      }
      if (e instanceof ApiError || !e.cause) throw e
      lastErr = toNetworkError(e, url)
      if (TRANSIENT_NET_CODES.has(lastErr.code) && attempt < RETRIES) {
        await sleep(2 ** (attempt - 1) * 1000)
        continue
      }
      throw lastErr
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr || new Error("Request failed")
}

const getJson = async (url) => {
  const { body, contentType } = await rawGet(url)
  return parseJson(body, contentType, url)
}
const getText = async (url, accept = "text/plain") =>
  (await rawGet(url, { accept })).body

/** One page, or every page with --all (capped), of a list endpoint. */
async function getList(ctx, path, params = {}) {
  const { flags } = ctx
  const all = Boolean(flags.all)
  const page = int(flags.page, "--page")
  const pagelen =
    int(flags.pagelen, "--pagelen") ??
    params.pagelen ??
    (all ? MAX_PAGELEN : undefined)
  const extra = {
    ...params,
    pagelen: pagelen && Math.min(pagelen, MAX_PAGELEN),
    page,
  }
  if (flags.q) extra.q = extra.q ? `(${extra.q}) AND (${flags.q})` : flags.q
  if (flags.sort) extra.sort = flags.sort
  let url = buildUrl(path, extra)
  if (!all) return getJson(url)
  const maxPages = int(flags["max-pages"], "--max-pages") ?? 20
  const values = []
  let size
  let pages = 0
  while (url && pages < maxPages) {
    const r = await getJson(url)
    values.push(...(r.values || []))
    size = r.size ?? size
    url = r.next
    pages++
  }
  return {
    values,
    size: size ?? values.length,
    ...(url ? { next: url, truncated: true } : {}),
  }
}

// ---------------------------------------------------------------- targets

function parseRepoToken(tok) {
  if (!tok)
    die(
      "Missing repository. Use <workspace>/<repo> (or set BITBUCKET_WORKSPACE and pass just <repo>).",
    )
  if (/^https?:\/\//.test(tok)) {
    const u = new URL(tok)
    // Nothing is sent to that host, but a GitHub (or other) URL would otherwise be read as ws/repo silently.
    if (!/(^|\.)bitbucket\.org$/i.test(u.hostname) && u.host !== apiBase().host)
      console.error(
        `Warning: ${u.host} is not bitbucket.org; reading workspace/repo from the URL path anyway.`,
      )
    let parts = u.pathname.split("/").filter(Boolean)
    // API form: /2.0/repositories/<ws>/<repo>/... (without this, "2.0" would parse as the workspace)
    if (parts[0] === "2.0") {
      if (parts[1] !== "repositories")
        die(
          `${tok} is an API URL but not a repository one. Use the "get" command for arbitrary API paths.`,
        )
      parts = parts.slice(2)
    }
    if (parts.length < 2) die(`Cannot find workspace/repo in URL: ${tok}`)
    const out = { ws: parts[0], repo: parts[1] }
    const i = parts.findIndex(
      (p) => p === "pull-requests" || p === "pullrequests",
    )
    if (i !== -1 && parts[i + 1]) out.prId = Number(parts[i + 1])
    return out
  }
  const parts = tok.split("/").filter(Boolean)
  if (parts.length === 2) return { ws: parts[0], repo: parts[1] }
  if (parts.length === 1 && process.env.BITBUCKET_WORKSPACE)
    return { ws: process.env.BITBUCKET_WORKSPACE, repo: parts[0] }
  return die(
    `Cannot parse repository "${tok}". Use <workspace>/<repo> or a Bitbucket URL.`,
  )
}

/** Resolve "<target> [rest...]" for repo-scoped commands. */
function repoCtx(ctx, needs = 0) {
  const t = parseRepoToken(ctx.pos[0])
  const rest = ctx.pos.slice(1)
  if (rest.length < needs)
    die(
      `Expected ${needs} more argument(s) after the repository. See: node bb.mjs help ${ctx.cmd}`,
    )
  return { ...t, rest, base: `/repositories/${enc(t.ws)}/${enc(t.repo)}` }
}

/** PR commands accept "<ws>/<repo> <id>" or a PR URL. */
function prCtx(ctx, extra = 0) {
  const t = repoCtx(ctx, 0)
  let id = t.prId
  let rest = t.rest
  if (id === undefined) {
    id = int(rest[0], "Pull request id")
    rest = rest.slice(1)
  }
  if (!id)
    die('Missing pull request id (pass "<ws>/<repo> <id>" or the PR URL).')
  if (rest.length < extra)
    die(`Missing argument. See: node bb.mjs help ${ctx.cmd}`)
  // main's count assumes "<ws>/<repo> <id>"; a PR URL carries the id, so it allows one argument fewer.
  if (rest.length > extra) die(unexpectedArg(C[ctx.cmd], rest[extra]))
  return { ...t, id, rest, pr: `${t.base}/pullrequests/${id}` }
}

// ---------------------------------------------------------------- ref resolution

const isNotFound = (e) => e instanceof ApiError && e.status === 404

// Errors propagate: guessing 'main' after an outage or a 404 would surface later as a misleading "could not resolve ref 'main'".
async function defaultBranch(base) {
  const r = await getJson(buildUrl(base))
  return r.mainbranch?.name || "main"
}

/** branch -> tag -> commit, suppressing only 404s (names with "/" only work this way). A full SHA is tried as a commit first. */
async function resolveRef(base, ref) {
  const paths = [
    `${base}/refs/branches/${enc(ref)}`,
    `${base}/refs/tags/${enc(ref)}`,
    `${base}/commit/${enc(ref)}`,
  ]
  if (/^[0-9a-f]{40}$/i.test(ref)) paths.unshift(paths.pop())
  for (const p of paths) {
    try {
      const r = await getJson(buildUrl(p))
      const h = r?.target?.hash || r?.hash
      if (h) return h
    } catch (e) {
      if (!isNotFound(e)) throw e
    }
  }
  return null
}

// ---------------------------------------------------------------- formatters

function pageNote(r, ctx) {
  if (r.truncated)
    return "\n(stopped at --max-pages; more results exist — raise --max-pages or narrow with --q)"
  if (r.next)
    return `\n(more results — rerun with --page ${(int(ctx.flags.page, "--page") || 1) + 1} or --all)`
  return ""
}
const none = (what) => `No ${what} found.`

/** "Title (N total):" + one entry per item + the paging footer, or "No <what> found." The footer cannot be forgotten. */
function listText(title, r, ctx, fmt, what, sep = "\n") {
  if (!r.values?.length) return none(what)
  const count = r.size != null ? ` (${r.size} total)` : ""
  return `${title}${count}:\n${r.values.map(fmt).join(sep)}${pageNote(r, ctx)}`
}

const commitLine = (c) =>
  `- ${short(c.hash)} ${first(c.message)}\n    ${commitAuthor(c)}  ${c.date}`

const statusLine = (s) =>
  `- ${s.state}  ${s.name || s.key}${s.description ? ` — ${s.description}` : ""}${s.url ? `\n    ${s.url}` : ""}`

function diffstatText(label, r) {
  if (!r.values?.length) return `No changes found for ${label}.`
  const added = r.values.reduce((s, e) => s + lineCount(e.lines_added), 0)
  const removed = r.values.reduce((s, e) => s + lineCount(e.lines_removed), 0)
  const lines = r.values.map((e) => {
    const st = (e.status || "").toUpperCase()
    const counts = `(+${lineCount(e.lines_added)} -${lineCount(e.lines_removed)})`
    return e.status === "renamed"
      ? `  ${st}: ${e.old?.path} -> ${e.new?.path}  ${counts}`
      : `  ${st}: ${e.new?.path || e.old?.path}  ${counts}`
  })
  return `Diffstat for ${label}: ${r.values.length} file(s), +${added} -${removed}\n\n${lines.join("\n")}`
}

function commentLine(c) {
  const where = c.inline
    ? ` [${c.inline.path}:${c.inline.to ?? c.inline.from ?? "?"}]`
    : ""
  const reply = c.parent ? ` (reply to #${c.parent.id})` : ""
  const del = c.deleted ? " [deleted]" : ""
  return `#${c.id} ${who(c.user)} ${c.created_on}${where}${reply}${del}\n  ${(c.content?.raw || "(no content)").split("\n").join("\n  ")}`
}

function pipelineState(s) {
  return s?.result?.name || s?.stage?.name || s?.name || "UNKNOWN"
}
function duration(sec) {
  if (sec == null) return "n/a"
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  return m < 60
    ? `${m}m ${sec % 60}s`
    : `${Math.floor(m / 60)}h ${m % 60}m ${sec % 60}s`
}

// ---------------------------------------------------------------- commands
// Each command: { usage, summary, run(ctx) -> { data, text, keepTail?, exitCode? } }
// paged: the command reads a list endpoint with getList, so it takes the paging flags;
// query: it also takes --q/--sort (default: same as paged).

const C = {}
const def = (name, usage, summary, run, { paged = false, query = paged } = {}) =>
  (C[name] = { name, usage, summary, run, paged, query })

// --- setup / meta
def(
  "check",
  "check",
  "Verify configuration and credentials (never prints secrets)",
  async () => {
    const lines = [
      `bb.mjs version: ${VERSION}`,
      `API base: ${BASE}`,
      `BITBUCKET_EMAIL: ${process.env.BITBUCKET_EMAIL ? "set" : "NOT SET"}`,
      `BITBUCKET_API_TOKEN: ${process.env.BITBUCKET_API_TOKEN ? "set" : "NOT SET"}`,
      `BITBUCKET_WORKSPACE: ${process.env.BITBUCKET_WORKSPACE || "(not set)"}`,
      `Proxy: ${proxyConfigured() ? (proxyIgnored() ? "HTTPS_PROXY/HTTP_PROXY set but NODE_USE_ENV_PROXY=1 is missing, so Node ignores it" : "set and honoured") : "none configured"}`,
    ]
    if (!hasCreds()) {
      lines.push(
        "",
        "No credentials: only public repositories are reachable. Set the two variables in your OS/user environment (not in chat), then open a new terminal.",
      )
      return { data: { authenticated: false }, text: lines.join("\n") }
    }
    try {
      const u = await getJson(buildUrl("/user"))
      lines.push(
        "",
        `Authenticated as: ${who(u)} (${u.account_id || u.uuid || "id unavailable"})`,
      )
      return { data: { authenticated: true, user: u }, text: lines.join("\n") }
    } catch (e) {
      // 403 means the credentials were accepted; only the account endpoint is out of the token's scope.
      if (e instanceof ApiError && e.status === 403) {
        lines.push(
          "",
          "Credentials accepted, but the token cannot read your account (needs the read:user:bitbucket scope). Repository commands may still work.",
        )
        return {
          data: { authenticated: true, account_read: false },
          text: lines.join("\n"),
        }
      }
      lines.push("", `Auth check failed: ${e.message}`, hintFor(e))
      return {
        data: { authenticated: false },
        text: lines.join("\n"),
        exitCode: 1,
      }
    }
  },
)

def(
  "get",
  "get <api-path-or-url>",
  "Generic read-only GET for any v2.0 endpoint not covered below, e.g. get repositories/ws/repo/default-reviewers (no leading slash: Git Bash on Windows rewrites it). JSON or text is auto-detected.",
  async (ctx) => {
    const target = ctx.pos[0] || die("Missing API path or URL.")
    if (/^[A-Za-z]:[\\/]/.test(target))
      die(
        "That path looks like it was rewritten by Git Bash (MSYS). Pass it without a leading slash, e.g. get repositories/ws/repo.",
      )
    const url = /^https?:\/\//.test(target)
      ? target
      : BASE + (target.startsWith("/") ? target : `/${target}`)
    const { body, contentType } = await rawGet(url, { accept: "*/*" })
    if (contentType.includes("json")) {
      const data = parseJson(body, contentType, url)
      return { data, text: JSON.stringify(data, null, 2) }
    }
    return { data: { text: body }, text: body }
  },
)

// --- workspaces & users
def(
  "workspaces",
  "workspaces",
  "List workspaces you can access",
  async (ctx) => {
    // GET /workspaces now 404s. /user/workspaces returns workspace_access objects whose nested
    // workspace has slug and uuid but no name; `workspace <slug>` gives the full details.
    const r = await getList(ctx, "/user/workspaces")
    const text = listText(
      "Workspaces",
      r,
      ctx,
      (v) =>
        `- ${v.workspace.slug}${v.administrator ? "  (administrator)" : ""}`,
      "workspaces",
    )
    return { data: r, text }
  },
  { paged: true },
)

def("workspace", "workspace <workspace>", "Workspace details", async (ctx) => {
  const w = await getJson(
    buildUrl(`/workspaces/${enc(ctx.pos[0] || die("Missing workspace."))}`),
  )
  return {
    data: w,
    text: `Workspace: ${w.name} (${w.slug})\nUUID: ${w.uuid}\nCreated: ${w.created_on || "unknown"}`,
  }
})

def("me", "me", "The authenticated user", async () => {
  const u = await getJson(buildUrl("/user"))
  return {
    data: u,
    text: `User: ${who(u)}${u.nickname ? ` (@${u.nickname})` : ""}\nAccount ID: ${u.account_id}\nUUID: ${u.uuid}`,
  }
})

def(
  "user",
  "user <username-or-uuid>",
  "Look up a user (UUID in braces or account id)",
  async (ctx) => {
    const u = await getJson(
      buildUrl(`/users/${enc(ctx.pos[0] || die("Missing user."))}`),
    )
    return {
      data: u,
      text: `User: ${who(u)}${u.nickname ? ` (@${u.nickname})` : ""}\nAccount ID: ${u.account_id || "n/a"}\nUUID: ${u.uuid || "n/a"}\nLocation: ${u.location || "n/a"}`,
    }
  },
)

// --- repositories
const repoLine = (r) =>
  `- ${r.full_name}  [${r.language || "?"}, ${r.is_private ? "private" : "public"}, updated ${r.updated_on}]${r.description ? `\n    ${first(r.description)}` : ""}`

def(
  "repos",
  "repos <workspace>",
  "List repositories in a workspace (supports --q, --sort)",
  async (ctx) => {
    const r = await getList(
      ctx,
      `/repositories/${enc(ctx.pos[0] || process.env.BITBUCKET_WORKSPACE || die("Missing workspace."))}`,
    )
    return {
      data: r,
      text: listText("Repositories", r, ctx, repoLine, "repositories"),
    }
  },
  { paged: true },
)

def(
  "search-repos",
  "search-repos <workspace> <query>",
  "Find repositories by name/description (server-side BBQL)",
  async (ctx) => {
    const ws = ctx.pos[0] || die("Missing workspace.")
    const query = ctx.pos[1] || die("Missing query.")
    const lit = bbqlString(query)
    const r = await getList(ctx, `/repositories/${enc(ws)}`, {
      q: `name ~ ${lit} OR description ~ ${lit}`,
      pagelen: MAX_PAGELEN,
    })
    return {
      data: r,
      text: listText(
        `Repositories matching "${query}"`,
        r,
        ctx,
        repoLine,
        "matching repositories",
      ),
    }
  },
  { paged: true },
)

def(
  "repo",
  "repo <ws>/<repo>",
  "Repository details (includes default branch)",
  async (ctx) => {
    const t = repoCtx(ctx)
    const r = await getJson(buildUrl(t.base))
    return {
      data: r,
      text: [
        `Repository: ${r.full_name}`,
        `Description: ${r.description || "none"}`,
        `Language: ${r.language || "n/a"}`,
        `Private: ${r.is_private}`,
        `Default branch: ${r.mainbranch?.name || "n/a"}`,
        `Created: ${r.created_on}`,
        `Updated: ${r.updated_on}`,
        `Size: ${r.size ?? "n/a"} bytes`,
        `Clone/HTML: ${r.links?.html?.href || "n/a"}`,
      ].join("\n"),
    }
  },
)

def(
  "browse",
  "browse <ws>/<repo> [path] [--ref REF] [--limit N]",
  "List a directory (or show a file if path is a file)",
  async (ctx) => {
    const t = repoCtx(ctx)
    const path = (t.rest[0] || "").replace(/^\/+|\/+$/g, "")
    const ref = ctx.flags.ref || (await defaultBranch(t.base))
    const limit = Math.min(int(ctx.flags.limit, "--limit") ?? 50, MAX_PAGELEN)
    // The root too goes through /src/{sha}/: bare /src redirects to the main branch and its "at" is undocumented.
    const sha = await resolveRef(t.base, ref)
    if (!sha)
      die(
        `Could not resolve ref '${ref}' in ${t.ws}/${t.repo}. Use "branches" or "tags" to list refs.`,
      )
    const dirUrl = buildUrl(
      `${t.base}/src/${sha}/${path ? `${encPath(path)}/` : ""}`,
      { pagelen: limit },
    )
    let r
    try {
      const res = await rawGet(dirUrl)
      if (!res.contentType.includes("json"))
        return fileResult(res.body, path, ref, ctx)
      r = parseJson(res.body, res.contentType, dirUrl)
    } catch (e) {
      if (!path || !isNotFound(e)) throw e
      // not a directory — maybe a file
      return fileResult(
        await getText(buildUrl(`${t.base}/src/${sha}/${encPath(path)}`)),
        path,
        ref,
        ctx,
      )
    }
    const items = (r.values || []).map(
      (i) =>
        `${i.type === "commit_directory" ? "d" : "f"}  ${i.path}${i.size ? `  (${i.size} bytes)` : ""}`,
    )
    return {
      data: r,
      text: `${t.ws}/${t.repo} @ ${ref}  /${path}\n${items.join("\n") || "(empty)"}${r.next ? "\n(more entries — raise --limit up to 100, or browse a subdirectory)" : ""}`,
    }
  },
)

function fileResult(content, path, ref, ctx) {
  // Same heuristic as git: a NUL byte in the first 8000 chars means binary. The body was decoded as text, so it would be garbage.
  if (content.slice(0, 8000).includes("\0")) {
    return {
      data: { file_path: path, ref, binary: true },
      text: `File: ${path} @ ${ref} looks like a binary file (contains NUL bytes); content not shown.`,
    }
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  const lines = content === "" ? [] : content.split(/\r?\n/)
  // A final line ending terminates the last line; it does not start an empty extra one.
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  if (!lines.length)
    return {
      data: { file_path: path, ref, total_lines: 0, content: "" },
      text: `File: ${path} @ ${ref} is empty.`,
    }
  const start = int(ctx.flags.start, "--start") ?? 1
  const limit = Math.min(int(ctx.flags.limit, "--limit") ?? 1000, 10000)
  if (start > lines.length)
    die(
      `--start ${start} is past the end of ${path}, which has ${lines.length} line(s).`,
    )
  const end = Math.min(start + limit - 1, lines.length)
  const slice = lines.slice(start - 1, end)
  const data = {
    file_path: path,
    ref,
    total_lines: lines.length,
    start,
    end,
    content: slice.join(eol),
  }
  if (ctx.flags.raw) return { data, text: data.content }
  const body = slice.map((l, i) => `${start + i}: ${l}`).join("\n")
  const more =
    end < lines.length
      ? `\n(… ${lines.length - end} more lines; use --start ${end + 1})`
      : ""
  return {
    data,
    text: `File: ${path} @ ${ref} (lines ${start}-${end} of ${lines.length})\n\n${body}${more}`,
  }
}

def(
  "file",
  "file <ws>/<repo> <path> [--ref REF] [--start N] [--limit N] [--raw]",
  "Read a file (line-numbered; paginated, default 1000 lines)",
  async (ctx) => {
    const t = repoCtx(ctx, 1)
    const path = t.rest[0].replace(/^\/+/, "")
    const ref = ctx.flags.ref || (await defaultBranch(t.base))
    const sha = await resolveRef(t.base, ref)
    if (!sha)
      die(
        `Could not resolve ref '${ref}' in ${t.ws}/${t.repo}. If you have the PR head commit SHA, pass it as --ref.`,
      )
    const content = await getText(
      buildUrl(`${t.base}/src/${sha}/${encPath(path)}`),
    )
    return fileResult(content, path, ref, ctx)
  },
)

def(
  "file-history",
  "file-history <ws>/<repo> <commit-or-branch> <path>",
  "Commits that touched a file",
  async (ctx) => {
    const t = repoCtx(ctx, 2)
    const [commit, path] = t.rest
    // Resolve first, like file/browse: a branch name with "/" would not survive as one encoded segment.
    const sha = await resolveRef(t.base, commit)
    if (!sha)
      die(
        `Could not resolve ref '${commit}' in ${t.ws}/${t.repo}. Use "branches" or "tags" to list refs.`,
      )
    const r = await getList(
      ctx,
      `${t.base}/filehistory/${sha}/${encPath(path.replace(/^\/+/, ""))}`,
    )
    const text = listText(
      `History of ${path} from ${commit}`,
      r,
      ctx,
      (e) =>
        commitLine(e.commit) +
        (e.size != null ? `  (${e.size} bytes)` : ""),
      "history",
    )
    return { data: r, text }
  },
  { paged: true },
)

// --- branches, tags, commits
def(
  "branches",
  "branches <ws>/<repo>",
  "List branches (supports --q, --sort)",
  async (ctx) => {
    const t = repoCtx(ctx)
    const r = await getList(ctx, `${t.base}/refs/branches`)
    return {
      data: r,
      text: listText(
        `Branches in ${t.ws}/${t.repo}`,
        r,
        ctx,
        (b) => `- ${b.name}  ${short(b.target.hash)}  ${b.target.date}`,
        "branches",
      ),
    }
  },
  { paged: true },
)

def(
  "branch",
  "branch <ws>/<repo> <name>",
  "Branch details (head commit, merge strategies)",
  async (ctx) => {
    const t = repoCtx(ctx, 1)
    const b = await getJson(
      buildUrl(`${t.base}/refs/branches/${enc(t.rest[0])}`),
    )
    return {
      data: b,
      text: [
        `Branch: ${b.name}`,
        `Head: ${b.target.hash}`,
        `Date: ${b.target.date}`,
        `Author: ${commitAuthor(b.target)}`,
        `Message: ${first(b.target.message)}`,
        b.merge_strategies
          ? `Merge strategies: ${b.merge_strategies.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    }
  },
)

def(
  "tags",
  "tags <ws>/<repo>",
  "List tags (supports --q, --sort e.g. --sort -target.date)",
  async (ctx) => {
    const t = repoCtx(ctx)
    const r = await getList(ctx, `${t.base}/refs/tags`)
    return {
      data: r,
      text: listText(
        `Tags in ${t.ws}/${t.repo}`,
        r,
        ctx,
        (g) => `- ${g.name}  ${short(g.target.hash)}  ${g.target.date}`,
        "tags",
      ),
    }
  },
  { paged: true },
)

def("tag", "tag <ws>/<repo> <name>", "Tag details", async (ctx) => {
  const t = repoCtx(ctx, 1)
  const g = await getJson(buildUrl(`${t.base}/refs/tags/${enc(t.rest[0])}`))
  return {
    data: g,
    text: [
      `Tag: ${g.name}`,
      `Commit: ${g.target.hash}`,
      `Date: ${g.target.date}`,
      `Author: ${commitAuthor(g.target)}`,
      g.message ? `Tag message: ${g.message.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }
})

def(
  "commits",
  "commits <ws>/<repo> [--branch NAME]",
  "Commit history (default branch unless --branch)",
  async (ctx) => {
    const t = repoCtx(ctx)
    const ref = ctx.flags.branch
    let sha
    if (ref) {
      sha = await resolveRef(t.base, ref)
      if (!sha)
        die(
          `Could not resolve ref '${ref}' in ${t.ws}/${t.repo}. Use "branches" or "tags" to list refs.`,
        )
    }
    const r = await getList(ctx, `${t.base}/commits${sha ? `/${sha}` : ""}`)
    return {
      data: r,
      text: listText(
        `Commits in ${t.ws}/${t.repo}${ref ? ` (${ref})` : ""}`,
        r,
        ctx,
        commitLine,
        "commits",
      ),
    }
  },
  { paged: true },
)

def("commit", "commit <ws>/<repo> <hash>", "Commit details", async (ctx) => {
  const t = repoCtx(ctx, 1)
  const c = await getJson(buildUrl(`${t.base}/commit/${enc(t.rest[0])}`))
  return {
    data: c,
    text: [
      `Commit: ${c.hash}`,
      `Author: ${commitAuthor(c)}`,
      `Date: ${c.date}`,
      `Parents: ${(c.parents || []).map((p) => short(p.hash)).join(", ") || "none"}`,
      "",
      c.message.trim(),
    ].join("\n"),
  }
})

def(
  "commit-statuses",
  "commit-statuses <ws>/<repo> <hash>",
  "CI/build statuses for a commit",
  async (ctx) => {
    const t = repoCtx(ctx, 1)
    // Status lists are short and you nearly always want all of them, so ask for a full page.
    const r = await getList(
      ctx,
      `${t.base}/commit/${enc(t.rest[0])}/statuses`,
      { pagelen: MAX_PAGELEN },
    )
    return {
      data: r,
      text: listText(
        `Build statuses for ${short(t.rest[0])}`,
        r,
        ctx,
        statusLine,
        "build statuses",
      ),
    }
  },
  { paged: true },
)

def(
  "merge-base",
  "merge-base <ws>/<repo> <rev1>..<rev2>",
  "Common ancestor of two refs",
  async (ctx) => {
    const t = repoCtx(ctx, 1)
    const m = await getJson(
      buildUrl(`${t.base}/merge-base/${rangeSpec(t.rest[0])}`),
    )
    return {
      data: m,
      text: `Merge base of ${t.rest[0]}: ${m.hash}\n${m.date || ""}${m.message ? `\n${first(m.message)}` : ""}`,
    }
  },
)

// --- diffs
function diffParams(ctx, withContext) {
  const p = { path: ctx.flags.path }
  if (withContext) p.context = int(ctx.flags.context, "--context", 0)
  return p
}

def(
  "diff",
  "diff <ws>/<repo> <spec> [--path FILE] [--context N] [--ignore-whitespace] [--topic]",
  'Unified diff for a commit ("<hash>") or range ("<a>..<b>")',
  async (ctx) => {
    const t = repoCtx(ctx, 1)
    const spec = t.rest[0]
    const p = {
      ...diffParams(ctx, true),
      ignore_whitespace: ctx.flags["ignore-whitespace"] || undefined,
      topic: ctx.flags.topic || undefined,
    }
    const diff = await getText(buildUrl(`${t.base}/diff/${rangeSpec(spec)}`, p))
    return {
      data: { diff },
      text: diff.trim() ? diff : `No changes found for ${spec}.`,
    }
  },
)

def(
  "diffstat",
  "diffstat <ws>/<repo> <spec> [--path FILE] [--ignore-whitespace] [--topic]",
  "Per-file change summary for a commit or range",
  async (ctx) => {
    const t = repoCtx(ctx, 1)
    const spec = t.rest[0]
    const r = await getList(ctx, `${t.base}/diffstat/${rangeSpec(spec)}`, {
      path: ctx.flags.path,
      ignore_whitespace: ctx.flags["ignore-whitespace"] || undefined,
      topic: ctx.flags.topic || undefined,
      pagelen: MAX_PAGELEN,
    })
    return {
      data: r,
      text: diffstatText(`${spec} in ${t.ws}/${t.repo}`, r) + pageNote(r, ctx),
    }
  },
  { paged: true },
)

// --- pull requests
def(
  "prs",
  "prs <ws>/<repo> [--state OPEN|MERGED|DECLINED|SUPERSEDED] [--q BBQL]",
  "List pull requests (open only unless --state is given)",
  async (ctx) => {
    const t = repoCtx(ctx)
    const state = ctx.flags.state && ctx.flags.state.toUpperCase()
    const r = await getList(ctx, `${t.base}/pullrequests`, { state })
    // Bitbucket returns only OPEN PRs when no state is given; say so, or "no PR for X" reads as "never existed".
    const openOnly = !state && !/\bstate\b/.test(ctx.flags.q || "")
    const label = state
      ? `${state} pull requests`
      : openOnly
        ? "Open pull requests"
        : "Pull requests"
    const text =
      openOnly && !r.values.length
        ? `No open pull requests found in ${t.ws}/${t.repo}. Merged, declined and superseded PRs are only listed with --state.`
        : listText(
            `${label} in ${t.ws}/${t.repo}`,
            r,
            ctx,
            (p) =>
              `- #${p.id} [${p.state}] ${p.title}\n    ${who(p.author)}  ${p.source.branch.name} -> ${p.destination.branch.name}  created ${p.created_on}`,
            "pull requests",
          )
    return { data: r, text }
  },
  { paged: true },
)

def(
  "pr",
  "pr <ws>/<repo> <id>   |   pr <PR-URL>",
  "Pull request details (description, reviewers, participants)",
  async (ctx) => {
    const t = prCtx(ctx)
    const p = await getJson(buildUrl(t.pr))
    const parts = (p.participants || []).map(
      (x) =>
        `${who(x.user)}${x.approved ? " (approved)" : ""}${x.state ? ` [${x.state}]` : ""}`,
    )
    return {
      data: p,
      text: [
        `PR #${p.id}: ${p.title}`,
        `State: ${p.state}`,
        `Author: ${who(p.author)}`,
        `Branch: ${p.source.branch.name} -> ${p.destination.branch.name}`,
        `Source commit: ${p.source.commit?.hash || "n/a"}`,
        `Created: ${p.created_on}`,
        `Updated: ${p.updated_on}`,
        `Reviewers: ${(p.reviewers || []).map(who).join(", ") || "none"}`,
        `Participants: ${parts.join(", ") || "none"}`,
        `Comments: ${p.comment_count ?? "n/a"}`,
        "",
        "Description:",
        p.description || "(none)",
      ].join("\n"),
    }
  },
)

def(
  "pr-comments",
  "pr-comments <ws>/<repo> <id> [--all]",
  "All comments on a PR (with ids and reply links)",
  async (ctx) => {
    const t = prCtx(ctx)
    const r = await getList(ctx, `${t.pr}/comments`)
    return {
      data: r,
      text: listText(
        `Comments on PR #${t.id}`,
        r,
        ctx,
        commentLine,
        "comments",
        "\n\n",
      ),
    }
  },
  { paged: true },
)

def(
  "pr-comment",
  "pr-comment <ws>/<repo> <id> <comment-id>",
  "A single PR comment",
  async (ctx) => {
    const t = prCtx(ctx, 1)
    const c = await getJson(
      buildUrl(`${t.pr}/comments/${int(t.rest[0], "Comment id")}`),
    )
    return { data: c, text: commentLine(c) }
  },
)

def(
  "comment-thread",
  "comment-thread <ws>/<repo> <id> <comment-id>",
  "A comment plus all nested replies",
  async (ctx) => {
    const t = prCtx(ctx, 1)
    const rootId = int(t.rest[0], "Comment id")
    const root = await getJson(buildUrl(`${t.pr}/comments/${rootId}`))
    // Replies can sit on any page, so fetch them all: drop the user's paging/filter flags and lift the page cap.
    const all = await getList(
      { ...ctx, flags: { all: true, "max-pages": THREAD_MAX_PAGES } },
      `${t.pr}/comments`,
      { pagelen: MAX_PAGELEN },
    )
    const walk = (pid, depth) =>
      all.values
        .filter((c) => c.parent?.id === pid)
        .flatMap((c) => [{ c, depth }, ...walk(c.id, depth + 1)])
    const replies = walk(rootId, 1)
    const fmt = (c, d) =>
      commentLine(c)
        .split("\n")
        .map((l) => "  ".repeat(d) + l)
        .join("\n")
    const note = all.truncated
      ? `\n\n(WARNING: stopped after ${THREAD_MAX_PAGES} pages of PR comments; replies beyond that are missing from this thread)`
      : ""
    const text =
      [
        `Thread for comment #${rootId} on PR #${t.id}`,
        "",
        fmt(root, 0),
        ...replies.map(({ c, depth }) => `\n${fmt(c, depth)}`),
      ].join("\n") + note
    return {
      data: {
        root,
        replies: replies.map((x) => x.c),
        ...(all.truncated ? { truncated: true } : {}),
      },
      text,
    }
  },
)

def(
  "pr-activity",
  "pr-activity <ws>/<repo> <id>",
  "Reviews, approvals, comments, updates on a PR",
  async (ctx) => {
    const t = prCtx(ctx)
    const r = await getList(ctx, `${t.pr}/activity`)
    const line = (a) => {
      if (a.comment)
        return `- comment by ${who(a.comment.user)} (${a.comment.created_on}): ${first(a.comment.content?.raw)}`
      if (a.approval)
        return `- approval by ${who(a.approval.user)} (${a.approval.date})`
      if (a.changes_requested)
        return `- changes requested by ${who(a.changes_requested.user)} (${a.changes_requested.date})`
      if (a.update)
        return `- update by ${who(a.update.author)} (${a.update.date}): state=${a.update.state}${a.update.title ? ` title="${a.update.title}"` : ""}`
      // Every entry carries pull_request; name only the keys that say what kind of entry this is.
      return `- ${Object.keys(a).filter((k) => k !== "pull_request").join(", ") || "unknown activity"}`
    }
    return {
      data: r,
      text: listText(`Activity on PR #${t.id}`, r, ctx, line, "activity"),
    }
  },
  { paged: true },
)

def(
  "pr-diff",
  "pr-diff <ws>/<repo> <id> [--path FILE] [--context N]",
  "Unified diff of a PR (use --path for one file; check pr-diffstat first on big PRs)",
  async (ctx) => {
    const t = prCtx(ctx)
    const diff = await getText(buildUrl(`${t.pr}/diff`, diffParams(ctx, true)))
    return {
      data: { diff },
      text: diff.trim() ? diff : `No changes found in PR #${t.id}.`,
    }
  },
)

def(
  "pr-diffstat",
  "pr-diffstat <ws>/<repo> <id> [--path FILE]",
  "Per-file +/- summary of a PR",
  async (ctx) => {
    const t = prCtx(ctx)
    const r = await getList(ctx, `${t.pr}/diffstat`, {
      path: ctx.flags.path,
      pagelen: MAX_PAGELEN,
    })
    return {
      data: r,
      text:
        diffstatText(`PR #${t.id} in ${t.ws}/${t.repo}`, r) + pageNote(r, ctx),
    }
  },
  { paged: true },
)

def(
  "pr-commits",
  "pr-commits <ws>/<repo> <id>",
  "Commits in a PR",
  async (ctx) => {
    const t = prCtx(ctx)
    const r = await getList(ctx, `${t.pr}/commits`)
    return {
      data: r,
      text: listText(`Commits in PR #${t.id}`, r, ctx, commitLine, "commits"),
    }
  },
  { paged: true },
)

def(
  "pr-statuses",
  "pr-statuses <ws>/<repo> <id>",
  "CI/build statuses for a PR",
  async (ctx) => {
    const t = prCtx(ctx)
    const r = await getList(ctx, `${t.pr}/statuses`, { pagelen: MAX_PAGELEN })
    return {
      data: r,
      text: listText(
        `Build statuses for PR #${t.id}`,
        r,
        ctx,
        statusLine,
        "build statuses",
      ),
    }
  },
  { paged: true },
)

def(
  "pr-context",
  "pr-context <ws>/<repo> <id> [--full]   |   pr-context <PR-URL> [--full]   |   pr-context <ws>/<repo> --branch NAME",
  "One-shot PR briefing: metadata, diffstat totals, build status, recent comments",
  async (ctx) => {
    const t = repoCtx(ctx)
    let id = t.prId
    const rest = [...t.rest]
    if (id === undefined && rest.length) {
      if (!/^\d+$/.test(rest[0]))
        die(
          `"${rest[0]}" is not a pull request id.${ctx.flags.branch ? "" : ` To find the open PR for a branch, use --branch ${rest[0]}.`}`,
        )
      id = Number(rest.shift())
    }
    if (rest.length) die(unexpectedArg(C["pr-context"], rest[0]))
    if (!id && ctx.flags.branch) {
      const branch = ctx.flags.branch
      const s = await getJson(
        buildUrl(`${t.base}/pullrequests`, {
          q: `source.branch.name=${bbqlString(branch)} AND state="OPEN"`,
          pagelen: 10,
        }),
      )
      const found = s.values || []
      if (!found.length)
        return {
          data: { found: false },
          text: `No open pull request found for branch "${branch}" in ${t.ws}/${t.repo}.`,
        }
      // A branch can have open PRs to several targets (develop, release/*); picking one silently would mislead.
      if (found.length > 1 || s.next)
        return {
          data: {
            found: false,
            candidates: found.map((p) => ({
              id: p.id,
              title: p.title,
              destination: p.destination?.branch?.name,
            })),
          },
          text: [
            `${s.size ?? found.length} open pull requests come from branch "${branch}" in ${t.ws}/${t.repo}. Pick one and rerun as: pr-context ${t.ws}/${t.repo} <id>`,
            ...found.map(
              (p) =>
                `- #${p.id} ${p.title}  (${p.source.branch.name} -> ${p.destination.branch.name})`,
            ),
            ...(s.next ? ["(more exist; list them with prs --q)"] : []),
          ].join("\n"),
        }
      id = found[0].id
    }
    if (!id)
      die(
        'Provide a PR URL, "<ws>/<repo> <id>", or "<ws>/<repo> --branch NAME".',
      )
    const full = Boolean(ctx.flags.full)
    const pr = `${t.base}/pullrequests/${id}`
    const p = await getJson(buildUrl(pr))
    // A failed section must not read as an empty one: keep the error so the briefing can say "unavailable".
    const errors = {}
    const soft = (key, f) =>
      f().catch((e) => {
        const hint = hintFor(e)
        errors[key] = hint ? `${e.message}. Hint: ${hint}` : e.message
        return null
      })
    const [ds, st, cm] = await Promise.all([
      // totals need every page; ignore the user's paging/filter flags (default 20-page cap, flagged below if hit)
      soft("diffstat", () =>
        getList({ ...ctx, flags: { all: true } }, `${pr}/diffstat`, {
          pagelen: MAX_PAGELEN,
        }),
      ),
      soft("statuses", () =>
        getJson(buildUrl(`${pr}/statuses`, { pagelen: MAX_PAGELEN })),
      ),
      // newest first; fall back to the default order only if the server rejects the sort (400), not on
      // auth errors or timeouts, which would just fail twice
      soft("comments", () =>
        getJson(
          buildUrl(`${pr}/comments`, {
            pagelen: full ? 20 : 3,
            sort: "-created_on",
          }),
        ).catch((e) => {
          if (!(e instanceof ApiError && e.status === 400)) throw e
          return getJson(
            buildUrl(`${pr}/comments`, { pagelen: full ? 20 : 3 }),
          )
        }),
      ),
    ])
    const unavailable = (key) => `Unavailable: ${errors[key]}`
    const L = [
      `=== PR #${p.id}: ${p.title} ===`,
      `State: ${p.state}`,
      `Author: ${who(p.author)}`,
      `Branch: ${p.source.branch.name} -> ${p.destination.branch.name}`,
      `Created: ${p.created_on}  Updated: ${p.updated_on}`,
    ]
    if (p.reviewers?.length)
      L.push(`Reviewers: ${p.reviewers.map(who).join(", ")}`)
    if (full && p.description) L.push("", "--- Description ---", p.description)
    L.push("", "--- Diffstat ---")
    if (ds?.values?.length) {
      const a = ds.values.reduce((s, e) => s + lineCount(e.lines_added), 0)
      const r = ds.values.reduce((s, e) => s + lineCount(e.lines_removed), 0)
      L.push(`${ds.values.length} file(s) changed, +${a} -${r}`)
      if (ds.truncated)
        L.push(
          `(WARNING: diffstat stopped after the first ${ds.values.length} files; totals are partial. Use pr-diffstat --all --max-pages N for the rest)`,
        )
      if (full) L.push(...diffstatText("", ds).split("\n").slice(2))
    } else
      L.push(
        errors.diffstat ? unavailable("diffstat") : "No diffstat available.",
      )
    L.push(
      "",
      "--- Build status ---",
      st?.values?.length
        ? st.values.map(statusLine).join("\n")
        : errors.statuses
          ? unavailable("statuses")
          : "No build statuses found.",
    )
    if (st?.next)
      L.push(
        `(WARNING: only the first ${st.values.length} build statuses are shown. Use pr-statuses --all for the rest)`,
      )
    L.push("", "--- Comments ---")
    if (cm?.values?.length) {
      L.push(
        `${cm.size ?? cm.values.length} comment(s) total; showing newest ${cm.values.length}:`,
        ...cm.values.map(commentLine),
      )
    } else L.push(errors.comments ? unavailable("comments") : "No comments.")
    return {
      data: {
        pull_request: p,
        diffstat: ds,
        statuses: st,
        comments: cm,
        errors,
      },
      text: L.join("\n"),
    }
  },
)

// --- pipelines
def(
  "pipelines",
  "pipelines <ws>/<repo>",
  "Recent pipeline runs (newest first)",
  async (ctx) => {
    const t = repoCtx(ctx)
    const r = await getList(ctx, `${t.base}/pipelines`, { sort: "-created_on" })
    const line = (p) =>
      [
        `- #${p.build_number} ${pipelineState(p.state)}`,
        p.target?.ref_name || "n/a",
        p.trigger?.name || "",
        duration(p.duration_in_seconds),
        `${p.created_on}\n    ${p.uuid}`,
      ].join("  ")
    return {
      data: r,
      text: listText(`Pipelines in ${t.ws}/${t.repo}`, r, ctx, line, "pipelines"),
    }
  },
  { paged: true },
)

def(
  "pipeline",
  "pipeline <ws>/<repo> <uuid>",
  "Pipeline run details",
  async (ctx) => {
    const t = repoCtx(ctx, 1)
    const p = await getJson(
      buildUrl(`${t.base}/pipelines/${enc(braces(t.rest[0]))}`),
    )
    return {
      data: p,
      text: [
        `Pipeline #${p.build_number}  ${pipelineState(p.state)}`,
        `Branch: ${p.target?.ref_name || "n/a"}`,
        `Commit: ${short(p.target?.commit?.hash)} ${first(p.target?.commit?.message)}`,
        `Trigger: ${p.trigger?.name || "n/a"}  Creator: ${who(p.creator)}`,
        `Duration: ${duration(p.duration_in_seconds)}`,
        `Created: ${p.created_on}${p.completed_on ? `  Completed: ${p.completed_on}` : ""}`,
        `UUID: ${p.uuid}`,
      ].join("\n"),
    }
  },
)

def(
  "pipeline-steps",
  "pipeline-steps <ws>/<repo> <pipeline-uuid>",
  "Steps of a pipeline run",
  async (ctx) => {
    const t = repoCtx(ctx, 1)
    // Parallel steps easily exceed the default page of 10, which could hide the failing one.
    const r = await getList(
      ctx,
      `${t.base}/pipelines/${enc(braces(t.rest[0]))}/steps`,
      { pagelen: MAX_PAGELEN },
    )
    return {
      data: r,
      text: listText(
        "Pipeline steps",
        r,
        ctx,
        (s, i) =>
          `- ${s.name || `Step ${i + 1}`}: ${pipelineState(s.state)}  ${duration(s.duration_in_seconds)}\n    ${s.uuid}`,
        "steps",
      ),
    }
  },
  { paged: true },
)

const LOG_404_HINT =
  "No log for this step. It may not have run yet (queued or skipped), its log may have expired under the retention period, or a UUID is wrong; list the steps with pipeline-steps."

/**
 * Fetch the end of a step log. Asks for only the last bytes with a Range request and falls back to the
 * full download when the server ignores it, rejects it (416) or the range turns out too short.
 * Returns { text (ANSI stripped), partial, totalBytes }.
 */
async function fetchStepLog(url, tail) {
  // The log endpoint answers 406 to Accept: text/plain; it only serves application/octet-stream.
  // It may redirect to log storage on another origin; that hop gets no credentials (see fetchChecked).
  const get = (headers = {}) =>
    rawGet(url, {
      accept: "application/octet-stream",
      headers,
      foreignRedirects: true,
    })
  const full = async () => ({
    text: stripAnsi((await get()).body),
    partial: false,
  })
  try {
    let res
    try {
      // 4 bytes per char covers UTF-8 and leaves room for colour codes that are stripped below.
      res = await get({ Range: `bytes=-${tail * 4}` })
    } catch (e) {
      if (e instanceof ApiError && e.status === 416) return await full()
      throw e
    }
    const m = /bytes (\d+)-\d+\/(\d+|\*)/.exec(
      res.headers.get("content-range") || "",
    )
    if (res.status !== 206 || !m || Number(m[1]) === 0)
      return { text: stripAnsi(res.body), partial: false }
    // The range starts mid-line (maybe mid-character or mid-escape-code): drop that first partial line.
    let text = stripAnsi(res.body)
    text = text.slice(text.indexOf("\n") + 1)
    if (text.length < tail) return await full()
    return {
      text,
      partial: true,
      totalBytes: m[2] === "*" ? undefined : Number(m[2]),
    }
  } catch (e) {
    if (isNotFound(e)) e.hint = LOG_404_HINT
    throw e
  }
}

def(
  "pipeline-step-log",
  "pipeline-step-log <ws>/<repo> <pipeline-uuid> <step-uuid> [--tail CHARS]",
  "Build log of a step (last 50000 chars by default — failures are at the end; colour codes removed)",
  async (ctx) => {
    const t = repoCtx(ctx, 2)
    const tail = int(ctx.flags.tail, "--tail") ?? 50000
    const { text: log, partial, totalBytes } = await fetchStepLog(
      buildUrl(
        `${t.base}/pipelines/${enc(braces(t.rest[0]))}/steps/${enc(braces(t.rest[1]))}/log`,
      ),
      tail,
    )
    if (!log.trim())
      return { data: { log: "" }, text: "No log output found for this step." }
    const truncated = partial || log.length > tail
    const out = log.length > tail ? log.slice(-tail) : log
    const whole = partial
      ? totalBytes
        ? `a ${totalBytes}-byte log`
        : "a longer log"
      : `${log.length} chars`
    // keepTail: a global --max-chars must cut the start of this output, not the end, where the failure is.
    return {
      data: { log: out, truncated },
      text: `${truncated ? `(showing last ${out.length} chars of ${whole})\n` : ""}${out}`,
      keepTail: true,
    }
  },
)

// --- issues
def(
  "issues",
  "issues <ws>/<repo> [--state S] [--kind K] [--q BBQL]",
  "Issue tracker entries",
  async (ctx) => {
    const t = repoCtx(ctx)
    const clauses = []
    if (ctx.flags.state) clauses.push(`state=${bbqlString(ctx.flags.state)}`)
    if (ctx.flags.kind) clauses.push(`kind=${bbqlString(ctx.flags.kind)}`)
    const r = await getList(
      ctx,
      `${t.base}/issues`,
      clauses.length ? { q: clauses.join(" AND ") } : {},
    )
    const line = (i) =>
      [
        `- #${i.id} [${i.state}/${i.kind}/${i.priority}] ${i.title}`,
        `    reporter ${who(i.reporter)}, assignee ${i.assignee ? who(i.assignee) : "unassigned"}, created ${i.created_on}`,
      ].join("\n")
    return {
      data: r,
      text: listText(`Issues in ${t.ws}/${t.repo}`, r, ctx, line, "issues"),
    }
  },
  { paged: true },
)

def("issue", "issue <ws>/<repo> <id>", "Issue details", async (ctx) => {
  const t = repoCtx(ctx, 1)
  const i = await getJson(
    buildUrl(`${t.base}/issues/${int(t.rest[0], "Issue id")}`),
  )
  return {
    data: i,
    text: [
      `Issue #${i.id}: ${i.title}`,
      `State: ${i.state}  Kind: ${i.kind}  Priority: ${i.priority}`,
      `Reporter: ${who(i.reporter)}  Assignee: ${i.assignee ? who(i.assignee) : "unassigned"}`,
      `Created: ${i.created_on}  Updated: ${i.updated_on}`,
      "",
      i.content?.raw || "(no content)",
    ].join("\n"),
  }
})

// --- code search
def(
  "search-code",
  "search-code <workspace> <query> [--repo SLUG] [--language L] [--extension EXT]",
  "Code search across a workspace (needs code search enabled at bitbucket.org/search)",
  async (ctx) => {
    const ws = ctx.pos[0] || die("Missing workspace.")
    let q = ctx.pos[1] || die("Missing query.")
    if (ctx.flags.repo) q += ` repo:${ctx.flags.repo}`
    if (ctx.flags.language) q += ` language:${ctx.flags.language}`
    if (ctx.flags.extension) q += ` extension:${ctx.flags.extension}`
    const r = await getList(ctx, `/workspaces/${enc(ws)}/search/code`, {
      search_query: q,
    })
    // A path-only match has no content_matches, so every level is optional.
    const matchText = (v) => {
      const hits = v.content_matches || []
      const head = `${v.file.path} (${v.content_match_count ?? hits.length} matches)`
      const body = hits.flatMap((m) =>
        (m.lines || []).map(
          (l) =>
            `    ${l.line}: ${(l.segments || []).map((s) => (s.match ? `[[${s.text}]]` : s.text)).join("")}`,
        ),
      )
      return body.length ? `${head}\n${body.join("\n")}` : head
    }
    const text = listText(
      `Code search "${q}" in ${ws}`,
      r,
      ctx,
      matchText,
      "code matches",
      "\n\n",
    )
    return { data: r, text }
  },
  // The code search endpoint takes its filters inside search_query, not as BBQL --q/--sort.
  { paged: true, query: false },
)

// ---------------------------------------------------------------- output / main

/** --select a.b,c : project fields from each item of `values` (or from a single object). */
function project(data, select) {
  const paths = select
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const pick = (o) =>
    Object.fromEntries(
      paths.map((p) => [
        p,
        p.split(".").reduce((v, k) => (v == null ? v : v[k]), o),
      ]),
    )
  if (Array.isArray(data?.values)) {
    const { values, ...meta } = data
    return { ...meta, values: values.map(pick) }
  }
  return pick(data)
}

const listFlags = (c) =>
  c.paged
    ? c.query
      ? "list flags: --page --pagelen --all --max-pages --q --sort"
      : "list flags: --page --pagelen --all --max-pages (no --q/--sort)"
    : ""

function help(name) {
  if (name) {
    const c =
      C[name] || die(`Unknown command "${name}". Run: node bb.mjs help`)
    return [
      `node bb.mjs ${c.usage}`,
      `  ${c.summary}`,
      listFlags(c) && `  Also takes ${listFlags(c)}.`,
    ]
      .filter(Boolean)
      .join("\n")
  }
  const rows = Object.values(C).map(
    (c) => `  ${c.usage.padEnd(78)} ${c.summary}${c.paged ? "  [list]" : ""}`,
  )
  return [
    `Read-only Bitbucket Cloud CLI ${VERSION}.  node bb.mjs <command> [args] [flags]`,
    "",
    "Repo-scoped commands take <workspace>/<repo> (or a Bitbucket URL; or just <repo> if BITBUCKET_WORKSPACE is set).",
    "",
    ...rows,
    "",
    "Output flags (every command):",
    "  --json            raw API JSON instead of the compact text view",
    "  --select a,b.c    JSON output limited to these (dotted) fields per item; implies --json",
    "  --max-chars N     truncate output to N characters (keeps the end for pipeline-step-log)",
    "  -h, --help        show this help (or: help <command>)",
    "",
    "List flags (commands marked [list] only; search-code takes paging but not --q/--sort):",
    "  --page N --pagelen N (max 100)   paging",
    "  --all [--max-pages N]            follow every page (default cap 20 pages; raise it with --max-pages)",
    "  --q BBQL --sort FIELD            server-side filter / sort (e.g. --q 'state=\"OPEN\"' --sort -updated_on)",
    "",
    'Unknown flags, flags a command would ignore, and extra arguments are rejected. A flag value that starts with "--" must be written --flag=--value; an argument that starts with "-" goes after "--".',
  ].join("\n")
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2))
  const cmd = pos.shift()
  if (!cmd || cmd === "help" || flags.help) {
    console.log(help(cmd === "help" ? pos[0] : cmd))
    return
  }
  const command = C[cmd]
  if (!command) die(`Unknown command "${cmd}". Run: node bb.mjs help`)
  checkFlags(command, flags)
  checkArgs(command, pos)
  const { data, text, keepTail, exitCode } = await command.run({
    cmd,
    pos,
    flags,
  })
  if (exitCode) process.exitCode = exitCode
  let out
  let isText = false
  if (flags.select) out = JSON.stringify(project(data, flags.select), null, 2)
  else if (flags.json) out = JSON.stringify(data, null, 2)
  else {
    out = text
    isText = true
  }
  const max = int(flags["max-chars"], "--max-chars")
  if (max && out.length > max) {
    // JSON stays head-truncated (a tail slice would not be parseable); tail-first text keeps its end.
    out =
      keepTail && isText
        ? `… [truncated: showing last ${max} of ${out.length} chars]\n${out.slice(-max)}`
        : `${out.slice(0, max)}\n… [truncated at ${max} of ${out.length} chars]`
  }
  console.log(out)
}

/** True when this file is the script being run (not imported, e.g. by the tests). */
function invokedDirectly() {
  if (!process.argv[1]) return false
  let argv1
  try {
    argv1 = realpathSync(process.argv[1])
  } catch {
    argv1 = resolve(process.argv[1])
  }
  const self = fileURLToPath(import.meta.url)
  return process.platform === "win32"
    ? argv1.toLowerCase() === self.toLowerCase()
    : argv1 === self
}

if (invokedDirectly())
  main().catch((e) => {
    console.error(`Error: ${e.message}`)
    const hint = hintFor(e)
    if (hint) console.error(`Hint: ${hint}`)
    // Not process.exit(1): exiting while fetch's sockets are still closing trips a libuv assertion on Windows (exit 127).
    process.exitCode = 1
  })

// Pure helpers, exported for tests/bb.test.mjs.
export {
  C as commands,
  parseArgs,
  checkFlags,
  checkArgs,
  maxArgs,
  int,
  enc,
  encPath,
  parseRepoToken,
  rangeSpec,
  bbqlString,
  stripAnsi,
  project,
  fileResult,
  diffstatText,
  listText,
  duration,
  retryAfterMs,
  rootCause,
}
