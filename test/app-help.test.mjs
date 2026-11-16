// 应用帮助 (直连对话): the assistant answers about CicaTavern from its help docs and its own source (server/help.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { appHelp, helpSystem, lookupGate, lookupLine, lookupOf, parseHelp, retrieve, runLookup } from '../server/help.mjs'
import { DIRECT_CARD } from '../web/shared/basic.js'

test('the help files read as sections with their fields, the 功能清单 left out', async () => {
  const help = await appHelp()
  assert.ok(help.sections.length > 300)
  assert.equal(help.byId.has('feature-list'), false)
  const tts = help.byId.get('chat-direct')
  assert.equal(tts.file, 'features.md')
  assert.ok(tts.fields['在哪'][0].includes('直连对话'))
  assert.ok(help.overview.length >= 3)
  const parsed = parseHelp('# 功能\n\n# 区\n\n## 甲 {#a}\n\n- 也叫：一、二\n- 在哪：设置\n\n正文。\n', 'features.md')
  assert.deepEqual(parsed.map(({ id, area, fields, body }) => ({ id, area, fields, body })), [{ id: 'a', area: '区', fields: { 也叫: ['一、二'], 在哪: ['设置'] }, body: '正文。' }])
})

test('a message goes with help sections only when it plainly asks about the app', async () => {
  const help = await appHelp()
  // An error quoted: its section, whatever else is said.
  assert.equal(retrieve(help, '发消息后提示：模型没有返回正文').ids[0], 'err-no-text')
  // The app named, and something found.
  const named = retrieve(help, '这个软件怎么导入世界书')
  assert.ok(named.ids.includes('book-import'))
  assert.match(named.text, /^<cicatavern_help>[\s\S]*## 导入世界书[\s\S]*<\/cicatavern_help>$/)
  assert.ok(named.text.length < 9000)
  // Its name says it is about the app, not which part: no launch errors for a question about voices.
  assert.ok(retrieve(help, 'CicaTavern 的朗读音色在哪换').ids.every(id => !/launch/.test(id)))
  // Everyday questions, even ones sharing words with the docs, carry nothing.
  for (const question of ['1+1 等于几？', 'React 和 Vue 有什么区别', '模型的温度参数是什么意思', '帮我写个状态栏的 HTML', 'git rebase 和 merge 有什么区别', 'How do I center a div in CSS?']) {
    assert.deepEqual(retrieve(help, question).ids, [], question)
  }
  // What an earlier message carried is not sent again.
  assert.ok(!retrieve(help, '这个软件怎么导入世界书', new Set(['book-import'])).ids.includes('book-import'))
})

test('the assistant is told the version, the platform, the overview and how to look further', async () => {
  const text = helpSystem(await appHelp(), { version: '9.9.9', platform: 'Windows' })
  assert.match(text, /9\.9\.9，Windows/)
  assert.match(text, /<cicatavern_overview>[\s\S]*## CicaTavern 是什么[\s\S]*<\/cicatavern_overview>/)
  for (const tool of ['search_help', 'read_help', '"list"', '"search"', '"read"']) assert.ok(text.includes(tool), tool)
})

test('a lookup ends a reply, words before it or not; anything after it makes it an answer', () => {
  assert.deepEqual(lookupOf(' \n<lookup>{"read_help": ["tts"]}</lookup>'), { read_help: ['tts'] })
  assert.deepEqual(lookupOf('<lookup>{"search": "a"}'), { search: 'a' }, 'cut off before its end')
  assert.deepEqual(lookupOf('<lookup>看看</lookup>'), {})
  // As Claude writes it, however it is asked.
  assert.deepEqual(lookupOf('我先查一下帮助资料。\n\n<lookup>{"search_help": "附文件"}</lookup>\n'), { search_help: '附文件' })
  assert.equal(lookupLine('我先查一下。\n<lookup>{"search": "a"}</lookup>\n'), '我先查一下。\n<lookup>{"search": "a"}</lookup>')
  assert.equal(lookupOf('<lookup>{"search": "a"}</lookup>\n查到了：是 5 次。'), null)
  assert.equal(lookupOf('好的。'), null)
})

test('the page never sees a lookup, and sees an answer as it comes', () => {
  const run = chunks => {
    const shown = []
    let restarts = 0
    const gate = lookupGate(text => shown.push(text), () => {
      restarts++
      shown.length = 0
    })
    for (const chunk of chunks) gate.push(chunk)
    return { shown, restarts: () => restarts, end: isLookup => (gate.end(isLookup), shown.join('')) }
  }
  assert.equal(run(['  <lo', 'okup>{"search":', ' "x"}</lookup>']).end(true), '')
  assert.deepEqual(run(['<', 'b>粗体</b>', '后面']).shown, ['<b>粗体</b>', '后面'])
  assert.deepEqual(run(['好', '的']).shown, ['好', '的'])
  // A reply that stops while it could still be one: what came is shown at its end.
  assert.equal(run(['答：<lo']).end(false), '答：<lo')
  // Words, then the lookup: they are taken back from the page.
  const late = run(['我先查', '一下。\n<loo', 'kup>{"search": "x"}</lookup>'])
  assert.equal(late.end(true), '')
  assert.equal(late.restarts(), 1)
  // The tag in an answer after all (talking about it): the whole answer comes at its end.
  assert.equal(run(['用 <lookup>', ' 这个标签，', '就行']).end(false), '用 <lookup> 这个标签，就行')
})

test('the source can be read, only the app\'s own, and only server and web', async () => {
  const help = await appHelp()
  const look = request => runLookup(request, { help })
  assert.match(await look({ list: '' }), /^server\/（\d+ 个文件）\nweb\/（\d+ 个文件）$/)
  assert.match(await look({ search: 'DIRECT_CARD = ', in: 'web' }), /web\/shared\/basic\.js:\d+: export const DIRECT_CARD = 'direct'/)
  const read = await look({ read: 'server/help.mjs', from: 1, to: 2 })
  assert.match(read, /^server\/help\.mjs 第 1–2 行（共 \d+ 行）\n1: \/\/ 应用帮助/)
  assert.equal((await look({ read: 'server/help.mjs', from: 1, to: 999 })).split('\n').length, 201, 'at most 200 lines')
  for (const where of ['package.json', '../package.json', 'server/../package.json', 'C:/Windows/win.ini', '/etc/passwd', 'web/fonts/zcool.woff2', 'web/icon.png']) {
    assert.match(await look({ read: where }), /^出错：没有「/, where)
  }
  assert.match(await look({ list: 'server/subscription' }), /^出错/)
  assert.match(await look({ search: 'createSubscription' }), /^(?!.*server\/subscription\/)/s)
  // Words taken as they are: a pattern never runs as a regular expression.
  assert.match(await look({ search: '(a+)+$' }), /^server\/regex-guard\.mjs:\d+: .*\(a\+\)\+\$/)
  assert.equal(await look({ search: 'zq(x' }), '源码里没有搜到')
  // The best two whole (a summary was once taken for the whole answer), the rest summed up.
  const searched = await look({ search_help: '朗读 音色' })
  assert.equal(searched.match(/^## .+ \{#tts[\w-]*\}$/gm)?.length, 2)
  assert.match(searched, /其他可能相关的（只是摘要，要看全文用 read_help）：\n\[tts/)
  assert.match(await look({ read_help: ['chat-direct', 'nope'] }), /## 直连对话 \{#chat-direct\}[\s\S]*没有 id 是「nope」的小节/)
  assert.match(await look({ what: 1 }), /^出错：看不懂/)
})

/** A model that answers from a script, in small pieces, and keeps what it was sent. */
async function setup(t, replies) {
  const seen = []
  const model = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (let i = 0; i < reply.length; i += 3) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(i, i + 3) }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-help-'))
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
    return (await res.text()).trim().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  }
  const added = await call('/api/providers', { method: 'POST', body: { name: 'Fake', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'sk-test', models: ['m1'] } })
  const provider = added.id ?? added.providers.at(-1).id
  await call('/api/settings', { method: 'PUT', body: { model: `${provider}/m1` } })
  const chat = await call('/api/chats', { method: 'POST', body: { cardId: DIRECT_CARD } })
  return { call, turn, seen, chat }
}

const system = body => body.messages.find(message => message.role === 'system')?.content ?? ''
const others = body => body.messages.filter(message => message.role !== 'system')

test('the assistant looks things up before it answers; the page sees the lookups, not their lines', async t => {
  // The second lookup comes after a few words, as Claude writes them.
  const { turn, seen, chat } = await setup(t, ['<lookup>{"search_help": "导入世界书"}</lookup>', '我再看一下源码。\n<lookup>{"read": "server/help.mjs", "from": 1, "to": 3}</lookup>', '在左栏点「导入」。'])
  assert.equal(chat.appHelp, true, 'on by default')
  const events = await turn(chat.id, { parentId: chat.path.at(-1).id, input: '怎么导入世界书？' })
  const end = events.at(-1)
  assert.equal(end.type, 'done', JSON.stringify(end))
  assert.deepEqual(events.filter(event => event.type === 'lookup').map(({ op, target, step }) => [op, target, step]), [['search_help', '导入世界书', 1], ['read', 'server/help.mjs 1–3', 2]])
  // What the page is left with: the words before the second lookup were taken back (restart).
  const afterRestart = events.slice(events.findLastIndex(event => event.type === 'restart') + 1)
  assert.equal(events.filter(event => event.type === 'restart').length, 1)
  assert.equal(afterRestart.filter(event => event.type === 'delta').map(event => event.text).join(''), '在左栏点「导入」。')
  assert.ok(events.every(event => event.type !== 'delta' || !event.text.includes('<lookup')))
  assert.equal(seen.length, 3)
  assert.match(system(seen[0]), /CicaTavern 答疑[\s\S]*<cicatavern_overview>/)
  // Not plainly about the app: nothing went with the message; the model looked itself.
  assert.equal(others(seen[0]).at(-1).content, '怎么导入世界书？')
  const third = others(seen[2])
  assert.deepEqual(third.slice(-4).map(message => message.role), ['assistant', 'user', 'assistant', 'user'])
  assert.match(third.at(-3).content, /^<lookup_result>\n## 导入世界书 \{#book-import\}/)
  assert.match(third.at(-1).content, /^<lookup_result>\nserver\/help\.mjs 第 1–3 行[\s\S]*（还能查 4 次）$/)
  const reply = end.chat.path.at(-1)
  assert.equal(reply.text, '在左栏点「导入」。')
  assert.equal(reply.lookups.length, 2)
  assert.equal(reply.usage.input, 300, 'every call counted')
  assert.equal(reply.usage.prompt, 100, 'the context is the first call\'s')
  // The next turn reads the answer, not the lookups.
  await turn(chat.id, { parentId: end.nodeId, input: '谢谢' })
  assert.deepEqual(others(seen[3]).map(message => message.content), ['怎么导入世界书？', '在左栏点「导入」。', '谢谢'])
})

test('a message naming the app carries what it finds, once; with 应用帮助 off the assistant is plain', async t => {
  const { call, turn, seen, chat } = await setup(t, ['好的。'])
  const first = (await turn(chat.id, { parentId: chat.path.at(-1).id, input: '这个软件怎么导入世界书' })).at(-1)
  assert.match(others(seen[0]).at(-1).content, /^<cicatavern_help>[\s\S]*\{#book-import\}[\s\S]*<\/cicatavern_help>\n\n这个软件怎么导入世界书$/)
  assert.equal(first.chat.path.at(-2).text, '这个软件怎么导入世界书', 'the page shows the words as typed')
  const second = (await turn(chat.id, { parentId: first.nodeId, input: '这个软件怎么导入世界书' })).at(-1)
  assert.doesNotMatch(others(seen[1]).at(-1).content, /\{#book-import\}/, 'still in the history')
  const off = await call(`/api/chats/${chat.id}`, { method: 'PUT', body: { appHelp: false } })
  assert.equal(off.appHelp, false)
  await turn(chat.id, { parentId: second.nodeId, input: '这个软件怎么导入预设' })
  assert.doesNotMatch(system(seen[2]), /CicaTavern 答疑/)
  assert.equal(others(seen[2]).at(-1).content, '这个软件怎么导入预设')
})

test('a model that keeps looking is stopped, and the turn says so', async t => {
  const { turn, seen, chat } = await setup(t, ['<lookup>{"list": ""}</lookup>'])
  const end = (await turn(chat.id, { parentId: chat.path.at(-1).id, input: '源码里有什么？' })).at(-1)
  assert.equal(end.type, 'error')
  assert.match(end.message, /查了 6 次资料还没有回答/)
  assert.equal(seen.length, 7)
  assert.match(others(seen[6]).at(-1).content, /查询次数用完了/)
})
