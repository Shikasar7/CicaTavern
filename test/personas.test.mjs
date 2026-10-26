// 你的角色 and 文风 as lists: the one setting there was becomes the first item
// (nothing lost, old chats unchanged), items are made, copied, renamed and
// deleted, files go out as SillyTavern's and come back the same, each card picks
// its own for new chats (default otherwise), a chat keeps what it started with
// until it is switched, and a card's export never carries the player's persona.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { createChat, newChatPicks, rebuildPrompt } from '../server/chats.mjs'
import { createStore } from '../server/store.mjs'
import { cleanList, DEFAULT_ITEM, personasInFile, pickFor, stPersonas, stStyles, stylesInFile } from '../web/shared/personas.js'

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-personas-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 3 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) }
  }
  return { app, call, dataRoot }
}

const section = (prompt, title) => new RegExp(`## ${title}\\n`).test(prompt)

test('the old single persona and writing rules become each list\'s first item, the default; old chats build the same prefix', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-personas-old-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  await writeFile(path.join(root, 'persona.json'), JSON.stringify({ name: '阿蝉', description: '阿蝉是个大学生。' }))
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ writingRules: '白描为主，对白口语化。', language: '简体中文' }))
  const store = createStore(root)
  await store.init()

  const personas = await store.getPersonas()
  const styles = await store.getStyles()
  assert.deepEqual(personas, { defaultId: DEFAULT_ITEM, items: [{ id: DEFAULT_ITEM, name: '阿蝉', title: '', description: '阿蝉是个大学生。' }], cards: {} })
  assert.deepEqual(styles, { defaultId: DEFAULT_ITEM, items: [{ id: DEFAULT_ITEM, name: '', text: '白描为主，对白口语化。' }], cards: {} })
  assert.ok(!existsSync(path.join(root, 'personas.json')) && !existsSync(path.join(root, 'styles.json')), 'read, not written, until something changes')
  assert.deepEqual(await store.getPersona(), personas.items[0], 'the old route still reads the default')

  const card = normalizeCard({ name: '小雨', description: '{{user}}是常客。', first_mes: '{{user}}，雨停了。' })
  await store.saveCard(card)
  const chat = await createChat(store, card.id)
  assert.equal(chat.names.user, '阿蝉')
  assert.deepEqual([chat.personaId, chat.styleId], [DEFAULT_ITEM, DEFAULT_ITEM])
  assert.ok(section(chat.systemPrompt, '玩家角色：阿蝉') && chat.systemPrompt.includes('阿蝉是个大学生。'))
  assert.match(chat.systemPrompt, /## 文风与写作要求\n白描为主，对白口语化。/)

  // A chat from before the lists (no personaId / styleId) rebuilds to the very same prefix.
  const old = structuredClone(chat)
  delete old.personaId
  delete old.styleId
  await rebuildPrompt(store, old)
  assert.equal(old.systemPrompt, chat.systemPrompt)

  // The first change writes the lists; the old files stay as they were.
  await store.savePersona({ description: '阿蝉在读研。' })
  assert.equal((await store.getPersonas()).items[0].description, '阿蝉在读研。')
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'persona.json'), 'utf8')), { name: '阿蝉', description: '阿蝉是个大学生。' })
  assert.equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).writingRules, '白描为主，对白口语化。')
  // A settings save keeps working (writingRules is no longer a setting, so nothing reads it there).
  await store.saveSettings({ replyLength: 600 })
  assert.equal((await store.getStyles()).items[0].text, '白描为主，对白口语化。')

  // A new default later: chats from before the lists still use the first item (what their prefix has).
  await store.updateList('persona', list => ({ ...list, items: [...list.items, { id: 'p2', name: '林舟', description: '林舟是记者。' }], defaultId: 'p2' }))
  const again = structuredClone(old)
  delete again.personaId
  await rebuildPrompt(store, again)
  assert.match(again.systemPrompt, /阿蝉在读研/)
  assert.equal(again.names.user, '阿蝉')
  assert.equal((await createChat(store, card.id)).names.user, '林舟', 'new chats take the new default')
})

