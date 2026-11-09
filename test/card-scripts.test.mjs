// A card's Tavern Helper scripts that follow its variables, run on the server (server/card-scripts.mjs): what they
// change at a chat's start, around a reply's update and on a card frame's own event; what fails stays out of the way;
// a card without them goes on as it always did.
process.env.CARD_SCRIPTS_FIRE_MS = '400'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { createApp } = await import('../server/http.mjs')
const { applyCommands, applyStateUpdates, readUpdates } = await import('../server/state.mjs')
const { helperSummary, runsOnServer } = await import('../server/helper-scripts.mjs')

const RULES = `
$(async () => {
  await waitGlobalInitialized('Mvu')
  eventOn(Mvu.events.VARIABLE_INITIALIZED, variables => {
    variables.stat_data.开局 = '已掷骰'
    _.set(variables, 'stat_data.属性.力量', 7)
  })
  // The model may not write a private field; every reply counts a round.
  eventOn(Mvu.events.COMMAND_PARSED, (variables, commands) => {
    for (let i = commands.length - 1; i >= 0; i--) if (String(commands[i].args[0]).includes('$')) commands.splice(i, 1)
    commands.push({ type: 'add', args: ['回合', '1'], full_match: '', reason: 'script' })
  })
  eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, async variables => {
    const n = Number(localStorage.getItem('turns') || 0) + 1
    localStorage.setItem('turns', String(n))
    variables.stat_data.记数 = n
    // An event entry of the card's own book opens once the story has gone a round.
    const name = getCharWorldbookNames().primary
    await updateWorldbookWith(name, entries => entries.map(entry => (entry.name === '事件A' ? { ...entry, enabled: n >= 1 } : entry)))
    toastr.info('事件A 开启')
  })
  eventOn('重随', who => {
    const data = Mvu.getMvuData({ type: 'message', message_id: 'latest' })
    data.stat_data.路人 = '重随:' + who
    Mvu.replaceMvuData(data, { type: 'message', message_id: 'latest' })
  })
})`
const NEVER_ENDS = `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, variables => { for (;;) {} })`
const FETCHES = `import thing from 'https://example.com/thing.js'\neventOn(Mvu.events.VARIABLE_UPDATE_ENDED, variables => { variables.stat_data.远程 = thing })`
const BROKEN = `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, variables => { variables.stat_data.坏 = 1 })\nnull.boom`
const PAGE = `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => { parent.document.body.append('x') })`
const REPLY = '她点头。\n<UpdateVariable><JSONPatch>[{"op":"replace","path":"/$秘密","value":1},{"op":"replace","path":"/心情","value":"好"}]</JSONPatch></UpdateVariable>'

const script = (name, content) => ({ type: 'script', enabled: true, name, id: name, content, info: '', button: { enabled: true, buttons: [] } })
const cardJson = (name, scripts) => ({
  spec: 'chara_card_v2',
  data: {
    name,
    first_mes: '蝉鸣。\n<initvar>\n回合: 0\n心情: 平\n属性:\n  力量: 1\n</initvar>',
    character_book: { name: `${name}的书`, entries: [{ keys: ['蝉'], content: '事件A的内容', comment: '事件A', enabled: false }, { keys: ['雨'], content: '别的', comment: '事件B', enabled: true }] },
    extensions: scripts.length ? { tavern_helper: { scripts } } : {},
  },
})

async function setup(t) {
  // What the model was sent, each request's body.
  const sent = []
  const model = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    sent.push(body)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-hooks-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    model.closeAllConnections()
    model.close()
    app.network?.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const get = async p => (await fetch(base + p)).json()
  const provider = await (await send('/api/providers', { name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] })).json()
  await send('/api/settings', { model: `${provider.id}/writer` }, 'PUT')
  const importCard = async (name, scripts) => (await send('/api/cards/import', { filename: 'c.json', data: Buffer.from(JSON.stringify(cardJson(name, scripts))).toString('base64') })).json()
  const turn = async chat => {
    const latest = await get(`/api/chats/${chat.id}`)
    const text = await (await send(`/api/chats/${chat.id}/turn`, { parentId: latest.path.at(-1).id, input: '你好' })).text()
    assert.match(text, /"type":"done"/)
    return get(`/api/chats/${chat.id}`)
  }
  return { send, get, importCard, turn, sent }
}

