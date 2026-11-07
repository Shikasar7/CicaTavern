// A reply that stops partway, by a failure upstream or by the player: what was written stays, and says why it ends there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { normalizeProvider, providerError } from '../server/providers.mjs'
import { withoutOpenEnd } from '../server/state.mjs'

const chunk = content => `data: ${JSON.stringify({ model: 'm1', choices: [{ delta: { content }, finish_reason: null }] })}\n\n`

/** A provider that writes `text`, then does `end`: 'reset' drops the connection, 'hang' writes no more, 'error' answers with one. */
async function provider(t, { text, end }) {
  const server = createServer(async (req, res) => {
    for await (const part of req) void part
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    if (text) res.write(chunk(text))
    if (end === 'error') return res.end(`data: ${JSON.stringify({ error: { message: 'quota gone' } })}\n\n`)
    if (end === 'reset') setTimeout(() => res.socket.destroy(), 40)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  return `http://127.0.0.1:${server.address().port}/v1`
}

async function app(t, fake) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-cut-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const store = createStore(dataRoot)
  await store.init()
  const made = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: await provider(t, fake), apiKey: 'sk-test-1234567890abcd', models: [{ id: 'm1' }] })
  await store.saveProviders([made])
  await store.saveSettings({ model: `${made.id}/m1`, subscription: 'off' })
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '小雨', first_mes: '你好' } })
  await store.saveCard(card)
  const server = await createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const listening = await server.listen({ port: 0 })
  t.after(() => {
    server.network.stop()
    listening.closeAllConnections?.()
    listening.close()
  })
  const base = `http://127.0.0.1:${listening.address().port}`
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const call = async (where, method = 'GET', body) => (await fetch(`${base}${where}`, { method, headers, body: body ? JSON.stringify(body) : undefined })).json()
  const chat = await call('/api/chats', 'POST', { cardId: card.id })
  const events = text => text.split('\n\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  const turn = async ({ stopAfter = 0 } = {}) => {
    if (stopAfter) setTimeout(() => call(`/api/chats/${chat.id}/stop`, 'POST', {}), stopAfter)
    return events(await (await fetch(`${base}/api/chats/${chat.id}/turn`, { method: 'POST', headers, body: JSON.stringify({ parentId: 'root', input: '走吧' }) })).text())
  }
  return { turn, call, chat, server }
}

const doneOf = events => events.find(event => event.type === 'done')

test('cut off upstream: what was written stays, marked, and the words say it was upstream', async t => {
  const { turn, call, chat } = await app(t, { text: '她点点头，推开门。\n<UpdateVariable>\n{"体力":', end: 'reset' })
  const events = await turn()
  const done = doneOf(events)
  assert.ok(done, 'the turn ends as a saved turn')
  assert.equal(events.some(event => event.type === 'error'), false)
  assert.equal(done.cut.stopped, false)
  assert.match(done.cut.message, /连接被上游/)
  assert.doesNotMatch(done.cut.message, /检查 Base URL/)
  assert.match(done.cut.message, /ECONNRESET/)
  const reply = done.chat.path.at(-1)
  assert.equal(reply.text, '她点点头，推开门。', 'the block it was in the middle of goes')
  assert.equal(reply.truncated, 'broken')
  assert.equal(reply.usage, undefined, 'a provider tells the tokens at the end')
  assert.equal(done.chat.path.at(-2).text, '走吧')
  const saved = await call(`/api/chats/${chat.id}`)
  assert.equal(saved.path.at(-1).text, '她点点头，推开门。')
  assert.equal(saved.running, false)
  assert.equal((await call('/api/diagnostics')).count, 1, 'in the error log as any failed turn is')
})

test('an error from upstream partway says it came from there', async t => {
  const { turn } = await app(t, { text: '她点点头。', end: 'error' })
  const done = doneOf(await turn())
  assert.equal(done.chat.path.at(-1).text, '她点点头。')
  assert.match(done.cut.message, /写到中途报错了，这是上游返回的错误：.*quota gone/)
})

test('stopped by hand: what was written stays, and no error is made of it', async t => {
  const { turn, call, chat } = await app(t, { text: '她点点头。', end: 'hang' })
  const events = await turn({ stopAfter: 150 })
  const done = doneOf(events)
  assert.deepEqual(done.cut, { stopped: true, message: '' })
  assert.equal(done.chat.path.at(-1).truncated, 'stopped')
  assert.equal(done.chat.path.at(-1).text, '她点点头。')
  assert.equal((await call('/api/diagnostics')).count, 0)
  assert.equal((await call(`/api/chats/${chat.id}`)).running, false)
})

test('nothing written yet: the turn fails whole, as before, in the same words', async t => {
  const dropped = await app(t, { text: '', end: 'reset' })
  const events = await dropped.turn()
  assert.equal(doneOf(events), undefined)
  assert.match(events.find(event => event.type === 'error').message, /连接被上游/)
  assert.equal((await dropped.call(`/api/chats/${dropped.chat.id}`)).path.length, 1)

  // Only its thinking in a tag, and no story: nothing to keep either.
  const thinking = await app(t, { text: '<thinking>她会怎么做', end: 'reset' })
  assert.equal(doneOf(await thinking.turn()), undefined)
  assert.equal((await thinking.call(`/api/chats/${thinking.chat.id}`)).path.length, 1)

  const stopped = await app(t, { text: '', end: 'hang' })
  assert.equal(doneOf(await stopped.turn({ stopAfter: 150 })), undefined)
})

test('a turn asked for without keepCut (试玩) fails whole', async t => {
  const { server, chat } = await app(t, { text: '她点点头。', end: 'reset' })
  await assert.rejects(server.engine.runTurn(chat.id, { parentId: 'root', input: '走吧' }, () => {}), /连接被上游/)
})

test('a cut reply loses only what it was in the middle of', () => {
  assert.equal(withoutOpenEnd('她笑了。\n<UpdateVariable>\n半截'), '她笑了。')
  assert.equal(withoutOpenEnd('她笑了。\n<choices>\n1. 走'), '她笑了。')
  assert.equal(withoutOpenEnd('她笑了。<thinking>再想想'), '她笑了。')
  assert.equal(withoutOpenEnd('她笑了。<%= sta'), '她笑了。')
  assert.equal(withoutOpenEnd('她笑了。\n<Upd'), '她笑了。')
  assert.equal(withoutOpenEnd('她笑了。\n【小雨|'), '她笑了。')
  const finished = '<thinking>想</thinking>她笑了。\n<UpdateVariable>x</UpdateVariable>\n接着写'
  assert.equal(withoutOpenEnd(finished), finished, 'what is closed stays')
  assert.equal(withoutOpenEnd('她说 “好”，然后'), '她说 “好”，然后')
})

test('the words: a connection gone once the answer is under way is no address problem', () => {
  const provider = { name: 'Vertex AI' }
  const reset = Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
  assert.match(providerError(provider, reset), /^Vertex AI 的回复写到中途，连接被上游.*（ECONNRESET）$/)
  const hungUp = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  assert.match(providerError(provider, hungUp), /^连不上 /, 'before an answer: still not reached')
  assert.match(providerError(provider, hungUp, { begun: true }), /连接被上游/)
  assert.match(providerError(provider, new Error('boom'), { begun: true }), /这是上游返回的错误：boom/)
  assert.match(providerError(provider, new Error('boom')), /^Vertex AI：boom/)
})
