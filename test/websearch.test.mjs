// 联网 (web search): which providers search, what each protocol is sent, and the queries and
// pages read back from the stream; a chat with it on sends it on its turns and keeps the sources.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, chatView, createChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { complete, normalizeProvider, providerChoices, webSearchKind } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const KEY = 'sk-test-search'
const PREAMBLE = '让我查一下。'
const STORY = '她抬头看了眼窗外：「听说今天东京下雪了。」'

/** A provider that searches once when the request carries a search tool (or a `:online` model). */
async function fakeSearcher(t) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = JSON.parse(body)
    requests.push({ url: req.url, body: json })
    const searching = Boolean(json.tools?.length) || /:online$/.test(json.model)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`)
    if (req.url === '/v1/messages') {
      send({ type: 'message_start', message: { model: json.model, usage: { input_tokens: 10, output_tokens: 1 } } })
      let index = 0
      if (searching) {
        send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: PREAMBLE } })
        send({ type: 'content_block_stop', index: index++ })
        send({ type: 'content_block_start', index, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } })
        send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"query": "东京' } })
        send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: ' 天气"}' } })
        send({ type: 'content_block_stop', index: index++ })
        send({ type: 'content_block_start', index, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
          { type: 'web_search_result', url: 'https://weather.example/tokyo', title: '东京天气' },
          { type: 'web_search_result', url: 'javascript:alert(1)', title: 'bad' },
          { type: 'web_search_result', url: 'https://news.example/snow', title: '东京降雪' },
        ] } })
        send({ type: 'content_block_stop', index: index++ })
      }
      send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: STORY } })
      if (searching) send({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://news.example/snow', title: '东京降雪', cited_text: '下雪' } } })
      send({ type: 'content_block_stop', index })
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20, ...(searching ? { server_tool_use: { web_search_requests: 1 } } : {}) } })
      send({ type: 'message_stop' })
    } else if (req.url === '/v1/responses') {
      send({ type: 'response.created', response: { model: json.model } })
      const output = []
      if (searching) {
        send({ type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } })
        output.push({ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: '东京 天气' } })
      }
      send({ type: 'response.output_text.delta', delta: STORY })
      if (searching) send({ type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://news.example/snow', title: '东京降雪' } })
      output.push({ type: 'message', content: [{ type: 'output_text', text: STORY, annotations: searching ? [{ type: 'url_citation', url: 'https://news.example/snow', title: '东京降雪' }] : [] }] })
      send({ type: 'response.completed', response: { model: json.model, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 20 } } })
    } else {
      send({ model: json.model, choices: [{ delta: { content: STORY } }] })
      if (searching) send({ model: json.model, choices: [{ delta: { annotations: [{ type: 'url_citation', url_citation: { url: 'https://news.example/snow', title: '东京降雪' } }] } }] })
      send({ model: json.model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })
      res.write('data: [DONE]\n\n')
    }
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { requests, baseURL: `http://127.0.0.1:${server.address().port}/v1` }
}

test('which providers search: OpenRouter on any interface, Claude on Anthropic Messages, the Responses API; plain Chat Completions not', () => {
  const at = (api, baseURL) => ({ api, baseURL })
  assert.equal(webSearchKind(at('openai-completions', 'https://openrouter.ai/api/v1'), 'deepseek/deepseek-v4'), 'openrouter')
  assert.equal(webSearchKind(at('anthropic-messages', 'https://openrouter.ai/api'), 'anthropic/claude-sonnet-5.5'), 'openrouter')
  assert.equal(webSearchKind(at('anthropic-messages', 'https://api.anthropic.com'), 'claude-opus-5-5'), 'anthropic')
  assert.equal(webSearchKind(at('anthropic-messages', 'https://api.deepseek.com/anthropic'), 'deepseek-chat'), null, 'not a Claude model')
  assert.equal(webSearchKind(at('openai-responses', 'https://api.openai.com/v1'), 'gpt-5'), 'openai')
  assert.equal(webSearchKind(at('openai-completions', 'https://api.deepseek.com'), 'deepseek-chat'), null)
  assert.equal(webSearchKind(at('openai-completions', 'not a url'), 'x'), null)
  const choices = providerChoices([normalizeProvider({ name: 'A', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKey: KEY, models: [{ id: 'claude-opus-5-5' }, { id: 'other' }] })])
  assert.deepEqual(choices.map(c => c.search), ['anthropic', null])
})