test('which scripts run on the server: they follow MVU events and leave SillyTavern\'s page alone', () => {
  assert.equal(runsOnServer(RULES), true)
  assert.equal(runsOnServer(PAGE), false)
  assert.equal(runsOnServer('eventOn("x", f)'), false, 'no MVU event: nothing to run it for')
  assert.equal(runsOnServer('eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, f); const chat = parent.SillyTavern.chat'), true, 'reading the chat is no page')
  const kinds = helperSummary([script('规则', RULES), script('页面', PAGE)])
  assert.deepEqual(kinds.map(item => [item.kind, item.effect]), [['hooks', 'none'], ['custom', 'none']])
})

test('commands as MVU hands them to scripts: left alone they run exactly as before, changed they run as MVU would', () => {
  const state = { 好感: 1, 物品: ['剑'], 人物: { 甲: { 年龄: 3 } } }
  const reply = '<UpdateVariable>\n_.set(\'好感\', 1, 5);\n<JSONPatch>[{"op":"delta","path":"/好感","value":2},{"op":"insert","path":"/物品/-","value":"盾"},{"op":"remove","path":"/人物/甲"}]</JSONPatch>\n</UpdateVariable>'
  const read = readUpdates(state, reply)
  assert.deepEqual(read.commands.map(c => c.type), ['add', 'insert', 'delete', 'set'])
  assert.deepEqual(read.commands[0].args, ['/好感', '2'])
  assert.deepEqual(applyCommands(read.state, read.commands).state, applyStateUpdates(state, reply).state)
  // Commands of a script's own, in MVU's shape.
  const made = applyCommands(state, [
    { type: 'set', args: ["'人物.乙.年龄'", '9'] },
    { type: 'set', args: ['好感', '1', '10'] },
    { type: 'add', args: ['物品', '"弓"'] },
    { type: 'insert', args: ['人物', '"丙"', '{"年龄":1}'] },
    { type: 'delete', args: ['物品', '"剑"'] },
    { type: 'move', args: ['/人物/甲', '/人物/丁'] },
    { type: 'set', args: ['__proto__.x', '1'] },
  ])
  assert.deepEqual(made.state, { 好感: 10, 物品: ['弓'], 人物: { 乙: { 年龄: 9 }, 丙: { 年龄: 1 }, 丁: { 年龄: 3 } } })
  assert.equal(({}).x, undefined)
})

test('a card\'s scripts at the start, around each reply, and on its frame\'s own event; what fails stays out of the way', async t => {
  const { send, get, importCard, turn } = await setup(t)
  const card = await importCard('千夏', [script('规则', RULES), script('死循环', NEVER_ENDS), script('远程', FETCHES), script('坏脚本', BROKEN), script('页面', PAGE)])
  const chat = await (await send('/api/chats', { cardId: card.id })).json()
  // VARIABLE_INITIALIZED: the opening's variables as the script set them up.
  assert.deepEqual(chat.path[0].state, { 回合: 0, 心情: '平', 属性: { 力量: 7 }, 开局: '已掷骰' })

  const first = await turn(chat)
  const reply = first.path.at(-1)
  // COMMAND_PARSED took the private write out and counted the round; VARIABLE_UPDATE_ENDED counted in its storage.
  assert.equal(reply.state.$秘密, undefined)
  assert.equal(reply.state.心情, '好')
  assert.equal(reply.state.回合, 1)
  assert.equal(reply.state.记数, 1)
  assert.equal(reply.state.远程, undefined, 'a loader of code on the web is not run')
  assert.equal(reply.state.坏, undefined, 'a script that fails setting up is left out')
  assert.deepEqual(reply.scriptNotes.map(note => note.text), ['事件A 开启'])
  // Its book change is this chat's: the entry is on here.
  const book = await (await send(`/api/chats/${chat.id}/worldbook`, { name: '' })).json()
  assert.deepEqual(book.entries.map(entry => [entry.name, entry.enabled]), [['事件A', true], ['事件B', true]])

  // Its localStorage stays with the chat from one reply to the next.
  const second = await turn(chat)
  assert.equal(second.path.at(-1).state.回合, 2)
  assert.equal(second.path.at(-1).state.记数, 2)

  // A card frame's own event: only the names the scripts listen for are sent on.
  assert.deepEqual((await get(`/api/cards/${card.id}/script-events`)).events, ['重随'])
  const rerolled = await (await send(`/api/chats/${chat.id}/script-event`, { type: '重随', args: ['张三'] })).json()
  assert.equal(rerolled.handled, true)
  assert.equal(rerolled.chat.path.at(-1).state.路人, '重随:张三')
  assert.deepEqual(await (await send(`/api/chats/${chat.id}/script-event`, { type: '没人听', args: [] })).json(), { handled: false })

  // The one that never ended and the one that failed setting up are in the error log; the turns went on without them.
  const report = await (await send('/api/diagnostics/report', {})).json()
  const text = JSON.stringify(report)
  assert.match(text, /死循环/)
  assert.match(text, /坏脚本/)
  assert.doesNotMatch(text, /远程/, 'a loader is not run here at all')
  assert.doesNotMatch(text, /页面/, 'a page script is not run here at all')
})

