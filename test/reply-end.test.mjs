// How a reply ended: whose doing it was when it stopped midway, what that changes, and what the page hears meanwhile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { complete, normalizeProvider } from '../server/providers.mjs'
import { stopsMidway, surelyAtGate, upstreamCut, waitsForRest } from '../server/reply-end.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5 }
const gemini = (text, finishReason) => `data: ${JSON.stringify({ modelVersion: 'm1', usageMetadata, candidates: [{ content: { parts: text ? [{ text }] : [] }, ...(finishReason ? { finishReason } : {}) }] })}\n\n`
const openai = (text, finish_reason = null) => `data: ${JSON.stringify({ model: 'm1', choices: [{ delta: text ? { content: text } : {}, finish_reason }] })}\n\n`
const anthropic = (type, rest) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`
const said = text => anthropic('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
const begun = anthropic('message_start', { message: { model: 'm1', usage: { input_tokens: 20, output_tokens: 1 } } }) + anthropic('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })

/** A provider that answers each request with the next of `answers` (the last again after them); a number is a wait. */
async function provider(t, api, answers) {
  const asked = []
  const closed = { early: 0 }
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    asked.push(JSON.parse(body))
    res.on('close', () => { if (!res.writableFinished) closed.early += 1 })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const piece of answers[Math.min(asked.length, answers.length) - 1]) {
      if (res.destroyed) return
      if (typeof piece === 'number') await sleep(piece)
      else res.write(piece)
    }
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  const made = normalizeProvider({ name: 'Fake', api, baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test-1234567890abcd', models: [{ id: 'm1' }] })
  return { made, asked, closed }
}

async function app(t, { api = 'google-generative', answers, card = {}, timeout = 0 }) {
  const { made, asked, closed } = await provider(t, api, answers)
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-end-'))
  const store = createStore(dataRoot)
  await store.init()
  // Shorter than a player may set it, so saved as it is.
  await store.saveProviders([{ ...made, timeout }])
  await store.saveSettings({ model: `${made.id}/m1`, subscription: 'off' })
  const saved = normalizeCard({ spec: 'chara_card_v2', data: { name: '小雨', first_mes: '你好', ...card } })
  await store.saveCard(saved)
  const running = await createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const listening = await running.listen({ port: 0 })
  t.after(async () => {
    running.network.stop()
    listening.closeAllConnections?.()
    listening.close()
    await rm(dataRoot, { recursive: true, force: true }).catch(() => {})
  })
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const base = `http://127.0.0.1:${listening.address().port}`
  const call = async (where, method = 'GET', body) => (await fetch(`${base}${where}`, { method, headers, body: body ? JSON.stringify(body) : undefined })).json()
  const chat = await call('/api/chats', 'POST', { cardId: saved.id })
  const turn = async () => {
    const text = await (await fetch(`${base}/api/chats/${chat.id}/turn`, { method: 'POST', headers, body: JSON.stringify({ parentId: 'root', input: '走吧' }) })).text()
    const events = text.split('\n\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    const done = events.find(event => event.type === 'done')
    return { events, done, reply: done?.chat.path.at(-1) }
  }
  return { turn, call, asked, closed, card: saved }
}

const MVU = { post_history_instructions: '每轮结尾写 <UpdateVariable> 变量更新块' }
const BLOCK = '<UpdateVariable>\n<JSONPatch>[]</JSONPatch>\n</UpdateVariable>'

test('a reply that stops in the middle: a tag, a comma, or a word where more is due', () => {
  for (const text of ['她说<font color="#9400', '她笑了。</', '她抬起头，', '她说：“']) assert.equal(stopsMidway(text), true, text)
  for (const text of ['她笑了。', '她笑了。</content>', '温度 < 3', '她推开门', 'x < y', '结束\n```', '']) assert.equal(stopsMidway(text), false, text)
  assert.equal(stopsMidway('她推开门，躺在', { more: true }), true)
  for (const text of ['D. 留在原地护住她', '时间：清晨', '地点 | 客栈', '- 一把伞', '她笑了。']) assert.equal(stopsMidway(text, { more: true }), false, text)
})

