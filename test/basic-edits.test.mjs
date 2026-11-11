// The built-in presets edited as entries: their own paragraphs rewritten or switched off, the player's
// entries added (in the prefix or with each turn), and everything back as it comes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanBuiltinEdits, cleanBasic, VN_ID } from '../web/shared/basic.js'
import { basicDetail, basicPreset, basicRules, editBuiltin, ownTexts, vnPreset } from '../server/basic.mjs'
import { buildChatPrompt } from '../server/prompt.mjs'
import { renderPresetTailParts } from '../server/presets.mjs'
import { createApp } from '../server/http.mjs'

const CARD = { name: '小雨', description: '一个爱下雨天的姑娘。', personality: '', scenario: '', mesExample: '', systemPrompt: '', postHistoryInstructions: '', book: null, depthPrompt: '' }
const PERSONA = { name: '旅人', description: '' }
const system = settings => buildChatPrompt({ card: CARD, persona: PERSONA, settings: { language: '简体中文', ...settings }, books: [], hasState: false, preset: basicPreset(settings) }).systemPrompt

test('no edits: the prompt is what it was', () => {
  assert.equal(basicRules(cleanBasic({})), basicRules(cleanBasic({}), cleanBuiltinEdits(null)))
  assert.deepEqual(cleanBuiltinEdits(undefined), { texts: {}, off: [], added: [], regexScripts: [] })
  const prompt = system({})
  assert.match(prompt, /^你是一场互动小说的叙述者，同时扮演除玩家以外的所有角色。玩家扮演「旅人」。\n\n## 基本规则\n- 除了「每轮回复都要遵守」一节/)
})

test('an own paragraph is rewritten for the option it was written for, switched off, and reset', () => {
  const settings = { basic: { style: 'cinematic' } }
  const known = ownTexts(settings, 'basic')
  assert.ok(known.has('style:cinematic') && known.has('intro') && known.has('rules'))
  let edits = editBuiltin(cleanBuiltinEdits(null), { prompts: [{ id: 'style:cinematic', content: '文风——只写{{char}}看得见的。' }, { id: 'knowledge:on', enabled: false }, { id: 'nope', content: 'x' }] }, known)
  assert.deepEqual(Object.keys(edits.texts), ['style:cinematic'], 'only what the window shows')
  const prompt = system({ ...settings, basicEdits: edits })
  assert.match(prompt, /文风——只写小雨看得见的。/)
  assert.doesNotMatch(prompt, /电影感/)
  assert.doesNotMatch(prompt, /信息隔离/)
  // Another style: its own text, the rewrite kept for when it comes back.
  assert.match(system({ basic: { style: 'delicate' }, basicEdits: edits }), /文风——细腻/)
  // The text as it comes is no edit; reset puts one back, switched on.
  assert.deepEqual(editBuiltin(edits, { prompts: [{ id: 'style:cinematic', content: known.get('style:cinematic') }] }, known).texts, {})
  edits = editBuiltin(edits, { reset: 'knowledge:on' }, known)
  assert.deepEqual(edits.off, [])
  const detail = basicDetail({ ...settings, basicEdits: edits })
  const style = detail.prompts.find(p => p.id === 'style:cinematic')
  assert.equal(style.edited, true)
  assert.match(style.original, /电影感/)
  assert.equal(detail.edited, 1)
})

test('the narrator lines are editable too', () => {
  const known = ownTexts({}, 'basic')
  const edits = editBuiltin(cleanBuiltinEdits(null), { prompts: [{ id: 'intro', content: '你是说书人，{{user}}在听。' }] }, known)
  assert.match(system({ basicEdits: edits }), /^你是说书人，旅人在听。\n\n## 基本规则/)
})

test('the player\'s entries: at the top, in the every-turn section, or with each turn', () => {
  const known = ownTexts({}, 'basic')
  let edits = cleanBuiltinEdits(null)
  for (const [name, place] of [['顶', 'top'], ['规则', 'rules'], ['每轮', 'turn']]) edits = editBuiltin(edits, { add: { name, content: `${name}的内容`, place } }, known)
  const [top, rules, turn] = edits.added
  edits = editBuiltin(edits, { prompts: [{ id: top.id, title: '开头那条' }] }, known)
  assert.equal(edits.added[0].name, '开头那条')
  const prompt = system({ basicEdits: edits })
  assert.ok(prompt.indexOf('顶的内容') > prompt.indexOf('## 基本规则') && prompt.indexOf('顶的内容') < prompt.indexOf('## 角色卡'))
  assert.ok(prompt.indexOf('规则的内容') > prompt.indexOf('## 每轮回复都要遵守'))
  assert.doesNotMatch(prompt, /每轮的内容/, 'not in the prefix')
  const preset = basicPreset({ basicEdits: edits })
  const tail = renderPresetTailParts(preset, { card: CARD, persona: PERSONA, names: { char: '小雨', user: '旅人' } })
  assert.equal(tail.text, '每轮的内容')
  // Switched off, moved, ordered, removed.
  edits = editBuiltin(edits, { prompts: [{ id: turn.id, enabled: false }] }, known)
  assert.equal(renderPresetTailParts(basicPreset({ basicEdits: edits }), { card: CARD, persona: PERSONA, names: { char: '小雨', user: '旅人' } }).text, '')
  edits = editBuiltin(edits, { prompts: [{ id: turn.id, place: 'rules', enabled: true }] }, known)
  edits = editBuiltin(edits, { order: [turn.id, rules.id, top.id] }, known)
  assert.ok(system({ basicEdits: edits }).indexOf('每轮的内容') < system({ basicEdits: edits }).indexOf('规则的内容'))
  assert.throws(() => editBuiltin(edits, { order: [turn.id] }, known), /刷新/)
  edits = editBuiltin(edits, { remove: [rules.id, 'own-one'] }, known)
  assert.deepEqual(edits.added.map(e => e.id), [turn.id, top.id])
})

test('the visual novel preset keeps its own edits and its lines together', () => {
  const settings = { vn: {}, vnEdits: { texts: { 'vn-paging:short': '一段一句。' } } }
  const rules = vnPreset(settings).edits.texts
  assert.equal(rules['vn-paging:short'], '一段一句。')
  const detail = basicDetail(settings, VN_ID)
  assert.match(detail.rules, /\n一段一句。\n/, 'the visual novel lines stay one paragraph')
  assert.equal(basicDetail(settings).edited, 0, 'the basic preset has none')
})

test('PUT /api/presets/basic edits, and reset: all puts the options and edits back', async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-basic-edits-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  await call('/api/settings', { method: 'PUT', body: { basic: { jailbreak: 'soft' } } })
  const added = (await call('/api/presets/basic', { method: 'PUT', body: { add: { name: '我的', content: '多写雨。', place: 'rules' } } })).body
  assert.ok(added.prompts.some(p => p.kind === 'added' && p.name === '我的'))
  assert.match(added.rules, /多写雨。/)
  await call('/api/presets/basic', { method: 'PUT', body: { prompts: [{ id: 'jailbreak:soft', content: '照写。' }] } })
  await call('/api/presets/basic/regex', { method: 'PUT', body: { scripts: [{ scriptName: 'r', findRegex: '/a/g', replaceString: 'b' }] } })
  assert.equal((await call('/api/presets/vn')).body.edited, 0, 'the other built-in preset is apart')
  const before = (await call('/api/presets/basic')).body
  assert.equal(before.edited, 3)
  assert.equal(before.regexScriptList.length, before.ownRegex + 1)
  const reset = (await call('/api/presets/basic', { method: 'PUT', body: { reset: 'all' } })).body
  assert.equal(reset.edited, 0)
  assert.equal(reset.options.jailbreak, 'off')
  assert.equal(reset.regexScriptList.length, reset.ownRegex)
})