test('a card without such scripts plays as it always did', async t => {
  const { send, get, importCard, turn } = await setup(t)
  const card = await importCard('素卡', [])
  const chat = await (await send('/api/chats', { cardId: card.id })).json()
  assert.deepEqual(chat.path[0].state, { 回合: 0, 心情: '平', 属性: { 力量: 1 } })
  const after = await turn(chat)
  assert.deepEqual(after.path.at(-1).state, { 回合: 0, 心情: '好', 属性: { 力量: 1 }, $秘密: 1 })
  assert.equal(after.path.at(-1).scriptNotes, undefined)
  assert.deepEqual((await get(`/api/cards/${card.id}/script-events`)).events, [])
  assert.deepEqual(await (await send(`/api/chats/${chat.id}/script-event`, { type: '重随', args: [] })).json(), { handled: false })
})

test("SillyTavern's events and injected prompts: a turn's start, an edit, and a frame's injectPrompts", async t => {
  // A model that keeps what it was sent.
  const sent = []
  const model = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    sent.push(body)
    // A turn that fails: the provider is down.
    if (body.includes('断线')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'down' } }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '雨落。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-events-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    model.closeAllConnections()
    model.close()
    app.network?.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const get = async p => (await fetch(base + p)).json()
  const provider = await (await send('/api/providers', { name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] })).json()
  await send('/api/settings', { model: `${provider.id}/writer` }, 'PUT')
  const EVENTS = `
eventOn(tavern_events.MESSAGE_SENT, id => {
  if (id === 1) injectPrompts([{ id: '天气', position: 'in_chat', depth: 0, role: 'system', content: '这一轮一直在下雨。' }], { once: true })
  const data = Mvu.getMvuData({ type: 'message', message_id: 'latest' })
  data.stat_data.天气 = '雨'
  data.stat_data.发送 = id
  Mvu.replaceMvuData(data, { type: 'message', message_id: 'latest' })
  const vars = getVariables({ type: 'chat' })
  vars.发送次数 = (vars.发送次数 || 0) + 1
  replaceVariables(vars, { type: 'chat' })
})
eventOn(tavern_events.MESSAGE_DELETED, id => {
  const data = Mvu.getMvuData({ type: 'message', message_id: 'latest' })
  data.stat_data.删过 = id
  Mvu.replaceMvuData(data, { type: 'message', message_id: 'latest' })
})
eventOn(tavern_events.MESSAGE_EDITED, id => {
  const data = Mvu.getMvuData({ type: 'message', message_id: 'latest' })
  data.stat_data.编辑过 = id
  Mvu.replaceMvuData(data, { type: 'message', message_id: 'latest' })
})
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => {})`
  const card = await (await send('/api/cards/import', { filename: 'c.json', data: Buffer.from(JSON.stringify(cardJson('雨夜', [script('事件', EVENTS)]))).toString('base64') })).json()
  let chat = await (await send('/api/chats', { cardId: card.id })).json()
  const turn = async input => {
    const text = await (await send(`/api/chats/${chat.id}/turn`, { parentId: chat.path.at(-1).id, input })).text()
    assert.match(text, /"type":"done"/)
    chat = await get(`/api/chats/${chat.id}`)
    return JSON.parse(sent.at(-1)).messages.at(-1).content
  }
  // MESSAGE_SENT: its prompt goes with this turn, after the input; the variables it set are where the turn starts.
  const first = await turn('出门')
  assert.match(first, /<玩家输入>\n出门\n<\/玩家输入>\n\n<卡脚本提示>\n这一轮一直在下雨。\n<\/卡脚本提示>/)
  assert.equal(chat.path.at(-1).state.天气, '雨')
  assert.equal(chat.path.at(-1).state.发送, 1)
  // `once`: gone after that turn.
  assert.doesNotMatch(await turn('回家'), /这一轮一直在下雨/)
  // MESSAGE_EDITED, after the edit, with its floor.
  const edited = await (await send(`/api/chats/${chat.id}/messages/${chat.path.at(-1).id}`, { text: '雨停了。' }, 'PUT')).json()
  assert.equal(edited.path.at(-1).state.编辑过, chat.path.length - 1)
  // A frame's injectPrompts: kept until it is taken back; a deeper one goes before the input.
  await send(`/api/chats/${chat.id}/injections`, { prompts: [{ id: '提醒', position: 'in_chat', depth: 2, content: '记得带伞。' }] })
  assert.match(await turn('再出门'), /<卡脚本提示>\n记得带伞。\n<\/卡脚本提示>\n\n<玩家输入>/)
  await send(`/api/chats/${chat.id}/injections`, { uninject: ['提醒'] })
  assert.doesNotMatch(await turn('又出门'), /记得带伞/)
  // The same injection again changes nothing on the chat.
  const { injectPrompts } = await import('../server/injections.mjs')
  const held = { scriptInjections: [] }
  assert.equal(injectPrompts(held, [{ id: '甲', content: '一' }]), true)
  assert.equal(injectPrompts(held, [{ id: '甲', content: '一' }]), false)
  assert.equal(injectPrompts(held, [{ id: '甲', content: '二' }]), true)

  // What MESSAGE_SENT did goes with the reply: a turn that fails keeps none of it.
  assert.equal(chat.frameVars.发送次数, 4)
  const failed = await (await send(`/api/chats/${chat.id}/turn`, { parentId: chat.path.at(-1).id, input: '断线' })).text()
  assert.doesNotMatch(failed, /"type":"done"/)
  chat = await get(`/api/chats/${chat.id}`)
  assert.equal(chat.frameVars.发送次数, 4)

  // MESSAGE_DELETED with the floor the message was at, not the last one.
  const deleted = await (await send(`/api/chats/${chat.id}/delete-message`, { nodeId: chat.path[1].id })).json()
  assert.equal(deleted.path.at(-1).state.删过, 1)
})

