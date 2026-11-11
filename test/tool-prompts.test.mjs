// 内置功能的附加提示词: the player's own words for the model calls outside the story, by group, after the
// task's own instructions and before (or with a word on) its output format.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, createChat } from '../server/chats.mjs'
import { cleanToolPrompts, toolNote, withToolNote } from '../server/context.mjs'
import { createEngine } from '../server/engine.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { directSummaryInstruction, summaryInstruction } from '../server/recap.mjs'
import { createStore } from '../server/store.mjs'

const textOf = content => (typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''))
const lastText = request => textOf(request.messages.at(-1).content)
const systemOf = request => textOf(request.messages.find(m => m.role === 'system')?.content ?? '')

test('kept as a text per group; a note only when there is one', () => {
  assert.deepEqual(cleanToolPrompts(null), { memory: '', check: '', forge: '', helper: '' })
  assert.deepEqual(cleanToolPrompts({ memory: 'a', check: 3, nope: 'x' }), { memory: 'a', check: '', forge: '', helper: '' })
  assert.equal(cleanToolPrompts({ forge: 'x'.repeat(9000) }).forge.length, 8000)
  assert.equal(toolNote({ toolPrompts: { memory: '  ' } }, 'memory'), '')
  const note = toolNote({ toolPrompts: { check: '不要说教' } }, 'check')
  assert.match(note, /^<玩家的附加要求>\n不要说教\n<\/玩家的附加要求>\n.*以任务说明和输出格式为准/)
  const request = { system: '只输出 JSON。', messages: [] }
  assert.equal(withToolNote(request, ''), request)
  assert.equal(withToolNote(request, note).system, `只输出 JSON。\n\n${note}`)
})

test('the archive request: the note before the format line, names filled in', () => {
  const note = toolNote({ toolPrompts: { memory: '记住{{char}}的口头禅' } }, 'memory')
  const asked = summaryInstruction({ user: '旅人', char: '林雪' }, '', note)
  assert.match(asked, /记住林雪的口头禅\n<\/玩家的附加要求>[\s\S]*以任务说明和输出格式为准。\n只输出存档本身，放在 <剧情存档> 和 <\/剧情存档> 之间。$/)
  assert.equal(summaryInstruction({ user: '旅人', char: '林雪' }), summaryInstruction({ user: '旅人', char: '林雪' }, '', ''), 'none: as it was')
  assert.match(summaryInstruction({ user: '旅人', char: '林雪' }, '<记忆条目>…', note), /口头禅[\s\S]*先写存档，放在[\s\S]*<记忆条目>…$/)
  assert.match(directSummaryInstruction(note), /口头禅[\s\S]*\n只输出摘要本身/)
})

/** An OpenAI-compatible model that answers with `answer(request)` (else a story reply). */
async function fakeModel(t, answer) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    requests.push(request)
    const text = answer(request) ?? `第${requests.length}次回复。`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

const ARCHIVE = `<剧情存档>\n${'你在旧邮局遇见了林雪，她把祖母的怀表交给你保管。'.repeat(10)}\n</剧情存档>`
const ENTRIES = '<记忆条目>\n[人物] 林雪 | 林雪\n邮局职员。\n</记忆条目>'

async function setup(t, settings) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-tool-prompts-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const fake = await fakeModel(t, request => {
    const last = lastText(request)
    if (last.includes('【暂停扮演：剧情存档】')) return `${ARCHIVE}\n\n${ENTRIES}`
    if (request.messages.some(m => textOf(m.content).includes('<原文>'))) return ENTRIES
    if (systemOf(request).includes('只输出 JSON')) return '{}'
    return null
  })
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: fake.baseURL, apiKey: 'sk-test', models: [{ id: 'm1' }, { id: 'helper' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off', media: { helperModel: `${provider.id}/helper` }, ...settings })
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', description: '林雪是邮局职员。', first_mes: '雪下了一整夜。' } })
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null })
  const chat = await createChat(store, card.id)
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    return engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})
  }
  return { store, engine, chat, turn, fake, card }
}

test('compaction and the tidy carry the memory note; the story turns do not', async t => {
  const memory = '每条记忆写上{{user}}当时的心情'
  const { engine, chat, turn, fake } = await setup(t, { memory: { enabled: true, tidy: { enabled: true, every: 5 } }, toolPrompts: { memory, forge: '别管我' } })
  await turn('去邮局')
  await turn('收下怀表')
  for (const request of fake.requests) assert.ok(!JSON.stringify(request).includes('当时的心情'), 'not in a story turn')
  await engine.compactChat(chat.id)
  assert.match(lastText(fake.requests.at(-1)), /每条记忆写上你当时的心情[\s\S]*只输出存档本身|每条记忆写上[\s\S]+当时的心情[\s\S]*先写存档/)
  let last
  for (const input of ['一', '二', '三', '四', '五']) last = await turn(input)
  assert.equal(await engine.tidyMemory(chat.id, last.nodeId), true)
  const tidy = fake.requests.at(-1)
  assert.match(systemOf(tidy), /<玩家的附加要求>\n每条记忆写上.+当时的心情/, 'the helper: after its system prompt')
  assert.ok(!JSON.stringify(fake.requests).includes('别管我'), 'another group\'s note stays out')
})

test('the helper calls (游戏规则) carry the helper note', async t => {
  const { engine, card, fake } = await setup(t, { toolPrompts: { helper: '规则用武侠的叫法' } })
  await engine.suggestRules(card.id).catch(() => {})
  assert.match(systemOf(fake.requests.at(-1)), /规则用武侠的叫法/)
})
