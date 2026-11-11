// 创作角色卡's 高级选项: 玩法积木, 卡的规模 and the status bar's looks. The code writes the works, the model fills in
// the content, and a card without them is what it always was.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { createForge } from '../server/forge/index.mjs'
import { createRulebooks } from '../server/game.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { blockFind, brickContent, brickCost, brickScripts, cleanEvents, cleanJudge, cleanWorld, eventDraw } from '../server/forge/bricks.mjs'
import { cleanCardOptions, cleanVariables, discussRequest, editTracking, emptyBrief, normalizePlan, optionLines, planRequest, reviseRequest, typedValue, withCardOptions } from '../server/forge/prompts.mjs'
import { forSillyTavern } from '../server/forge/st-export.mjs'
import { MVU_HELPER_ID, statusBarHtml, statusSpecOf } from '../server/forge/status.mjs'
import { cardJson, conditionExpression, entriesRequest, initialState, newCard, stateContent, writeSteps } from '../server/forge/write.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { drawnEntries, everyTurnReminder } from '../server/prompt.mjs'
import { basicPreset, basicRules, hasBasicFormat, vnPreset } from '../server/basic.mjs'
import { cleanBasic } from '../web/shared/basic.js'
import { bookText, bookValue, cleanPalette, limitsOf, onPage, paletteColors, settlePicks, statusGroups, statusPages } from '../web/shared/status.js'
import { PLACEMENT, applyScripts } from '../web/shared/regex.js'
import { cleanKit } from '../web/shared/game/sheet.js'
import { replaceVariableMacros } from '../web/shared/vars.js'
import { displayText } from '../server/state.mjs'

const RAW = {
  name: '春日便当',
  summary: '同桌每天多带一份便当。',
  user_role: { identity: '转学生' },
  world: { kind: '真实', overview: '海边小城的高中', places: [{ name: '天台', description: '午休去的地方' }, { name: '车站', description: '放学路过' }] },
  characters: [{ name: '林小满', kind: 'core', aliases: ['小满'], gender: '女', identity: '同桌', relationship: '每天给你带便当', personality: { base: '嘴硬', main: ['认真'] } }],
  style: { perspective: '第二人称' },
  tracking: { enabled: true, variables: [{ path: '林小满.好感度', label: '好感', type: 'number', initial: '20', range: '0~100', check: '真心相待时 +2' }] },
  greetings: [{ title: '午休', scene: '天台', situation: '她把便当推过来', state: {} }],
  avatar: { character: '林小满' },
}
const planOf = (raw, options) => withCardOptions(normalizePlan({ ...RAW, ...raw }, { scale: options?.scale }), options)

const EVENTS = { rate: 'rare', groups: [{ when: '在学校', items: ['班主任突然点名', '隔壁班的人来借东西'] }, { when: '放学路上', items: ['下起了雨', '老同学打来电话', '猫挡在路中间'] }] }
const JUDGE = { measure: '关系', when: '<user> 想让她做超出现在关系的事时', ranks: ['同学', '朋友', '恋人'], rank_path: '主角.关系', gaps: [{ gap: 0, result: '她半推半就' }, { gap: 1, result: '她笑着躲开' }, { gap: 2, result: '她翻脸走人' }], known: [{ name: '牵手', rank: '朋友' }, { name: '不存在', rank: '神仙' }] }

test('nothing picked: what the model is told, the options and the plan are as they were', () => {
  const options = cleanCardOptions({ cast: 'single', format: 'mvu-ui' })
  assert.deepEqual(Object.keys(options).sort(), ['cast', 'format', 'gender', 'play', 'statusTheme', 'world'])
  const said = [
    planRequest([], emptyBrief(), {}, { options }).system,
    discussRequest([{ user: { text: '想法' } }], emptyBrief(), { reply: '简体中文', card: '简体中文' }, { options }).system,
  ].join('\n')
  for (const word of ['selfcheck', 'random_events', 'judge', '册子', '自查', '随机事件', '裁判', 'status_colors', 'page']) assert.ok(!said.includes(word), word)
  const plan = planOf({}, options)
  for (const key of ['bricks', 'scale', 'selfcheck', 'random_events', 'judge', 'status_colors']) assert.ok(!(key in plan), key)
  assert.equal(plan.entries.filter(entry => ['selfcheck', 'events', 'judge'].includes(entry.part)).length, 0)
  assert.equal(cardJson(plan, newCard(plan)).data.extensions.regex_scripts.filter(script => /self-check|event|judge/.test(script.id)).length, 0)
})

test('what a model writes for a brick nobody picked does not get in', () => {
  const plan = planOf({ selfcheck: ['查这个'], judge: JUDGE, random_events: EVENTS }, cleanCardOptions({}))
  for (const key of ['selfcheck', 'random_events', 'judge']) assert.ok(!(key in plan), key)
  assert.equal(plan.entries.filter(entry => ['selfcheck', 'events', 'judge'].includes(entry.part)).length, 0)
})

test('the prompts name no genre: a brick is for any card', () => {
  const plan = planRequest([], emptyBrief(), {}, { options: cleanCardOptions({ bricks: ['books', 'selfcheck', 'events', 'judge'], scale: 'epic' }) }).system
  for (const word of ['修仙', '境界', '灵石', '战力', '修为', '武器', '怪物', '恋爱', '好感']) {
    const own = plan.split('\n').filter(line => /selfcheck|random_events|judge|册子|世界比一般的大/.test(line)).join('\n')
    assert.ok(!own.includes(word), word)
  }
})

// ─── Picks that depend on each other ──────────────────────────────────────

test('a brick that keeps values moves the format, says so, and moves it back', () => {
  const before = { format: '', bricks: [], play: [] }
  const on = settlePicks({ ...before, bricks: ['judge'] }, before)
  assert.equal(on.format, 'mvu-ui')
  assert.equal(on.formatBefore, '')
  const off = settlePicks({ ...on, bricks: [] }, on)
  assert.equal(off.format, '')
  assert.ok(!('formatBefore' in off))
  const text = { format: 'text', bricks: [], play: [] }
  assert.equal(settlePicks({ ...text, bricks: ['books'] }, text).formatBefore, 'text')
  const quiet = settlePicks({ ...text, bricks: ['selfcheck', 'events'] }, text)
  assert.equal(quiet.format, 'text')
  assert.ok(!('formatBefore' in quiet))
})

test('plain text picked by hand takes away the bricks that need values; another format stands', () => {
  const on = settlePicks({ format: '', bricks: ['books', 'events'], play: [] }, { format: '', bricks: [], play: [] })
  const text = settlePicks({ ...on, format: 'text' }, on)
  assert.deepEqual(text.bricks, ['events'])
  assert.equal(text.format, 'text')
  const mvu = settlePicks({ ...on, format: 'mvu' }, on)
  assert.ok(!('formatBefore' in mvu))
  assert.equal(settlePicks({ ...mvu, bricks: [] }, mvu).format, 'mvu')
})

