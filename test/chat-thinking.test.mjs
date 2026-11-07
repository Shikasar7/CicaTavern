// A chat's own 思考 (the top bar beside its model): kept with the chat, and what the page needs to say what 默认 comes to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-thinking-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(() => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
  })
  return async (where, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${where}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return res.json()
  }
}

test('a chat keeps its own 思考, and the models list says what each follows by default', async t => {
  const call = await tavern(t)
  const local = await call('/providers', 'POST', { name: '本机', api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'x', models: ['m1'], thinking: 'off' })
  const claude = await call('/providers', 'POST', { name: 'Anthropic', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKey: 'x', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] })
  await call('/settings', 'PUT', { model: `${local.id}/m1`, thinking: 'adaptive', effort: 'high' })
  const models = await call('/models')
  assert.deepEqual(models.reasoning, { thinking: 'adaptive', effort: 'high' })
  const of = id => models.choices.find(choice => choice.id === id)
  assert.equal(of(`${local.id}/m1`).thinkingOff, true)
  assert.deepEqual([of(`${claude.id}/claude-opus-5-5`).claude, of(`${claude.id}/claude-opus-5-5`).alwaysThinks], [true, true])
  assert.deepEqual([of(`${claude.id}/claude-sonnet-5-5`).claude, of(`${claude.id}/claude-sonnet-5-5`).alwaysThinks], [true, undefined])
  const haiku = await call('/providers', 'POST', { name: 'Anthropic 2', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKey: 'x', models: ['claude-haiku-4-5'], thinking: 'off' })
  const choice = (await call('/models')).choices.find(item => item.id === `${haiku.id}/claude-haiku-4-5`)
  assert.deepEqual([choice.noThinking, choice.thinkingOff], [true, undefined], "a provider's 关闭 does not reach Claude; Haiku 4.5 takes none of it")

  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '小雨', description: '女孩。', first_mes: '你好。' } }
  const made = await call('/cards/import', 'POST', { filename: 'c.json', data: Buffer.from(JSON.stringify(card)).toString('base64') })
  const chat = await call('/chats', 'POST', { cardId: made.card?.id ?? made.id })
  assert.equal(chat.thinking, null, 'a new chat follows')
  assert.equal((await call(`/chats/${chat.id}`, 'PUT', { thinking: 'xhigh' })).thinking, 'xhigh')
  assert.equal((await call(`/chats/${chat.id}`)).thinking, 'xhigh')
  assert.equal((await call(`/chats/${chat.id}`, 'PUT', { title: '改名' })).thinking, 'xhigh', 'other changes leave it')
  assert.equal((await call(`/chats/${chat.id}`, 'PUT', { thinking: 'off' })).thinking, 'off')
  assert.equal((await call(`/chats/${chat.id}`, 'PUT', { thinking: 'loud' })).thinking, null, 'nothing it knows: back to following')
  const settings = await call('/settings')
  assert.deepEqual([settings.thinking, settings.effort], ['adaptive', 'high'], 'the settings untouched')
})
