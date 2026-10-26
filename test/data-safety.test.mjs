// Data kept safe when something goes wrong: lists written whole and never wiped on a bad read, a card UI's
// variables saved as the keys it changed, a card updated in place keeping its picture with the new data,
// exported cards and presets checked on import, and regex scripts the editor can tell apart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { createStore, readJsonFile } from '../server/store.mjs'
import { createSaves } from '../server/saves.mjs'
import { createPromptLibrary } from '../server/prompts.mjs'
import { writeCardPng } from '../server/cards.mjs'
import { normalizeScripts, withUniqueIds } from '../web/shared/regex.js'
import { patchVars } from '../web/shared/vars.js'

// A 1×1 PNG.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

async function tempDir(t, name) {
  const dir = await mkdtemp(path.join(tmpdir(), name))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function tavern(t) {
  const dataRoot = await tempDir(t, 'tavern-safety-')
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.arrayBuffer() }
  }
  const upload = (filename, bytes, extra = {}) => call('/api/cards/import', { method: 'POST', body: { filename, data: Buffer.from(bytes).toString('base64'), ...extra } })
  return { dataRoot, call, upload }
}

test('readJsonFile: none is the fallback, a damaged file is moved aside, any other read error is thrown', async t => {
  const dir = await tempDir(t, 'tavern-readjson-')
  const file = path.join(dir, 'list.json')
  assert.deepEqual(await readJsonFile(file, { none: true }), { none: true })
  await writeFile(file, '{"saves": [{"id": "a"}')
  assert.equal(await readJsonFile(file, null), null)
  const names = await readdir(dir)
  assert.equal(names.length, 1)
  assert.match(names[0], /^list\.json\.bad-\d+$/, 'kept to recover by hand')
  await mkdir(file)
  await assert.rejects(readJsonFile(file, null), 'a read that fails is not read as empty')
})

test('存档: a damaged list is moved aside, not silently overwritten; the new list is written whole', async t => {
  const root = await tempDir(t, 'tavern-saves-')
  const store = createStore(root)
  await store.init()
  await store.saveCard({ id: 'card1', name: '小雨' })
  await store.saveChat({ id: 'chat1', cardId: 'card1', title: '雨夜', nodes: { root: { id: 'root', role: 'assistant', text: '开场', createdAt: '2026-10-01T00:00:00.000Z' } } })
  const saves = createSaves(store)
  const listFile = path.join(store.dirs.cards, 'card1', 'saves.json')
  await writeFile(listFile, '{"saves": [{"id": "s1", "slot": "1"')
  const { saves: after } = await saves.put('card1', '2', { chatId: 'chat1', nodeId: 'root', line: 0 })
  assert.deepEqual(after.map(save => save.slot), ['2'])
  assert.deepEqual(JSON.parse(await readFile(listFile, 'utf8')).saves.map(save => save.slot), ['2'])
  const kept = (await readdir(path.join(store.dirs.cards, 'card1'))).filter(name => name.startsWith('saves.json.bad-'))
  assert.equal(kept.length, 1)
  assert.match(await readFile(path.join(store.dirs.cards, 'card1', kept[0]), 'utf8'), /"s1"/)
})

test('prompt library: seeded only when there is none; a read that fails leaves the file alone and is tried again', async t => {
  const root = await tempDir(t, 'tavern-library-')
  const store = createStore(root)
  await store.init()
  const file = path.join(root, 'prompt-library.json')
  await mkdir(file)
  const library = createPromptLibrary(store)
  await assert.rejects(library.list('card1'))
  assert.equal((await readdir(root)).includes('prompt-library.json'), true, 'not written over')
  await rm(file, { recursive: true })
  await writeFile(file, JSON.stringify({ entries: [{ id: 'e1', cardId: 'card1', prompt: '手写的提示词', starred: true }] }))
  const [one, two] = await Promise.all([library.list('card1'), library.list('card1')])
  assert.deepEqual([one.map(e => e.prompt), two.map(e => e.prompt)], [['手写的提示词'], ['手写的提示词']], 'the next read works and shares one load')
})

test('patchVars: the keys set and unset, every other key as saved, never a prototype', () => {
  const saved = { 天数: 3, 好感: { 小雨: 10 }, 旧: true }
  // As a frame's message arrives (JSON): "__proto__" an own key, not the object's prototype.
  const set = JSON.parse('{"好感": {"小雨": 12}, "新": "x", "__proto__": {"polluted": 1}}')
  const next = patchVars(saved, { set, unset: ['旧', 'constructor'] })
  assert.deepEqual(next, { 天数: 3, 好感: { 小雨: 12 }, 新: 'x' })
  assert.equal({}.polluted, undefined)
  assert.deepEqual(saved, { 天数: 3, 好感: { 小雨: 10 }, 旧: true }, 'the saved object is left as it was')
  assert.deepEqual(patchVars(null, { set: 'nonsense' }), {})
})

