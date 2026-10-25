// ST-Prompt-Template in the QuickJS sandbox (server/template.mjs): variables that
// are saved, decorators, injected prompts, the card and preset as data, and EJS
// outside worldbook entries (openings, the frozen prefix, input, replies, display).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { initTemplates, renderTemplate, templateSession, templateSyntaxError } from '../server/template.mjs'
import { applyWrites } from '../server/state.mjs'
import { chatTemplates, renderEntry } from '../server/prompt.mjs'
import { constantEntries, dynamicEntries, initialState, normalizeBook, preloadEntries, templateInitialVariables, triggeredEntries } from '../server/worldbook.mjs'
import { normalizeScripts } from '../web/shared/regex.js'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, createChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { createStore } from '../server/store.mjs'
import { createApp } from '../server/http.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { placementsOf, renderPresetTail } from '../server/presets.mjs'
import { testSubscription } from './support/subscription.mjs'

before(() => initTemplates())

/** A session over `state`, and a render that gives the text or the error. */
function sandbox(options = {}) {
  const session = templateSession({ names: { char: '小雪', user: '阿明' }, ...options })
  const r = (text, data) => {
    const out = session.render(text, data)
    return out.error ? `ERROR ${out.error}` : out.text
  }
  return { session, r }
}

test('variables: the state at the root and as stat_data, old MVU pairs raw, arrays printed as SillyTavern prints them', () => {
  const { session, r } = sandbox({ state: { 好感度: 5, 物品: ['伞', '钥匙'], 旧: [10, '0-100'], 角色: { 名字: '小雪' } } })
  try {
    assert.equal(r('<%= getvar("好感度") %>/<%= getvar("stat_data.好感度") %>/<%= variables.stat_data.好感度 %>/<%= stat_data.角色.名字 %>'), '5/5/5/小雪')
    assert.equal(r('<%= getvar("旧")[0] %>/<%= getvar("物品") %>/<%= getvar("角色") %>'), '10/伞,钥匙/{"名字":"小雪"}', 'a [value, "desc"] pair as stored; an array joined; an object as JSON')
    assert.equal(r('<%= JSON.stringify(variables).includes("stat_data") %>/<%= Object.keys(variables).length %>'), 'false/4', 'printing the variables does not loop')
    assert.equal(r('<% setvar("stat_data.好感度", 9) %><%= getvar("好感度") %>'), '9', 'one value under both names')
    assert.equal(r('<%= getvar("没有", "local") === undefined %>/<%= getvar("没有", { defaults: 3 }) %>/<%= getvar(null).好感度 %>'), 'true/3/9', 'a string shorthand for a missing variable does not throw')
  } finally {
    session.dispose()
  }
})

test('variables: setvar flags, merge, results; incvar bounds; delvar and insvar; patchVariables; scopes and what comes back to save', () => {
  const { session, r } = sandbox({ state: { 金钱: 5, 背包: ['伞'], 资料: { 甲: 1 } }, local: { 本对话: 1 }, global: { 全局: 'a' }, initial: { 初始: '值', 金钱: 0 } })
  try {
    assert.equal(r('<%= setvar("金钱", 99, "nx") === undefined %>/<%= setvar("新", 1, "nx") %>/<%= setvar("没有的", 1, { flags: "xx" }) === undefined %>/<%= getvar("金钱") %>'), 'true/1/true/5')
    assert.equal(r('<%= setvar("金钱", 7, { results: "old" }) %>/<% setvar("资料", { 乙: 2 }, { merge: true }); setvar("背包", ["灯"], { merge: true }) %><%= JSON.stringify(getvar("资料")) %>/<%= getvar("背包") %>'), '5/{"甲":1,"乙":2}/伞,灯')
    assert.equal(r('<%= incvar("金钱", 10, { max: 12 }) %>/<%= decvar("金钱", 100, { min: 0 }) %>/<%= incvar("计数") %>'), '12/0/1')
    assert.equal(r('<% delvar("背包", "伞"); insvar("背包", "钥匙", 0); delvar("资料", "甲") %><%= getvar("背包") %>/<%= JSON.stringify(getvar("资料")) %>'), '钥匙,灯/{"乙":2}')
    assert.equal(r('<% patchVariables("资料", [{ op: "add", path: "/丙", value: 3 }, { op: "remove", path: "/乙" }]) %><%= JSON.stringify(getvar("资料")) %>'), '{"丙":3}')
    assert.equal(r('<%= getvar("初始") %>/<%= getvar("初始", "initial") %>/<%= getvar("本对话") %>/<%= getvar("全局", { scope: "global" }) %>'), '值/值/1/a', 'reads merge global, initial, local and the state')
    assert.equal(r('<% setLocalVar("本对话", 2); setGlobalVar("全局", "b"); setvar("临时", 1, "cache"); setvar("只读", 1, { scope: "initial" }) %><%= getvar("本对话") %>/<%= getvar("临时") %>'), '2/1')
    const writes = session.writes()
    assert.deepEqual(writes.local, [{ op: 'replace', path: '/本对话', value: 2 }])
    assert.deepEqual(writes.global, [{ op: 'replace', path: '/全局', value: 'b' }])
    assert.deepEqual(applyWrites({ 金钱: 5, 背包: ['伞'], 资料: { 甲: 1 } }, writes.message), { 金钱: 0, 背包: ['钥匙', '灯'], 资料: { 丙: 3 }, 新: 1, 计数: 1 }, 'cache and initial writes stay in the session')
  } finally {
    session.dispose()
  }
})

