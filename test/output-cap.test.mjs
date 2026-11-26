// The output limit: how big a cap goes, what a model says it takes, and an answer that ran into it written on from there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { createForge } from '../server/forge/index.mjs'
import { complete, normalizeProvider, outputLimit } from '../server/providers.mjs'
import { completeWhole, goesRound, joinedStream, joinWhole } from '../server/whole.mjs'

const KEY = 'sk-test-1234567890abcd'

/**
 * A provider (Chat Completions, or Anthropic's Messages at /v1/messages) that answers each request with the next of `answers`:
 * { text, cut, think } or { status, message }; the last again once they run out. `answers` may be a function of the request's body.
 */
async function provider(t, answers) {
  const asked = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += part
    const json = JSON.parse(body)
    asked.push(json)
    const answer = typeof answers === 'function' ? answers(json, asked.length) : answers[Math.min(asked.length - 1, answers.length - 1)]
    const { text = '', cut = false, think = '', status = 0, message = '', wait = false } = answer
    if (status) {
      res.writeHead(status, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message } }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
    if (req.url.includes('/messages')) {
      send({ type: 'message_start', message: { model: json.model, usage: { input_tokens: 1000, output_tokens: 0 } } }, 'message_start')
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start')
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, 'content_block_delta')
      send({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
      send({ type: 'message_delta', delta: { stop_reason: cut ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 20 } }, 'message_delta')
      send({ type: 'message_stop' }, 'message_stop')
      return res.end()
    }
    if (think) send({ model: json.model, choices: [{ delta: { reasoning_content: think }, finish_reason: null }] })
    // In pieces, as a stream comes.
    for (const piece of text.match(/[\s\S]{1,5}/g) ?? []) send({ model: json.model, choices: [{ delta: { content: piece }, finish_reason: null }] })
    // Written so far, and never finished.
    if (wait) return
    send({ model: json.model, choices: [{ delta: {}, finish_reason: cut ? 'length' : 'stop' }] })
    send({ model: json.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } })
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  return { base: `http://127.0.0.1:${server.address().port}`, asked }
}

const made = (fake, api = 'openai-completions', more = {}) => normalizeProvider({ name: 'Fake', api, baseURL: api === 'anthropic-messages' ? fake.base : `${fake.base}/v1`, apiKey: KEY, models: [{ id: 'm1' }], ...more })
const ask = { system: 's', messages: [{ role: 'user', content: '写' }] }

test('what a refusal says the model takes, as services word it', () => {
  const says = [
    ['max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-sonnet', 8192],
    ['max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.', 16384],
    ['Invalid max_tokens value, the valid range of max_tokens is [1, 8192]', 8192],
    ['Range of max_tokens should be [1, 16384]', 16384],
    ['Unable to submit request because it has a maxOutputTokens value of 32000 but the supported range is from 1 (inclusive) to 8193 (exclusive).', 8192],
    ['max_tokens must be less than or equal to 4096', 4096],
    ['max_completion_tokens <= 4096', 4096],
    ['max_tokens 不能大于 4096', 4096],
    // Nothing to go by: a number above what was asked for, none at all, or one that is no cap.
    ['max_tokens is invalid', 0],
    ['max_tokens must be less than or equal to 65536', 0],
    ['Rate limit reached: 8192', 0],
    ['This model\'s maximum context length is 8192 tokens', 0],
  ]
  for (const [message, limit] of says) assert.equal(outputLimit(message, 32000), limit, message)
})

test('a model that says how much it takes gets that much, then and from then on, whoever asked for more', async t => {
  const fake = await provider(t, json => (json.max_tokens > 8192 ? { status: 400, message: `max_tokens: ${json.max_tokens} > 8192, which is the maximum allowed number of output tokens` } : { text: '好', cut: true }))
  // The player's own number, not a soft one.
  const mine = made(fake, 'openai-completions', { maxTokens: 60000 })
  const first = await complete(mine, 'm1', ask)
  assert.deepEqual(fake.asked.map(json => json.max_tokens), [60000, 8192])
  assert.equal(first.cap, 8192)
  await complete(mine, 'm1', { ...ask, maxTokens: 32000, softCap: true })
  assert.equal(fake.asked.length, 3, 'remembered')
  assert.equal(fake.asked.at(-1).max_tokens, 8192)
})

test('nothing set on an Anthropic address: 32000; one that refuses it without saying more gets 8192 from then on', async t => {
  const fake = await provider(t, json => (json.max_tokens > 8192 ? { status: 400, message: 'max_tokens is invalid' } : { text: '好' }))
  const mine = made(fake, 'anthropic-messages')
  assert.equal((await complete(mine, 'm1', ask)).cap, 8192)
  await complete(mine, 'm1', ask)
  assert.deepEqual(fake.asked.map(json => json.max_tokens), [32000, 8192, 8192])
})