test('裁判表 and 战斗与成长: the one picked last stays, and on the server the rules win', () => {
  const fight = { format: '', bricks: [], play: ['battle'] }
  const judge = settlePicks({ ...fight, bricks: ['judge'] }, fight)
  assert.deepEqual(judge.play, [])
  assert.deepEqual(judge.bricks, ['judge'])
  const back = settlePicks({ ...judge, play: ['battle'] }, judge)
  assert.deepEqual(back.bricks, [])
  assert.deepEqual(back.play, ['battle'])
  assert.ok(!('bricks' in cleanCardOptions({ play: ['battle'], bricks: ['judge'] })))
})

test('options as kept: only what goes with what is picked', () => {
  assert.equal(cleanCardOptions({ eventRate: 'often' }).eventRate, undefined)
  assert.equal(cleanCardOptions({ bricks: ['events'], eventRate: 'often' }).eventRate, 'often')
  assert.equal(cleanCardOptions({ bricks: ['events'], eventRate: 'hourly' }).eventRate, undefined)
  assert.equal(cleanCardOptions({ bricks: ['judge'], judgeDice: 'off' }).judgeDice, 'off')
  assert.equal(cleanCardOptions({ bricks: ['books'], format: 'text' }).format, 'mvu-ui')
  assert.equal(cleanCardOptions({ scale: 'galaxy' }).scale, undefined)
  assert.equal(cleanCardOptions({ format: 'mvu-ui', statusTheme: 'auto' }).statusTheme, 'auto')
  assert.equal(cleanCardOptions({ format: 'mvu', statusPages: true }).statusPages, undefined)
})

// ─── 背包和册子 ───────────────────────────────────────────────────────────

const BOOK = { path: '主角.回忆', label: '回忆', type: 'book', show: 'table', columns: ['日子', '心情'], initial: [{ name: '第一份便当', 日子: 1, 心情: '紧张' }], check: '发生值得记住的事时加一行' }

test('a book goes out as a record MVU lets grow, with the rows it starts with', () => {
  const plan = planOf({ tracking: { enabled: true, variables: [...RAW.tracking.variables, BOOK] } }, cleanCardOptions({ bricks: ['books'] }))
  const book = plan.tracking.variables.find(v => v.type === 'book')
  assert.equal(book.initial, '第一份便当|1|紧张')
  assert.deepEqual(initialState(plan).主角.回忆, { $meta: { extensible: true }, 第一份便当: { 日子: 1, 心情: '紧张' } })
  const initvar = stateContent({ part: 'initvar' }, plan)
  assert.deepEqual(YAML.parse(initvar).主角.回忆.$meta, { extensible: true })
})

test('the model is told how to add, take out and change a row, and what each row keeps', () => {
  const plan = planOf({ tracking: { enabled: true, variables: [...RAW.tracking.variables, BOOK] } }, cleanCardOptions({ bricks: ['books'] }))
  const format = stateContent({ part: 'format' }, plan)
  assert.match(format, /"op": "add", "path": "\/主角\/回忆\/这一行的名字"/)
  assert.match(format, /册子（回忆）/)
  assert.match(format, /"op": "replace", "path": "\/林小满\/好感度", "value": 22/)
  assert.match(stateContent({ part: 'rules' }, plan), /每行记:\s*\n\s*- 日子/)
})

test('a card with only a book has a format that needs no other variable', () => {
  const plan = planOf({ tracking: { enabled: false, variables: [] } }, cleanCardOptions({ bricks: ['books'] }))
  assert.equal(plan.tracking.enabled, true)
  assert.equal(plan.tracking.variables[0].path, '主角.背包')
  assert.match(stateContent({ part: 'format' }, plan), /^\[\{ "op": "add", "path": "\/主角\/背包\/这一行的名字"/m)
})

test('a book in English has English columns when the planner wrote none', () => {
  const plan = withCardOptions(normalizePlan({ ...RAW, tracking: { enabled: false, variables: [] } }, { language: 'English' }), cleanCardOptions({ bricks: ['books'] }))
  assert.equal(plan.tracking.variables[0].path, 'Protagonist.Bag')
  assert.deepEqual(plan.tracking.variables[0].columns, ['Count', 'Note'])
})

test('a book as text and back: numbers stay numbers, nothing gets in that should not', () => {
  assert.equal(bookText([{ name: '铜钱', 数量: 5, 说明: 'a|b；c' }], ['数量', '说明']), '铜钱|5|a b c')
  assert.equal(bookText({ $meta: {}, 铜钱: { 数量: 5 } }, ['数量']), '铜钱|5')
  assert.deepEqual(bookValue('铜钱|5|旧；地图', ['数量', '说明']), { $meta: { extensible: true }, 铜钱: { 数量: 5, 说明: '旧' }, 地图: { 数量: '', 说明: '' } })
  assert.deepEqual(Object.keys(bookValue('__proto__|1；$meta|2；伞', ['数量'])), ['$meta', '伞'])
})

test('a book shows as a table, and an empty one shows none of MVU marks', () => {
  const spec = { fields: [{ path: '主角.回忆', label: '回忆', show: 'table' }] }
  const [full] = statusGroups(spec, { 主角: { 回忆: { $meta: { extensible: true }, 午休: { 心情: '紧张' } } } })
  assert.deepEqual(full.rows[0].table.rows.map(row => row.name), ['午休'])
  const [empty] = statusGroups(spec, { 主角: { 回忆: { $meta: { extensible: true } } } })
  assert.equal(empty.rows[0].text, '')
})

test('MVU marks stay out of what the model reads: the format, and {{format_message_variable}}', () => {
  const state = { 主角: { 回忆: { $meta: { extensible: true }, 午休: { 心情: '紧张' } }, 物品: ['$__META_EXTENSIBLE__$', '伞'] } }
  const text = replaceVariableMacros('{{format_message_variable::stat_data}}', state)
  assert.ok(!text.includes('meta'))
  assert.ok(!text.includes('META'))
  assert.match(text, /午休/)
  assert.match(text, /伞/)
})

test('an event can wait for a row in a book', () => {
  const variable = { path: '主角.回忆', type: 'book', columns: ['心情'], initial: '' }
  assert.equal(conditionExpression({ variable, op: 'has', value: '告白' }).startsWith('("告白" in getvar('), true)
})

// ─── 写前自查 ─────────────────────────────────────────────────────────────

test('写前自查: the model fills in what to check; the rule, the regex and the reminder are the code', () => {
  const plan = planOf({ selfcheck: ['她嘴硬的时候有没有直接说喜欢？', '便当的菜色和前文对得上吗？'] }, cleanCardOptions({ format: 'text', bricks: ['selfcheck'] }))
  const entry = plan.entries.find(e => e.part === 'selfcheck')
  assert.equal(entry.strategy, 'constant')
  const text = stateContent(entry, plan)
  assert.match(text, /<self_check>[\s\S]*<\/self_check>/)
  assert.match(text, /1\. 她嘴硬/)
  const card = newCard(plan)
  assert.equal(card.entries.find(e => e.part === 'selfcheck').content, text)
  const raw = cardJson(plan, card)
  const scripts = raw.data.extensions.regex_scripts
  const reply = '<self_check>\n1. 没问题\n2. 菜色写成了炸鸡，改回饭团\n</self_check>\n她把便当推过来。'
  assert.equal(applyScripts(reply, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: 4, macros: t => t }), '她把便当推过来。')
  assert.equal(applyScripts(reply, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0, macros: t => t }), '她把便当推过来。')
  // The turn's reminder names the block: named, it gets written (9 of 9 turns; 2 of 9 by the entry's name alone).
  const loaded = normalizeCard(raw)
  const late = loaded.book.entries.filter(e => e.position >= 2)
  assert.ok(late.some(e => e.content.includes('<self_check>')))
  assert.match(everyTurnReminder('## 每轮回复都要遵守', [loaded.book], { scripts: loaded.regexScripts }), /<self_check>…<\/self_check>/)
})

