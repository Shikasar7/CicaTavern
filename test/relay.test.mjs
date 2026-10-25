// A card frame's own API call the browser could not make: the frame's fetch goes
// straight out first, then asks the page (web/compat.js frameFetch), which has the
// app make it (server/relay.mjs, POST /api/frame-fetch) and passes the answer back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { frameFetch } from '../web/compat.js'

const API = 'https://api.example.com'

/** A frame's fetch with a browser that fails every call, and a page that answers as told. */
function frameWith({ page, relayed = [], direct = () => Promise.reject(new TypeError('Failed to fetch')) } = {}) {
  const fetches = new Map()
  const posts = []
  const calls = []
  const fetch = frameFetch({
    direct: (...args) => {
      calls.push(['direct', args[0].url])
      return direct(...args)
    },
    post: (op, args) => posts.push([op, args]),
    call: (op, args) => {
      calls.push([op, args])
      return page(args, fetches.get(args.id))
    },
    fetches,
    frame: 'f1',
    appOrigin: 'http://127.0.0.1:8790',
    relayed,
  })
  return { fetch, fetches, posts, calls }
}

test('a frame\'s fetch the browser cannot make goes through the page: status, headers and body as they come', async () => {
  let seen = null
  const { fetch, calls } = frameWith({
    page: async (args, entry) => {
      seen = args
      entry.head({ status: 201, statusText: 'Created', headers: [['content-type', 'application/json'], ['x-n', '7']] })
      entry.chunk(new TextEncoder().encode('{"choices":[{"message":'))
      entry.chunk(new TextEncoder().encode('{"content":"唐三"}}]}'))
      entry.done()
    },
  })
  const res = await fetch(`${API}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-x' }, body: JSON.stringify({ model: 'm' }) })
  assert.equal(res.status, 201)
  assert.equal(res.statusText, 'Created')
  assert.equal(res.headers.get('x-n'), '7')
  assert.equal((await res.json()).choices[0].message.content, '唐三')
  assert.equal(seen.url, `${API}/v1/chat/completions`)
  assert.equal(seen.method, 'POST')
  assert.deepEqual(Object.fromEntries(seen.headers), { authorization: 'Bearer sk-x', 'content-type': 'application/json' })
  assert.equal(new TextDecoder().decode(seen.body), '{"model":"m"}', 'the body as the card sent it')
  assert.deepEqual(calls.map(c => c[0]), ['direct', 'fetch'], 'straight out first')

  // Relayed once: that address goes through the page at once from now on (no second send of a call that may have got there).
  await (await fetch(`${API}/v1/models`)).text()
  assert.deepEqual(calls.map(c => c[0]), ['direct', 'fetch', 'fetch'])
})

test('a frame\'s fetch: what the browser can make stays the browser\'s; this app\'s own address and other schemes are never relayed', async () => {
  const ok = new Response('fine')
  const { fetch, calls } = frameWith({ direct: async () => ok, page: () => assert.fail('not asked') })
  assert.equal(await fetch(`${API}/v1/models`), ok)
  const broken = frameWith({ page: () => assert.fail('not asked') })
  await assert.rejects(broken.fetch('http://127.0.0.1:8790/api/chats'), /Failed to fetch/)
  await assert.rejects(broken.fetch('data:text/plain,x'), /Failed to fetch/)
  assert.deepEqual(calls.map(c => c[0]), ['direct'])
})

test('a frame\'s fetch the player did not allow fails with what the page said; one cancelled stops the page\'s call', async () => {
  const refused = frameWith({ page: async () => { throw new Error('没有允许这张卡经 CicaTavern 连接 https://api.example.com') } })
  await assert.rejects(refused.fetch(`${API}/v1/models`), error => error instanceof TypeError && /没有允许/.test(error.message))

  // The answer streams: its first piece can be read before the end comes; then the card gives up.
  let entry = null
  const streaming = frameWith({ page: async (_args, e) => { entry = e; e.head({ status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream']] }); e.chunk(new TextEncoder().encode('data: 1\n\n')) } })
  const controller = new AbortController()
  const res = await streaming.fetch(`${API}/v1/chat/completions`, { method: 'POST', body: '{}', signal: controller.signal })
  const reader = res.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: 1\n\n')
  controller.abort()
  assert.deepEqual(streaming.posts.at(-1)[0], 'fetchCancel')
  await assert.rejects(reader.read(), /abort/i)
  assert.equal(streaming.fetches.size, 0)
  assert.ok(entry)

  // Cancelled before the answer: rejected as an abort, and the page told.
  const waiting = frameWith({ page: () => new Promise(() => {}) })
  const early = new AbortController()
  const pending = waiting.fetch(`${API}/v1/models`, { signal: early.signal })
  await new Promise(resolve => setTimeout(resolve, 10))
  early.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(waiting.posts.at(-1)[0], 'fetchCancel')

  // No body for a 204.
  const empty = frameWith({ page: async (_args, e) => { e.head({ status: 204, statusText: 'No Content', headers: [] }); e.done() } })
  assert.equal((await empty.fetch(`${API}/x`, { method: 'DELETE' })).body, null)
})

/** An API that does not let pages call it, recording what reached it. */
async function plainApi(t) {
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const piece of req) body += piece
    seen.push({ method: req.method, url: req.url, headers: req.headers, body })
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: 1\n\n')
      res.on('close', () => seen.push({ closed: true }))
      return
    }
    res.writeHead(req.url.startsWith('/v1/models') ? 401 : 200, { 'content-type': 'application/json', 'set-cookie': 'session=abc', 'x-api': 'yes' })
    res.write('{"choices":[{"message":')
    setTimeout(() => res.end('{"content":"唐三"}}]}'), 20)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  return { base: `http://127.0.0.1:${server.address().port}`, seen }
}

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-relay-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const relay = (body, signal) => fetch(`${base}/api/frame-fetch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: JSON.stringify(body), signal })
  return { base, relay, dataRoot }
}

test('the app makes a frame\'s call: the card\'s method, headers and body; no cookies or app headers; the answer as it came, without cookies', async t => {
  const api = await plainApi(t)
  const { relay } = await tavern(t)
  const res = await relay({
    url: `${api.base}/v1/chat/completions`,
    method: 'POST',
    headers: [['content-type', 'application/json'], ['authorization', 'Bearer sk-card'], ['cookie', 'mine=1'], ['x-agent-tavern', '1'], ['origin', 'null']],
    body: Buffer.from('{"model":"m"}').toString('base64'),
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-relay'), '1', 'the API\'s answer')
  assert.equal(res.headers.get('x-api'), 'yes')
  assert.equal(res.headers.get('set-cookie'), null)
  assert.equal((await res.json()).choices[0].message.content, '唐三')
  const [got] = api.seen
  assert.equal(got.method, 'POST')
  assert.equal(got.body, '{"model":"m"}')
  assert.equal(got.headers.authorization, 'Bearer sk-card')
  assert.equal(got.headers['accept-encoding'], 'identity')
  for (const name of ['cookie', 'x-agent-tavern', 'origin']) assert.equal(got.headers[name], undefined, name)

  // The API's own error comes back as it is, still marked as the API's.
  const refused = await relay({ url: `${api.base}/v1/models`, method: 'GET', headers: [] })
  assert.equal(refused.status, 401)
  assert.equal(refused.headers.get('x-relay'), '1')
})

test('the app never makes a frame\'s call to a CicaTavern on this machine, nor to anything but http(s); one it cannot reach says why', async t => {
  const { base, relay, dataRoot } = await tavern(t)
  const own = new URL(base)
  for (const url of [`${base}/api/chats`, `http://localhost:${own.port}/api/providers`, 'http://127.0.0.1:8790/api/chats', 'http://localhost:8791/api/settings']) {
    const res = await relay({ url, method: 'GET', headers: [] })
    assert.equal(res.status, 403, url)
    assert.equal(res.headers.get('x-relay'), null)
    assert.match((await res.json()).error, /CicaTavern 自己/)
  }
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'not a url']) assert.equal((await relay({ url, method: 'GET' })).status, 400, url)

  // Nothing listens there: an answer from the app, not the API, and in the error log.
  const closed = createServer()
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve))
  const port = closed.address().port
  await new Promise(resolve => closed.close(resolve))
  const res = await relay({ url: `http://127.0.0.1:${port}/v1/models`, method: 'GET' })
  assert.equal(res.status, 502)
  assert.equal(res.headers.get('x-relay'), null)
  assert.match((await res.json()).error, new RegExp(`替卡片界面连接 127\\.0\\.0\\.1:${port} 没有连上`))
  assert.match(await readFile(path.join(dataRoot, 'logs', 'errors.jsonl'), 'utf8'), /POST \/api\/frame-fetch/)
})

test('the app gives up a frame\'s call when the page does', async t => {
  const api = await plainApi(t)
  const { relay } = await tavern(t)
  const controller = new AbortController()
  const res = await relay({ url: `${api.base}/slow`, method: 'GET' }, controller.signal)
  const reader = res.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: 1\n\n')
  controller.abort()
  for (let i = 0; i < 50 && !api.seen.some(s => s.closed); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(api.seen.some(s => s.closed), 'the API\'s connection closed')
})
