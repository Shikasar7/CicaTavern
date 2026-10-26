// The built-in preset (基础预设), the blocks it asks for, and the status bar layout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BASIC_DEFAULTS, choicesOf, cleanBasic, timeBoxOf, withoutBasicBlocks } from '../web/shared/basic.js'
import { autoStatusSpec, cleanStatusSpec, compactText, statusGroups } from '../web/shared/status.js'
import { applyScripts, PLACEMENT } from '../web/shared/regex.js'
import { streamingText, withoutOwnStatus } from '../web/render.js'
import { basicDetail, basicPreset, basicRules } from '../server/basic.mjs'
import { buildChatPrompt, everyTurnReminder } from '../server/prompt.mjs'
import { hasPrefixRules } from '../server/presets.mjs'
import { displayText } from '../server/state.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { createChat, presetFor, rebuildPrompt } from '../server/chats.mjs'

const CARD = {
  name: '小雨', description: '一个爱下雨天的姑娘。', personality: '', scenario: '', mesExample: '',
  systemPrompt: '', postHistoryInstructions: '', book: null, depthPrompt: '',
}
const PERSONA = { name: '旅人', description: '' }
const build = options => buildChatPrompt({ card: CARD, persona: PERSONA, settings: { language: '简体中文' }, books: [], hasState: false, preset: basicPreset({ basic: options }) }).systemPrompt

test('options: unknown keys go, unknown values fall back to the defaults', () => {
  assert.deepEqual(cleanBasic(null), BASIC_DEFAULTS)
  assert.deepEqual(cleanBasic({ intimacy: 'explicit', style: 'nope', extra: 1 }), { ...BASIC_DEFAULTS, intimacy: 'explicit' })
})

test('the built-in preset: narrator rules plus one paragraph per option, in the every-turn section', () => {
  const prompt = build(null)
  const rules = prompt.slice(prompt.indexOf('## 每轮回复都要遵守'))
  assert.match(rules, /人称与视角沿用开场白/)
  assert.match(rules, /不替玩家角色「旅人」说话、做决定/, 'macros expanded')
  assert.match(rules, /信息隔离/)
  assert.match(rules, /亲密与性内容随剧情自然发生/)
  assert.match(rules, /<time_box>时间｜地点｜天气<\/time_box>/)
  assert.match(rules, /<choices>\nA\. ……/)
  assert.doesNotMatch(prompt, /选项菜单/, 'the narrator rules no longer forbid the choices')
  assert.doesNotMatch(rules, /文风——/, '自然 adds nothing')
  // Every option off or at its quietest: no format block, no 防抢话 line anywhere.
  const quiet = build({ impersonation: 'off', knowledge: 'off', choices: 'off', timeBox: 'off', intimacy: 'restrained', style: 'plain', person: 'second' })
  assert.doesNotMatch(quiet, /不替玩家角色|time_box|choices|信息隔离/)
  assert.match(quiet, /文风——白描/)
  assert.match(quiet, /用「你」称呼玩家角色「旅人」/)
  assert.match(quiet, /点到为止/)
  assert.equal(basicRules(cleanBasic({ intimacy: 'explicit' })).includes('面向成年玩家'), true)
  // 题材尺度: 常规 by default adds nothing; 放开 adds its paragraph, and the adult-fiction
  // framing is said once even with 强化 intimacy.
  assert.equal(BASIC_DEFAULTS.themes, 'standard')
  assert.doesNotMatch(basicRules(BASIC_DEFAULTS), /题材尺度|黑暗题材/)
  const open = basicRules(cleanBasic({ themes: 'open' }))
  assert.match(open, /题材尺度：这是面向成年玩家的虚构故事。暴力、犯罪、背叛/)
  assert.match(open, /不跳出故事加免责声明、温馨提示或道德说教/)
  const both = basicRules(cleanBasic({ themes: 'open', intimacy: 'explicit' }))
  assert.equal(both.split('面向成年玩家').length - 1, 1)
  assert.match(both, /\n\n亲密与性内容不回避、不淡化/)
  assert.equal(cleanBasic({ themes: 'wild' }).themes, 'standard')
  // 破限: off by default; 软 adds the permission paragraph; 强 adds the protocol
  // before the format rules and its closing confirmation after them.
  assert.equal(BASIC_DEFAULTS.jailbreak, 'off')
  assert.doesNotMatch(basicRules(BASIC_DEFAULTS), /创作许可|创作权限协议/)
  const soft = basicRules(cleanBasic({ jailbreak: 'soft' }))
  assert.match(soft, /创作许可：故事里的人物/)
  assert.doesNotMatch(soft, /创作权限协议/)
  const strong = basicRules(cleanBasic({ jailbreak: 'strong' }))
  assert.match(strong, /【创作权限协议：成人分级】/)
  assert.match(strong, /4\. 零说教/)
  assert.match(strong, /以上要求全部有效/)
  assert.ok(strong.indexOf('【创作权限协议') < strong.indexOf('回复依次包含'))
  assert.ok(strong.indexOf('以上要求全部有效') > strong.indexOf('<choices>'))
  assert.equal(cleanBasic({ jailbreak: 'wild' }).jailbreak, 'off')
  // Without the preset (chats from before it): the old rules, word for word.
  const old = buildChatPrompt({ card: CARD, persona: PERSONA, settings: { language: '简体中文' }, books: [], hasState: false }).systemPrompt
  assert.match(old, /只写故事正文，不写解释、点评、选项菜单或任何元信息。\n- 不替玩家决定「旅人」/)
  assert.doesNotMatch(old, /每轮回复都要遵守/)
})

