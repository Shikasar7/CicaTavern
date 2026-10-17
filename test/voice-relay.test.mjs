import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'

const PC_KEY = 'pc-key-1234567890'

async function fakeBridge(t) {
  const seen = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    seen.push({ url: req.url, json: raw ? JSON.parse(raw) : null })
    if (req.url === '/api/persona/list') return res.end(JSON.stringify({ voices: [{ name: 'jok' }, { name: '南晚' }], cloud_voices: [{ name: 'fish:abc', label: '南晚 · abc', provider: 'Fish', model: 'drama-3', tags: true }], current: { voice: 'jok' } }))
    if (req.url === '/api/tts') {
      res.writeHead(200, { 'content-type': 'audio/wav' })
      return res.end('RIFF....WAVE')
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { seen, base: `http://127.0.0.1:${server.address().port}` }
}

async function tavern(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-voice-'))
  const app = createApp({ dataRoot: root, proxy: 'off', ...options })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body, key } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-agent-tavern': '1', ...(key ? { 'x-agent-tavern-key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()).toString() }
  }
  return { base, call }
}

test('voice relay: the phone reads through the PC tavern with its LAN link', async t => {
  const bridge = await fakeBridge(t)
  const pc = await tavern(t, { accessToken: PC_KEY })
  const phone = await tavern(t)
  assert.equal((await pc.call('/api/media/settings', { method: 'PUT', key: PC_KEY, body: { ttsUrl: bridge.base } })).status, 200)

  // The link from 局域网访问, pasted whole: the key goes to its own file, not the settings.
  const saved = await phone.call('/api/media/settings', { method: 'PUT', body: { ttsUrl: `${pc.base}/#k=${PC_KEY}` } })
  assert.equal(saved.body.media.ttsUrl, pc.base)
  assert.deepEqual(saved.body.voiceKey, { hasKey: true, keyHint: `…${PC_KEY.slice(-4)}` })
  assert.doesNotMatch(JSON.stringify((await phone.call('/api/settings')).body), new RegExp(PC_KEY))

  const voices = await phone.call('/api/media/voices')
  assert.deepEqual(voices.body, { ok: true, voices: ['jok', '南晚'], cloud: [{ name: 'fish:abc', label: '南晚 · abc', provider: 'Fish', model: 'drama-3', tags: true }], current: 'jok', remote: true })
  const wav = await phone.call('/api/tts', { method: 'POST', body: { text: '站住。', voice: '南晚' } })
  assert.equal(wav.body, 'RIFF....WAVE')
  await phone.call('/api/tts', { method: 'POST', body: { text: '站住。', voice: '南晚' } })
  const synthesised = () => bridge.seen.filter(r => r.url === '/api/tts').length
  assert.equal(synthesised(), 1, 'cached')
  await phone.call('/api/tts', { method: 'POST', body: { text: '站住。', voice: '南晚', fresh: true } })
  assert.equal(synthesised(), 2, '重新合成 on the phone skips the PC tavern’s cache too')

  // A wrong key is explained; a new address without a key drops the saved one.
  await phone.call('/api/media/settings', { method: 'PUT', body: { ttsUrl: `${pc.base}/#k=wrong-key-000000` } })
  assert.match((await phone.call('/api/media/voices')).body.error, /局域网访问/)
  const moved = await phone.call('/api/media/settings', { method: 'PUT', body: { ttsUrl: 'http://127.0.0.1:9' } })
  assert.equal(moved.body.voiceKey.hasKey, false)
  assert.match((await phone.call('/api/media/voices')).body.error, /小雅一键启动/)
})