test('写前自查 with nothing written still checks something, in the card\'s language', () => {
  assert.equal(planOf({}, cleanCardOptions({ bricks: ['selfcheck'] })).selfcheck.length, 3)
  const english = withCardOptions(normalizePlan(RAW, { language: 'English' }), cleanCardOptions({ bricks: ['selfcheck'] }))
  assert.match(english.selfcheck[0], /sound like/)
  assert.match(stateContent({ part: 'selfcheck' }, english), /Every reply opens with this self-check/)
})

test('a block left open takes one paragraph with it, not the story', () => {
  const find = new RegExp(blockFind('self_check').slice(1, -3), 'gi')
  assert.equal('<self_check>\n1. 没问题\n\n她笑了。\n\n然后走了。'.replace(find, ''), '她笑了。\n\n然后走了。')
  assert.equal('<self_check>\n1. 还在写'.replace(find, ''), '')
  assert.equal('<self_check>\n1. 没问题\n\n2. 也没问题\n</self_check>\n她笑了。'.replace(find, ''), '她笑了。')
})

test('战斗与成长 picked: 写前自查 leaves strength and gains to the rules', () => {
  assert.match(optionLines(cleanCardOptions({ play: ['battle'], bricks: ['selfcheck'] })).plan.join('\n'), /强弱和得失也不写/)
  assert.ok(!optionLines(cleanCardOptions({ bricks: ['selfcheck'] })).plan.join('\n').includes('强弱和得失'))
})

// ─── 随机事件 ─────────────────────────────────────────────────────────────

test('随机事件: drawn each turn by the code, in groups by where the story is, on a plain text card too', () => {
  const plan = planOf({ random_events: EVENTS, tracking: { enabled: false, variables: [] } }, cleanCardOptions({ format: 'text', bricks: ['events'] }))
  assert.equal(plan.tracking.enabled, false)
  const raw = cardJson(plan, newCard(plan))
  const scripts = raw.data.extensions.regex_scripts.filter(script => /^cicatavern-event-\d+$/.test(script.id))
  assert.equal(scripts.length, 2)
  // A copy of the rule a model writes back is kept from the player, and from what the model reads back.
  const echo = raw.data.extensions.regex_scripts.filter(script => script.id.startsWith('cicatavern-event-echo'))
  assert.deepEqual(echo.map(script => [script.promptOnly, script.markdownOnly]), [[true, false], [false, true]])
  const copied = '她点了点头。\n\n<random_event_rules>\n本轮抽到：班长来借笔记\n</random_event_rules>'
  for (const script of echo) assert.equal(applyScripts(copied, [script], { placement: PLACEMENT.AI_OUTPUT, target: script.promptOnly ? 'prompt' : 'display', depth: 0 }).trim(), '她点了点头。')
  assert.deepEqual(scripts[0].placement, [5])
  assert.equal(scripts[0].promptOnly, true)
  const loaded = normalizeCard(raw)
  const drawn = drawnEntries([loaded.book], loaded.regexScripts, { user: '你', char: '林小满' })
  assert.equal(drawn.length, 1)
  const lines = drawn[0].text.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^在学校：(班主任突然点名|隔壁班的人来借东西|无)$/)
  assert.match(lines[1], /^放学路上：(下起了雨|老同学打来电话|猫挡在路中间|无)$/)
})

test('the rule says when it is void, and offers nothing in its place', () => {
  const plan = planOf({ random_events: EVENTS }, cleanCardOptions({ bricks: ['events'] }))
  const text = stateContent({ part: 'events' }, plan)
  assert.match(text, /- 抽到「无」：这条作废，这一轮不安排任何意外。\n/, 'a draw of nothing offers nothing')
  assert.match(text, /才作废，也不要换成别的事/)
  // A drawn event is not voided by a tense scene: it comes in smaller, it is in this turn's story, and the model looks back for it.
  assert.match(text, /场面再紧、话正说到一半也不作废/)
  assert.match(text, /否则这件事这一轮必须写进正文/)
  assert.match(text, /写完回头看一眼：正文里有没有这件事？没有就补上再交。\n<\/random_event_rules>$/)
  assert.ok(!/改放|改成|窗外|照抄|本轮抽到[^：]/.test(text), 'no other event in its place, and no word about copying the rule')
})

test('how often is the odds of the draw, and the pick beats the planner', () => {
  const count = (text, word) => text.split('::').filter(item => item.replace(/[{}]/g, '') === word).length
  const items = ['甲', '乙', '丙']
  for (const [rate, n] of [['rare', 8], ['normal', 5], ['often', 3]]) assert.equal(count(eventDraw(items, rate, '无'), '无'), items.length * (n - 1))
  assert.equal(planOf({ random_events: EVENTS }, cleanCardOptions({ bricks: ['events'], eventRate: 'often' })).random_events.rate, 'often')
  assert.equal(planOf({ random_events: EVENTS }, cleanCardOptions({ bricks: ['events'] })).random_events.rate, 'rare')
})

test('what is drawn cannot break the macro', () => {
  assert.equal(eventDraw(['a::b', '{{user}}来了', '花了 $1'], 'often', '无').split('::').length, 3 + 6 + 1 - 0 + 0 + 1 - 1)
  assert.ok(!eventDraw(['{{user}}来了'], 'often', '无').includes('{{user'))
  assert.ok(!eventDraw(['花了 $1'], 'often', '无').includes('$'))
})

