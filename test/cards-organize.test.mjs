import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanGroup } from '../server/cards.mjs'
import { createApp } from '../server/http.mjs'

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', '示例-小雨.json')

test('cards go into groups and the archive, and come back; renaming and dissolving move whole groups', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-groups-'))
  const app = createApp({ dataRoot: root, proxy: 'off' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
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
  const list = async () => Object.fromEntries((await (await fetch(`${base}/api/cards`)).json()).map(c => [c.name, [c.group, c.archived]]))

  const rain = await importAs('小雨')
  const snow = await importAs('小雪')
  assert.deepEqual(await list(), { 小雨: ['', false], 小雪: ['', false] })

  // Into a group (names are tidied), then into the archive and back.
  assert.equal((await send('PUT', `/api/cards/${rain.id}/organize`, { group: '  日常   向 ' })).group, '日常 向')
  await send('PUT', `/api/cards/${snow.id}/organize`, { group: '日常 向' })
  await send('PUT', `/api/cards/${snow.id}/organize`, { archived: true })
  assert.deepEqual(await list(), { 小雨: ['日常 向', false], 小雪: ['日常 向', true] })
  await send('PUT', `/api/cards/${snow.id}/organize`, { archived: false })
  assert.deepEqual((await list()).小雪, ['日常 向', false])

  // A new version found by name lands in the same group; an in-place update keeps group and archive.
  const v2 = await importAs('小雨-v2')
  assert.equal(v2.group, '日常 向')
  await send('PUT', `/api/cards/${rain.id}/organize`, { archived: true })
  const replaced = await importAs('小雨-v3', { replace: rain.id })
  assert.deepEqual([replaced.id, replaced.group, replaced.archived], [rain.id, '日常 向', true])

  // Rename the group: all its cards move; dissolve it: they go back to no group.
  assert.deepEqual(await send('POST', '/api/cards/groups', { from: '日常 向', to: '治愈' }), { moved: 3 })
  assert.deepEqual(new Set(Object.values(await list()).map(([group]) => group)), new Set(['治愈']))
  assert.deepEqual(await send('POST', '/api/cards/groups', { from: '治愈', to: '' }), { moved: 3 })
  assert.deepEqual(new Set(Object.values(await list()).map(([group]) => group)), new Set(['']))
  await assert.rejects(send('POST', '/api/cards/groups', { from: '', to: 'x' }), /哪个分组/)
  assert.equal(cleanGroup('a'.repeat(50)).length, 30)
})
