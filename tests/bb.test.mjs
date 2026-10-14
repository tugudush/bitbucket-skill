// Tests for scripts/bb.mjs. Run from the skill root with: node --test (or npm test). Not `node --test tests/`:
// recent Node treats a directory argument as a test file and fails.
// Unit tests import the pure helpers; end-to-end tests run the CLI against loopback mock servers
// (BITBUCKET_API_BASE=http://127.0.0.1:<port>/2.0, which the HTTPS check allows for loopback only).

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  VERSION,
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
  revealInvisible,
  project,
  fileResult,
  diffstatText,
  duration,
  repoPath,
  pathFlag,
  isSecretEndpoint,
  prStates,
  updateChanges,
  help as helpFor,
  shq,
  headChars,
  tailChars,
} from '../scripts/bb.mjs'

const BB = fileURLToPath(new URL('../scripts/bb.mjs', import.meta.url))
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const SHORT7 = 'abc123abc123' // what a PR object carries: 12 characters
const FULL7 = SHORT7 + 'd'.repeat(28)
const DEST7 = 'fed987fed987' // the destination commit a PR carries, 12 characters like the source
const FULLDEST7 = DEST7 + 'e'.repeat(28)
const DEST8 = '0a1b2c3d4e5f' // one whose full hash cannot be looked up
const SHORT8 = 'def456def456'
// commits in the file-history mock: H_GONE has no commit mock, so its lookup fails with 404
const H_NEW = 'e'.repeat(40)
const H_OLD = 'f'.repeat(40)
const H_GONE = 'd'.repeat(40)
const manyHash = (i) => '9'.repeat(38) + i.toString(16).padStart(2, '0')
const ctx = (flags = {}) => ({ flags })

// ---------------------------------------------------------------- unit

describe('parseArgs', () => {
  test('splits positionals and flags', () => {
    const { pos, flags } = parseArgs([
      'pr',
      'ws/repo',
      '1',
      '--json',
      '--path',
      'a.ts',
    ])
    assert.deepEqual(pos, ['pr', 'ws/repo', '1'])
    assert.deepEqual(flags, { json: true, path: 'a.ts' })
  })
  test('rejects single-dash options instead of treating them as arguments', () => {
    assert.throws(
      () => parseArgs(['file', 'ws/repo', 'a', '-r', 'main']),
      /Unknown option -r/
    )
  })
  test('everything after "--" is positional', () => {
    assert.deepEqual(parseArgs(['search-code', 'ws', '--', '-x']).pos, [
      'search-code',
      'ws',
      '-x',
    ])
  })
  test('a value flag does not swallow the next flag', () => {
    assert.throws(
      () => parseArgs(['prs', 'ws/repo', '--q', '--json']),
      /needs a value/
    )
  })
  test("a misspelled boolean flag is unknown, not 'needs a value' (at the end, or before another flag)", () => {
    assert.throws(
      () => parseArgs(['pr-context', 'u', '--ful']),
      /Unknown flag --ful\. Did you mean --full\?/
    )
    assert.throws(
      () => parseArgs(['file', 'ws/repo', 'a.ts', '--raww']),
      /Unknown flag --raww\. Did you mean --raw\?/
    )
    assert.throws(
      () => parseArgs(['prs', 'ws/repo', '--al']),
      /Unknown flag --al\. Did you mean --all\?/
    )
    assert.throws(
      () => parseArgs(['file', 'ws/repo', 'a.ts', '--raww', '--ref', 'main']),
      /Unknown flag --raww\. Did you mean --raw\?/
    )
    assert.throws(
      () => parseArgs(['pr-context', 'u', '--ful', '--json']),
      /Unknown flag --ful\. Did you mean --full\?/
    )
  })
  test('a flag no command is close to gets no suggestion, and a real value flag still says it needs a value', () => {
    assert.throws(
      () => parseArgs(['pr', 'u', '--zzzzzz']),
      (e) =>
        /Unknown flag --zzzzzz\./.test(e.message) &&
        !/Did you mean/.test(e.message)
    )
    assert.throws(
      () => parseArgs(['file', 'ws/repo', 'a.ts', '--ref']),
      /--ref needs a value$/
    )
    assert.throws(
      () => parseArgs(['file', 'ws/repo', 'a.ts', '--ref', '--raw']),
      /--ref needs a value, but the next argument is "--raw"/
    )
    assert.throws(
      () => parseArgs(['diff', 'ws/repo', 'a..b', '--path']),
      /--path needs a value$/
    )
    // the removed flag is never suggested
    assert.throws(
      () => parseArgs(['diff', 'ws/repo', 'a..b', '--topi']),
      (e) => !/--topic/.test(e.message)
    )
  })
})

describe('paging flags that contradict each other (review run 5)', () => {
  test('--all with --page is rejected: it would skip the early pages under a full-total header', () => {
    for (const name of [
      'branches',
      'tags',
      'prs',
      'commits',
      'browse',
      'search-code',
      'pr-comments',
    ])
      assert.throws(
        () => checkFlags(commands[name], { all: true, page: '3' }),
        /--page cannot be combined with --all: --all reads every page from the first.*--page alone for one page, or --all alone/,
        name
      )
  })
  test('--max-pages without --all is rejected, and with --all it is fine', () => {
    for (const name of ['branches', 'browse', 'search-code']) {
      assert.throws(
        () => checkFlags(commands[name], { 'max-pages': '5' }),
        /--max-pages only applies together with --all/,
        name
      )
      assert.doesNotThrow(
        () => checkFlags(commands[name], { all: true, 'max-pages': '5' }),
        name
      )
    }
  })
  test('each flag alone, and --all=false, stay valid', () => {
    assert.doesNotThrow(() => checkFlags(commands['branches'], { page: '3' }))
    assert.doesNotThrow(() =>
      checkFlags(commands['branches'], { page: '3', pagelen: '50' })
    )
    assert.doesNotThrow(() =>
      checkFlags(commands['branches'], { all: true, pagelen: '50' })
    )
    assert.doesNotThrow(() =>
      checkFlags(commands['branches'], { all: false, page: '3' })
    ) // --all=false is not --all
  })
  test('on a command that is not a list, --page/--all/--max-pages keep their older message', () => {
    assert.throws(
      () => checkFlags(commands['pr-diff'], { page: '2' }),
      /is not a list command/
    )
    assert.throws(
      () => checkFlags(commands['pr-diff'], { 'max-pages': '2' }),
      /is not a list command/
    )
  })
})

describe('shq (a command printed in a message can be pasted)', () => {
  test('plain words are left alone and anything else is single-quoted', () => {
    assert.equal(shq('src/pages/a.ts'), 'src/pages/a.ts')
    assert.equal(shq('feature/x'), 'feature/x')
    assert.equal(shq('dir with space'), "'dir with space'")
    assert.equal(shq('source.branch.name="x"'), `'source.branch.name="x"'`)
    assert.equal(shq("it's"), `'it'\\''s'`)
    assert.equal(shq('a;b$c'), "'a;b$c'")
    assert.equal(shq(''), "''")
  })
})

describe('flags the endpoint ignores (review run 4)', () => {
  const tip = {
    commits: /file-history lists the commits that touched one file/,
    'pr-diffstat': /--path FILE\[,FILE\] picks the files/,
  }
  test('--q and --sort are rejected where Bitbucket ignores them, with what to do instead', () => {
    for (const name of [
      'commits',
      'pr-commits',
      'pr-activity',
      'pr-diffstat',
      'diffstat',
    ]) {
      for (const flag of ['q', 'sort']) {
        assert.throws(
          () => checkFlags(commands[name], { [flag]: 'x' }),
          (e) =>
            e.message.startsWith(
              `--${flag} is not supported by ${name}: Bitbucket's endpoint ignores it`
            ) && /Fetch with --all .* the result yourself/.test(e.message),
          `${name} --${flag}`
        )
      }
    }
    assert.throws(
      () => checkFlags(commands['commits'], { q: 'x' }),
      tip.commits
    )
    assert.throws(
      () => checkFlags(commands['pr-diffstat'], { sort: 'x' }),
      tip['pr-diffstat']
    )
  })
  test('pipelines and pipeline-steps reject --q only: --sort works on them', () => {
    for (const name of ['pipelines', 'pipeline-steps']) {
      assert.throws(
        () => checkFlags(commands[name], { q: 'x' }),
        /--q is not supported by .*--sort works here/
      )
      assert.doesNotThrow(() =>
        checkFlags(commands[name], {
          sort: 'created_on',
          all: true,
          pagelen: '5',
        })
      )
    }
  })
  test('the commands that do honour them (checked live) still take both', () => {
    for (const name of [
      'repos',
      'search-repos',
      'branches',
      'tags',
      'prs',
      'pr-comments',
      'file-history',
    ])
      assert.doesNotThrow(
        () => checkFlags(commands[name], { q: 'x', sort: 'y' }),
        name
      )
  })
  test('the message for an ignored flag names the cost of --all and how to cap it', () => {
    assert.throws(
      () => checkFlags(commands['commits'], { q: 'x' }),
      (e) =>
        /--select keeps the output small, --max-pages N caps the number of requests/.test(
          e.message
        ) && /about 2 s per 100 commits, 48 s for 1,959/.test(e.message)
    )
    // the cost note is specific to commits
    assert.throws(
      () => checkFlags(commands['pr-diffstat'], { q: 'x' }),
      (e) => !/about 2 s per 100/.test(e.message)
    )
  })
  test('help says which of --q/--sort a command takes', () => {
    assert.match(
      helpFor('commits'),
      /\(not --q\/--sort: Bitbucket ignores them on this endpoint\)/
    )
    assert.match(
      helpFor('pipelines'),
      /--sort \(not --q: Bitbucket ignores it on this endpoint\)/
    )
    assert.match(helpFor('prs'), /--max-pages --q --sort\.?$/)
    assert.match(helpFor('browse'), /\(no --q\/--sort\)/)
  })
})

describe('checkFlags / maxArgs', () => {
  test('list flags only on list commands', () => {
    assert.throws(
      () => checkFlags(commands['pr-diff'], { q: 'x' }),
      /not a list command/
    )
    assert.doesNotThrow(() =>
      checkFlags(commands['prs'], { q: 'x', all: true })
    )
  })
  test('search-code pages but takes no --q/--sort', () => {
    assert.doesNotThrow(() =>
      checkFlags(commands['search-code'], { page: '2' })
    )
    assert.throws(
      () => checkFlags(commands['search-code'], { sort: 'x' }),
      /not supported/
    )
  })
  test('typos get a suggestion', () => {
    assert.throws(
      () => checkFlags(commands['prs'], { pagelenn: '5' }),
      /Did you mean --pagelen/
    )
  })
  test('positional limits come from the usage string', () => {
    assert.equal(maxArgs(commands['commits'].usage), 1)
    assert.equal(maxArgs(commands['file'].usage), 2)
    assert.equal(maxArgs(commands['browse'].usage), 2)
    assert.equal(maxArgs(commands['merge-base'].usage), 2)
    assert.equal(maxArgs(commands['pr'].usage), 2)
    assert.equal(maxArgs(commands['pr-context'].usage), 2)
    assert.equal(maxArgs(commands['pipeline-step-log'].usage), 3)
  })
})

describe('value helpers', () => {
  test('int accepts whole numbers >= min only', () => {
    assert.equal(int('5', '--tail'), 5)
    assert.equal(int(undefined, '--tail'), undefined)
    assert.equal(int('0', '--context', 0), 0)
    for (const bad of ['0', '-1', '1.5', 'abc'])
      assert.throws(() => int(bad, '--tail'), /--tail must be/)
  })
  test('enc and encPath reject dot segments', () => {
    assert.throws(() => enc('..'), /Invalid path segment/)
    assert.throws(() => encPath('../../x'), /Invalid path segment/)
    assert.equal(enc('feature/x'), 'feature%2Fx')
    assert.equal(encPath('src/a b.ts'), 'src/a%20b.ts')
  })
  test('rangeSpec', () => {
    assert.equal(rangeSpec('a..b'), 'a..b')
    assert.equal(rangeSpec('feature/x..main'), 'feature%2Fx..main')
    assert.throws(() => rangeSpec('a..b..c'), /Invalid revision/)
    assert.throws(() => rangeSpec('...'), /Invalid revision/)
  })
  test('bbqlString escapes backslashes and quotes', () => {
    assert.equal(bbqlString('a"b\\c'), '"a\\"b\\\\c"')
  })
  test('stripAnsi', () => {
    assert.equal(
      stripAnsi('\x1b[31mFAIL\x1b[0m done \x1b]0;title\x07'),
      'FAIL done '
    )
  })
  test('revealInvisible: format characters become <U+XXXX>; a leading BOM and an emoji joiner stay', () => {
    assert.deepEqual(revealInvisible('plain text ✓ é'), {
      text: 'plain text ✓ é',
      found: [],
    })
    assert.deepEqual(revealInvisible('a‌b‌'), {
      text: 'a<U+200C>b<U+200C>',
      found: ['U+200C'],
    })
    assert.deepEqual(revealInvisible('x‮y⁦'), {
      text: 'x<U+202E>y<U+2066>',
      found: ['U+202E', 'U+2066'],
    })
    assert.equal(revealInvisible('\u{E0041}').text, '<U+E0041>')
    assert.equal(revealInvisible('﻿bom').text, '﻿bom')
    assert.equal(revealInvisible('a﻿').text, 'a<U+FEFF>')
    const family = '👨‍👩‍👧' // joiners between emoji are how the sequence is built
    assert.deepEqual(revealInvisible(family), { text: family, found: [] })
    assert.deepEqual(revealInvisible('❤️‍🔥').found, [])
    assert.deepEqual(revealInvisible('a‍b').found, ['U+200D']) // a joiner after a letter is not an emoji sequence
  })
  test('duration', () => {
    assert.equal(duration(null), 'n/a')
    assert.equal(duration(59), '59s')
    assert.equal(duration(61), '1m 1s')
    assert.equal(duration(3661), '1h 1m 1s')
  })
  test('project picks dotted fields from each item', () => {
    const d = { size: 1, values: [{ id: 1, a: { b: 2 }, c: 3 }] }
    assert.deepEqual(project(d, 'id,a.b'), {
      size: 1,
      values: [{ id: 1, 'a.b': 2 }],
    })
  })
  test('project maps through arrays and keeps missing fields visible as null (L13)', () => {
    const d = {
      values: [
        {
          id: 1,
          reviewers: [{ display_name: 'A' }, { display_name: 'B' }],
          title: 't',
        },
      ],
    }
    const warnings = []
    const out = project(d, 'id,reviewers.display_name,titel', (m) =>
      warnings.push(m)
    )
    assert.deepEqual(out.values[0], {
      id: 1,
      'reviewers.display_name': ['A', 'B'],
      titel: null,
    })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /"titel" matched nothing/)
  })
  test('project does not warn for an empty array or an empty list, or for a real null', () => {
    const warnings = []
    const warn = (m) => warnings.push(m)
    project(
      { values: [{ reviewers: [], x: null }] },
      'reviewers.display_name,x',
      warn
    )
    project({ values: [] }, 'anything', warn)
    assert.deepEqual(warnings, [])
  })
  test('project explains the leading values. slip on a list, and only there', () => {
    const warnings = []
    const warn = (m) => warnings.push(m)
    project({ values: [{ full_name: 'a/b' }] }, 'values.full_name', warn)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /matched nothing/)
    assert.match(
      warnings[0],
      /On a list the paths apply to each item, so drop the leading "values\.": "full_name"\./
    )
    // a plain typo gets no tip, and neither does a single object
    warnings.length = 0
    project({ values: [{ full_name: 'a/b' }] }, 'full_nam', warn)
    project({ x: 1 }, 'values.y', warn)
    assert.equal(warnings.length, 2)
    assert.doesNotMatch(warnings.join('\n'), /drop the leading/)
  })
  test('project works on a single object', () => {
    const warnings = []
    assert.deepEqual(
      project({ a: { b: 1 } }, 'a.b,a.c', (m) => warnings.push(m)),
      { 'a.b': 1, 'a.c': null }
    )
    assert.equal(warnings.length, 1)
  })
  test('the version is the same in bb.mjs, package.json and the README', () => {
    const root = (f) =>
      readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    assert.equal(JSON.parse(root('package.json')).version, VERSION)
    assert.equal(
      /Version: \*\*([\d.]+)\*\*/.exec(root('README.md'))?.[1],
      VERSION
    )
    assert.match(
      root('CHANGELOG.md'),
      new RegExp(`^## ${VERSION.replaceAll('.', '\\.')} `, 'm')
    )
  })
})

