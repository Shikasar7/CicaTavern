// 删除: one message goes from the chat and from what the model reads; the rest stays where it is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { activePath, chatView, deleteMessage, forgetDeleted } from '../server/chats.mjs'
import { withoutHidden } from '../server/recap.mjs'

/** root → u1 → a1 → u2 → a2, with a second version of a2 where asked. */
function story({ versions = false, compacted = false } = {}) {
  const nodes = {
    root: { id: 'root', role: 'assistant', text: '开场', display: '开场', createdAt: '1' },
    u1: { id: 'u1', parent: 'root', role: 'user', text: '第一句', prompt: '第一句', createdAt: '2' },
    a1: { id: 'a1', parent: 'u1', role: 'assistant', text: '回复一', display: '回复一', createdAt: '3', ...(compacted ? { compaction: { summary: '摘要', turns: 1 } } : {}) },
    u2: { id: 'u2', parent: 'a1', role: 'user', text: '第二句', prompt: '第二句', createdAt: '4' },
    a2: { id: 'a2', parent: 'u2', role: 'assistant', text: '回复二', display: '回复二', createdAt: '5' },
    ...(versions ? { a3: { id: 'a3', parent: 'u2', role: 'assistant', text: '回复二新版', display: '回复二新版', createdAt: '6' } } : {}),
  }
  return { id: 'c', cardId: 'k', title: 't', names: { char: '林雪', user: '你' }, nodes, tips: {}, systemPrompt: '' }
}
const ids = chat => chatView(chat).path.map(node => node.id)

test('a reply or the player\'s words go alone, and the next turn still follows the latest reply', () => {
  const chat = story()
  deleteMessage(chat, 'a2')
  assert.deepEqual(ids(chat), ['root', 'u1', 'a1', 'u2'])
  assert.equal(chatView(chat).replyTip, 'a2', 'the turn goes on from there')
  assert.equal(chat.stateDirty, true)
  const other = story()
  deleteMessage(other, 'u2')
  assert.deepEqual(ids(other), ['root', 'u1', 'a1', 'a2'])
  assert.deepEqual(withoutHidden(activePath(other)).map(node => node.id), ['root', 'u1', 'a1', 'a2'])
})

test('undone it is back where it was; once the story goes on its words are gone for good', () => {
  const chat = story()
  deleteMessage(chat, 'u2')
  deleteMessage(chat, 'u2', false)
  assert.deepEqual(ids(chat), ['root', 'u1', 'a1', 'u2', 'a2'])
  assert.equal(chat.nodes.u2.deleted, undefined)
  deleteMessage(chat, 'u2')
  forgetDeleted(chat)
  assert.deepEqual([chat.nodes.u2.text, chat.nodes.u2.prompt, chat.nodes.a1.text], ['', '', '回复一'])
})

test('a version gives way to the one beside it, which then shows no other', () => {
  const chat = story({ versions: true })
  assert.equal(chatView(chat).path.at(-1).id, 'a3')
  deleteMessage(chat, 'a3')
  const view = chatView(chat)
  assert.equal(view.path.at(-1).id, 'a2')
  assert.equal(view.path.at(-1).siblingCount, 1)
  deleteMessage(chat, 'a3', false)
  assert.equal(chatView(chat).path.at(-1).id, 'a3', 'back to the one that was showing')
})

test('the opening and what was compacted say why they cannot go', () => {
  assert.throws(() => deleteMessage(story(), 'root'), /开场不能删除/)
  assert.throws(() => deleteMessage(story({ compacted: true }), 'a1'), /压缩点/)
  assert.throws(() => deleteMessage(story({ compacted: true }), 'u1'), /在上次压缩之前/)
  const chat = story({ compacted: true })
  deleteMessage(chat, 'u2')
  assert.deepEqual(ids(chat), ['root', 'u1', 'a1', 'a2'], 'what came after it can')
  assert.throws(() => deleteMessage(story(), 'nope'), /不在当前对话/)
})

test('what the model reads takes turns, whatever was deleted, and nothing deleted is in it', async t => {
  const seen = []
  const model = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `回复${seen.length}` }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-delete-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    model.closeAllConnections?.()
    model.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const call = async (pathname, method = 'GET', body) => (await fetch(`${base}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined })).json()
  const turn = async (id, body) => {
    const res = await fetch(`${base}/api/chats/${id}/turn`, { method: 'POST', headers, body: JSON.stringify(body) })
    return (await res.text()).trim().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).at(-1)
  }
  const added = await call('/api/providers', 'POST', { name: 'Fake', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'sk-test', models: ['m1'] })
  await call('/api/settings', 'PUT', { model: `${added.id ?? added.providers.at(-1).id}/m1` })
  let chat = await call('/api/chats', 'POST', { cardId: 'direct' })
  let end = await turn(chat.id, { parentId: chat.path.at(-1).id, input: '第一句' })
  end = await turn(chat.id, { parentId: end.nodeId, input: '第二句' })
  const [first, , second, reply] = end.chat.path.filter(node => node.id !== 'root')
  chat = await call(`/api/chats/${chat.id}/delete-message`, 'POST', { nodeId: first.id })
  chat = await call(`/api/chats/${chat.id}/delete-message`, 'POST', { nodeId: reply.id })
  assert.equal(chat.replyTip, reply.id)
  end = await turn(chat.id, { parentId: chat.replyTip, input: '第三句' })
  assert.equal(end.type, 'done')
  const roles = seen.at(-1).messages.filter(message => message.role !== 'system')
  assert.deepEqual(roles.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  assert.deepEqual(roles.map(message => message.content), ['（这条消息已删除）', '回复1', '第二句', '（这条消息已删除）', '第三句'])
  assert.ok(second)
  assert.equal((await call(`/api/chats/${chat.id}/delete-message`, 'POST', { nodeId: end.chat.path.at(-1).id, deleted: false })).id, chat.id)
})
