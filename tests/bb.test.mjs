// Tests for scripts/bb.mjs. Run with: node --test tests/
// Unit tests import the pure helpers; end-to-end tests run the CLI against loopback mock servers
// (BITBUCKET_API_BASE=http://127.0.0.1:<port>/2.0, which the HTTPS check allows for loopback only).

import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  commands,
  parseArgs,
  checkFlags,
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
  duration,
} from "../scripts/bb.mjs"

const BB = fileURLToPath(new URL("../scripts/bb.mjs", import.meta.url))
const SHA = "a".repeat(40)
const SHA2 = "b".repeat(40)
const ctx = (flags = {}) => ({ flags })

// ---------------------------------------------------------------- unit

describe("parseArgs", () => {
  test("splits positionals and flags", () => {
    const { pos, flags } = parseArgs(["pr", "ws/repo", "1", "--json", "--path", "a.ts"])
    assert.deepEqual(pos, ["pr", "ws/repo", "1"])
    assert.deepEqual(flags, { json: true, path: "a.ts" })
  })
  test("rejects single-dash options instead of treating them as arguments", () => {
    assert.throws(() => parseArgs(["file", "ws/repo", "a", "-r", "main"]), /Unknown option -r/)
  })
  test('everything after "--" is positional', () => {
    assert.deepEqual(parseArgs(["search-code", "ws", "--", "-x"]).pos, ["search-code", "ws", "-x"])
  })
  test("a value flag does not swallow the next flag", () => {
    assert.throws(() => parseArgs(["prs", "ws/repo", "--q", "--json"]), /needs a value/)
  })
})

describe("checkFlags / maxArgs", () => {
  test("list flags only on list commands", () => {
    assert.throws(() => checkFlags(commands["pr-diff"], { q: "x" }), /not a list command/)
    assert.doesNotThrow(() => checkFlags(commands["prs"], { q: "x", all: true }))
  })
  test("search-code pages but takes no --q/--sort", () => {
    assert.doesNotThrow(() => checkFlags(commands["search-code"], { page: "2" }))
    assert.throws(() => checkFlags(commands["search-code"], { sort: "x" }), /not supported/)
  })
  test("typos get a suggestion", () => {
    assert.throws(() => checkFlags(commands["prs"], { pagelenn: "5" }), /Did you mean --pagelen/)
  })
  test("positional limits come from the usage string", () => {
    assert.equal(maxArgs(commands["commits"].usage), 1)
    assert.equal(maxArgs(commands["file"].usage), 2)
    assert.equal(maxArgs(commands["browse"].usage), 2)
    assert.equal(maxArgs(commands["merge-base"].usage), 2)
    assert.equal(maxArgs(commands["pr"].usage), 2)
    assert.equal(maxArgs(commands["pr-context"].usage), 2)
    assert.equal(maxArgs(commands["pipeline-step-log"].usage), 3)
  })
})

describe("value helpers", () => {
  test("int accepts whole numbers >= min only", () => {
    assert.equal(int("5", "--tail"), 5)
    assert.equal(int(undefined, "--tail"), undefined)
    assert.equal(int("0", "--context", 0), 0)
    for (const bad of ["0", "-1", "1.5", "abc"])
      assert.throws(() => int(bad, "--tail"), /--tail must be/)
  })
  test("enc and encPath reject dot segments", () => {
    assert.throws(() => enc(".."), /Invalid path segment/)
    assert.throws(() => encPath("../../x"), /Invalid path segment/)
    assert.equal(enc("feature/x"), "feature%2Fx")
    assert.equal(encPath("src/a b.ts"), "src/a%20b.ts")
  })
  test("rangeSpec", () => {
    assert.equal(rangeSpec("a..b"), "a..b")
    assert.equal(rangeSpec("feature/x..main"), "feature%2Fx..main")
    assert.throws(() => rangeSpec("a..b..c"), /Invalid revision/)
    assert.throws(() => rangeSpec("..."), /Invalid revision/)
  })
  test("bbqlString escapes backslashes and quotes", () => {
    assert.equal(bbqlString('a"b\\c'), '"a\\"b\\\\c"')
  })
  test("stripAnsi", () => {
    assert.equal(stripAnsi("\x1b[31mFAIL\x1b[0m done \x1b]0;title\x07"), "FAIL done ")
  })
  test("duration", () => {
    assert.equal(duration(null), "n/a")
    assert.equal(duration(59), "59s")
    assert.equal(duration(61), "1m 1s")
    assert.equal(duration(3661), "1h 1m 1s")
  })
  test("project picks dotted fields from each item", () => {
    const d = { size: 1, values: [{ id: 1, a: { b: 2 }, c: 3 }] }
    assert.deepEqual(project(d, "id,a.b"), { size: 1, values: [{ id: 1, "a.b": 2 }] })
  })
})

