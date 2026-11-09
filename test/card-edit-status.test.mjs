// 修改角色卡 → 状态栏: the bar's part of 检查这张卡 read on its own (GET …/check/status), and 对话修改 changing the
// layout: what the model is shown, how its <status_bar> is read, and the proposal taken in and back over HTTP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { STATUS_TUNE } from '../server/forge/check.mjs'
import { STATUS_TARGET, editRequest, readEdit } from '../server/forge/edit.mjs'

const BOOK = { entries: [{ id: 0, comment: '[InitVar]初始变量', content: '好感: 10\n体力: 50', keys: [], constant: true, enabled: false }] }
const BAR = { title: '小雨', theme: 'paper', fields: [{ path: '好感', label: '好感', show: 'meter', min: 0, max: 100 }] }
const cardWith = (extra = {}) => normalizeCard({ spec: 'chara_card_v2', data: { name: '小雨', first_mes: '你好', character_book: BOOK, ...extra } })
const withBar = (bar = BAR) => Object.assign(cardWith(), { statusBar: structuredClone(bar) })

const NEW_BAR = '{"fields": [{"path": "好感", "label": "好感", "show": "meter", "min": 0, "max": 100}, {"path": "体力", "label": "体力", "show": "number"}]}'
const ANSWER = `<reply>把体力加进了状态栏。</reply>\n<status_bar>${NEW_BAR}</status_bar>`