test('a relay short of the price of the whole cap is asked again without it; a balance used up says so', async t => {
  const fake = await provider(t, json => (json.max_tokens > 8192 ? { status: 403, message: '预扣费额度失败, 用户剩余额度: ＄0.10' } : { text: '好' }))
  assert.equal((await complete(made(fake, 'anthropic-messages'), 'm1', ask)).text, '好')
  assert.deepEqual(fake.asked.map(json => json.max_tokens), [32000, 8192])
  const empty = await provider(t, [{ status: 403, message: '预扣费额度失败, 用户剩余额度: ＄0.00' }])
  await assert.rejects(complete(made(empty, 'anthropic-messages'), 'm1', ask), /预扣费/)
  assert.equal(empty.asked.length, 2)
})

test('a model seen thinking has room on a short cap the next time, though it was not cut off', async t => {
  const fake = await provider(t, [{ text: '好', think: '想一想' }])
  const mine = made(fake)
  await complete(mine, 'm1', { ...ask, maxTokens: 4000, softCap: true })
  await complete(mine, 'm1', { ...ask, maxTokens: 4000, softCap: true })
  assert.deepEqual(fake.asked.map(json => json.max_tokens), [4000, 20000])
})

test('joining: a repeated end is held back from the page; an answer begun over stands by itself; a fence goes', () => {
  const shown = (before, pieces) => {
    const stream = joinedStream(before)
    return pieces.map(piece => stream.push(piece)).join('') + stream.end()
  }
  assert.equal(shown('她推开门，雨丝斜斜地扑进来。她回头', ['雨丝斜斜', '地扑进来。她', '回头看了', '你一眼。']), '看了你一眼。')
  assert.equal(shown('她推开门。', ['雨', '停了。']), '雨停了。')
  assert.equal(shown('第一段。\n\n', ['\n\n', '第二段。']), '第二段。')
  const plan = '<plan>\n{"name": "雨宿", "summary": "深夜便利店里，只在雨夜出现的女孩", "world": {"kind": "真'
  assert.equal(joinWhole(plan, '```json\n实", "overview": ""}}'), `${plan}实", "overview": ""}}`)
  const over = '<plan>{"name": "雨宿", "summary": "深夜便利店里，只在雨夜出现的女孩", "world": {"kind": "真实"}}</plan>'
  assert.equal(joinWhole(plan, over), over)
})

test('text going round in circles is told from text that only repeats a word', () => {
  assert.equal(goesRound(`她笑了。${'雨一直下，一直下，她站在窗边不说话，像是在等一个不会来的人，又像只是在听雨声敲着玻璃。'.repeat(6)}`), true)
  assert.equal(goesRound('—'.repeat(300)), true)
  assert.equal(goesRound(Array.from({ length: 60 }, (_, i) => `{"path": "林小雨.第${i}项", "type": "number", "initial": "${i}", "range": "0~100"}`).join(',\n')), false)
  assert.equal(goesRound('她笑了。'.repeat(3)), false)
})

test('a made answer cut off is asked on till it is whole, the usage of all of it together', async t => {
  const fake = await provider(t, [{ text: '<plan>{"name": "雨宿", "cast"', cut: true }, { text: ': ["林小雨", "王', cut: true }, { text: '店长"]}</plan>' }])
  const rounds = []
  const result = await completeWhole(made(fake), 'm1', { ...ask, maxTokens: 32000, softCap: true }, {}, { onMore: n => rounds.push(n) })
  assert.equal(result.text, '<plan>{"name": "雨宿", "cast": ["林小雨", "王店长"]}</plan>')
  assert.equal(result.truncated, false)
  assert.deepEqual([rounds, result.more], [[1, 2], 2])
  assert.equal(result.usage.output, 150)
  const last = fake.asked.at(-1).messages
  assert.equal(last.at(-2).content, '<plan>{"name": "雨宿", "cast": ["林小雨", "王')
  assert.match(last.at(-1).content, /直接接着写/)
  // Never whole: three times more, and it is still marked as cut.
  let n = 0
  const endless = await provider(t, () => ({ text: `第 ${++n} 段，还有很多要写的内容；`, cut: true }))
  const cut = await completeWhole(made(endless), 'm1', ask, {})
  assert.deepEqual([endless.asked.length, cut.truncated, cut.more], [4, true, 3])
  // One that fails on the way: what there is, as cut.
  const failing = await provider(t, [{ text: '开头', cut: true }, { status: 500, message: 'oops' }])
  const kept = await completeWhole(made(failing), 'm1', ask, {})
  assert.deepEqual([kept.text, kept.truncated], ['开头', true])
})

