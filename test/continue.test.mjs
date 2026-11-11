// 继续生成 (SillyTavern's /continue): a reply cut short is written on from where it stopped, as a new version of it.
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
import { joinContinued } from '../server/engine.mjs'

const chunk = (content, finish = null) => `data: ${JSON.stringify({ model: 'm1', choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`

/** A provider that answers each request with the next of `answers` ({ text, cut }: cut stops at the output limit), and keeps what it was sent. */
async function provider(t, answers) {
  const asked = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    asked.push(JSON.parse(body))
    const { text, cut = false } = answers[Math.min(asked.length - 1, answers.length - 1)]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(chunk(text))
    res.write(chunk('', cut ? 'length' : 'stop'))
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  return { url: `http://127.0.0.1:${server.address().port}/v1`, asked }
}

async function app(t, answers) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-continue-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const store = createStore(dataRoot)
  await store.init()
  const fake = await provider(t, answers)
  const made = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: fake.url, apiKey: 'sk-test-1234567890abcd', models: [{ id: 'm1' }] })
  await store.saveProviders([made])
  await store.saveSettings({ model: `${made.id}/m1`, subscription: 'off', autoFillUpdate: false })
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '小雨', first_mes: '雨下了一整夜。' } })
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
  const stream = async (kind, body) => events(await (await fetch(`${base}/api/chats/${chat.id}/${kind}`, { method: 'POST', headers, body: JSON.stringify(body) })).text())
  return { stream, call, chat, asked: fake.asked }
}

const doneOf = events => events.find(event => event.type === 'done')

test('a reply cut at the output limit is written on: the model sees it and is asked to go on, the two join as a new version', async t => {
  const { stream, asked } = await app(t, [
    { text: '她推开门，雨丝斜斜地扑进来。她回头', cut: true },
    // The model starts again a few words back: what repeats goes.
    { text: '雨丝斜斜地扑进来。她回头看了你一眼。\n<choices>\nA. 跟上\n</choices>' },
  ])
  const first = doneOf(await stream('turn', { parentId: 'root', input: '走吧' }))
  const cut = first.chat.path.at(-1)
  assert.equal(cut.truncated, true, 'marked as cut at the limit')

  const events = await stream('continue', { nodeId: cut.id })
  const done = doneOf(events)
  assert.ok(done, JSON.stringify(events.find(event => event.type === 'error')))
  const reply = done.chat.path.at(-1)
  assert.equal(reply.raw ?? reply.text, '她推开门，雨丝斜斜地扑进来。她回头看了你一眼。\n<choices>\nA. 跟上\n</choices>')
  assert.equal(reply.truncated, undefined, 'this time it ended')
  assert.equal(reply.siblingCount, 2, 'the version cut short is still there')
  assert.equal(done.chat.path.at(-2).text, '走吧', 'the same turn, not a new one')

  // What the model was sent: the turn as it was, then the reply so far and the ask to go on.
  const [turn, more] = asked
  const sent = more.messages
  assert.deepEqual(sent.slice(0, turn.messages.length), turn.messages, 'the turn sent as it was')
  assert.equal(sent.at(-2).role, 'assistant')
  assert.equal(sent.at(-2).content, '她推开门，雨丝斜斜地扑进来。她回头')
  assert.equal(sent.at(-1).role, 'user')
  assert.match(sent.at(-1).content, /接着写/)
})

test('the opening is not continued, and a reply that is not there says so', async t => {
  const { stream, chat } = await app(t, [{ text: '嗯。' }])
  const opening = chat.path[0]
  const refused = (await stream('continue', { nodeId: opening.id })).find(event => event.type === 'error')
  assert.equal(refused.status, 400)
  assert.match(refused.message, /开场白不能继续生成/)
  const missing = (await stream('continue', { nodeId: 'nope' })).find(event => event.type === 'error')
  assert.equal(missing.status, 404)
})

test('joining: a start that repeats the end goes; a space at the cut is not doubled; anything else is put on as it is', () => {
  assert.equal(joinContinued('她推开门，雨丝斜斜地扑进来。', '雨丝斜斜地扑进来。她回头。'), '她推开门，雨丝斜斜地扑进来。她回头。')
  assert.equal(joinContinued('第一段。\n\n', '\n\n第二段。'), '第一段。\n\n第二段。')
  assert.equal(joinContinued('她说：「我', '们走吧。」'), '她说：「我们走吧。」')
  // A short echo (fewer than 8 characters) is too likely to be the story's own words.
  assert.equal(joinContinued('他笑了。', '他笑了。又笑了。'), '他笑了。他笑了。又笑了。')
})