test('Anthropic: the web_search tool, the query, the pages (cited first, http only), and the words before the search dropped', async t => {
  const fake = await fakeSearcher(t)
  const provider = normalizeProvider({ name: 'A', api: 'anthropic-messages', baseURL: fake.baseURL, apiKey: KEY, models: [{ id: 'claude-x' }] })
  const shown = []
  const result = await complete(provider, 'claude-x', { system: 's', messages: [{ role: 'user', content: '外面怎么样' }], webSearch: true, onDelta: d => shown.push(d) })
  assert.deepEqual(fake.requests[0].body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
  assert.equal(result.text, STORY)
  assert.equal(shown.join(''), PREAMBLE + STORY, 'the stream showed it as it came')
  assert.deepEqual(result.search, {
    count: 1,
    queries: ['东京 天气'],
    sources: [{ url: 'https://news.example/snow', title: '东京降雪' }, { url: 'https://weather.example/tokyo', title: '东京天气' }],
  })
  const plain = await complete(provider, 'claude-x', { system: 's', messages: [{ role: 'user', content: '外面怎么样' }] })
  assert.equal(fake.requests[1].body.tools, undefined, 'off: no tool')
  assert.equal(plain.search, null)
})

test('Responses: the web_search tool, web_search_call queries and url_citation pages', async t => {
  const fake = await fakeSearcher(t)
  const provider = normalizeProvider({ name: 'O', api: 'openai-responses', baseURL: fake.baseURL, apiKey: KEY, models: [{ id: 'gpt-x' }] })
  const result = await complete(provider, 'gpt-x', { system: 's', messages: [{ role: 'user', content: '外面怎么样' }], webSearch: true })
  assert.deepEqual(fake.requests[0].body.tools, [{ type: 'web_search' }])
  assert.equal(result.text, STORY)
  assert.deepEqual(result.search, { count: 1, queries: ['东京 天气'], sources: [{ url: 'https://news.example/snow', title: '东京降雪' }] })
})

test('Chat Completions: nothing added where there is no search; OpenRouter-style annotations still read', async t => {
  const fake = await fakeSearcher(t)
  const provider = normalizeProvider({ name: 'C', api: 'openai-completions', baseURL: fake.baseURL, apiKey: KEY, models: [{ id: 'm' }] })
  const result = await complete(provider, 'm', { system: 's', messages: [{ role: 'user', content: '外面怎么样' }], webSearch: true })
  assert.equal(fake.requests[0].body.model, 'm', 'no :online away from OpenRouter')
  assert.equal(fake.requests[0].body.tools, undefined)
  assert.equal(result.search, null)
  const online = await complete(provider, 'm:online', { system: 's', messages: [{ role: 'user', content: '外面怎么样' }] })
  assert.deepEqual(online.search, { count: 0, queries: [], sources: [{ url: 'https://news.example/snow', title: '东京降雪' }] })
})

test('a chat with 联网 on: its turns carry the tool and say when to search; the reply keeps its sources; off again, neither', async t => {
  const fake = await fakeSearcher(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-search-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '小雨', first_mes: '欢迎光临～' } })
  await store.saveCard(card)
  const provider = normalizeProvider({ name: 'A', api: 'anthropic-messages', baseURL: fake.baseURL, apiKey: KEY, models: [{ id: 'claude-x' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/claude-x`, subscription: 'off' })
  const engine = createEngine(store, { proxy: null })
  const chat = await createChat(store, card.id)
  assert.equal(chatView(chat).webSearch, false)
  const turn = async input => engine.runTurn(chat.id, { parentId: activePath(await store.getChat(chat.id)).at(-1).id, input }, () => {})

  const saved = await store.getChat(chat.id)
  saved.webSearch = true
  await store.saveChat(saved)
  const first = (await turn('外面下雪了吗')).chat
  const sent = fake.requests.at(-1).body
  assert.equal(sent.tools?.[0]?.type, 'web_search_20250305')
  assert.match(sent.messages.at(-1).content[0].text, /<联网搜索>/)
  const reply = activePath(first).at(-1)
  assert.equal(reply.text, STORY)
  assert.equal(reply.search.queries[0], '东京 天气')
  const view = chatView(first)
  assert.equal(view.webSearch, true)
  assert.equal(view.path.at(-1).search.sources[0].url, 'https://news.example/snow')

  const off = await store.getChat(chat.id)
  off.webSearch = false
  await store.saveChat(off)
  const second = (await turn('好吧')).chat
  const plain = fake.requests.at(-1).body
  assert.equal(plain.tools, undefined)
  assert.doesNotMatch(plain.messages.at(-1).content[0].text, /<联网搜索>/)
  assert.equal(activePath(second).at(-1).search, undefined)
})
