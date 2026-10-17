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
