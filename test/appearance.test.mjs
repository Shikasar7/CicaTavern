// 主题: the colour style and the picture behind the page are settings; the
// picture is one file under the data folder's ui/, renamed with each upload.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanAppearance, cleanFontName, cleanReading, storyFontOf } from '../web/shared/appearance.js'
import { createApp } from '../server/http.mjs'

// The smallest valid images of each kind the page may send.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64')

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-look-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const files = async () => (await readdir(path.join(dataRoot, 'ui')).catch(() => [])).sort()
  return { base, call, files }
}

test('appearance values: unknown styles, names and opacities fall back', () => {
  assert.deepEqual(cleanAppearance(null), { style: 'lamp', backdrop: '', backdropOpacity: 0.5, custom: null })
  assert.deepEqual(cleanAppearance({ style: 'sakura', backdrop: 'backdrop-abc123.jpg', backdropOpacity: 0.333 }), { style: 'sakura', backdrop: 'backdrop-abc123.jpg', backdropOpacity: 0.33, custom: null })
  assert.equal(cleanAppearance({ style: 'neon' }).style, 'lamp')
  assert.equal(cleanAppearance({ backdrop: '../settings.json' }).backdrop, '')
  assert.equal(cleanAppearance({ backdrop: 'backdrop-abc123.svg' }).backdrop, '')
  assert.deepEqual([0, 7, -1].map(o => cleanAppearance({ backdropOpacity: o }).backdropOpacity), [0.05, 1, 0.05])
})

test('the story font and size: unknown fonts and sizes fall back, a typed name cannot break out of its quotes', () => {
  assert.deepEqual(cleanReading(null), { font: 'song', custom: '', scale: 1 })
  assert.deepEqual(cleanReading({ font: 'kai', scale: 1.234 }), { font: 'kai', custom: '', scale: 1.23 })
  assert.equal(cleanReading({ font: 'comic' }).font, 'song')
  assert.deepEqual([0.2, 9, 'big'].map(scale => cleanReading({ scale }).scale), [0.8, 1.6, 1])
  assert.equal(cleanFontName(' 霞鹜文楷 '), '霞鹜文楷')
  assert.equal(cleanFontName('x"; } body { display: none'), 'x  body  display: none'.replace(/\s+/g, ' '))
  assert.equal(cleanFontName('a'.repeat(80)).length, 60)
  assert.equal(storyFontOf({ font: 'song' }), '')
  assert.equal(storyFontOf({ font: 'hei' }), 'var(--font-hei)')
  assert.equal(storyFontOf({ font: 'custom', custom: '霞鹜文楷' }), '"霞鹜文楷", var(--serif)')
  // Picked but not named yet: the usual font.
  assert.equal(storyFontOf({ font: 'custom', custom: ' "' }), '')
})

test('style and opacity save with the settings; the picture only through its own address', async t => {
  const { base, call, files } = await tavern(t)
  assert.deepEqual((await call('/api/settings')).body.appearance, { style: 'lamp', backdrop: '', backdropOpacity: 0.5, custom: null })
  const styled = await call('/api/settings', { method: 'PUT', body: { appearance: { style: 'night', backdropOpacity: 0.3, backdrop: 'backdrop-zzzzzz.png' } } })
  assert.deepEqual(styled.body.appearance, { style: 'night', backdrop: '', backdropOpacity: 0.3, custom: null }, 'a picture name from the page is ignored')

  const first = await call('/api/appearance/backdrop', { method: 'PUT', body: { image: `data:image/png;base64,${PNG}` } })
  assert.equal(first.status, 200)
  const name = first.body.appearance.backdrop
  assert.match(name, /^backdrop-[a-f0-9]{10}\.png$/)
  assert.equal(first.body.appearance.style, 'night', 'the style stays')
  assert.deepEqual(await files(), [name])
  const served = await fetch(`${base}/api/appearance/${name}`)
  assert.equal(served.headers.get('content-type'), 'image/png')
  assert.match(served.headers.get('cache-control'), /immutable/)
  assert.equal(Buffer.from(await served.arrayBuffer()).toString('base64'), PNG)

  // Other settings keep the picture; a new picture replaces the old file.
  assert.equal((await call('/api/settings', { method: 'PUT', body: { appearance: { style: 'paper' } } })).body.appearance.backdrop, name)
  const second = await call('/api/appearance/backdrop', { method: 'PUT', body: { image: `data:image/jpeg;base64,${JPEG}` } })
  const next = second.body.appearance.backdrop
  assert.match(next, /\.jpg$/)
  assert.deepEqual(await files(), [next])
  assert.equal((await fetch(`${base}/api/appearance/${name}`)).status, 404)

  // What is not a picture, or claims to be another kind, is refused.
  assert.equal((await call('/api/appearance/backdrop', { method: 'PUT', body: { image: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}` } })).status, 400)
  assert.equal((await call('/api/appearance/backdrop', { method: 'PUT', body: { image: 'https://example.com/a.png' } })).status, 400)
  assert.equal((await fetch(`${base}/api/appearance/backdrop-..%2Fsettings.json`)).status, 404)

  const removed = await call('/api/appearance/backdrop', { method: 'DELETE' })
  assert.deepEqual(removed.body.appearance, { style: 'paper', backdrop: '', backdropOpacity: 0.3, custom: null })
  assert.deepEqual(await files(), [])
})