test("regex functions: the chat's own regex a script added goes when its list leaves it out", async () => {
  const { regexChanges, withRegexChanges } = await import('../web/shared/regex.js')
  const base = [{ id: 'c1', scriptName: '卡', findRegex: '/a/g', replaceString: 'b', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, minDepth: null, maxDepth: null }]
  const own = { id: 'x', script_name: '新', enabled: true, find_regex: '/x/g', replace_string: 'y', source: { ai_output: true }, destination: { display: true, prompt: true } }
  const card = { ...own, id: 'c1', script_name: '卡', find_regex: '/a/g', replace_string: 'b' }
  const added = regexChanges(base, [card, own], null, { own: true })
  assert.deepEqual(withRegexChanges(base, added).map(script => script.id), ['c1', 'x'])
  const removed = regexChanges(base, [card], added, { own: true })
  assert.equal(removed, null, 'nothing of the chat\'s own is left')
  // Another scope's replacement leaves the chat's own be.
  const global = regexChanges([], [], added)
  assert.deepEqual(global.added.map(script => script.id), ['x'])
})

test("a card's script calls the model only once the player lets it", async t => {
  const { send, get, importCard } = await setup(t)
  const SUMMARY = `
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, async variables => {
  try {
    variables.stat_data.总结 = await generate({ user_input: '用一句话总结' })
  } catch (error) {
    variables.stat_data.总结错误 = error.message
  }
})`
  const card = await importCard('总结', [script('总结', SUMMARY)])
  let chat = await (await send('/api/chats', { cardId: card.id })).json()
  const turn = async () => {
    const text = await (await send(`/api/chats/${chat.id}/turn`, { parentId: chat.path.at(-1).id, input: '你好' })).text()
    assert.match(text, /"type":"done"/)
    chat = await get(`/api/chats/${chat.id}`)
    return chat.path.at(-1)
  }
  assert.deepEqual(await get(`/api/cards/${card.id}/script-permissions`), { model: false })
  const refused = await turn()
  assert.equal(refused.state.总结, undefined)
  assert.match(refused.state.总结错误, /没有被允许/)
  assert.match(refused.scriptNotes.map(note => note.text).join(), /检查这张卡/)
  assert.deepEqual(await (await send(`/api/cards/${card.id}/script-permissions`, { model: true }, 'PUT')).json(), { model: true })
  const allowed = await turn()
  assert.match(allowed.state.总结, /她点头/, "the model's reply, as the fake model writes it")
})

