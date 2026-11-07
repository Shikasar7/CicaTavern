// 修改角色卡: a saved card's fields edited in place (web/shared/card-edit.js), the
// card exported back to SillyTavern with what the app does not read kept
// (cards.mjs sillyTavernCard), and changes asked for in words, proposed by a
// model and applied only as chosen (forge/edit.mjs, run like a forge draft).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard, rawOfPicture, sillyTavernCard, writeCardPng } from '../server/cards.mjs'
import { applyChanges, editRequest, readEdit, shownEntries } from '../server/forge/edit.mjs'
import { claimsChanges, missingNote } from '../server/forge/blocks.mjs'
import { cleanTags, diffLines, editCard, foldSame, greetingList, inlineDiff } from '../web/shared/card-edit.js'

const RAW = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '林青禾',
    description: '旧城「青禾茶馆」的掌柜，二十六岁。',
    personality: '温和，记性好。',
    scenario: '雨天的午后，茶馆里只有你一个客人。',
    first_mes: '「又下雨了。」青禾把茶盏推到你面前。',
    alternate_greetings: ['打烊前，青禾在擦柜台。'],
    mes_example: '<START>\n{{char}}: 「这茶要等三分钟。」',
    creator_notes: '一张安静的茶馆卡。',
    system_prompt: '',
    post_history_instructions: '',
    tags: ['日常', '茶馆'],
    creator: '测试',
    character_version: '1.2',
    extensions: { talkativeness: '0.4', depth_prompt: { prompt: '', depth: 2, role: 'system' }, custom: { kept: true } },
    character_book: {
      name: '茶馆',
      entries: [
        { id: 0, comment: '青禾茶馆', content: '茶馆在旧城石桥边，木楼两层。', constant: true, keys: [], enabled: true, position: 'before_char', extensions: { position: 0, depth: 4, group: '地点' } },
        { id: 1, comment: '茶点', content: '桂花糕、绿豆酥。', constant: false, keys: ['茶点', '点心'], enabled: true, insertion_order: 50, extensions: { position: 1 } },
      ],
    },
  },
}

const stored = () => normalizeCard(RAW)

test('editing fields: what changed, and whether a chat\'s frozen prefix would differ', () => {
  const card = stored()
  assert.deepEqual(editCard(card, { creatorNotes: '新的备注', tags: '日常, 茶馆，雨天' }), { changed: ['creatorNotes', 'tags'], prefix: false })
  assert.deepEqual(card.tags, ['日常', '茶馆', '雨天'])
  assert.deepEqual(editCard(card, { description: card.description }), { changed: [], prefix: false }, 'the same text is no change')
  assert.deepEqual(editCard(card, { personality: '冷淡，话少。' }), { changed: ['personality'], prefix: true })
  assert.deepEqual(editCard(card, { depthPrompt: '她今天心情不好。' }), { changed: ['depthPrompt'], prefix: false }, 'the character note goes with every turn')
  assert.deepEqual(editCard(card, { greetings: ['新的开场。', '', '  ', '第二个开场。'] }), { changed: ['greetings'], prefix: false })
  assert.equal(card.firstMes, '新的开场。')
  assert.deepEqual(card.alternateGreetings, ['第二个开场。'], 'blank alternates are dropped')
  assert.deepEqual(greetingList(card), ['新的开场。', '第二个开场。'])
  assert.equal(editCard(card, { name: '  林  青禾 ' }).prefix, true)
  assert.equal(card.name, '林 青禾')
  assert.throws(() => editCard(card, { name: '  ' }), error => error.blankName)
  assert.deepEqual(cleanTags(['a', ' a ', '', 'b']), ['a', 'b'])
})

test('before and after: changed lines paired, with the part that differs; long unchanged runs folded', () => {
  assert.deepEqual(inlineDiff('她很温柔。', '她很冷淡。'), [{ op: 'same', text: '她很' }, { op: 'del', text: '温柔' }, { op: 'add', text: '冷淡' }, { op: 'same', text: '。' }])
  const lines = diffLines('一\n二\n三\n四\n五\n六\n七\n八', '一\n二\n叁\n四\n五\n六\n七\n八\n九')
  assert.deepEqual(lines.map(l => l.op), ['same', 'same', 'change', 'same', 'same', 'same', 'same', 'same', 'add'])
  assert.deepEqual(lines[2].parts, [{ op: 'del', text: '三' }, { op: 'add', text: '叁' }])
  const folded = foldSame(lines)
  assert.deepEqual(folded.map(l => l.op), ['same', 'same', 'change', 'same', 'skip', 'same', 'add'], 'a run of two at the start is not worth folding')
  assert.equal(folded[4].count, 3)
  assert.deepEqual(foldSame(diffLines('a\nb\nc\nd\ne', 'a\nb\nc\nd\nE')).map(l => l.op), ['skip', 'same', 'change'])
  assert.deepEqual(diffLines('', '新'), [{ op: 'add', text: '新' }])
  assert.deepEqual(diffLines('旧', ''), [{ op: 'del', text: '旧' }])
})

