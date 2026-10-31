import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, chatView, createChat, restoreFolded, rollbackTo } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { testSubscription } from './support/subscription.mjs'
import { editPreset, normalizePreset } from '../server/presets.mjs'
import { complete, draftProvider, exportProviders, googleRequest, importProviders, isGoogle, listRemoteModelDetails, listRemoteModels, normalizeProvider, providerChoices, providerError, publicProvider, reasoningFields } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { cleanScripts } from '../server/regex.mjs'

const CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '小雨',
    description: '{{char}}是咖啡店店员。',
    first_mes: '欢迎光临～',
    extensions: {
      regex_scripts: [
        { id: 'r1', scriptName: '对AI隐藏变量', findRegex: '/<hide>[\\s\\S]*?<\\/hide>/g', replaceString: '', placement: [2], promptOnly: true, markdownOnly: false, disabled: false },
      ],
    },
  },
}

const CROSSED = '\n\n<state>{"好感": 30}</UpdateVariable>'
const SUMMARY = `<剧情存档>\n${'小雨和你在咖啡店聊起了桂花拿铁。'.repeat(20)}\n</剧情存档>`
const KEY = 'sk-test-1234567890abcd'

/** A provider that speaks all three protocols and records each request. */
async function fakeProvider(t) {
  const requests = []
  const flags = { rejectTtl: false, rejectReasoning: false, maxOutput: 0, contextLimit: 0, stopReason: 'end_turn', promptTokens: 100, summaryText: '', contextMessage: '', dropSystem: false, lateUsage: false, thinking: '' }
  let count = 0
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = body ? JSON.parse(body) : null
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: json })
    const auth = req.headers.authorization === `Bearer ${KEY}` || req.headers['x-api-key'] === KEY
    if (!auth) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
    }
    if (flags.rejectTtl && json?.system?.[0]?.cache_control?.ttl) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'system.0.cache_control.ttl: Extra inputs are not permitted' } }))
    }
    if (flags.rejectReasoning && (json?.thinking || json?.output_config || json?.reasoning || json?.reasoning_effort)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'thinking: Extra inputs are not permitted' } }))
    }
    // A window the prompt plus the output cap must fit into (characters stand in for tokens).
    if (flags.contextLimit && body.length + (json?.max_tokens ?? 0) > flags.contextLimit) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: flags.contextMessage || 'Context window is full. Reduce conversation history, system prompt, or tools.' } }))
    }
    if (flags.maxOutput && json?.max_tokens > flags.maxOutput) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: `max_tokens: ${json.max_tokens} > ${flags.maxOutput}, which is the maximum allowed number of output tokens` } }))
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a', context_length: 64000 }] }))
    }
    const lastUser = JSON.stringify((json.messages ?? json.input).at(-1))
    // 「标签写错」: a state block closed with MVU's tag, as some models write it.
    const text = lastUser.includes('暂停扮演') ? flags.summaryText || SUMMARY : lastUser.includes('标签写错') ? `第 ${++count} 次回复${CROSSED}` : `第 ${++count} 次回复<hide>变量${count}</hide>`
    const half = Math.ceil(text.length / 2)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    if (req.url === '/v1/chat/completions') {
      send({ model: json.model, choices: [{ delta: { role: 'assistant', reasoning_content: '想一想' } }] })
      send({ model: json.model, choices: [{ delta: { content: text.slice(0, half) } }] })
      send({ model: json.model, choices: [{ delta: { content: text.slice(half) }, finish_reason: 'stop' }] })
      send({ model: json.model, choices: [], usage: { prompt_tokens: flags.promptTokens, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } })
      send('[DONE]')
    } else if (req.url === '/v1/responses') {
      send({ type: 'response.created', response: { model: json.model } }, 'response.created')
      send({ type: 'response.output_text.delta', delta: text.slice(0, half) }, 'response.output_text.delta')
      send({ type: 'response.output_text.delta', delta: text.slice(half) }, 'response.output_text.delta')
      send({ type: 'response.completed', response: { model: json.model, status: 'completed', usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 9 } } }, 'response.completed')
    } else if (req.url === '/v1/messages') {
      // dropSystem: a relay that loses the system field (its input then counts the messages alone).
      // lateUsage: one that counts nothing until message_delta (all zeros at the start).
      const lost = flags.dropSystem && json.system
      const counts = lost ? { input_tokens: 20 } : { input_tokens: 5, cache_read_input_tokens: flags.dropSystem ? 4000 : 70, cache_creation_input_tokens: 30 }
      send({ type: 'message_start', message: { model: json.model, usage: flags.lateUsage ? { input_tokens: 0, output_tokens: 0 } : { ...counts, output_tokens: 1 } } }, 'message_start')
      if (flags.thinking) {
        send({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }, 'content_block_start')
        send({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: flags.thinking } }, 'content_block_delta')
      }
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } }, 'content_block_delta')
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } }, 'content_block_delta')
      send({ type: 'message_delta', delta: { stop_reason: flags.stopReason }, usage: { ...(flags.lateUsage ? counts : {}), output_tokens: flags.thinking ? 1000 : 11 } }, 'message_delta')
      send({ type: 'message_stop' }, 'message_stop')
    }
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { requests, flags, baseURL: `http://127.0.0.1:${server.address().port}` }
}