test('whose doing it was, by the reason the API gave', () => {
  const cut = (text, end, more) => upstreamCut(text, end, { more })
  for (const stop of ['SAFETY', 'PROHIBITED_CONTENT', 'RECITATION', 'content_filter', 'refusal']) assert.equal(cut('她笑了。', { stop, ended: true }), 'filtered', stop)
  assert.equal(cut('她抬起头，', { stop: null, ended: false }), 'dropped')
  assert.equal(cut('她抬起头，', { stop: 'OTHER', ended: true }), 'dropped')
  assert.equal(cut('她抬起头，', { stop: 'STOP', ended: true }), 'halfway')
  assert.equal(cut('她抬起头，', { stop: null, ended: true }), 'halfway')
  // Relays that never say it is over: a reply that reads whole is.
  assert.equal(cut('她笑了。', { stop: null, ended: false }), null)
  assert.equal(cut('她推开门', { stop: 'STOP', ended: true }), null)
  // The story is whole, only its block is not: 补写变量 makes up for that. A whole block: nothing is missing.
  assert.equal(cut('她笑了。\n<UpdateVariable>\n{"op": "re', { stop: null, ended: false }, true), null)
  assert.equal(cut(`她笑了。\n${BLOCK}`, { stop: 'SAFETY', ended: true }, true), null)
  assert.deepEqual(['paused', 'filtered', 'dropped', 'halfway', true, 'broken', undefined].map(waitsForRest), [true, true, true, true, false, false, false])
})

test('kept back by the content check: marked, the reason kept, and no 补写变量 on half a story', async t => {
  const { turn, asked } = await app(t, { card: MVU, answers: [[gemini('她抬起头看着你，慢慢'), gemini('', 'SAFETY')], [gemini(BLOCK, 'STOP')]] })
  const { events, done, reply } = await turn()
  assert.equal(reply.truncated, 'filtered')
  assert.equal(reply.stop, 'SAFETY')
  assert.equal(reply.text, '她抬起头看着你，慢慢')
  assert.equal(done.cut, undefined)
  assert.equal(asked.length, 1, 'nothing more is asked')
  assert.equal(events.some(event => event.type === 'filling'), false)
})

test('the stream closed with no word that it was over', async t => {
  const { turn, asked } = await app(t, { card: MVU, answers: [[gemini('她抬起头看着你，慢慢')]] })
  const { reply } = await turn()
  assert.deepEqual([reply.truncated, reply.stop, asked.length], ['dropped', undefined, 1])
})

test('each API: how its stream says it is over, or does not', async t => {
  const cases = [
    ['google-generative', [gemini('她抬起头，', 'STOP')], 'halfway'],
    ['openai-completions', [openai('她抬起头，'), openai('', 'stop'), 'data: [DONE]\n\n'], 'halfway'],
    ['openai-completions', [openai('她抬起头，'), 'data: [DONE]\n\n'], 'halfway'],
    ['openai-completions', [openai('她抬起头，')], 'dropped'],
    ['openai-completions', [openai('她抬起头，'), openai('', 'content_filter')], 'filtered'],
    ['anthropic-messages', [begun, said('她抬起头，')], 'dropped'],
    ['anthropic-messages', [begun, said('她抬起头，'), anthropic('message_delta', { delta: { stop_reason: 'refusal' }, usage: { output_tokens: 4 } }), anthropic('message_stop', {})], 'filtered'],
    ['openai-responses', [`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '她抬起头，' })}\n\n`], 'dropped'],
    ['openai-responses', [`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '她抬起头，' })}\n\n`, `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`], 'halfway'],
  ]
  for (const [api, answer, kind] of cases) {
    const { turn } = await app(t, { api, answers: [answer] })
    assert.equal((await turn()).reply.truncated, kind, `${api} ${kind}`)
  }
})

test('a whole reply is not marked, and its missing block is filled in as before', async t => {
  const { turn, asked } = await app(t, { card: MVU, answers: [[gemini('她笑了。', 'STOP')], [gemini(BLOCK, 'STOP')]] })
  const { events, reply } = await turn()
  assert.equal(reply.truncated, undefined)
  assert.equal(asked.length, 2)
  const order = events.map(event => event.type)
  assert.ok(order.indexOf('written') > order.lastIndexOf('delta') && order.indexOf('filling') > order.indexOf('written'), order.join(' '))
})

test('upstream silent: the page hears so, hears it is over, and the longest time of it is kept', async t => {
  const { turn } = await app(t, { answers: [[gemini('她笑'), 5900, gemini('了。', 'STOP')]] })
  const { events, reply } = await turn()
  const quiet = events.filter(event => event.type === 'quiet')
  assert.ok(quiet.length >= 2)
  assert.deepEqual([quiet[0].begun, quiet[0].seconds >= 5, quiet.at(-1).seconds], [true, true, 0])
  assert.ok(reply.timing.gapMs >= 5500 && reply.timing.gapMs < 9000, String(reply.timing.gapMs))
  const start = events.find(event => event.type === 'start')
  assert.deepEqual([start.by, start.watch], ['Fake · m1', true])
})