test('a group too short to be a draw goes; no groups, no entry, and the plan says so', () => {
  assert.deepEqual(cleanEvents({ groups: [{ items: ['只有一条'] }] }).groups, [])
  const plan = planOf({}, cleanCardOptions({ bricks: ['events'] }))
  assert.equal(plan.entries.some(e => e.part === 'events'), false)
  assert.ok(plan.warnings.some(w => w.includes('随机事件')))
})

// ─── 裁判表 ───────────────────────────────────────────────────────────────

test('裁判表 compares whatever the card says: the ladder, the gaps, the known; the player\'s rank is a variable', () => {
  const plan = planOf({ judge: JUDGE }, cleanCardOptions({ bricks: ['judge'] }))
  assert.ok(plan.tracking.variables.some(v => v.path === '主角.关系' && v.initial === '同学' && v.show === 'badge'))
  assert.equal(plan.tracking.enabled, true)
  assert.deepEqual(plan.judge.known, [{ name: '牵手', rank: '朋友' }])
  const text = stateContent({ part: 'judge' }, plan)
  assert.match(text, /靠「关系」定成败/)
  assert.match(text, /1 同学、2 朋友、3 恋人/)
  assert.match(text, /差 2 及以上：她翻脸走人/)
  assert.match(text, /每次动笔前先问自己一句：这一轮里，是不是<user>想让她做超出现在关系的事？是，就必须先写下面的 <judge> 块再写正文/)
  assert.match(text, /不是，这条作废：整个 <judge> 块都不写，也不写「本轮无判定」这类话。/)
  assert.match(text, /做的是一件事、不是和人较量时，「对方的等级」就是这件事要求的等级：/)
  assert.match(text, /\[JUDGE_DICE\]/)
})

test('a judgment is one plain line for the player, gone for the model, and the die is the code\'s', () => {
  const plan = planOf({ judge: JUDGE }, cleanCardOptions({ bricks: ['judge'] }))
  const raw = cardJson(plan, newCard(plan))
  const scripts = raw.data.extensions.regex_scripts
  const dice = scripts.find(script => script.id === 'cicatavern-judge-dice')
  assert.equal(dice.replaceString, '{{roll:1d20}}')
  assert.deepEqual(dice.placement, [5])
  const reply = '<judge>\n对比：同学 对 恋人\n差距：2\n结果：她翻脸走人\n</judge>\n她把便当收了回去。'
  assert.equal(applyScripts(reply, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: 1, macros: t => t }), '她把便当收了回去。')
  const shown = applyScripts(reply, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0, macros: t => t })
  assert.equal(shown, '〔判定：她翻脸走人〕\n\n她把便当收了回去。')
  // No result line, or still being written: nothing of it shows.
  assert.equal(applyScripts('<judge>\n对比：同学\n</judge>\n她笑了。', scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0, macros: t => t }), '她笑了。')
  assert.equal(applyScripts('<judge>\n对比：同', scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0, macros: t => t }), '')
})

test('a judgment and a self-check are no story: previews and summaries leave them out', () => {
  assert.equal(displayText('<self_check>\n1. 没问题\n</self_check>\n<judge>\n结果：输\n</judge>\n她走了。').trim(), '她走了。')
})

test('in Chinese there is no space beside the player, whatever the rule says', () => {
  const plan = planOf({ judge: JUDGE }, cleanCardOptions({ bricks: ['judge'] }))
  const text = stateContent({ part: 'judge' }, plan)
  assert.ok(!/ <user>|<user> /.test(text.replace(/^对比：.*$/m, '')))
})

test('no luck asked for: no die in the rule or in the card', () => {
  const plan = planOf({ judge: JUDGE }, cleanCardOptions({ bricks: ['judge'], judgeDice: 'off' }))
  assert.ok(!stateContent({ part: 'judge' }, plan).includes('JUDGE_DICE'))
  assert.ok(!cardJson(plan, newCard(plan)).data.extensions.regex_scripts.some(script => script.id === 'cicatavern-judge-dice'))
})

test('a ladder that does not hold up goes no further, and the plan says so', () => {
  const plan = planOf({ judge: { measure: '修为', ranks: ['甲'] } }, cleanCardOptions({ bricks: ['judge'] }))
  assert.equal(plan.entries.some(e => e.part === 'judge'), false)
  assert.ok(plan.warnings.some(w => w.includes('裁判表')))
  assert.deepEqual(cleanJudge({ ranks: ['甲', '乙'], gaps: [{ gap: 1, result: '后' }, { gap: 0, result: '先' }, { gap: 1, result: '重复' }] }).gaps.map(g => g.result), ['先', '后'])
})

// ─── 战斗与成长 knows the ladder ──────────────────────────────────────────

test('the plan\'s ladder, its span, sanity and what energy is called reach the card\'s rules', () => {
  const game = { attributes: {}, energy: '灵力', ranks: ['一阶', '二阶', '三阶'], rank_span: 'narrow', sanity: true }
  const plan = planOf({ game }, cleanCardOptions({ play: ['battle'] }))
  const rules = cardJson(plan, newCard(plan)).data.extensions.cicatavern.game
  assert.deepEqual(rules.ranks, ['一阶', '二阶', '三阶'])
  assert.equal(rules.rankSpan, 'narrow')
  assert.equal(rules.sanity, true)
  assert.equal(rules.energyName, '灵力')
  assert.equal(rules.level, 'full')
})

test('a plan revised keeps them: the kit reads its own names back', () => {
  const kit = cleanKit({ energy: '灵力', ranks: ['一阶', '二阶'], rank_span: 'narrow', sanity: true })
  assert.deepEqual(cleanKit(kit), kit)
  assert.equal(cleanKit({ rank_span: 'odd' }).rankSpan, 'wide')
})

test('the planner is asked for them with 战斗与成长, in words of no genre', () => {
  const line = optionLines(cleanCardOptions({ play: ['battle'] })).plan.join('\n')
  for (const word of ['"ranks"', '"rank_span"', '"sanity"', '"energy"']) assert.ok(line.includes(word), word)
  assert.ok(!/炼气|筑基|金丹|境界/.test(line))
})

// ─── 卡的规模 ─────────────────────────────────────────────────────────────

const many = (n, make) => Array.from({ length: n }, (_, i) => make(i + 1))
const BIG = {
  world: { overview: '大陆', places: many(30, i => ({ name: `地点${i}`, description: '一句话' })), factions: many(15, i => ({ name: `势力${i}`, description: '一句话' })) },
  characters: [RAW.characters[0], ...many(40, i => ({ name: `配角${i}`, kind: 'npc', identity: '路人', role: '路过' }))],
}

test('轻量 holds what it always held; 标准 and 大作 hold more', () => {
  const light = planOf(BIG, cleanCardOptions({}))
  assert.deepEqual([light.characters.length, light.world.places.length, light.world.factions.length], [12, 10, 8])
  const standard = planOf(BIG, cleanCardOptions({ scale: 'standard' }))
  assert.deepEqual([standard.characters.length, standard.world.places.length, standard.world.factions.length], [30, 20, 12])
  const epic = planOf(BIG, cleanCardOptions({ scale: 'epic' }))
  assert.deepEqual([epic.characters.length, epic.world.places.length, epic.world.factions.length], [41, 30, 15])
  assert.equal(epic.scale, 'epic')
})