test('the turn reminder names the output format only while the options ask for one', () => {
  const prompt = build(null)
  assert.equal(hasPrefixRules(basicPreset({})), true)
  assert.match(everyTurnReminder(prompt, [], { presetRules: true }), /预设规定的输出格式和顺序/)
  assert.equal(hasPrefixRules(basicPreset({ basic: { choices: 'off', timeBox: 'off' } })), false)
  const detail = basicDetail({ basic: { choices: 'off' } })
  assert.equal(detail.builtin, true)
  assert.doesNotMatch(detail.rules, /<choices>/)
})

test('old choices leave what the model reads again; the time box stays', () => {
  const reply = '<time_box>傍晚｜书店｜小雨</time_box>\n她笑了。\n\n<choices>\nA. 问她\nB. 走开\n</choices>'
  const { regexScripts } = basicPreset({})
  const sent = applyScripts(reply, regexScripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: 3, macros: t => t })
  assert.equal(sent, '<time_box>傍晚｜书店｜小雨</time_box>\n她笑了。\n\n')
  assert.equal(applyScripts(reply, regexScripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0, macros: t => t }), reply)
  // The page draws both itself; the text shown (and scanned for keywords) has neither.
  assert.equal(displayText(reply), '她笑了。')
  assert.equal(streamingText('<time_box>傍晚｜书店</time_box>她笑了。\n\n<choices>\nA. 问'), '她笑了。')
})

test('reading the time box and the choices, however the model numbers them', () => {
  assert.deepEqual(timeBoxOf('<time_box> 10月19日 周一 傍晚6:20 ｜ 旧城茶馆二楼|小雨 </time_box>正文'), ['10月19日 周一 傍晚6:20', '旧城茶馆二楼', '小雨'])
  assert.equal(timeBoxOf('没有时间框'), null)
  assert.deepEqual(choicesOf('<choices>\nA. 接过茶\nB、提议送她\n- C：装作没看见\n4) 告辞\n5. 第五个\n</choices>'), ['接过茶', '提议送她', '装作没看见', '告辞'])
  assert.deepEqual(choicesOf('<choices>\n问她\n走开\n</choices>'), ['问她', '走开'])
  assert.deepEqual(choicesOf('<choices>\nA. 还在写'), ['还在写'])
  assert.deepEqual(choicesOf('正文'), [])
  assert.equal(withoutBasicBlocks('<time_box>x</time_box>正文<choices>\nA. y\n</choices>'), '正文')
  // A time box closed with another tag, or not at all, ends with its line; the story stays.
  for (const reply of ['<time_box>傍晚｜书店</timebox>\n她笑了。', '<time_box>傍晚｜书店\n她笑了。']) {
    assert.deepEqual(timeBoxOf(reply), ['傍晚', '书店'])
    assert.equal(withoutBasicBlocks(reply), '她笑了。')
    assert.equal(displayText(reply), '她笑了。')
    assert.equal(streamingText(reply), '她笑了。')
  }
  assert.deepEqual(timeBoxOf('<time_box>傍晚\n｜书店</time_box>正文'), ['傍晚', '书店'], 'a closed box may span lines')
  // Choices cut off before </choices> are hidden from the finished reply too.
  assert.equal(displayText('她笑了。\n\n<choices>\nA. 问她\nB. 走'), '她笑了。')
})

