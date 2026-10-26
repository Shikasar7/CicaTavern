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
import { relayRequest } from '../server/relay.mjs'
import { frameFetch } from '../web/compat.js'

const API = 'https://api.example.com'
const ALLOWED = '已允许这张卡经 CicaTavern 连接，再试一次'

/** A frame's fetch with a browser that fails every call, and a page that answers as told. */
function frameWith({ page, allow = async () => ALLOWED, relayed = [], direct = () => Promise.reject(new TypeError('Failed to fetch')) } = {}) {
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
      return op === 'fetchAllow' ? allow(args) : page(args, fetches.get(args.id))
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
  // A POST that failed may have reached the API (a refused answer comes after the call): not sent again, the player
  // asked, and the card told to try again.
  const send = () => fetch(`${API}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-x' }, body: JSON.stringify({ model: 'm' }) })
  await assert.rejects(send(), error => error instanceof TypeError && error.message === ALLOWED)
  assert.deepEqual(calls.map(c => c[0]), ['direct', 'fetchAllow'], 'straight out first, then only asked')
  assert.deepEqual(calls[1][1], { url: `${API}/v1/chat/completions` })

  // Tried again: through the page at once.
  const res = await send()
  assert.equal(res.status, 201)
  assert.equal(res.statusText, 'Created')
  assert.equal(res.headers.get('x-n'), '7')
  assert.equal((await res.json()).choices[0].message.content, '唐三')
  assert.equal(seen.url, `${API}/v1/chat/completions`)
  assert.equal(seen.method, 'POST')
  assert.deepEqual(Object.fromEntries(seen.headers), { authorization: 'Bearer sk-x', 'content-type': 'application/json' })
  assert.equal(new TextDecoder().decode(seen.body), '{"model":"m"}', 'the body as the card sent it')
  assert.deepEqual(calls.map(c => c[0]), ['direct', 'fetchAllow', 'fetch'])

  // That address goes through the page at once from now on.
  await (await fetch(`${API}/v1/models`)).text()
  assert.deepEqual(calls.map(c => c[0]), ['direct', 'fetchAllow', 'fetch', 'fetch'])

  // A frame made before the player allowed an address elsewhere is told (broadcastRelay): no failed call first.
  const told = frameWith({ page: async (_args, entry) => { entry.head({ status: 200, statusText: 'OK', headers: [] }); entry.done() } })
  told.fetch.allow([API, 42])
  assert.equal((await told.fetch(`${API}/v1/chat/completions`, { method: 'POST', body: '{}' })).status, 200)
  assert.deepEqual(told.calls.map(c => c[0]), ['fetch'])

  // A GET does nothing twice: sent again through the page straight away.
  const reading = frameWith({ page: async (_args, entry) => { entry.head({ status: 200, statusText: 'OK', headers: [] }); entry.chunk(new TextEncoder().encode('{"data":[]}')); entry.done() } })
  assert.deepEqual(await (await reading.fetch(`${API}/v1/models`)).json(), { data: [] })
  assert.deepEqual(reading.calls.map(c => c[0]), ['direct', 'fetch'])
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
  const refusal = async () => { throw new Error('没有允许这张卡经 CicaTavern 连接 https://api.example.com') }
  const refused = frameWith({ page: refusal, allow: refusal })
  await assert.rejects(refused.fetch(`${API}/v1/models`), error => error instanceof TypeError && /没有允许/.test(error.message))
  await assert.rejects(refused.fetch(`${API}/v1/chat/completions`, { method: 'POST', body: '{}' }), error => error instanceof TypeError && /没有允许/.test(error.message))
  await assert.rejects(refused.fetch(`${API}/v1/chat/completions`, { method: 'POST', body: '{}' }), /没有允许/, 'still asked, not relayed')
  assert.deepEqual(refused.calls.map(c => c[0]), ['direct', 'fetch', 'direct', 'fetchAllow', 'direct', 'fetchAllow'])

  // The answer streams: its first piece can be read before the end comes; then the card gives up.
  let entry = null
  const streaming = frameWith({ relayed: [API], page: async (_args, e) => { entry = e; e.head({ status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream']] }); e.chunk(new TextEncoder().encode('data: 1\n\n')) } })
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
  const empty = frameWith({ relayed: [API], page: async (_args, e) => { e.head({ status: 204, statusText: 'No Content', headers: [] }); e.done() } })
  assert.equal((await empty.fetch(`${API}/x`, { method: 'DELETE' })).body, null)
})

/** An API that does not let pages call it, recording what reached it. */
async function plainApi(t) {
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const piece of req) body += piece
    seen.push({ method: req.method, url: req.url, headers: req.headers, body })
    if (req.url === '/408') {
      res.writeHead(408, { 'content-type': 'application/json' })
      return res.end('{"error":"timeout"}')
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: 1\n\n')
      res.on('close', () => seen.push({ closed: true }))
      return
    }
    res.writeHead(req.url.startsWith('/v1/models') ? 401 : 200, { 'content-type': 'application/json', 'set-cookie': 'session=abc', 'x-api': 'yes', 'clear-site-data': '"storage", "cookies"', 'cache-control': 'public, max-age=600', 'x-relay-status-text': '%E0', link: ['<a>; rel=a', '<b>; rel=b'] })
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

/** The API's headers as the page reads them (x-relay-headers). */
const apiHeaders = res => JSON.parse(decodeURIComponent(res.headers.get('x-relay-headers')))

test('the app makes a frame\'s call: the card\'s method, headers and body; no cookies or app headers; the answer as it came, without cookies', async t => {
  const api = await plainApi(t)
  const { relay } = await tavern(t)
  const res = await relay({
    url: `${api.base}/v1/chat/completions`,
    method: 'POST',
    headers: [['content-type', 'application/json'], ['authorization', 'Bearer sk-card'], ['cookie', 'mine=1'], ['x-agent-tavern', '1'], ['origin', 'null']],
    body: Buffer.from('{"model":"m"}').toString('base64'),
    local: true,
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-relay'), '1', 'the API\'s answer')
  assert.equal(res.headers.get('x-relay-status'), '200')
  assert.equal((await res.json()).choices[0].message.content, '唐三')
  const [got] = api.seen
  assert.equal(got.method, 'POST')
  assert.equal(got.body, '{"model":"m"}')
  assert.equal(got.headers.authorization, 'Bearer sk-card')
  assert.equal(got.headers['accept-encoding'], 'identity')
  for (const name of ['cookie', 'x-agent-tavern', 'origin']) assert.equal(got.headers[name], undefined, name)

  // The API's headers reach the page as data only: none of them acts on this app's origin, nor overrides the app's own.
  for (const name of ['x-api', 'set-cookie', 'clear-site-data', 'link']) assert.equal(res.headers.get(name), null, name)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(res.headers.get('x-relay-status-text'), 'OK')
  const passed = apiHeaders(res)
  assert.deepEqual(passed.filter(([name]) => ['x-api', 'clear-site-data', 'cache-control'].includes(name)), [['x-api', 'yes'], ['clear-site-data', '"storage", "cookies"'], ['cache-control', 'public, max-age=600']])
  assert.deepEqual(passed.filter(([name]) => name === 'link').map(([, value]) => value), ['<a>; rel=a', '<b>; rel=b'], 'each one kept')
  for (const name of ['set-cookie', 'content-length', 'transfer-encoding', 'connection']) assert.ok(!passed.some(([n]) => n === name), name)

  // The API's own error comes back as data, still marked as the API's: the app's answer is a 200, as a browser
  // resends a 408 by itself (the API would get the call twice) and fails a 407.
  const refused = await relay({ url: `${api.base}/v1/models`, method: 'GET', headers: [], local: true })
  assert.equal(refused.status, 200)
  assert.equal(refused.headers.get('x-relay'), '1')
  assert.equal(refused.headers.get('x-relay-status'), '401')
  const before = api.seen.length
  const timedOut = await relay({ url: `${api.base}/408`, method: 'POST', headers: [], body: Buffer.from('{}').toString('base64'), local: true })
  assert.equal(timedOut.status, 200)
  assert.equal(timedOut.headers.get('x-relay-status'), '408')
  assert.deepEqual(await timedOut.json(), { error: 'timeout' })
  assert.equal(api.seen.length, before + 1, 'sent once')
})

test('an address on this computer or the local network is reached only once allowed as one, whatever its name', async t => {
  const api = await plainApi(t)
  const { relay, dataRoot } = await tavern(t)
  const port = new URL(api.base).port
  for (const url of [`${api.base}/v1/chat/completions`, `http://[::ffff:7f00:1]:${port}/x`, `http://0.0.0.0:${port}/x`, 'http://[::]:8000/x', 'http://100.64.1.1/x', 'http://192.168.1.20:5000/x', 'http://[fd12::1]/x', 'http://169.254.169.254/latest/meta-data']) {
    const res = await relay({ url, method: 'GET', headers: [] })
    assert.equal(res.status, 403, url)
    assert.equal(res.headers.get('x-relay'), null, url)
    const answer = await res.json()
    assert.equal(answer.local, true, url)
    assert.match(answer.error, /局域网/)
  }
  assert.equal(api.seen.length, 0, 'nothing reached it')
  // The page asks the player and tries again: not an error for the log.
  const log = await readFile(path.join(dataRoot, 'logs', 'errors.jsonl'), 'utf8').catch(() => '')
  assert.doesNotMatch(log, /局域网/)
})