test('a card UI saves the global and chat variable keys it changed, over what was saved since it opened', async t => {
  const { call, upload } = await tavern(t)
  // A turn's template wrote 天数 after the UI opened with an empty bucket; the UI then sets 金币.
  await call('/api/settings', { method: 'PUT', body: { globalVars: { 天数: 5 } } })
  const saved = await call('/api/settings', { method: 'PUT', body: { globalVarsPatch: { set: { 金币: 100 }, unset: [] } } })
  assert.deepEqual(saved.body.globalVars, { 天数: 5, 金币: 100 })
  assert.deepEqual((await call('/api/settings', { method: 'PUT', body: { globalVarsPatch: { set: {}, unset: ['天数'] } } })).body.globalVars, { 金币: 100 })

  const card = (await upload('c.json', JSON.stringify({ spec: 'chara_card_v2', data: { name: '小雨', first_mes: '你好' } }))).body
  const chat = (await call('/api/chats', { method: 'POST', body: { cardId: card.id } })).body
  const vars = body => call(`/api/chats/${chat.id}/frame-vars`, { method: 'PUT', body })
  await vars({ set: { 背包: ['剑'] } })
  assert.deepEqual((await vars({ set: { 地图: 'A' }, unset: [] })).body.vars, { 背包: ['剑'], 地图: 'A' }, 'two UIs keep each other\'s keys')
  assert.deepEqual((await vars({ vars: { 只有这个: 1 } })).body.vars, { 只有这个: 1 }, 'a whole value still replaces, as before')
})

test('a card updated in place from JSON keeps its picture, with the new version\'s data in it for exports', async t => {
  const { call, upload } = await tavern(t)
  const version = (n, scripts) => ({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: `小雨-v${n}`, first_mes: '你好', character_version: String(n), extensions: { tavern_helper: { scripts } } },
  })
  const v1 = (await upload('c.png', writeCardPng(PNG_1PX, version(1, [{ name: '旧脚本' }])))).body
  const v2 = (await upload('c.json', JSON.stringify(version(2, [{ name: '新脚本一' }, { name: '新脚本二' }])), { replace: v1.id })).body
  assert.equal(v2.hasAvatar, true)
  assert.equal(v2.helperScripts, 2)
  const exported = (await call(`/api/cards/${v1.id}/sillytavern`)).body
  const data = exported.data ?? exported
  assert.equal(data.character_version, '2')
  assert.deepEqual(data.extensions.tavern_helper.scripts.map(s => s.name), ['新脚本一', '新脚本二'])
  const picture = await call(`/api/cards/${v1.id}/avatar`)
  assert.equal(picture.status, 200)
  assert.equal(Buffer.from(picture.body).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'still the picture')
})

test('this app\'s own card and preset files are checked on import: one missing fields no longer breaks the lists', async t => {
  const { call, upload } = await tavern(t)
  const card = await upload('own.json', JSON.stringify({ format: 'agent-tavern-card', card: { name: '手改的卡', book: { entries: [{ content: 7 }] } } }))
  assert.equal(card.status, 200)
  const cards = (await call('/api/cards')).body
  assert.deepEqual(cards.map(c => c.name), ['手改的卡'])
  assert.equal(cards[0].bookEntries, 1)
  assert.equal((await call(`/api/cards/${card.body.id}`)).status, 200)

  const presetFile = { format: 'agent-tavern-preset', preset: { name: '缺字段的预设', builtin: true, prompts: [{ id: 'main', content: '写' }] } }
  const preset = await call('/api/presets/import', { method: 'POST', body: { filename: 'p.json', data: Buffer.from(JSON.stringify(presetFile)).toString('base64') } })
  assert.equal(preset.status, 200)
  const presets = (await call('/api/presets')).body
  assert.equal(presets.some(p => p.name === '缺字段的预设' && p.regexScripts === 0), true)
  const detail = (await call(`/api/presets/${preset.body.id}`)).body
  assert.deepEqual(detail.regexScriptList, [])
})

test('a card\'s regex scripts without an id, or with one repeated, get ids of their own, the same each time', async t => {
  const list = normalizeScripts([{ findRegex: 'a' }, { findRegex: 'b' }, { id: 'x', findRegex: 'c' }, { id: 'x', findRegex: 'd' }, { id: 'script-2', findRegex: 'e' }])
  const ids = withUniqueIds(list).map(s => s.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids[2], 'x', 'an id of its own is kept')
  assert.equal(ids[4], 'script-2', 'even when it looks like a made-up one')
  assert.deepEqual(withUniqueIds(list).map(s => s.id), ids, 'the same list, the same ids')
  assert.deepEqual(withUniqueIds(withUniqueIds(list)).map(s => s.id), ids)

  // A card imported with two scripts without ids: the editor gets two it can tell apart.
  const { call, upload } = await tavern(t)
  const scripts = [{ scriptName: '一', findRegex: '/a/g' }, { scriptName: '二', findRegex: '/b/g' }]
  const card = (await upload('c.json', JSON.stringify({ spec: 'chara_card_v2', data: { name: '两条正则', extensions: { regex_scripts: scripts } } }))).body
  const listed = (await call(`/api/cards/${card.id}`)).body.regexScriptList
  assert.deepEqual(listed.map(s => s.scriptName), ['一', '二'])
  assert.equal(new Set(listed.map(s => s.id)).size, 2)
})
