import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function start(t, options) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-presence-'))
  let stopped = 0
  const app = createApp({ dataRoot: root, proxy: 'off', onShutdown: () => { stopped++ }, ...options })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  return { base: `http://127.0.0.1:${server.address().port}`, stopped: () => stopped }
}

test('the launcher server exits only after every page has been gone for the idle time', async t => {
  const { base, stopped } = await start(t, { idleExitMs: 300 })
  const page = new AbortController()
  const res = await fetch(`${base}/api/presence`, { signal: page.signal })
  assert.equal(res.status, 200)
  await wait(500)
  assert.equal(stopped(), 0, 'an open page keeps it running')
  page.abort()
  await wait(150)
  await fetch(`${base}/api/health`)
  await wait(200)
  assert.equal(stopped(), 0, 'a request restarts the countdown')
  await wait(300)
  assert.equal(stopped(), 1)
})

test('a console server never exits on its own', async t => {
  const { base, stopped } = await start(t, { idleExitMs: 0 })
  const page = new AbortController()
  await fetch(`${base}/api/presence`, { signal: page.signal })
  page.abort()
  await wait(400)
  assert.equal(stopped(), 0)
})

test('open to phones (手机访问): the server stays up after the pages are gone', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-presence-'))
  let stopped = 0
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release', onShutdown: () => { stopped++ }, idleExitMs: 200 })
  // LAN mode, kept on loopback for the test.
  const server = await app.listen({ port: 0, listen: 'lan', host: '127.0.0.1' })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const page = new AbortController()
  await fetch(`${base}/api/presence`, { signal: page.signal })
  page.abort()
  await wait(500)
  assert.equal(stopped, 0)
})

test('the home-screen app: icons and manifest for anyone; its start address carries the key only for a phone that has logged in', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-presence-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release', accessToken: 'k'.repeat(32) })
  const server = await app.listen({ port: 0, listen: 'lan', host: '127.0.0.1' })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  for (const file of ['/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']) {
    const res = await fetch(`${base}${file}`)
    assert.equal(res.headers.get('content-type'), 'image/png', file)
  }
  const plain = await fetch(`${base}/manifest.webmanifest`)
  assert.match(plain.headers.get('content-type'), /application\/manifest\+json/)
  const manifest = await plain.json()
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.display, 'standalone')
  assert.deepEqual(manifest.icons.map(i => i.sizes), ['192x192', '512x512'])
  const signedIn = await (await fetch(`${base}/manifest.webmanifest`, { headers: { cookie: `tavern_key=${'k'.repeat(32)}` } })).json()
  assert.equal(signedIn.start_url, `/#k=${'k'.repeat(32)}`)
  const wrong = await (await fetch(`${base}/manifest.webmanifest`, { headers: { cookie: 'tavern_key=nope' } })).json()
  assert.equal(wrong.start_url, '/')
})

test('unlocking with the key takes a few bytes: a big body is refused, not held in memory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-presence-'))
  const key = 'k'.repeat(32)
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release', accessToken: key })
  const server = await app.listen({ port: 0, listen: 'lan', host: '127.0.0.1' })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const unlock = token => fetch(`http://127.0.0.1:${server.address().port}/api/access/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  assert.equal((await unlock('wrong')).status, 403)
  const right = await unlock(key)
  assert.equal(right.status, 200)
  // Named after this server's key: another server on this machine has a cookie of its own.
  const cookie = right.headers.get('set-cookie').split(';')[0]
  assert.match(cookie, /^tavern_key_[0-9a-f]{8}=k{32}$/)
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(`${base}/api/settings`, { headers: { cookie } })).status, 200)
  assert.equal((await fetch(`${base}/api/settings`, { headers: { cookie: `tavern_key_00000000=other; ${cookie}` } })).status, 200, 'beside another server cookie')
  assert.equal((await fetch(`${base}/api/settings`, { headers: { cookie: 'tavern_key_00000000=other' } })).status, 401)
  assert.equal((await unlock('x'.repeat(100_000))).status, 413)
})

test('a card frame reads its card\'s avatar with the key it is given, with no cookie; nothing else opens with it', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-presence-'))
  const key = 'k'.repeat(32)
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release', accessToken: key })
  const server = await app.listen({ port: 0, listen: 'lan', host: '127.0.0.1' })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const signedIn = { cookie: `tavern_key=${key}`, 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const card = await (await fetch(`${base}/api/cards/import`, { method: 'POST', headers: signedIn, body: JSON.stringify({ filename: 'a.json', data: Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '青禾', first_mes: '你好。' } })).toString('base64') }) })).json()
  const other = await (await fetch(`${base}/api/cards/import`, { method: 'POST', headers: signedIn, body: JSON.stringify({ filename: 'b.json', data: Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '阿砚', first_mes: '嗯。' } })).toString('base64') }) })).json()
  await app.store.saveCard(await app.store.getCard(card.id), png)
  await app.store.saveCard(await app.store.getCard(other.id), png)
  const chat = await (await fetch(`${base}/api/chats`, { method: 'POST', headers: signedIn, body: JSON.stringify({ cardId: card.id }) })).json()
  const { avatarKey } = await (await fetch(`${base}/api/chats/${chat.id}/frame-info`, { headers: signedIn })).json()
  assert.match(avatarKey, /^[0-9a-f]{32}$/)
  assert.equal((await fetch(`${base}/api/cards/${card.id}/avatar`)).status, 401, 'no cookie, no key')
  assert.equal((await fetch(`${base}/api/cards/${card.id}/avatar?fk=${avatarKey}`)).status, 200)
  assert.equal((await fetch(`${base}/api/cards/${other.id}/avatar?fk=${avatarKey}`)).status, 401, 'another card\'s avatar')
  assert.equal((await fetch(`${base}/api/cards/${card.id}?fk=${avatarKey}`)).status, 401, 'the card itself')
})