/** relayRequest on a server of its own, with names looked up as the test says. */
async function relayWith(t, options) {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const piece of req) body += piece
    relayRequest(JSON.parse(body), res, options).catch(error => {
      res.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error.message, local: error.local === true, unverified: error.unverified }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  return body => fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body: JSON.stringify(body) })
}

test('a name is looked up once and the call goes to the address checked; one leading to this computer needs the player\'s yes for it', async t => {
  const api = await plainApi(t)
  const port = new URL(api.base).port
  const asked = []
  // A name only this lookup knows: reaching the API proves the connection used the address checked, not a second lookup.
  const resolve = async host => {
    asked.push(host)
    if (host === 'api.example.test') return [{ address: '127.0.0.1', family: 4 }]
    if (host === 'fake-ip.example.test') return [{ address: '198.18.1.5', family: 4 }]
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
  }
  const relay = await relayWith(t, { resolve })
  const refused = await relay({ url: `http://api.example.test:${port}/v1/x`, method: 'GET' })
  assert.equal(refused.status, 403)
  assert.equal((await refused.json()).local, true, 'a public-looking name that leads here')
  assert.equal(api.seen.length, 0)

  const res = await relay({ url: `http://api.example.test:${port}/v1/x`, method: 'GET', local: true })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-relay'), '1')
  assert.equal(api.seen[0].headers.host, `api.example.test:${port}`, 'still asked for by its name')
  assert.deepEqual(asked, ['api.example.test', 'api.example.test'], 'one lookup per call')

  // A fake-IP answer (Clash / Mihomo TUN) says nothing of where the name leads: the player's yes first, as for here.
  const fake = await relay({ url: 'http://fake-ip.example.test/x', method: 'GET' })
  assert.equal(fake.status, 403)
  assert.deepEqual(await fake.json().then(({ local, unverified }) => ({ local, unverified })), { local: true, unverified: true })

  // Not known: says why. Through a proxy only the proxy can look it up, so the same yes first (then the proxy, not there).
  const unknown = await relay({ url: 'http://nowhere.example.test/x', method: 'GET' })
  assert.equal(unknown.status, 502)
  assert.match((await unknown.json()).error, /ENOTFOUND/)
  const proxied = await relayWith(t, { resolve, proxy: 'http://127.0.0.1:9' })
  const unchecked = await proxied({ url: 'http://nowhere.example.test/x', method: 'GET' })
  assert.equal(unchecked.status, 403)
  assert.equal((await unchecked.json()).unverified, true)
  assert.equal((await proxied({ url: 'http://nowhere.example.test/x', method: 'GET', local: true })).status, 502)

  // This computer and the local network are reached directly, never through the app's proxy.
  const direct = await proxied({ url: `http://api.example.test:${port}/v1/x`, method: 'GET', local: true })
  assert.equal(direct.status, 200)
  assert.equal(direct.headers.get('x-relay'), '1')
})