test('a made answer whose thinking took the whole limit is asked once more, thinking less', async t => {
  const fake = await provider(t, [{ text: '', think: '想了很久很久', cut: true }, { text: '<plan>{}</plan>' }])
  const result = await completeWhole(made(fake), 'm1', { ...ask, maxTokens: 32000, softCap: true }, {})
  assert.equal(result.text, '<plan>{}</plan>')
  assert.deepEqual(fake.asked.map(json => [json.max_tokens, json.reasoning_effort]), [[32000, undefined], [64000, 'low']])
})

test('出方案: cut off halfway, it is written on and reads; never whole, the error says what to do', async t => {
  const plan = `<plan>\n${JSON.stringify({ name: '雨宿', summary: '深夜便利店', characters: [{ name: '林小雨', kind: 'core', identity: '雨女' }], greetings: [{ title: '第一场雨' }] })}\n</plan>`
  const talk = '<reply>好。</reply>\n<questions>[{"id": "a", "title": "她是谁？", "options": [{"label": "普通人"}, {"label": "雨女"}]}]</questions>\n<brief>{"title": "雨宿", "readiness": 90, "items": [], "open": []}</brief>'
  let whole = true
  const fake = await provider(t, json => {
    if (!json.messages[0].content.includes('角色卡策划')) return { text: talk }
    if (!whole) return { text: `<plan>{"name": "${'长'.repeat(json.messages.length)}`, cut: true }
    return json.messages.at(-1).content.includes('直接接着写') ? { text: plan.slice(60) } : { text: plan.slice(0, 60), cut: true }
  })
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-cap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const mine = made(fake)
  await store.saveProviders([mine])
  await store.saveSettings({ model: `${mine.id}/m1` })
  const forge = createForge(store, { ledger: { recordTurn: async () => {} } })
  const settled = async id => {
    for (let i = 0; i < 300; i++) {
      const draft = await forge.get(id)
      if (!draft.job) return draft
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('the job never finished')
  }
  let draft = await forge.create({ text: '雨夜便利店' })
  await settled(draft.id)
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  assert.equal(draft.error, null, JSON.stringify(draft.error))
  assert.equal(draft.plan.characters[0].name, '林小雨')
  whole = false
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  assert.match(draft.error.message, /自动接着写了 3 次还没写完/)
  assert.match(draft.error.message, /把规模调低/)
})

// ─── 聊天 ─────────────────────────────────────────────────────────────────

async function app(t, answers, { settings = {}, mvu = false, more = {} } = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-auto-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const store = createStore(dataRoot)
  await store.init()
  const fake = await provider(t, answers)
  const mine = made(fake, 'openai-completions', more)
  await store.saveProviders([mine])
  await store.saveSettings({ model: `${mine.id}/m1`, subscription: 'off', ...settings })
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '小雨', first_mes: '雨下了一整夜。', ...(mvu ? { character_book: { entries: [{ keys: [], content: '金钱: 10', comment: '[initvar]', enabled: true, constant: true }, { keys: [], content: '每轮结尾写 <UpdateVariable>', comment: '[mvu_update]规则', enabled: true, constant: true }] } } : {}) } })
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
  const stream = async (kind, body) => (await (await fetch(`${base}/api/chats/${chat.id}/${kind}`, { method: 'POST', headers, body: JSON.stringify(body) })).text()).split('\n\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  return { stream, call, asked: fake.asked, chatId: chat.id }
}

const doneOf = events => events.find(event => event.type === 'done')
const shownOf = events => events.filter(event => event.type === 'delta').map(event => event.text).join('')

test('自动续写: a reply cut at the limit goes on into the same one, its variables worked out from the whole', async t => {
  const { stream, asked } = await app(t, [
    { text: '她回头，雨丝斜斜地扑进来。\n<UpdateVariable>_.set("金钱", 10, ', cut: true },
    { text: '雨丝斜斜地扑进来。\n<UpdateVariable>_.set("金钱", 10, 25);</UpdateVariable>' },
  ], { mvu: true })
  const events = await stream('turn', { parentId: 'root', input: '走吧' })
  const done = doneOf(events)
  assert.ok(done, JSON.stringify(events.find(event => event.type === 'error')))
  const reply = done.chat.path.at(-1)
  const whole = '她回头，雨丝斜斜地扑进来。\n<UpdateVariable>_.set("金钱", 10, 25);</UpdateVariable>'
  assert.equal(reply.raw, whole)
  assert.equal(reply.truncated, undefined)
  assert.equal(reply.more, 1)
  assert.equal(reply.siblingCount, 1, 'one version, not two')
  assert.equal(reply.state.金钱, 25)
  assert.equal(reply.updateUnread, undefined)
  assert.equal(asked.length, 2, 'no 补写变量 on top')
  assert.ok(events.some(event => event.type === 'continuing' && event.round === 1))
  assert.equal(reply.usage.output, 100, 'both calls are counted')
  assert.equal(reply.usage.prompt, 100, 'the context is the first one\'s')
  const [turn, more] = asked
  assert.deepEqual(more.messages.slice(0, turn.messages.length), turn.messages, 'the turn sent as it was')
  assert.match(more.messages.at(-1).content, /接着写/)
})

