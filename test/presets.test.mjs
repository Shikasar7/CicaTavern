import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { editPreset, expandMacros, exportPreset, importOwnPreset, isPresetJson, normalizePreset, placementsOf, presetDetail, renderPresetPrefix, renderPresetTail } from '../server/presets.mjs'
import { buildChatPrompt, buildTurnPrompt, everyTurnReminder } from '../server/prompt.mjs'

const CARD = {
  name: '小雨', description: '一个爱下雨天的姑娘。', personality: '安静', scenario: '雨夜的书店', mesExample: '<START>\n{{char}}：你好',
  systemPrompt: '', postHistoryInstructions: '', book: null, depthPrompt: '',
}
const PERSONA = { name: '旅人', description: '迷路的旅人' }
const NAMES = { char: '小雨', user: '旅人' }

// The shape SillyTavern exports: prompts + per-character prompt_order.
const PRESET = {
  temperature: 1, openai_max_tokens: 4000,
  scenario_format: '[场景：{{scenario}}]',
  prompts: [
    { identifier: 'main', name: '主提示', role: 'system', content: '你是{{char}}的叙述者。{{setvar::字数::800}}' },
    { identifier: 'charDescription', name: 'Char Description', marker: true },
    { identifier: 'scenario', name: 'Scenario', marker: true },
    { identifier: 'worldInfoBefore', name: 'World Info (before)', marker: true },
    { identifier: 'open', name: '历史开端', role: 'system', content: '<历史>\n以下是过往记录' },
    { identifier: 'chatHistory', name: 'Chat History', marker: true },
    { identifier: 'close', name: '历史闭合', role: 'system', content: '</历史>' },
    { identifier: 'style', name: '文风', role: 'system', content: '白描为主，每轮约{{getvar::字数}}字。' },
    { identifier: 'dice', name: '骰子', role: 'user', content: '玩家输入：{{lastUserMessage}}' },
    { identifier: 'off', name: '关掉的', role: 'system', content: '不应出现' },
    { identifier: 'deep', name: '深度注入', role: 'system', content: '注意节奏', injection_position: 1, injection_depth: 2 },
  ],
  prompt_order: [
    { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
    {
      character_id: 100001,
      order: ['main', 'charDescription', 'scenario', 'worldInfoBefore', 'open', 'chatHistory', 'close', 'style', 'dice', 'off', 'deep']
        .map(identifier => ({ identifier, enabled: identifier !== 'off' })),
    },
  ],
  extensions: { regex_scripts: [{ scriptName: '隐藏思考', findRegex: '/<think>[\\s\\S]*?<\\/think>/g', replaceString: '', placement: [2] }] },
}

test('normalizePreset reads the 100001 order, markers, injections and bundled regex', () => {
  assert.equal(isPresetJson(PRESET), true)
  assert.equal(isPresetJson({ entries: {} }), false)
  const preset = normalizePreset(PRESET, '测试')
  assert.equal(preset.prompts.length, 11)
  assert.equal(preset.prompts.find(p => p.id === 'off').enabled, false)
  assert.equal(preset.prompts.find(p => p.id === 'scenario').marker, true)
  assert.equal(preset.prompts.find(p => p.id === 'deep').absolute, true)
  assert.equal(preset.regexScripts.length, 1)
  assert.equal(preset.params.maxTokens, 4000)
  assert.equal(preset.postMode, 'prefix')
})

test('static post-history prompts join the prefix; per-turn ones go to the turn', () => {
  const preset = normalizePreset(PRESET)
  const byId = Object.fromEntries(preset.prompts.map((p, i) => [p.id, placementsOf(preset)[i]]))
  assert.equal(byId.main, 'prefix')
  assert.equal(byId.style, 'prefix')
  assert.equal(byId.dice, 'turn')
  assert.equal(byId.deep, 'prefix')
  editPreset(preset, { postMode: 'turn' })
  assert.equal(placementsOf(preset)[preset.prompts.findIndex(p => p.id === 'style')], 'turn')
  assert.equal(presetDetail(preset).prompts.find(p => p.id === 'style').placement, 'turn')
})

test('prompt editor: name, role, position, depth, add, remove and reorder', () => {
  const preset = normalizePreset(PRESET)
  editPreset(preset, { prompts: [{ id: 'style', title: ' 文风·改 ', role: 'assistant', absolute: true, depth: 7.9 }] })
  const style = preset.prompts.find(p => p.id === 'style')
  assert.deepEqual([style.name, style.role, style.absolute, style.depth], ['文风·改', 'assistant', true, 7])
  editPreset(preset, { prompts: [{ id: 'style', role: 'narrator', depth: -3, title: '  ' }] })
  assert.deepEqual([style.name, style.role, style.depth], ['文风·改', 'assistant', 0], 'bad values are ignored or clamped')
  editPreset(preset, { prompts: [{ id: 'scenario', title: 'x', role: 'user' }] })
  assert.equal(preset.prompts.find(p => p.id === 'scenario').role, 'system', 'markers keep their fields')

  editPreset(preset, { add: { name: '补充规则', content: '多写环境' } })
  const added = preset.prompts.find(p => p.name === '补充规则')
  assert.match(added.id, /^custom-/)
  assert.equal(preset.prompts.indexOf(added), preset.prompts.findIndex(p => p.id === 'chatHistory') - 1, 'new entries land just before the chat history')
  assert.match(renderPresetPrefix(preset, { card: CARD, persona: PERSONA, names: NAMES }).text, /多写环境/)

  // Moving an entry past the chat history moves it out of the part before the history.
  const order = preset.prompts.map(p => p.id).filter(id => id !== added.id)
  order.splice(order.indexOf('chatHistory') + 1, 0, added.id)
  editPreset(preset, { order })
  assert.equal(presetDetail(preset).prompts.find(p => p.id === added.id).section, 'post')
  assert.throws(() => editPreset(preset, { order: order.slice(1) }), /刷新/)

  editPreset(preset, { quick: [added.id, 'dice'] })
  editPreset(preset, { remove: [added.id, 'chatHistory'] })
  assert.equal(preset.prompts.some(p => p.id === added.id), false)
  assert.equal(preset.prompts.some(p => p.id === 'chatHistory'), true, 'markers cannot be removed')
  assert.deepEqual(preset.quick, ['dice'])
})

test('the prefix follows the preset order, expands markers and carries variables', () => {
  const preset = normalizePreset(PRESET)
  const prefix = renderPresetPrefix(preset, { card: CARD, persona: PERSONA, names: NAMES, worldBefore: '常驻设定A' })
  const text = prefix.text
  assert.ok(text.indexOf('你是小雨的叙述者。') < text.indexOf('一个爱下雨天的姑娘。'))
  assert.match(text, /\[场景：雨夜的书店\]/)
  assert.match(text, /常驻设定A/)
  // The tag wrapping the chat history is dropped on both sides.
  assert.doesNotMatch(text, /<历史>/)
  assert.doesNotMatch(prefix.rules, /<\/历史>/)
  assert.doesNotMatch(text + prefix.rules, /不应出现/)
  // Depth injections first, then the post-history prompts in order.
  assert.equal(prefix.rules, '注意节奏\n\n白描为主，每轮约800字。')
  assert.equal(prefix.vars.字数, '800')

  const tail = renderPresetTail(preset, { card: CARD, persona: PERSONA, names: NAMES, vars: prefix.vars, input: '我推门进去' })
  assert.equal(tail, '玩家输入：我推门进去')
})

test('a prompt mixing fixed and per-turn paragraphs is split between prefix and turn', () => {
  const json = structuredClone(PRESET)
  json.prompts.find(p => p.identifier === 'style').content = '白描为主。\n\n---\n本轮骰子：{{roll:d20}}\n\n不要替玩家说话。'
  const preset = normalizePreset(json)
  assert.equal(placementsOf(preset)[preset.prompts.findIndex(p => p.id === 'style')], 'split')
  const prefix = renderPresetPrefix(preset, { card: CARD, persona: PERSONA, names: NAMES })
  assert.equal(prefix.rules, '注意节奏\n\n白描为主。\n\n不要替玩家说话。')
  const tail = renderPresetTail(preset, { card: CARD, persona: PERSONA, names: NAMES, vars: prefix.vars, input: '你好' })
  assert.match(tail, /^本轮骰子：\d+\n\n玩家输入：你好$/)
})

test('a per-turn paragraph that sets a variable sets it for the prefix prompts after it too', () => {
  // TGbreak: the options rule has {{random}} (so it goes per turn) and a {{setvar}} that the
  // output-order check, a fixed prompt after it, reads.
  const json = structuredClone(PRESET)
  json.prompts.find(p => p.identifier === 'style').content = '选项不超过{{random::4::5}}个，用<w2g>包起来。{{setvar::order::<w2g>}}'
  json.prompts.push({ identifier: 'format', name: '检查格式', role: 'system', content: '输出顺序：正文{{getvar::order}}' })
  json.prompt_order[1].order.push({ identifier: 'format', enabled: true })
  const preset = normalizePreset(json)
  const prefix = renderPresetPrefix(preset, { card: CARD, persona: PERSONA, names: NAMES })
  assert.match(prefix.rules, /输出顺序：正文<w2g>$/)
  assert.doesNotMatch(prefix.rules, /选项不超过/)
  const tail = renderPresetTail(preset, { card: CARD, persona: PERSONA, names: NAMES, vars: prefix.vars, input: '你好' })
  assert.match(tail, /^选项不超过[45]个，用<w2g>包起来。/)

  // 'latest': everything after the history goes with the turn, as with 'turn'.
  editPreset(preset, { postMode: 'latest' })
  assert.equal(presetDetail(preset).postMode, 'latest')
  assert.equal(renderPresetPrefix(preset, { card: CARD, persona: PERSONA, names: NAMES }).rules, '')
  assert.match(renderPresetTail(preset, { card: CARD, persona: PERSONA, names: NAMES, input: '你好' }), /输出顺序：正文<w2g>/)
})

test('late worldbook entries go last in the prefix, with a one-line reminder each turn', () => {
  const entry = (comment, content, position) => ({ uid: comment, comment, keys: [], secondaryKeys: [], content, constant: true, enabled: true, order: 10, position, initvar: false })
  const books = [{ id: 'b', entries: [entry('世界观', '雨城常年下雨。', 0), entry('[mvu_update]变量输出格式', '正文后输出 <UpdateVariable>。', 4)] }]
  const plain = buildChatPrompt({ card: CARD, persona: PERSONA, settings: {}, books, hasState: false }).systemPrompt
  assert.ok(plain.indexOf('雨城常年下雨。') < plain.indexOf('## 每轮回复都要遵守'))
  assert.match(plain, /## 每轮回复都要遵守\n【\[mvu_update\]变量输出格式】\n正文后输出 <UpdateVariable>。$/)
  assert.equal(everyTurnReminder(plain, books), '本轮回复同样要遵守系统提示末尾「每轮回复都要遵守」一节的全部要求，包括【[mvu_update]变量输出格式】。')
  // A chat whose frozen prefix predates the section still gets a reminder by title.
  assert.equal(everyTurnReminder('## 常驻设定\n【[mvu_update]变量输出格式】\n…', books), '本轮回复同样要遵守系统提示中【[mvu_update]变量输出格式】的要求。')
  assert.equal(everyTurnReminder('无关', [{ id: 'b', entries: [books[0].entries[0]] }]), '')
  // A preset's post-history prompts in the prefix: point at the blocks they want after the story.
  assert.equal(everyTurnReminder(plain, books, { presetRules: true }), '本轮回复同样要遵守系统提示末尾「每轮回复都要遵守」一节的全部要求，包括预设规定的输出格式和顺序（正文之后要求附加的内容块一个都不能省）、【[mvu_update]变量输出格式】。')
  assert.equal(everyTurnReminder('## 每轮回复都要遵守 只有预设', [], { presetRules: true }), '本轮回复同样要遵守系统提示末尾「每轮回复都要遵守」一节的全部要求，尤其是预设规定的输出格式和顺序（正文之后要求附加的内容块一个都不能省）。')
  const turn = buildTurnPrompt({ names: NAMES, input: '你好', reminder: '提醒一句' })
  assert.match(turn, /<\/玩家输入>\n\n<本轮提醒>提醒一句<\/本轮提醒>$/)
  const withPreset = buildChatPrompt({ card: CARD, persona: PERSONA, settings: {}, books, hasState: false, preset: normalizePreset(PRESET) }).systemPrompt
  assert.match(withPreset, /## 每轮回复都要遵守\n注意节奏\n\n白描为主，每轮约800字。\n\n【\[mvu_update\]变量输出格式】/)
})

test('buildChatPrompt puts preset rules last and buildTurnPrompt appends the preset block', () => {
  const preset = normalizePreset(PRESET)
  const built = buildChatPrompt({ card: CARD, persona: PERSONA, settings: { language: '简体中文', writingRules: '' }, books: [], hasState: false, preset })
  assert.match(built.systemPrompt, /^你是小雨的叙述者。/)
  assert.match(built.systemPrompt, /## 本应用的消息格式/)
  assert.match(built.systemPrompt, /## 每轮回复都要遵守\n注意节奏\n\n白描为主，每轮约800字。$/)
  assert.equal(built.presetVars.字数, '800')
  const turn = buildTurnPrompt({ names: NAMES, input: '你好', presetText: '玩家输入：你好' })
  assert.match(turn, /<玩家输入>\n你好\n<\/玩家输入>\n\n<预设指令>\n玩家输入：你好\n<\/预设指令>$/)
  const plain = buildChatPrompt({ card: CARD, persona: PERSONA, settings: {}, books: [], hasState: false })
  assert.match(plain.systemPrompt, /## 基本规则/)
})

test('card main prompt overrides the preset main, with {{original}}', () => {
  const preset = normalizePreset(PRESET)
  const card = { ...CARD, systemPrompt: '卡作者：{{original}}再加一句' }
  const { text } = renderPresetPrefix(preset, { card, persona: PERSONA, names: NAMES })
  assert.match(text, /^卡作者：你是小雨的叙述者。再加一句/)
})

test('expandMacros: nesting, vars, trim, unknown macros survive', () => {
  const ctx = { names: NAMES, vars: {} }
  assert.equal(expandMacros('{{setvar::a::3}}{{addvar::a::4}}{{getvar::a}}', ctx), '7')
  assert.equal(expandMacros('{{setvar::b::{{user}}}}[{{getvar::b}}]', ctx), '[旅人]')
  assert.equal(expandMacros('上\n\n{{trim}}\n下', ctx), '上下')
  assert.equal(expandMacros('{{// 注释}}{{xbgetvar::x}}', ctx), '{{xbgetvar::x}}')
  assert.match(expandMacros('{{random::甲::乙}}', ctx), /^[甲乙]$/)
})

// The author's own presets (test/local-paths.mjs; skipped elsewhere).
const { realPresets: REAL = '' } = existsSync(new URL('./local-paths.mjs', import.meta.url)) ? await import('./local-paths.mjs') : {}
test('every real preset on this machine imports and renders', { skip: !existsSync(REAL) }, () => {
  for (const name of readdirSync(REAL).filter(f => f.endsWith('.json'))) {
    const json = JSON.parse(readFileSync(path.join(REAL, name), 'utf8'))
    if (!isPresetJson(json)) continue
    const preset = normalizePreset(json, name)
    const prefix = renderPresetPrefix(preset, { card: CARD, persona: PERSONA, names: NAMES })
    const tail = renderPresetTail(preset, { card: CARD, persona: PERSONA, names: NAMES, vars: prefix.vars, input: '我推门进去' })
    assert.ok(prefix.text.includes('一个爱下雨天的姑娘。') || !preset.prompts.some(p => p.id === 'charDescription' && p.enabled), name)
    assert.ok(tail.length < 1500, `${name}: per-turn block stays small (${tail.length})`)
  }
})

test('preset export and import: edits made here travel, the copy gets its own id', () => {
  const preset = normalizePreset(PRESET)
  editPreset(preset, { postMode: 'turn', prompts: [{ id: 'style', title: '文风·改' }] })
  const archive = JSON.parse(JSON.stringify(exportPreset(preset)))
  const copy = importOwnPreset(archive)
  assert.notEqual(copy.id, preset.id)
  assert.deepEqual({ ...copy, id: preset.id, importedAt: preset.importedAt }, preset)
  assert.equal(importOwnPreset(PRESET), null, 'a SillyTavern file is left to normalizePreset')
  assert.throws(() => importOwnPreset({ ...archive, preset: { name: 'x', prompts: [{ id: 1 }] } }), /不完整/)
})
