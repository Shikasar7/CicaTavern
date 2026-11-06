// What a review before 2.3.3 found: a deleted message reaching further than it should, and what a new version or a dead run left.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { activePath, chatSummary, chatView, deleteMessage, forgetDeleted } from '../server/chats.mjs'
import { createApp } from '../server/http.mjs'
import { turnTexts } from '../server/memory.mjs'
import { createMusic } from '../server/music.mjs'
import { keepToSchema, onSchemaProblem } from '../server/schema.mjs'
import { createStore } from '../server/store.mjs'

/** root → u1 → { old, a1 } → (a1) u2 → a2: a reply with a version beside it, and the story going on from it. */
function story() {
  const nodes = {
    root: { id: 'root', role: 'assistant', text: '开场', display: '开场', createdAt: '1' },
    u1: { id: 'u1', parent: 'root', role: 'user', text: '第一句', prompt: '第一句', createdAt: '2' },
    old: { id: 'old', parent: 'u1', role: 'assistant', text: '旧版本', display: '旧版本', createdAt: '3' },
    a1: { id: 'a1', parent: 'u1', role: 'assistant', text: '新版本', display: '新版本', createdAt: '4' },
    u2: { id: 'u2', parent: 'a1', role: 'user', text: '第二句', prompt: '第二句', createdAt: '5' },
    a2: { id: 'a2', parent: 'u2', role: 'assistant', text: '后面的故事', display: '后面的故事', createdAt: '6' },
  }
  return { id: 'c', cardId: 'k', title: 't', names: { char: '林雪', user: '你' }, nodes, tips: {}, systemPrompt: '' }
}
const ids = chat => chatView(chat).path.map(node => node.id)

test('a version the story goes on from goes alone: what came after it stays', () => {
  const chat = story()
  deleteMessage(chat, 'a1')
  assert.deepEqual(ids(chat), ['root', 'u1', 'u2', 'a2'])
  deleteMessage(chat, 'a1', false)
  assert.deepEqual(ids(chat), ['root', 'u1', 'a1', 'u2', 'a2'])
})

test('once the next turn has cleared its words a message does not come back empty', () => {
  const chat = story()
  deleteMessage(chat, 'u2')
  forgetDeleted(chat)
  assert.throws(() => deleteMessage(chat, 'u2', false), /不能恢复/)
  assert.equal(chat.nodes.u2.deleted, true)
})

test('the chat list and the 记忆簿 read what is left', () => {
  const chat = story()
  deleteMessage(chat, 'a2')
  assert.equal(chatSummary(chat).preview, '第二句')
  assert.deepEqual(turnTexts(activePath(chat)).map(({ user, reply }) => [user, reply]), [['第一句', '新版本'], ['第二句', '']])
  deleteMessage(chat, 'u2')
  assert.deepEqual(turnTexts(activePath(chat)).map(item => item.turn), [1])
})

test('a schema sandbox that cannot start leaves the state as it is, and the turn goes on', () => {
  const said = []
  onSchemaProblem(message => said.push(message))
  const state = { 金币: 3 }
  // No initTemplates here: this process has no QuickJS, as a phone that could not load it.
  assert.deepEqual(keepToSchema('registerMvuSchema(z.object({}))', state), { state })
  assert.match(said[0], /not initialised/)
  onSchemaProblem(() => {})
})

test('a newer version of a card takes the older one\'s music, and the older one keeps it', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-music-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root, { subscription: false })
  await store.ensure?.()
  const save = id => store.saveCard({ id, name: id, hasAvatar: false })
  await save('older')
  await save('newer')
  const music = createMusic(store)
  const track = await music.add('older', { name: '雨', use: 'story', data: `data:audio/mpeg;base64,${Buffer.from('歌').toString('base64')}` })
  await music.inherit('older', 'newer')
  assert.deepEqual((await music.list('newer')).tracks, [track])
  assert.equal(String((await music.readTrack('newer', track.file)).data), '歌')
  assert.deepEqual((await music.list('older')).tracks, [track])
  await music.inherit('newer', 'older')
  assert.equal((await music.list('older')).tracks.length, 1)
})

test('regenerating from a deleted message is refused, and a trial no run owns is gone from the list and the folder', async t => {
  const model = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '回复' }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-review-'))
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
  const turn = async (body, route = 'turn') => {
    const res = await fetch(`${base}/api/chats/${chat.id}/${route}`, { method: 'POST', headers, body: JSON.stringify(body) })
    return (await res.text()).trim().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).at(-1)
  }
  const added = await call('/api/providers', 'POST', { name: 'Fake', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'sk-test', models: ['m1'] })
  await call('/api/settings', 'PUT', { model: `${added.id ?? added.providers.at(-1).id}/m1` })
  const card = await call('/api/cards/import', 'POST', { filename: 'c.json', data: Buffer.from(JSON.stringify({ name: '林雪', first_mes: '雨夜。' })).toString('base64') })
  const chat = await call('/api/chats', 'POST', { cardId: card.id })
  const done = await turn({ parentId: chat.path.at(-1).id, input: '第一句' })
  const user = done.chat.path.find(node => node.role === 'user')
  await call(`/api/chats/${chat.id}/delete-message`, 'POST', { nodeId: user.id })
  const again = await turn({ userNodeId: user.id }, 'regenerate')
  assert.equal(again.type, 'error')
  assert.match(JSON.stringify(again), /不能从它重新生成/)

  const stray = await call('/api/chats', 'POST', { cardId: card.id })
  const store = createStore(root, { subscription: false })
  await store.saveChat({ ...await store.getChat(stray.id), trial: true })
  const listed = await call(`/api/chats?cardId=${card.id}`)
  assert.deepEqual(listed.map(item => item.id), [chat.id])
  assert.equal((await store.listChats(card.id)).some(item => item.id === stray.id), false)
})
