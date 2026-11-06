// A relay set up for /chat/completions, reached through the Responses API: what the player is told, and that the
// change it names works.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createApp } from '../server/http.mjs'
import { providerError, unreadReply } from '../server/providers.mjs'

const CHANGE_IT = /接口类型改成「OpenAI 兼容（Chat Completions）」/
const OVERRIDE = { error: { message: 'operation append failed: operation not supported for type: Null (request id: 1)', type: 'new_api_error', param: '', code: 'channel:param_override_invalid' } }
const chunk = body => `data: ${JSON.stringify(body)}\n\n`

async function relay(t, responses) {
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    if (req.url.endsWith('/responses')) return responses(res)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(chunk({ choices: [{ delta: { content: '雨停了。' }, finish_reason: null }] }))
    res.write(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-relay-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const listening = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    listening.closeAllConnections?.()
    listening.close()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${listening.address().port}`
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const call = async (pathname, method = 'GET', body) => (await fetch(`${base}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined })).json()
  const fields = { name: '橘子', api: 'openai-responses', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: ['g4'] }
  const added = await call('/api/providers', 'POST', fields)
  const id = added.id ?? added.providers.at(-1).id
  await call('/api/settings', 'PUT', { model: `${id}/g4` })
  const chat = await call('/api/chats', 'POST', { cardId: 'direct' })
  const turn = async () => {
    const res = await fetch(`${base}/api/chats/${chat.id}/turn`, { method: 'POST', headers, body: JSON.stringify({ parentId: chat.path.at(-1).id, input: '你好' }) })
    return (await res.text()).trim().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).at(-1)
  }
  return { turn, useCompletions: () => call(`/api/providers/${id}`, 'PUT', { ...fields, api: 'openai-completions' }) }
}

test('a channel\'s parameter override failing on a Responses request names the change, and the change works', async t => {
  const { turn, useCompletions } = await relay(t, res => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify(OVERRIDE))
  })
  const refused = await turn()
  assert.equal(refused.type, 'error')
  assert.match(refused.error ?? refused.message, CHANGE_IT)
  assert.doesNotMatch(refused.error ?? refused.message, /是对方的问题/)
  await useCompletions()
  assert.equal((await turn()).type, 'done')
})

test('a stream with nothing of the Responses API in it says so, instead of "no text"', async t => {
  const { turn } = await relay(t, res => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(chunk({ choices: [{ delta: { content: '别的格式' }, finish_reason: null }] }))
    res.end('data: [DONE]\n\n')
  })
  const end = await turn()
  assert.equal(end.type, 'error')
  assert.match(end.error ?? end.message, CHANGE_IT)
})

test('only that: other providers, and a Responses reply that really came back empty, keep their words', () => {
  const failed = Object.assign(new Error(OVERRIDE.error.message), { providerStatus: 500 })
  assert.match(providerError({ name: '橘子', api: 'openai-completions' }, failed), /是对方的问题/)
  assert.match(providerError({ name: '橘子', api: 'openai-responses' }, Object.assign(new Error('Internal error'), { providerStatus: 500 })), /是对方的问题/)
  const responses = { name: '橘子', api: 'openai-responses' }
  assert.match(unreadReply(responses, { text: '', stopReason: null, usage: null }), CHANGE_IT)
  assert.equal(unreadReply(responses, { text: '', stopReason: 'completed', usage: null }), null)
  assert.equal(unreadReply(responses, { text: '', stopReason: null, usage: { input: 1 } }), null)
  assert.equal(unreadReply(responses, { text: '有字', stopReason: null, usage: null }), null)
  assert.equal(unreadReply({ name: '橘子', api: 'openai-completions' }, { text: '', stopReason: null, usage: null }), null)
})