test('redirects are followed as a page\'s fetch follows them, within the host allowed, each hop checked; another host\'s comes back as it is', async t => {
  const seen = []
  const api = createServer(async (req, res) => {
    let body = ''
    for await (const piece of req) body += piece
    seen.push(`${req.method} ${req.url}`)
    const go = (status, location) => {
      res.writeHead(status, { location })
      res.end()
    }
    if (req.url === '/moved') return go(301, '/final')
    if (req.url === '/see-other') return go(303, '/final')
    if (req.url === '/keep') return go(307, '/final')
    if (req.url === '/away') return go(302, `http://other.example.test:${api.address().port}/final`)
    if (req.url === '/loop') return go(302, '/loop')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`${req.method} ${body}`)
  })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    api.closeAllConnections?.()
    api.close()
  })
  const port = api.address().port
  const resolve = async host => [{ address: '127.0.0.1', family: 4 }]
  const relay = await relayWith(t, { resolve })
  const call = async (pathname, method = 'GET', body = null) => {
    const res = await relay({ url: `http://api.example.test:${port}${pathname}`, method, local: true, body: body && Buffer.from(body).toString('base64') })
    return { status: res.headers.get('x-relay-status'), text: await res.text() }
  }
  assert.deepEqual(await call('/moved'), { status: '200', text: 'GET ' })
  assert.deepEqual(await call('/see-other', 'POST', 'a=1'), { status: '200', text: 'GET ' }, '303: GET, no body')
  assert.deepEqual(await call('/keep', 'POST', 'a=1'), { status: '200', text: 'POST a=1' }, '307: the same method and body')
  assert.equal((await call('/away')).status, '302', 'another host: not followed, the card sees it')
  assert.equal((await call('/loop')).status, '302', 'a loop ends after a few hops')
  assert.equal(seen.filter(line => line === 'GET /loop').length, 6)
})

