import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { editionName, featuresOf } from '../server/edition.mjs'
import { createApp } from '../server/http.mjs'
import { cleanProxySetting, createProxy, parseWindowsProxy, proxyOverride } from '../server/proxy.mjs'

async function tavern(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-edition-'))
  const app = createApp({ dataRoot: root, ...options })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json() }
  }
  return { app, call }
}

test('editions: capabilities by name, unknown names are the personal install', () => {
  assert.equal(editionName('desktop'), 'personal', 'the old name')
  assert.equal(editionName('nonsense'), 'personal')
  assert.deepEqual(
    Object.fromEntries(['personal', 'release', 'android'].map(e => [e, featuresOf(e).subscription])),
    { personal: true, release: false, android: false },
  )
  assert.equal(featuresOf('release').lan, true)
  assert.equal(featuresOf('android').lan, false)
  // The phone's Node 18 has no http.Agent proxyEnv, so it has no 网络代理 setting.
  assert.deepEqual(['personal', 'release', 'android'].map(e => featuresOf(e).proxy), [true, true, false])
  // Every edition is CicaTavern; this machine's own install keeps its data folder and port.
  assert.deepEqual(['personal', 'release', 'android'].map(e => featuresOf(e).appName), ['CicaTavern', 'CicaTavern', 'CicaTavern'])
  assert.deepEqual([featuresOf('personal').dataDir, featuresOf('personal').port], ['.agent-tavern', 8791])
  assert.equal(featuresOf('release').defaultProxy, 'none')
  assert.equal(featuresOf('personal').defaultProxy, 'http://127.0.0.1:7897')
  assert.deepEqual([featuresOf("release").appName, featuresOf("release").dataDir, featuresOf("release").port], ["CicaTavern", ".cicatavern", 8790])
  assert.equal(featuresOf("personal").port, 8791)
})

test('release: no subscription, no DSH import, no assumed voice bridge; LAN still allowed', async t => {
  const { call } = await tavern(t, { edition: 'release' })
  const status = (await call('/api/status')).body
  assert.equal(status.edition, 'release')
  assert.equal(status.features.subscription, false)
  assert.equal(status.claudeExecutable, null)
  assert.deepEqual((await call('/api/auth')).body, { disabled: true })
  const models = (await call('/api/models')).body
  assert.equal(models.subscription, false)
  assert.ok(!models.choices.some(m => m.group === 'Claude 订阅'))
  assert.equal((await call('/api/providers')).body.subscriptionLocked, true)
  assert.equal((await call('/api/providers/import-dsh', { method: 'POST', body: {} })).status, 404)

  // A subscription model cannot become the default; turning the subscription on does nothing.
  const saved = (await call('/api/settings', { method: 'PUT', body: { model: 'sonnet', subscription: 'on', listen: 'lan' } })).body
  assert.equal(saved.model, '')
  assert.equal(saved.subscription, 'off')
  assert.equal(saved.listen, 'lan', 'phones may still connect to a release build')

  // Voice: nothing configured, so the page offers browser voices; the server says why it cannot read.
  const voices = (await call('/api/media/voices')).body.sources
  assert.deepEqual(voices.map(s => [s.id, s.configured, s.voices.length]), [['bridge', false, 0], ['openai', false, 0], ['fish', false, 0], ['minimax', false, 0]])
  assert.equal((await call('/api/media/settings')).body.media.ttsUrl, '')
  const spoken = await call('/api/tts', { method: 'POST', body: { text: '你好' } })
  assert.equal(spoken.status, 400)
  assert.match(spoken.body.error, /浏览器音色/)
  // Clearing the address keeps it empty (the personal install falls back to the bridge).
  assert.equal((await call('/api/media/settings', { method: 'PUT', body: { ttsUrl: '' } })).body.media.ttsUrl, '')
})

test('android: loopback only', async t => {
  const { call } = await tavern(t, { edition: 'android' })
  assert.equal((await call('/api/settings', { method: 'PUT', body: { listen: 'lan' } })).body.listen, 'local')
})

test('proxy: setting values, overrides and the Windows ProxyServer forms', () => {
  assert.equal(cleanProxySetting(''), null)
  assert.equal(cleanProxySetting('off'), 'none')
  assert.equal(cleanProxySetting('SYSTEM'), 'system')
  assert.equal(cleanProxySetting('http://127.0.0.1:7890/'), 'http://127.0.0.1:7890')
  assert.throws(() => cleanProxySetting('socks5://127.0.0.1:1080'), /HTTP/)
  assert.equal(proxyOverride(undefined), undefined)
  assert.equal(proxyOverride('off'), 'none')
  assert.equal(proxyOverride('http://10.0.0.2:8080'), 'http://10.0.0.2:8080')

  assert.equal(parseWindowsProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(parseWindowsProxy('http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892'), 'http://127.0.0.1:7891')
  assert.equal(parseWindowsProxy('http=127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(parseWindowsProxy('socks=127.0.0.1:1080'), null)
  assert.equal(parseWindowsProxy(''), null)
})

test('proxy: system mode prefers Windows settings over stale environment variables', async () => {
  let windows = 'http://127.0.0.1:7897'
  const network = createProxy({ defaultMode: 'none', env: { HTTP_PROXY: 'http://127.0.0.1:7890' }, readSystem: async () => windows })
  assert.equal(network.current(), null)
  assert.deepEqual(await network.apply('system'), { mode: 'system', effective: 'http://127.0.0.1:7897', source: 'windows', locked: false })
  windows = null
  assert.deepEqual(await network.apply('system'), { mode: 'system', effective: 'http://127.0.0.1:7890', source: 'env', locked: false })
  assert.equal((await network.apply(null)).effective, null, 'unset: the edition default')
  network.stop()

  const fixed = createProxy({ override: 'none', defaultMode: 'http://127.0.0.1:7897' })
  assert.deepEqual(await fixed.apply('http://10.0.0.2:8080'), { mode: 'none', effective: null, source: null, locked: true })
  assert.equal(createProxy({ defaultMode: 'http://127.0.0.1:7897' }).current(), 'http://127.0.0.1:7897', 'usable before the first apply')
})

test('proxy: changing the setting applies at once', async t => {
  const { app, call } = await tavern(t, { edition: 'release' })
  assert.equal(app.isolation.proxy, null, 'release builds use no proxy by default')
  await call('/api/settings', { method: 'PUT', body: { proxy: 'http://127.0.0.1:7890' } })
  assert.equal(app.isolation.proxy, 'http://127.0.0.1:7890')
  assert.deepEqual((await call('/api/network')).body, { mode: 'http://127.0.0.1:7890', effective: 'http://127.0.0.1:7890', source: null, locked: false })
  assert.equal((await call('/api/settings', { method: 'PUT', body: { proxy: 'socks5://x:1' } })).status, 400)
  await call('/api/settings', { method: 'PUT', body: { proxy: 'none' } })
  assert.equal(app.isolation.proxy, null)
})