test('export: the fields kept here over the file the card came from, so the rest survives', () => {
  const card = stored()
  editCard(card, { description: '掌柜，话少。', greetings: ['开场一。', '开场二。', '开场三。'] })
  card.book.entries[1].content = '桂花糕。'
  card.book.entries[1].keys = ['茶点']
  const out = sillyTavernCard(card, RAW)
  assert.equal(out.spec, 'chara_card_v3')
  assert.equal(out.data.description, '掌柜，话少。')
  assert.deepEqual(out.data.alternate_greetings, ['开场二。', '开场三。'])
  assert.equal(out.data.character_version, '1.2', 'fields the app does not read are kept')
  assert.deepEqual(out.data.extensions.custom, { kept: true })
  assert.equal(out.data.extensions.depth_prompt.depth, 2)
  assert.equal(out.data.character_book.entries[0].extensions.group, '地点', 'and so are entry fields')
  assert.equal(out.data.character_book.entries[1].content, '桂花糕。')
  assert.deepEqual(out.data.character_book.entries[1].keys, ['茶点'])
  // Read back, it is the edited card.
  const back = normalizeCard(out)
  for (const key of ['name', 'description', 'personality', 'firstMes', 'alternateGreetings', 'mesExample', 'creatorNotes', 'tags']) assert.deepEqual(back[key], card[key], key)
  assert.deepEqual(back.book.entries.map(e => [e.uid, e.content, e.constant, e.position, e.order]), card.book.entries.map(e => [e.uid, e.content, e.constant, e.position, e.order]))
  // No file to go over: still a whole card.
  assert.equal(normalizeCard(sillyTavernCard(card)).description, '掌柜，话少。')
})

test('the request: the card in full, entries the words name first, a target kept to one piece', () => {
  const card = stored()
  const { request, shown } = editRequest(card, { text: '茶点再多几样', target: 'entry:1', reply: 'English' })
  assert.deepEqual(shown, ['1', '0'])
  const content = request.messages[0].content
  assert.match(content, /<field name="description">\n旧城/)
  assert.match(content, /<greeting index="2">\n打烊前/)
  assert.match(content, /<entry uid="1" name="茶点" mode="keyword" keys="茶点, 点心">/)
  assert.match(content, /只改 <entry uid="1"> 这一处/)
  assert.match(request.system, /用English/)
  // A card's own update format stays (a JSONPatch card was once rewritten to _.set), and a laid-out bar needs 调整状态栏.
  assert.match(request.system, /沿用它原来的写法/)
  assert.doesNotMatch(request.system, /只能用 <UpdateVariable> 这个标签和 _\.set/)
  assert.match(request.system, /调整状态栏」里加上才显示/)
  // Past the budget, entries go by name only and their text can't be changed.
  const big = stored()
  big.book.entries[0].content = '长'.repeat(70000)
  assert.deepEqual([...shownEntries(big.book.entries, '茶点')], ['1'])
  assert.match(editRequest(big, { text: '茶点' }).request.messages[0].content, /正文 70000 字，这次没有附上/)
})

const ANSWER = `<reply>她说话冷淡了些，也加了青梅竹马阿砚。</reply>
<field name="personality">冷淡，话少，记性好。</field>
<field name="tags">日常, 茶馆, 冷淡</field>
<greeting index="3">打烊了，青禾没抬头。
</greeting>
<entry uid="1" keys="茶点, 点心, 桂花糕">桂花糕、绿豆酥、杏仁茶。</entry>
<entry uid="0">茶馆在旧城石桥边，木楼两层。</entry>
<new_entry name="阿砚" keys="阿砚, 砚哥" mode="keyword">青禾的青梅竹马，在码头做账房。
<remove_entry uid="9"></remove_entry>
<field name="unknown">x</field>`