test('a frame that stops reading a relayed answer: chunks still arriving are dropped, never thrown inside the card', async () => {
  let entry = null
  const { fetch, posts } = frameWith({
    relayed: [API],
    page: async (_args, item) => {
      entry = item
      item.head({ status: 200, statusText: 'OK', headers: [] })
      item.chunk(new TextEncoder().encode('one'))
    },
  })
  const res = await fetch(`${API}/stream`)
  await res.body.cancel()
  assert.deepEqual(posts.at(-1)?.[0], 'fetchCancel')
  assert.doesNotThrow(() => entry.chunk(new TextEncoder().encode('two')))
  assert.doesNotThrow(() => entry.done())
})

test('the app never makes a frame\'s call to a CicaTavern on this machine, nor to anything but http(s); one it cannot reach says why', async t => {
  const { base, relay, dataRoot } = await tavern(t)
  const own = new URL(base)
  for (const url of [`${base}/api/chats`, `http://localhost:${own.port}/api/providers`, 'http://127.0.0.1:8790/api/chats', 'http://localhost:8791/api/settings', `http://[::ffff:7f00:1]:${own.port}/api/settings`]) {
    // Never, even allowed as an address on this computer.
    const res = await relay({ url, method: 'GET', headers: [], local: true })
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
  const res = await relay({ url: `http://127.0.0.1:${port}/v1/models`, method: 'GET', local: true })
  assert.equal(res.status, 502)
  assert.equal(res.headers.get('x-relay'), null)
  assert.match((await res.json()).error, new RegExp(`替卡片界面连接 127\\.0\\.0\\.1:${port} 没有连上`))
  assert.match(await readFile(path.join(dataRoot, 'logs', 'errors.jsonl'), 'utf8'), /POST \/api\/frame-fetch/)
})

test('the app gives up a frame\'s call when the page does', async t => {
  const api = await plainApi(t)
  const { relay } = await tavern(t)
  const controller = new AbortController()
  const res = await relay({ url: `${api.base}/slow`, method: 'GET', local: true }, controller.signal)
  const reader = res.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: 1\n\n')
  controller.abort()
  for (let i = 0; i < 50 && !api.seen.some(s => s.closed); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(api.seen.some(s => s.closed), 'the API\'s connection closed')
})