describe("parseRepoToken", () => {
  test("ws/repo and URLs", () => {
    assert.deepEqual(parseRepoToken("ws/repo"), { ws: "ws", repo: "repo" })
    assert.deepEqual(parseRepoToken("https://bitbucket.org/ws/repo/pull-requests/42"), {
      ws: "ws",
      repo: "repo",
      prId: 42,
    })
    assert.deepEqual(parseRepoToken("https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/7"), {
      ws: "ws",
      repo: "repo",
      prId: 7,
    })
  })
})

describe("fileResult", () => {
  test("a trailing newline does not add a line", () => {
    const r = fileResult("one\ntwo\n", "f.txt", "main", ctx())
    assert.equal(r.data.total_lines, 2)
    assert.match(r.text, /lines 1-2 of 2/)
  })
  test("CRLF files", () => {
    assert.equal(fileResult("a\r\nb\r\n", "f", "main", ctx()).data.total_lines, 2)
  })
  test("empty file", () => {
    assert.match(fileResult("", "f", "main", ctx()).text, /is empty/)
  })
  test("--start past the end is an error", () => {
    assert.throws(() => fileResult("a\nb\n", "f", "main", ctx({ start: "5" })), /past the end/)
  })
  test("paging hint", () => {
    const r = fileResult("1\n2\n3\n", "f", "main", ctx({ limit: "2" }))
    assert.match(r.text, /use --start 3/)
  })
})

// ---------------------------------------------------------------- end to end

const pr = (id, dest = "main") => ({
  id,
  title: `PR ${id}`,
  state: "OPEN",
  author: { display_name: "Ana" },
  source: { branch: { name: "feature/x" }, commit: { hash: SHA2 } },
  destination: { branch: { name: dest } },
  created_on: "2026-01-01",
  updated_on: "2026-01-02",
  participants: [],
  reviewers: [],
})
const statuses = (n) =>
  Array.from({ length: n }, (_, i) => ({ state: "SUCCESSFUL", key: `build-${i}`, name: `Build ${i}` }))

const LOG =
  Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n") +
  "\n\x1b[31mFAILURE: boom\x1b[0m\n"

