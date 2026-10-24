import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, chatView, createChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { testSubscription } from './support/subscription.mjs'
import { editPreset, normalizePreset } from '../server/presets.mjs'
import { complete, exportProviders, importProviders, listRemoteModels, normalizeProvider, providerChoices, providerError, publicProvider, reasoningFields } from '../server/providers.mjs'
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
  const flags = { rejectTtl: false, rejectReasoning: false, maxOutput: 0, contextLimit: 0, stopReason: 'end_turn' }
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
      return res.end(JSON.stringify({ error: { message: 'Context window is full. Reduce conversation history, system prompt, or tools.' } }))
    }
    if (flags.maxOutput && json?.max_tokens > flags.maxOutput) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: `max_tokens: ${json.max_tokens} > ${flags.maxOutput}, which is the maximum allowed number of output tokens` } }))
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a' }] }))
    }
    const lastUser = JSON.stringify((json.messages ?? json.input).at(-1))
    // 「标签写错」: a state block closed with MVU's tag, as some models write it.
    const text = lastUser.includes('暂停扮演') ? SUMMARY : lastUser.includes('标签写错') ? `第 ${++count} 次回复${CROSSED}` : `第 ${++count} 次回复<hide>变量${count}</hide>`
    const half = Math.ceil(text.length / 2)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    if (req.url === '/v1/chat/completions') {
      send({ model: json.model, choices: [{ delta: { role: 'assistant', reasoning_content: '想一想' } }] })
      send({ model: json.model, choices: [{ delta: { content: text.slice(0, half) } }] })
      send({ model: json.model, choices: [{ delta: { content: text.slice(half) }, finish_reason: 'stop' }] })
      send({ model: json.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } })
      send('[DONE]')
    } else if (req.url === '/v1/responses') {
      send({ type: 'response.created', response: { model: json.model } }, 'response.created')
      send({ type: 'response.output_text.delta', delta: text.slice(0, half) }, 'response.output_text.delta')
      send({ type: 'response.output_text.delta', delta: text.slice(half) }, 'response.output_text.delta')
      send({ type: 'response.completed', response: { model: json.model, status: 'completed', usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 9 } } }, 'response.completed')
    } else if (req.url === '/v1/messages') {
      send({ type: 'message_start', message: { model: json.model, usage: { input_tokens: 5, cache_read_input_tokens: 70, cache_creation_input_tokens: 30, output_tokens: 1 } } }, 'message_start')
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } }, 'content_block_delta')
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } }, 'content_block_delta')
      send({ type: 'message_delta', delta: { stop_reason: flags.stopReason }, usage: { output_tokens: 11 } }, 'message_delta')
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

  await turn('结账')
  const next = fake.requests.at(-1).body
  assert.equal(next.messages.length, 2, 'only the system prompt and the new message')
  assert.match(next.messages[1].content, /<前情提要>[\s\S]*桂花拿铁[\s\S]*结账/)
  await turn('再见')
  assert.equal(fake.requests.at(-1).body.messages.length, 4, 'then it continues from the compaction point')
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
  assert.match(contextImageInstruction({ promptStyle: 'tags', style: '水彩', passage: '欢迎光临～' }), /<latest_passage>\n欢迎光临～[\s\S]*画面里一定要有人[\s\S]*画风：水彩[\s\S]*逗号分隔/)

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
  assert.throws(() => importProviders([], { providers: [] }), /不是酒馆导出的供应商文件/)
})
