// Card files may be big (a large MVU card's picture carries the card twice, as V2 and V3): their import takes more
// than other requests, which keep the smaller limit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'

test('a card file past the usual request size imports; other requests keep the limit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-upload-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network?.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body })

  // 32 MB of card: 43 MB as base64, past the 40 MB the other requests take.
  const lore = '江湖'.repeat(5_600_000)
  const card = { spec: 'chara_card_v2', data: { name: '大卡', description: 'x', first_mes: '开场', character_book: { entries: [{ keys: ['江湖'], content: lore, comment: '长条目' }] } } }
  const data = Buffer.from(JSON.stringify(card)).toString('base64')
  assert.ok(data.length > 40 * 1024 * 1024)
  const imported = await send('/api/cards/import', JSON.stringify({ filename: 'big.json', data }))
  assert.equal(imported.status, 200)
  assert.equal((await imported.json()).name, '大卡')

  const settings = await send('/api/settings', JSON.stringify({ note: 'x'.repeat(41 * 1024 * 1024) }), 'PUT')
  assert.equal(settings.status, 413)
})