test('lists stay whole: never empty, one default, picks only of items that are there', () => {
  assert.deepEqual(cleanList('persona', null), { defaultId: DEFAULT_ITEM, items: [{ id: DEFAULT_ITEM, name: '你', title: '', description: '' }], cards: {} })
  const list = cleanList('style', {
    defaultId: 'gone',
    items: [{ id: 'a', name: ' 白描 ', text: 'x' }, { id: 'a', name: 'twice' }, { id: '../bad', name: 'bad' }, { id: 'b', name: '', text: 'y' }],
    cards: { c1: 'b', c2: 'gone', '../c': 'a' },
  })
  assert.deepEqual(list, { defaultId: 'a', items: [{ id: 'a', name: '白描', text: 'x' }, { id: 'b', name: '', text: 'y' }], cards: { c1: 'b' } })
  assert.equal(pickFor(list, 'c1').id, 'b', 'the card\'s pick')
  assert.equal(pickFor(list, 'c9').id, 'a', 'no pick: the default')
  assert.equal(pickFor(list, 'c1', 'a').id, 'a', 'the chat\'s own first')
  assert.equal(pickFor(list, 'c1', 'deleted').id, 'b', 'the chat\'s own deleted: the card\'s')
})

test('personas and styles: made, edited, copied, made default, deleted, ticked for cards one at a time', async t => {
  const { app, call } = await tavern(t)
  await app.store.saveCard({ ...normalizeCard({ name: '林雪' }), id: 'c1' })
  await app.store.saveCard({ ...normalizeCard({ name: '白芷' }), id: 'c2' })

  const first = (await call('/api/personas')).body
  assert.deepEqual(first.items.map(i => [i.id, i.name, i.cardIds]), [[DEFAULT_ITEM, '你', []]])
  const made = (await call('/api/personas', { method: 'POST', body: { name: ' 林舟 ', description: '记者', id: 'mine', cardIds: ['c1'] } })).body
  assert.notEqual(made.item.id, 'mine', 'ids are the server\'s')
  assert.deepEqual([made.item.name, made.item.description, made.list.items.length], ['林舟', '记者', 2])
  const edited = (await call(`/api/personas/${made.item.id}`, { method: 'PUT', body: { title: '都市版', description: '{{user}}是记者。', name: '' } })).body.item
  assert.deepEqual([edited.name, edited.title, edited.description], ['你', '都市版', '{{user}}是记者。'], 'an empty name is the default one')
  await call(`/api/personas/${made.item.id}`, { method: 'PUT', body: { name: '林舟' } })
  assert.equal((await call('/api/personas/nope', { method: 'PUT', body: { name: 'x' } })).status, 404)

  // A persona's copy keeps the player's name and says it is a copy in its note; a style's says it in its name.
  const copy = (await call(`/api/personas/${made.item.id}/copy`, { method: 'POST', body: {} })).body.item
  assert.deepEqual([copy.name, copy.title, copy.description], ['林舟', '都市版（副本）', '{{user}}是记者。'])
  const style = (await call('/api/styles', { method: 'POST', body: { name: '白描', text: '少用形容词。' } })).body.item
  const styleCopy = (await call(`/api/styles/${style.id}/copy`, { method: 'POST', body: {} })).body.item
  assert.deepEqual([styleCopy.name, styleCopy.text], ['白描（副本）', '少用形容词。'])

  // A card picks one of each: ticking it for one item takes it off another.
  let ticked = (await call(`/api/personas/${made.item.id}/cards`, { method: 'PUT', body: { ids: ['c1', 'c2', 'gone'] } })).body
  assert.deepEqual(ticked.list.cards, { c1: made.item.id, c2: made.item.id })
  assert.deepEqual(ticked.changed.sort(), ['c1', 'c2'])
  ticked = (await call(`/api/personas/${copy.id}/cards`, { method: 'PUT', body: { ids: ['c2'] } })).body
  assert.deepEqual(ticked.list.cards, { c1: made.item.id, c2: copy.id })
  assert.deepEqual(ticked.list.items.find(i => i.id === made.item.id).cardIds, ['c1'])
  ticked = (await call(`/api/personas/${made.item.id}/cards`, { method: 'PUT', body: { ids: [] } })).body
  assert.deepEqual(ticked.list.cards, { c2: copy.id }, 'unticked: c1 uses the default again; c2 keeps its own')

  // The same from the card's side ('' = the default).
  const picks = (await call('/api/cards/c1/picks', { method: 'PUT', body: { personaId: made.item.id, styleId: style.id } })).body
  assert.equal(picks.persona.cards.c1, made.item.id)
  assert.equal(picks.style.cards.c1, style.id)
  assert.equal((await call('/api/cards/c1/picks', { method: 'PUT', body: { styleId: '' } })).body.style.cards.c1, undefined)
  assert.equal((await call('/api/personas')).body.cards.c1, made.item.id, 'left out: kept')
  assert.equal((await call('/api/cards/c1/picks', { method: 'PUT', body: { personaId: 'nope' } })).status, 404)
  assert.equal((await call('/api/cards/gone/picks', { method: 'PUT', body: { personaId: '' } })).status, 404)

  // The default can't go; another can, and the cards that picked it use the default again.
  assert.equal((await call(`/api/personas/${DEFAULT_ITEM}`, { method: 'DELETE' })).status, 400)
  const defaulted = (await call(`/api/personas/${copy.id}/default`, { method: 'POST', body: {} })).body
  assert.equal(defaulted.defaultId, copy.id)
  const left = (await call(`/api/personas/${made.item.id}`, { method: 'DELETE' })).body
  assert.deepEqual(left.items.map(i => i.id), [DEFAULT_ITEM, copy.id])
  assert.deepEqual(left.cards, { c2: copy.id })
  assert.equal((await call(`/api/personas/${DEFAULT_ITEM}`, { method: 'DELETE' })).status, 200, 'no longer the default')
  assert.equal((await call(`/api/personas/${copy.id}`, { method: 'DELETE' })).status, 400)

  // A card deleted lets go of its picks; the items stay.
  await call('/api/cards/c2', { method: 'DELETE' })
  assert.deepEqual((await call('/api/personas')).body.cards, {})
  assert.equal((await call('/api/personas')).body.items.length, 1)
})