test('reading a proposal: each changed piece, nothing the same as before, nothing unknown', () => {
  const card = stored()
  const { reply, changes } = readEdit(ANSWER, card, { shown: ['0', '1'] })
  assert.equal(reply, '她说话冷淡了些，也加了青梅竹马阿砚。')
  assert.deepEqual(changes.map(c => c.id), ['field:personality', 'field:tags', 'greeting:2', 'entry:1', 'new:0'])
  assert.equal(changes.find(c => c.id === 'greeting:2').before, '', 'a new opening')
  assert.deepEqual(changes.find(c => c.id === 'entry:1').keys, ['茶点', '点心', '桂花糕'])
  assert.equal(changes.find(c => c.id === 'new:0').after, '青禾的青梅竹马，在码头做账房。', 'an unclosed block ends at the next one')
  assert.equal(changes.find(c => c.id === 'new:0').constant, false)
  assert.deepEqual(readEdit(ANSWER, card, { shown: ['0'] }).changes.map(c => c.id), ['field:personality', 'field:tags', 'greeting:2', 'new:0'], 'an entry not sent in full is not changed')
  assert.deepEqual(readEdit(ANSWER, card, { target: 'field:personality' }).changes.map(c => c.id), ['field:personality'])
  assert.deepEqual(readEdit('好的，不用改。', card), { reply: '好的，不用改。', changes: [] })
  assert.equal(readEdit('<reply>改了描述。\n<field name="description">新描述</field>', card).reply, '改了描述。', 'a reply left open stops at the first block')
})

test('applying the chosen changes: the card changes in place, a new entry makes a book where there was none', () => {
  const card = stored()
  const { changes } = readEdit(ANSWER, card)
  const keywordOnly = applyChanges(card, changes, ['entry:1', 'new:0', 'greeting:2'])
  assert.deepEqual(keywordOnly, { applied: 3, prefix: false }, 'keyword entries and openings stay out of the prefix')
  assert.deepEqual(card.alternateGreetings, ['打烊前，青禾在擦柜台。', '打烊了，青禾没抬头。'])
  assert.equal(card.book.entries.at(-1).comment, '阿砚')
  assert.deepEqual(card.book.entries.at(-1).keys, ['阿砚', '砚哥'])
  assert.equal(applyChanges(card, changes, ['field:personality', 'field:tags']).prefix, true)
  assert.equal(card.personality, '冷淡，话少，记性好。')
  assert.deepEqual(card.tags, ['日常', '茶馆', '冷淡'])

  const bare = normalizeCard({ name: '无书', first_mes: '你好。' })
  const added = readEdit('<new_entry name="规矩" mode="constant">不替玩家说话。</new_entry>', bare).changes
  assert.deepEqual(applyChanges(bare, added, added.map(c => c.id)), { applied: 1, prefix: true })
  assert.equal(bare.book.entries[0].constant, true)
})

test('a fenced piece keeps its fences; a body the model only wrapped in one loses them', () => {
  const card = normalizeCard({ ...RAW, data: { ...RAW.data, first_mes: '```html\n<div>UI</div>\n```' } })
  const echoed = readEdit('<greeting index="1">```html\n<div>UI</div>\n```</greeting>', card).changes
  assert.deepEqual(echoed, [], 'the same fenced opening is no change')
  const [changed] = readEdit('<greeting index="1">```html\n<div>UI v2</div>\n```</greeting>', card).changes
  assert.equal(changed.after, '```html\n<div>UI v2</div>\n```')
  // A plain piece answered inside a fence: the fence was the model's.
  const [wrapped] = readEdit('<field name="personality">```\n冷淡，话少。\n```</field>', card).changes
  assert.equal(wrapped.after, '冷淡，话少。')
  // Two blocks of code with words between: not one wrapper, left whole.
  const [two] = readEdit('<field name="personality">```js\na()\n```\n然后\n```js\nb()\n```</field>', card).changes
  assert.equal(two.after, '```js\na()\n```\n然后\n```js\nb()\n```')
})

