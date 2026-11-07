// 直连对话: a chat with no card, on a hidden one, with nothing of a story in what the model reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { booksForCard } from '../server/chats.mjs'
import { directSummaryInstruction, recapBlock } from '../server/recap.mjs'
import { markdownHtml } from '../web/render.js'
import { DIRECT_CARD } from '../web/shared/basic.js'

/** A model that says one thing and keeps what it was sent; the app around it, with one provider set up. */
async function setup(t) {
  const seen = []
  const model = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好的。' }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-direct-'))
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
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    const data = await res.json().catch(() => null)
    assert.ok(res.ok, `${method} ${pathname}: ${JSON.stringify(data)}`)
    return data
  }
  const turn = async (chatId, body) => {
    const res = await fetch(`${base}/api/chats/${chatId}/turn`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: JSON.stringify(body) })
    const events = (await res.text()).trim().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    return events.at(-1)
  }
  const added = await call('/api/providers', { method: 'POST', body: { name: 'Fake', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'sk-test', models: ['m1'] } })
  const provider = added.id ?? added.providers.at(-1).id
  await call('/api/settings', { method: 'PUT', body: { model: `${provider}/m1` } })
  return { call, turn, seen }
}

const sent = body => body.messages.at(-1).content
const system = body => body.messages.find(message => message.role === 'system')?.content ?? ''

test('the hidden card is there to open but in no list, and the page is told it can', async t => {
  const { call } = await setup(t)
  assert.deepEqual(await call('/api/cards'), [])
  assert.equal((await call(`/api/cards/${DIRECT_CARD}`)).id, DIRECT_CARD)
  assert.equal((await call('/api/status')).features.direct, true)
})

test('the model reads no story: a plain assistant prompt, the words as typed, and no book', async t => {
  const { call, turn, seen } = await setup(t)
  const chat = await call('/api/chats', { method: 'POST', body: { cardId: DIRECT_CARD } })
  assert.equal(chat.names.char, '助手')
  const end = await turn(chat.id, { parentId: chat.path.at(-1).id, input: '1+1 等于几？' })
  assert.equal(end.type, 'done')
  assert.match(system(seen[0]), /AI 助手/)
  assert.doesNotMatch(system(seen[0]), /叙述者|互动小说|玩家/)
  assert.equal(sent(seen[0]), '1+1 等于几？')
  assert.deepEqual(await booksForCard({ getSettings: async () => ({ globalBookIds: ['x'] }) }, { direct: true }), [])
  await turn(chat.id, { parentId: end.nodeId, input: '再加 1 呢？' })
  assert.deepEqual(seen[1].messages.filter(message => message.role !== 'system').map(message => message.content), ['1+1 等于几？', '好的。', '再加 1 呢？'])
})

test('a file goes with its message and stays in the history; the chat keeps its name, not its text', async t => {
  const { call, turn, seen } = await setup(t)
  const chat = await call('/api/chats', { method: 'POST', body: { cardId: DIRECT_CARD } })
  const file = await call('/api/forge/references', { method: 'POST', body: { name: '设定.txt', text: '听雨茶馆只卖清茶。' } })
  const end = await turn(chat.id, { parentId: chat.path.at(-1).id, input: '总结一下', files: [file] })
  assert.match(sent(seen[0]), /^<references>\n<reference type="文件" name="设定.txt">\n听雨茶馆只卖清茶。\n<\/reference>\n<\/references>\n\n总结一下$/)
  const asked = end.chat.path.at(-2)
  assert.equal(asked.text, '总结一下')
  assert.deepEqual(asked.files, [{ name: '设定.txt', kind: 'file', chars: 9 }])
  await turn(chat.id, { parentId: end.nodeId, input: '它卖什么？' })
  assert.match(seen[1].messages.find(message => message.role === 'user').content, /听雨茶馆只卖清茶/)
})

test('what is attached here is read as it is, whole or broken; 创作角色卡 turns the broken one away', async t => {
  const { call, turn, seen } = await setup(t)
  const chat = await call('/api/chats', { method: 'POST', body: { cardId: DIRECT_CARD } })
  const whole = JSON.stringify({ spec: 'chara_card_v3', data: { name: '别人的卡', description: '听雨茶馆只卖清茶。', first_mes: '你来了。' } })
  const broken = whole.slice(0, -3)
  const card = await call('/api/forge/references', { method: 'POST', body: { name: 'a.json', text: whole, direct: true } })
  const file = await call('/api/forge/references', { method: 'POST', body: { name: 'b.json', text: broken, direct: true } })
  await turn(chat.id, { parentId: chat.path.at(-1).id, input: '总结一下', files: [card, file] })
  assert.equal(sent(seen[0]).match(/听雨茶馆只卖清茶/g).length, 2)
  await assert.rejects(call('/api/forge/references', { method: 'POST', body: { name: 'b.json', text: broken } }), /看起来是角色卡/)
  await assert.rejects(call('/api/forge', { method: 'POST', body: { text: '做张卡', references: [{ kind: 'file', name: 'b.json', text: broken }] } }), /看起来是角色卡/)
  // As SillyTavern exports one: cut before anything but the plain fields.
  const cut = '{"name":"别人的卡","description":"听雨茶馆只卖清茶。","personality":"话少","scenario":"雨夜'
  assert.equal((await call('/api/forge/references', { method: 'POST', body: { name: 'c.json', text: cut, direct: true } })).kind, 'file')
  await assert.rejects(call('/api/forge/references', { method: 'POST', body: { name: 'c.json', text: cut } }), /看起来是角色卡/)
  await assert.rejects(call('/api/forge', { method: 'POST', body: { text: '做张卡', references: [{ kind: 'file', name: 'c.json', text: cut }] } }), /看起来是角色卡/)
})