let api
let foreign
let apiBase
const seen = [] // { path, query, auth, range }
const foreignSeen = []

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function apiHandler(req, res) {
  const u = new URL(req.url, "http://x")
  const path = u.pathname
  seen.push({ path, query: u.searchParams, auth: Boolean(req.headers.authorization), range: req.headers.range })
  const R = "/2.0/repositories/ws/repo"
  const token = req.headers.authorization
    ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":")[1]
    : ""

  if (path === "/2.0/user") {
    if (token === "bad") return sendJson(res, 401, { error: { message: "Unauthorized" } })
    if (token === "noscope") return sendJson(res, 403, { error: { message: "Forbidden" } })
    return sendJson(res, 200, { display_name: "Me", account_id: "1" })
  }
  if (path === "/2.0/redir-foreign") {
    res.writeHead(302, { location: `${foreign}/other` })
    return res.end()
  }
  if (path === R) return sendJson(res, 200, { full_name: "ws/repo", mainbranch: { name: "main" } })
  if (path === `${R}/refs/branches/main`) return sendJson(res, 200, { name: "main", target: { hash: SHA } })
  if (path === `${R}/refs/branches/feature%2Fx`) return sendJson(res, 200, { name: "feature/x", target: { hash: SHA2 } })
  if (path === `${R}/src/${SHA}/`)
    return sendJson(res, 200, { values: [{ type: "commit_file", path: "two.txt", size: 8 }] })
  if (path === `${R}/src/${SHA}/two.txt/`) return sendJson(res, 404, { error: { message: "not a dir" } })
  if (path === `${R}/src/${SHA}/two.txt`) {
    res.writeHead(200, { "content-type": "text/plain" })
    return res.end("one\ntwo\n")
  }
  if (path === `${R}/filehistory/${SHA2}/src/a.ts`)
    return sendJson(res, 200, {
      values: [{ commit: { hash: SHA2, message: "Edit a", date: "2026-01-01", author: { raw: "Ana" } } }],
    })
  if (path === `${R}/commits`) return sendJson(res, 200, { values: [] })
  if (path === `${R}/pullrequests`) {
    if ((u.searchParams.get("q") || "").includes('"dup"'))
      return sendJson(res, 200, { size: 2, values: [pr(5, "develop"), pr(6, "release/2")] })
    return sendJson(res, 200, { size: 0, values: [] })
  }
  if (path === `${R}/pullrequests/1` || path === `${R}/pullrequests/2`) return sendJson(res, 200, pr(Number(path.slice(-1))))
  if (/\/pullrequests\/[12]\/diffstat$/.test(path))
    return sendJson(res, 200, { values: [{ status: "modified", new: { path: "a.ts" }, lines_added: 1, lines_removed: 0 }] })
  if (/\/pullrequests\/[12]\/statuses$/.test(path))
    return sendJson(res, 200, { size: 12, values: statuses(10), next: `${apiBase}${R}/pullrequests/1/statuses?page=2` })
  if (path === `${R}/pullrequests/1/comments`) return sendJson(res, 200, { size: 0, values: [] })
  if (path === `${R}/pullrequests/2/comments`) return sendJson(res, 403, { error: { message: "Forbidden" } })
  if (path === `${R}/pullrequests/1/activity`)
    return sendJson(res, 200, {
      values: [
        { changes_requested: { user: { display_name: "Dana" }, date: "2026-01-03" }, pull_request: { id: 1 } },
        { approval: { user: { display_name: "Eli" }, date: "2026-01-04" }, pull_request: { id: 1 } },
      ],
    })
  if (path === `${R}/pipelines/%7Bp%7D/steps`)
    return sendJson(res, 200, {
      values: statuses(10).map((s, i) => ({ name: `step ${i}`, state: { name: "COMPLETED" }, uuid: `{s${i}}` })),
      next: `${apiBase}${R}/pipelines/%7Bp%7D/steps?page=2`,
    })
  if (path === `${R}/pipelines/%7Bp%7D/steps/%7Bs%7D/log`) {
    const buf = Buffer.from(LOG)
    const m = /^bytes=-(\d+)$/.exec(req.headers.range || "")
    if (m) {
      const start = Math.max(0, buf.length - Number(m[1]))
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-range": `bytes ${start}-${buf.length - 1}/${buf.length}`,
      })
      return res.end(buf.subarray(start))
    }
    res.writeHead(200, { "content-type": "application/octet-stream" })
    return res.end(buf)
  }
  if (path === `${R}/pipelines/%7Bp%7D/steps/%7Bredir%7D/log`) {
    res.writeHead(302, { location: `${foreign}/log` })
    return res.end()
  }
  if (path === `${R}/pipelines/%7Bp%7D/steps/%7Bgone%7D/log`) return sendJson(res, 404, { error: { message: "Not found" } })
  sendJson(res, 404, { error: { message: `no mock for ${path}` } })
}

