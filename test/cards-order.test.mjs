import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { orderCards } from '../server/cards.mjs'
import { createApp } from '../server/http.mjs'

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', '示例-小雨.json')

test('cards not yet ordered come first, newest on top; the rest keep the order given', () => {
  const cards = ['d', 'c', 'b', 'a'].map(id => ({ id }))
  assert.deepEqual(orderCards(cards, ['a', 'x', 'c']).map(card => card.id), ['d', 'b', 'a', 'c'])
  assert.deepEqual(orderCards(cards, []).map(card => card.id), ['d', 'c', 'b', 'a'])
})

test('置顶, 收藏 and the dragged order are kept by the server, across a restart', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-order-'))
  let app = createApp({ dataRoot: root, proxy: 'off' })
  let server = await app.listen({ port: 0 })
  t.after(async () => {
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  let base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const send = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers, body: JSON.stringify(body) })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error)
    return json
  }
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'))
  const importAs = (name, extra = {}) => {
    const card = structuredClone(raw)
    ;(card.data ?? card).name = name
    return send('POST', '/api/cards/import', { filename: 'c.json', data: Buffer.from(JSON.stringify(card)).toString('base64'), ...extra })
  }
  const list = async () => (await (await fetch(`${base}/api/cards`)).json())
  const names = async () => (await list()).map(card => card.name)

  const a = await importAs('甲')
  const b = await importAs('乙')
  const c = await importAs('丙')
  // Before any dragging: newest first, as always; nothing pinned or starred.
  assert.deepEqual(await names(), ['丙', '乙', '甲'])
  assert.deepEqual((await list()).map(card => [card.pinned, card.favorite]), [[false, false], [false, false], [false, false]])

  // Pin and star (and only that changes); unpin again.
  assert.equal((await send('PUT', `/api/cards/${a.id}/organize`, { pinned: true })).pinned, true)
  const starred = await send('PUT', `/api/cards/${b.id}/organize`, { favorite: true })
  assert.deepEqual([starred.favorite, starred.pinned, starred.group], [true, false, ''])
  await send('PUT', `/api/cards/${c.id}/organize`, { pinned: true, favorite: true })
  await send('PUT', `/api/cards/${c.id}/organize`, { pinned: false })
  assert.deepEqual(Object.fromEntries((await list()).map(card => [card.name, [card.pinned, card.favorite]])), { 甲: [true, false], 乙: [false, true], 丙: [false, true] })

  // Drag: the order given is the order listed; unknown ids are dropped, a list is required.
  assert.deepEqual((await send('PUT', '/api/cards/order', { ids: [a.id, 'gone', c.id, b.id, a.id] })).ids, [a.id, c.id, b.id])
  assert.deepEqual(await names(), ['甲', '丙', '乙'])
  await assert.rejects(send('PUT', '/api/cards/order', { ids: 'x' }), /怎么排/)

  // A card imported later goes on top until it is dragged somewhere.
  const d = await importAs('丁')
  assert.deepEqual(await names(), ['丁', '甲', '丙', '乙'])
  // A new version in place of a card keeps its pin, star and place.
  const updated = await importAs('甲', { replace: a.id })
  assert.deepEqual([updated.pinned, updated.favorite], [true, false])
  assert.deepEqual(await names(), ['丁', '甲', '丙', '乙'])
  // A card left out of a later order (deleted in between) does not hold the others back.
  await send('DELETE', `/api/cards/${c.id}`)
  assert.deepEqual(await names(), ['丁', '甲', '乙'])

  // A restart reads it all back from disk.
  server.close()
  app = createApp({ dataRoot: root, proxy: 'off' })
  server = await app.listen({ port: 0 })
  base = `http://127.0.0.1:${server.address().port}`
  assert.deepEqual((await list()).map(card => [card.name, card.pinned, card.favorite]), [['丁', false, false], ['甲', true, false], ['乙', false, true]])
  assert.equal(d.pinned, false)
})
