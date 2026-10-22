// 存档 / 读档 (server/saves.mjs): slots per card, a quick save, the last ten
// auto saves; loading shows the saved reply, later turns rolled back and kept.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
const picture = `data:image/jpeg;base64,${JPEG.toString('base64')}`

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-saves-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  return { base, call }
}

const card = { spec: 'chara_card_v2', data: { name: '林青禾', description: '茶馆掌柜', first_mes: '欢迎光临。' } }
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n')
const said = mes => ({ name: '你', is_user: true, is_system: false, send_date: 'October 22, 2026 1:00pm', mes, extra: {} })
const reply = mes => ({ name: '林青禾', is_user: false, is_system: false, send_date: 'October 22, 2026 1:01pm', mes, extra: {} })

test('saves: slots, quick and auto saves per card; loading rolls the chat back to the saved reply', async t => {
  const { base, call } = await tavern(t)
  const { id: cardId } = (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(card)).toString('base64') } })).body
  const text = lines([
    { user_name: '你', character_name: '林青禾', create_date: '2026-10-22@13h00m00s', chat_metadata: {} },
    reply('雨下了一下午。'),
    said('我进门。'),
    reply('「来了？」她笑了笑。'),
    said('我坐下。'),
    reply('「喝什么？」'),
  ])
  const chat = (await call('/api/chats/import-sillytavern', { method: 'POST', body: { cardId, filename: 'teahouse.jsonl', text } })).body
  const replies = chat.path.filter(node => node.role === 'assistant')
  assert.equal(replies.length, 3)
  const [, second, third] = replies

  assert.deepEqual((await call(`/api/cards/${cardId}/saves`)).body, { saves: [], slots: 18 })
  // Only a reply of a chat on this card.
  assert.equal((await call(`/api/cards/${cardId}/saves/slot/1`, { method: 'PUT', body: { chatId: chat.id, nodeId: chat.path.find(node => node.role === 'user').id } })).status, 400)
  assert.equal((await call(`/api/cards/${cardId}/saves/slot/1`, { method: 'PUT', body: { chatId: 'nope', nodeId: second.id } })).status, 400)
  assert.equal((await call(`/api/cards/${cardId}/saves/slot/19`, { method: 'PUT', body: { chatId: chat.id, nodeId: second.id } })).status, 404)

  let view = (await call(`/api/cards/${cardId}/saves/slot/1`, { method: 'PUT', body: { chatId: chat.id, nodeId: second.id, line: 1, place: '茶馆', time: '午后', text: '林青禾：「来了？」', image: picture } })).body
  const first = view.saves[0]
  assert.deepEqual({ slot: first.slot, line: first.line, place: first.place, gone: first.gone }, { slot: '1', line: 1, place: '茶馆', gone: false })
  assert.match(first.picture, /^s[0-9a-z]+\.jpg$/)
  assert.equal((await fetch(`${base}/api/saves/${cardId}/${first.picture}`)).headers.get('content-type'), 'image/jpeg')
  // The same slot again: the old save and its picture go.
  view = (await call(`/api/cards/${cardId}/saves/slot/1`, { method: 'PUT', body: { chatId: chat.id, nodeId: second.id, line: 2, image: picture } })).body
  assert.equal(view.saves.length, 1)
  assert.equal(view.saves[0].line, 2)
  assert.equal((await fetch(`${base}/api/saves/${cardId}/${first.picture}`)).status, 404)
  view = (await call(`/api/cards/${cardId}/saves/${view.saves[0].id}/note`, { method: 'PUT', body: { note: '选了留下' } })).body
  assert.equal(view.saves[0].note, '选了留下')

  // Auto saves: the last ten.
  for (let i = 0; i < 12; i++) view = (await call(`/api/cards/${cardId}/saves/auto`, { method: 'POST', body: { chatId: chat.id, nodeId: third.id, line: i } })).body
  assert.equal(view.saves.filter(save => save.slot === 'auto').length, 10)
  assert.equal(view.saves.filter(save => save.slot === 'auto').at(-1).line, 2)

  // Loading slot 1: the second reply is on screen again; the third turn is folded, not gone.
  const slot = view.saves.find(save => save.slot === '1')
  const loaded = (await call(`/api/cards/${cardId}/saves/${slot.id}/load`, { method: 'POST' })).body
  assert.equal(loaded.save.id, slot.id)
  assert.equal(loaded.chat.path.at(-1).id, second.id)
  assert.equal(loaded.chat.folded, 1)
  // The latest auto save brings the third back.
  const latest = view.saves.find(save => save.slot === 'auto')
  const again = (await call(`/api/cards/${cardId}/saves/${latest.id}/load`, { method: 'POST' })).body
  assert.equal(again.chat.path.at(-1).id, third.id)

  // A deleted chat: its saves say so, and cannot be loaded.
  await call(`/api/chats/${chat.id}`, { method: 'DELETE' })
  view = (await call(`/api/cards/${cardId}/saves`)).body
  assert.ok(view.saves.every(save => save.gone))
  assert.equal((await call(`/api/cards/${cardId}/saves/${slot.id}/load`, { method: 'POST' })).status, 404)
  view = (await call(`/api/cards/${cardId}/saves/${slot.id}`, { method: 'DELETE' })).body
  assert.equal(view.saves.some(save => save.id === slot.id), false)
})