test('files: SillyTavern\'s persona backup and system prompts go out and come back the same; text files are styles', async t => {
  const { call } = await tavern(t)
  const items = [{ id: 'a', name: '林舟', title: '都市版', description: '{{user}}是记者。' }, { id: 'b', name: '阿蝉', title: '', description: '大学生' }]

  // Personas: SillyTavern's backup, which its Persona Management restores.
  const file = JSON.parse(JSON.stringify(stPersonas(items)))
  assert.deepEqual(Object.keys(file), ['personas', 'persona_descriptions'])
  assert.deepEqual(file.personas, { 'cicatavern-a.png': '林舟', 'cicatavern-b.png': '阿蝉' })
  assert.deepEqual(Object.keys(file.persona_descriptions['cicatavern-a.png']), ['description', 'position', 'depth', 'role', 'lorebook', 'connections', 'title'])
  const imported = (await call('/api/personas/import', { method: 'POST', body: { text: JSON.stringify(file), filename: 'personas.json' } })).body
  assert.deepEqual(imported.added.map(({ id, ...rest }) => rest), items.map(({ id, ...rest }) => rest))
  assert.equal(imported.skipped, 0)
  const twice = (await call('/api/personas/import', { method: 'POST', body: { text: JSON.stringify(file) } })).body
  assert.deepEqual([twice.added.length, twice.skipped], [0, 2], 'the same file again adds nothing')
  // Exported from the list, it is the same file (ids aside).
  const listed = (await call('/api/personas')).body.items.slice(1)
  assert.deepEqual(Object.values(stPersonas(listed).personas), ['林舟', '阿蝉'])

  // A backup as SillyTavern writes it (its own keys, a default, connections) reads too.
  const st = {
    personas: { '1712345678901-Kai.png': 'Kai', 'user-default.png': 'User' },
    persona_descriptions: { '1712345678901-Kai.png': { description: 'A courier.', position: 0, depth: 2, role: 0, lorebook: '', connections: [{ type: 'character', id: 'x.png' }], title: 'night' }, 'orphan.png': { description: 'no persona' } },
    default_persona: 'user-default.png',
  }
  assert.deepEqual(personasInFile(st).map(p => [p.name, p.title, p.description]), [['Kai', 'night', 'A courier.'], ['User', '', '']])
  assert.deepEqual(personasInFile([{ name: '甲', description: '一' }]).map(p => p.name), ['甲'], 'a plain list')
  assert.deepEqual(personasInFile({ name: '小雨', description: '店员', first_mes: '欢迎' }), [], 'a character card is not a persona')
  assert.equal((await call('/api/personas/import', { method: 'POST', body: { text: '{"spec":"chara_card_v2","name":"小雨","description":"x"}' } })).status, 400)
  assert.equal((await call('/api/personas/import', { method: 'POST', body: { text: 'not json' } })).status, 400)

  // Styles: one as SillyTavern's system prompt, several as a list of them.
  const styles = [{ id: 'a', name: '白描', text: '少用形容词。' }, { id: 'b', name: '', text: '对白口语化。' }]
  assert.deepEqual(stStyles([styles[0]]), { name: '白描', content: '少用形容词。' })
  assert.deepEqual(stStyles(styles, '未命名'), [{ name: '白描', content: '少用形容词。' }, { name: '未命名', content: '对白口语化。' }])
  const back = (await call('/api/styles/import', { method: 'POST', body: { text: JSON.stringify(stStyles(styles, '未命名')), filename: 'styles.json' } })).body
  assert.deepEqual(back.added.map(s => [s.name, s.text]), [['白描', '少用形容词。'], ['未命名', '对白口语化。']])
  assert.deepEqual(stylesInFile(JSON.stringify({ instruct: {}, sysprompt: { name: 'Neutral', content: 'Write {{char}}.', post_history: '' } })).map(s => s.name), ['Neutral'], 'SillyTavern\'s Advanced Formatting export')
  const text = (await call('/api/styles/import', { method: 'POST', body: { text: '第一人称，现在时。\n', filename: '我的文风.txt' } })).body
  assert.deepEqual(text.added.map(s => [s.name, s.text]), [['我的文风', '第一人称，现在时。']])
  assert.equal((await call('/api/styles/import', { method: 'POST', body: { text: '{"temp": 1}' } })).status, 400)
})