test('a proposal taken later: an entry edited since keeps the edit unless the proposal rewrites its text', () => {
  const card = stored()
  const { changes } = readEdit('<entry uid="1" keys="茶点, 甜点">桂花糕、绿豆酥。</entry>', card)
  assert.deepEqual(changes.map(c => [c.id, c.keys]), [['entry:1', ['茶点', '甜点']]])
  card.book.entries[1].content = '桂花糕、绿豆酥、芝麻饼。'
  applyChanges(card, changes, ['entry:1'])
  assert.equal(card.book.entries[1].content, '桂花糕、绿豆酥、芝麻饼。')
  assert.deepEqual(card.book.entries[1].keys, ['茶点', '甜点'])
})

// ─── Over HTTP, with a model that answers ANSWER (or `answers` in turn, the last one from then on) ───

async function fakeModel(answers = [ANSWER]) {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    const content = answers[Math.min(seen.length, answers.length) - 1]
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 60 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

async function tavern(t, answers) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-card-edit-'))
  const model = await fakeModel(answers)
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    model.close()
    server.closeAllConnections?.()
    server.close()
    // A write still finishing on Windows can leave the folder briefly not empty.
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: res.headers.get('content-type')?.startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer()) }
  }
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `${model.base}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  return { app, call, model }
}

// The smallest PNG there is: one transparent pixel.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

test('editing over HTTP keeps the card\'s id, chats, cast and settings; an open chat keeps its prefix until applied', async t => {
  const { app, call } = await tavern(t)
  const png = writeCardPng(PIXEL, RAW)
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'c.png', data: png.toString('base64') } })).body
  await call(`/api/cards/${card.id}/organize`, { method: 'PUT', body: { group: '日常' } })
  const saved = await app.store.getCard(card.id)
  saved.media = { roster: [{ id: 'r1', name: '林青禾', looks: 'black hair' }] }
  saved.worldbookIds = ['book1']
  await app.store.saveCard(saved)
  const chat = (await call('/api/chats', { method: 'POST', body: { cardId: card.id } })).body

  const view = (await call(`/api/cards/${card.id}/edit`)).body
  assert.equal(view.personality, '温和，记性好。')
  assert.deepEqual(view.greetings, ['「又下雨了。」青禾把茶盏推到你面前。', '打烊前，青禾在擦柜台。'])
  assert.equal(view.fromForge, false)

  const notes = (await call(`/api/cards/${card.id}/edit`, { method: 'PUT', body: { creatorNotes: '改过的备注' } })).body
  assert.deepEqual([notes.changed, notes.prefix], [['creatorNotes'], false])
  const edited = (await call(`/api/cards/${card.id}/edit`, { method: 'PUT', body: { name: '青禾', description: '茶馆掌柜，话少。' } })).body
  assert.deepEqual([edited.changed, edited.prefix, edited.id], [['name', 'description'], true, card.id])
  assert.equal((await call(`/api/cards/${card.id}/edit`, { method: 'PUT', body: { name: '' } })).status, 400)

  const after = await app.store.getCard(card.id)
  assert.deepEqual(after.media, saved.media, 'the cast stays')
  assert.deepEqual([after.worldbookIds, after.group], [['book1'], '日常'])
  assert.deepEqual((await call(`/api/chats?cardId=${card.id}`)).body.map(c => c.id), [chat.id], 'the chat stays with the card')

  const prompt = (await call(`/api/chats/${chat.id}/prompt`)).body.systemPrompt
  assert.match(prompt, /旧城「青禾茶馆」的掌柜/, 'the open chat keeps the prefix it started with')
  const applied = (await call(`/api/chats/${chat.id}/preset`, { method: 'POST', body: {} })).body
  assert.equal(applied.names.char, '青禾', 'a rename reaches {{char}} once applied')
  assert.match((await call(`/api/chats/${chat.id}/prompt`)).body.systemPrompt, /茶馆掌柜，话少。/)

  // Exported, the card carries the edits and what the app does not read.
  const json = (await call(`/api/cards/${card.id}/sillytavern`)).body
  assert.deepEqual([json.data.name, json.data.description, json.data.character_version], ['青禾', '茶馆掌柜，话少。', '1.2'])
  const exported = rawOfPicture((await call(`/api/cards/${card.id}/png`)).body)
  assert.equal(exported.data.description, '茶馆掌柜，话少。')

  // A new picture keeps the card file in it.
  const pictured = (await call(`/api/cards/${card.id}/avatar`, { method: 'PUT', body: { image: `data:image/png;base64,${PIXEL.toString('base64')}` } })).body
  assert.equal(pictured.hasAvatar, true)
  assert.equal(rawOfPicture((await call(`/api/cards/${card.id}/avatar`)).body).data.character_version, '1.2')
  assert.equal((await call(`/api/cards/${card.id}/avatar`, { method: 'PUT', body: { image: 'data:image/jpeg;base64,AAAA' } })).status, 400)
})

test('a proposal taken in is taken back as a whole, once, and not after the card has changed since', async t => {
  const { app, call } = await tavern(t)
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'c.json', data: Buffer.from(JSON.stringify(RAW)).toString('base64') } })).body
  let session = (await call(`/api/cards/${card.id}/assistant`, { method: 'POST', body: { text: '让她说话冷淡一点，再加一个青梅竹马' } })).body
  for (let i = 0; i < 200 && session.job; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    session = (await call(`/api/cards/${card.id}/assistant`)).body
  }
  const done = (await call(`/api/cards/${card.id}/assistant/apply`, { method: 'POST', body: { ids: ['field:personality', 'new:0'] } })).body
  assert.equal(done.session.undo, true)
  assert.equal((await call(`/api/cards/${card.id}/assistant`)).body.undo, true, 'still there when the window opens again')
  const before = await app.store.getCard(card.id)
  await app.store.saveCard({ ...before, creator: '别处改过' })
  assert.equal((await call(`/api/cards/${card.id}/assistant/undo`, { method: 'POST' })).status, 409)
  await app.store.saveCard(before)
  const undone = (await call(`/api/cards/${card.id}/assistant/undo`, { method: 'POST' })).body
  assert.equal(undone.card.personality, '温和，记性好。')
  assert.equal(undone.card.bookEntries, 2)
  assert.equal(undone.prefix, true)
  assert.equal(undone.chatKept, false)
  assert.equal(undone.session.undo, false)
  assert.equal(undone.session.turns[0].outcome.undone, true)
  assert.equal((await call(`/api/cards/${card.id}/assistant/undo`, { method: 'POST' })).status, 409, 'once')
})

test('asking in words: a proposal from the model, applied as chosen, counted under the card', async t => {
  const { app, call, model } = await tavern(t)
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'c.json', data: Buffer.from(JSON.stringify(RAW)).toString('base64') } })).body
  assert.deepEqual((await call(`/api/cards/${card.id}/assistant`)).body.turns, [], 'no session yet')
  assert.equal((await call(`/api/cards/${card.id}/assistant`, { method: 'POST', body: { text: ' ' } })).status, 400)

  const started = (await call(`/api/cards/${card.id}/assistant`, { method: 'POST', body: { text: '让她说话冷淡一点，再加一个青梅竹马' } })).body
  assert.equal(started.turns.length, 1)
  let session = started
  for (let i = 0; i < 200 && session.job; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    session = (await call(`/api/cards/${card.id}/assistant`)).body
  }
  assert.equal(session.error, null)
  const turn = session.turns[0]
  assert.equal(turn.assistant.reply, '她说话冷淡了些，也加了青梅竹马阿砚。')
  assert.deepEqual(turn.assistant.changes.map(c => c.id), ['field:personality', 'field:tags', 'greeting:2', 'entry:1', 'new:0'])
  assert.match(model.seen[0].messages.at(-1).content, /这次的要求：\n让她说话冷淡一点/)
  assert.equal((await app.store.getCard(card.id)).personality, '温和，记性好。', 'nothing changes before it is chosen')

  const done = (await call(`/api/cards/${card.id}/assistant/apply`, { method: 'POST', body: { ids: ['field:personality', 'new:0'] } })).body
  assert.deepEqual([done.applied, done.prefix], [2, true])
  assert.equal(done.card.personality, '冷淡，话少，记性好。')
  assert.equal(done.card.bookEntries, 3)
  assert.deepEqual(done.session.turns[0].outcome.applied, ['field:personality', 'new:0'])
  assert.equal((await call(`/api/cards/${card.id}/assistant/apply`, { method: 'POST', body: { ids: ['field:tags'] } })).status, 409, 'answered already')

  // The next request carries what came before; usage counts under the card.
  await call(`/api/cards/${card.id}/assistant`, { method: 'POST', body: { text: '开场白也冷一点', target: 'greeting:0' } })
  for (let i = 0; i < 200 && (await call(`/api/cards/${card.id}/assistant`)).body.job; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const second = model.seen[1].messages.at(-1).content
  assert.match(second, /之前的几次修改[\s\S]*用户采用了其中 2 处/)
  assert.match(second, /只改 <greeting index="1"> 这一处/)
  const usage = (await call('/api/usage?days=1')).body
  assert.ok(usage.byChat.some(row => row.chatId === `forge-edit-${card.id}` && row.title === '修改：林青禾'), JSON.stringify(usage.byChat))

  const discarded = (await call(`/api/cards/${card.id}/assistant/discard`, { method: 'POST' })).body
  assert.equal(discarded.turns.at(-1).outcome.discarded, true)
  assert.deepEqual((await call(`/api/cards/${card.id}/assistant`, { method: 'DELETE' })).body.turns, [])
  await call(`/api/cards/${card.id}/assistant`, { method: 'POST', body: { text: '再改改' } })
  await call(`/api/cards/${card.id}`, { method: 'DELETE' })
  assert.equal((await call(`/api/cards/${card.id}/assistant`)).status, 404, 'the session goes with the card')
})

test('a card without a book of its own gets one when its first entry is added', async t => {
  const { call } = await tavern(t)
  const bare = (await call('/api/cards/import', { method: 'POST', body: { filename: 'b.json', data: Buffer.from(JSON.stringify({ name: '无书', first_mes: '你好。' })).toString('base64') } })).body
  assert.equal((await call(`/api/cards/${bare.id}/book`, { method: 'PUT', body: { entries: [] } })).status, 404)
  const added = (await call(`/api/cards/${bare.id}/book`, { method: 'PUT', body: { add: { comment: '新条目' } } })).body
  assert.equal(added.card.bookEntries, 1)
  assert.equal((await call(`/api/cards/${bare.id}/book`)).body.entries[0].comment, '新条目')
})

test('reading leniently: full-width or missing quotes, the page\'s field names, an <entry> the card lacks as a new one', () => {
  const card = stored()
  const answer = `<reply>改好了。</reply>