test('the toolbox: lenient parseJSON, jsonPatch, define binding, names and run type, injected prompts filled in at the end', () => {
  const { session, r } = sandbox({ state: { 好感度: 3 }, runType: 'generate' })
  try {
    assert.equal(r(String.raw`<%= JSON.stringify(parseJSON("{a: 1, 'b': [1, 2,], c: True, /* 注释 */ d: \"q\",}")) %>|<%= parseJSON("{坏") === null %>`), '{"a":1,"b":[1,2],"c":true,"d":"q"}|true')
    assert.equal(r('<%= JSON.stringify(jsonPatch({ a: [1] }, [{ op: "add", path: "/a/-", value: 2 }, { op: "replace", path: "/b", value: 3 }])) %>'), '{"a":[1,2],"b":3}')
    assert.equal(r('<% define("读", function () { return this.variables.好感度 + "/" + this.getvar("好感度") + "/" + typeof this._.sum + "/" + this.userName }) %><%= 读() %>'), '3/3/function/阿明')
    assert.equal(r('<%= charName %>/<%= assistantName %>/<%= userName %>/<%= runType %>'), '小雪/小雪/阿明/generate')
    const early = r('[<%= getPromptsInjected("思考") %>]<%= hasPromptsInjected("思考") %>')
    assert.equal(r('<% injectPrompt("思考", "第二步", 2); injectPrompt("思考", "第一步", 1) %>'), '')
    assert.equal(session.resolveInjected(`${early}|${r('<%= getPromptsInjected("没有") %>')}`), '[第一步\n第二步]false|', 'read before it was injected, filled in once everything has rendered; never "[]"')
    assert.equal(r('<%= getPromptsInjected("思考", [{ search: "第", replace: "" }]) %>'), '一步\n第二步', 'with post-processing it is read at once')
  } finally {
    session.dispose()
  }
})

test('the chat: floor numbers beyond a short window, and messages as the card\'s prompt-side regex leaves them', () => {
  const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', text: `第${i}条` }))
  const { session, r } = sandbox({ messages })
  try {
    assert.equal(r('<%= lastMessageId %>/<%= getChatMessage(0) %>/<%= getChatMessage(-1) %>/<%= getChatMessages(-2).join() %>/<%= lastUserMessageId %>/<%= getChatMessage(0, "user") %>'), '59/第0条/第59条/第58条,第59条/59/第1条')
  } finally {
    session.dispose()
  }
  const scripts = normalizeScripts([{ scriptName: '对AI隐藏选项', findRegex: '/<option>[\\s\\S]*?<\\/option>/g', replaceString: '', placement: [2], promptOnly: true }])
  const chat = chatTemplates({ names: { char: '小雪', user: '阿明' }, scripts, messages: [{ role: 'assistant', text: '开场' }, { role: 'user', text: '你好' }, { role: 'assistant', text: '她笑了。<option>休息</option>' }, { role: 'user', text: '走吧' }] })
  try {
    assert.equal(chat.render('<%= matchChatMessages("休息") %>/<%= matchChatMessages("她笑了") %>').text, 'false/true', 'an option list hidden from the model does not trigger')
  } finally {
    chat.dispose()
  }
})