test('a stop is sure only on a line of its own in the story', () => {
  const sure = text => surelyAtGate(text, ['check', 'battle'])
  assert.deepEqual(sure('她伸出手。\n【检定|力量|DC12】'), { wrapper: null })
  assert.deepEqual(sure('<content>\n她伸出手。\n【检定|力量|DC12】'), { wrapper: 'content' })
  assert.deepEqual(sure('<content>\n她伸出手。\n【检定|力量|DC12】\n</content>\n'), { wrapper: null })
  const unsure = ['她伸出手。', '她伸出手【检定|力量|DC12】', 'A. 伸手【检定|力量|DC12】', '<plan>\n要有检定\n【检定|力量|DC12】', '<thinking>\n【检定|力量|DC12】', '<think_mist>\n【检定|力量|DC12】\n</think_mist>\n她']
  for (const text of unsure) assert.equal(sure(text), null, text)
})

test('游戏规则: a reply past its stop is not waited for, its wrapper is closed, its tokens are kept', async t => {
  const { turn, call, closed, card } = await app(t, { answers: [[gemini('<content>\n她把手按在石门上。\n【检定|力量|DC12】\n'), 300, gemini('门开了。\n'), 3000, gemini('</content>', 'STOP')]] })
  assert.equal((await call(`/api/cards/${card.id}/game`, 'PUT', { level: 'full' })).level, 'full')
  const before = Date.now()
  const { reply } = await turn()
  await sleep(60)
  assert.ok(Date.now() - before < 2500, 'not waited for')
  assert.equal(closed.early, 1)
  assert.equal(reply.raw ?? reply.text, '<content>\n她把手按在石门上。\n【检定|力量|DC12】\n</content>')
  assert.equal(reply.gate?.kind, 'check')
  assert.deepEqual([reply.truncated, reply.usage.input], [undefined, 10])
})

test('silent past 超时: upstream stopped sending, this app hung up, and both are said', async t => {
  for (const api of ['google-generative', 'openai-completions']) {
    const piece = api === 'google-generative' ? gemini('她抬起头，') : openai('她抬起头，')
    const { turn } = await app(t, { api, timeout: 1, answers: [[piece, 4000, piece]] })
    const before = Date.now()
    const { done, reply, events } = await turn()
    assert.ok(Date.now() - before < 3500, 'ended by the timeout')
    assert.equal(events.some(event => event.type === 'error'), false)
    assert.deepEqual([reply.truncated, reply.text], ['timeout', '她抬起头，'])
    assert.match(done.cut.message, /^上游 Fake 写到中途，连着 1 秒没有发来任何内容，应用按.*「超时」断开了/)
  }
})

test('told it has enough, an answer is not read to its end, its tokens kept', async t => {
  const ask = async (api, answer) => {
    const { made, closed } = await provider(t, api, [answer])
    let text = ''
    const result = await complete(made, 'm1', { system: '', messages: [{ role: 'user', content: '走' }], signal: new AbortController().signal, onDelta: delta => { text += delta }, enough: () => text.includes('】') })
    await sleep(60)
    return { result, closed }
  }
  const one = await ask('google-generative', [gemini('手。\n【检定】'), 300, gemini('之后的。', 'STOP')])
  assert.deepEqual([one.result.text, one.result.usage.input, one.result.ended, one.closed.early], ['手。\n【检定】', 10, true, 1])
  const two = await ask('anthropic-messages', [begun, said('手。\n【检定】'), 300, said('之后的。')])
  assert.deepEqual([two.result.text, two.result.usage.input, two.result.usage.output > 1, two.closed.early], ['手。\n【检定】', 20, true, 1])
  // Its tokens come at the end: read to its end.
  const three = await ask('openai-completions', [openai('手。\n【检定】'), 50, openai('之后的。', 'stop')])
  assert.deepEqual([three.result.text, three.closed.early], ['手。\n【检定】之后的。', 0])
})

test('自动续写: how the whole reply ended is how its last part did', async t => {
  const { turn, asked } = await app(t, { answers: [[gemini('她笑了。门外', 'MAX_TOKENS')], [gemini('传来脚步声，', 'SAFETY')]] })
  const { events, reply } = await turn()
  assert.equal(asked.length, 2)
  assert.ok(events.some(event => event.type === 'continuing'))
  assert.deepEqual([reply.text, reply.truncated, reply.stop, reply.more], ['她笑了。门外传来脚步声，', 'filtered', 'SAFETY', 1])
})
