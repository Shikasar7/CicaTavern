// A card UI's own model call (generate) stops at the provider when the page stops it or goes: it was billed to
// the end before, as the server listened for the end of a request it had already read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { normalizeProvider } from '../server/providers.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** An OpenAI-compatible provider writing a word every 100 ms for 3 s, saying when the caller hung up early. */
async function slowProvider(t) {
  const state = { calls: 0, cutShort: false, finished: false }
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    state.calls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.on('close', () => {
      if (!state.finished) state.cutShort = true
    })
    for (let i = 0; i < 30 && !res.destroyed; i++) {
      res.write(`data: ${JSON.stringify({ model: 'm1', choices: [{ delta: { content: `词${i} ` } }] })}\n\n`)
      await wait(100)
    }
    if (res.destroyed) return
    state.finished = true
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  return { state, baseURL: `http://127.0.0.1:${server.address().port}/v1` }
}

test('a card UI\'s model call is stopped at the provider when the page stops reading it', async t => {
  const provider = await slowProvider(t)
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-framegen-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const store = createStore(dataRoot)
  await store.init()
  const fake = normalizeProvider({ name: 'Slow', api: 'openai-completions', baseURL: provider.baseURL, apiKey: 'sk-test', models: [{ id: 'm1' }] })
  await store.saveProviders([fake])
  await store.saveSettings({ model: `${fake.id}/m1`, subscription: 'off' })
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '小雨', first_mes: '你好' } })
  await store.saveCard(card)

  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(() => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const chat = await (await fetch(`${base}/api/chats`, { method: 'POST', headers, body: JSON.stringify({ cardId: card.id }) })).json()

  const stop = new AbortController()
  const res = await fetch(`${base}/api/chats/${chat.id}/frame-generate`, { method: 'POST', headers, body: JSON.stringify({ config: { user_input: '说点什么' } }), signal: stop.signal })
  const reader = res.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /"delta"/, 'the call is under way')
  stop.abort()
  for (let i = 0; i < 30 && !provider.state.cutShort; i++) await wait(50)
  assert.equal(provider.state.calls, 1)
  assert.equal(provider.state.cutShort, true, 'the provider\'s stream was closed before it ended')
  assert.equal(provider.state.finished, false)
})