test('the card and the preset as data: getchar with the plugin\'s layout, getCharData, getpreset', () => {
  const card = normalizeCard({ name: '小雪', description: '店员', personality: '温柔', mes_example: '<START>\n{{user}}: 你好', extensions: { depth_prompt: { prompt: '记得微笑' } } })
  const preset = { prompts: [{ id: 'a', name: '文风', content: '写给<%= userName %>看' }, { id: 'chatHistory', name: 'Chat History', marker: true, content: '' }] }
  const { session, r } = sandbox({ card, preset })
  try {
    assert.equal(r('<%- await getchar() %>'), '<小雪>\nname: 小雪\npersonality: 温柔\ndescription: 店员\nexample:\n{{user}}: 你好\nSystem: 记得微笑\n</小雪>')
    assert.equal(r('<%= getCharData().data.extensions.depth_prompt.prompt %>/<%= getCharData("别人") === null %>/<%- await getchar("别人") %>'), '记得微笑/true/')
    assert.equal(r('<%- await getpreset("文风") %>/<%- await getPresetPrompt(/文/) %>/<%- await getpreset("没有") %>'), '写给阿明看/写给阿明看/')
    assert.equal(r('<%- await getqr("a", "b") %>'), '')
  } finally {
    session.dispose()
  }
})

test('decorators: @@activate, @@dont_activate, the @@@ escape, @@initial_variables, @@preload / @@only_preload', () => {
  const book = {
    ...normalizeBook({
      entries: [
        { comment: '强制', keys: ['不会出现'], content: '@@activate\n一直在' },
        { comment: '禁止', keys: ['龙'], content: '@@dont_activate\n龙来了' },
        { comment: '转义', constant: true, content: '@@@activate\n正文' },
        { comment: '初始', enabled: false, content: '@@initial_variables\n名字: <%= "小" + "雪" %>' },
        { comment: '预载', enabled: false, content: '@@only_preload\n<% define("问候", function () { return "你好，" + this.userName }) %>' },
        { comment: '用预载', constant: true, content: '<%= 问候() %>' },
      ],
    }),
    id: 'b',
  }
  const books = [book]
  assert.deepEqual(dynamicEntries(books).map(e => e.comment), ['强制', '用预载'], '@@activate is constant, kept out of the frozen prefix')
  assert.deepEqual(constantEntries(books).map(e => e.comment), ['转义'])
  assert.equal(renderEntry(constantEntries(books)[0], { state: {}, names: { char: 'c', user: 'u' } }).text, '@@activate\n正文', 'an escaped line stays as text, one @ less')
  assert.deepEqual(triggeredEntries(books, '龙 不会出现', new Set()).map(hit => hit.entry.comment), [], 'never keyword-triggered')
  const render = entry => renderTemplate(entry.content, {}).text
  assert.deepEqual(initialState(books, render), { 名字: '小雪' }, 'read like an [InitVar] entry, its EJS run first')
  assert.deepEqual(templateInitialVariables(books, render), { 名字: '小雪' })
  assert.deepEqual(preloadEntries(books).map(e => e.comment), ['预载'])
  const { session, r } = sandbox({ books, preload: preloadEntries(books) })
  try {
    assert.equal(r('<%= 问候() %>|<%- await getwi("禁止") %>'), '你好，阿明|龙来了', 'a preload define() exists for the turn; getwi still reads @@dont_activate')
  } finally {
    session.dispose()
  }
})

test('a preset prompt whose template block spans blank lines stays in one piece: rendered in the turn\'s sandbox, then its macros', () => {
  const formats = { wi: '{0}', scenario: '{{scenario}}', personality: '{{personality}}', exampleChat: '[Example Chat]' }
  const preset = {
    postMode: 'prefix',
    formats,
    prompts: [
      { id: 'chatHistory', name: 'Chat History', marker: true, content: '', enabled: true },
      { id: 'cot', name: '思考', content: '<% if (getvar("开") === 1) { %>\n\n先想想 {{lastUserMessage}}\n\n<% } %>', enabled: true },
    ],
  }
  assert.deepEqual(placementsOf(preset), ['marker', 'turn'], 'one paragraph, per turn as a whole')
  const { session } = sandbox({ state: { 开: 1 } })
  try {
    const text = renderPresetTail(preset, { card: { postHistoryInstructions: '' }, persona: {}, names: { char: '小雪', user: '阿明' }, input: '你好', render: t => session.renderText(t).text })
    assert.equal(text, '先想想 你好')
  } finally {
    session.dispose()
  }
})

async function startApp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-template-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network?.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: JSON.stringify(body) })
  const post = async (p, body) => (await send(p, body)).json()
  const importCard = data => post('/api/cards/import', { filename: 'card.json', data: Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data })).toString('base64') })
  return { app, send, post, importCard }
}

