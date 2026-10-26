// 正则集 (regex sets) and the regex window as the lorebook one: a set is a named
// list of scripts for the cards ticked for it, run after the card's own; scripts
// export as SillyTavern regex files and come back the same; copies, moves, a
// card deleted, and a card exported with its sets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { cleanScripts, withAttachedScripts } from '../server/regex.mjs'
import { normalizeCard, sillyTavernCard } from '../server/cards.mjs'
import { activePath, chatScripts, createChat, scriptsOf } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { applyScripts, chatScriptList, PLACEMENT, scriptsInFile, stScripts } from '../web/shared/regex.js'

const script = (name, extra = {}) => ({ id: '', scriptName: name, findRegex: `/${name}/g`, replaceString: '', placement: [2], ...extra })
// A script that adds its mark after the text, so the order they ran in shows.
const mark = (name, extra = {}) => ({ ...script(name), findRegex: '/$/', replaceString: name, markdownOnly: true, ...extra })

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-regex-sets-'))
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
  return { app, call }
}

test('exported scripts are SillyTavern regex files: every field it reads, a name it insists on, and they come back the same', () => {
  const scripts = cleanScripts([
    { ...script('藏起变量块'), findRegex: '/<state>[\\s\\S]*?<\\/state>/g', trimStrings: ['<br>'], placement: [1, 2, 5], minDepth: 0, maxDepth: 3, substituteRegex: 2, promptOnly: true, runOnEdit: true },
    { ...script(''), findRegex: '/(?<who>小雨)说/', replaceString: '$<who>：', disabled: true },
  ])
  const file = JSON.parse(JSON.stringify(stScripts(scripts)))
  const fields = ['id', 'scriptName', 'findRegex', 'replaceString', 'trimStrings', 'placement', 'disabled', 'markdownOnly', 'promptOnly', 'runOnEdit', 'substituteRegex', 'minDepth', 'maxDepth']
  for (const one of file) assert.deepEqual(Object.keys(one), fields, 'SillyTavern\'s shape, nothing of this app\'s own')
  assert.equal(file[1].scriptName, '/(?<who>小雨)说/', 'SillyTavern refuses a script without a name: named by its pattern')
  assert.equal(file[1].runOnEdit, false)
  assert.equal(file[0].runOnEdit, true, 'kept from the file it came in')

  // One script as it is, several as a list: either reads back as the same scripts.
  const back = cleanScripts(scriptsInFile(file))
  assert.deepEqual(back, scripts.map((s, i) => (i === 1 ? { ...s, scriptName: '/(?<who>小雨)说/', runOnEdit: false } : s)))
  assert.deepEqual(cleanScripts(scriptsInFile(file[0])), [scripts[0]])
})