test('编辑重发 gets a message\'s files back, and a compaction there writes a summary, not a story', async t => {
  const { call, turn } = await setup(t)
  const chat = await call('/api/chats', { method: 'POST', body: { cardId: DIRECT_CARD } })
  const file = await call('/api/forge/references', { method: 'POST', body: { name: '设定.txt', text: '听雨茶馆只卖清茶。' } })
  const end = await turn(chat.id, { parentId: chat.path.at(-1).id, input: '总结一下', files: [file] })
  const asked = end.chat.path.at(-2)
  const { files } = await call(`/api/chats/${chat.id}/messages/${asked.id}/files`)
  assert.deepEqual(files.map(item => [item.name, item.kind, item.text, item.chars, item.total]), [['设定.txt', 'file', '听雨茶馆只卖清茶。', 9, 9]])
  assert.equal(asked.text, '总结一下')
  assert.equal(end.chat.path.at(-2).files[0].text, undefined, 'the page does not carry it around')
  assert.match(directSummaryInstruction(), /<剧情存档>/)
  assert.doesNotMatch(directSummaryInstruction(), /人物|伏笔|故事/)
  assert.match(recapBlock('摘要', '', { direct: true }), /接着回答用户/)
  assert.match(recapBlock('摘要', ''), /故事已经进行了一段时间/)
})

test('a reply is Markdown: lists, tables, quotes and code, and nothing the model wrote runs', () => {
  assert.equal(markdownHtml('- 甲\n  - 甲一\n- 乙'), '<ul><li>甲<ul><li>甲一</li></ul></li><li>乙</li></ul>')
  assert.equal(markdownHtml('2. 二\n\n3. 三'), '<ol start="2"><li>二</li><li>三</li></ol>')
  assert.equal(markdownHtml('# 标题'), '<h3>标题</h3>')
  assert.equal(markdownHtml('> 引用'), '<blockquote><p>引用</p></blockquote>')
  assert.match(markdownHtml('| 名 | 值 |\n|---|---|\n| a | **1** |'), /<th>名<\/th>.*<td><strong>1<\/strong><\/td>/)
  assert.equal(markdownHtml('```js\nconst a = "<b>"\n```'), '<pre class="code"><code>const a = &quot;&lt;b&gt;&quot;</code></pre>')
  assert.equal(markdownHtml('```\n写到一半'), '<pre class="code"><code>写到一半</code></pre>', 'a fence still open')
  assert.equal(markdownHtml('<img src=x onerror=alert(1)> **粗**'), '<p>&lt;img src=x onerror=alert(1)&gt; <strong>粗</strong></p>')
  assert.equal(markdownHtml('[好](https://a.test/x?a=1&b=2) [坏](javascript:alert(1))'), '<p><a href="https://a.test/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">好</a> [坏](javascript:alert(1))</p>')
  assert.equal(markdownHtml('第一行\n第二行'), '<p>第一行<br>第二行</p>')
})

test('too much at once is refused before anything is asked, and a chat of a card takes no files', async t => {
  const { call, turn, seen } = await setup(t)
  const chat = await call('/api/chats', { method: 'POST', body: { cardId: DIRECT_CARD } })
  const many = Array.from({ length: 7 }, () => ({ name: 'a.txt', text: '字' }))
  const refused = await turn(chat.id, { parentId: chat.path.at(-1).id, input: '看看', files: many })
  assert.equal(refused.type, 'error')
  assert.equal(seen.length, 0)
  const data = Buffer.from(JSON.stringify({ name: '林雪', description: '掌柜', first_mes: '又下雨了。' })).toString('base64')
  const card = await call('/api/cards/import', { method: 'POST', body: { filename: 'c.json', data } })
  const story = await call('/api/chats', { method: 'POST', body: { cardId: card.id } })
  await turn(story.id, { parentId: story.path.at(-1).id, input: '你好', files: [{ name: 'a.txt', text: '不该发出去' }] })
  assert.doesNotMatch(sent(seen[0]), /不该发出去/)
  assert.match(system(seen[0]), /叙述者/)
})