test('a turn: @@preprocessing keys, activewi, an @@if keyword entry that prints nothing is not recorded', async t => {
  const { post, importCard } = await startApp(t)
  const card = await importCard({
    name: '小雪',
    first_mes: '你好。',
    character_book: {
      entries: [
        { id: 0, comment: '[InitVar]', content: '暗号: 山\n好感: 1', enabled: false },
        { id: 1, comment: '[Preprocessing]口令', keys: ['<%= getvar("暗号") %>'], enabled: true, content: '口令对上了：<%= getvar("暗号") %>' },
        { id: 2, comment: '叫人', constant: true, enabled: true, content: '<% await activewi("被叫来的"); await activewi("禁止的", true) %>' },
        { id: 3, comment: '被叫来的', enabled: false, content: '我被叫来了' },
        { id: 4, comment: '禁止的', keys: ['山'], enabled: true, content: '@@dont_activate\n强行叫来' },
        { id: 5, comment: '门禁', keys: ['山'], enabled: true, content: '@@if getvar("好感") > 50\n好感很高' },
      ],
    },
  })
  const chat = await post('/api/chats', { cardId: card.id })
  const preview = await post(`/api/chats/${chat.id}/preview`, { parentId: 'root', input: '暗号是山' })
  assert.deepEqual(preview.templateErrors, [])
  assert.match(preview.prompt, /<世界书>[\s\S]*口令对上了：山[\s\S]*我被叫来了[\s\S]*强行叫来[\s\S]*<\/世界书>/)
  assert.doesNotMatch(preview.prompt, /好感很高|【门禁】/)
  assert.deepEqual(preview.injected, ['[Preprocessing]口令', '被叫来的', '禁止的'])
})

/** An OpenAI-style provider answering each story turn with the next of `replies`. */
async function fakeProvider(t, replies) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = JSON.parse(body)
    requests.push(json)
    const text = replies.shift() ?? '……'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ model: json.model, choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ model: json.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { requests, baseURL: `http://127.0.0.1:${server.address().port}/v1` }
}

test('saved template variables: the turn\'s writes on the user node, replayed by regenerate, applied before the reply\'s update; local and global scopes; EJS in the opening, the prefix, the input and the reply; display rendering', async t => {
  const replies = [
    '她笑了。<% setvar("回复写的", getvar("好感")) %>\n<UpdateVariable><JSONPatch>[{"op":"replace","path":"/好感","value":50}]</JSONPatch></UpdateVariable>',
    '她又笑了。',
  ]
  const fake = await fakeProvider(t, replies)
  const { app, send, post, importCard } = await startApp(t)
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: fake.baseURL, apiKey: 'sk-test-1234567890abcd', models: [{ id: 'm1' }] })
  await app.store.saveProviders([provider])
  await app.store.saveSettings({ model: `${provider.id}/m1` })
  const card = await importCard({
    name: '小雪',
    description: '<%= charName %>是<%= getvar("身份") %>。',
    first_mes: '<% setvar("开场", 1) %>早，<%= userName %>。',
    character_book: {
      entries: [
        { id: 0, comment: '[InitVar]', content: '好感: 10\n身份: 店员', enabled: false },
        { id: 1, comment: '计数', constant: true, enabled: true, content: '<% incvar("好感", 2); setLocalVar("见面", 1); setGlobalVar("全局", "有") %>好感<%= getvar("好感") %>' },
        { id: 2, comment: '提示', constant: true, enabled: true, content: '提示：<%= getPromptsInjected("西瓜") %>' },
        { id: 3, comment: '西瓜', keys: ['西瓜'], enabled: true, content: '西瓜很甜<% injectPrompt("西瓜", "要冰的") %>' },
      ],
    },
  })
  const view = await post('/api/chats', { cardId: card.id })
  assert.equal(view.path[0].text, '早，你。', 'the opening\'s templates ran once')
  assert.equal(view.path[0].state.开场, 1, 'and what they wrote is kept')
  const stored = await app.store.getChat(view.id)
  assert.match(stored.systemPrompt, /小雪是店员。/, 'prefix templates rendered once at chat start')
  assert.doesNotMatch(stored.systemPrompt, /<%/)

  const before = await app.store.getSettings()
  const preview = await post(`/api/chats/${view.id}/preview`, { parentId: 'root', input: '吃西瓜<%= 1 + 1 %>' })
  assert.match(preview.prompt, /好感12/)
  assert.match(preview.prompt, /提示：要冰的/, 'read before the entry that injects it rendered')
  assert.match(preview.prompt, /<玩家输入>\n吃西瓜2\n<\/玩家输入>/)
  assert.equal((await app.store.getChat(view.id)).frameVars, undefined, 'a preview keeps nothing')
  assert.deepEqual((await app.store.getSettings()).globalVars, before.globalVars)

  const { chat } = await app.engine.runTurn(view.id, { parentId: 'root', input: '吃西瓜<%= 1 + 1 %>' }, () => {})
  const reply = activePath(chat).at(-1)
  const turn = chat.nodes[reply.parent]
  assert.equal(turn.text, '吃西瓜2', 'the input is kept as its templates left it')
  assert.deepEqual(turn.templateWrites, [{ op: 'replace', path: '/好感', value: 12 }])
  assert.equal(reply.text, '她笑了。\n<UpdateVariable><JSONPatch>[{"op":"replace","path":"/好感","value":50}]</JSONPatch></UpdateVariable>', 'the reply is kept rendered')
  assert.equal(reply.state.好感, 50, 'the reply\'s update over the turn\'s writes')
  assert.equal(reply.state.回复写的, 50, 'the reply\'s own template after its update block')
  assert.deepEqual(reply.stateChanges, ['好感', '回复写的'])
  assert.deepEqual(chat.frameVars, { 见面: 1 })
  assert.deepEqual((await app.store.getSettings()).globalVars, { 全局: '有' })
  assert.doesNotMatch(JSON.stringify(fake.requests[0].messages), /<%/, 'no raw EJS reaches the model')

  // Regenerate: the recorded writes again, not the templates run twice.
  const again = (await app.engine.runTurn(view.id, { userNodeId: turn.id }, () => {})).chat
  const second = activePath(again).at(-1)
  assert.notEqual(second.id, reply.id)
  assert.equal(second.state.好感, 12)
  assert.deepEqual(second.stateChanges, ['好感'])

  // 楼层渲染: rendered at that message, nothing kept; a failing text comes back without its EJS.
  const shown = await post(`/api/chats/${view.id}/display-render`, { nodeId: reply.id, texts: ['<b><%= getvar("好感") %></b>', '无模板', '<% setvar("好感", 0); throw new Error("坏了") %>后'] })
  assert.deepEqual(shown.texts, ['<b>50</b>', '无模板', '后'])
  assert.equal(shown.errors.length, 1)
  assert.equal(shown.errors[0].index, 2)
  assert.match(shown.errors[0].error, /坏了/)
  assert.equal((await app.store.getChat(view.id)).nodes[reply.id].state.好感, 50)
  assert.equal((await send(`/api/chats/${view.id}/display-render`, { nodeId: reply.id, texts: Array(65).fill('x') })).status, 400)
  assert.equal((await send(`/api/chats/${view.id}/display-render`, { nodeId: 'nope', texts: ['<%= 1 %>'] })).status, 404)
})