test('slash commands in a server script: the same runner as the page, with what the server has', async t => {
  const { send, get, importCard } = await setup(t)
  const SLASH = `
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, async () => {
  await triggerSlash('/setvar key=天气 晴 | /inject id=窗 depth=0 记得关窗。 | /echo 天气是{{getvar::天气}} | /send 你好')
})`
  const card = await importCard('斜杠', [script('斜杠', SLASH)])
  let chat = await (await send('/api/chats', { cardId: card.id })).json()
  const text = await (await send(`/api/chats/${chat.id}/turn`, { parentId: chat.path.at(-1).id, input: '你好' })).text()
  assert.match(text, /"type":"done"/)
  chat = await get(`/api/chats/${chat.id}`)
  assert.equal(chat.frameVars?.天气, '晴', '/setvar: the chat variable')
  const notes = chat.path.at(-1).scriptNotes.map(note => note.text)
  assert.ok(notes.includes('天气是晴'), '/echo, with the variable macro')
  assert.ok(notes.some(note => /\/send/.test(note)), 'starting a turn is not done here, and said')
  const injections = await (await send(`/api/chats/${chat.id}/injections`, { prompts: [] })).json()
  assert.deepEqual(injections.injections.map(item => [item.id, item.content]), [['窗', '记得关窗。']])
})

test("regex functions: a script turns the card's regex off for its chat only, and runs text through them", async t => {
  const { send, get } = await setup(t)
  const REGEX = `
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, async variables => {
  variables.stat_data.之前 = formatAsTavernRegexedString('暗号', 'ai_output', 'display')
  await updateTavernRegexesWith(list => list.map(regex => (regex.script_name === '藏暗号' ? { ...regex, enabled: false } : regex)))
  variables.stat_data.之后 = formatAsTavernRegexedString('暗号', 'ai_output', 'display')
})`
  const json = cardJson('暗号', [script('正则', REGEX)])
  json.data.extensions.regex_scripts = [{ id: 'r1', scriptName: '藏暗号', findRegex: '/暗号/g', replaceString: '**', placement: [2], markdownOnly: true, disabled: false }]
  const card = await (await send('/api/cards/import', { filename: 'c.json', data: Buffer.from(JSON.stringify(json)).toString('base64') })).json()
  let chat = await (await send('/api/chats', { cardId: card.id })).json()
  assert.match(await (await send(`/api/chats/${chat.id}/turn`, { parentId: chat.path.at(-1).id, input: '你好' })).text(), /"type":"done"/)
  chat = await get(`/api/chats/${chat.id}`)
  assert.deepEqual([chat.path.at(-1).state.之前, chat.path.at(-1).state.之后], ['**', '暗号'])
  assert.deepEqual(chat.regexChanges, { changed: { r1: { disabled: true } }, added: [] })
  // The same lists through a frame's route; the card itself is untouched.
  const listed = await (await send(`/api/chats/${chat.id}/regexes`, { action: 'get', option: { type: 'character' } })).json()
  assert.deepEqual(listed.value.map(regex => [regex.script_name, regex.enabled]), [['藏暗号', false]])
  const other = await (await send('/api/chats', { cardId: card.id })).json()
  const fresh = await (await send(`/api/chats/${other.id}/regexes`, { action: 'format', text: '暗号', source: 'ai_output', destination: 'display' })).json()
  assert.equal(fresh.value, '**', "another chat of the card still has it on")
})