test('variables follow the scale, also when edited by hand', () => {
  const variables = many(150, i => ({ path: `世界.项${i}`, type: 'number', initial: '1' }))
  assert.equal(planOf({ tracking: { enabled: true, variables } }, cleanCardOptions({})).tracking.variables.length, limitsOf('').variables)
  const epic = planOf({ tracking: { enabled: true, variables } }, cleanCardOptions({ scale: 'epic' }))
  assert.equal(epic.tracking.variables.length, 150)
  assert.equal(editTracking(epic, { variables }).tracking.variables.length, 150)
})

test('a bigger card is written in batches, a card of the usual size in one go', () => {
  const light = planOf(BIG, cleanCardOptions({}))
  const steps = plan => writeSteps(plan, newCard(plan)).filter(step => step.names)
  assert.ok(steps(light).every(step => !step.id.includes(':') || step.id.startsWith('character:')))
  const epic = planOf(BIG, cleanCardOptions({ scale: 'epic' }))
  const cast = steps(epic).filter(step => step.id.startsWith('cast'))
  assert.ok(cast.length >= 5)
  assert.ok(cast.every(step => step.names.length <= 8))
  assert.equal(new Set(cast.map(step => step.id)).size, cast.length)
  assert.match(cast[0].label, /（1\/\d+）$/)
  const names = steps(epic).flatMap(step => step.names)
  assert.equal(new Set(names).size, names.length)
})

test('a batch is told the world and the core cast, and in full only what it writes', () => {
  const plan = planOf(BIG, cleanCardOptions({ scale: 'epic' }))
  const target = plan.entries.find(e => e.name === '配角3')
  const sent = entriesRequest(plan, [target], []).messages[0].content
  const told = JSON.parse(sent.slice(sent.indexOf('<plan>') + 7, sent.indexOf('</plan>')))
  const cast = name => told.characters.find(c => c.name === name)
  assert.equal(cast('配角3').role, '路过')
  assert.deepEqual(Object.keys(cast('配角4')), ['name', 'kind', 'identity'])
  assert.ok(cast('林小满').personality)
  assert.deepEqual(Object.keys(told.world.places[0]), ['name'])
  const light = planOf(RAW, cleanCardOptions({}))
  assert.equal(entriesRequest(light, [light.entries[0]], []).messages[0].content.includes(JSON.stringify(light.world)), true)
})

test('keywords two entries share are pointed out on a bigger card', () => {
  const twins = { characters: [RAW.characters[0], { name: '张三', kind: 'npc', aliases: ['老大'], role: '路过' }, { name: '李四', kind: 'npc', aliases: ['老大'], role: '路过' }] }
  assert.ok(planOf(twins, cleanCardOptions({ scale: 'standard' })).warnings.some(w => w.includes('老大')))
  assert.ok(!planOf(twins, cleanCardOptions({})).warnings.some(w => w.includes('老大')))
})

// ─── The status bar ───────────────────────────────────────────────────────

