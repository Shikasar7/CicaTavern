// 对话修改 for a worldbook and a preset (server/forge/book-edit.mjs, preset-edit.mjs):
// what the model is shown, how its answer is read, what goes in when chosen, and
// the sessions over HTTP with a model that answers by what it is asked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeBook } from '../server/worldbook.mjs'
import { normalizePreset } from '../server/presets.mjs'
import { applyBookChanges, bookEditRequest, bookTooLong, pickRequest, readBookEdit, readPicked } from '../server/forge/book-edit.mjs'
import { applyPresetChanges, presetEditRequest, readPickedPrompts, readPresetEdit } from '../server/forge/preset-edit.mjs'

const BOOK = {
  name: '旧城',
  entries: [
    { uid: 0, comment: '世界规则', keys: [], content: '旧城只在雨夜开门。', constant: true },
    { uid: 1, comment: '林青禾', keys: ['青禾', '掌柜'], content: '茶馆掌柜，话少。' },
    { uid: 2, comment: '码头', keys: ['码头'], content: '城东的旧码头。' },
    { uid: 3, comment: '[initvar]初始变量', keys: [], content: 'gold: 10', constant: true },
  ],
}

const PRESET = {
  name: '叙事预设',
  prompts: [
    { identifier: 'main', name: 'Main Prompt', role: 'system', content: '你是{{char}}，用第三人称写。' },
    { identifier: 'charDescription', name: 'Char Description', marker: true },
    { identifier: 'style', name: '文风', role: 'system', content: '短句，少形容词。' },
    { identifier: 'chatHistory', name: 'Chat History', marker: true },
    { identifier: 'cot', name: '思维链', role: 'system', content: '先在 <think> 里想好再写。' },
  ],
  prompt_order: [{ character_id: 100001, order: ['main', 'charDescription', 'style', 'chatHistory', 'cot'].map(identifier => ({ identifier, enabled: true })) }],
}

test('a worldbook: shown whole within the budget, its answer read entry by entry', () => {
  const book = normalizeBook(BOOK, '旧城', { standalone: true })
  const { request, shown } = bookEditRequest(book, { text: '青禾说话再冷一点，加一个码头的船夫', reply: '简体中文' })
  assert.deepEqual(shown, ['1', '2', '0', '3'], 'all of it, the ones the request names first')
  assert.match(request.messages[0].content, /<worldbook name="旧城">[\s\S]*<entry uid="1" name="林青禾" mode="keyword" keys="青禾, 掌柜">\n茶馆掌柜，话少。/)
  assert.match(request.messages[0].content, /mode="initvar"/)
  assert.match(request.system, /<book name="书名">/, 'an imported book can be renamed')
  assert.doesNotMatch(bookEditRequest(book, { text: 'x', own: true }).request.system, /<book name/, "a card's own book has no name of its own")

  const answer = [
    '<reply>青禾冷了一些，加了船夫老周。</reply>',
    '<entry uid="1">茶馆掌柜，话很少，不笑。</entry>',
    '<entry uid="2" mode="constant" keys="码头, 东码头"></entry>',
    '<entry uid="0" enabled="false"></entry>',
    '<entry uid="3">gold: 99</entry>',
    '<new_entry name="老周" keys="老周, 船夫" mode="keyword">码头的船夫，六十岁。</new_entry>',
    '<remove_entry uid="9"></remove_entry>',
    '<book name="雨夜旧城">一本雨夜里的旧城设定。</book>',
  ].join('\n')
  const read = readBookEdit(answer, book, { shown })
  assert.equal(read.reply, '青禾冷了一些，加了船夫老周。')
  assert.deepEqual(read.changes.map(c => c.id), ['entry:1', 'entry:2', 'entry:0', 'entry:3', 'new:0', 'book'])
  const byId = Object.fromEntries(read.changes.map(c => [c.id, c]))
  assert.deepEqual([byId['entry:2'].mode, byId['entry:2'].keys, byId['entry:2'].after], ['constant', ['码头', '东码头'], '城东的旧码头。'], 'an empty body keeps the text')
  assert.equal(byId['entry:0'].enabled, false)
  assert.equal(byId['entry:3'].mode, undefined, 'an initial-variables entry keeps its kind')
  assert.deepEqual([byId.book.name, byId.book.after], ['雨夜旧城', '一本雨夜里的旧城设定。'])
  assert.deepEqual(readBookEdit(answer, book, { shown, own: true }).changes.map(c => c.id).includes('book'), false)
  assert.deepEqual(readBookEdit(answer, book, { shown, target: 'entry:1' }).changes.map(c => c.id), ['entry:1'])
  assert.deepEqual(readBookEdit(answer, book, { shown: ['0'] }).changes.map(c => c.id), ['entry:0', 'new:0', 'book'], 'entries not sent in full stay as they are')

  const { applied, prefix } = applyBookChanges(book, read.changes, ['entry:1', 'entry:2', 'new:0', 'book'])
  assert.deepEqual([applied, prefix], [4, true])
  assert.equal(book.entries.find(e => e.uid === '1').content, '茶馆掌柜，话很少，不笑。')
  assert.deepEqual([book.entries.find(e => e.uid === '2').constant, book.entries.find(e => e.uid === '2').keys], [true, ['码头', '东码头']])
  assert.deepEqual(book.entries.at(-1), { ...book.entries.at(-1), comment: '老周', keys: ['老周', '船夫'], content: '码头的船夫，六十岁。', constant: false })
  assert.deepEqual([book.name, book.description], ['雨夜旧城', '一本雨夜里的旧城设定。'])
  assert.equal(book.entries.find(e => e.uid === '0').enabled, true, 'what was not chosen stays')
})