test('a chat runs the global scripts, its preset\'s, its card\'s own, then the sets on its card in their order; other cards are left alone', () => {
  const sets = [
    { id: 'a', name: '美化', cardIds: ['c1'], scripts: cleanScripts([mark('S1')]) },
    { id: 'b', name: '别的卡', cardIds: ['c2'], scripts: cleanScripts([mark('X')]) },
    { id: 'c', name: '第二个', cardIds: ['c2', 'c1'], scripts: cleanScripts([mark('S2')]) },
  ]
  const card = { id: 'c1', regexScripts: cleanScripts([mark('C')]) }
  const run = scripts => applyScripts('x', scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display' })
  assert.equal(run(scriptsOf(card, { regexScripts: cleanScripts([mark('P')]) }, cleanScripts([mark('G')]), sets)), 'xGPCS1S2')
  assert.equal(run(scriptsOf({ id: 'c3', regexScripts: [] }, null, [], sets)), 'x', 'a card no set is on')
  assert.equal(run(scriptsOf({ id: 'c2', regexScripts: [] }, null, [], sets)), 'xXS2')
  assert.equal(run(scriptsOf(null, null, [], sets)), 'x', 'a chat whose card is gone')

  // A card exported with its sets and imported again has them as its own: each runs once, as the card has it.
  const again = { ...card, regexScripts: withAttachedScripts(card, sets).regexScripts }
  assert.deepEqual(again.regexScripts.map(s => s.scriptName), ['C', 'S1', 'S2'])
  assert.equal(run(scriptsOf(again, null, [], sets)), 'xCS1S2')
  assert.deepEqual(chatScriptList({ card: again.regexScripts, cardId: 'c1', sets }).map(s => s.id), again.regexScripts.map(s => s.id))
})

test('sets: made, renamed, noted, copied apart, ticked for cards that exist, and listed with the global scripts', async t => {
  const { app, call } = await tavern(t)
  await app.store.saveCard({ ...normalizeCard({ name: '林雪' }), id: 'c1' })
  await app.store.saveCard({ ...normalizeCard({ name: '白芷' }), id: 'c2' })

  const made = (await call('/api/regex/sets', { method: 'POST', body: {} })).body
  assert.equal(made.name, '新正则集')
  assert.deepEqual([made.cardIds, made.scripts], [[], []])
  const set = (await call(`/api/regex/sets/${made.id}`, { method: 'PUT', body: { name: '  美化\n状态栏 ', description: '只给自己看', scripts: [script('a'), script('b')] } })).body
  assert.deepEqual([set.name, set.description, set.scripts.map(s => s.scriptName)], ['美化 状态栏', '只给自己看', ['a', 'b']])
  assert.equal((await call(`/api/regex/sets/${made.id}`, { method: 'PUT', body: { name: ' ' } })).status, 400)
  assert.equal((await call('/api/regex/sets/nope', { method: 'PUT', body: { name: 'x' } })).status, 404)

  const ticked = (await call(`/api/regex/sets/${made.id}/cards`, { method: 'PUT', body: { ids: ['c1', 'c2', 'gone', 'c1'] } })).body
  assert.deepEqual(ticked.set.cardIds, ['c1', 'c2'], 'cards that exist, each once')
  assert.deepEqual(ticked.changed, ['c1', 'c2'])
  assert.deepEqual((await call(`/api/regex/sets/${made.id}/cards`, { method: 'PUT', body: { ids: ['c2'] } })).body.changed, ['c1'])

  const copy = (await call(`/api/regex/sets/${made.id}/copy`, { method: 'POST' })).body
  assert.equal(copy.name, '美化 状态栏（副本）')
  assert.deepEqual(copy.cardIds, [], 'a copy is on no card yet')
  assert.deepEqual(copy.scripts.map(s => s.scriptName), ['a', 'b'])
  assert.ok(copy.scripts.every((s, i) => s.id !== set.scripts[i].id), 'its scripts are its own')

  const list = (await call('/api/regex')).body
  assert.deepEqual(list.sets.map(s => s.name), ['美化 状态栏', '美化 状态栏（副本）'], 'in the order they were made: the order they run in')
  assert.deepEqual(list.scripts, [])
  // The card editor learns which sets an export can take along.
  assert.deepEqual((await call('/api/cards/c2/edit')).body.regexSets, [{ id: made.id, name: '美化 状态栏', scripts: 2 }])
  assert.deepEqual((await call('/api/cards/c1/edit')).body.regexSets, [])
})

test('imports go into the group asked for, or a new set; scripts copy and move between groups', async t => {
  const { app, call } = await tavern(t)
  await app.store.saveCard({ ...normalizeCard({ name: '林雪' }), id: 'c1', regexScripts: cleanScripts([script('own')]) })
  const set = (await call('/api/regex/sets', { method: 'POST', body: { name: '美化' } })).body

  const file = stScripts(cleanScripts([script('one'), script('two', { promptOnly: true })]))
  const into = (await call('/api/regex/import', { method: 'POST', body: { scripts: file, to: `set-${set.id}` } })).body
  assert.deepEqual([into.added, into.to, into.scripts.map(s => s.scriptName)], [2, `set-${set.id}`, ['one', 'two']])
  assert.deepEqual(into.scripts.map(s => s.id), file.map(s => s.id), 'the ids the file has, while free')
  const fresh = (await call('/api/regex/import', { method: 'POST', body: { scripts: file, to: 'new', name: 'regex-美化' } })).body
  assert.equal(fresh.set.name, 'regex-美化')
  assert.deepEqual(fresh.scripts.map(s => [s.id, s.scriptName, s.promptOnly]), file.map(s => [s.id, s.scriptName, s.promptOnly]), 'exported and imported again: the same scripts')
  assert.deepEqual((await call('/api/regex/import', { method: 'POST', body: { scripts: file } })).body.to, 'global', 'global unless said')
  assert.equal((await call('/api/regex/import', { method: 'POST', body: { scripts: file, to: 'preset-basic' } })).status, 400)

  // Copied from the card's own into the set: ids of their own. Moved out of the set into the card: they keep theirs.
  const own = (await app.store.getCard('c1')).regexScripts
  const copied = (await call('/api/regex/transfer', { method: 'POST', body: { from: 'card-c1', to: `set-${set.id}`, ids: [own[0].id] } })).body
  assert.deepEqual(copied.to.scripts.map(s => s.scriptName), ['one', 'two', 'own'])
  assert.notEqual(copied.to.scripts[2].id, own[0].id)
  assert.equal(copied.from.scripts.length, 1, 'a copy leaves the source as it was')
  const moved = (await call('/api/regex/transfer', { method: 'POST', body: { from: `set-${set.id}`, to: 'card-c1', ids: [into.scripts[0].id], move: true } })).body
  assert.deepEqual(moved.from.scripts.map(s => s.scriptName), ['two', 'own'])
  assert.deepEqual((await app.store.getCard('c1')).regexScripts.map(s => [s.scriptName, s.id]), [['own', own[0].id], ['one', into.scripts[0].id]])
  // Into a new set, named.
  const out = (await call('/api/regex/transfer', { method: 'POST', body: { from: 'global', to: '', ids: [(await app.store.getRegex())[0].id], name: '摘录' } })).body
  assert.equal(out.to.set.name, '摘录')
  assert.equal(out.to.key, `set-${out.to.set.id}`)
  assert.equal((await call('/api/regex/transfer', { method: 'POST', body: { from: 'global', to: 'global', ids: [(await app.store.getRegex())[0].id] } })).status, 400)
  assert.equal((await call('/api/regex/transfer', { method: 'POST', body: { from: 'global', to: '', ids: [], name: 'x' } })).status, 400)
})

test('a card deleted comes off every set, which stays; a set deleted lets go of its cards and its talk', async t => {
  const { app, call } = await tavern(t)
  await app.store.saveCard({ ...normalizeCard({ name: '林雪' }), id: 'c1' })
  await app.store.saveCard({ ...normalizeCard({ name: '白芷' }), id: 'c2' })
  const set = (await call('/api/regex/sets', { method: 'POST', body: { name: '美化', scripts: [script('a')] } })).body
  await call(`/api/regex/sets/${set.id}/cards`, { method: 'PUT', body: { ids: ['c1', 'c2'] } })

  assert.equal((await call('/api/cards/c1', { method: 'DELETE' })).status, 200)
  const [kept] = (await call('/api/regex')).body.sets
  assert.deepEqual([kept.id, kept.cardIds, kept.scripts.length], [set.id, ['c2'], 1])
  assert.deepEqual(await chatScripts(app.store, { cardId: 'c1', presetId: null }), [], 'a chat left from the deleted card runs nothing of it')

  const gone = (await call(`/api/regex/sets/${set.id}`, { method: 'DELETE' })).body
  assert.deepEqual(gone.cardIds, ['c2'])
  assert.deepEqual((await call('/api/regex')).body.sets, [])
  assert.equal((await call(`/api/regex/sets/${set.id}`, { method: 'DELETE' })).status, 404)
})

test('a card exported with ?regex=sets carries its sets after its own scripts; without it, only its own', async t => {
  const { app, call } = await tavern(t)
  await app.store.saveCard({ ...normalizeCard({ name: '林雪' }), id: 'c1', regexScripts: cleanScripts([script('own')]) })
  const set = (await call('/api/regex/sets', { method: 'POST', body: { name: '美化', scripts: [script('mine', { runOnEdit: true })] } })).body
  await call(`/api/regex/sets/${set.id}/cards`, { method: 'PUT', body: { ids: ['c1'] } })

  const plain = (await call('/api/cards/c1/sillytavern')).body
  assert.deepEqual(plain.data.extensions.regex_scripts.map(s => s.scriptName), ['own'])
  const withSets = (await call('/api/cards/c1/sillytavern?regex=sets')).body
  assert.deepEqual(withSets.data.extensions.regex_scripts.map(s => s.scriptName), ['own', 'mine'])
  assert.equal(withSets.data.extensions.regex_scripts[1].runOnEdit, true)
  // Imported again (SillyTavern or here), they are the card's own; the same ids run once beside the set still on it.
  const again = normalizeCard(withSets)
  assert.deepEqual(again.regexScripts.map(s => s.scriptName), ['own', 'mine'])
  const sets = (await call('/api/regex')).body.sets
  assert.deepEqual(scriptsOf({ ...again, id: 'c1' }, null, [], sets).map(s => s.scriptName), ['own', 'mine'])
  assert.equal(sillyTavernCard(await app.store.getCard('c1')).data.extensions.regex_scripts.length, 1, 'the card itself is unchanged')
})

/** An OpenAI-compatible model that answers every turn with the same line; `seen` holds what each turn sent. */
async function fakeModel(t) {
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '夜深了。' }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen }
}