test('a subscription reply rendered by its templates: the session transcript holds the rendered text too', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-template-sub-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const configDir = path.join(root, 'claude-config')
  // Stands in for the SDK: answers, and writes the transcript the way Claude Code keeps it.
  const query = ({ options }) => {
    const sessionId = randomUUID()
    const uuid = randomUUID()
    const text = '她笑了<%= 1 + 1 %>。'
    return (async function* () {
      const dir = path.join(configDir, 'projects', 'workspace')
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: 'assistant', uuid, message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text }] } }) + '\n')
      yield { type: 'assistant', session_id: sessionId, uuid, message: { model: options.model, content: [{ type: 'text', text }] } }
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {} }
    })()
  }
  const subscription = testSubscription(store, root, query)
  if (!subscription) return t.skip('no subscription backend in this tree')
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '小雪', first_mes: '你好。' } })
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null }, null, { subscription })
  const chat = await createChat(store, card.id)
  const after = (await engine.runTurn(chat.id, { parentId: 'root', input: '嗨' }, () => {})).chat
  const reply = activePath(after).at(-1)
  assert.equal(reply.text, '她笑了2。')
  const transcript = JSON.parse((await readFile(path.join(configDir, 'projects', 'workspace', `${reply.sdk.sessionId}.jsonl`), 'utf8')).trim())
  assert.equal(transcript.message.content[0].text, '她笑了2。')
  assert.ok(reply.historyTrim, 'the next turn does not trim it again')
})

test('a template is checked for syntax without running it (EjsTemplate.getSyntaxErrorInfo)', () => {
  assert.equal(templateSyntaxError('<% if (getvar("x")) { %>a<% } %>'), '')
  assert.equal(templateSyntaxError('<% await getwi("码头") %>'), '')
  assert.notEqual(templateSyntaxError('<% if (x) { %>a'), '')
  assert.equal(templateSyntaxError('<% globalThis.ran = true %>'), '')
  assert.equal(globalThis.ran, undefined)
})