test('a book too long to send whole: a look at its contents first, then the entries it asked for', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ uid: i, comment: `人物${i}`, keys: [`人物${i}`], content: '设定'.repeat(1500) }))
  const book = normalizeBook({ name: '大书', entries }, '大书', { standalone: true })
  assert.equal(bookTooLong(book), true)
  const look = pickRequest(book, { text: '人物7 和 人物20 改成常驻' })
  assert.match(look.messages[0].content, /uid=7「人物7」keyword，关键词：人物7（3000 字）/)
  assert.deepEqual(readPicked('<read>20, 7, 99, 7</read>', book), ['20', '7'])
  const { shown } = bookEditRequest(book, { text: '改一下', picked: ['20', '7'] })
  assert.deepEqual(shown.slice(0, 2), ['7', '20'], 'the picked ones first')
  assert.ok(shown.length < 30)
})

test('a preset: prompts with their place, markers only to switch, new prompts where asked', () => {
  const preset = normalizePreset(PRESET, '叙事预设')
  const { request, shown } = presetEditRequest(preset, { text: '文风改成长句', reply: '简体中文' })
  assert.deepEqual(shown, ['style', 'main', 'cot'], 'all of them, the one the request names first')
  const content = request.messages[0].content
  assert.match(content, /<prompt id="main" name="Main Prompt" role="system" place="聊天记录之前">\n你是\{\{char\}\}/)
  assert.match(content, /<marker id="charDescription" name="角色描述"\/>/)
  assert.match(content, /<prompt id="cot" name="思维链" role="system" place="聊天记录之后">/)

  const answer = [
    '<reply>文风改成了长句，加了一条视角规则。</reply>',
    '<prompt id="style">长句，多用从句。</prompt>',
    '<prompt id="cot" enabled="false"></prompt>',
    '<prompt id="charDescription" enabled="false">不能有正文</prompt>',
    '<new_prompt name="视角" role="system" after="main">只写 {{char}} 看得见的事。</new_prompt>',
    '<remove_prompt id="chatHistory"></remove_prompt>',
  ].join('\n')
  const read = readPresetEdit(answer, preset, { shown })
  assert.deepEqual(read.changes.map(c => c.id), ['prompt:style', 'prompt:cot', 'prompt:charDescription', 'new:0'], 'a marker is never removed')
  const byId = Object.fromEntries(read.changes.map(c => [c.id, c]))
  assert.deepEqual([byId['prompt:cot'].enabled, byId['prompt:cot'].after], [false, '先在 <think> 里想好再写。'])
  assert.deepEqual([byId['prompt:charDescription'].after, byId['prompt:charDescription'].title], ['', '角色描述'])
  assert.deepEqual([byId['new:0'].afterId, byId['new:0'].afterTitle], ['main', 'Main Prompt'])

  const { applied, prefix } = applyPresetChanges(preset, read.changes, ['prompt:style', 'new:0'])
  assert.deepEqual([applied, prefix], [2, true])
  assert.equal(preset.prompts.find(p => p.id === 'style').content, '长句，多用从句。')
  assert.deepEqual(preset.prompts.map(p => p.name), ['Main Prompt', '视角', 'Char Description', '文风', 'Chat History', '思维链'], 'the new prompt right after the one named')
  assert.equal(preset.prompts.find(p => p.id === 'cot').enabled, true)
  assert.deepEqual(readPickedPrompts('<read>cot, style, chatHistory, nope</read>', preset), ['cot', 'style'])
})