test('a turn sends what the sets on its card make of the input, and only on that card', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-regex-turn-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const model = await fakeModel(t)
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: model.url, apiKey: 'sk-test', models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off' })
  const snow = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', first_mes: '雪下了一整夜。' } })
  const other = normalizeCard({ spec: 'chara_card_v2', data: { name: '白芷', first_mes: '药炉还温着。' } })
  await store.saveCard(snow)
  await store.saveCard(other)
  // The card's own changes 苹果 to 梨; the set on it then 梨 to 香蕉: it runs after the card's own.
  snow.regexScripts = cleanScripts([{ scriptName: '卡自带', findRegex: '/苹果/g', replaceString: '梨', placement: [PLACEMENT.USER_INPUT], promptOnly: true }])
  await store.saveCard(snow)
  await store.updateRegexSets(() => [{ id: 's1', name: '换水果', description: '', cardIds: [snow.id], createdAt: '', scripts: cleanScripts([{ scriptName: '集', findRegex: '/梨/g', replaceString: '香蕉', placement: [PLACEMENT.USER_INPUT], promptOnly: true }]) }])

  const engine = createEngine(store, { proxy: null })
  const sent = async card => {
    const chat = await createChat(store, card.id)
    await engine.runTurn(chat.id, { parentId: activePath(chat).at(-1).id, input: '我想吃苹果' }, () => {})
    return JSON.stringify(model.seen.at(-1).messages)
  }
  const onSnow = await sent(snow)
  assert.match(onSnow, /我想吃香蕉/, 'the card\'s own, then the set on it')
  const onOther = await sent(other)
  assert.match(onOther, /我想吃苹果/, 'another card is left alone')
  assert.doesNotMatch(onOther, /香蕉/)
  const user = activePath(await store.getChat((await store.listChats(snow.id))[0].id)).find(node => node.role === 'user')
  assert.equal(user.text, '我想吃苹果', 'what is kept is what was written')
})