describe('paths and arguments', () => {
  test('repoPath strips leading slashes and rejects Git Bash rewrites (L14)', () => {
    assert.equal(repoPath('/src/a.ts'), 'src/a.ts')
    assert.equal(repoPath('src/a.ts'), 'src/a.ts')
    assert.throws(() => repoPath('C:/Program Files/Git/src/a.ts'), /rewrote/)
    assert.throws(() => repoPath('C:\\Program Files\\Git\\src'), /rewrote/)
  })
  test('pathFlag takes a comma-separated list', () => {
    assert.equal(pathFlag({}), undefined)
    assert.deepEqual(pathFlag({ path: 'a.ts' }), ['a.ts'])
    assert.deepEqual(pathFlag({ path: '/a.ts, b/c.ts' }), ['a.ts', 'b/c.ts'])
    assert.throws(() => pathFlag({ path: 'C:/Program Files/Git/x' }), /rewrote/)
  })
  test('a flag given twice is an error, not a silent last-wins', () => {
    assert.throws(
      () =>
        parseArgs([
          'diffstat',
          'ws/repo',
          'a..b',
          '--path',
          'x',
          '--path',
          'y',
        ]),
      /--path was given more than once.*comma-separated/
    )
    assert.doesNotThrow(() => parseArgs(['prs', '--json', '--json']))
  })
  test('--topic was removed and says what to use', () => {
    assert.throws(
      () => checkFlags(commands['diff'], { topic: true }),
      /--topic was removed.*--two-dot/
    )
    assert.doesNotThrow(() => checkFlags(commands['diff'], { 'two-dot': true }))
    assert.throws(
      () => checkFlags(commands['pr-diff'], { 'two-dot': true }),
      /Unknown flag/
    )
  })
  test('browse takes paging flags but not --q (L18)', () => {
    assert.doesNotThrow(() =>
      checkFlags(commands['browse'], { all: true, pagelen: '10' })
    )
    assert.throws(
      () => checkFlags(commands['browse'], { q: 'x' }),
      /not supported/
    )
  })
  test('prStates (L19)', () => {
    assert.equal(prStates(undefined), undefined)
    assert.deepEqual(prStates('merged'), ['MERGED'])
    assert.deepEqual(prStates('MERGED, declined,MERGED'), [
      'MERGED',
      'DECLINED',
    ])
    assert.deepEqual(prStates('all'), [
      'OPEN',
      'MERGED',
      'DECLINED',
      'SUPERSEDED',
    ])
    assert.throws(() => prStates('done'), /Unknown pull request state "DONE"/)
    assert.throws(() => prStates(''), /needs a value/)
  })
})

describe('diffstatText', () => {
  const e = (p) => ({
    status: 'modified',
    new: { path: p },
    lines_added: 2,
    lines_removed: 1,
  })
  test('a complete list reports totals', () => {
    assert.match(
      diffstatText('x', { values: [e('a'), e('b')] }),
      /^Diffstat for x: 2 file\(s\), \+4 -2/
    )
  })
  test('a partial page says so in the headline (L15)', () => {
    const t = diffstatText('x', {
      values: [e('a'), e('b')],
      next: 'https://example/next',
    })
    assert.match(
      t,
      /^Diffstat for x: first 2 file\(s\) \(more exist\), \+4 -2 so far/
    )
  })
  test('a partial page names the total when the API gave one (review run 8)', () => {
    const next = 'https://example/next'
    assert.match(
      diffstatText('x', { values: [e('a'), e('b')], size: 2295, next }),
      /^Diffstat for x: first 2 file\(s\) of 2295 \(more exist\), \+4 -2 so far/
    )
    // a total that is not larger than what was read adds nothing
    assert.match(
      diffstatText('x', { values: [e('a'), e('b')], size: 2, next }),
      /first 2 file\(s\) \(more exist\)/
    )
  })
})

describe('truncation keeps a character whole (review run 8)', () => {
  const smile = '\u{1F600}' // two UTF-16 units
  test('a head cut between the halves of an emoji drops the half', () => {
    assert.equal(headChars(`ab${smile}cd`, 3), 'ab')
    assert.equal(headChars(`ab${smile}cd`, 4), `ab${smile}`)
    assert.equal(headChars(`ab${smile}cd`, 2), 'ab')
    assert.equal(headChars('abc', 2), 'ab')
    assert.equal(headChars('abc', 10), 'abc')
  })
  test('a tail cut between the halves drops the half', () => {
    assert.equal(tailChars(`ab${smile}cd`, 3), 'cd')
    assert.equal(tailChars(`ab${smile}cd`, 4), `${smile}cd`)
    assert.equal(tailChars('abc', 2), 'bc')
    assert.equal(tailChars('abc', 10), 'abc')
  })
  test('a lone surrogate that was already in the text is left alone when nothing is cut through it', () => {
    assert.equal(headChars('a\ud83dz', 3), 'a\ud83dz')
    assert.equal(tailChars('a\ud83dz', 3), 'a\ud83dz')
  })
})

describe('updateChanges', () => {
  test("names the PR state next to Bitbucket's internal status words", () => {
    assert.equal(
      updateChanges({ status: { old: 'open', new: 'fulfilled' } }),
      'status open -> fulfilled (merged)'
    )
    assert.equal(
      updateChanges({ status: { old: 'open', new: 'rejected' } }),
      'status open -> rejected (declined)'
    )
    assert.equal(
      updateChanges({ status: { old: 'open', new: 'superseded' } }),
      'status open -> superseded'
    )
    assert.equal(updateChanges({}), '')
  })
})

describe('secret-bearing endpoints (M1)', () => {
  const base = 'https://api.bitbucket.org/2.0'
  test('are recognised however the path is spelled', () => {
    for (const p of [
      'repositories/ws/repo/hooks',
      'repositories/ws/repo/hooks/%7Buuid%7D',
      'repositories/ws/repo/%68ooks',
      'repositories/ws/repo/%2568ooks',
      'repositories/ws/repo/HOOKS',
      'repositories/ws/repo/default-reviewers/../hooks',
      'repositories/ws/repo/deploy-keys',
      'repositories/ws/repo/pipelines_config/variables/',
      'repositories/ws/repo/deployments_config/environments/%7Be%7D/variables',
      'workspaces/ws/pipelines-config/variables',
      'workspaces/ws/hooks',
      'users/%7Bu%7D/ssh-keys',
      'user/ssh-keys',
      'user/emails',
      'users/%7Bu%7D/emails',
      'repositories/ws/repo/access-tokens',
    ])
      assert.ok(isSecretEndpoint(`${base}/${p}`), p)
  })
  test('ordinary endpoints are not blocked', () => {
    for (const p of [
      'repositories/ws/repo',
      'repositories/ws/repo/default-reviewers',
      'repositories/ws/repo/pipelines_config',
      'repositories/ws/emails',
      'user',
    ])
      assert.ok(!isSecretEndpoint(`${base}/${p}`), p)
  })
  test('a full URL is checked by its path', () => {
    assert.ok(
      isSecretEndpoint(
        'https://api.bitbucket.org/2.0/repositories/ws/repo/hooks?pagelen=1'
      )
    )
  })
})

describe('parseRepoToken', () => {
  test('ws/repo and URLs', () => {
    assert.deepEqual(parseRepoToken('ws/repo'), { ws: 'ws', repo: 'repo' })
    assert.deepEqual(
      parseRepoToken('https://bitbucket.org/ws/repo/pull-requests/42'),
      {
        ws: 'ws',
        repo: 'repo',
        prId: 42,
      }
    )
    assert.deepEqual(
      parseRepoToken(
        'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/7'
      ),
      {
        ws: 'ws',
        repo: 'repo',
        prId: 7,
      }
    )
  })
  test('git remotes: SSH form and .git suffix (L16)', () => {
    const want = { ws: 'ws', repo: 'repo' }
    assert.deepEqual(parseRepoToken('git@bitbucket.org:ws/repo.git'), want)
    assert.deepEqual(
      parseRepoToken('ssh://git@bitbucket.org/ws/repo.git'),
      want
    )
    assert.deepEqual(parseRepoToken('https://bitbucket.org/ws/repo.git'), want)
    assert.deepEqual(
      parseRepoToken('https://user@bitbucket.org/ws/repo.git'),
      want
    )
    assert.deepEqual(parseRepoToken('ws/repo.git'), want)
    assert.deepEqual(parseRepoToken('git@bitbucket.org:ws/repo'), want)
  })
  test('a malformed PR id in a URL is named, not turned into NaN (L16)', () => {
    assert.throws(
      () => parseRepoToken('https://bitbucket.org/ws/repo/pull-requests/12abc'),
      /Pull request id must be a positive whole number, got "12abc"/
    )
    assert.equal(
      parseRepoToken('https://bitbucket.org/ws/repo/pull-requests/12/diff')
        .prId,
      12
    )
  })

  // review run 9, issue 1: a commit, branch or file URL carries a hash, a name or a ref and path, not only ws/repo
  test('web URLs name a commit, a branch, or a ref and a path (review run 9)', () => {
    const u = (tail) =>
      parseRepoToken(`https://bitbucket.org/ws/repo/${tail}`).url
    assert.deepEqual(u('commits/157f907128d4'), { commit: '157f907128d4' })
    assert.deepEqual(u('commits/157f907128d4?at=develop#chg-src/a.ts'), {
      commit: '157f907128d4',
    })
    assert.deepEqual(u('commit/157f907128d4'), { commit: '157f907128d4' })
    assert.deepEqual(u('commits/branch/feature%2Fx'), { branch: 'feature/x' })
    assert.deepEqual(u('commits/branch/feature/x'), { branch: 'feature/x' })
    assert.deepEqual(u('branch/feature%2Fx'), { branch: 'feature/x' })
    assert.deepEqual(u('src/develop/src/shared/utils/'), {
      ref: 'develop',
      path: 'src/shared/utils',
    })
    assert.deepEqual(u('src/develop/'), { ref: 'develop', path: '' })
    assert.deepEqual(u('src/develop'), { ref: 'develop', path: '' })
    // a branch with a "/" is one segment (%2F) and the query and fragment are not part of the path
    assert.deepEqual(u('src/feature%2Fx/a%20b.ts?at=feature%2Fx#lines-4'), {
      ref: 'feature/x',
      path: 'a b.ts',
    })
    assert.deepEqual(u('raw/main/a.ts'), { ref: 'main', path: 'a.ts' })
    assert.deepEqual(u('src/50%/a'), { ref: '50%', path: 'a' }) // a stray % is part of the name
    assert.deepEqual(
      parseRepoToken(
        'https://api.bitbucket.org/2.0/repositories/ws/repo/commit/abc123'
      ).url,
      {
        commit: 'abc123',
      }
    )
  })
  test('URLs with nothing more to name keep the plain shape', () => {
    for (const tail of [
      '',
      'pull-requests/12/commits/abc123',
      'commits/tag/v1',
      'commits/branch',
      'pipelines',
      'branches',
    ])
      assert.equal(
        'url' in parseRepoToken(`https://bitbucket.org/ws/repo/${tail}`),
        false,
        tail
      )
  })
})

describe('fileResult', () => {
  test('a trailing newline does not add a line', () => {
    const r = fileResult('one\ntwo\n', 'f.txt', 'main', ctx())
    assert.equal(r.data.total_lines, 2)
    assert.match(r.text, /lines 1-2 of 2/)
  })
  test('CRLF files', () => {
    assert.equal(
      fileResult('a\r\nb\r\n', 'f', 'main', ctx()).data.total_lines,
      2
    )
  })
  test('empty file', () => {
    assert.match(fileResult('', 'f', 'main', ctx()).text, /is empty/)
  })
  test('--start past the end is an error', () => {
    assert.throws(
      () => fileResult('a\nb\n', 'f', 'main', ctx({ start: '5' })),
      /past the end/
    )
  })
  test('paging hint', () => {
    const r = fileResult('1\n2\n3\n', 'f', 'main', ctx({ limit: '2' }))
    assert.match(r.text, /use --start 3/)
  })

  // review run 8, issue 1: --raw stopped at 1000 lines with nothing saying so, and a grep over it said "not there"
  const numbered = (n) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  test('--raw starts from the 10000-line maximum, not 1000, and says nothing when it all fits', () => {
    const r = fileResult(numbered(1455), 'f', 'main', ctx({ raw: true }))
    assert.equal(r.data.end, 1455)
    assert.equal(r.text.split('\n').length, 1455)
    assert.equal(r.warn, undefined)
  })
  test('--raw warns, for stderr, when lines are left out, and says how to get them', () => {
    let r = fileResult(
      numbered(1455),
      'f',
      'main',
      ctx({ raw: true, limit: '1000' })
    )
    assert.equal(r.text.split('\n').length, 1000)
    assert.match(
      r.warn,
      /^Warning: --raw printed lines 1-1000 of 1455; 455 line\(s\) are not in this output, so a grep over it can miss matches\. Add --limit 1455 to read to the end, or continue with --start 1001\./
    )
    // from the middle, the limit that reaches the end is smaller
    r = fileResult(
      numbered(1455),
      'f',
      'main',
      ctx({ raw: true, start: '1001', limit: '100' })
    )
    assert.match(
      r.warn,
      /lines 1001-1100 of 1455; 355 line\(s\).*Add --limit 455 to read to the end, or continue with --start 1101\./
    )
    // past the 10000 cap the flag cannot reach the end, and the message does not suggest it
    r = fileResult(numbered(10500), 'f', 'main', ctx({ raw: true }))
    assert.equal(r.data.end, 10000)
    assert.match(
      r.warn,
      /lines 1-10000 of 10500; 500 line\(s\).*--limit is capped at 10000, so read the rest in pieces, or continue with --start 10001\./
    )
    assert.doesNotMatch(r.warn, /Add --limit/)
  })
  test('the numbered view keeps its 1000-line default and its own footer, with no stderr warning', () => {
    const r = fileResult(numbered(1455), 'f', 'main', ctx())
    assert.match(r.text, /lines 1-1000 of 1455/)
    assert.match(r.text, /455 more lines; use --start 1001/)
    assert.equal(r.warn, undefined)
  })
})

// ---------------------------------------------------------------- end to end

const pr = (id, dest = 'main') => ({
  id,
  title: `PR ${id}`,
  state: 'OPEN',
  author: { display_name: 'Ana' },
  source: { branch: { name: 'feature/x' }, commit: { hash: SHA2 } },
  destination: { branch: { name: dest } },
  created_on: '2026-01-01',
  updated_on: '2026-01-02',
  participants: [],
  reviewers: [],
})
const statuses = (n) =>
  Array.from({ length: n }, (_, i) => ({
    state: 'SUCCESSFUL',
    key: `build-${i}`,
    name: `Build ${i}`,
  }))

const LOG =
  Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') +
  '\n\x1b[31mFAILURE: boom\x1b[0m\n'

let api
let foreign
let apiBase
const seen = [] // { path, query, auth, range }
const hits = {} // requests per path, for the retry mocks
const origin = () => apiBase.replace(/\/2\.0$/, '') // apiBase already ends in /2.0, like the paths in `next` links
const foreignSeen = []

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const BIG_TOTAL = 32_000_000
const sentBy = {} // path -> bytes the mock server wrote before the client went away

function streamBig(res, path, withNul) {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': BIG_TOTAL,
  })
  const chunk = Buffer.alloc(65536, 0x61)
  if (withNul) chunk[100] = 0
  sentBy[path] = 0
  const pump = () => {
    while (sentBy[path] < BIG_TOTAL && !res.destroyed) {
      const n = Math.min(chunk.length, BIG_TOTAL - sentBy[path])
      sentBy[path] += n
      if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
        res.once('drain', pump) // never fires once the client has hung up: the loop just stops
        return
      }
    }
    if (!res.destroyed) res.end()
  }
  pump()
}

