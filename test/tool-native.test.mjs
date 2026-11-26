// 直连对话的工具, through the APIs' own tool calling (server/providers.mjs, engine.mjs): Chat Completions and Anthropic, as
// a stream and whole; what goes back with a call; a model that takes no tools.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { createGuard } from '../server/tools/paths.mjs'
import { fileToolDefs } from '../server/tools/files.mjs'
import { blockRequest } from '../server/blockwords.mjs'
import { DIRECT_CARD } from '../web/shared/basic.js'

let providers = 0

/** @param answer - (request, n) => { status?, body } (whole) or { events } (a stream of data objects) */
async function setup(t, api, answer, { mode = 'write', free = true, stream = false, model = 'm' } = {}) {
  const sent = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    sent.push(request)
    const said = answer(request, sent.length)
    if (said.events) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of said.events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    res.writeHead(said.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(said.body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'cica-native-')))
  const root = await mkdtemp(path.join(tmpdir(), 'cica-native-data-'))
  const novel = path.join(base, 'novel')
  await mkdir(novel)
  await writeFile(path.join(novel, '一.txt'), '她抬起头。\n雨停了。\n')
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release', toolGuard: createGuard({ dataRoot: root, appRoot: path.join(base, 'app'), home: path.join(base, 'home', 'me'), env: {} }) })
  const http = await app.listen({ port: 0 })
  t.after(async () => {
    server.closeAllConnections()
    http.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => http.close(resolve))])
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
    await rm(base, { recursive: true, force: true, maxRetries: 5 })
  })
  const url = `http://127.0.0.1:${http.address().port}`
  const call = async (method, at, body) => (await fetch(url + at, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })).json()
  // A provider of its own each time: what one refused is remembered by its id.
  const id = `p${++providers}`
  await app.store.saveProviders([{ id, name: 'P', api, baseURL: `http://127.0.0.1:${server.address().port}${api === 'anthropic-messages' ? '' : '/v1'}`, apiKey: 'k', models: [{ id: model }], proxy: 'direct', cacheTtl: '5m', ...(stream ? {} : { stream: false }) }])
  await call('PUT', '/api/settings', { model: `${id}/${model}`, thinking: 'adaptive', effort: 'low' })
  await call('PUT', '/api/tools', { on: true })
  const chat = await call('POST', '/api/chats', { cardId: DIRECT_CARD })
  await call('PUT', `/api/chats/${chat.id}/tools`, { folders: [{ path: novel, mode, free }] })
  const turn = async input => {
    const view = await call('GET', `/api/chats/${chat.id}`)
    const res = await fetch(`${url}/api/chats/${chat.id}/turn`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: JSON.stringify({ parentId: view.replyTip, input }) })
    const events = (await res.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    return { events, end: events.at(-1), node: events.at(-1).chat?.path.at(-1) }
  }
  return { sent, turn, call, chat, novel, app, text: () => readFile(path.join(novel, '一.txt'), 'utf8') }
}

const fn = (id, name, args, extra = {}) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }, ...extra })
const whole = (message, finish = 'tool_calls') => ({ body: { choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10 } } })

test('Chat Completions: read, edited, answered; the calls go back as they came', async t => {
  const { sent, turn, text } = await setup(t, 'openai-completions', (_, n) => [
    whole({ content: '我先读。', tool_calls: [fn('call_1', 'read_file', { path: 'novel/一.txt' })] }),
    whole({ content: null, tool_calls: [fn('call_2', 'edit_file', { path: 'novel/一.txt', old: '雨停了。', new: '雪停了。</tool> "引号" <new>' })] }),
    whole({ content: '改好了。' }, 'stop'),
    whole({ content: '记得。' }, 'stop'),
  ][n - 1])
  const { node, events } = await turn('改')
  assert.equal(node.text, '改好了。')
  assert.equal(await text(), '她抬起头。\n雪停了。</tool> "引号" <new>\n', 'nothing in a content can end anything')
  assert.deepEqual(node.steps.map(step => [step.name, step.ok, step.said]), [['read_file', true, '我先读。'], ['edit_file', true, undefined]])
  assert.deepEqual(events.filter(event => event.type === 'restart').length, 1, 'the words before a call go with the step')
  assert.equal(sent[0].tools[0].type, 'function')
  assert.doesNotMatch(sent[0].messages[0].content, /<tool/, 'no text way told beside it')
  assert.deepEqual(sent[1].messages.slice(2), [
    { role: 'assistant', content: '我先读。', tool_calls: [fn('call_1', 'read_file', { path: 'novel/一.txt' })] },
    { role: 'tool', tool_call_id: 'call_1', content: '「novel/一.txt」第 1–2 行，共 2 行：\n她抬起头。\n雨停了。' },
  ])
  assert.equal(sent[2].messages[4].content, null)
  await turn('还记得吗')
  assert.deepEqual(sent[3].messages.slice(0, 6), sent[2].messages, 'the next turn reads as this one was sent: the cache')
  assert.deepEqual(sent[3].messages.slice(6).map(message => message.role), ['assistant', 'user'])
})