test('a book entry made constant after it was edited elsewhere keeps the edit', () => {
  const book = normalizeBook(BOOK, '旧城')
  const { changes } = readBookEdit('<entry uid="2" mode="constant">城东的旧码头。</entry>', book)
  assert.deepEqual(changes.map(c => [c.id, c.mode]), [['entry:2', 'constant']])
  book.entries.find(e => e.uid === '2').content = '城东的旧码头，渡船停在这里。'
  applyBookChanges(book, changes, ['entry:2'])
  const entry = book.entries.find(e => e.uid === '2')
  assert.deepEqual([entry.constant, entry.content], [true, '城东的旧码头，渡船停在这里。'])
  // A fenced entry keeps its fences, echoed or changed.
  book.entries[0].content = '```yaml\nrule: 雨夜\n```'
  assert.deepEqual(readBookEdit('<entry uid="0">```yaml\nrule: 雨夜\n```</entry>', book).changes, [])
  assert.equal(readBookEdit('<entry uid="0">```yaml\nrule: 雪夜\n```</entry>', book).changes[0].after, '```yaml\nrule: 雪夜\n```')
})

// ─── Over HTTP, with a model that answers by what it is asked ─────────────

const BOOK_ANSWER = '<reply>加了船夫。</reply>\n<new_entry name="老周" keys="老周, 船夫" mode="keyword">码头的船夫。</new_entry>\n<entry uid="0">旧城只在雨夜和雪夜开门。</entry>'
const PRESET_ANSWER = '<reply>文风改了。</reply>\n<prompt id="style">长句。</prompt>'