test('the request shows the layout and the variables; the format says how to write one', () => {
  const card = withBar()
  const { request } = editRequest(card, { text: '体力也显示出来', state: { 好感: 10, 体力: 50 } })
  const content = request.messages[0].content
  assert.match(content, /<status_bar>\{"title":"小雨","theme":"paper"/)
  assert.match(content, /<variables>\n开局时的变量：\n好感: 10\n体力: 50\n<\/variables>/)
  assert.match(request.system, /<status_bar>\{"title": "标题，可空"/)
  assert.match(request.system, /theme 可选：plain、paper/)
  assert.doesNotMatch(request.system, /检查这张卡 → 调整状态栏/, 'no longer sent elsewhere for new variables')
  // Kept to the bar.
  const aimed = editRequest(card, { text: '换个配色', target: STATUS_TARGET }).request.messages[0].content
  assert.match(aimed, /只改 <status_bar> 这一处/)
  // A card with neither: said so, no variables block.
  const plain = editRequest(normalizeCard({ spec: 'chara_card_v2', data: { name: '甲', first_mes: '嗨' } }), { text: '改改' }).request.messages[0].content
  assert.match(plain, /（这张卡还没有状态栏布局）/)
  assert.doesNotMatch(plain, /<variables>/)
})

test('a <status_bar> in the answer is a layout change; the look it says nothing of stays', () => {
  const card = withBar()
  const { reply, changes } = readEdit(ANSWER, card)
  assert.equal(reply, '把体力加进了状态栏。')
  assert.equal(changes.length, 1)
  const [change] = changes
  assert.deepEqual([change.id, change.kind], ['statusBar', 'statusBar'])
  assert.equal(change.spec.theme, 'paper', 'not written: kept')
  assert.deepEqual(change.spec.fields.map(field => field.path), ['好感', '体力'])
  assert.match(change.before, /好感 \(好感\): meter/)
  assert.match(change.after, /体力 \(体力\): number/)
  assert.equal(change.scripts, undefined, 'the card had a bar: its SillyTavern copy only if it had one')

  // Kept to the bar, the rest of the answer is left out; kept elsewhere, the bar is.
  const both = `${ANSWER}\n<field name="scenario">雨夜</field>`
  assert.deepEqual(readEdit(both, card, { target: STATUS_TARGET }).changes.map(change => change.id), ['statusBar'])
  assert.deepEqual(readEdit(both, card, { target: 'field:scenario' }).changes.map(change => change.id), ['field:scenario'])
  // The same layout again is no change; a card that draws its own bar gets none.
  assert.deepEqual(readEdit(`<status_bar>${JSON.stringify(BAR)}</status_bar>`, card).changes, [])
  const own = cardWith({ extensions: { regex_scripts: [{ id: 'x', scriptName: '状态栏美化', findRegex: '<StatusPlaceHolderImpl/>', replaceString: '<div>bar</div>', placement: [2] }] } })
  assert.deepEqual(readEdit(ANSWER, own).changes, [])
  // A card with no layout yet: a new one, with its SillyTavern copy.
  const fresh = readEdit(ANSWER, cardWith()).changes[0]
  assert.equal(fresh.before, '')
  assert.equal(fresh.scripts, true)
})

async function fakeModel() {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

async function tavern(t, card) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-edit-status-'))
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
  await app.store.saveCard(card)
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `${model.base}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  const ask = async (url, body) => {
    let session = (await call(url, { method: 'POST', body })).body
    for (let i = 0; i < 200 && session.job; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      session = (await call(url)).body
    }
    return session
  }
  return { app, call, ask, model, card: () => app.store.getCard(card.id) }
}

test('…/check/status: the bar to adjust, its preview, what is wrong with it, and what was taken in, to undo', async t => {
  const broken = withBar({ ...BAR, fields: [...BAR.fields, { path: '状态.体力', label: '体力', show: 'number' }] })
  const { call, card } = await tavern(t, broken)
  const url = `/api/cards/${broken.id}/check/status`
  const seen = (await call(url)).body
  assert.equal(seen.statusTune.id, STATUS_TUNE)
  assert.deepEqual(seen.state, { 好感: 10, 体力: 50 })
  assert.equal(seen.ownBar, false)
  assert.deepEqual(seen.findings.map(item => item.id), ['status-path-missing:card'])
  assert.deepEqual(seen.records, [])

  // 修好 goes in as in 检查这张卡, and shows there as taken in.
  const fixed = await call(`/api/cards/${broken.id}/check/apply`, { method: 'POST', body: { items: [{ id: 'status-path-missing:card' }] } })
  assert.equal(fixed.status, 200)
  assert.deepEqual((await card()).statusBar.fields.map(field => field.path), ['好感', '体力'])
  const after = (await call(url)).body
  assert.deepEqual(after.findings, [])
  assert.equal(after.records.length, 1)

  // 调整样式 then 撤销, from here.
  const [change] = after.statusTune.changes
  const palette = { bg: '#101820', ink: '#f0f0f0', accent: '#d08030' }
  await call(`/api/cards/${broken.id}/check/apply`, { method: 'POST', body: { items: [{ id: STATUS_TUNE, edits: { [change.id]: { spec: { ...change.spec, theme: undefined, palette } } } }] } })
  const tuned = (await call(url)).body
  assert.deepEqual(tuned.statusBar.palette, palette)
  assert.equal(tuned.records.at(-1).title, '调整状态栏')
  const undone = await call(`/api/cards/${broken.id}/check/undo`, { method: 'POST', body: { record: tuned.records.at(-1).id } })
  assert.equal(undone.status, 200)
  assert.equal((await card()).statusBar.theme, 'paper')
  assert.equal((await call(url)).body.records.length, 1)

  // No variables: nothing to adjust.
  const none = normalizeCard({ spec: 'chara_card_v2', data: { name: '甲', first_mes: '嗨' } })
  const { call: other } = await tavern(t, none)
  const empty = (await other(`/api/cards/${none.id}/check/status`)).body
  assert.equal(empty.statusTune, null)
  assert.equal(empty.statusBar, null)
})

test('对话修改 kept to the status bar: proposed, taken in with its SillyTavern copy, and undone', async t => {
  const { call, ask, model, card } = await tavern(t, cardWith())
  const { id } = await card()
  const url = `/api/cards/${id}/assistant`
  const session = await ask(url, { text: '体力也显示出来', target: STATUS_TARGET })
  assert.equal(session.error, null)
  assert.equal(session.turns[0].user.target, STATUS_TARGET, 'a target the server takes')
  const [change] = session.turns[0].assistant.changes
  assert.equal(change.kind, 'statusBar')
  const sent = model.seen[0].messages.at(-1).content
  assert.match(sent, /<variables>\n开局时的变量：\n好感: 10\n体力: 50/)
  assert.match(sent, /只改 <status_bar> 这一处/)

  const done = (await call(`${url}/apply`, { method: 'POST', body: { ids: ['statusBar'] } })).body
  assert.deepEqual([done.applied, done.prefix, done.session.undo], [1, false, true])
  const saved = await card()
  assert.deepEqual(saved.statusBar.fields.map(field => field.path), ['好感', '体力'])
  assert.ok(saved.regexScripts.some(script => script.id === 'cicatavern-status-bar'), 'the SillyTavern copy goes with a new bar')

  const undone = await call(`${url}/undo`, { method: 'POST' })
  assert.equal(undone.status, 200)
  const back = await card()
  assert.equal(back.statusBar ?? null, null)
  assert.equal((back.regexScripts ?? []).some(script => script.id === 'cicatavern-status-bar'), false)
})