test('Chat Completions as a stream: a call in pieces, several in one reply, one not whole', async t => {
  const piece = (delta, finish = null) => ({ choices: [{ delta, finish_reason: finish }] })
  const { sent, turn } = await setup(t, 'openai-completions', (_, n) => (n === 1
    ? { events: [
      piece({ content: '看看' }),
      piece({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
      piece({ tool_calls: [{ index: 0, function: { arguments: '{"path":"nov' } }] }),
      piece({ tool_calls: [{ index: 0, function: { arguments: 'el/一.txt"}' } }, { index: 1, id: 'b', type: 'function', function: { name: 'list_files', arguments: '{}' } }] }),
      piece({ tool_calls: [{ index: 2, id: 'c', type: 'function', function: { name: 'write_file', arguments: '{"path":"novel/x.txt","content":"写到' } }] }),
      piece({}, 'length'),
    ] }
    : { events: [piece({ content: '好。' }, 'stop')] }), { stream: true })
  const { node } = await turn('看')
  assert.deepEqual(node.steps.map(step => [step.name, step.ok]), [['read_file', true], ['list_files', true], ['write_file', false]])
  assert.match(node.steps[2].kept, /不是完整的 JSON/)
  const back = sent[1].messages.slice(2)
  assert.deepEqual(back.map(message => message.role), ['assistant', 'tool', 'tool', 'tool'], 'each call has its result')
  assert.deepEqual(back[0].tool_calls.map(item => item.id), ['a', 'b', 'c'])
  assert.deepEqual(back.slice(1).map(message => message.tool_call_id), ['a', 'b', 'c'])
})

test('a service that leaves the index out, or sends the arguments as an object', async t => {
  const piece = (delta, finish = null) => ({ choices: [{ delta, finish_reason: finish }] })
  const { turn } = await setup(t, 'openai-completions', (_, n) => (n === 1
    ? { events: [piece({ tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{"path":' } }] }), piece({ tool_calls: [{ function: { arguments: '"novel/一.txt"}' } }] }), piece({ tool_calls: [{ id: 'b', function: { name: 'list_files', arguments: { path: 'novel' } } }] }, 'tool_calls')] }
    : { events: [piece({ content: '好。' }, 'stop')] }), { stream: true })
  assert.deepEqual((await turn('看')).node.steps.map(step => [step.name, step.ok, step.args.path]), [['read_file', true, 'novel/一.txt'], ['list_files', true, 'novel']])
})

test('thinking wanted back (DeepSeek): with its own replies, in this turn and the later ones, never to another model', async t => {
  const { sent, turn, call, chat, app } = await setup(t, 'openai-completions', (_, n) => [
    whole({ content: '', reasoning_content: '想一', tool_calls: [fn('a', 'read_file', { path: 'novel/一.txt' })] }),
    whole({ content: '看完了。', reasoning_content: '想二' }, 'stop'),
    whole({ content: '再见。' }, 'stop'),
    whole({ content: '换了。' }, 'stop'),
    whole({ content: '没有工具了。' }, 'stop'),
  ][n - 1])
  await turn('看')
  assert.equal(sent[1].messages[2].reasoning_content, '想一')
  await turn('再见')
  assert.deepEqual(sent[2].messages.filter(message => message.role === 'assistant').map(message => message.reasoning_content), ['想一', '想二'])
  // Another model on the same address: calls yes, thinking no.
  const [provider] = await app.store.getProviders()
  await app.store.saveProviders([{ ...provider, models: [...provider.models, { id: 'other' }] }])
  await call('PUT', `/api/chats/${chat.id}`, { model: `${provider.id}/other` })
  await turn('换模型')
  assert.ok(sent[3].messages[2].tool_calls)
  assert.doesNotMatch(JSON.stringify(sent[3].messages), /想一|想二/)
  // The folders taken away: no tools, and no call of their kind left in the history.
  await call('PUT', `/api/chats/${chat.id}/tools`, { folders: [] })
  await turn('还在吗')
  assert.equal(sent[4].tools, undefined)
  assert.doesNotMatch(JSON.stringify(sent[4].messages), /tool_calls|reasoning_content/)
  assert.match(JSON.stringify(sent[4].messages), /<tool name=/)
})

test('a service that asks for the thinking of replies that have none gets an empty one', async t => {
  const { sent, turn } = await setup(t, 'openai-completions', request => {
    const bare = request.messages.some(message => message.role === 'assistant' && message.reasoning_content === undefined)
    if (bare) return { status: 400, body: { error: { message: 'Missing `reasoning_content` field in the assistant message at message index 2.' } } }
    return whole({ content: '好。' }, 'stop')
  })
  await turn('一')
  const { node, end } = await turn('二')
  assert.equal(node?.text, '好。', JSON.stringify(end).slice(0, 300))
  assert.equal(sent.at(-1).messages[2].reasoning_content, '')
  assert.ok(sent.at(-1).tools)
})

test('what a service sends with a call goes back with it (Gemini’s signature), not to another', async t => {
  const extra = { extra_content: { google: { thought_signature: 'sig' } } }
  const { sent, turn } = await setup(t, 'openai-completions', (_, n) => [
    whole({ content: '', tool_calls: [fn('a', 'list_files', {}, extra)] }),
    whole({ content: '好。' }, 'stop'), whole({ content: '好。' }, 'stop'),
  ][n - 1])
  await turn('看')
  assert.deepEqual(sent[1].messages[2].tool_calls[0].extra_content, extra.extra_content)
  await turn('再')
  assert.deepEqual(sent[2].messages[2].tool_calls[0].extra_content, extra.extra_content)
})

test('no tools taken: the same turn again with the calls as text, and so from then on', async t => {
  const { sent, turn, text } = await setup(t, 'openai-completions', (request, n) => {
    if (request.tools) return { status: 400, body: { error: { message: 'm does not support tools' } } }
    return whole({ content: n === 2 ? '<tool name="read_file" path="novel/一.txt"/>' : n === 3 ? '<tool name="edit_file" path="novel/一.txt"><old>雨</old><new>雪</new></tool>' : '好。' }, 'stop')
  })
  const { node } = await turn('改')
  assert.equal(node.text, '好。')
  assert.equal(await text(), '她抬起头。\n雪停了。\n')
  assert.match(sent[1].messages[0].content, /<tool name="read_file"/)
  await turn('再')
  assert.equal(sent.filter(request => request.tools).length, 1)
})

test('a 400 about something else is still that error, with tools on', async t => {
  const { sent, turn } = await setup(t, 'openai-completions', () => ({ status: 400, body: { error: { message: 'Invalid value for temperature' } } }))
  const { end } = await turn('改')
  assert.equal(end.type, 'error')
  assert.match(end.message, /temperature/)
  assert.equal(sent.length, 1)
})

test('Anthropic: thinking goes back with the call in the turn, as it came; later turns have the calls alone', async t => {
  const answer = (content, stop) => ({ body: { model: 'claude-sonnet-5-5', content, stop_reason: stop, usage: { input_tokens: 9000, output_tokens: 10 } } })
  const thinking = { type: 'thinking', thinking: '想想', signature: 'sig==' }
  const { sent, turn, text } = await setup(t, 'anthropic-messages', (_, n) => [
    answer([thinking, { type: 'text', text: '' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'novel/一.txt' } }], 'tool_use'),
    answer([{ type: 'tool_use', id: 'toolu_2', name: 'edit_file', input: { path: 'novel/一.txt', old: '雨', new: '雪' } }, { type: 'tool_use', id: 'toolu_3', name: 'read_file', input: { path: 'novel/没有.txt' } }], 'tool_use'),
    answer([{ type: 'text', text: '好了。' }], 'end_turn'),
    answer([{ type: 'text', text: '记得。' }], 'end_turn'),
  ][n - 1], { model: 'claude-sonnet-5-5' })
  const { node, end } = await turn('改')
  assert.equal(node?.text, '好了。', JSON.stringify(end).slice(0, 400))
  assert.equal(await text(), '她抬起头。\n雪停了。\n')
  assert.deepEqual(sent[0].tools[2].input_schema.required, ['path'])
  assert.equal(sent[0].tool_choice, undefined)
  assert.deepEqual(sent[1].messages.at(-2), { role: 'assistant', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'novel/一.txt' } }] })
  const result = sent[1].messages.at(-1)
  assert.deepEqual([result.role, result.content[0].type, result.content[0].tool_use_id, result.content[0].cache_control], ['user', 'tool_result', 'toolu_1', { type: 'ephemeral' }])
  assert.deepEqual(sent[2].messages.at(-1).content.map(block => [block.tool_use_id, block.is_error ?? false]), [['toolu_2', false], ['toolu_3', true]], 'every call answered, in one message')
  // Four marks at most.
  for (const request of sent) assert.ok(JSON.stringify(request).split('cache_control').length - 1 <= 4)
  await turn('记得吗')
  assert.doesNotMatch(JSON.stringify(sent[3].messages), /thinking|sig==/)
  assert.deepEqual(sent[3].messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'])
  assert.deepEqual(sent[3].messages[3].content.map(block => block.id), ['toolu_2', 'toolu_3'], 'those of one reply together')
})

test('Anthropic as a stream: a call in pieces; one cut off by the limit is not run', async t => {
  const start = { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 9000 } } }
  const end = stop => [{ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]
  const { sent, turn, novel } = await setup(t, 'anthropic-messages', (_, n) => ({ events: [
    [start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } }, { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'list_files', input: {} } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th":"novel"}' } }, { type: 'content_block_stop', index: 1 },
      ...end('tool_use')],
    [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't2', name: 'write_file', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"novel/x.txt","content":"写' } }, { type: 'content_block_stop', index: 0 }, ...end('max_tokens')],
    [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好。' } }, { type: 'content_block_stop', index: 0 }, ...end('end_turn')],
  ][n - 1] }), { stream: true, model: 'claude-sonnet-5-5' })
  const { node, end: last } = await turn('写')
  assert.equal(node?.text, '好。', JSON.stringify(last).slice(0, 400))
  assert.deepEqual(node.steps.map(step => [step.name, step.ok]), [['list_files', true], ['write_file', false]])
  assert.deepEqual(sent[1].messages.at(-2).content, [{ type: 'thinking', thinking: '想', signature: 's' }, { type: 'tool_use', id: 't1', name: 'list_files', input: { path: 'novel' } }])
  await assert.rejects(readFile(path.join(novel, 'x.txt')))
})

test('a tool there is none of; more calls than a turn may have: each still answered', async t => {
  const many = Array.from({ length: 30 }, (_, i) => fn(`c${i}`, i ? 'list_files' : 'run_command', i ? { find: `x${i}` } : { cmd: 'dir' }))
  const { sent, turn } = await setup(t, 'openai-completions', (_, n) => (n === 1 ? whole({ content: '', tool_calls: many }) : whole({ content: '好。' }, 'stop')))
  const { node } = await turn('看')
  assert.equal(node.steps.length, 25)
  assert.match(node.steps[0].kept, /没有「run_command」/)
  assert.equal(sent[1].messages.filter(message => message.role === 'tool').length, 30)
  assert.match(sent[1].messages.at(-1).content, /没有执行/)
})

test('屏蔽词 reach the calls and what they found, not the thinking blocks a service signed', () => {
  const words = [{ id: 'w', word: '雨', replacement: '雪', exceptions: [], enabled: true, mode: 'replace', scope: 'both' }]
  const sent = blockRequest({ system: '', messages: [{ role: 'assistant', content: '雨', calls: [{ id: 'a', name: 'x', input: { old: '雨', edits: [{ new: '雨' }], from: 2 } }], blocks: [{ type: 'thinking', thinking: '雨' }] }, { role: 'tool', results: [{ id: 'a', text: '雨', ok: true }] }] }, words)
  assert.equal(sent.messages[0].content, '雪')
  assert.deepEqual([sent.messages[0].calls[0].input, sent.messages[1].results[0].text, sent.messages[0].blocks[0].thinking], [{ old: '雪', edits: [{ new: '雪' }], from: 2 }, '雪', '雨'])
})

test('what is offered: the writing tools only where there is something to write; names every API takes', () => {
  const names = fileToolDefs([{ label: 'a', mode: 'read' }]).map(tool => tool.name)
  assert.deepEqual(names, ['list_files', 'search_files', 'read_file'])
  for (const tool of fileToolDefs([{ label: 'a', mode: 'write' }])) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/)
    assert.equal(tool.parameters.type, 'object')
  }
})