test('a card\'s picks make its new chats; other cards use the defaults; a picked persona brings its own name', async t => {
  const { app, call } = await tavern(t)
  const store = app.store
  await store.savePersona({ name: '阿蝉', description: '阿蝉是个大学生。' })
  const plain = { ...normalizeCard({ name: '小雨', first_mes: '{{user}}，雨停了。' }), id: 'c1' }
  const named = { ...normalizeCard({ name: '青芜谷', first_mes: '{{user}}，过来。', extensions: { cicatavern: { user_name: '沈观' } } }), id: 'c2' }
  await store.saveCard(plain)
  await store.saveCard(named)
  const p = (await call('/api/personas', { method: 'POST', body: { name: '林舟', description: '林舟是记者。' } })).body.item
  const s = (await call('/api/styles', { method: 'POST', body: { name: '电影感', text: '按镜头组织段落。' } })).body.item

  // No picks: the defaults, and a card's own name for the player without the default's description.
  let chat = await createChat(store, 'c2')
  assert.equal(chat.names.user, '沈观')
  assert.doesNotMatch(chat.systemPrompt, /阿蝉/)
  assert.ok(!section(chat.systemPrompt, '文风与写作要求'), 'an empty default style writes no section')

  await call('/api/cards/c2/picks', { method: 'PUT', body: { personaId: p.id, styleId: s.id } })
  chat = await createChat(store, 'c2')
  assert.equal(chat.names.user, '林舟', 'a persona the card picked: its name, not the card\'s')
  assert.match(chat.systemPrompt, /## 玩家角色：林舟\n林舟是记者。/)
  assert.match(chat.systemPrompt, /## 文风与写作要求\n按镜头组织段落。/)
  assert.match(chat.nodes.root.text, /林舟，过来/)
  assert.deepEqual([chat.personaId, chat.styleId], [p.id, s.id])
  assert.equal((await call('/api/cards/c2')).body.greetingTexts[0], '林舟，过来。', 'the opening preview names the same player')

  const other = await createChat(store, 'c1')
  assert.equal(other.names.user, '阿蝉')
  assert.match(other.systemPrompt, /阿蝉是个大学生/)
  assert.doesNotMatch(other.systemPrompt, /林舟|按镜头/)

  // A persona named as the card names the player keeps its description.
  const same = (await call('/api/personas', { method: 'POST', body: { name: '沈观', description: '沈观是药童。' } })).body.item
  await call(`/api/personas/${same.id}/default`, { method: 'POST', body: {} })
  await call('/api/cards/c2/picks', { method: 'PUT', body: { personaId: '' } })
  const own = await createChat(store, 'c2')
  assert.equal(own.names.user, '沈观')
  assert.match(own.systemPrompt, /沈观是药童/)
  const picks = newChatPicks(named, await store.getPersonas(), await store.getStyles())
  assert.deepEqual([picks.persona.id, picks.style.id, picks.name], [same.id, s.id, '沈观'])
})

test('a chat keeps what it started with; it switches when told, and falls back when its own is deleted', async t => {
  const { app, call } = await tavern(t)
  const store = app.store
  await store.saveCard({ ...normalizeCard({ name: '小雨', first_mes: '雨停了。' }), id: 'c1' })
  const p = (await call('/api/personas', { method: 'POST', body: { name: '林舟', description: '林舟是记者。' } })).body.item
  const q = (await call('/api/personas', { method: 'POST', body: { name: '阿蝉', description: '阿蝉是学生。' } })).body.item
  const s = (await call('/api/styles', { method: 'POST', body: { name: '白描', text: '少用形容词。' } })).body.item
  const s2 = (await call('/api/styles', { method: 'POST', body: { name: '轻小说', text: '语言轻快。' } })).body.item
  await call('/api/cards/c1/picks', { method: 'PUT', body: { personaId: p.id, styleId: s.id } })
  let chat = await createChat(store, 'c1')
  await store.saveChat(chat)

  // The card picks another: the chat keeps its own, rebuilt or not.
  await call('/api/cards/c1/picks', { method: 'PUT', body: { personaId: q.id, styleId: s2.id } })
  await rebuildPrompt(store, chat)
  assert.match(chat.systemPrompt, /## 玩家角色：林舟\n林舟是记者。/)
  assert.match(chat.systemPrompt, /## 文风与写作要求\n少用形容词。/)
  assert.doesNotMatch(chat.systemPrompt, /阿蝉|语言轻快/)
  assert.equal(chat.names.user, '林舟')
  await store.saveChat(chat)

  // Switched for this chat: another style; then '' = what the card picks now (its persona, by its name).
  let view = (await call(`/api/chats/${chat.id}/picks`, { method: 'POST', body: { styleId: s2.id } })).body
  assert.equal(view.styleId, s2.id)
  chat = await store.getChat(chat.id)
  assert.match(chat.systemPrompt, /## 文风与写作要求\n语言轻快。/)
  assert.equal(chat.names.user, '林舟', 'only the style changed')
  view = (await call(`/api/chats/${chat.id}/picks`, { method: 'POST', body: { personaId: '' } })).body
  assert.deepEqual([view.personaId, view.names.user], [q.id, '阿蝉'])
  chat = await store.getChat(chat.id)
  assert.match(chat.systemPrompt, /## 玩家角色：阿蝉\n阿蝉是学生。/)
  view = (await call(`/api/chats/${chat.id}/picks`, { method: 'POST', body: { personaId: p.id } })).body
  assert.deepEqual([view.personaId, view.names.user], [p.id, '林舟'])
  assert.equal((await call(`/api/chats/${chat.id}/picks`, { method: 'POST', body: { personaId: 'nope' } })).status, 404)

  // Its persona deleted: the next rebuild takes what a new chat on the card would, name and all.
  await call(`/api/personas/${p.id}`, { method: 'DELETE' })
  chat = await store.getChat(chat.id)
  await rebuildPrompt(store, chat)
  assert.deepEqual([chat.personaId, chat.names.user], [q.id, '阿蝉'])
  assert.match(chat.systemPrompt, /阿蝉是学生/)
  assert.doesNotMatch(chat.systemPrompt, /林舟/)
})

test('a card exported never carries the player\'s persona or style; a new version picks what the old one did', async t => {
  const { app, call } = await tavern(t)
  const file = card => ({ filename: `${card.name}.json`, data: Buffer.from(JSON.stringify(card)).toString('base64') })
  const v1 = (await call('/api/cards/import', { method: 'POST', body: file({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '小雨 v1', description: '店员', first_mes: '欢迎。', extensions: {} } }) })).body
  const p = (await call('/api/personas', { method: 'POST', body: { name: '林舟', description: '这段是玩家自己的设定' } })).body.item
  const s = (await call('/api/styles', { method: 'POST', body: { name: '白描', text: '这段是玩家自己的文风' } })).body.item
  await call(`/api/cards/${v1.id}/picks`, { method: 'PUT', body: { personaId: p.id, styleId: s.id } })
  await createChat(app.store, v1.id)
  // A picture of its own, so the PNG export has one to write into (1×1).
  const dot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  assert.equal((await call(`/api/cards/${v1.id}/avatar`, { method: 'PUT', body: { image: `data:image/png;base64,${dot}` } })).status, 200)

  for (const url of [`/api/cards/${v1.id}/export`, `/api/cards/${v1.id}/sillytavern`, `/api/cards/${v1.id}/png`]) {
    const { status, body: out } = await call(url)
    assert.equal(status, 200, url)
    const text = Buffer.isBuffer(out) ? Buffer.from(out.toString('latin1').match(/chara\0([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf8') : JSON.stringify(out)
    assert.match(text, /店员/, `${url} carries the card`)
    assert.doesNotMatch(text, /玩家自己的|林舟/, url)
    assert.ok(!text.includes(p.id) && !text.includes(s.id), url)
  }

  const v2 = (await call('/api/cards/import', { method: 'POST', body: file({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '小雨 v2', description: '店员', first_mes: '欢迎。', extensions: {} } }) })).body
  assert.equal(v2.inherited, '小雨 v1')
  assert.equal((await call('/api/personas')).body.cards[v2.id], p.id)
  assert.equal((await call('/api/styles')).body.cards[v2.id], s.id)
})