<field name=“性格”>冷淡。</field>
<field name=scenario>夜里，茶馆打烊了。</field>
<field name="first_mes">「打烊了。」</field>
<entry uid="7" name="阿砚" keys="阿砚">青禾的青梅竹马。</entry>
<entry uid="1" keys="茶点">桂花糕。</entry>
<field name="背景故事">x</field>`
  const { changes, dropped } = readEdit(answer, card, { shown: ['0'] })
  assert.deepEqual(changes.map(c => c.id), ['field:personality', 'field:scenario', 'greeting:0', 'new:0'])
  assert.equal(changes.find(c => c.id === 'new:0').name, '阿砚')
  assert.deepEqual(changes.find(c => c.id === 'new:0').keys, ['阿砚'])
  assert.deepEqual(dropped, [{ reason: 'unshown', name: '茶点' }, { reason: 'unknown', name: '背景故事' }])
})

test('an initial-variables entry asked for by mode: named so the book knows it, no keywords, and an open chat is told', () => {
  const card = stored()
  const { changes } = readEdit('<reply>加了变量。</reply><new_entry name="好感度" keys="好感" mode="initvar">好感度: 10</new_entry><new_entry name="[InitVar]状态" mode="initvar">心情: 平静</new_entry>', card)
  assert.deepEqual(changes.map(c => [c.name, c.keys, c.constant, c.initvar]), [['[initvar]好感度', [], false, true], ['[InitVar]状态', [], false, true]])
  assert.deepEqual(applyChanges(card, changes, ['new:0']), { applied: 1, prefix: true }, 'initial variables reach an open chat when it is applied')
  assert.equal(card.book.entries.at(-1).initvar, true)
})

test('an answer that says it changed things and wrote none out is caught; a plain "nothing to change" is not', () => {
  const card = stored()
  assert.equal(claimsChanges(readEdit('<reply>我已经把她改成冷淡的性格，并加了初始变量。</reply>', card)), true)
  assert.equal(claimsChanges(readEdit('<reply>这张卡已经是这样了，不需要改。</reply>', card)), false)
  assert.equal(claimsChanges(readEdit('<reply>改了性格。</reply><field name="personality">冷淡。</field>', card)), false)
  const unshown = readEdit('<reply>改了茶点。</reply><entry uid="1">桂花糕。</entry>', card, { shown: ['0'] })
  assert.equal(claimsChanges(unshown), true)
  assert.match(missingNote(unshown), /条目「茶点」这次没有附上全文/)
  assert.match(missingNote(readEdit('<reply>已修改。</reply>', card)), /改动没有写在规定的标签里/)
})

test('asked once more when the answer promised changes it did not write; still none, and the page hears why', async t => {
  const promised = '<reply>我已经把她改冷淡了，也加了青梅竹马。</reply>'
  const { call, model } = await tavern(t, [promised, ANSWER])
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'c.json', data: Buffer.from(JSON.stringify(RAW)).toString('base64') } })).body
  const wait = async () => {
    let session = (await call(`/api/cards/${card.id}/assistant`)).body
    for (let i = 0; i < 200 && session.job; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      session = (await call(`/api/cards/${card.id}/assistant`)).body
    }
    return session
  }
  await call(`/api/cards/${card.id}/assistant`, { method: 'POST', body: { text: '让她冷淡一点' } })
  const fixed = (await wait()).turns.at(-1).assistant
  assert.equal(model.seen.length, 2)
  assert.match(model.seen[1].messages.at(-1).content, /【格式提醒】/)
  assert.equal(model.seen[1].messages.at(-2).content, promised, 'the answer it gave goes back with the reminder')
  assert.equal(fixed.changes.length, 5)
  assert.equal(fixed.missed, undefined)
})

test('a chat begun without variables gets the card\'s new initial variables when its prefix is rebuilt; one with variables keeps its own', async t => {
  const { app, call } = await tavern(t)
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'c.json', data: Buffer.from(JSON.stringify(RAW)).toString('base64') } })).body
  const chat = (await call('/api/chats', { method: 'POST', body: { cardId: card.id } })).body
  assert.deepEqual(chat.state, {}, 'begun without variables')
  await call(`/api/cards/${card.id}/book`, { method: 'PUT', body: { add: { comment: '[initvar]初始变量', content: '好感度: 10\n心情: 平静' } } })
  const rebuilt = (await call(`/api/chats/${chat.id}/preset`, { method: 'POST', body: {} })).body
  assert.deepEqual(rebuilt.state, { 好感度: 10, 心情: '平静' })
  const stored = await app.store.getChat(chat.id)
  assert.deepEqual(stored.nodes.root.state, { 好感度: 10, 心情: '平静' })

  // Variables the chat has are left alone, even ones the card's start would set differently.
  stored.nodes.root.state = { 好感度: 50 }
  await app.store.saveChat(stored)
  await call(`/api/chats/${chat.id}/preset`, { method: 'POST', body: {} })
  assert.deepEqual((await app.store.getChat(chat.id)).nodes.root.state, { 好感度: 50 })
})

test('still nothing after asking once more: no changes, and the turn says the answer missed them', async t => {
  const { call, model } = await tavern(t, ['<reply>已经改好了。</reply>'])
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'c.json', data: Buffer.from(JSON.stringify(RAW)).toString('base64') } })).body
  await call(`/api/cards/${card.id}/assistant`, { method: 'POST', body: { text: '改成 MVU 卡' } })
  let session = (await call(`/api/cards/${card.id}/assistant`)).body
  for (let i = 0; i < 200 && session.job; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    session = (await call(`/api/cards/${card.id}/assistant`)).body
  }
  const turn = session.turns.at(-1).assistant
  assert.equal(model.seen.length, 2, 'asked once more, not again and again')
  assert.deepEqual([turn.changes, turn.missed], [[], { dropped: [] }])
  assert.equal(turn.reply, '已经改好了。')
  // The next request reads that nothing changed, not that it was done.
  await call(`/api/cards/${card.id}/assistant`, { method: 'POST', body: { text: '再试试' } })
  for (let i = 0; i < 200 && (await call(`/api/cards/${card.id}/assistant`)).body.job; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(model.seen[2].messages.at(-1).content, /已经改好了。（这次没有写出改动，内容没有变）/)
})

test('tags a model wrote escaped in a piece come out as tags, unless the piece had escapes of its own', () => {
  const card = stored()
  const { changes } = readEdit('<reply>加了规则。</reply><new_entry name="规则" mode="constant">每轮末尾写 &lt;UpdateVariable&gt; 块。</new_entry>', card)
  assert.equal(changes[0].after, '每轮末尾写 <UpdateVariable> 块。')
  card.description = '写成 &lt;b&gt; 的样子。'
  assert.equal(readEdit('<field name="description">写成 &lt;i&gt; 的样子。</field>', card).changes[0].after, '写成 &lt;i&gt; 的样子。')
})
