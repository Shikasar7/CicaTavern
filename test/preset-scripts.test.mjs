// The Tavern Helper scripts an imported preset carries (server/preset-scripts.mjs): kept beside the preset at import,
// run in the chats that use it before the card's own (server/card-scripts.mjs), stopped by a switch or another preset,
// with permissions of the preset's own; and Tavern Helper's preset functions (getPreset / replacePreset).
process.env.CARD_SCRIPTS_FIRE_MS = '400'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { createApp } = await import('../server/http.mjs')
const { applyThPreset, presetScriptsOf, scriptsAsSwitched, thPreset, withPresetScripts } = await import('../server/preset-scripts.mjs')
const { decideEntry, entryDecision } = await import('../web/shared/frame-permissions.js')

const REPLY = '她点头。\n<UpdateVariable><JSONPatch>[{"op":"replace","path":"/心情","value":"好"}]</JSONPatch></UpdateVariable>'
// Each leaves its mark in 顺序 at a chat's start and after each reply: the order they ran in.
const marks = who => `
eventOn(Mvu.events.VARIABLE_INITIALIZED, variables => { variables.stat_data.开局 = (variables.stat_data.开局 || '') + '${who}' })
// Each reply's marks start afresh (both clear them; both run before either marks).
eventOn(Mvu.events.VARIABLE_UPDATE_STARTED, variables => { variables.stat_data.顺序 = '' })
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, variables => {
  variables.stat_data.顺序 = (variables.stat_data.顺序 || '') + '${who}'
  localStorage.setItem('n', String(Number(localStorage.getItem('n') || 0) + 1))
  variables.stat_data['${who}计数'] = Number(localStorage.getItem('n'))
})
eventOn('同名按钮', () => {
  const data = Mvu.getMvuData({ type: 'message', message_id: 'latest' })
  data.stat_data.按下 = (data.stat_data.按下 || '') + '${who}'
  Mvu.replaceMvuData(data, { type: 'message', message_id: 'latest' })
})`
const ASKS_MODEL = `
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, async variables => {
  try {
    variables.stat_data.总结 = await generate({ user_input: '一句话总结' })
  } catch (error) {
    variables.stat_data.总结错误 = error.message
  }
})`
const PANEL = `$(() => { replaceScriptButtons([{ name: '设置', visible: true }]); eventOn(getButtonEvent('设置'), () => {}) })`