test('自动续写: what repeats is not shown twice; off, the reply stays as it was cut, and says which limit it was', async t => {
  const answers = [{ text: '她推开门，雨丝斜斜地扑进来。她回头', cut: true }, { text: '雨丝斜斜地扑进来。她回头看了你一眼。' }]
  const on = await app(t, answers)
  assert.equal(shownOf(await on.stream('turn', { parentId: 'root', input: '走吧' })), '她推开门，雨丝斜斜地扑进来。她回头看了你一眼。')
  const off = await app(t, answers, { settings: { autoContinue: false }, more: { maxTokens: 900 } })
  const reply = doneOf(await off.stream('turn', { parentId: 'root', input: '走吧' })).chat.path.at(-1)
  assert.equal(off.asked.length, 1)
  assert.equal(reply.truncated, true)
  assert.deepEqual(reply.cap, { tokens: 900, from: 'provider' })
})

test('自动续写: twice at most; not for one that goes round; a failure on the way keeps what there was', async t => {
  let n = 0
  const endless = await app(t, () => ({ text: `第 ${++n} 段，故事还很长很长。`, cut: true }))
  const still = doneOf(await endless.stream('turn', { parentId: 'root', input: '走吧' })).chat.path.at(-1)
  assert.equal(endless.asked.length, 3)
  assert.equal(still.raw, '第 1 段，故事还很长很长。第 2 段，故事还很长很长。第 3 段，故事还很长很长。')
  assert.deepEqual([still.truncated, still.more, still.cap], [true, 2, { tokens: 0, from: 'default' }])

  const round = await app(t, [{ text: '雨一直下，一直下，她站在窗边不说话，像是在等一个不会来的人，又像只是在听雨声。'.repeat(8), cut: true }])
  assert.equal(doneOf(await round.stream('turn', { parentId: 'root', input: '走吧' })).chat.path.at(-1).truncated, true)
  assert.equal(round.asked.length, 1)

  const failing = await app(t, [{ text: '她回头', cut: true }, { status: 500, message: 'oops' }])
  const kept = doneOf(await failing.stream('turn', { parentId: 'root', input: '走吧' })).chat.path.at(-1)
  assert.deepEqual([kept.raw, kept.truncated], ['她回头', true])
})

test('继续生成 that runs into the limit again is written on too, all of it one reply', async t => {
  const { stream, asked } = await app(t, [
    { text: '她推开门。', cut: true }, { status: 500, message: 'oops' },
    { text: '雨停了。', cut: true }, { text: '你们走进巷子。' },
  ])
  const cut = doneOf(await stream('turn', { parentId: 'root', input: '走吧' })).chat.path.at(-1)
  const reply = doneOf(await stream('continue', { nodeId: cut.id })).chat.path.at(-1)
  assert.equal(reply.raw, '她推开门。雨停了。你们走进巷子。')
  assert.equal(reply.more, 1)
  assert.equal(asked.at(-1).messages.at(-2).content, '她推开门。雨停了。')
})

test('a reply that stayed cut with no update block is not given one: it may not have got to its end', async t => {
  const { stream, asked } = await app(t, [{ text: '她回头，正要说', cut: true }], { mvu: true, settings: { autoContinue: false } })
  const reply = doneOf(await stream('turn', { parentId: 'root', input: '走吧' })).chat.path.at(-1)
  assert.equal(asked.length, 1)
  assert.equal(reply.raw, '她回头，正要说')
})

test('thinking that took the whole limit, with nothing of the reply: the error says what to change', async t => {
  const { stream } = await app(t, [{ text: '', think: '想了很久', cut: true }], { more: { maxTokens: 20000 } })
  const error = (await stream('turn', { parentId: 'root', input: '走吧' })).find(event => event.type === 'error')
  assert.match(error.message, /光是思考就用完了输出上限（20000 token）/)
})

test('stopped while it was being written on: what there was stays with what came since, marked as stopped', async t => {
  const { stream, call, asked, chatId } = await app(t, [{ text: '她推开门。', cut: true }, { text: '雨停了。', wait: true }])
  const turn = stream('turn', { parentId: 'root', input: '走吧' })
  for (let i = 0; i < 200 && asked.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10))
  await new Promise(resolve => setTimeout(resolve, 100))
  await call(`/api/chats/${chatId}/stop`, 'POST')
  const reply = doneOf(await turn)?.chat.path.at(-1)
  assert.equal(reply.raw, '她推开门。雨停了。')
  assert.equal(reply.truncated, 'stopped')
  assert.equal(reply.usage.output, 50, 'the first part is counted')
})