async function setup(t, api, baseSuffix = '/v1') {
  const fake = await fakeProvider(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-provider-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard(CARD)
  await store.saveCard(card)
  const provider = normalizeProvider({ name: 'Fake', api, baseURL: fake.baseURL + baseSuffix, apiKey: KEY, models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off' })
  const sdkCalls = []
  const engine = createEngine(store, { proxy: null }, null, {
    subscription: testSubscription(store, root, args => {
      sdkCalls.push(args)
      throw new Error('the SDK must not be called for a provider model')
    }),
  })
  const chat = await createChat(store, card.id)
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    const events = []
    const result = await engine.runTurn(chat.id, { parentId: tip.id, input }, event => events.push(event))
    return { chat: result.chat, events }
  }
  return { fake, store, engine, chat, turn, provider, sdkCalls }
}

test('provider config: validation, kept and cleared keys, nothing secret in the public view', () => {
  const first = normalizeProvider({ name: 'DeepSeek 官方', api: 'openai-completions', baseURL: 'https://api.deepseek.com/', apiKey: KEY, models: ['deepseek-chat', { id: 'deepseek-chat' }, { id: 'deepseek-reasoner', label: '推理' }] })
  assert.equal(first.id, 'deepseek')
  assert.equal(first.baseURL, 'https://api.deepseek.com')
  assert.deepEqual(first.models, [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner', label: '推理' }])
  const kept = normalizeProvider({ ...first, apiKey: '' }, first)
  assert.equal(kept.apiKey, KEY, 'a blank key keeps the saved one')
  assert.equal(normalizeProvider({ ...first, apiKey: '', clearKey: true }, first).apiKey, '')
  const view = publicProvider(first)
  assert.equal(view.apiKey, undefined)
  assert.equal(view.keyHint, '…abcd')
  assert.ok(!JSON.stringify(view).includes(KEY))
  assert.equal(normalizeProvider({ ...first, apiKey: '' }, null, new Set(['deepseek'])).id, 'deepseek-2')
  assert.equal(normalizeProvider({ ...first, id: undefined, name: '深度求索', baseURL: 'https://api.deepseek.com/v1' }).id, 'deepseek')
  assert.equal(normalizeProvider({ ...first, id: undefined, name: '方舟', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' }).id, 'volces')
  assert.equal(normalizeProvider({ ...first, id: undefined, name: '本机中转', baseURL: 'http://127.0.0.1:8045/v1' }).id, 'local')
  assert.throws(() => normalizeProvider({ ...first, baseURL: 'ftp://x' }), /http/)
  assert.throws(() => normalizeProvider({ ...first, models: [] }), /模型/)
  assert.throws(() => normalizeProvider({ ...first, api: 'gemini' }), /接口类型/)
  assert.throws(() => normalizeProvider({ ...first, extraBody: [1] }), /JSON 对象/)
  assert.deepEqual(providerChoices([first]).map(c => c.id), ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'])
})

test('OpenAI-compatible provider: history rebuilt from the tree, regex-trimmed replies, cached tokens', async t => {
  const { fake, turn, provider, sdkCalls, store, chat } = await setup(t, 'openai-completions')
  const first = await turn('点一杯拿铁')
  const start = first.events.find(e => e.type === 'start')
  assert.equal(start.api, 'Fake')
  assert.equal(first.events.filter(e => e.type === 'delta').map(e => e.text).join(''), '第 1 次回复<hide>变量1</hide>')
  const second = await turn('再来块蛋糕')
  assert.equal(sdkCalls.length, 0)

  const [one, two] = fake.requests.map(r => r.body)
  assert.equal(fake.requests[0].url, '/v1/chat/completions')
  assert.equal(fake.requests[0].headers.authorization, `Bearer ${KEY}`)
  assert.equal(one.model, 'm1')
  assert.equal(one.stream, true)
  const saved = await store.getChat(chat.id)
  assert.equal(one.messages[0].role, 'system')
  assert.equal(one.messages[0].content, saved.systemPrompt)
  assert.equal(one.messages.length, 2)
  assert.match(one.messages[1].content, /欢迎光临～[\s\S]*点一杯拿铁/, 'the opening rides along with the first message')
  // Second request: the first exchange verbatim (reply with the prompt-side regex), then the new message.
  assert.equal(two.messages.length, 4)
  assert.deepEqual(two.messages.slice(0, 2), one.messages, 'the prefix is identical, so the provider cache can hit')
  assert.deepEqual(two.messages[2], { role: 'assistant', content: '第 1 次回复' })
  assert.match(two.messages[3].content, /再来块蛋糕/)

  const tip = activePath(second.chat).at(-1)
  assert.equal(tip.text, '第 2 次回复<hide>变量2</hide>', 'the stored reply keeps everything')
  assert.equal(tip.sdk, null)
  assert.deepEqual(tip.api, { provider: provider.id, model: 'm1' })
  assert.equal(tip.model, `${provider.id}/m1`)
  assert.equal(tip.usage.input, 40)
  assert.equal(tip.usage.cacheRead, 60)
  assert.equal(tip.usage.output, 7)
  assert.equal(tip.timing.api, true)
})

test('a state block closed with the wrong tag: applied and hidden, but sent back to the model as it was written', async t => {
  const { fake, turn } = await setup(t, 'openai-completions')
  const first = await turn('标签写错了也要记上')
  const reply = activePath(first.chat).at(-1)
  assert.equal(reply.text, `第 1 次回复${CROSSED}`, 'the stored reply keeps everything')
  assert.equal(reply.display, '第 1 次回复')
  assert.equal(reply.state.好感, 30)
  await turn('再来块蛋糕')
  const [one, two] = fake.requests.map(r => r.body)
  // Only what the page shows and the state changed: the history is the reply as written,
  // so the next turn's prefix is what it was before this fix and stays cached.
  assert.deepEqual(two.messages.slice(0, 2), one.messages)
  assert.deepEqual(two.messages[2], { role: 'assistant', content: `第 1 次回复${CROSSED}` })
})

test('global regex (正则): a prompt-side script changes what the model reads again, before the card\'s; a display-only one never does', async t => {
  const { fake, turn, store } = await setup(t, 'openai-completions')
  await store.saveRegex(cleanScripts([
    { scriptName: 'shorten', findRegex: '/第 (\\d+) 次回复/g', replaceString: '回复$1', placement: [2], promptOnly: true },
    { scriptName: 'shown', findRegex: '/回复/g', replaceString: 'REPLY', placement: [2], markdownOnly: true },
  ]))
  await turn('一')
  await turn('二')
  // The global script first, then the card's own (which drops <hide>…</hide>).
  assert.deepEqual(fake.requests[1].body.messages[2], { role: 'assistant', content: '回复1' })
})

test('provider compaction too long for the context: the older half first, then the newer half on top of it', async t => {
  const { fake, turn, engine, chat } = await setup(t, 'anthropic-messages', '')
  for (const input of ['一', '二', '三', '四']) await turn(`${input}${'长'.repeat(3000)}`)
  const last = fake.requests.at(-1).body
  // The last turn's whole history no longer fits with the output cap; half of it does.
  fake.flags.contextLimit = JSON.stringify(last).length + last.max_tokens - 4000
  const after = await engine.compactChat(chat.id)
  const [full, older, newer] = fake.requests.slice(-3)
  assert.equal(full.body.messages.length, 9, 'four exchanges and the instruction: refused')
  assert.equal(older.body.messages.length, 5, 'the first two exchanges and the instruction')
  assert.equal(newer.body.messages.length, 7, 'the older archive, an acknowledgement, the last two exchanges, the instruction')
  assert.match(newer.body.messages[0].content, /<前情提要>[\s\S]*桂花拿铁/)
  assert.match(newer.body.messages.at(-1).content[0].text, /暂停扮演/)
  assert.match(activePath(after).at(-1).compaction.summary, /桂花拿铁/)
})

test('provider compaction: summary from the rebuilt history, next turn starts fresh with the recap', async t => {
  const { fake, turn, engine, chat } = await setup(t, 'openai-completions')
  await turn('点一杯拿铁')
  const { chat: before } = await turn('再来块蛋糕')
  assert.equal(chatView(before).compactable, 2)
  const after = await engine.compactChat(chat.id)
  const summaryRequest = fake.requests.at(-1).body
  assert.equal(summaryRequest.messages.length, 6, 'system, two exchanges, the instruction')
  assert.match(summaryRequest.messages.at(-1).content, /暂停扮演/)
  assert.match(activePath(after).at(-1).compaction.summary, /桂花拿铁/)

  // A side request on the compacted reply (an image prompt): the summary and last turns stand in for the history.
  await engine.askInContext(chat.id, activePath(after).at(-1).id, '写一句配图提示')
  const side = fake.requests.at(-1).body
  assert.equal(side.messages.length, 2, 'the system prompt and one message')
  assert.match(side.messages[1].content, /<前情提要>[\s\S]*桂花拿铁[\s\S]*再来块蛋糕[\s\S]*写一句配图提示$/)

  await turn('结账')
  const next = fake.requests.at(-1).body
  assert.equal(next.messages.length, 2, 'only the system prompt and the new message')
  assert.match(next.messages[1].content, /<前情提要>[\s\S]*桂花拿铁[\s\S]*结账/)
  await turn('再见')
  assert.equal(fake.requests.at(-1).body.messages.length, 4, 'then it continues from the compaction point')
})

test('自动压缩: past the threshold for the chat\'s model, a new turn compacts first and starts from the archive; off, it does not', async t => {
  const { fake, store, turn, provider } = await setup(t, 'openai-completions')
  const ref = `${provider.id}/m1`
  // A 2 000-token window: the threshold is its floor, 1 000; each turn reports 1 500 + 7.
  await store.saveSettings({ compaction: { windows: { [ref]: 2_000 } } })
  fake.flags.promptTokens = 1_500
  await turn('点一杯拿铁')
  const { events: quiet } = await turn('再来块蛋糕')
  assert.ok(!quiet.some(event => event.type === 'compacting'), 'one turn in: not worth an archive yet')
  const { chat, events } = await turn('结账')
  assert.deepEqual(events.filter(event => event.type.startsWith('compact')).map(event => event.type), ['compacting', 'compacted'])
  const [summary, next] = fake.requests.slice(-2)
  assert.match(summary.body.messages.at(-1).content, /暂停扮演/)
  assert.equal(next.body.messages.length, 2, 'the system prompt and the new message, after the archive')
  assert.match(next.body.messages[1].content, /<前情提要>[\s\S]*桂花拿铁[\s\S]*结账/)
  assert.ok(activePath(chat).at(-3).compaction, 'the archive is on the reply the turn continued from')

  // Switched off: only the page's reminder.
  await store.saveSettings({ compaction: { auto: false, windows: { [ref]: 2_000 } } })
  await turn('再见')
  const { events: off } = await turn('明天见')
  assert.ok(!off.some(event => event.type === 'compacting'))
})

test('compaction checks the archive, keeps the last turns when nothing can read the story, learns a window from an error', async t => {
  const { fake, store, turn, engine, chat, provider } = await setup(t, 'openai-completions')
  await turn('一')
  await turn('二')
  // A model that carried on with the story instead: no compaction.
  fake.flags.summaryText = '小雨笑了笑，端起杯子，继续讲她昨天在街角遇见的那只猫。'.repeat(10)
  await assert.rejects(engine.compactChat(chat.id), /没有写出剧情存档/)
  assert.ok(!activePath(await store.getChat(chat.id)).some(node => node.compaction))
  // 只保留最近两轮: no model call, the turns left out noted, the last ones verbatim next turn.
  const sent = fake.requests.length
  const kept = await engine.compactChat(chat.id, { keepRecent: true })
  assert.equal(fake.requests.length, sent)
  assert.match(activePath(kept).at(-1).compaction.summary, /前面的 2 轮没有写成存档/)
  assert.equal(chatView(kept).path.at(-1).compaction.kept, 2)
  fake.flags.summaryText = ''
  await turn('三')
  assert.match(fake.requests.at(-1).body.messages[1].content, /<前情提要>[\s\S]*没有写成存档[\s\S]*<最近原文>[\s\S]*二[\s\S]*三/)

  // Too long for the model, and it says how long it can be: kept for 自动压缩, flagged for 压缩后重试.
  fake.flags.contextLimit = 10
  fake.flags.contextMessage = "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens."
  await assert.rejects(turn('四'), error => error.contextFull === true)
  assert.equal((await store.getModelContext())[`${provider.id}/m1`], 131_072)
})

test('compaction too long even in halves: read again in parts under the start of the system prompt only', async t => {
  const { fake, store, turn, engine, chat } = await setup(t, 'openai-completions')
  for (const input of ['一', '二', '三']) await turn(input)
  const saved = await store.getChat(chat.id)
  saved.systemPrompt = `${saved.systemPrompt}\n${'设定'.repeat(15_000)}`
  await store.saveChat(saved)
  // Any request with the whole system prompt is refused; one with its start fits.
  fake.flags.contextLimit = 25_000
  const after = await engine.compactChat(chat.id)
  assert.match(activePath(after).at(-1).compaction.summary, /桂花拿铁/)
  const last = fake.requests.at(-1).body
  assert.ok(last.messages[0].content.length < 7_000)
  assert.match(last.messages[0].content, /只保留了开头部分/)
})

test('compaction and rollbacks: compacted with turns folded behind it, they come back with the archive in front; a new version of the compacted reply keeps it', async t => {
  const { fake, store, turn, engine, chat } = await setup(t, 'openai-completions')
  await turn('一')
  const { chat: two } = await turn('二')
  const second = activePath(two).at(-1)
  await turn('三')
  const rolled = await store.getChat(chat.id)
  rollbackTo(rolled, second.id)
  await store.saveChat(rolled)
  assert.equal(chatView(rolled).compactable, 2)
  const compacted = await engine.compactChat(chat.id)
  assert.ok(compacted.nodes[second.id].compaction)
  const restored = await store.getChat(chat.id)
  restoreFolded(restored)
  await store.saveChat(restored)
  assert.equal(chatView(restored).path.find(node => node.id === second.id).compaction.editable, true, 'nothing written from it since')
  await turn('四')
  const messages = fake.requests.at(-1).body.messages
  assert.match(messages[1].content, /^<前情提要>[\s\S]*桂花拿铁[\s\S]*<\/前情提要>\n\n[\s\S]*三/, 'the folded turn opens with the archive')

  // Too few turns: said as it is.
  const fresh = await createChat(store, chat.cardId)
  await engine.runTurn(fresh.id, { parentId: activePath(fresh).at(-1).id, input: '你好' }, () => {})
  assert.equal(chatView(await store.getChat(fresh.id)).compactBlock, 'start')
  await assert.rejects(engine.compactChat(fresh.id), /这段对话还不到 2 轮/)

  // A new version of the reply the story was compacted into: the archive goes with it.
  await turn('五')
  await turn('六')
  const tip = activePath(await engine.compactChat(chat.id)).at(-1)
  await engine.runTurn(chat.id, { userNodeId: tip.parent }, () => {})
  const redone = activePath(await store.getChat(chat.id)).at(-1)
  assert.notEqual(redone.id, tip.id)
  assert.match(redone.compaction.summary, /桂花拿铁/)
})

test('a provider\'s model list says how long each context is where it can', async t => {
  const { provider } = await setup(t, 'openai-completions')
  assert.deepEqual(await listRemoteModelDetails(provider), { models: ['m-a', 'm-b'], contexts: { 'm-a': 64_000 } })
})

test('Anthropic Messages provider: /v1 added, x-api-key, cache breakpoints, usage', async t => {
  const { fake, turn } = await setup(t, 'anthropic-messages', '')
  await turn('你好')
  const { chat } = await turn('再见')
  const request = fake.requests.at(-1)
  assert.equal(request.url, '/v1/messages')
  assert.equal(request.headers['x-api-key'], KEY)
  assert.equal(request.headers['anthropic-version'], '2023-06-01')
  assert.equal(request.body.max_tokens, 8192)
  assert.deepEqual(request.body.system[0].cache_control, { type: 'ephemeral' })
  const messages = request.body.messages
  assert.equal(messages.length, 3)
  // Only the system prompt and the newest message: relays mishandle more (see apiMessages).
  assert.equal(typeof messages[0].content, 'string')
  assert.equal(typeof messages[1].content, 'string')
  assert.deepEqual(messages[2].content[0].cache_control, { type: 'ephemeral' })
  const tip = activePath(chat).at(-1)
  assert.deepEqual([tip.usage.input, tip.usage.cacheRead, tip.usage.cacheWrite, tip.usage.output], [5, 70, 30, 11])
})

test('Anthropic 1-hour cache: ttl on both breakpoints, resent without it when a relay rejects the field', async t => {
  const { fake, turn, store } = await setup(t, 'anthropic-messages', '')
  const [provider] = await store.getProviders()
  await store.saveProviders([normalizeProvider({ ...provider, cacheTtl: '1h' }, provider)])
  await turn('你好')
  const body = fake.requests.at(-1).body
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(body.messages.at(-1).content[0].cache_control, { type: 'ephemeral', ttl: '1h' })

  fake.flags.rejectTtl = true
  const { chat } = await turn('再见')
  const [rejected, retried] = fake.requests.slice(-2)
  assert.equal(rejected.body.system[0].cache_control.ttl, '1h')
  assert.deepEqual(retried.body.system[0].cache_control, { type: 'ephemeral' })
  assert.match(activePath(chat).at(-1).text, /第 2 次回复/)
  assert.equal(normalizeProvider({ ...provider, cacheTtl: 'forever' }, provider).cacheTtl, '5m')
})

test('Anthropic API with another model behind it: plain system prompt and messages, no breakpoints', async t => {
  // A relay serving deepseek-v4.1-flash this way dropped the system prompt when the newest message came as marked blocks.
  const fake = await fakeProvider(t)
  const provider = normalizeProvider({ name: 'Relay', api: 'anthropic-messages', baseURL: fake.baseURL, apiKey: KEY, models: [{ id: 'deepseek-v4.1-flash' }] })
  await complete(provider, 'deepseek-v4.1-flash', { system: '暗号是青梅煮酒', messages: [{ role: 'user', content: '暗号是什么？' }] })
  const body = fake.requests.at(-1).body
  assert.equal(body.system, '暗号是青梅煮酒')
  assert.equal(body.messages[0].content, '暗号是什么？')
})

test('a relay that drops the system prompt: asked again at once with it in the first message, and so from then on', async t => {
  const fake = await fakeProvider(t)
  fake.flags.dropSystem = true
  const provider = normalizeProvider({ name: 'Relay', api: 'anthropic-messages', baseURL: fake.baseURL, apiKey: KEY, models: [{ id: 'claude-x' }] })
  const system = '你是角色卡共创向导。'.repeat(200)
  const shown = []
  const result = await complete(provider, 'claude-x', { system, messages: [{ role: 'user', content: '我的想法：雨夜' }], onDelta: text => shown.push(text) })
  const [lost, again] = fake.requests.slice(-2)
  assert.equal(lost.body.system[0].text, system)
  assert.equal(again.body.system, undefined)
  const first = again.body.messages[0].content
  assert.match(typeof first === 'string' ? first : first[0].text, /^<system>\n你是角色卡共创向导。[\s\S]*<\/system>\n\n我的想法：雨夜$/)
  assert.match(result.text, /次回复/)
  // Nothing of the lost answer showed: the check comes before any text.
  assert.equal(shown.join('').split('次回复').length, 2)
  assert.equal(fake.requests.length, 2)
  await complete(provider, 'claude-x', { system, messages: [{ role: 'user', content: '再来' }] })
  assert.equal(fake.requests.length, 3, 'straight to the first message now')
  assert.equal(fake.requests.at(-1).body.system, undefined)
})

test('a relay that counts nothing until the end: the lost system prompt shows after the text; asked again when the shown text can be taken back', async t => {
  const fake = await fakeProvider(t)
  Object.assign(fake.flags, { dropSystem: true, lateUsage: true })
  const provider = normalizeProvider({ name: 'Relay', api: 'anthropic-messages', baseURL: fake.baseURL, apiKey: KEY, models: [{ id: 'claude-late' }, { id: 'claude-late-2' }] })
  const system = '你是角色卡共创向导。'.repeat(200)
  let shown = ''
  const restarts = []
  const result = await complete(provider, 'claude-late', { system, messages: [{ role: 'user', content: '我的想法：雨夜' }], onDelta: text => (shown += text), onRestart: () => { restarts.push(shown); shown = '' } })
  assert.equal(fake.requests.length, 2)
  assert.equal(restarts.length, 1)
  assert.ok(restarts[0].length > 0, 'the lost answer had shown')
  assert.equal(shown, result.text, 'only the second answer is left on screen')
  assert.equal(fake.requests.at(-1).body.system, undefined)
  assert.equal(result.usage.prompt, 4035, 'the context is the second call\'s')
  assert.equal(result.usage.input, 25, 'both calls are billed')
  // No way to take it back: the answer stands, and the next request goes with the system prompt in the first message.
  const kept = await complete(provider, 'claude-late-2', { system, messages: [{ role: 'user', content: '雨夜' }], onDelta: () => {} })
  assert.equal(fake.requests.length, 3)
  assert.ok(kept.text)
  await complete(provider, 'claude-late-2', { system, messages: [{ role: 'user', content: '再来' }] })
  assert.equal(fake.requests.length, 4)
  assert.equal(fake.requests.at(-1).body.system, undefined)
})

test('usage keeps each call\'s prompt and the thinking in output: neither is context next turn', async t => {
  const fake = await fakeProvider(t)
  const provider = normalizeProvider({ name: 'Relay', api: 'anthropic-messages', baseURL: fake.baseURL, apiKey: KEY, models: [{ id: 'claude-x' }] })
  const plain = await complete(provider, 'claude-x', { system: '短', messages: [{ role: 'user', content: '你好' }] })
  assert.equal(plain.usage.prompt, 105)
  assert.equal(plain.usage.thinking, undefined)
  // Thinking nine times the answer's length: about nine tenths of output_tokens.
  fake.flags.thinking = '想'.repeat(9 * 20)
  const thought = await complete(provider, 'claude-x', { system: '短', messages: [{ role: 'user', content: '你好' }] })
  assert.ok(thought.usage.thinking > 800 && thought.usage.thinking < 1000, String(thought.usage.thinking))
})

test('an empty system prompt is left out in every protocol (Anthropic refuses an empty text block)', async t => {
  const fake = await fakeProvider(t)
  const sent = async (api, suffix) => {
    const provider = normalizeProvider({ name: 'Fake', api, baseURL: fake.baseURL + suffix, apiKey: KEY, models: [{ id: 'm1' }] })
    await complete(provider, 'm1', { system: ' ', messages: [{ role: 'user', content: '你好' }] })
    return fake.requests.at(-1).body
  }
  assert.equal('system' in (await sent('anthropic-messages', '')), false)
  assert.equal('instructions' in (await sent('openai-responses', '/v1')), false)
  assert.deepEqual((await sent('openai-completions', '/v1')).messages.map(m => m.role), ['user'])
})

test('output limit: the preset max response length, capped, dropped when refused; cut-off replies are marked', async t => {
  const { fake, turn, store, chat } = await setup(t, 'anthropic-messages', '')
  const preset = normalizePreset({ name: 'P', openai_max_tokens: 65535, prompts: [{ identifier: 'main', content: '写', enabled: true }] })
  await store.savePreset(preset)
  await store.saveChat({ ...(await store.getChat(chat.id)), presetId: preset.id })
  await turn('你好')
  assert.equal(fake.requests.at(-1).body.max_tokens, 32000, 'the preset asks for 65535; capped')

  fake.flags.maxOutput = 16000
  fake.flags.stopReason = 'max_tokens'
  const { chat: after } = await turn('再见')
  const [refused, retried] = fake.requests.slice(-2)
  assert.equal(refused.body.max_tokens, 32000)
  assert.equal(retried.body.max_tokens, 8192, 'the model refused it: the provider default instead')
  const tip = activePath(after).at(-1)
  assert.equal(tip.api.truncated, true)
  assert.equal(chatView(after).path.at(-1).truncated, true)

  const [provider] = await store.getProviders()
  await store.saveProviders([normalizeProvider({ ...provider, maxTokens: 4000 }, provider)])
  fake.flags.stopReason = 'end_turn'
  const { chat: last } = await turn('再来')
  assert.equal(fake.requests.at(-1).body.max_tokens, 4000, 'a limit set on the provider wins')
  assert.equal(activePath(last).at(-1).api.truncated, undefined)
})

test('context window full: retried with the smaller default output cap, then a hint to compact', async t => {
  const { fake, turn, store, chat } = await setup(t, 'anthropic-messages', '')
  const preset = normalizePreset({ name: 'P', openai_max_tokens: 65535, prompts: [{ identifier: 'main', content: '写', enabled: true }] })
  await store.savePreset(preset)
  await store.saveChat({ ...(await store.getChat(chat.id)), presetId: preset.id })
  await turn('你好')
  const size = JSON.stringify(fake.requests.at(-1).body).length
  // Fits with 8192 more, not with 32000.
  fake.flags.contextLimit = size + 20000
  await turn('再见')
  const [full, retried] = fake.requests.slice(-2)
  assert.equal(full.body.max_tokens, 32000)
  assert.equal(retried.body.max_tokens, 8192)

  fake.flags.contextLimit = 100
  await assert.rejects(turn('还在吗'), /Context window is full[\s\S]*压缩上下文/)
})

test('a model whose thinking uses up a short cap: once more with room, and room from then on', async t => {
  // Thinks for 1000 tokens before every answer, and the cap counts the thinking.
  const caps = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = JSON.parse(body)
    caps.push(json.max_tokens)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (json.model === 'plain') {
      send({ model: json.model, choices: [{ delta: { content: 'a girl' }, finish_reason: 'length' }] })
      return res.end('data: [DONE]\n\n')
    }
    send({ model: json.model, choices: [{ delta: { role: 'assistant', reasoning_content: '先想一想画面' } }] })
    if (json.max_tokens < 1000) send({ model: json.model, choices: [{ delta: {}, finish_reason: 'length' }] })
    else send({ model: json.model, choices: [{ delta: { content: 'a girl under a paper umbrella' }, finish_reason: 'stop' }] })
    send({ model: json.model, choices: [], usage: { prompt_tokens: 50, completion_tokens: Math.min(json.max_tokens ?? 4000, 1010), completion_tokens_details: { reasoning_tokens: 1000 } } })
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const provider = normalizeProvider({ name: 'Thinker', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: KEY, models: [{ id: 'flash' }] })

  const first = await complete(provider, 'flash', { system: 's', messages: [{ role: 'user', content: '画一张' }], maxTokens: 400 })
  assert.deepEqual(caps, [400, 16400], 'cut off while thinking, nothing answered: asked again with room')
  assert.equal(first.text, 'a girl under a paper umbrella')
  assert.equal(first.truncated, false)
  assert.equal(first.usage.output, 400 + 1010, 'both calls are counted')

  await complete(provider, 'flash', { system: 's', messages: [{ role: 'user', content: '再画一张' }], maxTokens: 700 })
  assert.equal(caps.at(-1), 16700, 'the room is given up front from then on')
  await complete(provider, 'flash', { system: 's', messages: [{ role: 'user', content: '写方案' }], maxTokens: 32000 })
  assert.equal(caps.at(-1), 32000, 'a long cap already has room')

  // A model that answers straight away and runs out: cut off as before, not asked again.
  caps.length = 0
  const cut = await complete(provider, 'plain', { system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 50 })
  assert.deepEqual(caps, [50])
  assert.equal(cut.truncated, true)
})

test('rebuilt history as SillyTavern sends it: preset block on the newest message only, regex by real depth', async t => {
  const { fake, turn, store, chat } = await setup(t, 'anthropic-messages', '')
  const preset = normalizePreset({
    name: 'P',
    prompts: [
      { identifier: 'main', content: '写' },
      { identifier: 'chatHistory', marker: true },
      { identifier: 'rule', content: '正文后写选项' },
    ],
    // Only the last two messages are wrapped, as TGbreak does with <ai_last_output>.
    extensions: { regex_scripts: [{ scriptName: '巡回', findRegex: '^([\\s\\S]*)$', replaceString: '<last>$1</last>', placement: [2], promptOnly: true, maxDepth: 2 }] },
  })
  editPreset(preset, { postMode: 'latest' })
  await store.savePreset(preset)
  await store.saveChat({ ...(await store.getChat(chat.id)), presetId: preset.id })
  await turn('一')
  await turn('二')
  await turn('三')
  const messages = fake.requests.at(-1).body.messages
  const text = m => (typeof m.content === 'string' ? m.content : m.content[0].text)
  assert.equal(messages.length, 5)
  assert.match(text(messages[4]), /<预设指令>\n正文后写选项\n<\/预设指令>/, 'the newest message carries the preset block')
  assert.doesNotMatch(text(messages[0]) + text(messages[2]), /预设指令/, 'older messages do not')
  assert.equal(text(messages[1]), '第 1 次回复', 'depth 3: not wrapped')
  assert.equal(text(messages[3]), '<last>第 2 次回复</last>', 'depth 1: wrapped')
  // The reply at depth 3 never changes again: the next turn reads the cache up to it.
  assert.ok(messages[1].content[0].cache_control)
  assert.equal(typeof messages[3].content, 'string')
  assert.ok(messages[4].content[0].cache_control)
})

test('cache marks: turn mode keeps the history fixed and marks only the newest message; latest adds one settled reply', async t => {
  const { fake, turn, store, chat } = await setup(t, 'anthropic-messages', '')
  const preset = normalizePreset({ name: 'P', prompts: [{ identifier: 'main', content: '写' }, { identifier: 'chatHistory', marker: true }, { identifier: 'rule', content: '正文后写选项' }] })
  const marked = request => request.body.messages.flatMap((m, i) => (typeof m.content === 'string' ? [] : [i]))
  editPreset(preset, { postMode: 'turn' })
  await store.savePreset(preset)
  await store.saveChat({ ...(await store.getChat(chat.id)), presetId: preset.id })
  for (const input of ['一', '二', '三']) await turn(input)
  assert.deepEqual(marked(fake.requests.at(-1)), [4], 'turn: the newest message only')
  editPreset(preset, { postMode: 'latest' })
  await store.savePreset(preset)
  await turn('四')
  assert.deepEqual(marked(fake.requests.at(-1)), [5, 6], 'latest: the newest reply in the history and the newest message')
})

test('thinking and effort settings reach providers in each protocol’s fields, within each model’s rules', () => {
  const on = { thinking: 'adaptive', effort: 'high' }
  const off = { thinking: 'off', effort: 'max' }
  assert.deepEqual(reasoningFields('anthropic-messages', 'claude-opus-5-5', off), { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }, 'Opus 5.5 always thinks')
  assert.deepEqual(reasoningFields('anthropic-messages', 'claude-sonnet-5-5', off), { thinking: { type: 'between_tools' }, output_config: { effort: 'high' } }, 'Sonnet 5.5 turns it off its own way, at most high')
  assert.deepEqual(reasoningFields('anthropic-messages', 'claude-opus-4-6-20260201', off), { thinking: { type: 'disabled' }, output_config: { effort: 'high' } })
  assert.deepEqual(reasoningFields('anthropic-messages', 'anthropic/claude-sonnet-5.5', on), { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }, 'OpenRouter ids')
  assert.deepEqual(reasoningFields('anthropic-messages', 'claude-opus-4-6', { thinking: 'adaptive', effort: 'xhigh' }), { thinking: { type: 'adaptive' } }, 'a level the model lacks is left out')
  assert.deepEqual(reasoningFields('anthropic-messages', 'claude-haiku-4-5-20251001', on), {}, 'Haiku 4.5 takes neither')
  assert.deepEqual(reasoningFields('anthropic-messages', 'claude-haiku-5-5', on), { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
  assert.deepEqual(reasoningFields('anthropic-messages', 'claude-haiku-5-5', off), { thinking: { type: 'disabled' }, output_config: { effort: 'high' } }, 'Haiku 5.5 turns thinking off at high or below')
  assert.deepEqual(reasoningFields('anthropic-messages', 'gemini-3.1-pro', on), {}, 'not a Claude model')
  assert.deepEqual(reasoningFields('openai-responses', 'gpt-6.1-sol', off), { reasoning: { effort: 'xhigh' } })
  assert.deepEqual(reasoningFields('openai-completions', 'deepseek-v4-flash', on), { reasoning_effort: 'high' })
  assert.deepEqual(reasoningFields('openai-completions', 'x', { thinking: 'off' }), {})
})

test('a provider that refuses the thinking fields gets the turn without them, and from then on', async t => {
  const { fake, turn, store } = await setup(t, 'anthropic-messages', '')
  const [provider] = await store.getProviders()
  await store.saveProviders([normalizeProvider({ ...provider, models: [{ id: 'claude-sonnet-5-5' }], extraBody: { output_config: { effort: 'low' } } }, provider)])
  await store.saveSettings({ model: `${provider.id}/claude-sonnet-5-5`, thinking: 'adaptive', effort: 'high' })
  await turn('你好')
  const first = fake.requests.at(-1).body
  assert.deepEqual(first.thinking, { type: 'adaptive' })
  assert.deepEqual(first.output_config, { effort: 'low' }, 'the provider’s own extra parameters win')

  const [withExtra] = await store.getProviders()
  await store.saveProviders([normalizeProvider({ ...withExtra, extraBody: null }, withExtra)])
  fake.flags.rejectReasoning = true
  const { chat } = await turn('再见')
  const [rejected, retried] = fake.requests.slice(-2)
  assert.ok(rejected.body.thinking)
  assert.equal(retried.body.thinking, undefined)
  assert.match(activePath(chat).at(-1).text, /第 2 次回复/)
  const before = fake.requests.length
  await turn('又来了')
  assert.equal(fake.requests.length, before + 1, 'not tried again')
  assert.equal(fake.requests.at(-1).body.thinking, undefined)
})

test('a relay refusing the 1-hour cache ("Extra inputs are not permitted") keeps thinking: only the cache field goes', async t => {
  const { fake, turn, store } = await setup(t, 'anthropic-messages', '')
  const [provider] = await store.getProviders()
  // A model id of its own (relay-style, the same model): what other tests here learnt about refusals is kept per model.
  await store.saveProviders([normalizeProvider({ ...provider, cacheTtl: '1h', models: [{ id: 'anthropic/claude-sonnet-5-5' }] }, provider)])
  await store.saveSettings({ model: `${provider.id}/anthropic/claude-sonnet-5-5`, thinking: 'adaptive', effort: 'high' })
  fake.flags.rejectTtl = true
  await turn('你好')
  const [rejected, retried] = fake.requests.slice(-2)
  assert.equal(rejected.body.system[0].cache_control.ttl, '1h')
  assert.deepEqual(retried.body.thinking, { type: 'adaptive' }, 'thinking kept: the cache field explained it')
  assert.equal(retried.body.system[0].cache_control.ttl, undefined)
  await turn('再见')
  assert.deepEqual(fake.requests.at(-1).body.thinking, { type: 'adaptive' }, 'and not left out from then on')
})

test('a reply paused mid-search (pause_turn) is marked unfinished, apart from one cut at the output limit', async t => {
  const { fake, turn } = await setup(t, 'anthropic-messages', '')
  fake.flags.stopReason = 'pause_turn'
  const { chat } = await turn('查一下')
  assert.equal(chatView(chat).path.at(-1).truncated, 'paused')
  fake.flags.stopReason = 'max_tokens'
  const { chat: cut } = await turn('接着写')
  assert.equal(chatView(cut).path.at(-1).truncated, true)
})

test('OpenAI Responses provider: instructions + input, not stored', async t => {
  const { fake, turn } = await setup(t, 'openai-responses')
  await turn('你好')
  const { chat } = await turn('再见')
  const request = fake.requests.at(-1)
  assert.equal(request.url, '/v1/responses')
  assert.equal(request.body.store, false)
  assert.equal(typeof request.body.instructions, 'string')
  assert.equal(request.body.input.length, 3)
  assert.equal(request.body.input[1].role, 'assistant')
  const tip = activePath(chat).at(-1)
  assert.equal(tip.text, '第 2 次回复<hide>变量2</hide>')
  assert.deepEqual([tip.usage.input, tip.usage.cacheRead, tip.usage.output], [30, 20, 9])
})

test('provider errors, model listing, and no SDK continuation from an API reply', async t => {
  const { fake, turn, store, provider, engine, chat } = await setup(t, 'openai-completions')
  assert.deepEqual(await listRemoteModels(provider), ['m-a', 'm-b'])
  await assert.rejects(listRemoteModels({ ...provider, apiKey: 'wrong' }), error => {
    assert.match(providerError(provider, error), /API Key 无效/)
    return true
  })
  // A connection that failed names its code, also when its message does not (a reset in the TLS handshake).
  const reset = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' })
  assert.match(providerError(provider, reset), /^连不上 .*（ECONNRESET）$/)
  await assert.rejects(listRemoteModels({ ...provider, baseURL: 'http://127.0.0.1:9/v1' }), error => {
    assert.match(providerError(provider, error), /^连不上 .*ECONNREFUSED/)
    assert.equal(providerError(provider, error).split('ECONNREFUSED').length, 2, 'the code once, not again after the message that has it')
    return true
  })
  // No answer before the time is up (a proxy that is off): can't connect, not a bare "aborted".
  const silent = createServer(() => {})
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve))
  t.after(() => silent.close())
  t.after(() => silent.closeAllConnections())
  await assert.rejects(listRemoteModels({ ...provider, baseURL: `http://127.0.0.1:${silent.address().port}/v1` }, { signal: AbortSignal.timeout(200) }), error => {
    assert.match(providerError(provider, error), /^连不上 .*请求超时/)
    return true
  })
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(listRemoteModels(provider, { signal: stopped.signal }), error => {
    assert.match(providerError(provider, error), /aborted$/, 'stopped by hand: still just stopped')
    return true
  })

  await turn('你好')
  await store.saveSettings({ subscription: 'on' })
  const saved = await store.getChat(chat.id)
  saved.model = 'claude-sonnet-5-5'
  await store.saveChat(saved)
  const tip = activePath(saved).at(-1)
  // With the subscription backend (this machine's own install) the model is refused for a provider-written story;
  // without it (public trees) no model outside the providers is accepted.
  await assert.rejects(engine.runTurn(chat.id, { parentId: tip.id, input: '继续' }, () => {}), testSubscription(store, '.', null) ? /压缩上下文/ : /选一个供应商的模型/)

  await store.saveSettings({ subscription: 'off' })
  await assert.rejects(engine.runTurn(chat.id, { parentId: tip.id, input: '继续' }, () => {}), testSubscription(store, '.', null) ? /关闭 Claude 订阅/ : /选一个供应商的模型/)

  saved.model = null
  await store.saveChat(saved)
  await store.saveProviders([{ ...provider, apiKey: 'wrong' }])
  await assert.rejects(engine.runTurn(chat.id, { parentId: tip.id, input: '继续' }, () => {}), error => error.status === 502 && /Fake 拒绝了请求/.test(error.message))
  assert.equal(fake.requests.at(-1).url, '/v1/chat/completions')
})

test('import from DSH: address, protocol and chat models; no keys; re-import keeps a pasted key', async () => {
  const { default: YAML } = await import('yaml')
  const { mergeDshProviders, providersFromDsh } = await import('../server/providers.mjs')
  const doc = YAML.parse(`
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      grok:
        displayName: Grok 本机
        apiKeyEnv: GROK_API_KEY
        api: openai-responses
        baseURL: http://127.0.0.1:8180/v1
        models:
          - id: grok-4.7
          - id: grok-imagine-video
      arkagentplan:
        apiKeyEnv: ARKAGENTPLAN_API_KEY
        api: openai-responses
        baseURL: https://ark.cn-beijing.volces.com/api/plan/v3
        timeoutMs: 600000
        models:
          - id: deepseek-v4.1-flash
      weird:
        api: google-generative-ai
        baseURL: https://example.com
        models: [x]
`)
  const { drafts, skipped } = providersFromDsh(doc)
  assert.deepEqual(drafts.map(d => [d.id, d.name, d.proxy, d.models.map(m => m.id).join()]), [
    ['grok', 'Grok 本机', 'global', 'grok-4.7'],
    ['arkagentplan', 'arkagentplan', 'direct', 'deepseek-v4.1-flash'],
  ])
  assert.match(skipped[0], /weird/)
  const first = mergeDshProviders([], drafts)
  assert.deepEqual(first.added, ['Grok 本机', 'arkagentplan'])
  assert.ok(first.list.every(p => p.apiKey === '' && p.apiKeyEnv === ''))
  first.list[0].apiKey = KEY
  const again = mergeDshProviders(first.list, drafts)
  assert.deepEqual(again.updated, ['Grok 本机', 'arkagentplan'])
  assert.equal(again.list[0].apiKey, KEY, 'a key pasted after the first import survives a re-import')
  assert.throws(() => providersFromDsh({ nothing: true }), /providers/)
  // A DSH key that is not an id as it is (DeepSeek → deepseek): found again, not added twice.
  const upper = [{ ...drafts[1], id: 'DeepSeek', name: 'DeepSeek' }]
  const saved = mergeDshProviders([], upper).list
  saved[0].apiKey = KEY
  const reimported = mergeDshProviders(saved, upper)
  assert.deepEqual([reimported.list.map(p => p.id), reimported.updated, reimported.list[0].apiKey], [['deepseek'], ['DeepSeek'], KEY])
})

test('a model server without a key: on this machine or the local network it is asked, elsewhere the key is asked for', async () => {
  const ask = baseURL => complete(normalizeProvider({ name: '本地', api: 'openai-completions', baseURL, models: [{ id: 'm' }] }), 'm', { messages: [{ role: 'user', content: '你好' }], signal: AbortSignal.abort() })
  for (const lan of ['http://192.168.1.10:1234/v1', 'http://10.0.0.5:11434/v1', 'http://172.20.0.2/v1', 'http://studio.local:1234/v1', 'http://nas:8080/v1', 'http://[fd00::5]:1234/v1']) {
    await assert.rejects(ask(lan), error => !/API Key/.test(error.message), lan)
  }
  for (const far of ['https://api.example.com/v1', 'http://172.32.0.1/v1', 'http://8.8.8.8/v1']) await assert.rejects(ask(far), /还没有填 API Key/, far)
})

test('image prompt inside the conversation: same prefix as the next turn, so the cache hits', async t => {
  const { fake, turn, engine, chat, store } = await setup(t, 'openai-completions')
  await turn('点一杯拿铁')
  const { chat: after } = await turn('再来块蛋糕')
  const tip = activePath(after).at(-1)

  const { cleanMedia, contextImageInstruction, createMedia } = await import('../server/media.mjs')
  await store.saveSettings({ media: cleanMedia({ promptSource: 'chat' }) })
  const media = createMedia(store, { askInContext: engine.askInContext })
  const result = await media.writeImagePrompt(await store.getChat(chat.id), tip, { reply: '', input: '' })
  assert.equal(result.inContext, true)
  assert.equal(result.cache, 60, 'cached share from the provider usage')
  const side = fake.requests.at(-1).body
  assert.equal(side.max_tokens, 400)
  assert.match(side.messages.at(-1).content, /暂停扮演[\s\S]*英文提示词/)
  assert.doesNotMatch(side.messages.at(-1).content, /latest_passage/, 'the reply is already in the history')

  await turn('结账')
  const next = fake.requests.at(-1).body
  assert.deepEqual(side.messages.slice(0, -1), next.messages.slice(0, -1), 'identical prefix: system, both exchanges')

  // The opening is not in the history, so it rides along in the instruction.
  assert.match(contextImageInstruction({ promptStyle: 'tags', style: '水彩', passage: '欢迎光临～' }), /<latest_passage>\n欢迎光临～[\s\S]*画面里一定要有人[\s\S]*画风会自动加上[^\n]*水彩[\s\S]*逗号分隔/)

  // A chat on the subscription cannot lend its context: the helper model takes over.
  const saved = await store.getChat(chat.id)
  saved.model = 'claude-sonnet-5-5'
  await store.saveChat(saved)
  const sdkNode = { ...saved.nodes[tip.id], api: null, model: 'claude-sonnet-5-5' }
  saved.nodes[tip.id] = sdkNode
  await store.saveChat(saved)
  assert.equal(await engine.askInContext(chat.id, tip.id, 'x'), null)
})
test('provider export and import: keys travel, loopback relays stay behind, default model follows', () => {
  const remote = normalizeProvider({ name: 'DeepSeek', api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: KEY, models: [{ id: 'deepseek-chat' }] })
  const relay = normalizeProvider({ name: 'Grok', api: 'openai-responses', baseURL: 'http://127.0.0.1:8180/v1', apiKey: KEY, models: [{ id: 'grok-4' }] }, null, new Set([remote.id]))
  const { archive, skipped } = exportProviders([remote, relay], `${remote.id}/deepseek-chat`)
  assert.deepEqual(skipped, ['Grok'])
  assert.equal(archive.providers.length, 1)
  assert.equal(archive.providers[0].apiKey, KEY)
  assert.equal(archive.defaultModel, 'deepseek/deepseek-chat')
  // The default model is dropped when its provider stays behind.
  assert.equal(exportProviders([remote, relay], 'grok/grok-4').archive.defaultModel, '')

  // Into an empty phone: added under the same id, so the default model still resolves.
  const fresh = importProviders([], JSON.parse(JSON.stringify(archive)))
  assert.deepEqual(fresh.added, ['DeepSeek'])
  assert.equal(fresh.list[0].id, 'deepseek')
  assert.equal(fresh.list[0].apiKey, KEY)
  assert.equal(fresh.defaultModel, 'deepseek/deepseek-chat')

  // Again: same id replaces; a file without a key keeps the saved one; a bad entry is reported.
  const keyless = { ...archive, providers: [{ ...archive.providers[0], apiKey: '', models: [{ id: 'deepseek-reasoner' }] }, { name: 'broken', api: 'nope' }] }
  const again = importProviders(fresh.list, keyless)
  assert.deepEqual(again.updated, ['DeepSeek'])
  assert.equal(again.list.length, 1)
  assert.equal(again.list[0].apiKey, KEY)
  assert.equal(again.list[0].models[0].id, 'deepseek-reasoner')
  assert.equal(again.failed.length, 1)
  assert.match(again.failed[0], /^broken：/)
  assert.deepEqual(again.keyless, [])
  assert.throws(() => importProviders([], { providers: [] }), /不是酒馆导出的供应商文件/)

  // A file that moves the provider elsewhere without a key: the saved key is not sent there, and the player is told.
  const moved = importProviders(fresh.list, { ...archive, providers: [{ ...archive.providers[0], apiKey: '', baseURL: 'https://evil.example/v1' }] })
  assert.deepEqual([moved.list[0].baseURL, moved.list[0].apiKey, moved.keyless], ['https://evil.example/v1', '', ['DeepSeek']])
  // The same host on another path keeps it; a key in the file is the file's.
  assert.equal(importProviders(fresh.list, { ...archive, providers: [{ ...archive.providers[0], apiKey: '', baseURL: 'https://api.deepseek.com/beta' }] }).list[0].apiKey, KEY)
  assert.equal(importProviders(fresh.list, { ...archive, providers: [{ ...archive.providers[0], apiKey: 'sk-other-0000', baseURL: 'https://other.example/v1' }] }).list[0].apiKey, 'sk-other-0000')
})

test('视觉小说格式: switched on for one turn and off for the next, the history is sent again as it was', async t => {
  const { fake, store, chat, engine } = await setup(t, 'openai-completions')
  const tip = async () => activePath(await store.getChat(chat.id)).at(-1).id
  await engine.runTurn(chat.id, { parentId: await tip(), input: '你好', marks: true }, () => {})
  await engine.runTurn(chat.id, { parentId: await tip(), input: '再见' }, () => {})
  const [one, two] = fake.requests.map(r => r.body)
  assert.match(JSON.stringify(one.messages.at(-1)), /<对白格式>/)
  assert.doesNotMatch(JSON.stringify(two.messages.at(-1)), /<对白格式>/)
  assert.deepEqual(two.messages.slice(0, one.messages.length), one.messages, 'the cached part does not change')
  // Regenerating the first turn asks the same way it did.
  const first = activePath(await store.getChat(chat.id)).find(node => node.role === 'user')
  await engine.runTurn(chat.id, { userNodeId: first.id }, () => {})
  assert.match(JSON.stringify(fake.requests.at(-1).body.messages.at(-1)), /<对白格式>/)
})

test('a reply paused mid-search (pause_turn) goes back as it came, and the model carries on', async t => {
  const asked = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    asked.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    send('message_start', { message: { model: body.model, usage: { input_tokens: 10, output_tokens: 1 } } })
    if (asked.length === 1) {
      send('content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } })
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"旧城' } })
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '茶馆"}' } })
      send('content_block_stop', { index: 0 })
      send('content_block_start', { index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com/a', title: '茶馆', encrypted_content: 'enc' }] } })
      send('content_block_stop', { index: 1 })
      send('content_block_start', { index: 2, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 2, delta: { type: 'text_delta', text: '第一段' } })
      send('content_block_stop', { index: 2 })
      send('message_delta', { delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 5 } })
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '第二段' } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } })
    }
    send('message_stop', {})
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const provider = normalizeProvider({ name: 'Claude', api: 'anthropic-messages', baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: KEY, models: [{ id: 'claude-sonnet-5-5' }] })
  const seen = []
  const result = await complete(provider, 'claude-sonnet-5-5', { system: '规则', messages: [{ role: 'user', content: '查一下旧城茶馆' }], webSearch: true, onDelta: text => seen.push(text) })
  assert.equal(asked.length, 2)
  const back = asked[1].messages
  assert.deepEqual(back.map(m => m.role), ['user', 'assistant'])
  assert.deepEqual(back[1].content.map(b => b.type), ['server_tool_use', 'web_search_tool_result', 'text'])
  assert.deepEqual(back[1].content[0].input, { query: '旧城茶馆' })
  assert.equal(back[1].content[1].content[0].encrypted_content, 'enc', 'the search results as they came')
  assert.ok(back[0].content[0].cache_control, 'the cache breakpoint stays on the conversation')
  assert.equal(result.text, '第一段第二段')
  assert.equal(seen.join(''), '第一段第二段')
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(result.truncated, false)
  assert.equal(result.usage.output, 11)
  assert.deepEqual([result.search.count, result.search.queries], [1, ['旧城茶馆']])
})

test('Vertex AI: a service account JSON key or gcloud login file, traded for an access token that is kept until it runs out', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const seen = { tokens: 0, chat: [], google: [], lists: [] }
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (req.url === '/token') {
      const form = new URLSearchParams(body)
      // gcloud's login file: its refresh token.
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== '1//rt-demo' || form.get('client_id') !== 'cid.apps.googleusercontent.com' || form.get('client_secret') !== 'cs') return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)
        seen.tokens += 1
        return json({ access_token: `ya29.token-${seen.tokens}`, expires_in: 3599 })
      }
      // The assertion must be a JWT signed with the service account's key, for this address.
      const assertion = form.get('assertion')
      const [head, claims, signature] = assertion.split('.')
      const valid = createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, signature, 'base64url')
      const payload = JSON.parse(Buffer.from(claims, 'base64url').toString())
      if (!valid || payload.iss !== 'tavern@demo-proj.iam.gserviceaccount.com' || !payload.aud.endsWith('/token')) return json({ error: 'invalid_grant' }, 400)
      seen.tokens += 1
      return json({ access_token: `ya29.token-${seen.tokens}`, expires_in: 3599, token_type: 'Bearer' })
    }
    if (req.headers.authorization !== `Bearer ya29.token-${seen.tokens}`) return json({ error: { message: 'unauthenticated' } }, 401)
    if (req.url.startsWith('/v1beta1/publishers/google/models')) {
      seen.lists.push({ url: req.url, project: req.headers['x-goog-user-project'] })
      return json(req.url.includes('pageToken')
        ? { publisherModels: [{ name: 'publishers/google/models/gemini-3.1-pro-preview' }, { name: 'publishers/google/models/imagen-4.0' }, { name: 'publishers/google/models/gemini-3.5-transcribe-live' }] }
        : { publisherModels: [{ name: 'publishers/google/models/gemini-4-argon' }, { name: 'publishers/google/models/gemini-2.5-flash-image' }], nextPageToken: 'p2' })
    }
    if (req.url.includes('/publishers/google/models/')) {
      seen.google.push(req.url)
      return json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    }
    seen.chat.push({ url: req.url, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const keyFile = JSON.stringify({
    type: 'service_account',
    project_id: 'demo-proj',
    private_key_id: 'abc',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'tavern@demo-proj.iam.gserviceaccount.com',
    token_uri: `${origin}/token`,
  }, null, 2)

  const provider = normalizeProvider({ name: 'Vertex AI', api: 'openai-completions', baseURL: `${origin}/v1/projects/PROJECT_ID/locations/global/endpoints/openapi`, apiKey: keyFile, models: [{ id: 'google/gemini-4-argon' }] })
  assert.equal(provider.baseURL, `${origin}/v1/projects/demo-proj/locations/global/endpoints/openapi`, 'the project comes from the key')
  assert.doesNotMatch(provider.apiKey, /\n/, 'kept on one line')
  assert.equal(JSON.parse(provider.apiKey).private_key_id, undefined, 'only what a token needs')
  assert.equal(publicProvider(provider).keyHint, 'tavern@demo-proj.iam.gserviceaccount.com')
  assert.throws(() => normalizeProvider({ name: 'x', api: 'openai-completions', baseURL: origin, apiKey: '{"type": "authorized_user"}', models: ['m'] }), /服务账号/)

  const reply = await complete(provider, 'google/gemini-4-argon', { system: 's', messages: [{ role: 'user', content: '在吗' }] })
  assert.equal(reply.text, '你好')
  assert.equal(seen.chat[0].url, '/v1/projects/demo-proj/locations/global/endpoints/openapi/chat/completions')
  assert.equal(seen.chat[0].body.model, 'google/gemini-4-argon')
  await complete(provider, 'google/gemini-4-argon', { system: 's', messages: [{ role: 'user', content: '再来' }] })
  assert.equal(seen.tokens, 1, 'one token for both turns')

  // Gemini pictures and speech: Vertex's own generateContent, with the same token.
  assert.equal(isGoogle({ ...provider, baseURL: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi' }), true)
  await googleRequest(provider, '/models/gemini-2.5-flash-image:generateContent', { body: { contents: [] } })
  assert.deepEqual(seen.google, ['/v1/projects/demo-proj/locations/global/publishers/google/models/gemini-2.5-flash-image:generateContent'])

  const listed = await listRemoteModelDetails(provider)
  assert.deepEqual(listed.models, ['google/gemini-3.1-pro-preview', 'google/gemini-4-argon'], 'Gemini chat models from every page, as google/<model>')
  assert.equal(seen.lists.length, 2)
  assert.equal(seen.lists[0].project, 'demo-proj', 'its address names no project: the header says which one')

  // An organization that allows no keys: the file `gcloud auth application-default login` writes. It names no project.
  const login = JSON.stringify({ client_id: 'cid.apps.googleusercontent.com', client_secret: 'cs', refresh_token: '1//rt-demo', type: 'authorized_user', universe_domain: 'googleapis.com', token_uri: `${origin}/token` })
  const template = { name: 'Vertex AI', api: 'openai-completions', baseURL: `${origin}/v1/projects/PROJECT_ID/locations/global/endpoints/openapi`, apiKey: login, models: [{ id: 'google/gemini-4-argon' }] }
  assert.throws(() => normalizeProvider(template), /PROJECT_ID/, 'the project has to be written in')
  const byLogin = normalizeProvider({ ...template, baseURL: template.baseURL.replace('PROJECT_ID', 'my-proj') })
  assert.match(publicProvider(byLogin).keyHint, /gcloud/)
  assert.equal(normalizeProvider({ ...template, apiKey: JSON.stringify({ ...JSON.parse(login), quota_project_id: 'quota-proj' }) }).baseURL, `${origin}/v1/projects/quota-proj/locations/global/endpoints/openapi`, 'or comes from the quota project')
  const before = seen.tokens
  assert.equal((await complete(byLogin, 'google/gemini-4-argon', { system: 's', messages: [{ role: 'user', content: '在吗' }] })).text, '你好')
  assert.equal(seen.tokens, before + 1)
  assert.equal(seen.chat.at(-1).url, '/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions')
  const revoked = normalizeProvider({ ...template, baseURL: byLogin.baseURL, apiKey: login.replace('rt-demo', 'rt-old') })
  await assert.rejects(complete(revoked, 'google/gemini-4-argon', { system: 's', messages: [{ role: 'user', content: 'x' }] }), /expired or revoked[\s\S]*application-default login/)
})

test('Agent Platform with an API key: sent in x-goog-api-key, models found by counting tokens, a wrong project said so', async t => {
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ url: req.url, key: req.headers['x-goog-api-key'], bearer: req.headers.authorization })
    const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (req.url.includes('/projects/300Free/')) return json(403, { error: { code: 403, message: 'Permission denied on resource project 300Free.', status: 'PERMISSION_DENIED' } })
    // The project has three models, one of them only written in by hand.
    if (req.url.endsWith(':countTokens')) return /\/(gemini-4-argon|gemini-3\.8-flash|gemini-own-tune):countTokens$/.test(req.url) ? json(200, { totalTokens: 1 }) : json(404, { error: { code: 404, message: 'Publisher model was not found or your project does not have access to it.' } })
    if (req.url.includes('/publishers/google/models/')) return json(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const at = project => normalizeProvider({ name: 'Gemini Agent Platform API', api: 'openai-completions', baseURL: `${origin}/v1/projects/${project}/locations/global/endpoints/openapi`, apiKey: 'AQ.key', models: [{ id: 'google/gemini-3.8-flash' }] })
  const provider = at('demo-proj')

  assert.equal((await complete(provider, 'google/gemini-3.8-flash', { system: 's', messages: [{ role: 'user', content: 'hi' }] })).text, '你好')
  assert.deepEqual(seen.at(-1), { url: '/v1/projects/demo-proj/locations/global/endpoints/openapi/chat/completions', key: 'AQ.key', bearer: undefined }, 'the key in Google\'s header, not after Bearer')
  seen.length = 0
  // The Model Garden takes no API key: the models written in and the known ones, each counted (free).
  assert.deepEqual(await listRemoteModels(provider), ['google/gemini-3.8-flash', 'google/gemini-4-argon'])
  assert.equal(seen[0].url, '/v1/projects/demo-proj/locations/global/publishers/google/models/gemini-3.8-flash:countTokens', 'the one written in first')
  assert.ok(seen.length > 5 && seen.every(hit => hit.url.endsWith(':countTokens') && hit.key === 'AQ.key'))
  // As the settings form asks (「从接口获取模型列表」): the models written in so far come along, one not on the known list too.
  const form = { name: provider.name, api: provider.api, baseURL: provider.baseURL, models: [{ id: 'google/gemini-own-tune' }] }
  assert.deepEqual(await listRemoteModels(draftProvider(form, provider)), ['google/gemini-3.8-flash', 'google/gemini-4-argon', 'google/gemini-own-tune'])
  await assert.rejects(listRemoteModels(draftProvider({ ...form, models: [] }, { ...provider, models: [] })), error => error.status === 400 && /先在「模型」里填一个模型 ID/.test(error.message))
  await googleRequest(provider, '/models/gemini-3.8-flash:generateContent', { body: {} })
  assert.equal(seen.at(-1).key, 'AQ.key', 'pictures and speech: the same key')
  seen.length = 0
  await assert.rejects(listRemoteModels(at('300Free')), error => {
    assert.match(providerError(provider, error), /不认地址里的项目：.*不是项目名称/)
    return true
  })
  assert.ok(seen.length <= 6, 'the project turned away: no more models asked than were under way')
  assert.throws(() => at('PROJECT_ID'), /PROJECT_ID/, 'the template\'s placeholder left in the address')
})

test('a busy Vertex AI (429) is asked again after a wait, twice at most; other providers are not', async t => {
  let busy = 0
  let delay = '0.05s'
  const hits = []
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    hits.push(req.url)
    if (busy > 0) {
      busy -= 1
      res.writeHead(429, { 'content-type': 'application/json' })
      return res.end(JSON.stringify([{ error: { code: 429, message: 'Resource exhausted. Please try again later.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] } }]))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const vertex = normalizeProvider({ name: 'Vertex AI', api: 'openai-completions', baseURL: `${origin}/v1/projects/demo/locations/global/endpoints/openapi`, apiKey: 'k', models: [{ id: 'google/gemini-4-argon' }] })
  const relay = normalizeProvider({ name: 'relay', api: 'openai-completions', baseURL: `${origin}/v1`, apiKey: 'k', models: [{ id: 'm' }] })
  const retries = []
  const ask = provider => complete(provider, provider.models[0].id, { system: 's', messages: [{ role: 'user', content: 'hi' }], onRetry: info => retries.push(info) })
  const again = () => {
    retries.length = 0
    hits.length = 0
  }

  busy = 2
  assert.equal((await ask(vertex)).text, '你好', 'answered on the third try')
  assert.deepEqual(retries.map(r => [r.attempt, r.of, r.wait]), [[1, 2, 50], [2, 2, 50]], 'as long as Google said each time')
  assert.equal(hits.length, 3)

  again()
  busy = 3
  await assert.rejects(ask(vertex), error => error.providerStatus === 429 && /Resource exhausted/.test(error.message) && /已经自动重试了 2 次/.test(error.hint))
  assert.equal(hits.length, 3, 'given up after two retries')

  again()
  busy = 1
  delay = '60s'
  await assert.rejects(ask(vertex), error => error.providerStatus === 429 && !error.hint)
  assert.deepEqual([hits.length, retries.length], [1, 0], 'Google asking for longer than we wait: given up at once')

  again()
  busy = 1
  delay = '0.05s'
  await assert.rejects(ask(relay), error => error.providerStatus === 429 && !error.hint)
  assert.deepEqual([hits.length, retries.length], [1, 0], 'another provider: not asked again')
})