const script = (name, content, buttons = []) => ({ type: 'script', enabled: true, name, id: name, content, info: '', button: { enabled: true, buttons: buttons.map(b => ({ name: b, visible: true })) } })
const cardJson = (name, scripts) => ({
  spec: 'chara_card_v2',
  data: { name, first_mes: '蝉鸣。\n<initvar>\n心情: 平\n</initvar>', extensions: scripts.length ? { tavern_helper: { scripts } } : {} },
})
const presetJson = (name, scripts) => ({
  name,
  prompts: [
    { identifier: 'main', name: '主提示', role: 'system', content: '你是叙述者。' },
    { identifier: 'chatHistory', name: 'Chat History', marker: true },
    { identifier: 'style', name: '文风', role: 'system', content: '写得简短。' },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'style', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
  extensions: scripts.length ? { tavern_helper: { scripts, variables: {} } } : {},
})

async function setup(t) {
  const model = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-preset-scripts-'))
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
  const upload = (p, json, filename = 'p.json') => send(p, { filename, data: Buffer.from(JSON.stringify(json)).toString('base64') })
  const importCard = async (name, scripts) => (await upload('/api/cards/import', cardJson(name, scripts), 'c.json')).json()
  const importPreset = async (name, scripts) => (await upload('/api/presets/import', presetJson(name, scripts))).json()
  const turn = async chat => {
    const latest = await get(`/api/chats/${chat.id}`)
    const text = await (await send(`/api/chats/${chat.id}/turn`, { parentId: latest.path.at(-1).id, input: '你好' })).text()
    assert.match(text, /"type":"done"/)
    return get(`/api/chats/${chat.id}`)
  }
  return { root, send, get, upload, importCard, importPreset, turn }
}

test("a preset's scripts as kept and switched; Tavern Helper's shape of a preset, there and back", () => {
  const file = presetJson('甲', [script('钩子', marks('P')), script('面板', PANEL, ['设置']), { name: '坏的' }])
  file.extensions.tavern_helper.scripts[1].data = { should_enable: true }
  const scripts = presetScriptsOf(file)
  assert.deepEqual(scripts.map(s => [s.name, s.enabled]), [['钩子', true], ['面板', true]], 'one without text is left out')
  assert.deepEqual(scripts[1].data, { should_enable: true }, 'its own variables, as its author shipped them')
  const preset = withPresetScripts({ prompts: [] }, scripts)
  assert.equal(preset.helperSaved, true)
  assert.deepEqual(preset.helperList.map(item => [item.name, item.kind, item.buttons]), [['钩子', 'hooks', []], ['面板', 'custom', ['设置']]])
  preset.helperList[0].on = false
  assert.deepEqual(scriptsAsSwitched(preset, scripts).map(s => s.enabled), [false, true])
  // An exported preset carries them in helperScriptList.
  assert.equal(presetScriptsOf({ format: 'agent-tavern-preset', preset: { helperScriptList: scripts } }).length, 2)

  const own = {
    params: { maxTokens: 1000 },
    prompts: [
      { id: 'main', name: '主提示', role: 'system', content: '甲', marker: false, absolute: false, depth: 4, enabled: true },
      { id: 'chatHistory', name: 'Chat History', role: 'system', content: '', marker: true, absolute: false, depth: 4, enabled: true },
      { id: 'style', name: '文风', role: 'system', content: '乙', marker: false, absolute: false, depth: 4, enabled: true },
    ],
  }
  const th = thPreset(own)
  assert.deepEqual(th.prompts.map(p => p.id), ['main', 'chat_history', 'style'])
  assert.equal(th.settings.max_completion_tokens, 1000)
  assert.equal(applyThPreset(own, structuredClone(th)), false, 'read and put back as it was: nothing changed')
  // A panel switches an entry off, moves another into the chat at depth 2 and adds one of its own.
  th.prompts[2].enabled = false
  th.prompts[0].position = { type: 'in_chat', depth: 2, order: 100 }
  th.prompts.push({ id: 'extra', name: '附加', role: 'user', content: '丙', enabled: true, position: { type: 'relative' } })
  assert.equal(applyThPreset(own, th), true)
  assert.deepEqual(own.prompts.map(p => [p.id, p.enabled, p.absolute, p.depth]), [['main', true, true, 2], ['chatHistory', true, false, 4], ['style', false, false, 4], ['extra', true, false, 4]])
  // Moved to prompts_unused: off. Left out of both: kept as it was, after the ordered ones.
  assert.equal(applyThPreset(own, { prompts: [{ id: 'style', enabled: true }], prompts_unused: [{ id: 'main' }] }), true)
  assert.deepEqual(own.prompts.map(p => [p.id, p.enabled]), [['style', true], ['main', false], ['chatHistory', true], ['extra', true]])
  assert.throws(() => applyThPreset(own, { nope: 1 }), /prompts/)
})

test("a preset's permissions are its own: one answer kept, an address's local answer forgotten with it", () => {
  let entry = decideEntry({}, 'generate', 'allow')
  entry = decideEntry(entry, 'relay', 'allow', 'https://api.example.com')
  entry = decideEntry(entry, 'local', 'allow', 'https://api.example.com')
  assert.equal(entryDecision(entry, 'generate'), 'allow')
  assert.equal(entryDecision(entry, 'local', 'https://api.example.com'), 'allow')
  entry = decideEntry(entry, 'relay', 'deny', 'https://api.example.com')
  assert.equal(entryDecision(entry, 'local', 'https://api.example.com'), undefined)
  assert.deepEqual(decideEntry(entry, 'nonsense', 'allow'), entry, 'an unknown kind changes nothing')
  assert.equal(entryDecision(decideEntry(entry, 'generate', null), 'generate'), undefined, 'null forgets: asked again')
})

test("a preset's scripts run beside the card's, the preset's first, and stop with a switch or another preset", async t => {
  const { root, send, get, importCard, importPreset, turn } = await setup(t)
  const preset = await importPreset('带脚本的预设', [script('预设钩子', marks('P')), script('面板', PANEL, ['设置'])])
  const card = await importCard('卡', [script('卡钩子', marks('C'))])
  // Kept beside the preset, not in it.
  assert.deepEqual(await readdir(path.join(root, 'preset-scripts')), [`${preset.id}.json`])
  const detail = await get(`/api/presets/${preset.id}`)
  assert.equal(detail.helperSaved, true)
  assert.deepEqual(detail.helperList.map(item => [item.name, item.kind, item.on]), [['预设钩子', 'hooks', true], ['面板', 'custom', true]])
  // The page starts the preset's page scripts with the chat, their own variables with them.
  const buttons = await get(`/api/presets/${preset.id}/script-buttons`)
  assert.deepEqual(buttons.page.map(s => [s.name, s.buttons, s.data]), [['面板', ['设置'], {}]])

  await send('/api/settings', { presetId: preset.id }, 'PUT')
  let chat = await (await send('/api/chats', { cardId: card.id })).json()
  assert.equal(chat.presetId, preset.id)
  assert.equal(chat.path[0].state.开局, 'PC', "at the start: the preset's, then the card's")
  chat = await turn(chat)
  assert.equal(chat.path.at(-1).state.顺序, 'PC', 'after a reply: the same order')
  // Each keeps its own storage, though the scripts use the same key.
  assert.equal(chat.path.at(-1).state.P计数, 1)
  assert.equal(chat.path.at(-1).state.C计数, 1)
  assert.deepEqual((await get(`/api/cards/${card.id}/script-events?presetId=${preset.id}`)).events, ['同名按钮'])

  // A button of the same name on both: each press reaches only its own.
  const pressed = async owner => (await (await send(`/api/chats/${chat.id}/script-event`, { type: '同名按钮', args: [], owner })).json()).chat.path.at(-1).state.按下
  assert.equal(await pressed('preset'), 'P')
  assert.equal(await pressed('card'), 'PC')

  // Switched off in the preset window: the card's alone.
  await send(`/api/presets/${preset.id}`, { helpers: [{ index: 0, on: false }] }, 'PUT')
  assert.equal((await get(`/api/presets/${preset.id}`)).helperList[0].on, false)
  chat = await turn(chat)
  assert.equal(chat.path.at(-1).state.顺序, 'C')
  await send(`/api/presets/${preset.id}`, { helpers: [{ index: 0, on: true }] }, 'PUT')
  chat = await turn(chat)
  assert.equal(chat.path.at(-1).state.顺序, 'PC', 'on again')
  // Another preset for the chat: the card's alone.
  chat = await (await send(`/api/chats/${chat.id}/preset`, { presetId: '' })).json()
  chat = await turn(chat)
  assert.equal(chat.path.at(-1).state.顺序, 'C')

  // Exported with its scripts, without what the player let them do; imported again, they run as before.
  await send(`/api/presets/${preset.id}/script-permissions`, { kind: 'generate', decision: 'allow' }, 'PUT')
  const archive = await get(`/api/presets/${preset.id}/export`)
  assert.equal(archive.preset.helperScriptList.length, 2)
  assert.equal(archive.preset.scriptPermissions, undefined)
  const again = await (await send('/api/presets/import', { filename: 'again.json', data: Buffer.from(JSON.stringify(archive)).toString('base64') })).json()
  const copy = await get(`/api/presets/${again.id}`)
  assert.equal(copy.helperSaved, true)
  assert.deepEqual(copy.scriptPermissions, {}, 'asked again for the copy')
  // Deleted: its scripts' file goes with it.
  await send(`/api/presets/${again.id}`, undefined, 'DELETE')
  assert.deepEqual(await readdir(path.join(root, 'preset-scripts')), [`${preset.id}.json`])
})

test("a preset's scripts call the model by the preset's permission, not the card's", async t => {
  const { send, get, importCard, importPreset, turn } = await setup(t)
  const preset = await importPreset('总结预设', [script('总结', ASKS_MODEL)])
  const card = await importCard('卡', [])
  await send('/api/settings', { presetId: preset.id }, 'PUT')
  let chat = await (await send('/api/chats', { cardId: card.id })).json()
  // The card's own permission does not cover its preset's scripts.
  await send(`/api/cards/${card.id}/script-permissions`, { model: true }, 'PUT')
  chat = await turn(chat)
  let latest = chat.path.at(-1)
  assert.match(latest.state.总结错误, /这个预设的脚本没有被允许/)
  assert.match(latest.scriptNotes.map(note => note.text).join(), /预设「总结预设」.*脚本权限/)
  assert.deepEqual(await get(`/api/presets/${preset.id}/script-permissions`), {})
  // Asked once, kept with the preset.
  assert.deepEqual(await (await send(`/api/presets/${preset.id}/script-permissions`, { kind: 'generate', decision: 'allow' }, 'PUT')).json(), { generate: 'allow' })
  assert.equal((await get(`/api/presets/${preset.id}`)).scriptPermissions.generate, 'allow')
  chat = await turn(chat)
  latest = chat.path.at(-1)
  assert.match(latest.state.总结, /她点头/, "the model's reply")
  // And the other way round: the preset's answer is not the card's.
  await send(`/api/cards/${card.id}/script-permissions`, { model: false }, 'PUT')
  assert.deepEqual(await get(`/api/cards/${card.id}/script-permissions`), { model: false })
})

test("Tavern Helper's preset functions: the chat's preset read, changed by a script, the chat's prefix built again", async t => {
  const { send, get, upload, importCard, importPreset } = await setup(t)
  const preset = await importPreset('开关预设', [])
  const card = await importCard('卡', [])
  await send('/api/settings', { presetId: preset.id }, 'PUT')
  const chat = await (await send('/api/chats', { cardId: card.id })).json()
  const info = await get(`/api/chats/${chat.id}/th-preset`)
  assert.equal(info.loaded, '开关预设')
  assert.ok(info.names.includes('开关预设'))
  assert.equal(info.editable, true)
  assert.deepEqual(info.inUse.prompts.map(p => [p.id, p.enabled]), [['main', true], ['style', true], ['chat_history', true]])
  // A panel switches 文风 off, as a floating menu does.
  const next = structuredClone(info.inUse)
  next.prompts.find(p => p.id === 'style').enabled = false
  const answer = await (await send(`/api/chats/${chat.id}/th-preset`, { name: 'in_use', preset: next }, 'PUT')).json()
  assert.equal(answer.changed, true)
  assert.equal(answer.rebuilt, true, 'the entry was in the fixed prefix')
  assert.equal(answer.info.inUse.prompts.find(p => p.id === 'style').enabled, false)
  assert.equal((await get(`/api/presets/${preset.id}`)).prompts.find(p => p.id === 'style').enabled, false, 'saved to the preset')
  assert.equal(answer.chat.id, chat.id, 'the chat as it is now, for the page')
  // The same again changes nothing; a name nobody has is refused.
  assert.equal((await (await send(`/api/chats/${chat.id}/th-preset`, { name: 'in_use', preset: next }, 'PUT')).json()).changed, false)
  assert.equal((await send(`/api/chats/${chat.id}/th-preset`, { name: '没有这个', preset: next }, 'PUT')).status, 400)
  // A chat on the built-in preset: read as empty, not changed.
  const plain = await (await send(`/api/chats/${chat.id}/preset`, { presetId: '' })).json()
  assert.equal((await get(`/api/chats/${plain.id}/th-preset`)).editable, false)
  assert.equal((await send(`/api/chats/${plain.id}/th-preset`, { name: 'in_use', preset: next }, 'PUT')).status, 400)

  // A preset imported before its scripts were kept reads them in from its file, its entries as edited here.
  const old = await importPreset('旧预设', [])
  await send(`/api/presets/${old.id}`, { prompts: [{ id: 'style', enabled: false }] }, 'PUT')
  assert.equal((await upload(`/api/presets/${old.id}/helper-scripts`, presetJson('旧预设', []))).status, 400, 'a file without scripts')
  const read = await (await upload(`/api/presets/${old.id}/helper-scripts`, presetJson('旧预设', [script('面板', PANEL, ['设置'])]))).json()
  assert.equal(read.helperSaved, true)
  assert.equal(read.helperScripts, 1)
  assert.equal(read.prompts.find(p => p.id === 'style').enabled, false, 'its entries stay as edited')
  assert.deepEqual((await get(`/api/presets/${old.id}/script-buttons`)).page.map(s => s.name), ['面板'])
})