function foreignHandler(req, res) {
  foreignSeen.push({ path: req.url, auth: Boolean(req.headers.authorization) })
  res.writeHead(200, { "content-type": "application/octet-stream" })
  res.end("stored log\n\x1b[32mok\x1b[0m\n")
}

const listen = (handler) =>
  new Promise((done) => {
    const s = http.createServer(handler)
    s.listen(0, "127.0.0.1", () => done(s))
  })

function bb(args, env = {}) {
  const base = { ...process.env }
  for (const k of Object.keys(base))
    if (/^(BITBUCKET_|HTTPS?_PROXY$|NODE_USE_ENV_PROXY$)/i.test(k)) delete base[k]
  return new Promise((done) => {
    execFile(
      process.execPath,
      [BB, ...args],
      {
        env: {
          ...base,
          BITBUCKET_API_BASE: apiBase,
          BITBUCKET_EMAIL: "me@example.com",
          BITBUCKET_API_TOKEN: "dummy",
          ...env,
        },
      },
      (err, stdout, stderr) => done({ code: err ? err.code : 0, stdout, stderr }),
    )
  })
}

const requested = (path) => seen.filter((s) => s.path === path)

describe("CLI against a mock API", () => {
  before(async () => {
    const a = await listen(apiHandler)
    const f = await listen(foreignHandler)
    apiBase = `http://127.0.0.1:${a.address().port}/2.0`
    foreign = `http://127.0.0.1:${f.address().port}`
    api = a
    foreignSrv = f
  })
  let foreignSrv
  after(() => {
    api.close()
    foreignSrv.close()
  })

  test("extra positional arguments are rejected with a flag suggestion (M3)", async () => {
    let r = await bb(["commits", "ws/repo", "develop"])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Unexpected argument "develop"\. Did you mean --branch develop\?/)
    r = await bb(["file", "ws/repo", "src/a.ts", "feature/x"])
    assert.match(r.stderr, /Did you mean --ref feature\/x\?/)
    r = await bb(["pr", "https://bitbucket.org/ws/repo/pull-requests/1", "extra"])
    assert.match(r.stderr, /Unexpected argument "extra"/)
  })

  test("status and step lists ask for 100 and keep the more-results footer (M4)", async () => {
    let r = await bb(["pr-statuses", "ws/repo", "1"])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /\(more results/)
    assert.equal(requested("/2.0/repositories/ws/repo/pullrequests/1/statuses").at(-1).query.get("pagelen"), "100")
    r = await bb(["pipeline-steps", "ws/repo", "p"])
    assert.match(r.stdout, /\(more results/)
  })

  test("pr-context warns about partial build statuses (M4)", async () => {
    const r = await bb(["pr-context", "ws/repo", "1"])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /WARNING: only the first 10 build statuses/)
  })

  test("browse with no path lists /src/{sha}/ (L1)", async () => {
    const r = await bb(["browse", "ws/repo"])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /two\.txt/)
    assert.equal(requested("/2.0/repositories/ws/repo/src").length, 0)
    assert.ok(requested(`/2.0/repositories/ws/repo/src/${SHA}/`).length)
  })

  test("file does not count the trailing newline (L2)", async () => {
    const r = await bb(["file", "ws/repo", "two.txt"])
    assert.match(r.stdout, /lines 1-2 of 2/)
  })

  test("pr-activity names changes requested (L3)", async () => {
    const r = await bb(["pr-activity", "ws/repo", "1"])
    assert.match(r.stdout, /changes requested by Dana \(2026-01-03\)/)
    assert.doesNotMatch(r.stdout, /pull_request/)
  })

  test("list flags on a non-list command are rejected (L4)", async () => {
    const r = await bb(["pr-diff", "ws/repo", "1", "--all"])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /not a list command/)
  })

  test("bad numbers and settings fail clearly (L5)", async () => {
    let r = await bb(["pipeline-step-log", "ws/repo", "p", "s", "--tail", "0"])
    assert.match(r.stderr, /--tail must be a positive whole number/)
    r = await bb(["repo", "ws/repo"], { BITBUCKET_REQUEST_TIMEOUT: "-5" })
    assert.match(r.stderr, /BITBUCKET_REQUEST_TIMEOUT must be/)
    r = await bb(["repo", "ws/repo"], { BITBUCKET_API_BASE: "not a url" })
    assert.match(r.stderr, /is not a valid URL/)
  })

  test("dot segments never reach the API (L6)", async () => {
    const before = seen.length
    const r = await bb(["commit", "ws/repo", ".."])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Invalid path segment/)
    assert.equal(seen.length, before)
  })

  test("step log: range request, ANSI stripped, tail kept (L7)", async () => {
    const r = await bb(["pipeline-step-log", "ws/repo", "p", "s", "--tail", "100"])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /FAILURE: boom/)
    assert.doesNotMatch(r.stdout, /\x1b/)
    assert.match(r.stdout, /showing last 100 chars of a \d+-byte log/)
    assert.equal(requested("/2.0/repositories/ws/repo/pipelines/%7Bp%7D/steps/%7Bs%7D/log").at(-1).range, "bytes=-400")
  })

  test("step log 404 gets a log-specific hint (L7)", async () => {
    const r = await bb(["pipeline-step-log", "ws/repo", "p", "gone"])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Hint: No log for this step/)
  })

  test("check: 403 means credentials accepted; 401 exits 1 (L8)", async () => {
    let r = await bb(["check"], { BITBUCKET_API_TOKEN: "noscope" })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /Credentials accepted, but the token cannot read your account/)
    r = await bb(["check"], { BITBUCKET_API_TOKEN: "bad" })
    assert.equal(r.code, 1)
    assert.match(r.stdout, /Auth check failed/)
  })

  test("redirects off the API origin are refused (L9)", async () => {
    const r = await bb(["get", "redir-foreign"])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Refusing to follow a redirect/)
    assert.equal(foreignSeen.filter((s) => s.path === "/other").length, 0)
  })

  test("the step log may redirect to storage, without credentials (L9)", async () => {
    const r = await bb(["pipeline-step-log", "ws/repo", "p", "redir"])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /stored log\nok/)
    const hit = foreignSeen.filter((s) => s.path === "/log")
    assert.ok(hit.length)
    assert.ok(hit.every((s) => !s.auth))
  })

  test("pr-context --branch lists candidates when there are several (L10)", async () => {
    const r = await bb(["pr-context", "ws/repo", "--branch", "dup"])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /2 open pull requests come from branch "dup"/)
    assert.match(r.stdout, /#5 .*-> develop/)
    assert.match(r.stdout, /#6 .*-> release\/2/)
  })

  test("prs without --state says it lists open PRs only (L11)", async () => {
    const r = await bb(["prs", "ws/repo"])
    assert.match(r.stdout, /No open pull requests found .* only listed with --state/)
  })

  test("file-history resolves slash branches first (L12)", async () => {
    const r = await bb(["file-history", "ws/repo", "feature/x", "src/a.ts"])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Edit a/)
  })

  test("pr-context does not retry comments after a non-400 error (nit)", async () => {
    const path = "/2.0/repositories/ws/repo/pullrequests/2/comments"
    const before = requested(path).length
    const r = await bb(["pr-context", "ws/repo", "2"])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /--- Comments ---\nUnavailable:/)
    assert.equal(requested(path).length - before, 1)
  })

  test("help for an unknown command is an error (nit)", async () => {
    let r = await bb(["help", "nosuch"])
    assert.equal(r.code, 1)
    r = await bb(["nosuch", "--help"])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Unknown command "nosuch"/)
  })

  test("a non-Bitbucket URL gets a warning (nit)", async () => {
    const r = await bb(["pr", "https://github.com/ws/repo/pull-requests/1"])
    assert.match(r.stderr, /Warning: github\.com is not bitbucket\.org/)
  })
})