function apiHandler(req, res) {
  const u = new URL(req.url, 'http://x')
  const path = u.pathname
  seen.push({
    path,
    query: u.searchParams,
    auth: Boolean(req.headers.authorization),
    range: req.headers.range,
  })
  const R = '/2.0/repositories/ws/repo'
  const token = req.headers.authorization
    ? Buffer.from(req.headers.authorization.slice(6), 'base64')
        .toString()
        .split(':')[1]
    : ''

  if (path === '/2.0/user') {
    if (token === 'bad')
      return sendJson(res, 401, { error: { message: 'Unauthorized' } })
    if (token === 'noscope')
      return sendJson(res, 403, { error: { message: 'Forbidden' } })
    return sendJson(res, 200, { display_name: 'Me', account_id: '1' })
  }
  if (path === '/2.0/redir-foreign') {
    res.writeHead(302, { location: `${foreign}/other` })
    return res.end()
  }
  if (path === R)
    return sendJson(res, 200, {
      full_name: 'ws/repo',
      mainbranch: { name: 'main' },
    })
  if (path === `${R}/refs/branches/main`)
    return sendJson(res, 200, { name: 'main', target: { hash: SHA } })
  if (path === `${R}/refs/branches/feature%2Fx`)
    return sendJson(res, 200, { name: 'feature/x', target: { hash: SHA2 } })
  if (path === `${R}/src/${SHA}/`)
    return sendJson(res, 200, {
      values: [{ type: 'commit_file', path: 'two.txt', size: 8 }],
    })
  if (path === `${R}/src/${SHA}/two.txt/`)
    return sendJson(res, 404, { error: { message: 'not a dir' } })
  if (path === `${R}/src/${SHA}/two.txt`) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('one\ntwo\n')
  }
  // lines-N.txt has N short lines ("line 1" ...): for the --raw checks, which depend on how many lines there are
  const longFile = /\/src\/a{40}\/lines-(\d+)\.txt$/.exec(path)
  if (longFile) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end(
      Array.from(
        { length: Number(longFile[1]) },
        (_, i) => `line ${i + 1}`
      ).join('\n') + '\n'
    )
  }
  // `file` on a directory: the src endpoint answers a JSON listing (no trailing slash needed), where a file is plain text
  if (path === `${R}/src/${SHA}/dirx`)
    return sendJson(res, 200, {
      values: [
        {
          type: 'commit_file',
          path: 'dirx/a.txt',
          size: 3,
          commit: { hash: SHA },
        },
      ],
    })
  if (path === '/2.0/users/712020%3Aabc')
    return sendJson(res, 200, {
      display_name: 'Ian Flory',
      nickname: 'Ian (Flo) Flory',
      account_id: '712020:abc',
      uuid: '{u-1}',
    })
  if (path.startsWith('/2.0/users/'))
    // live: the 404 message is just the id that was asked for
    return sendJson(res, 404, {
      error: { message: decodeURIComponent(path.slice('/2.0/users/'.length)) },
    })
  if (path === `${R}/src/${SHA}/emoji.txt`) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('ab\u{1F600}cd\n') // the emoji is two UTF-16 units: a cut after "ab" + 1 splits it
  }
  // zero-width non-joiner, a right-to-left override and two Unicode tag characters (a hidden "Hi"), the way a smuggled line looks
  if (path === `${R}/src/${SHA}/hidden.txt`) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('ok‌‮\u{E0048}\u{E0069} done\n')
  }
  // Huge files, streamed with backpressure so `sentBy` shows how much was really downloaded before the CLI hung up.
  // big.bin has a NUL in its first chunk (binary); big.txt is plain text. Both claim BIG_TOTAL bytes.
  if (
    path === `${R}/src/${SHA}/big.bin/` ||
    path === `${R}/src/${SHA}/big.txt/`
  )
    return sendJson(res, 404, { error: { message: 'not a dir' } })
  if (path === `${R}/src/${SHA}/big.bin` || path === `${R}/src/${SHA}/big.txt`)
    return streamBig(res, path, path.endsWith('big.bin'))
  if (
    path === `${R}/src/${SHA}/dir%20with%20space/x.ts` ||
    path === `${R}/src/${SHA}/dir%20with%20space/x.ts/`
  )
    return sendJson(res, 404, {
      error: { message: 'No such file or directory: dir with space/x.ts' },
    })
  // A path that does not exist under a ref that did resolve: the real API's message names the path.
  if (
    path === `${R}/src/${SHA}/sub/nope.txt` ||
    path === `${R}/src/${SHA}/sub/nope.txt/`
  )
    return sendJson(res, 404, {
      error: { message: 'No such file or directory: sub/nope.txt' },
    })
  // filehistory entries have the LIVE shape: only { path, size, commit: { hash } }, no message, author or date.
  // The first two are one file before and after a rename; the third has a commit that cannot be looked up.
  if (path === `${R}/filehistory/${SHA2}/src/a.ts`)
    return sendJson(res, 200, {
      values: [
        {
          type: 'commit_file',
          path: 'src/a.ts',
          size: 7,
          commit: { hash: H_NEW, type: 'commit' },
        },
        {
          type: 'commit_file',
          path: 'src/old-a.ts',
          size: 5,
          commit: { hash: H_OLD, type: 'commit' },
        },
        {
          type: 'commit_file',
          path: 'src/old-a.ts',
          size: 4,
          commit: { hash: H_GONE, type: 'commit' },
        },
      ],
    })
  if (path === `${R}/filehistory/${SHA2}/src/none.ts`)
    return sendJson(res, 404, {
      error: { message: 'No such file: src/none.ts' },
    })
  if (path === `${R}/filehistory/${SHA2}/src/many.ts`) {
    // 27 entries: only the first HISTORY_DETAIL_MAX (25) may cost a commit lookup
    return sendJson(res, 200, {
      values: Array.from({ length: 27 }, (_, i) => ({
        type: 'commit_file',
        path: 'src/many.ts',
        size: i,
        commit: { hash: manyHash(i) },
      })),
    })
  }
  if (path === `${R}/commit/${H_NEW}`)
    return sendJson(res, 200, {
      hash: H_NEW,
      message: 'Edit a\n\nlong body',
      date: '2026-02-01',
      author: { raw: 'Ana' },
      parents: [],
    })
  if (path === `${R}/commit/${H_OLD}`)
    return sendJson(res, 200, {
      hash: H_OLD,
      message: 'Add old-a',
      date: '2026-01-01',
      author: { user: { display_name: 'Bo' }, raw: 'Bo <bo@example.com>' },
      parents: [],
    })
  if (/\/commit\/9{38}[0-9a-f]{2}$/.test(path))
    return sendJson(res, 200, {
      hash: path.split('/').pop(),
      message: `msg ${path.slice(-2)}`,
      date: '2026-03-01',
      author: { raw: 'Cy' },
      parents: [],
    })
  // issues: Bitbucket removed them; every endpoint answers 410 (live: CHANGE-3071)
  if (path === `${R}/issues` || path.startsWith(`${R}/issues/`))
    return sendJson(res, 410, {
      error: {
        message: 'CHANGE-3071 - Functionality has been deprecated',
        detail: 'Please read the changelog entry for more details.',
      },
    })
  // ranges and single commits with no changes (and no --path filter involved)
  if (path === `${R}/diffstat/empty..main` || path === `${R}/diffstat/emptyc`)
    return sendJson(res, 200, { values: [] })
  if (path === `${R}/diff/empty..main`) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('')
  }
  // a --path filter that matches nothing
  if (['nope.ts', 'src/hooks'].includes(u.searchParams.get('path'))) {
    if (path.includes('/diffstat')) return sendJson(res, 200, { values: [] })
    if (path.endsWith('/diff') || path.includes('/diff/')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('')
    }
  }
  if (path === `${R}/pullrequests/1/diff`) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('diff --git a/x b/x\n')
  }
  // PR 10 is an old PR whose commits were rewritten away (live: a 2024 merge PR in a repository with rewritten history):
  // the PR loads, but its diff, diffstat and commit list answer 404, and the message ends in a period.
  if (path === `${R}/pullrequests/10`) return sendJson(res, 200, pr(10))
  if (/\/pullrequests\/10\/(diffstat|diff|commits)$/.test(path))
    return sendJson(res, 404, {
      error: {
        message:
          'The source or destination could not be found for spec: ws/repo:f164b219cb0e..7be7b3a3bd20.',
      },
    })
  if (/\/pullrequests\/(10|12)\/(comments|statuses)$/.test(path))
    return sendJson(res, 200, { size: 0, values: [] })
  if (path === `${R}/commits/${SHA}`) return sendJson(res, 200, { values: [] })
  // PR 13: pushed to twice (live: PR #688 went fd587c1a -> 950a63cc -> 1e6de21d). Two pushes sit next to each other, with
  // the same author, state and title, so only the source commit tells them apart from the duplicated opening update.
  if (path === `${R}/pullrequests/13/activity`) {
    const upd = (date, hash, changes = {}) => ({
      update: {
        author: { display_name: 'Ana' },
        date,
        state: 'OPEN',
        title: 'PR 13',
        changes,
        source: { commit: { hash } },
      },
    })
    return sendJson(res, 200, {
      values: [
        upd('2026-02-01T10:00:00+00:00', '1e6de21d94c3', {
          status: { old: 'open', new: 'fulfilled' },
        }),
        upd('2026-02-01T09:51:56+00:00', '1e6de21d94c3'),
        upd('2026-02-01T08:37:22+00:00', '950a63ccb559'),
        upd('2026-02-01T08:36:30.600+00:00', 'fd587c1a2e6a', {
          reviewers: { added: [{ display_name: 'Eli' }] },
        }),
        upd('2026-02-01T08:36:30.300+00:00', 'fd587c1a2e6a'),
      ],
    })
  }
  // PR 11 and the range big..main have a 252,500-character diff (a lock file, say); every path gets the same answer
  if (path === `${R}/pullrequests/11/diff` || path === `${R}/diff/big..main`) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end(('+' + 'a'.repeat(99) + '\n').repeat(2500))
  }
  // PR 12 has 2,295 changed files, 100 to a page, like the real diffstat: `size` is the total on every page
  if (path === `${R}/pullrequests/12`) return sendJson(res, 200, pr(12))
  if (path === `${R}/pullrequests/12/diffstat`) {
    const page = Number(u.searchParams.get('page') || 1)
    const count = page < 23 ? 100 : 95
    return sendJson(res, 200, {
      size: 2295,
      values: Array.from({ length: count }, (_, i) => ({
        status: 'modified',
        new: { path: `f${(page - 1) * 100 + i}.ts` },
        lines_added: 2,
        lines_removed: 1,
      })),
      ...(page < 23
        ? {
            next: `${origin()}${R}/pullrequests/12/diffstat?page=${page + 1}&pagelen=100`,
          }
        : {}),
    })
  }
  // PR 9 changes nothing (an empty diff, with no --path filter involved)
  if (path === `${R}/pullrequests/9/diffstat`)
    return sendJson(res, 200, { values: [] })
  if (path === `${R}/pullrequests/9/diff`) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('')
  }
  if (path === `${R}/commits`) return sendJson(res, 200, { values: [] })
  if (path === `${R}/pullrequests`) {
    // the real endpoint answers 400 above 50 per page (found live in review run 7); so does the activity one below
    if (Number(u.searchParams.get('pagelen')) > 50)
      return sendJson(res, 400, { error: { message: 'Invalid pagelen' } })
    // live: a person's display name is not a filterable field (Bitbucket's own text, with the doubled dot)
    if ((u.searchParams.get('q') || '').includes('display_name'))
      return sendJson(res, 400, {
        error: {
          message: 'Field "user..display_name" does not support filtering',
        },
      })
    if ((u.searchParams.get('q') || '').includes('"dup"'))
      return sendJson(res, 200, {
        size: 2,
        values: [pr(5, 'develop'), pr(6, 'release/2')],
      })
    return sendJson(res, 200, { size: 0, values: [] })
  }
  if (path === `${R}/pullrequests/1` || path === `${R}/pullrequests/2`)
    return sendJson(res, 200, pr(Number(path.slice(-1))))
  // PR 7 and 8 carry the 12-character source hash the real API returns; 7's full hash can be looked up, 8's cannot.
  // 7 also has a reviewer who approved and one who asked for changes.
  if (path === `${R}/pullrequests/7` || path === `${R}/pullrequests/8`) {
    const n = Number(path.slice(-1))
    const p = pr(n)
    p.source.commit.hash = n === 7 ? SHORT7 : SHORT8
    p.destination.commit = { hash: n === 7 ? DEST7 : DEST8 }
    if (n === 7)
      p.participants = [
        {
          user: { display_name: 'Dana' },
          role: 'REVIEWER',
          approved: true,
          state: 'approved',
        },
        {
          user: { display_name: 'Eli' },
          role: 'REVIEWER',
          approved: false,
          state: 'changes_requested',
        },
        {
          user: { display_name: 'Fay' },
          role: 'REVIEWER',
          approved: false,
          state: null,
        },
      ]
    return sendJson(res, 200, p)
  }
  if (path === `${R}/commit/${SHORT7}`)
    return sendJson(res, 200, {
      hash: FULL7,
      date: '2026-01-01',
      message: 'x',
      parents: [],
    })
  if (path === `${R}/commit/${DEST7}`)
    return sendJson(res, 200, {
      hash: FULLDEST7,
      date: '2026-01-01',
      message: 'x',
      parents: [],
    })
  // a range with an end that no longer exists (a branch deleted by its merge): the same 404 an old PR gets
  if (/\/(diffstat|diff|merge-base)\/gone\.\.(main|[0-9a-f]{12})$/.test(path))
    return sendJson(res, 404, {
      error: {
        message: `The source or destination could not be found for spec: ws/repo:${path.split('/').pop()}.`,
      },
    })
  if (/\/pullrequests\/[78]\/(comments|statuses)$/.test(path))
    return sendJson(res, 200, { size: 0, values: [] })
  if (/\/pullrequests\/[127]\/diffstat$/.test(path))
    return sendJson(res, 200, {
      values: [
        {
          status: 'modified',
          new: { path: 'a.ts' },
          lines_added: 1,
          lines_removed: 0,
        },
      ],
    })
  if (/\/pullrequests\/[12]\/statuses$/.test(path))
    return sendJson(res, 200, {
      size: 12,
      values: statuses(10),
      next: `${apiBase}${R}/pullrequests/1/statuses?page=2`,
    })
  if (path === `${R}/pullrequests/1/comments`)
    return sendJson(res, 200, { size: 0, values: [] })
  if (path === `${R}/pullrequests/2/comments`)
    return sendJson(res, 403, { error: { message: 'Forbidden' } })
  if (
    path === `${R}/pullrequests/1/activity` &&
    Number(u.searchParams.get('pagelen')) > 50
  )
    return sendJson(res, 400, { error: { message: 'Invalid pagelen' } })
  if (path === `${R}/pullrequests/1/activity`)
    return sendJson(res, 200, {
      values: [
        {
          changes_requested: {
            user: { display_name: 'Dana' },
            date: '2026-01-03',
          },
          pull_request: { id: 1 },
        },
        {
          approval: { user: { display_name: 'Eli' }, date: '2026-01-04' },
          pull_request: { id: 1 },
        },
        {
          update: {
            author: { display_name: 'Ana' },
            date: '2026-01-02',
            state: 'OPEN',
            title: 'PR 1',
            changes: { reviewers: { added: [{ nickname: 'Eli' }] } },
          },
        },
        {
          update: {
            author: { display_name: 'Ana' },
            date: '2026-01-05',
            state: 'MERGED',
            title: 'PR 1',
            changes: {
              status: { old: 'open', new: 'fulfilled' },
              title: { old: 'a', new: 'b' },
            },
          },
        },
        // Bitbucket writes the opening update twice
        {
          update: {
            author: { display_name: 'Ana' },
            date: '2026-01-01',
            state: 'OPEN',
            title: 'PR 1',
            changes: {},
          },
        },
        {
          update: {
            author: { display_name: 'Ana' },
            date: '2026-01-01',
            state: 'OPEN',
            title: 'PR 1',
            changes: {},
          },
        },
      ],
    })
  if (path === `${R}/pullrequests/1/commits`)
    return sendJson(res, 200, {
      values: [
        {
          hash: SHA,
          message: 'Merged in x',
          date: '2026-01-05',
          author: { raw: 'Ana' },
          parents: [{ hash: SHA2 }, { hash: 'c'.repeat(40) }],
        },
        {
          hash: SHA2,
          message: 'Edit a',
          date: '2026-01-01',
          author: { raw: 'Ana' },
          parents: [{ hash: 'c'.repeat(40) }],
        },
      ],
    })
  if (path === `${R}/pipelines/%7Bp%7D/steps`)
    return sendJson(res, 200, {
      values: statuses(10).map((s, i) => ({
        name: `step ${i}`,
        state: { name: 'COMPLETED' },
        uuid: `{s${i}}`,
      })),
      next: `${apiBase}${R}/pipelines/%7Bp%7D/steps?page=2`,
    })
  if (path === `${R}/pipelines/%7Bp%7D/steps/%7Bs%7D/log`) {
    const buf = Buffer.from(LOG)
    const m = /^bytes=-(\d+)$/.exec(req.headers.range || '')
    if (m) {
      const start = Math.max(0, buf.length - Number(m[1]))
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${buf.length - 1}/${buf.length}`,
      })
      return res.end(buf.subarray(start))
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return res.end(buf)
  }
  if (path === `${R}/pipelines/%7Bp%7D/steps/%7Bredir%7D/log`) {
    res.writeHead(302, { location: `${foreign}/log` })
    return res.end()
  }
  if (path === `${R}/pipelines/%7Bp%7D/steps/%7Bgone%7D/log`)
    return sendJson(res, 404, { error: { message: 'Not found' } })
  if (path === '/2.0/workspaces/empty/search/code')
    return sendJson(res, 200, { size: 0, values: [] })
  if (path === '/2.0/workspaces/ws/search/code')
    return sendJson(res, 200, {
      size: 1,
      values: [
        {
          file: { path: 'src/a.ts' },
          content_match_count: 1,
          content_matches: [
            {
              lines: [
                { line: 3, segments: [{ text: 'const x = 1' }] },
                {
                  line: 4,
                  segments: [
                    { text: "'" },
                    { text: 'Ocean', match: true },
                    { text: "-Token': x" },
                  ],
                },
                { line: 9, segments: [{ text: '}' }] },
              ],
            },
          ],
        },
      ],
    })
  if (path === `${R}/commit/${SHA}`)
    return sendJson(res, 200, { hash: SHA, date: '2026-01-01', parents: [] }) // no message
  if (path === '/2.0/workspaces/ws2/search/code') {
    // two matches that both include line 4
    const line = (n, text, match) => ({
      line: n,
      segments: [{ text, ...(match ? { match: true } : {}) }],
    })
    return sendJson(res, 200, {
      size: 1,
      values: [
        {
          file: { path: 'src/b.ts' },
          content_match_count: 2,
          content_matches: [
            { lines: [line(3, 'before'), line(4, 'Ocean here', true)] },
            { lines: [line(4, 'Ocean here', true), line(5, 'after')] },
          ],
        },
      ],
    })
  }
  if (path.startsWith(`${R}/diff/`)) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('diff --git a/x b/x\n')
  }
  if (path.startsWith(`${R}/diffstat/`))
    return sendJson(res, 200, {
      values: [
        {
          status: 'modified',
          new: { path: 'a.ts' },
          lines_added: 1,
          lines_removed: 1,
        },
      ],
    })
  if (path === `${R}/src/${SHA}/big/`) {
    // Like the real API, directory listings page with an opaque token (page=ByUK); a page number is a 400.
    const token = u.searchParams.get('page')
    if (token && token !== 'ByUK')
      return sendJson(res, 400, { error: { message: 'Invalid page' } })
    const page = token ? 2 : 1
    const values = [0, 1].map((i) => ({
      type: 'commit_file',
      path: `big/p${page}-${i}.txt`,
      size: 1,
    }))
    return sendJson(res, 200, {
      values,
      ...(page < 2
        ? { next: `${origin()}${R}/src/${SHA}/big/?pagelen=50&page=ByUK` }
        : {}),
    })
  }
  if (path === `${R}/refs/branches`) {
    const page = Number(u.searchParams.get('page') || 1)
    const values = [0, 1].map((i) => ({
      name: `b${page}-${i}`,
      target: { hash: SHA, date: '2026-01-01' },
    }))
    return sendJson(res, 200, {
      size: 6,
      values,
      ...(page < 3
        ? { next: `${origin()}${R}/refs/branches?pagelen=100&page=${page + 1}` }
        : {}),
    })
  }
  // comment threads: #10 has reply #11, which has reply #12; #13 is unrelated
  if (path === `${R}/pullrequests/3/comments/10`)
    return sendJson(res, 200, {
      id: 10,
      user: { display_name: 'Ana' },
      created_on: 'd',
      content: { raw: 'root' },
    })
  if (path === `${R}/pullrequests/3/comments`) {
    const c = (id, parent, raw) => ({
      id,
      parent: parent && { id: parent },
      user: { display_name: 'Bo' },
      created_on: 'd',
      content: { raw },
    })
    return sendJson(res, 200, {
      values: [
        c(13, null, 'unrelated'),
        c(11, 10, 'reply one'),
        c(12, 11, 'reply two'),
      ],
    })
  }
  // PR 31: resolved and outdated markers, and mentions. A list carries `resolution: {}` for a resolved comment and no
  // `inline.outdated`; the single-comment endpoint carries both in full (as the live API does).
  {
    const mention = (id, name) =>
      `<span class="ap-mention" data-atlassian-id="${id}">${name}</span>`
    const comments31 = [
      {
        id: 30,
        user: { display_name: 'Dana' },
        created_on: 'd1',
        inline: { path: 'a.ts', to: 5 },
        resolution: {},
        content: { raw: 'root' },
      },
      {
        id: 31,
        user: { display_name: 'Dana' },
        created_on: 'd1',
        inline: { path: 'b.ts', to: 9 },
        content: { raw: 'still open' },
      },
      {
        id: 32,
        parent: { id: 30 },
        user: { display_name: 'Bo' },
        created_on: 'd3',
        content: {
          raw: '@{acc:1} thanks @{acc:2} and @{acc:9}',
          html: `<p>${mention('acc:1', '@Ana B')} thanks ${mention('acc:2', '@Bo &amp; Co')} and @{acc:9}</p>`,
        },
      },
      {
        id: 33,
        user: { display_name: 'Bo' },
        created_on: 'd4',
        content: { raw: '@{acc:1} hi' },
      }, // no HTML: stays as written
      {
        id: 34,
        user: { display_name: 'Bo' },
        created_on: 'd5',
        content: {
          raw: '@{acc:3}',
          html: `<p>${mention('acc:3', '@O&#39;Neil &#x41; &#99999999;')}</p>`,
        },
      },
    ]
    if (path === `${R}/pullrequests/31/comments/30`)
      return sendJson(res, 200, {
        ...comments31[0],
        inline: { path: 'a.ts', to: 5, outdated: true },
        resolution: {
          type: 'comment_resolution',
          user: { display_name: 'Eli' },
          created_on: 'd2',
        },
      })
    if (path === `${R}/pullrequests/31/comments`)
      return sendJson(res, 200, { size: comments31.length, values: comments31 })
    if (path === `${R}/pullrequests/31/activity`)
      return sendJson(res, 200, {
        values: [
          { comment: comments31[0] },
          { comment: comments31[2] },
          { comment: comments31[1] },
        ],
      })
  }
  // PR 4 never runs out of comment pages, to reach the comment-thread page cap
  if (path === `${R}/pullrequests/4/comments/20`)
    return sendJson(res, 200, {
      id: 20,
      user: { display_name: 'Ana' },
      created_on: 'd',
      content: { raw: 'root' },
    })
  if (path === `${R}/pullrequests/4/comments`) {
    const page = Number(u.searchParams.get('page') || 1)
    return sendJson(res, 200, {
      values: [
        {
          id: 1000 + page,
          user: { display_name: 'Bo' },
          created_on: 'd',
          content: { raw: 'x' },
        },
      ],
      next: `${origin()}${R}/pullrequests/4/comments?page=${page + 1}`,
    })
  }
  // retry behaviour
  const hit = (hits[path] = (hits[path] || 0) + 1)
  if (path === `${R}/flaky503`)
    return hit < 3
      ? sendJson(res, 503, { error: { message: 'busy' } })
      : sendJson(res, 200, { ok: true })
  if (path === `${R}/always503`)
    return sendJson(res, 503, { error: { message: 'down' } })
  if (path === `${R}/rate429`) {
    if (hit > 1) return sendJson(res, 200, { ok: true })
    res.writeHead(429, {
      'retry-after': '0.05',
      'content-type': 'application/json',
    })
    return res.end(JSON.stringify({ error: { message: 'slow down' } }))
  }
  if (path === `${R}/rate429long`) {
    res.writeHead(429, {
      'retry-after': '31',
      'content-type': 'application/json',
    })
    return res.end(JSON.stringify({ error: { message: 'slow down' } }))
  }
  if (path === `${R}/reset`) return req.socket.destroy()
  if (path === `${R}/hang`) return // never answers; the CLI's timeout has to end it
  if (path === '/2.0/repositories/ws/htmlrepo') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<!DOCTYPE html><html><body>Please log in</body></html>')
  }
  sendJson(res, 404, { error: { message: `no mock for ${path}` } })
}

function foreignHandler(req, res) {
  foreignSeen.push({ path: req.url, auth: Boolean(req.headers.authorization) })
  res.writeHead(200, { 'content-type': 'application/octet-stream' })
  res.end('stored log\n\x1b[32mok\x1b[0m\n')
}

const listen = (handler) =>
  new Promise((done) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => done(s))
  })

function bb(args, env = {}) {
  const base = { ...process.env }
  for (const k of Object.keys(base))
    if (/^(BITBUCKET_|HTTPS?_PROXY$|NODE_USE_ENV_PROXY$)/i.test(k))
      delete base[k]
  return new Promise((done) => {
    execFile(
      process.execPath,
      [BB, ...args],
      {
        env: {
          ...base,
          BITBUCKET_API_BASE: apiBase,
          BITBUCKET_EMAIL: 'me@example.com',
          BITBUCKET_API_TOKEN: 'dummy',
          ...env,
        },
      },
      (err, stdout, stderr) =>
        done({ code: err ? err.code : 0, stdout, stderr })
    )
  })
}

const requested = (path) => seen.filter((s) => s.path === path)

describe('CLI against a mock API', () => {
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
    api.closeAllConnections() // the "hang" mock never finishes its responses
    api.close()
    foreignSrv.close()
  })

  test('extra positional arguments are rejected with a flag suggestion (M3)', async () => {
    let r = await bb(['commits', 'ws/repo', 'develop'])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Unexpected argument "develop"\. Did you mean --branch develop\?/
    )
    r = await bb(['file', 'ws/repo', 'src/a.ts', 'feature/x'])
    assert.match(r.stderr, /Did you mean --ref feature\/x\?/)
    r = await bb([
      'pr',
      'https://bitbucket.org/ws/repo/pull-requests/1',
      'extra',
    ])
    assert.match(r.stderr, /Unexpected argument "extra"/)
  })

  test('status and step lists ask for 100 and keep the more-results footer (M4)', async () => {
    let r = await bb(['pr-statuses', 'ws/repo', '1'])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /\(more results/)
    assert.equal(
      requested('/2.0/repositories/ws/repo/pullrequests/1/statuses')
        .at(-1)
        .query.get('pagelen'),
      '100'
    )
    r = await bb(['pipeline-steps', 'ws/repo', 'p'])
    assert.match(r.stdout, /\(more results/)
  })

  test('pr-context warns about partial build statuses (M4)', async () => {
    const r = await bb(['pr-context', 'ws/repo', '1'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /WARNING: only the first 10 build statuses/)
  })

  test('pr-context prints the source commit and, with --full, an explicit empty description', async () => {
    let r = await bb(['pr-context', 'ws/repo', '1'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`Source commit: ${SHA2}`))
    assert.doesNotMatch(r.stdout, /--- Description ---/)
    r = await bb(['pr-context', 'ws/repo', '1', '--full'])
    assert.match(r.stdout, /--- Description ---\n\(none\)/)
  })

  test('search-code keeps snippet text verbatim and marks matches and gaps', async () => {
    const r = await bb(['search-code', 'ws', 'Ocean'])
    assert.equal(r.code, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /\[\[/)
    assert.match(r.stdout, /^ {4}3: const x = 1$/m)
    assert.match(r.stdout, /^ {2}> 4: 'Ocean-Token': x$/m)
    assert.match(r.stdout, /4: 'Ocean-Token': x\n {4}\.\.\.\n {4}9: \}/)
    assert.match(r.stdout, /search index and can be incomplete/)
  })

  test('search-code --files prints paths only and an unquoted phrase gets a quoting tip', async () => {
    let r = await bb(['search-code', 'ws', 'Ocean-Token', '--files'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^src\/a\.ts \(1 matches\)$/m)
    assert.doesNotMatch(r.stdout, /const x = 1/)
    assert.doesNotMatch(r.stdout, /Snippets come from/)
    assert.match(r.stdout, /quote it, e\.g\. '"Ocean-Token"'/)
    r = await bb(['search-code', 'ws', '"Ocean-Token"'])
    assert.doesNotMatch(r.stdout, /quote it/)
    r = await bb(['search-code', 'ws', 'Ocean'])
    assert.doesNotMatch(r.stdout, /quote it/)
  })

  test("the PR's abbreviated source hash is resolved to the full sha, in pr and pr-context", async () => {
    for (const args of [
      ['pr', 'ws/repo', '7'],
      ['pr-context', 'ws/repo', '7'],
    ]) {
      const r = await bb(args)
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, new RegExp(`Source commit: ${FULL7}\\n`), args[0])
    }
  })

  test('when the full sha cannot be looked up, the briefing says the hash is abbreviated', async () => {
    for (const args of [
      ['pr', 'ws/repo', '8'],
      ['pr-context', 'ws/repo', '8'],
    ]) {
      const r = await bb(args)
      assert.equal(r.code, 0, r.stderr)
      assert.match(
        r.stdout,
        new RegExp(`Source commit: ${SHORT8} \\(abbreviated\\)`),
        args[0]
      )
    }
  })

  test('a 40-character source hash needs no extra request', async () => {
    const before = seen.length
    await bb(['pr', 'ws/repo', '1'])
    assert.equal(
      seen.slice(before).filter((s) => s.path.includes('/commit/')).length,
      0
    )
  })

  test('pr-context shows who approved and who asked for changes', async () => {
    let r = await bb(['pr-context', 'ws/repo', '7'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^Approved by: Dana$/m)
    assert.match(r.stdout, /^Changes requested by: Eli$/m)
    r = await bb(['pr-context', 'ws/repo', '1'])
    assert.match(r.stdout, /^Approved by: none$/m)
    assert.doesNotMatch(r.stdout, /Changes requested by/)
  })

  test('pr lists participants without repeating an approval', async () => {
    const r = await bb(['pr', 'ws/repo', '7'])
    assert.match(
      r.stdout,
      /Participants: Dana \(approved\), Eli \[changes_requested\], Fay\n/
    )
  })

  test('pr-activity folds the duplicated opening update', async () => {
    const r = await bb(['pr-activity', 'ws/repo', '1'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal((r.stdout.match(/state=OPEN title="PR 1"/g) || []).length, 1)
    assert.match(
      r.stdout,
      /state=OPEN title="PR 1" \(listed 2 times by Bitbucket\)/
    )
    // updates that changed something are never folded
    assert.match(r.stdout, /reviewers added: Eli/)
    assert.match(r.stdout, /status open -> fulfilled \(merged\); title changed/)
  })

  test('pr-commits labels the merge commit', async () => {
    const r = await bb(['pr-commits', 'ws/repo', '1'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      new RegExp(`- ${SHA.slice(0, 8)} \\(merge commit\\) Merged in x`)
    )
    assert.doesNotMatch(
      r.stdout,
      new RegExp(`${SHA2.slice(0, 8)} \\(merge commit\\)`)
    )
  })

  test('pr-activity says what an update changed', async () => {
    const r = await bb(['pr-activity', 'ws/repo', '1'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /update by Ana \(2026-01-02\): reviewers added: Eli/)
    assert.match(
      r.stdout,
      /update by Ana \(2026-01-05\): status open -> fulfilled \(merged\); title changed/
    )
    assert.match(
      r.stdout,
      /update by Ana \(2026-01-01\): state=OPEN title="PR 1"/
    )
  })

  test('browse with no path lists /src/{sha}/ (L1)', async () => {
    const r = await bb(['browse', 'ws/repo'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /two\.txt/)
    assert.equal(requested('/2.0/repositories/ws/repo/src').length, 0)
    assert.ok(requested(`/2.0/repositories/ws/repo/src/${SHA}/`).length)
  })

  test('file does not count the trailing newline (L2)', async () => {
    const r = await bb(['file', 'ws/repo', 'two.txt'])
    assert.match(r.stdout, /lines 1-2 of 2/)
  })

  test('pr-activity names changes requested (L3)', async () => {
    const r = await bb(['pr-activity', 'ws/repo', '1'])
    assert.match(r.stdout, /changes requested by Dana \(2026-01-03\)/)
    assert.doesNotMatch(r.stdout, /pull_request/)
  })

  test('list flags on a non-list command are rejected (L4)', async () => {
    const r = await bb(['pr-diff', 'ws/repo', '1', '--all'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /not a list command/)
  })

  test('bad numbers and settings fail clearly (L5)', async () => {
    let r = await bb(['pipeline-step-log', 'ws/repo', 'p', 's', '--tail', '0'])
    assert.match(r.stderr, /--tail must be a positive whole number/)
    r = await bb(['repo', 'ws/repo'], { BITBUCKET_REQUEST_TIMEOUT: '-5' })
    assert.match(r.stderr, /BITBUCKET_REQUEST_TIMEOUT must be/)
    r = await bb(['repo', 'ws/repo'], { BITBUCKET_API_BASE: 'not a url' })
    assert.match(r.stderr, /is not a valid URL/)
  })

  test('dot segments never reach the API (L6)', async () => {
    const before = seen.length
    const r = await bb(['commit', 'ws/repo', '..'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Invalid path segment/)
    assert.equal(seen.length, before)
  })

  test('step log: range request, ANSI stripped, tail kept (L7)', async () => {
    const r = await bb([
      'pipeline-step-log',
      'ws/repo',
      'p',
      's',
      '--tail',
      '100',
    ])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /FAILURE: boom/)
    // eslint-disable-next-line no-control-regex -- checks that no escape character reaches the output
    assert.doesNotMatch(r.stdout, /\x1b/)
    assert.match(r.stdout, /showing last 100 chars of a \d+-byte log/)
    assert.equal(
      requested(
        '/2.0/repositories/ws/repo/pipelines/%7Bp%7D/steps/%7Bs%7D/log'
      ).at(-1).range,
      'bytes=-400'
    )
  })

  test('step log 404 gets a log-specific hint (L7)', async () => {
    const r = await bb(['pipeline-step-log', 'ws/repo', 'p', 'gone'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Hint: No log for this step/)
  })

  test('check: 403 means credentials accepted; 401 exits 1 (L8)', async () => {
    let r = await bb(['check'], { BITBUCKET_API_TOKEN: 'noscope' })
    assert.equal(r.code, 0)
    assert.match(
      r.stdout,
      /Credentials accepted, but the token cannot read your account/
    )
    r = await bb(['check'], { BITBUCKET_API_TOKEN: 'bad' })
    assert.equal(r.code, 1)
    assert.match(r.stdout, /Auth check failed/)
  })

  test('redirects off the API origin are refused (L9)', async () => {
    const r = await bb(['get', 'redir-foreign'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Refusing to follow a redirect/)
    assert.equal(foreignSeen.filter((s) => s.path === '/other').length, 0)
  })

  test('the step log may redirect to storage, without credentials (L9)', async () => {
    const r = await bb(['pipeline-step-log', 'ws/repo', 'p', 'redir'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /stored log\nok/)
    const hit = foreignSeen.filter((s) => s.path === '/log')
    assert.ok(hit.length)
    assert.ok(hit.every((s) => !s.auth))
  })

  test('pr-context --branch lists candidates when there are several (L10)', async () => {
    const r = await bb(['pr-context', 'ws/repo', '--branch', 'dup'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /2 open pull requests come from branch "dup"/)
    assert.match(r.stdout, /#5 .*-> develop/)
    assert.match(r.stdout, /#6 .*-> release\/2/)
  })

  test('prs without --state says it lists open PRs only (L11)', async () => {
    const r = await bb(['prs', 'ws/repo'])
    assert.match(
      r.stdout,
      /No open pull requests found .* only listed with --state/
    )
  })

  test('file-history resolves slash branches first (L12)', async () => {
    const r = await bb(['file-history', 'ws/repo', 'feature/x', 'src/a.ts'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Edit a/)
  })

  test('file-history shows message, author and date from commit lookups, never undefined', async () => {
    const r = await bb(['file-history', 'ws/repo', 'feature/x', 'src/a.ts'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      new RegExp(
        `^- ${H_NEW.slice(0, 8)} Edit a\\n {4}Ana {2}2026-02-01 {2}\\(7 bytes\\)$`,
        'm'
      )
    )
    // an author with a linked account is shown by display name, not by the raw "Name <email>"
    assert.match(
      r.stdout,
      new RegExp(
        `^- ${H_OLD.slice(0, 8)} Add old-a\\n {4}Bo {2}2026-01-01 {2}\\(5 bytes, as src/old-a\\.ts\\)$`,
        'm'
      )
    )
    assert.doesNotMatch(r.stdout, /undefined|unknown|bo@example/)
    assert.equal(
      requested(`/2.0/repositories/ws/repo/commit/${H_NEW}`).length >= 1,
      true
    )
  })

  test('file-history keeps the entry when its commit lookup fails, and says so', async () => {
    const r = await bb(['file-history', 'ws/repo', 'feature/x', 'src/a.ts'])
    assert.match(
      r.stdout,
      new RegExp(
        `^- ${H_GONE.slice(0, 8)} {2}\\(4 bytes, as src/old-a\\.ts\\)$`,
        'm'
      )
    )
    assert.match(
      r.stdout,
      /\(1 commit lookup\(s\) failed; those entries show the hash only\)/
    )
  })

  test('file-history --json carries the full commit objects', async () => {
    const r = await bb([
      'file-history',
      'ws/repo',
      'feature/x',
      'src/a.ts',
      '--select',
      'path,commit.message,commit.hash',
    ])
    assert.equal(r.code, 0, r.stderr)
    const v = JSON.parse(r.stdout).values
    assert.equal(v[0]['commit.message'], 'Edit a\n\nlong body')
    assert.equal(v[1].path, 'src/old-a.ts')
    assert.equal(v[2]['commit.message'], null) // failed lookup: only the hash is known
    assert.equal(v[2]['commit.hash'], H_GONE)
  })

  test('file-history looks up commit details for the first 25 entries only', async () => {
    const r = await bb(['file-history', 'ws/repo', 'feature/x', 'src/many.ts'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal((r.stdout.match(/ msg [0-9a-f]{2}$/gm) || []).length, 25)
    assert.match(
      r.stdout,
      new RegExp(`^- ${manyHash(26).slice(0, 8)} {2}\\(26 bytes\\)$`, 'm')
    )
    assert.match(r.stdout, /looked up for the first 25 entries only/)
    const lookups = seen.filter((s) =>
      /\/commit\/9{38}[0-9a-f]{2}$/.test(s.path)
    )
    assert.equal(lookups.length, 25)
  })

  test('file-history on a path that is not there gets the browse hint (not the ref-spelling hint)', async () => {
    const r = await bb(['file-history', 'ws/repo', 'feature/x', 'src/none.ts'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /404 .*No such file: src\/none\.ts/)
    assert.match(
      r.stderr,
      /Hint: 'src\/none\.ts' does not exist at ref 'feature\/x' \(the ref itself resolved\)/
    )
    assert.match(
      r.stderr,
      /node bb\.mjs browse ws\/repo src --ref feature\/x$/m
    )
    assert.doesNotMatch(r.stderr, /Check workspace\/repo\/ref spelling/)
  })

  test('issues and issue explain that the issue tracker is gone (410)', async () => {
    for (const args of [
      ['issues', 'ws/repo'],
      ['issue', 'ws/repo', '1'],
    ]) {
      const r = await bb(args)
      assert.equal(r.code, 1, args.join(' '))
      assert.match(
        r.stderr,
        /410 Gone - CHANGE-3071 - Functionality has been deprecated/
      )
      assert.match(
        r.stderr,
        /Hint: Bitbucket's native issue tracker has been removed.*issues and issue no longer work\. Use Jira/
      )
    }
  })

  test('any other 410 gets a generic removed-endpoint hint with the changelog', async () => {
    const r = await bb(['get', 'repositories/ws/repo/issues'])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Hint: Bitbucket answers 410 Gone for endpoints it has removed or deprecated/
    )
    assert.match(
      r.stderr,
      /developer\.atlassian\.com\/cloud\/bitbucket\/changelog/
    )
  })

  test('pr-context --branch with no open PR says how to search closed ones', async () => {
    const r = await bb(['pr-context', 'ws/repo', '--branch', 'bugfix/gone'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /^No open pull request found for branch "bugfix\/gone" in ws\/repo\./
    )
    assert.match(
      r.stdout,
      /Merged, declined and superseded PRs are not searched here/
    )
    assert.match(
      r.stdout,
      /node bb\.mjs prs ws\/repo --state ALL --q 'source\.branch\.name="bugfix\/gone"'/
    )
  })

  test('a --path that matches nothing is named in the empty result (diff, diffstat, pr-diff, pr-diffstat)', async () => {
    const cases = [
      [
        ['pr-diffstat', 'ws/repo', '1', '--path', 'nope.ts'],
        /^No changes found for PR #1 in ws\/repo matching --path nope\.ts\. Check the paths against pr-diffstat without --path\./,
      ],
      [
        ['pr-diff', 'ws/repo', '1', '--path', 'nope.ts,also.ts'],
        /^No changes found for PR #1 matching --path nope\.ts,also\.ts\. Check the paths against pr-diffstat without --path\./,
      ],
      [
        ['diffstat', 'ws/repo', 'a..b', '--path', 'nope.ts'],
        /^No changes found for a\.\.b in ws\/repo matching --path nope\.ts\. Check the paths against diffstat without --path\./,
      ],
      [
        ['diff', 'ws/repo', 'a..b', '--path', 'nope.ts'],
        /^No changes found for a\.\.b matching --path nope\.ts\. Check the paths against diffstat without --path\./,
      ],
    ]
    for (const [args, expected] of cases) {
      const r = await bb(args)
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`)
      assert.match(r.stdout, expected, args.join(' '))
    }
  })

  test('an empty range says which way round Bitbucket reads it (diff and diffstat)', async () => {
    const hint =
      /Bitbucket reads <source>\.\.<dest> the reverse of git diff \(what <source> has that <dest> lacks\): if you expected changes, try "main\.\.empty"\.$/
    let r = await bb(['diffstat', 'ws/repo', 'empty..main'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout.trim(),
      /^No changes found for empty\.\.main in ws\/repo\. /
    )
    assert.match(r.stdout.trim(), hint)
    r = await bb(['diff', 'ws/repo', 'empty..main'])
    assert.match(r.stdout.trim(), /^No changes found for empty\.\.main\. /)
    assert.match(r.stdout.trim(), hint)
  })

  test('the range hint comes after the --path note, and a single commit or a PR gets none', async () => {
    let r = await bb(['diffstat', 'ws/repo', 'a..b', '--path', 'nope.ts'])
    assert.match(
      r.stdout,
      /matching --path nope\.ts\. Check the paths against diffstat without --path\. Bitbucket reads <source>\.\.<dest> the reverse.*try "b\.\.a"\./
    )
    r = await bb(['diffstat', 'ws/repo', 'emptyc'])
    assert.equal(r.stdout.trim(), 'No changes found for emptyc in ws/repo.')
    r = await bb(['pr-diffstat', 'ws/repo', '9'])
    assert.doesNotMatch(r.stdout, /reverse of git diff/)
  })

  test('an empty diff without a --path filter does not mention one', async () => {
    let r = await bb(['pr-diffstat', 'ws/repo', '9'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'No changes found for PR #9 in ws/repo.')
    r = await bb(['pr-diff', 'ws/repo', '9'])
    assert.equal(r.stdout.trim(), 'No changes found for PR #9.')
  })

  test('pr-context does not retry comments after a non-400 error (nit)', async () => {
    const path = '/2.0/repositories/ws/repo/pullrequests/2/comments'
    const before = requested(path).length
    const r = await bb(['pr-context', 'ws/repo', '2'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /--- Comments ---\nUnavailable:/)
    assert.equal(requested(path).length - before, 1)
  })

  test('help for an unknown command is an error (nit)', async () => {
    let r = await bb(['help', 'nosuch'])
    assert.equal(r.code, 1)
    r = await bb(['nosuch', '--help'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Unknown command "nosuch"/)
  })

  test('a non-Bitbucket URL gets a warning (nit)', async () => {
    const r = await bb(['pr', 'https://github.com/ws/repo/pull-requests/1'])
    assert.match(r.stderr, /Warning: github\.com is not bitbucket\.org/)
  })

  // ---- M5: where credentials may go

  test('credentials are never sent to a host other than api.bitbucket.org (M5)', async () => {
    for (const base of [
      'https://attacker.example/2.0',
      'https://api.bitbucket.org.attacker.example/2.0',
    ]) {
      const r = await bb(['check'], { BITBUCKET_API_BASE: base })
      assert.equal(r.code, 1, base)
      assert.match(
        r.stderr,
        /credentials are only sent to api\.bitbucket\.org/,
        base
      )
      assert.doesNotMatch(r.stdout, /Authenticated|Auth check/)
    }
  })

  test('a non-loopback http:// API base and one with a password are refused (M5)', async () => {
    let r = await bb(['check'], {
      BITBUCKET_API_BASE: 'http://example.com/2.0',
    })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /must be an https:\/\/ URL/)
    r = await bb(['check'], {
      BITBUCKET_API_BASE: 'https://user:secret@api.bitbucket.org/2.0',
    })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /must not contain a user name or password/)
    assert.doesNotMatch(r.stdout + r.stderr, /secret/)
  })

  test('credentials are refused while TLS verification is off (M5)', async () => {
    // Fails before any request is made, so nothing leaves the machine.
    const r = await bb(['repo', 'ws/repo'], {
      BITBUCKET_API_BASE: 'https://api.bitbucket.org/2.0',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    })
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Refusing to send credentials while NODE_TLS_REJECT_UNAUTHORIZED=0/
    )
  })

  test('Authorization is sent to the API origin, and only when credentials are set', async () => {
    await bb(['repo', 'ws/repo'])
    assert.equal(requested('/2.0/repositories/ws/repo').at(-1).auth, true)
    await bb(['repo', 'ws/repo'], {
      BITBUCKET_EMAIL: '',
      BITBUCKET_API_TOKEN: '',
    })
    assert.equal(requested('/2.0/repositories/ws/repo').at(-1).auth, false)
  })

  // ---- M1: get and secrets

  test('get refuses secret-bearing endpoints before any request (M1)', async () => {
    const before = seen.length
    for (const target of [
      'repositories/ws/repo/hooks',
      'repositories/ws/repo/%68ooks',
      'repositories/ws/repo/pipelines_config/variables/',
      'user/emails',
      `${apiBase}/repositories/ws/repo/deploy-keys`,
    ]) {
      const r = await bb(['get', target])
      assert.equal(r.code, 1, target)
      assert.match(r.stderr, /can hold secrets/, target)
    }
    assert.equal(seen.length, before)
    const ok = await bb(['get', 'repositories/ws/repo'])
    assert.equal(ok.code, 0, ok.stderr)
    assert.match(ok.stdout, /"full_name": "ws\/repo"/)
  })

  // ---- M6: range order and --two-dot

  test('diff and diffstat send the range as given and topic=false only for --two-dot (M6)', async () => {
    const R = '/2.0/repositories/ws/repo'
    let r = await bb(['diff', 'ws/repo', 'feature..main'])
    assert.equal(r.code, 0, r.stderr)
    let q = requested(`${R}/diff/feature..main`).at(-1).query
    assert.equal(q.has('topic'), false)
    r = await bb([
      'diff',
      'ws/repo',
      'feature..main',
      '--two-dot',
      '--path',
      'a.ts,b.ts',
    ])
    assert.equal(r.code, 0, r.stderr)
    q = requested(`${R}/diff/feature..main`).at(-1).query
    assert.equal(q.get('topic'), 'false')
    assert.deepEqual(q.getAll('path'), ['a.ts', 'b.ts'])
    r = await bb(['diffstat', 'ws/repo', 'feature..main', '--two-dot'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(
      requested(`${R}/diffstat/feature..main`).at(-1).query.get('topic'),
      'false'
    )
  })

  test('--two-dot needs a range and --topic is rejected (M6)', async () => {
    let r = await bb(['diff', 'ws/repo', SHA, '--two-dot'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--two-dot only applies to a range/)
    r = await bb(['diff', 'ws/repo', 'a..b', '--topic'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--topic was removed/)
  })

  test('help spells out the range order (M6)', async () => {
    for (const c of ['diff', 'diffstat']) {
      const r = await bb(['help', c])
      assert.match(r.stdout, /REVERSE of git diff/)
      assert.match(r.stdout, /feature\.\.main/)
    }
  })

  // ---- L13: --select

  test('--select maps through arrays, keeps missing keys as null and warns (L13)', async () => {
    const r = await bb([
      'pr-commits',
      'ws/repo',
      '1',
      '--select',
      'hash,parents.hash,nope',
    ])
    assert.equal(r.code, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.values[0]['parents.hash'], [SHA2, 'c'.repeat(40)])
    assert.equal(out.values[0].nope, null)
    assert.match(r.stderr, /"nope" matched nothing/)
  })

  // ---- L14: Git Bash path rewriting

  test('a Git Bash rewritten path is explained, not sent as a 404 (L14)', async () => {
    const before = seen.length
    const bad = 'C:/Program Files/Git/src/a.ts'
    for (const args of [
      ['file', 'ws/repo', bad],
      ['browse', 'ws/repo', bad],
      ['file-history', 'ws/repo', 'main', bad],
      ['diff', 'ws/repo', 'a..b', `--path=${bad}`],
      ['diffstat', 'ws/repo', 'a..b', `--path=${bad}`],
      ['pr-diff', 'ws/repo', '1', `--path=${bad}`],
      ['pr-diffstat', 'ws/repo', '1', `--path=${bad}`],
    ]) {
      const r = await bb(args)
      assert.equal(r.code, 1, args.join(' '))
      assert.match(r.stderr, /Git Bash \(MSYS\) rewrote/, args.join(' '))
    }
    assert.equal(seen.length, before)
  })

  // ---- L15, L16, L17

  test('a git remote URL works as the repository (L16)', async () => {
    const r = await bb(['repo', 'git@bitbucket.org:ws/repo.git'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Repository: ws\/repo/)
  })

  test('a bare repo name uses BITBUCKET_WORKSPACE', async () => {
    const r = await bb(['repo', 'repo'], { BITBUCKET_WORKSPACE: 'ws' })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Repository: ws\/repo/)
  })

  test('pr-context rejects an id together with --branch (L17)', async () => {
    const before = seen.length
    const r = await bb(['pr-context', 'ws/repo', '1', '--branch', 'dup'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /either a PR id\/URL or --branch, not both/)
    assert.equal(seen.length, before)
  })

  // ---- L18: browse paging

  test('browse pages a directory and --all follows every page (L18)', async () => {
    let r = await bb(['browse', 'ws/repo', 'big'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /p1-0\.txt/)
    assert.doesNotMatch(r.stdout, /p2-0\.txt/)
    // the next link carries a token, not a number, so the footer must not advise --page N
    assert.match(
      r.stdout,
      /\(more results — this endpoint pages with tokens, so --page N does not work: rerun with --all/
    )
    assert.doesNotMatch(r.stdout, /rerun with --page 2/)
    r = await bb(['browse', 'ws/repo', 'big', '--page', '2'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /400 Bad Request - Invalid page/)
    assert.match(r.stderr, /Hint: --page N is not supported by this endpoint/)
    r = await bb(['browse', 'ws/repo', 'big', '--all'])
    assert.match(r.stdout, /p1-0\.txt[\s\S]*p2-1\.txt/)
    assert.doesNotMatch(r.stdout, /more results/)
    r = await bb(['browse', 'ws/repo', 'big', '--limit', '5'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--limit applies to files/)
  })

  // ---- L19: prs states

  test('prs --state takes several states, and ALL (L19)', async () => {
    const P = '/2.0/repositories/ws/repo/pullrequests'
    let r = await bb(['prs', 'ws/repo', '--state', 'MERGED,declined'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(requested(P).at(-1).query.getAll('state'), [
      'MERGED',
      'DECLINED',
    ])
    r = await bb(['prs', 'ws/repo', '--state', 'ALL'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(requested(P).at(-1).query.getAll('state'), [
      'OPEN',
      'MERGED',
      'DECLINED',
      'SUPERSEDED',
    ])
    r = await bb(['prs', 'ws/repo', '--state', 'done'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Unknown pull request state "DONE"/)
  })

  test("prs --q on state does not depend on Bitbucket's default OPEN filter (L19)", async () => {
    const P = '/2.0/repositories/ws/repo/pullrequests'
    await bb(['prs', 'ws/repo', '--q', 'state="MERGED"'])
    const q = requested(P).at(-1).query
    assert.equal(q.get('q'), 'state="MERGED"')
    assert.equal(q.getAll('state').length, 4)
  })

  // ---- L20: output flags are checked before the request

  test('a bad --max-chars or empty --select fails before any request (L20)', async () => {
    const before = seen.length
    let r = await bb(['repo', 'ws/repo', '--max-chars', 'abc'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--max-chars must be a positive whole number/)
    r = await bb(['repo', 'ws/repo', '--max-chars', ''])
    assert.equal(r.code, 1)
    r = await bb(['repo', 'ws/repo', '--select', ''])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--select needs at least one field/)
    assert.equal(seen.length, before)
  })

  // ---- nits

  test('search-code prints a line covered by two matches once', async () => {
    const r = await bb(['search-code', 'ws2', 'Ocean'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal((r.stdout.match(/4: Ocean here/g) || []).length, 1)
    assert.match(r.stdout, /3: before\n {2}> 4: Ocean here\n {4}5: after\n/)
    assert.doesNotMatch(r.stdout, /\.\.\./)
  })

  test('search-code with no matches says the index may cover only the main branch', async () => {
    let r = await bb(['search-code', 'empty', 'Ocean'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /^No code matches found\.\n\n\(An empty result does not mean the code is absent/
    )
    assert.match(r.stdout, /`file --ref <branch or sha>` or `pr-diff`/)
    r = await bb(['search-code', 'empty', 'Ocean', '--files'])
    assert.match(r.stdout, /may cover only each repository's main branch/)
    r = await bb(['search-code', 'ws', 'Ocean'])
    assert.doesNotMatch(r.stdout, /main branch/)
  })

  test('a path missing at a ref that resolved gets a browse hint, not the ref-spelling hint', async () => {
    let r = await bb(['file', 'ws/repo', 'sub/nope.txt'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /404 .*No such file or directory: sub\/nope\.txt/)
    assert.match(
      r.stderr,
      /Hint: 'sub\/nope\.txt' does not exist at ref 'main' \(the ref itself resolved\)/
    )
    assert.match(r.stderr, /node bb\.mjs browse ws\/repo sub --ref main$/m)
    assert.doesNotMatch(r.stderr, /Check workspace\/repo\/ref spelling/)
    r = await bb(['browse', 'ws/repo', 'sub/nope.txt', '--ref', 'main'])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Hint: 'sub\/nope\.txt' does not exist at ref 'main'/
    )
    // the same API answer through `get` keeps a generic form of the hint
    r = await bb(['get', `repositories/ws/repo/src/${SHA}/sub/nope.txt`])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Hint: The ref resolved but this path does not exist in it/
    )
    assert.match(r.stderr, /browse <ws>\/<repo> <dir> --ref <ref>/)
  })

  test('a printed browse command quotes a directory with a space so it can be pasted', async () => {
    const r = await bb(['file', 'ws/repo', 'dir with space/x.ts'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /No such file or directory: dir with space\/x\.ts/)
    assert.match(
      r.stderr,
      /list its directory with: node bb\.mjs browse ws\/repo 'dir with space' --ref main$/m
    )
    // a directory without special characters is left as it was
    const plain = await bb(['file', 'ws/repo', 'sub/nope.txt'])
    assert.match(plain.stderr, /browse ws\/repo sub --ref main$/m)
  })

  test('the prs command printed by pr-context --branch is quoted even for an apostrophe in the branch', async () => {
    let r = await bb(['pr-context', 'ws/repo', '--branch', 'bugfix/gone'])
    assert.match(
      r.stdout,
      /--state ALL --q 'source\.branch\.name="bugfix\/gone"'/
    )
    r = await bb(['pr-context', 'ws/repo', '--branch', "o'neil"])
    assert.match(r.stdout, /--q 'source\.branch\.name="o'\\''neil"'/)
  })

  test('--all with --page and --max-pages without --all are refused before any request (CLI)', async () => {
    const before = seen.length
    let r = await bb(['branches', 'ws/repo', '--all', '--page', '3'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--page cannot be combined with --all/)
    r = await bb(['tags', 'ws/repo', '--max-pages', '5'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--max-pages only applies together with --all/)
    assert.equal(seen.length, before)
    // the valid combinations still reach the API
    r = await bb(['branches', 'ws/repo', '--all', '--max-pages', '2'])
    assert.equal(r.code, 0, r.stderr)
    r = await bb(['branches', 'ws/repo', '--page', '2'])
    assert.equal(r.code, 0, r.stderr)
  })

  test('a huge binary file is not downloaded: the notice has its size and the server is cut off early', async () => {
    const r = await bb(['file', 'ws/repo', 'big.bin'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(
      r.stdout.trim(),
      'File: big.bin @ main looks like a binary file (contains NUL bytes, 32.0 MB); content not shown.'
    )
    const sent = sentBy[`/2.0/repositories/ws/repo/src/${SHA}/big.bin`]
    assert.ok(
      sent > 0 && sent < BIG_TOTAL / 2,
      `server wrote ${sent} of ${BIG_TOTAL} bytes`
    )
  })

  test('browse on a huge binary path takes the same early exit', async () => {
    const r = await bb(['browse', 'ws/repo', 'big.bin'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /big\.bin @ main looks like a binary file \(contains NUL bytes, 32\.0 MB\)/
    )
    assert.ok(
      sentBy[`/2.0/repositories/ws/repo/src/${SHA}/big.bin`] < BIG_TOTAL / 2
    )
  })

  test('a huge text file over the limit is refused with its size, and --json says so', async () => {
    let r = await bb(['file', 'ws/repo', 'big.txt'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /^File: big\.txt @ main is 32\.0 MB, over the 10\.0 MB limit, so it was not downloaded\./
    )
    assert.match(
      r.stdout,
      /set BITBUCKET_MAX_FILE_BYTES to a larger number of bytes in your environment \(not in the chat\)/
    )
    assert.ok(
      sentBy[`/2.0/repositories/ws/repo/src/${SHA}/big.txt`] < BIG_TOTAL / 2
    )
    r = await bb(['file', 'ws/repo', 'big.txt', '--json'])
    const j = JSON.parse(r.stdout)
    assert.equal(j.too_large, true)
    assert.equal(j.size, BIG_TOTAL)
    assert.equal(j.max_bytes, 10_000_000)
  })

  test('BITBUCKET_MAX_FILE_BYTES sets the limit (8 bytes is allowed at 8, refused at 4) and is validated', async () => {
    let r = await bb(['file', 'ws/repo', 'two.txt'], {
      BITBUCKET_MAX_FILE_BYTES: '8',
    })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /lines 1-2 of 2/)
    r = await bb(['file', 'ws/repo', 'two.txt'], {
      BITBUCKET_MAX_FILE_BYTES: '4',
    })
    // the mock replies chunked, with no Content-Length: only "over the limit" is known, not by how much
    assert.match(
      r.stdout,
      /^File: two\.txt @ main is over the 4 bytes limit, so it was not downloaded\./
    )
    r = await bb(['file', 'ws/repo', 'two.txt'], {
      BITBUCKET_MAX_FILE_BYTES: 'lots',
    })
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /BITBUCKET_MAX_FILE_BYTES must be a positive whole number/
    )
  })

  test('browse accepts . and ./ as the repository root', async () => {
    for (const root of ['.', './']) {
      const before = seen.length
      const r = await bb(['browse', 'ws/repo', root])
      assert.equal(r.code, 0, `${root}: ${r.stderr}`)
      assert.match(r.stdout, /two\.txt/)
      assert.doesNotMatch(r.stderr, /Invalid path segment/)
      assert.ok(
        seen
          .slice(before)
          .some((s) => s.path === `/2.0/repositories/ws/repo/src/${SHA}/`),
        root
      )
    }
    // anywhere else a "." segment is still refused, so it cannot change which endpoint is hit
    const r = await bb(['browse', 'ws/repo', 'src/./x'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Invalid path segment "\."/)
  })

  test('an ignored --q or --sort is refused before any request is made', async () => {
    const before = seen.length
    for (const args of [
      ['commits', 'ws/repo', '--q', 'message ~ "x"'],
      ['commits', 'ws/repo', '--sort', 'date'],
      ['pr-commits', 'ws/repo', '1', '--q', 'x'],
      ['pr-activity', 'ws/repo', '1', '--sort', 'x'],
      ['diffstat', 'ws/repo', 'a..b', '--q', 'x'],
    ]) {
      const r = await bb(args)
      assert.equal(r.code, 1, args.join(' '))
      assert.match(
        r.stderr,
        /is not supported by .*: Bitbucket's endpoint ignores it/,
        args.join(' ')
      )
    }
    assert.equal(seen.length, before)
    // and the honoured ones still reach the API with the flag
    const r = await bb([
      'branches',
      'ws/repo',
      '--q',
      'name ~ "x"',
      '--sort',
      'name',
      '--pagelen',
      '1',
    ])
    assert.equal(r.code, 0, r.stderr)
    const last = requested('/2.0/repositories/ws/repo/refs/branches').at(-1)
    assert.equal(last.query.get('q'), 'name ~ "x"')
    assert.equal(last.query.get('sort'), 'name')
  })

  test('a misspelled boolean flag reaches the user as an unknown flag with a suggestion (CLI)', async () => {
    const before = seen.length
    let r = await bb(['pr-context', 'ws/repo', '1', '--ful'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Error: Unknown flag --ful\. Did you mean --full\?/)
    r = await bb(['file', 'ws/repo', 'two.txt', '--raww', '--ref', 'main'])
    assert.match(r.stderr, /Unknown flag --raww\. Did you mean --raw\?/)
    assert.equal(seen.length, before)
  })

  test("search-code --language with no matches says the names are the index's own (and without it, no such note)", async () => {
    let r = await bb(['search-code', 'empty', 'Ocean', '--language', 'csharp'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /Nothing matched with --language csharp: the names are the index's own \(for example c#; the match is not case-sensitive\)/
    )
    assert.match(
      r.stdout,
      /Retry without --language, or narrow with --extension \(for example --extension ts,tsx\)/
    )
    assert.match(r.stdout, /An empty result does not mean the code is absent/) // the branch note is still there
    r = await bb(['search-code', 'empty', 'Ocean'])
    assert.doesNotMatch(r.stdout, /--language/)
    r = await bb(['search-code', 'ws', 'Ocean', '--language', 'c#']) // with hits there is nothing to explain
    assert.doesNotMatch(r.stdout, /Nothing matched/)
  })

  test('search-code --extension takes a comma list as one clause per extension and refuses a space', async () => {
    const sent = () =>
      requested('/2.0/workspaces/ws/search/code')
        .at(-1)
        .query.get('search_query')
    let r = await bb(['search-code', 'ws', 'Ocean', '--extension', 'ts,tsx'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(sent(), 'Ocean extension:ts extension:tsx')
    assert.match(
      r.stdout,
      /Code search "Ocean extension:ts extension:tsx" in ws/
    )
    r = await bb([
      'search-code',
      'ws',
      'Ocean',
      '--repo',
      'repo',
      '--extension',
      'ts, tsx,',
    ]) // a space after the comma and a trailing comma are fine
    assert.equal(r.code, 0, r.stderr)
    assert.equal(sent(), 'Ocean repo:repo extension:ts extension:tsx')
    r = await bb(['search-code', 'ws', 'Ocean', '--extension', 'tsx']) // one extension is sent as before
    assert.equal(r.code, 0, r.stderr)
    assert.equal(sent(), 'Ocean extension:tsx')
    // a space would add search terms to the query instead of another extension, and a bare comma names nothing
    const before = seen.length
    for (const bad of ['ts tsx', 'ts OR tsx']) {
      r = await bb(['search-code', 'ws', 'Ocean', '--extension', bad])
      assert.equal(r.code, 1, bad)
      assert.match(
        r.stderr,
        /--extension takes extensions separated by commas, not spaces \(--extension ts,tsx\)/,
        bad
      )
    }
    r = await bb(['search-code', 'ws', 'Ocean', '--extension', ','])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--extension needs an extension such as ts/)
    assert.equal(seen.length, before, 'refused before any request')
  })

  test('search-code --extension with no matches says it is an exact match (and with hits, no such note)', async () => {
    let r = await bb(['search-code', 'empty', 'Ocean', '--extension', 'ts'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /Nothing matched with --extension ts: it is an exact match on the file extension, so ts does not cover tsx/
    )
    assert.match(
      r.stdout,
      /Add other extensions with a comma \(for example --extension ts,tsx\) or drop the filter/
    )
    assert.match(r.stdout, /An empty result does not mean the code is absent/) // the branch note is still there
    r = await bb(['search-code', 'empty', 'Ocean', '--extension', 'js,jsx'])
    assert.match(r.stdout, /Nothing matched with --extension js,jsx:/)
    r = await bb(['search-code', 'empty', 'Ocean'])
    assert.doesNotMatch(r.stdout, /--extension/)
    r = await bb(['search-code', 'ws', 'Ocean', '--extension', 'ts']) // with hits there is nothing to explain
    assert.doesNotMatch(r.stdout, /Nothing matched/)
  })

  test('--pagelen above 100 is clamped with a warning, not silently', async () => {
    let r = await bb(['branches', 'ws/repo', '--pagelen', '500'])
    assert.equal(r.code, 0, r.stderr.slice(0, 200))
    assert.match(
      r.stderr,
      /Warning: --pagelen 500 is above Bitbucket's maximum of 100; using 100\. Use --all to read every page\./
    )
    assert.equal(
      requested('/2.0/repositories/ws/repo/refs/branches')
        .at(-1)
        .query.get('pagelen'),
      '100'
    )
    r = await bb(['branches', 'ws/repo', '--pagelen', '100'])
    assert.doesNotMatch(r.stderr, /Warning: --pagelen/)
  })

  test('prs and pr-activity take at most 50 per page: --all and --pagelen stay within it, with a warning naming the command', async () => {
    const sent = (path) => requested(path).at(-1).query.get('pagelen')
    const prs = '/2.0/repositories/ws/repo/pullrequests'
    const activity = '/2.0/repositories/ws/repo/pullrequests/1/activity'
    let r = await bb(['prs', 'ws/repo', '--all'])
    assert.equal(r.code, 0, r.stderr) // the mock answers 400 "Invalid pagelen" above 50, like the real endpoint
    assert.equal(sent(prs), '50')
    r = await bb(['prs', 'ws/repo', '--pagelen', '100'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stderr,
      /Warning: --pagelen 100 is above Bitbucket's maximum of 50 for prs; using 50\. Use --all to read every page\./
    )
    assert.equal(sent(prs), '50')
    r = await bb(['prs', 'ws/repo', '--pagelen', '50'])
    assert.doesNotMatch(r.stderr, /Warning: --pagelen/)
    r = await bb(['pr-activity', 'ws/repo', '1', '--all'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(sent(activity), '50')
    r = await bb(['pr-activity', 'ws/repo', '1', '--pagelen', '100'])
    assert.match(r.stderr, /maximum of 50 for pr-activity; using 50/)
    // the other list commands keep 100 (and keep the plain warning)
    r = await bb(['branches', 'ws/repo', '--all'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(sent('/2.0/repositories/ws/repo/refs/branches'), '100')
    r = await bb(['branches', 'ws/repo', '--pagelen', '500'])
    assert.match(r.stderr, /maximum of 100; using 100\./)
    assert.doesNotMatch(r.stderr, / for branches/)
    // help says so for the two commands only
    assert.match((await bb(['help', 'prs'])).stdout, /--pagelen \(up to 50\)/)
    assert.match(
      (await bb(['help', 'pr-activity'])).stdout,
      /--pagelen \(up to 50\)/
    )
    assert.doesNotMatch((await bb(['help', 'branches'])).stdout, /up to 50/)
  })

  test("a 400 'Invalid pagelen' is not mistaken for the token-paging 'Invalid page' hint", async () => {
    // `get` sends the page size as given, so it reaches the endpoint's limit with no client-side cap
    const r = await bb(['get', 'repositories/ws/repo/pullrequests?pagelen=100'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Invalid pagelen/)
    assert.match(
      r.stderr,
      /Hint: Bitbucket rejected this page size: some endpoints take at most 50 per page/
    )
    assert.doesNotMatch(r.stderr, /--page N is not supported/)
  })

  test('resolved and outdated comments are marked, in lists, single comments, threads and activity', async () => {
    // list: `resolution: {}` marks the resolved root; a reply and an open comment get no marker
    let r = await bb(['pr-comments', 'ws/repo', '31'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^#30 Dana d1 \[a\.ts:5\] \[resolved\]$/m)
    assert.match(r.stdout, /^#31 Dana d1 \[b\.ts:9\]$/m)
    assert.match(r.stdout, /^#32 Bo d3 \(reply to #30\)$/m)
    // single comment: the endpoint says who resolved it and when, and that the line moved
    r = await bb(['pr-comment', 'ws/repo', '31', '30'])
    assert.match(
      r.stdout,
      /^#30 Dana d1 \[a\.ts:5\] \[resolved by Eli d2\] \[outdated\]$/m
    )
    // thread: the root comes from the single endpoint, the replies from the list
    r = await bb(['comment-thread', 'ws/repo', '31', '30'])
    assert.match(
      r.stdout,
      /^#30 Dana d1 \[a\.ts:5\] \[resolved by Eli d2\] \[outdated\]$/m
    )
    assert.match(r.stdout, /^ {2}#32 Bo d3 \(reply to #30\)$/m)
    // activity
    r = await bb(['pr-activity', 'ws/repo', '31'])
    assert.match(r.stdout, /^- comment by Dana \(d1\) \[resolved\]: root$/m)
    assert.match(r.stdout, /^- comment by Dana \(d1\): still open$/m) // not resolved: the old format
    // --json is the raw payload
    r = await bb(['pr-comments', 'ws/repo', '31', '--json'])
    assert.deepEqual(JSON.parse(r.stdout).values[0].resolution, {})
  })

  test("mentions are written as @Display Name when the comment's HTML names them, and left alone when it does not", async () => {
    let r = await bb(['pr-comments', 'ws/repo', '31'])
    // acc:1 and acc:2 are named by the HTML (an entity decoded); acc:9 is not, so it stays as written
    assert.match(r.stdout, /^ {2}@Ana B thanks @Bo & Co and @\{acc:9\}$/m)
    // no HTML: the raw text
    assert.match(r.stdout, /^ {2}@\{acc:1\} hi$/m)
    // numeric entities decode; a number that is not a character stays as written instead of throwing
    assert.match(r.stdout, /^ {2}@O'Neil A &#99999999;$/m)
    // the activity line uses the same text
    r = await bb(['pr-activity', 'ws/repo', '31'])
    assert.match(
      r.stdout,
      /^- comment by Bo \(d3\): @Ana B thanks @Bo & Co and @\{acc:9\}$/m
    )
    // --json keeps the raw text
    r = await bb(['pr-comments', 'ws/repo', '31', '--json'])
    assert.equal(
      JSON.parse(r.stdout).values[2].content.raw,
      '@{acc:1} thanks @{acc:2} and @{acc:9}'
    )
  })

  test('a bare repository name without BITBUCKET_WORKSPACE says how to make it work', async () => {
    let r = await bb(['branches', 'oops'])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Cannot parse repository "oops"\. Use <workspace>\/<repo> or a Bitbucket URL, or set BITBUCKET_WORKSPACE in your environment to use a bare repository name\./
    )
    r = await bb(['branches', 'oops'], { BITBUCKET_WORKSPACE: 'ws' }) // with it set the name resolves (the mock has no such repo: 404, not a parse error)
    assert.doesNotMatch(r.stderr, /Cannot parse repository/)
  })

  test('a 404 on a PR command points at the PR id first; other commands keep the generic hint', async () => {
    let r = await bb(['pr', 'ws/repo', '404'])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Hint: Not found\. For a PR command the PR id is the likeliest typo \(the comment id, for pr-comment and comment-thread\); then check the workspace\/repo spelling/
    )
    r = await bb(['pr-comment', 'ws/repo', '1', '99999'])
    assert.match(
      r.stderr,
      /Hint: Not found\. For a PR command the PR id is the likeliest typo/
    )
    r = await bb(['branch', 'ws/repo', 'nope'])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Hint: No branch 'nope' in ws\/repo: check the spelling/
    )
    assert.doesNotMatch(r.stderr, /PR id/)
  })

  test('without credentials a PR 404 keeps the private-repository hint', async () => {
    const r = await bb(['pr', 'ws/repo', '404'], {
      BITBUCKET_EMAIL: '',
      BITBUCKET_API_TOKEN: '',
    })
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Hint: Not found\. Private repositories look like 404 without credentials/
    )
    assert.doesNotMatch(r.stderr, /PR id/)
  })

  test('pr and pr-context print the destination commit in full, so the old side of a change can be read', async () => {
    for (const args of [
      ['pr', 'ws/repo', '7'],
      ['pr-context', 'ws/repo', '7'],
    ]) {
      const r = await bb(args)
      assert.equal(r.code, 0, r.stderr)
      assert.match(
        r.stdout,
        new RegExp(
          `Source commit: ${FULL7}\nDestination commit: ${FULLDEST7}\n`
        ),
        args[0]
      )
    }
    // a hash that cannot be completed is said to be abbreviated; a PR that records none prints no line
    const r8 = await bb(['pr-context', 'ws/repo', '8'])
    assert.match(
      r8.stdout,
      new RegExp(`Destination commit: ${DEST8} \\(abbreviated\\)`)
    )
    for (const args of [
      ['pr', 'ws/repo', '1'],
      ['pr-context', 'ws/repo', '1'],
    ]) {
      assert.doesNotMatch(
        (await bb(args)).stdout,
        /Destination commit/,
        args[0]
      )
    }
  })

  test("an unresolved ref says that a merged PR's branch is gone and prints the search that finds its source commit", async () => {
    const find =
      /A branch is usually deleted when its PR is merged: find the PR with node bb\.mjs prs ws\/repo --state ALL --q 'source\.branch\.name="gone\/x"'/
    for (const args of [
      ['file', 'ws/repo', 'a.ts', '--ref', 'gone/x'],
      ['browse', 'ws/repo', '--ref', 'gone/x'],
      ['commits', 'ws/repo', '--branch', 'gone/x'],
      ['file-history', 'ws/repo', 'gone/x', 'a.ts'],
    ]) {
      const r = await bb(args)
      assert.equal(r.code, 1, args[0])
      assert.match(
        r.stderr,
        /Could not resolve ref 'gone\/x' in ws\/repo\./,
        args[0]
      )
      assert.match(r.stderr, find, args[0])
    }
  })

  test('branch on a name that no longer exists says so; without credentials the private-repository hint stays', async () => {
    let r = await bb(['branch', 'ws/repo', 'gone/x'])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Hint: No branch 'gone\/x' in ws\/repo: check the spelling \(list them with branches\)/
    )
    assert.match(r.stderr, /--state ALL --q 'source\.branch\.name="gone\/x"'/)
    r = await bb(['branch', 'ws/repo', 'gone/x'], {
      BITBUCKET_EMAIL: '',
      BITBUCKET_API_TOKEN: '',
    })
    assert.match(
      r.stderr,
      /Hint: Not found\. Private repositories look like 404 without credentials/
    )
    assert.doesNotMatch(r.stderr, /No branch/)
  })

  test('a range with an end that is gone blames the end, not a rewritten PR history', async () => {
    for (const args of [
      ['diffstat', 'ws/repo', 'gone..main'],
      ['diff', 'ws/repo', 'gone..main'],
      ['merge-base', 'ws/repo', 'gone..main'],
    ]) {
      const r = await bb(args)
      assert.equal(r.code, 1, args[0])
      assert.match(
        r.stderr,
        /404 Not Found - The source or destination could not be found/,
        args[0]
      )
      assert.match(
        r.stderr,
        /Hint: Bitbucket cannot find a ref or commit that 'gone\.\.main' needs: check both ends for spelling\./,
        args[0]
      )
      assert.match(r.stderr, /source\.branch\.name="gone"'/, args[0])
      // main resolves, so it is not the end that is gone
      assert.doesNotMatch(r.stderr, /source\.branch\.name="main"/, args[0])
      assert.doesNotMatch(r.stderr, /old pull request/, args[0])
    }
    // an end that is a commit hash is not a branch name, so it gets no search for one
    const r = await bb(['diffstat', 'ws/repo', 'gone..abc123abc123'])
    assert.match(r.stderr, /source\.branch\.name="gone"'/)
    assert.doesNotMatch(r.stderr, /abc123abc123"/)
    // a PR command keeps the old-PR hint
    assert.match(
      (await bb(['pr-diff', 'ws/repo', '10'])).stderr,
      /On an old pull request/
    )
  })

  test('a file that is gone at a ref says to read it before the deletion', async () => {
    const r = await bb(['file', 'ws/repo', 'sub/nope.txt'])
    assert.match(
      r.stderr,
      /node bb\.mjs browse ws\/repo sub --ref main\nIf the file was deleted at this ref, read it at a commit before the deletion: the Destination commit that pr and pr-context print/
    )
    const h = await bb(['file-history', 'ws/repo', 'feature/x', 'src/none.ts'])
    assert.match(
      h.stderr,
      /If the file was deleted at this ref, read it at a commit before the deletion/
    )
  })

  test('a --path that is a directory says that only files match', async () => {
    let r = await bb(['pr-diff', 'ws/repo', '1', '--path', 'src/hooks'])
    assert.match(
      r.stdout,
      /matching --path src\/hooks\. Check the paths against pr-diffstat without --path\. --path matches file paths only, so a directory matches nothing/
    )
    // a path with an extension is a file: no note
    r = await bb(['pr-diff', 'ws/repo', '1', '--path', 'nope.ts'])
    assert.doesNotMatch(r.stdout, /file paths only/)
  })

  test('help on a PR command names the URL form, and the diff commands document the --path list', async () => {
    let r = await bb(['help', 'pr-diff'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /\[--path FILE\[,FILE\]\]/)
    assert.match(r.stdout, /comma-separated list/)
    assert.match(
      r.stdout,
      /node bb\.mjs pr-diff https:\/\/bitbucket\.org\/<ws>\/<repo>\/pull-requests\/<id>/
    )
    r = await bb(['help', 'pr-diffstat'])
    assert.match(r.stdout, /\[--path FILE\[,FILE\]\]/)
    r = await bb(['help', 'comment-thread'])
    assert.match(r.stdout, /pull-requests\/<id>/)
    r = await bb(['help', 'pr']) // already spells out the URL form in its usage: no second note
    assert.equal(
      (r.stdout.match(/<PR-URL>|pull-requests\/<id>/g) || []).length,
      1
    )
    r = await bb(['help', 'issue']) // an issue id is not a PR id
    assert.doesNotMatch(r.stdout, /pull-requests/)
    r = await bb(['help'])
    assert.match(r.stdout, /PR commands take the PR URL/)
  })

  test('commit tolerates a missing message', async () => {
    const r = await bb(['commit', 'ws/repo', SHA])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`^Commit: ${SHA}`))
  })

  // ---- output limits

  test('--max-chars cuts text at the head, JSON at the end, and step logs at the start', async () => {
    let r = await bb(['pr', 'ws/repo', '1', '--max-chars', '20'])
    assert.match(
      r.stdout,
      /^PR #1: PR 1\nState: O\n… \[truncated at 20 of \d+ chars\]/
    )
    r = await bb(['pr', 'ws/repo', '1', '--json', '--max-chars', '30'])
    assert.match(r.stdout, /^\{\n {2}"id": 1,/)
    assert.match(r.stdout, /\[truncated at 30 of \d+ chars\]/)
    r = await bb([
      'pipeline-step-log',
      'ws/repo',
      'p',
      's',
      '--tail',
      '1000',
      '--max-chars',
      '40',
    ])
    assert.match(r.stdout, /^… \[truncated: showing last 40 of \d+ chars\]\n/)
    assert.match(r.stdout, /FAILURE: boom/)
  })

  // ---- review run 8

  test('--max-chars does not cut an emoji in half (issue 5)', async () => {
    // "ab" + a two-unit emoji + "cd" is 6 units; a cut at 3 would leave a lone surrogate, printed as U+FFFD
    let r = await bb([
      'file',
      'ws/repo',
      'emoji.txt',
      '--raw',
      '--max-chars',
      '3',
    ])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, 'ab\n… [truncated at 3 of 6 chars]\n')
    assert.doesNotMatch(r.stdout, /�/)
    r = await bb(['file', 'ws/repo', 'emoji.txt', '--raw', '--max-chars', '4'])
    assert.equal(r.stdout, 'ab\u{1F600}\n… [truncated at 4 of 6 chars]\n')
  })

  test('the text view writes invisible format characters as <U+XXXX> and says so on stderr; --json and --raw keep them', async () => {
    let r = await bb(['file', 'ws/repo', 'hidden.txt'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /1: ok<U\+200C><U\+202E><U\+E0048><U\+E0069> done/)
    assert.doesNotMatch(r.stdout, /[‌‮]|\u{E0048}/u)
    assert.match(
      r.stderr,
      /Note: this text contains invisible character\(s\) \(U\+200C, U\+202E, U\+E0048, U\+E0069\)/
    )
    // --json and --select are the payload as it is: stdout is untouched, stderr carries the note (worded for JSON)
    for (const flag of [['--json'], ['--select', 'content']]) {
      r = await bb(['file', 'ws/repo', 'hidden.txt', ...flag])
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /ok‌‮/u, flag[0])
      assert.match(
        r.stderr,
        /Note: this output contains invisible character\(s\) \(U\+200C, U\+202E, U\+E0048, U\+E0069\); JSON output, --raw included, prints them as they are/,
        flag[0]
      )
    }
    assert.equal(JSON.parse(r.stdout).content.includes('‌'), true)
    // --raw feeds pipes: the bytes are untouched, the note still goes to stderr
    r = await bb(['file', 'ws/repo', 'hidden.txt', '--raw'])
    assert.equal(r.stdout, 'ok‌‮\u{E0048}\u{E0069} done\n')
    assert.match(
      r.stderr,
      /Note: this output contains invisible character\(s\)/
    )
    // a file without any prints no note, in any view
    for (const flag of [[], ['--json'], ['--raw']]) {
      r = await bb(['file', 'ws/repo', 'emoji.txt', ...flag])
      assert.doesNotMatch(r.stderr, /invisible/, flag[0] ?? 'text')
    }
  })

  test('tag on a name that does not exist says so; without credentials the private-repository hint stays', async () => {
    let r = await bb(['tag', 'ws/repo', 'v9'])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Hint: No tag 'v9' in ws\/repo: it is misspelled, or it was deleted or renamed/
    )
    assert.match(r.stderr, /tags ws\/repo --q 'name~"v9"'/)
    r = await bb(['tag', 'ws/repo', 'v9'], {
      BITBUCKET_EMAIL: '',
      BITBUCKET_API_TOKEN: '',
    })
    assert.match(
      r.stderr,
      /Hint: Not found\. Private repositories look like 404 without credentials/
    )
    assert.doesNotMatch(r.stderr, /No tag/)
  })

  test('file --raw gives the whole file by default and warns on stderr when lines are left out (issue 1)', async () => {
    let r = await bb(['file', 'ws/repo', 'lines-1455.txt', '--raw'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trimEnd().split('\n').length, 1455)
    assert.equal(r.stderr, '')
    // the file is cut short on purpose: stdout is still only the file, the notice is on stderr
    r = await bb([
      'file',
      'ws/repo',
      'lines-1455.txt',
      '--raw',
      '--limit',
      '1000',
    ])
    assert.equal(r.stdout.trimEnd().split('\n').length, 1000)
    assert.doesNotMatch(r.stdout, /Warning/)
    assert.match(
      r.stderr,
      /^Warning: --raw printed lines 1-1000 of 1455; 455 line\(s\) are not in this output, so a grep over it can miss matches\. Add --limit 1455 to read to the end, or continue with --start 1001\./
    )
    // past the 10000 cap even the maximum stops short
    r = await bb(['file', 'ws/repo', 'lines-10500.txt', '--raw'])
    assert.equal(r.stdout.trimEnd().split('\n').length, 10000)
    assert.match(r.stderr, /capped at 10000.*--start 10001/)
    // the numbered view is as before: 1000 lines and its own footer, nothing on stderr
    r = await bb(['file', 'ws/repo', 'lines-1455.txt'])
    assert.match(r.stdout, /lines 1-1000 of 1455/)
    assert.match(r.stdout, /455 more lines; use --start 1001/)
    assert.equal(r.stderr, '')
  })

  test('a PR whose commits are gone: the PR loads, its diff does not, and the hint says why (issue 2)', async () => {
    let r = await bb(['pr', 'ws/repo', '10'])
    assert.equal(r.code, 0, r.stderr)
    for (const cmd of ['pr-diffstat', 'pr-diff', 'pr-commits']) {
      r = await bb([cmd, 'ws/repo', '10'])
      assert.equal(r.code, 1, cmd)
      assert.match(
        r.stderr,
        /404 Not Found - The source or destination could not be found for spec/,
        cmd
      )
      assert.match(
        r.stderr,
        /Hint: Bitbucket cannot find a commit this diff needs\. On an old pull request that means a commit is gone/,
        cmd
      )
      assert.match(r.stderr, /pr, pr-activity and pr-statuses still work/, cmd)
      assert.doesNotMatch(r.stderr, /PR id is the likeliest typo/, cmd)
    }
  })

  test('pr-context on such a PR shows the diffstat error with the hint and no doubled period (issue 2)', async () => {
    const r = await bb(['pr-context', 'ws/repo', '10'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /--- Diffstat ---\nUnavailable: .*7be7b3a3bd20\. Hint: Bitbucket cannot find a commit this diff needs/
    )
    assert.doesNotMatch(r.stdout, /\.\. Hint/)
  })

  test('pr-context reads at most 5 diffstat pages and names the real size and the command for the rest (issue 3)', async () => {
    const stat = '/2.0/repositories/ws/repo/pullrequests/12/diffstat'
    let r = await bb(['pr-context', 'ws/repo', '12'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(requested(stat).length, 5)
    assert.match(
      r.stdout,
      /--- Diffstat ---\n2295 file\(s\) changed; first 500 summed: \+1000 -500\n\(WARNING: totals are partial: only the first 500 files were read of 2295, to keep this briefing quick\. For every file: pr-diffstat ws\/repo 12 --all --max-pages 23; to pick files, add --path a,b\)/
    )
    r = await bb(['pr-context', 'ws/repo', '12', '--full'])
    assert.match(r.stdout, /f499\.ts/)
    assert.doesNotMatch(r.stdout, /f500\.ts/)
    // the command the warning names does reach the end
    r = await bb(['pr-diffstat', 'ws/repo', '12', '--all', '--max-pages', '23'])
    assert.match(
      r.stdout,
      /^Diffstat for PR #12 in ws\/repo: 2295 file\(s\), \+4590 -2295/
    )
    assert.doesNotMatch(r.stdout, /stopped at --max-pages/)
  })

  test("pr-diffstat names the total in its 'more exist' headline (issue 3)", async () => {
    let r = await bb(['pr-diffstat', 'ws/repo', '12'])
    assert.match(
      r.stdout,
      /^Diffstat for PR #12 in ws\/repo: first 100 file\(s\) of 2295 \(more exist\), \+200 -100 so far/
    )
    r = await bb(['pr-diffstat', 'ws/repo', '12', '--all', '--max-pages', '3'])
    assert.match(r.stdout, /first 300 file\(s\) of 2295 \(more exist\)/)
    assert.match(r.stdout, /stopped at --max-pages/)
  })

  // ---- review run 9

  const W = 'https://bitbucket.org/ws/repo'

  test('a commit, branch or file URL fills in what it names, instead of failing or answering for the wrong place (run 9 issue 1)', async () => {
    // commit URL -> the hash
    let r = await bb(['commit', `${W}/commits/${SHA}`])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, new RegExp(`^Commit: ${SHA}`))
    assert.equal(r.stderr, '')
    r = await bb(['diffstat', `${W}/commits/emptyc`])
    assert.match(r.stdout, /No changes found for emptyc in ws\/repo/)
    // branch URL -> the name
    r = await bb(['branch', `${W}/branch/main`])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^Branch: main/)
    // file URL -> ref and path
    r = await bb(['file', `${W}/src/main/two.txt`])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^File: two\.txt @ main \(lines 1-2 of 2\)/)
    // directory URL -> ref and directory (it used to list the root of the default branch)
    let before = requested(`/2.0/repositories/ws/repo/src/${SHA}/big/`).length
    r = await bb(['browse', `${W}/src/main/big/`])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^ws\/repo @ main {2}\/big\n/)
    assert.match(r.stdout, /big\/p1-0\.txt/)
    assert.equal(
      requested(`/2.0/repositories/ws/repo/src/${SHA}/big/`).length,
      before + 1
    )
    // ref and path for file-history; the branch with a "/" arrives as %2F
    r = await bb(['file-history', `${W}/src/feature%2Fx/src/a.ts`])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^History of src\/a\.ts from feature\/x/)
    // branch commit list
    before = requested(`/2.0/repositories/ws/repo/commits/${SHA}`).length
    r = await bb(['commits', `${W}/commits/branch/main`])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(
      requested(`/2.0/repositories/ws/repo/commits/${SHA}`).length,
      before + 1
    )
  })

  test('an argument typed on the line wins over what the URL supplies', async () => {
    const viaUrlRef = () =>
      requested(`/2.0/repositories/ws/repo/src/${SHA}/big/`).length
    const viaFlagRef = () =>
      requested(`/2.0/repositories/ws/repo/src/${SHA2}/big/`).length
    const [u0, f0] = [viaUrlRef(), viaFlagRef()]
    await bb(['browse', `${W}/src/main/big/`, '--ref', 'feature/x'])
    // the --ref flag beats the URL's ref: feature/x (the sha SHA2, which has no listing in the mock, so the command fails) is
    // what was asked for, and main (SHA) was not
    assert.equal(viaUrlRef(), u0)
    assert.ok(viaFlagRef() > f0)
  })

  test('a URL part the command cannot use is reported, not dropped silently (run 9 issue 1)', async () => {
    let r = await bb(['repo', `${W}/src/main/two.txt`])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^Repository: ws\/repo/)
    assert.equal(
      r.stderr,
      'Warning: the URL also names ref main and path two.txt, which repo does not use; only ws/repo was taken from it.\n'
    )
    r = await bb(['file', `${W}/commits/${SHA}`])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /Warning: the URL also names commit a{40}, which file does not use/
    )
    assert.match(r.stderr, /Expected 1 more argument\(s\)/)
    // the root of a ref (no path) is nothing to report, and neither is a plain PR or repo URL
    r = await bb(['repo', `${W}/src/main/`])
    assert.equal(
      r.stderr,
      'Warning: the URL also names ref main, which repo does not use; only ws/repo was taken from it.\n'
    )
    r = await bb(['pr', `${W}/pull-requests/1`])
    assert.equal(r.stderr, '')
  })

  test('a ref read from a URL that does not resolve says where it came from', async () => {
    let r = await bb(['file', `${W}/src/nope/x.txt`])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Could not resolve ref 'nope' in ws\/repo\./)
    assert.match(
      r.stderr,
      /The ref was read from the URL as the segment after \/src\/; Bitbucket writes a "\/" inside a branch name as %2F/
    )
    // with --ref given there is nothing to explain
    r = await bb(['file', `${W}/src/nope/x.txt`, '--ref', 'nope2'])
    assert.doesNotMatch(r.stderr, /read from the URL/)
  })

  test('pr-activity shows a push as a change of source commit, and does not fold two pushes (run 9 issue 2)', async () => {
    const r = await bb(['pr-activity', 'ws/repo', '13'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /\(2026-02-01T09:51:56\+00:00\): source commit 950a63cc -> 1e6de21d\n/
    )
    assert.match(
      r.stdout,
      /\(2026-02-01T08:37:22\+00:00\): source commit fd587c1a -> 950a63cc\n/
    )
    // the two pushes agree on author, state and title and are next to each other: they are not duplicates
    assert.doesNotMatch(r.stdout, /listed \d+ times/)
    // no push where the source commit did not change, and none for the oldest update (nothing to compare with)
    assert.match(
      r.stdout,
      /\(2026-02-01T10:00:00\+00:00\): status open -> fulfilled \(merged\)\n/
    )
    assert.match(
      r.stdout,
      /\(2026-02-01T08:36:30\.600\+00:00\): reviewers added: Eli\n/
    )
    assert.match(
      r.stdout,
      /\(2026-02-01T08:36:30\.300\+00:00\): state=OPEN title="PR 13"$/m
    )
    // an update with no source commit (PR 1's) reads as before
    assert.match(
      (await bb(['pr-activity', 'ws/repo', '1'])).stdout,
      /state=OPEN title="PR 1" \(listed 2 times by Bitbucket\)/
    )
  })

  test('file on a directory says so and gives the browse command, instead of printing the listing (run 9 issue 3)', async () => {
    let r = await bb(['file', 'ws/repo', 'dirx'])
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assert.match(
      r.stderr,
      /Error: dirx is a directory at ref 'main', not a file\. List it with: node bb\.mjs browse ws\/repo dirx --ref main/
    )
    r = await bb(['file', 'ws/repo', 'dirx', '--raw'])
    assert.equal(r.code, 1)
    // a file is unaffected
    r = await bb(['file', 'ws/repo', 'two.txt'])
    assert.equal(r.code, 0, r.stderr)
  })

  test('user explains what it takes, and a 404 does not blame the repository (run 9 issue 4)', async () => {
    let r = await bb(['user', '712020:abc'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /^User: Ian Flory \(@Ian \(Flo\) Flory\)\nAccount ID: 712020:abc/
    )
    r = await bb(['user', 'Ian Flory'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /404 Not Found - Ian Flory/)
    assert.match(
      r.stderr,
      /Hint: Use a user's account id .* or UUID in braces .*, not a name or nickname\./
    )
    assert.match(
      r.stderr,
      /prs <ws>\/<repo> --state ALL --select author\.display_name,author\.account_id/
    )
    assert.doesNotMatch(r.stderr, /workspace\/repo\/ref spelling/)
    r = await bb(['user'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Error: Missing user\. Use a user's account id/)
    assert.match(
      (await bb(['help', 'user'])).stdout,
      /user <account-id-or-uuid>\n.*a name or nickname does not work/
    )
  })

  test('a --q on a field that cannot be filtered gets a hint, and an empty nickname search says why (run 9 issue 5)', async () => {
    let r = await bb([
      'prs',
      'ws/repo',
      '--state',
      'MERGED',
      '--q',
      'author.display_name="Ian Flory"',
    ])
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /400 Bad Request - Field "user\.\.display_name" does not support filtering/
    )
    assert.match(
      r.stderr,
      /Hint: Bitbucket cannot filter on that field\. A person's display name is not filterable: use author\.account_id or reviewers\.account_id/
    )
    assert.match(r.stderr, /references\/bbql\.md/)
    r = await bb([
      'prs',
      'ws/repo',
      '--state',
      'ALL',
      '--q',
      'author.nickname="Ian Flory"',
    ])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /^No pull requests found\.\n\(--q on a nickname matches that field exactly, and a person's nickname can differ from the name shown in this output\. Match on author\.account_id instead; read it with --select author\.account_id\.\)/
    )
    // other empty results, and a nickname search with hits, get no such note
    r = await bb([
      'prs',
      'ws/repo',
      '--state',
      'ALL',
      '--q',
      'title ~ "nothing"',
    ])
    assert.equal(r.stdout.trim(), 'No pull requests found.')
    r = await bb(['prs', 'ws/repo', '--q', 'author.nickname="dup"'])
    assert.doesNotMatch(r.stdout, /nickname can differ/)
  })

  test('search-code with a list of extensions that finds nothing does not suggest the list it was given (run 9 nit)', async () => {
    const r = await bb([
      'search-code',
      'empty',
      'Ocean',
      '--extension',
      'ts,tsx',
    ])
    assert.equal(r.code, 0, r.stderr)
    assert.match(
      r.stdout,
      /Nothing matched with --extension ts,tsx: it is an exact match on the file extension, and every extension in that list was tried\. Check their spelling, or drop the filter\./
    )
    assert.doesNotMatch(r.stdout, /for example --extension ts,tsx/)
  })

  test('a diff over 200,000 characters warns on stderr and leaves stdout alone (issue 4)', async () => {
    let r = await bb(['pr-diff', 'ws/repo', '11'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.length, 252500 + 1) // the diff and the newline console.log adds: no warning text in it
    assert.match(
      r.stderr,
      /^Warning: large diff, 252,500 characters \(2,500 lines\)\. Lock files and generated files are the usual cause: run pr-diffstat first and fetch only the files that matter with --path a,b/
    )
    r = await bb(['diff', 'ws/repo', 'big..main'])
    assert.match(r.stderr, /run diffstat first/)
    // already narrowed with --path: do not send the reader back to --path
    r = await bb(['pr-diff', 'ws/repo', '11', '--path', 'a.ts'])
    assert.match(
      r.stderr,
      /even with --path\. Narrow --path to fewer files, lower --context/
    )
    assert.doesNotMatch(r.stderr, /run pr-diffstat first/)
    // --max-chars already bounds the output; and a small diff has nothing to warn about
    r = await bb(['pr-diff', 'ws/repo', '11', '--max-chars', '100'])
    assert.equal(r.stderr, '')
    r = await bb(['pr-diff', 'ws/repo', '1'])
    assert.equal(r.stderr, '')
  })

  // ---- paging

  test('--all follows every page; --max-pages stops with a footer', async () => {
    let r = await bb(['branches', 'ws/repo', '--all'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Branches in ws\/repo \(6 total\)/)
    for (const n of ['b1-0', 'b2-1', 'b3-1'])
      assert.match(r.stdout, new RegExp(`- ${n} `))
    assert.doesNotMatch(r.stdout, /more results|stopped at/)
    r = await bb(['branches', 'ws/repo', '--all', '--max-pages', '2'])
    assert.match(r.stdout, /b2-1/)
    assert.doesNotMatch(r.stdout, /b3-0/)
    assert.match(r.stdout, /stopped at --max-pages/)
    r = await bb(['branches', 'ws/repo', '--page', '2'])
    assert.match(r.stdout, /rerun with --page 3 or --all/)
  })

  // ---- comment threads

  test('comment-thread follows nested replies and leaves unrelated comments out', async () => {
    const r = await bb(['comment-thread', 'ws/repo', '3', '10'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^Thread for comment #10 on PR #3/)
    assert.match(r.stdout, /^#10 .*\n {2}root$/m)
    assert.match(r.stdout, /^ {2}#11 .*\(reply to #10\)\n {4}reply one$/m)
    assert.match(r.stdout, /^ {4}#12 .*\(reply to #11\)\n {6}reply two$/m)
    assert.doesNotMatch(r.stdout, /unrelated|WARNING/)
  })

  test('comment-thread warns when the comment pages run out of cap', async () => {
    const r = await bb(['comment-thread', 'ws/repo', '4', '20'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /WARNING: stopped after 1000 pages of PR comments/)
  })

  // ---- retries, timeouts, proxies

  const FAST = { BITBUCKET_RETRY_BASE_MS: '1' }
  const R = '/2.0/repositories/ws/repo'

  test('5xx is retried with backoff until it succeeds', async () => {
    const r = await bb(['get', 'repositories/ws/repo/flaky503'], FAST)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(requested(`${R}/flaky503`).length, 3)
  })

  test('a persistent 5xx gives up after 3 attempts', async () => {
    const r = await bb(['get', 'repositories/ws/repo/always503'], FAST)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /503/)
    assert.equal(requested(`${R}/always503`).length, 3)
  })

  test('429 honours a short Retry-After and then succeeds', async () => {
    const r = await bb(['get', 'repositories/ws/repo/rate429'], FAST)
    assert.equal(r.code, 0, r.stderr)
    assert.equal(requested(`${R}/rate429`).length, 2)
  })

  test('a Retry-After longer than 30 s fails at once and says so', async () => {
    const r = await bb(['get', 'repositories/ws/repo/rate429long'], FAST)
    assert.equal(r.code, 1)
    assert.match(
      r.stderr,
      /server asked to wait 31s via Retry-After; not retrying/
    )
    assert.equal(requested(`${R}/rate429long`).length, 1)
  })

  test('a dropped connection is retried, then reported with its cause and a hint', async () => {
    const r = await bb(['get', 'repositories/ws/repo/reset'], FAST)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Network error contacting 127\.0\.0\.1:\d+/)
    assert.match(r.stderr, /Hint:/)
    assert.equal(requested(`${R}/reset`).length, 3)
  })

  test('a request that never answers times out after 3 attempts', async () => {
    const r = await bb(['get', 'repositories/ws/repo/hang'], {
      ...FAST,
      BITBUCKET_REQUEST_TIMEOUT: '150',
    })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Request timed out after 150ms/)
    assert.match(
      r.stderr,
      /Hint: Tried 3 times, 150 ms each\. For a slow network or a large response raise BITBUCKET_REQUEST_TIMEOUT \(milliseconds, set in your environment, not in the chat\)/
    )
    assert.equal(requested(`${R}/hang`).length, 3)
  })

  test('an HTML page instead of JSON is blamed on a proxy or login page', async () => {
    const r = await bb(['repo', 'ws/htmlrepo'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /got an HTML page.*proxy, firewall or login page/)
  })
})