test("a script's own macro goes over each turn's message", async t => {
  const { send, get, importCard, sent } = await setup(t)
  const MACRO = `registerMacroLike(/<天气>/g, (context, found) => '今天' + (context.role === 'user' ? '下雨' : '?'))
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => {})`
  const card = await importCard('宏', [script('宏', MACRO)])
  const chat = await (await send('/api/chats', { cardId: card.id })).json()
  assert.match(await (await send(`/api/chats/${chat.id}/turn`, { parentId: chat.path.at(-1).id, input: '外面<天气>吗' })).text(), /"type":"done"/)
  const message = JSON.parse(sent.at(-1)).messages.at(-1).content
  assert.match(message, /<玩家输入>\n外面今天下雨吗\n<\/玩家输入>/)
  assert.equal((await get(`/api/chats/${chat.id}`)).path.at(-1).role, 'assistant')
})

test("a server script's audio calls reach the page with its notes", async t => {
  const { send, get, importCard } = await setup(t)
  const AUDIO = `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => {
  playAudio('bgm', { url: 'https://example.com/music/雨夜.mp3' })
  setAudioSettings('bgm', { volume: 40 })
})`
  const card = await importCard('音乐', [script('音乐', AUDIO)])
  const chat = await (await send('/api/chats', { cardId: card.id })).json()
  assert.match(await (await send(`/api/chats/${chat.id}/turn`, { parentId: chat.path.at(-1).id, input: '你好' })).text(), /"type":"done"/)
  const notes = (await get(`/api/chats/${chat.id}`)).path.at(-1).scriptNotes
  assert.deepEqual(notes.map(note => [note.level, note.audio?.action]), [['audio', 'play'], ['audio', 'settings']])
  assert.equal(notes[0].audio.audio.url, 'https://example.com/music/雨夜.mp3')
})

test('every enabled page script goes to the page to start with the chat, a button or not; one from an address says so', async t => {
  const { get, importCard } = await setup(t)
  const PANEL = `$(() => { $('body').append('<div class="float">悬浮面板</div>') })`
  const LOADER = `import 'https://cdn.jsdelivr.net/gh/someone/panel@main/dist/index.js'`
  const off = { ...script('关掉的', PANEL), enabled: false }
  const card = await importCard('页面脚本', [script('悬浮面板', PANEL), script('远程', LOADER), script('规则', RULES), off])
  const cards = await get('/api/cards')
  assert.equal(cards.find(item => item.id === card.id)?.pageScripts, true)
  const list = await get(`/api/cards/${card.id}/script-buttons`)
  assert.deepEqual(list.page.map(item => [item.name, item.remote, item.buttons.length]), [['悬浮面板', false, 0], ['远程', true, 0]])
  // A card with only server scripts and no buttons: nothing for the page.
  const plain = await importCard('只有规则', [script('规则', RULES)])
  assert.equal((await get('/api/cards')).find(item => item.id === plain.id)?.pageScripts, false)
  assert.deepEqual(await get(`/api/cards/${plain.id}/script-buttons`), { page: [], server: [] })
})