test('colors of the card\'s own: kept when they are colors, and text stays readable', () => {
  assert.equal(cleanPalette({ bg: 'red', ink: '#000000', accent: '#ff0000' }), null)
  const fixed = cleanPalette({ bg: '#ffffff', ink: '#f0f0f0', accent: '#fefefe' })
  assert.equal(fixed.ink, '#1c1c1c')
  assert.notEqual(fixed.accent, '#fefefe')
  assert.deepEqual(cleanPalette({ bg: '#101820', ink: '#F2F2F2', accent: '#E0A030' }), { bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' })
  assert.match(paletteColors(cleanPalette({ bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' })).soft, /^rgba\(224,160,48/)
})

test('按卡配色 goes from the plan to both bars; by hand too', () => {
  const plan = planOf({ status_colors: { bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' } }, cleanCardOptions({ format: 'mvu-ui', statusTheme: 'auto' }))
  const spec = statusSpecOf(plan)
  assert.deepEqual(spec.palette, { bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' })
  assert.ok(!('theme' in spec))
  assert.match(statusBarHtml(spec), /style="--bg:#101820;--ink:#f2f2f2/)
  const edited = editTracking(plan, { palette: { bg: '#000000', ink: '#ffffff', accent: '#ff00ff' } })
  assert.equal(statusSpecOf(edited).palette.accent, '#ff00ff')
  assert.equal(edited.status_colors.bg, '#000000')
})

test('the SillyTavern bar draws a list a line each, as the app does, and tags by their marks', () => {
  const html = statusBarHtml({ fields: [{ path: '主角.线索簿', show: 'list' }] })
  // Its helpers, run on their own: everything from unwrap up to the DOM helper.
  const script = html.slice(html.indexOf('const unwrap='), html.indexOf('const h='))
  const { lines, tags } = new Function(`${script}; return { lines, tags }`)()
  const clues = '岑秀兰：煤油，一卷油布\n路线本批注：寄临水县，挂号信'
  assert.deepEqual(lines(clues), ['岑秀兰：煤油，一卷油布', '路线本批注：寄临水县，挂号信'])
  assert.deepEqual(lines(['甲', '乙']), ['甲', '乙'])
  assert.deepEqual(tags('甲、乙，丙'), ['甲', '乙', '丙'])
  assert.match(html, /f\.show==='list'\)\{[^}]*lines\(value\)/)
})

test('a new look reaches both bars', () => {
  const plan = planOf({}, cleanCardOptions({ format: 'mvu-ui', statusTheme: 'gothic' }))
  const spec = statusSpecOf(plan)
  assert.equal(spec.theme, 'gothic')
  const html = statusBarHtml(spec)
  assert.match(html, /class="bar theme-gothic"/)
  assert.match(html, /\.theme-gothic\{/)
})

test('pages: the plan says which, a field with none goes on the first, one page is no pages', () => {
  const variables = [{ path: '林小满.好感度', type: 'number', range: '0~100', page: '她' }, { path: '主角.回忆', type: 'book', columns: ['心情'], page: '册子' }, { path: '世界.天气', type: 'string' }]
  const plan = planOf({ tracking: { enabled: true, variables } }, cleanCardOptions({ format: 'mvu-ui', statusPages: true }))
  const spec = statusSpecOf(plan)
  const pages = statusPages(spec)
  assert.deepEqual(pages, ['她', '册子'])
  assert.deepEqual(onPage(spec, '她', pages).fields.map(field => field.path), ['林小满.好感度', '世界.天气'])
  assert.deepEqual(statusPages({ fields: [{ path: 'a', show: 'text', page: '一' }] }), [])
  const off = statusSpecOf(planOf({ tracking: { enabled: true, variables } }, cleanCardOptions({ format: 'mvu-ui' })))
  assert.ok(off.fields.every(field => !('page' in field)))
})

// ─── 写前自查 in the built-in presets ─────────────────────────────────────

test('the preset\'s 写前自查 is off unless asked, and asks only what the options keep watch on', () => {
  assert.equal(cleanBasic({}).selfCheck, 'off')
  assert.ok(!basicRules(cleanBasic({})).includes('self_check'))
  assert.equal(basicPreset({}).regexScripts.length, 1)
  const on = basicRules(cleanBasic({ selfCheck: 'on' }))
  assert.match(on, /<self_check>/)
  assert.match(on, /替「\{\{user\}\}」说话/)
  assert.match(on, /本不知道的事/)
  const loose = basicRules(cleanBasic({ selfCheck: 'on', impersonation: 'off', knowledge: 'off' }))
  assert.ok(!loose.includes('替「{{user}}」说话、做决定或写内心？'))
  assert.ok(!loose.includes('本不知道的事'))
  assert.match(loose, /前文对不对得上/)
  assert.equal(hasBasicFormat(cleanBasic({ selfCheck: 'on', choices: 'off', timeBox: 'off' })), true)
})

test('on, only the last two replies keep the block for the model to follow, in both built-in presets', () => {
  const settings = { basic: { selfCheck: 'on' }, vn: { selfCheck: 'on' } }
  const reply = '<self_check>\n1. 没问题\n</self_check>\n她笑了。'
  for (const preset of [basicPreset(settings), vnPreset(settings)]) {
    assert.equal(preset.regexScripts.length, 3)
    const sent = depth => applyScripts(reply, preset.regexScripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth })
    assert.equal(sent(4), '她笑了。')
    assert.equal(sent(3), reply)
    assert.equal(sent(1), reply)
  }
})

test('a card\'s self-check too: older ones go, the last two stay, and the judgment never does', () => {
  const scripts = brickScripts({ selfcheck: ['查一条'], judge: { measure: '修为', ranks: ['凡', '仙'], gaps: [{ gap: 0, result: '平' }], known: [], dice: false } }, false)
  const reply = '<self_check>\n1. 没问题\n</self_check>\n<judge>\n结果：平\n</judge>\n她笑了。'
  const sent = depth => applyScripts(reply, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth })
  assert.equal(sent(4).trim(), '她笑了。')
  assert.match(sent(3), /<self_check>/)
  assert.doesNotMatch(sent(1), /<judge>/)
})

test('the turn\'s reminder asks for it, once, whoever asked for it', () => {
  const system = '## 每轮回复都要遵守\n'
  assert.match(everyTurnReminder(system, [], { selfCheck: true }), /<self_check>…<\/self_check> 自查/)
  assert.ok(!everyTurnReminder(system, [], {}).includes('self_check'))
  const plan = planOf({ selfcheck: ['查这个'] }, cleanCardOptions({ bricks: ['selfcheck'] }))
  const loaded = normalizeCard(cardJson(plan, newCard(plan)))
  const both = everyTurnReminder(system, [loaded.book], { selfCheck: true, scripts: loaded.regexScripts })
  assert.equal(both.split('<self_check>').length, 2)
})

// ─── What a brick costs ───────────────────────────────────────────────────

test('what the bricks add can be told before anything is written', () => {
  const plan = planOf({ selfcheck: ['一', '二', '三'], judge: JUDGE }, cleanCardOptions({ bricks: ['selfcheck', 'judge'] }))
  const cost = brickCost(plan, false)
  assert.ok(cost.always > 200)
  assert.equal(cost.reply, 3 * 25 + 60)
})

// ─── The whole way through ────────────────────────────────────────────────

const PNG = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex').toString('base64')}`

/** A forge on a model that answers in the wizard's formats. */
async function wizard(t, plan) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-bricks-'))
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const system = String(body.messages[0]?.content ?? '')
    const user = body.messages.filter(m => m.role === 'user').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
    calls.push({ system, user })
    let text = '<reply>好。</reply><questions>[]</questions><brief>{"title": "卡", "readiness": 80, "items": [], "open": []}</brief>'
    if (system.includes('角色卡策划')) text = `<plan>\n${JSON.stringify(plan)}\n</plan>`
    else if (system.includes('审稿人')) text = '<issues>[]</issues>'
    else if (system.includes('开场白作者')) text = '<greeting index="1">开场。</greeting>'
    else if (system.includes('角色卡写手')) text = [...user.matchAll(/^- (.+?)：/gm)].map(m => `<entry name="${m[1]}">内容</entry>`).join('\n')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/writer` })
  const rulebooks = createRulebooks(store)
  const forge = createForge(store, { ledger: { recordTurn: async () => {} }, rulebooks })
  const settled = async id => {
    for (let i = 0; i < 600; i++) {
      const draft = await forge.get(id)
      if (!draft.job) return draft
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('the job never finished')
  }
  return { forge, store, rulebooks, calls, settled }
}

test('a big card goes from the picks to a saved card, a batch at a time', async t => {
  const { forge, store, calls, settled } = await wizard(t, { ...RAW, ...BIG, selfcheck: ['查这个'], random_events: EVENTS })
  let draft = await settled((await forge.create({ text: '大世界', options: { scale: 'epic', bricks: ['selfcheck', 'events', 'books'], eventRate: 'often', format: 'mvu-ui' } })).id)
  assert.equal(draft.options.scale, 'epic')
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  assert.equal(draft.plan.characters.length, 41)
  assert.ok(draft.brickCost.always > 0)
  await forge.write(draft.id)
  draft = await settled(draft.id)
  assert.equal(draft.error ?? null, null)
  assert.equal(draft.stage, 'polish')
  const writes = calls.filter(call => call.system.includes('角色卡写手'))
  assert.ok(writes.length >= 10)
  assert.ok(writes.every(call => (call.user.match(/^- .+?：/gm) ?? []).length <= 8))
  const saved = await forge.saveCard(draft.id, { avatar: PNG })
  const card = await store.getCard(saved.card.id)
  assert.equal(card.book.entries.filter(entry => entry.comment.startsWith('配角')).every(entry => entry.content.includes('内容')), true)
  assert.ok(card.book.entries.some(entry => entry.content.includes('<self_check>')))
  assert.ok(card.regexScripts.some(script => script.id === 'cicatavern-event-1'))
})

test('打开游戏规则 turns the card\'s 裁判表 off, and closing them turns it back on', async t => {
  const { forge, store, rulebooks, settled } = await wizard(t, { ...RAW, judge: JUDGE })
  let draft = await settled((await forge.create({ text: '卡', options: { bricks: ['judge'] } })).id)
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  await forge.write(draft.id)
  draft = await settled(draft.id)
  const { card: { id } } = await forge.saveCard(draft.id, { avatar: PNG })
  const table = async () => (await store.getCard(id)).book.entries.find(entry => entry.content.includes('<judge_rules>'))
  assert.equal((await table()).enabled, true)
  await rulebooks.change(id, { level: 'light' })
  assert.equal((await table()).enabled, false)
  await rulebooks.change(id, { difficulty: 'hard' })
  assert.equal((await table()).enabled, false)
  await rulebooks.change(id, { level: 'off' })
  assert.equal((await table()).enabled, true)
})

test('a table someone turned off stays off while the rules stay off', async t => {
  const { forge, store, rulebooks, settled } = await wizard(t, { ...RAW, judge: JUDGE })
  let draft = await settled((await forge.create({ text: '卡', options: { bricks: ['judge'] } })).id)
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  await forge.write(draft.id)
  draft = await settled(draft.id)
  const { card: { id } } = await forge.saveCard(draft.id, { avatar: PNG })
  const card = await store.getCard(id)
  card.book.entries.find(entry => entry.content.includes('<judge_rules>')).enabled = false
  await store.saveCard(card)
  await rulebooks.change(id, { difficulty: 'hard' })
  assert.equal((await store.getCard(id)).book.entries.find(entry => entry.content.includes('<judge_rules>')).enabled, false)
})

test('a plan with bricks or a scale gets room for the thinking it takes; a plain card keeps its cap', () => {
  const cap = options => planRequest([], emptyBrief(), {}, { options }).maxTokens
  assert.equal(cap({ play: ['bond'] }), 32000)
  assert.equal(cap({ bricks: ['selfcheck'] }), 64000)
  assert.equal(cap({ scale: 'standard' }), 64000)
  assert.equal(reviseRequest([], {}, { text: '改' }, { options: { bricks: ['events'] } }).maxTokens, 64000)
})

test('the plan is told how the die works, so a judge table does not make up its own', () => {
  const plan = planRequest([], emptyBrief(), {}, { options: cleanCardOptions({ bricks: ['judge'] }) }).system
  assert.match(plan, /一次 1 到 20，只在差距为 0 时看/)
  assert.match(plan, /不写点数、门槛、加值和掷法/)
})

test('不看运气 reaches the plan too: a table that says 看骰子 on a card with no die reads wrong', () => {
  const plan = dice => planRequest([], emptyBrief(), {}, { options: cleanCardOptions({ bricks: ['judge'], judgeDice: dice }) }).system
  assert.match(plan('off'), /dice 写 false：这张卡不看运气/)
  assert.doesNotMatch(plan('off'), /骰子由程序掷/)
  assert.match(plan('on'), /dice 写 true。骰子由程序掷/)
})

test('a variable with the way it shows as its type keeps being a number or a list', () => {
  const [meter, tags, odd] = cleanVariables([
    { path: '主角.关防', type: 'meter', initial: '40', range: '0~100', show: 'meter' },
    { path: '主角.谍报', type: 'tags', initial: ['南营添了马铠'], show: 'tags' },
    { path: '主角.心情', type: 'mood', initial: '好' },
  ])
  assert.equal(meter.type, 'number')
  assert.equal(meter.show, 'meter')
  assert.equal(tags.type, 'list')
  assert.equal(odd.type, 'string')
})

test('a list written as JSON in a string starts with its items, not with one odd item', () => {
  const start = initial => typedValue(cleanVariables([{ path: '主角.已到地点', type: 'tags', show: 'tags', initial }])[0])
  assert.deepEqual(start('["白矾镇","后山"]'), ['白矾镇', '后山'])
  assert.deepEqual(start('白矾镇、后山'), ['白矾镇', '后山'])
  assert.deepEqual(start('[旧矿'), ['[旧矿'])
})

test('a book that lists the row name as a column loses the column no row fills', () => {
  const book = (columns, initial) => cleanVariables([{ path: '主角.人情册', type: 'book', columns, initial }])[0]
  const named = book(['谁', '欠什么', '几时还'], [{ name: '沈栖梧', 欠什么: '两百石粮', 几时还: '秋后' }])
  assert.deepEqual(named.columns, ['欠什么', '几时还'])
  assert.equal(named.initial, '沈栖梧|两百石粮|秋后')
  assert.deepEqual(book(['欠什么', '几时还'], [{ name: '沈栖梧', 欠什么: '粮' }]).columns, ['欠什么', '几时还'])
  assert.deepEqual(book(['欠什么', '几时还'], []).columns, ['欠什么', '几时还'])
})

test('the judge table numbers its ranks, so the model subtracts instead of counting steps', () => {
  const judge = { measure: '厨艺', ranks: ['只会泡面', '能煮熟', '家常小炒', '能下一碗面', '能掌勺'], gaps: [{ gap: 0, result: '平' }, { gap: 1, result: '输' }], known: [{ name: '许南枝', rank: '能掌勺' }], dice: false }
  const text = brickContent('judge', { judge }, false)
  assert.match(text, /1 只会泡面、2 能煮熟、3 家常小炒、4 能下一碗面、5 能掌勺/)
  assert.match(text, /许南枝 能掌勺（5）/)
  assert.match(text, /序号相减/)
  assert.match(brickContent('judge', { judge }, true), /许南枝 能掌勺 \(5\)/)
})

test('the status bar finds MVU from a frame Tavern Helper did not set up', () => {
  const html = statusBarHtml({ title: '账', fields: [] })
  assert.match(html, /parent\.Mvu/)
  assert.match(html, /closest\('\.mes'\)/)
})

test('a list can grow in SillyTavern: its starting value carries MVU\'s mark, and the mark stays out of sight', () => {
  const plan = { tracking: { enabled: true, variables: [{ path: '主角.去过', type: 'list', initial: '灰梁镇、井口' }, { path: '主角.线索', type: 'list', initial: '' }] } }
  const state = initialState(plan)
  assert.deepEqual(state.主角.去过, ['灰梁镇', '井口', '$__META_EXTENSIBLE__$'])
  assert.deepEqual(state.主角.线索, ['$__META_EXTENSIBLE__$'])
  assert.equal(replaceVariableMacros('{{get_message_variable::stat_data.主角.去过}}', state), '["灰梁镇","井口"]')
  assert.equal(replaceVariableMacros('{{format_message_variable::stat_data.主角.线索}}', state).includes('META'), false)
})

// ─── Older cards on the way to SillyTavern ───────────────────────────────

const OLD_BAR = ['```html', '<div class="bar" id="bar"></div>', '<style>body{margin:0}</style>', `<script>const SPEC={"title":"账","fields":[]};
async function load(){
  try{if(typeof waitGlobalInitialized==='function')await waitGlobalInitialized('Mvu')}catch(e){}
  try{const data=Mvu.getMvuData({type:'message',message_id:getCurrentMessageId()});draw((data&&data.stat_data)||{})}catch(e){draw({})}
}
load();</script>`, '```'].join('\n')
const oldCard = more => ({
  creator: 'CicaTavern',
  regexScripts: [{ id: 'cicatavern-status-bar', replaceString: OLD_BAR }, { id: 'card-own', replaceString: '```html\n<div>own</div>\n```' }],
  firstMes: '开场',
  alternateGreetings: ['第二个开场\n\n<UpdateVariable>\n<initvar>\n主角:\n  去过:\n    - 灰梁镇\n</initvar>\n</UpdateVariable>'],
  book: { entries: [{ uid: '0', comment: '[InitVar]请勿打开', content: '主角:\n  去过:\n    - 灰梁镇\n  灯油: 10\n  册子:\n    $meta:\n      extensible: true\n', initvar: true }, { uid: '1', comment: '世界', content: '- 这只是一段设定' }] },
  ...more,
})

test('an older card leaves for SillyTavern with a bar it can show, and what is kept here does not change', () => {
  const card = oldCard()
  const before = JSON.stringify(card)
  const out = forSillyTavern(card)
  const bar = out.regexScripts[0].replaceString
  assert.match(bar, /^```html\n<!DOCTYPE html>\n<html><body>\n<div class="bar"/)
  assert.match(bar, /const SPEC=\{"title":"账"/)
  assert.match(bar, /parent\.Mvu/)
  assert.doesNotMatch(bar, /message_id:getCurrentMessageId\(\)\}\)/)
  assert.equal(out.regexScripts[1].replaceString, card.regexScripts[1].replaceString)
  assert.equal(JSON.stringify(card), before)
})

test('a bar someone edited keeps the edits, a new bar is left alone, and doing it twice changes nothing', () => {
  const edited = OLD_BAR.replace("draw((data&&data.stat_data)||{})}catch(e){draw({})}", "myDraw(data)}catch(e){}")
  const out = forSillyTavern(oldCard({ regexScripts: [{ id: 'cicatavern-status-bar', replaceString: edited }] })).regexScripts[0].replaceString
  assert.match(out, /myDraw\(data\)/)
  assert.match(out, /<body>/)
  const fresh = statusBarHtml({ title: '账', fields: [] })
  assert.equal(forSillyTavern(oldCard({ regexScripts: [{ id: 'cicatavern-status-bar', replaceString: fresh }] })).regexScripts[0].replaceString, fresh)
  const once = forSillyTavern(oldCard())
  assert.deepEqual(forSillyTavern(once), once)
})

test('lists of a card made here can grow once exported; a card made elsewhere keeps its own', () => {
  const out = forSillyTavern(oldCard())
  assert.deepEqual(YAML.parse(out.book.entries[0].content).主角.去过, ['灰梁镇', '$__META_EXTENSIBLE__$'])
  assert.deepEqual(YAML.parse(out.book.entries[0].content).主角.册子.$meta, { extensible: true })
  assert.equal(out.book.entries[1].content, '- 这只是一段设定')
  assert.match(out.alternateGreetings[0], /- \$__META_EXTENSIBLE__\$/)
  assert.equal(out.firstMes, '开场')
  const other = forSillyTavern(oldCard({ creator: '别人' }))
  assert.equal(other.book.entries[0].content, oldCard().book.entries[0].content)
  const byHelper = forSillyTavern(oldCard({ creator: '改过的名字' }), { data: { extensions: { tavern_helper: { scripts: [{ id: MVU_HELPER_ID }] } } } })
  assert.match(byHelper.book.entries[0].content, /META_EXTENSIBLE/)
})

// ─── 世界动态 ─────────────────────────────────────────────

const withWorld = more => ({ ...more, world_moves: { rate: 'often', lines: [{ name: '北境战事', stages: ['边境摩擦', '增兵', '开战'] }, { name: '粮价', stages: ['平稳', '上涨', '饥荒'] }] } })

test('世界动态 tells the planner what to write, and the talk what to ask, only when picked', () => {
  const plan = options => planRequest([], emptyBrief(), {}, { options }).system
  assert.match(plan(cleanCardOptions({ bricks: ['world'] })), /world_moves/)
  assert.doesNotMatch(plan(cleanCardOptions({})), /world_moves/)
  assert.match(discussRequest([], emptyBrief(), { card: '简体中文', reply: '简体中文' }, { options: cleanCardOptions({ bricks: ['world'] }) }).system, /世界自己在动/)
})

test('a plan keeps the lines it can use: named, with steps to go through, each name usable in a path', () => {
  const moves = cleanWorld({ rate: 'wild', lines: [{ name: '北.境 战事', stages: ['甲', '乙'] }, { name: '只有一步', stages: ['甲'] }, { name: '', stages: ['甲', '乙'] }, { name: '北境战事', stages: ['丙', '丁'] }] })
  assert.equal(moves.rate, 'normal')
  assert.deepEqual(moves.lines.map(line => line.name), ['北境战事'])
  assert.equal(cleanWorld(null), null)
})

test('the rule names each line and its variable, and everything that voids it', () => {
  const text = brickContent('world', withWorld(), false)
  assert.match(text, /北境战事（变量 世界\.北境战事）：边境摩擦 → 增兵 → 开战/)
  assert.match(text, /\[WORLD_MOVE\]/)
  assert.match(text, /抽到「无」：这条作废/)
  assert.match(text, /最后一步：这条作废/)
  assert.match(brickContent('world', withWorld(), true), /World\.北境战事/)
})

test('the code draws what moves: about one turn in the rate, on the worldbook placement', () => {
  const script = brickScripts(withWorld(), false).find(item => item.id === 'cicatavern-world-move')
  assert.deepEqual(script.placement, [5])
  assert.equal(script.promptOnly, true)
  const items = script.replaceString.replace(/^\{\{random::|\}\}$/g, '').split('::')
  assert.equal(items.length, 6)
  assert.equal(items.filter(item => item === '无').length, 4)
})

test('each line gets a variable on its first step, on a page of its own when the bar has pages', () => {
  const raw = { name: '卡', user_role: { identity: '领主' }, characters: [{ name: '她', kind: 'core' }], world_moves: withWorld().world_moves }
  const read = (options, plan = raw) => withCardOptions(normalizePlan(plan), cleanCardOptions(options))
  const plan = read({ bricks: ['world'], worldRate: 'rare', statusPages: true, format: 'mvu-ui' })
  assert.equal(plan.world_moves.rate, 'rare')
  assert.equal(plan.tracking.enabled, true)
  const line = plan.tracking.variables.find(v => v.path === '世界.北境战事')
  assert.equal(line.initial, '边境摩擦')
  assert.equal(line.show, 'badge')
  assert.equal(line.page, '世界')
  assert.ok(plan.entries.some(entry => entry.part === 'world'))
  assert.equal(read({}).world_moves, undefined)
})