async function fakeModel() {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(body)
    const system = body.messages[0]?.content ?? ''
    const content = /只回答 <read>/.test(system) ? '<read>3, 5</read>' : /预设编辑/.test(system) ? PRESET_ANSWER : BOOK_ANSWER
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-talk-'))
  const model = await fakeModel()
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    model.close()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `${model.base}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  // Ask, then wait for the job to finish.
  const ask = async (url, body) => {
    let session = (await call(url, { method: 'POST', body })).body
    for (let i = 0; i < 200 && session.job; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      session = (await call(url)).body
    }
    return session
  }
  return { app, call, ask, model }
}

test('a worldbook by talking: a proposal, the chosen part applied, undone, the session gone with the book', async t => {
  const { app, call, ask, model } = await tavern(t)
  const book = normalizeBook(BOOK, '旧城', { standalone: true })
  await app.store.saveBook(book)
  const url = `/api/talk/book/${book.id}`
  assert.deepEqual((await call(url)).body.turns, [])

  const session = await ask(url, { text: '加一个船夫，雨夜规则加上雪夜' })
  assert.equal(session.error, null)
  assert.deepEqual(session.turns[0].assistant.changes.map(c => c.id), ['new:0', 'entry:0'])
  assert.match(model.seen[0].messages.at(-1).content, /这次的要求：\n加一个船夫/)

  const done = (await call(`${url}/apply`, { method: 'POST', body: { ids: ['new:0'] } })).body
  assert.deepEqual([done.applied, done.prefix, done.session.undo], [1, false, true])
  assert.equal(done.book.entries.at(-1).comment, '老周')
  assert.equal((await app.store.getBook(book.id)).entries.length, 5)

  const undone = (await call(`${url}/undo`, { method: 'POST' })).body
  assert.equal(undone.book.entries.length, 4)
  assert.equal(undone.session.turns[0].outcome.undone, true)
  assert.equal((await app.store.getBook(book.id)).entries.length, 4)
  assert.equal((await call(`${url}/undo`, { method: 'POST' })).status, 409, 'once')

  // Changed elsewhere after it went in: no undo.
  await ask(url, { text: '再加一次' })
  await call(`${url}/apply`, { method: 'POST', body: { ids: ['entry:0'] } })
  await call(`/api/worldbooks/${book.id}`, { method: 'PUT', body: { name: '改了名' } })
  assert.equal((await call(`${url}/undo`, { method: 'POST' })).status, 409)
  assert.match(model.seen[1].messages.at(-1).content, /用户采用后又撤销了/)

  const usage = (await call('/api/usage?days=1')).body
  assert.ok(usage.byChat.some(row => row.title === '修改世界书：旧城'), JSON.stringify(usage.byChat))
  await call(`/api/worldbooks/${book.id}`, { method: 'DELETE' })
  assert.equal((await call(url)).status, 404, 'the session goes with the book')
})

test("a card's own book and a long one: the card is what is saved; a long book is looked through first", async t => {
  const { app, call, ask, model } = await tavern(t)
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'c.json', data: Buffer.from(JSON.stringify({ name: '青禾', first_mes: '你好。', character_book: BOOK })).toString('base64') } })).body
  const url = `/api/talk/book/card-${card.id}`
  await ask(url, { text: '加一个船夫' })
  const done = (await call(`${url}/apply`, { method: 'POST', body: { ids: ['new:0', 'entry:0'] } })).body
  assert.deepEqual([done.applied, done.prefix, done.card.id], [2, true, card.id])
  assert.equal(done.book.id, `card-${card.id}`)
  assert.equal((await app.store.getCard(card.id)).book.entries.at(-1).comment, '老周')
  assert.equal((await call(`${url}/undo`, { method: 'POST' })).body.book.entries.length, 4)
  assert.equal((await app.store.getCard(card.id)).book.entries.length, 4)

  const long = normalizeBook({ name: '大书', entries: Array.from({ length: 30 }, (_, i) => ({ uid: i, comment: `人物${i}`, keys: [`人物${i}`], content: '设定'.repeat(1500) })) }, '大书', { standalone: true })
  await app.store.saveBook(long)
  const before = model.seen.length
  await ask(`/api/talk/book/${long.id}`, { text: '改改人物' })
  const [look, edit] = model.seen.slice(before)
  assert.match(look.messages.at(-1).content, /目录（30 条）/)
  assert.match(edit.messages.at(-1).content, /<entry uid="3" name="人物3"[^>]*>\n设定/, 'the entries asked for go in full')
})

test('a preset by talking; the built-in one is changed by its options instead', async t => {
  const { app, call, ask } = await tavern(t)
  const preset = normalizePreset(PRESET, '叙事预设')
  await app.store.savePreset(preset)
  const url = `/api/talk/preset/${preset.id}`
  const session = await ask(url, { text: '文风改成长句' })
  assert.deepEqual(session.turns[0].assistant.changes.map(c => c.id), ['prompt:style'])
  const done = (await call(`${url}/apply`, { method: 'POST', body: { ids: ['prompt:style'] } })).body
  assert.equal(done.preset.prompts.find(p => p.id === 'style').content, '长句。')
  assert.equal(done.prefix, true)
  assert.equal((await call(`${url}/undo`, { method: 'POST' })).body.preset.prompts.find(p => p.id === 'style').content, '短句，少形容词。')
  assert.equal((await call('/api/talk/preset/basic')).status, 400)
  await call(`/api/presets/${preset.id}`, { method: 'DELETE' })
  assert.equal((await call(url)).status, 404)
})
