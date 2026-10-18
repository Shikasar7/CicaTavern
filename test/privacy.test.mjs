// 隐私与网络: the public builds make no connection nobody configured (web font,
// update check) before the notice is confirmed, and each one has a switch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { featuresOf } from '../server/edition.mjs'
import { createApp } from '../server/http.mjs'

async function fakeFeed(t) {
  const hits = { latest: 0 }
  const server = http.createServer((req, res) => {
    hits.latest++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ tag_name: 'v9.9.9', body: '', assets: [] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { feed: `http://127.0.0.1:${server.address().port}/repos/Shikasar7/CicaTavern`, hits }
}

async function tavern(t, edition, feed) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-privacy-'))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-privacy-app-'))
  const app = createApp({ dataRoot, proxy: 'off', edition, update: { root, feed } })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const page = async () => (await fetch(`${base}/`)).text()
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return res.json()
  }
  return { app, page, call }
}

test('the public builds ask first; this machine\'s own install does not', () => {
  assert.deepEqual(['personal', 'release', 'android'].map(e => featuresOf(e).privacyNotice), [false, true, true])
})

test('release, first start: no web font and no update check until the notice is confirmed', async t => {
  const { feed, hits } = await fakeFeed(t)
  const { page, call } = await tavern(t, 'release', feed)
  const status = await call('/api/status')
  assert.equal(status.privacyNoticeVersion, 1)
  assert.equal(typeof status.launcher, 'boolean')
  assert.equal((await call('/api/settings')).privacyNotice, 0)
  assert.doesNotMatch(await page(), /fonts\.googleapis\.com/)
  await call('/api/update?auto=1')
  assert.equal(hits.latest, 0, 'the daily check waits for the notice')

  await call('/api/settings', { method: 'PUT', body: { privacyNotice: 1, webFonts: true, cdnLibraries: true } })
  assert.match(await page(), /fonts\.googleapis\.com/)
  await call('/api/update?auto=1')
  assert.equal(hits.latest, 1)

  const saved = await call('/api/settings', { method: 'PUT', body: { webFonts: false, cdnLibraries: false } })
  assert.deepEqual([saved.webFonts, saved.cdnLibraries, saved.privacyNotice], [false, false, 1])
  assert.doesNotMatch(await page(), /fonts\.(googleapis|gstatic)\.com/, '网络字体 off')
})

test('检查更新 is the user asking: it works before the notice too', async t => {
  const { feed, hits } = await fakeFeed(t)
  const { call } = await tavern(t, 'release', feed)
  await call('/api/update/check', { method: 'POST', body: {} })
  assert.equal(hits.latest, 1)
})

test('personal install: the font loads as always; settings keep their defaults', async t => {
  const { page, call } = await tavern(t, 'personal')
  assert.match(await page(), /fonts\.googleapis\.com/)
  const settings = await call('/api/settings')
  assert.deepEqual([settings.webFonts, settings.cdnLibraries], [true, true])
  const saved = await call('/api/settings', { method: 'PUT', body: { webFonts: 'no', privacyNotice: 'x' } })
  assert.deepEqual([saved.webFonts, saved.privacyNotice], [true, 0], 'only false turns a switch off')
})