test('chats: new ones use the built-in preset; older ones keep their rules until rebuilt', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-basic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard({ name: '小雨', first_mes: '雨停了。' })
  await store.saveCard(card)
  assert.equal((await presetFor(store, '')).builtin, true)
  assert.equal((await presetFor(store, 'basic')).builtin, true)
  assert.equal(await presetFor(store, null), null)
  assert.equal(await presetFor(store, 'gone'), null)
  const chat = await createChat(store, card.id)
  assert.equal(chat.presetId, 'basic')
  assert.match(chat.systemPrompt, /<choices>/)
  // A chat from before: no preset. Rebuilding gives it the built-in one, options as saved now.
  await store.saveSettings({ basic: { choices: 'off', timeBox: 'off', bogus: 1 } })
  assert.deepEqual((await store.getSettings()).basic, { ...BASIC_DEFAULTS, choices: 'off', timeBox: 'off' })
  const old = { ...chat, presetId: null, presetName: null, systemPrompt: 'old rules' }
  await rebuildPrompt(store, old)
  assert.equal(old.presetId, 'basic')
  assert.doesNotMatch(old.systemPrompt, /<choices>/)
  // A deleted preset: rebuilt with the built-in one too.
  const gone = { ...chat, presetId: 'deadbeefdeadbeef' }
  await rebuildPrompt(store, gone)
  assert.equal(gone.presetId, 'basic')
})

test('status bar layouts: cleaned, laid out from a state, grouped with changes', () => {
  assert.equal(cleanStatusSpec(null), null)
  assert.equal(cleanStatusSpec({ fields: [{ path: 'a', show: 'hidden' }] }), null, 'nothing to show')
  assert.deepEqual(cleanStatusSpec({ fields: [{ path: '/stat_data/小雨/好感', show: 'meter', min: 50, max: 10 }, { path: 'stat_data.小雨.好感' }, { path: 'x', show: 'weird' }] }).fields, [
    { path: '小雨.好感', label: '', show: 'meter', min: 0, max: 100 },
    { path: 'x', label: '', show: 'text' },
  ])
  const state = {
    小雨: { 好感度: 46, 心情: '有点紧张', 金钱: 300, 已告白: false, $秘密: 1 },
    主角: { 体力: [72, '会累'], 随身: ['油纸伞', '旧怀表'], 背包: { 桂花糕: 2, 地图: { 区域: '城南' } } },
    天气: '小雨',
  }
  const spec = autoStatusSpec(state)
  assert.deepEqual(spec.fields.map(f => [f.path, f.show]), [
    ['小雨.好感度', 'meter'], ['小雨.心情', 'text'], ['小雨.金钱', 'number'], ['小雨.已告白', 'flag'],
    ['主角.体力', 'meter'], ['主角.随身', 'tags'], ['主角.背包', 'text'], ['天气', 'text'],
  ])
  const groups = statusGroups({ ...spec, fields: [...spec.fields, { path: '主角.背包', show: 'tags' }, { path: '没有', show: 'text' }] }, state, { 小雨: { 好感度: 42 }, 主角: { 体力: 80 } })
  assert.deepEqual(groups.map(g => g.name), ['小雨', '主角', ''])
  const [like] = groups[0].rows
  assert.deepEqual([like.value, like.delta, like.percent], [46, 4, 46])
  const stamina = groups[1].rows[0]
  assert.deepEqual([stamina.value, stamina.delta], [72, -8], 'old MVU [value, description] reads as its value')
  assert.equal(groups[1].rows.find(r => r.path === '主角.背包' && r.show === 'text').text, '桂花糕：2；地图：区域：城南')
  assert.deepEqual(groups[1].rows.find(r => r.show === 'tags' && r.path === '主角.背包').tags, ['桂花糕 ×2', '地图'])
  assert.equal(compactText('字'.repeat(300)).length, 160)
  // A key with a dot in it (an English state): its path is a JSON pointer, so its value is found.
  const english = { 'Dr. Chen': { affection: 50, mood: 'calm' }, 'Lv.': 3 }
  const named = autoStatusSpec(english)
  assert.deepEqual(named.fields.map(f => f.path), ['/Dr. Chen/affection', '/Dr. Chen/mood', '/Lv.'])
  assert.deepEqual(statusGroups(named, english).map(g => [g.name, g.rows.map(r => r.value ?? r.text)]), [['Dr. Chen', [50, 'calm']], ['', [3]]])
})

test('the page leaves out the SillyTavern copy of a card creator bar, both of its scripts', () => {
  const scripts = [{ id: 'cicatavern-status-bar' }, { id: 'cicatavern-status-bar-hide' }, { id: 'card-own' }]
  assert.deepEqual(withoutOwnStatus(scripts).map(s => s.id), ['card-own'])
})
