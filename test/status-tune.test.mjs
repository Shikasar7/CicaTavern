// 调整状态栏 in 检查这张卡: the bar by hand, with no model and nothing found about it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { STATUS_TUNE, statusTuning } from '../server/forge/check.mjs'

const BOOK = { entries: [{ id: 0, comment: '[InitVar]初始变量', content: '好感: 10\n体力: 50', keys: [], constant: true, enabled: false }] }
const BAR = { title: '小雨', theme: 'paper', fields: [{ path: '好感', label: '好感', show: 'meter' }] }
const cardWith = extra => normalizeCard({ spec: 'chara_card_v2', data: { name: '小雨', first_mes: '你好', character_book: BOOK, ...extra } })

async function app(t, card) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-tune-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const store = createStore(dataRoot)
  await store.init()
  await store.saveSettings({ subscription: 'off' })
  await store.saveCard(card)
  const server = await createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const listening = await server.listen({ port: 0 })
  t.after(() => {
    server.network.stop()
    listening.closeAllConnections?.()
    listening.close()
  })
  const base = `http://127.0.0.1:${listening.address().port}/api/cards/${card.id}/check`
  const call = async (where = '', method = 'GET', body) => {
    const res = await fetch(`${base}${where}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, ...(await res.json()) }
  }
  const api = async (where, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${listening.address().port}/api${where}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return res.json()
  }
  return { call, api, id: card.id, card: () => store.getCard(card.id) }
}

const withBar = () => {
  const card = cardWith({})
  card.statusBar = structuredClone(BAR)
  return card
}

test('a bar with nothing wrong can be adjusted, saved and taken back', async t => {
  const { call, card } = await app(t, withBar())
  const seen = await call()
  assert.equal(seen.statusTune.id, STATUS_TUNE)
  assert.equal(seen.findings.some(item => item.id === STATUS_TUNE), false, 'no finding: nothing is wrong')
  assert.ok(seen.statusTune.fields.some(field => field.path === '体力'), 'what can be added')
  const [change] = seen.statusTune.changes
  const palette = { bg: '#101820', ink: '#f0f0f0', accent: '#d08030' }
  const spec = { ...change.spec, theme: undefined, palette }
  const saved = await call('/apply', 'POST', { items: [{ id: STATUS_TUNE, edits: { [change.id]: { spec } } }] })
  assert.equal(saved.status, 200)
  assert.deepEqual((await card()).statusBar.palette, palette)
  assert.equal((await card()).statusBar.theme, undefined)
  assert.equal(saved.check.records.at(-1).title, '调整状态栏')
  assert.deepEqual(saved.check.statusTune.changes[0].spec.palette, palette, 'the editor opens on the bar as saved')

  const undone = await call('/undo', 'POST', { record: saved.check.records.at(-1).id })
  assert.equal(undone.status, 200)
  assert.equal((await card()).statusBar.theme, 'paper')
})

test('a bar taken in that shows variables an older chat lacks says so', async t => {
  const { call, api, id } = await app(t, withBar())
  // A chat from before the card had 体力, and one started after.
  const old = await api('/chats', 'POST', { cardId: id })
  await api(`/chats/${old.id}/state`, 'PUT', { state: { 好感: 12 } })
  await api('/chats', 'POST', { cardId: id })
  const [change] = (await call()).statusTune.changes
  const fields = [...change.spec.fields, { path: '体力', label: '体力', show: 'number' }]
  const added = await call('/apply', 'POST', { items: [{ id: STATUS_TUNE, edits: { [change.id]: { spec: { ...change.spec, fields } } } }] })
  assert.equal(added.status, 200)
  assert.deepEqual(added.chatGaps, { chats: 1, labels: ['体力'] })
  const [again] = added.check.statusTune.changes
  const restyled = await call('/apply', 'POST', { items: [{ id: STATUS_TUNE, edits: { [again.id]: { spec: { ...again.spec, theme: 'plain' } } } }] })
  assert.equal(restyled.chatGaps, null, 'only a look changed: nothing new to read')
})

test('a page of the bar with nothing in this chat says so rather than staying blank', async () => {
  // web/status.js loads by the page's own paths, so it is read rather than run (the page itself was checked by hand).
  const source = await readFile(new URL('../web/status.js', import.meta.url), 'utf8')
  const opened = source.slice(source.indexOf('const open = page =>'), source.indexOf('const tabs = '))
  assert.ok(opened.includes('const shown = statusGroups(onPage(spec, page, pages), state, previous)'), 'the page drawn from what it has')
  assert.ok(opened.includes("if (!shown.length) body.replaceChildren(el('p', { class: 'status-empty', text: t`这一页要显示的变量现在还没有` }))"), 'nothing on it: said')
})

test('nothing changed, or nothing left to show, is not saved', async t => {
  const { call, card } = await app(t, withBar())
  const [change] = (await call()).statusTune.changes
  assert.equal((await call('/apply', 'POST', { items: [{ id: STATUS_TUNE, edits: { [change.id]: { spec: change.spec } } }] })).status, 400)
  assert.equal((await call('/apply', 'POST', { items: [{ id: STATUS_TUNE, edits: { [change.id]: { spec: { ...change.spec, fields: [] } } } }] })).status, 400)
  assert.equal((await card()).statusBar.theme, 'paper')
})

test('a card with variables and no bar gets one laid out to start from, with its SillyTavern copy', async t => {
  const { call, card } = await app(t, cardWith({}))
  const seen = await call()
  const [change] = seen.statusTune.changes
  assert.equal(change.before, '')
  assert.equal(change.scripts, true)
  assert.equal((await call('/apply', 'POST', { items: [{ id: STATUS_TUNE }] })).status, 200)
  const saved = await card()
  assert.ok(saved.statusBar.fields.length >= 2)
  assert.ok(saved.regexScripts.some(script => script.id.startsWith('cicatavern-status-bar')))
})

test('no bar to adjust: no variables, or the card draws its own', () => {
  assert.equal(statusTuning(normalizeCard({ spec: 'chara_card_v2', data: { name: '小雨', first_mes: '你好' } })), null)
  const own = cardWith({})
  own.regexScripts = [{ id: 'x', scriptName: '美化状态栏', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '<div></div>', placement: [2], disabled: false }]
  assert.equal(statusTuning(own), null)
  own.statusBar = structuredClone(BAR)
  assert.ok(statusTuning(own), 'a layout it has can still be adjusted')
})
