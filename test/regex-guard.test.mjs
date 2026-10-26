// A card's own regexes (its regex scripts, a preset's, a lorebook's /regex/ keys) and its templates run with a bound
// on their time: one that backtracks without end, or text full of `<%`, once held the whole server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyScripts, guardedTest, onSlowPattern } from '../server/regex-guard.mjs'
import { applyScripts as applyPlain, normalizeScripts, PLACEMENT } from '../web/shared/regex.js'
import { normalizeBook, triggeredEntries } from '../server/worldbook.mjs'
import { compileEjs, escapeReasoning, hasEjs, stripTemplates, templateSyntaxError } from '../server/template.mjs'

const scripts = (findRegex, replaceString = '') => normalizeScripts([{ findRegex, replaceString, placement: [PLACEMENT.AI_OUTPUT] }])
const run = (text, list, target = 'prompt') => applyScripts(text, list, { placement: PLACEMENT.AI_OUTPUT, target })
const timed = fn => {
  const started = Date.now()
  const value = fn()
  return { value, ms: Date.now() - started }
}

test('a card\'s regex scripts give what they always gave, the ones V8 cannot run in linear time included', () => {
  const text = '她说：「你好」<thinking>想了想\n再想</thinking>然后<b>走了</b>。AbC abc ABC'
  for (const [find, replace] of [
    ['/<thinking>[\\s\\S]*?<\\/thinking>/gi', ''],
    ['/(?<=<b>)[^<]+(?=<\\/b>)/g', '[$&]'],
    ['/(a)(b)(c)/gi', '$3$2$1'],
    ['/(?<x>a)(?<y>b)/gi', '{{match}}-$<y>$<x>'],
    ['/abc/', 'X'],
    ['/(\\w)\\1*/gu', '<$1>'],
    ['/x*/g', '-'],
    ['/\\p{Script=Han}+/gu', '汉'],
  ]) {
    assert.equal(run(text, scripts(find, replace)), applyPlain(text, scripts(find, replace), { placement: PLACEMENT.AI_OUTPUT, target: 'prompt' }), find)
  }
})

test('a regex script that would backtrack for ever is stopped within its time, then left out; the others go on', () => {
  const slow = []
  onSlowPattern(regex => slow.push(regex.source))
  const evil = `${'a'.repeat(40)}!`
  // V8's linear engine takes this one: no time at all.
  assert.ok(timed(() => run(evil, scripts('/^(a+)+$/', 'X'))).ms < 200)
  // These it cannot (case-insensitive, a lookahead, large counts): stopped at the deadline, the text as it was.
  for (const find of ['/^(a+)+$/i', '/^(?=a)(a+)+$/', '/^(a{1,30}){1,30}$/']) {
    const { value, ms } = timed(() => run(evil, scripts(find, 'X')))
    assert.equal(value, evil, find)
    assert.ok(ms < 2000, `${find} took ${ms} ms`)
  }
  assert.equal(slow.length, 3, 'each said once')
  // Left out from then on: no second wait.
  assert.ok(timed(() => run(evil, scripts('/^(a+)+$/i', 'X'))).ms < 50)
  assert.equal(slow.length, 3)
  // A pattern after them still runs (a new worker).
  assert.equal(run('abc', scripts('/(?<=a)b/g', 'B')), 'aBc')
  onSlowPattern(() => {})
})

test('a lorebook\'s /regex/ key that would backtrack for ever does not hold the turn', () => {
  const book = { ...normalizeBook({ entries: { 0: { uid: 0, key: ['/^(\\w+\\s?)+$/i'], content: '坏正则的条目', comment: '坏' }, 1: { uid: 1, key: ['/(?<=喝)桂花/'], content: '桂花拿铁', comment: '好' } } }), id: 'b' }
  const { value, ms } = timed(() => triggeredEntries([book], `${'word '.repeat(30)}!我想喝桂花`, new Set()))
  assert.deepEqual(value.map(hit => hit.entry.comment), ['好'])
  assert.ok(ms < 2000, `${ms} ms`)
  assert.equal(guardedTest(/(?<=喝)桂花/g, '我想喝桂花'), true, 'a global key matches every time')
  assert.equal(guardedTest(/(?<=喝)桂花/g, '我想喝桂花'), true)
})

test('templates are found in linear time: text full of `<%` with no `%>` no longer holds the server', () => {
  const many = '<%'.repeat(131072)
  for (const fn of [() => hasEjs(many), () => stripTemplates(many), () => templateSyntaxError(many), () => compileEjs(many), () => escapeReasoning('<think>'.repeat(40000))]) {
    assert.ok(timed(fn).ms < 500)
  }
  // And read as before.
  assert.equal(hasEjs('a <%= x %> b'), true)
  assert.equal(hasEjs('<%>'), false)
  assert.equal(stripTemplates('a<% x %>b<%= y %>c<% open'), 'abc<% open')
  assert.equal(escapeReasoning('<Think>a<%x%></THINK><% y %>'), '<Think>a<%%x%></THINK><% y %>')
  assert.equal(templateSyntaxError('<% if (a) { %>x<% } %>'), '')
  assert.match(compileEjs('a<%_ x _%>\n b<%- y -%>\nc<%%lit%>'), /x[\s\S]*__str\(y\)[\s\S]*"<%lit%>"/)
})

test('a card whose regex script would hang: the turn is prepared within its time, and the server answers meanwhile', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { createApp } = await import('../server/http.mjs')
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-regex-guard-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, method = 'GET', body) => (await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })).json()
  const card = { spec: 'chara_card_v2', data: { name: '小雨', first_mes: '开场', extensions: { regex_scripts: [{ findRegex: '/^(aa|a)+$/i', replaceString: 'X', placement: [1, 2] }] } } }
  const imported = await call('/api/cards/import', 'POST', { filename: 'c.json', data: Buffer.from(JSON.stringify(card)).toString('base64') })
  const chat = await call('/api/chats', 'POST', { cardId: imported.id })
  const started = Date.now()
  const [preview, health] = await Promise.all([call(`/api/chats/${chat.id}/preview`, 'POST', { parentId: 'root', input: `${'a'.repeat(40)}!` }), new Promise(resolve => setTimeout(resolve, 50)).then(() => fetch(`${base}/api/health`))])
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`)
  assert.match(preview.prompt, /a{40}!/, 'the input as written: the script was left out')
  assert.equal(health.status, 200)
})
