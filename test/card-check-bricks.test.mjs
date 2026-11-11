// 角色卡自检 on what 创作角色卡's 高级选项 put in a card: 玩法积木 (a rule and the regex that answers to it), 册子 and lists
// that have to grow, and a status bar's colors and pages. The cards are made by the code that makes them for real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import YAML from 'yaml'
import { normalizeCard } from '../server/cards.mjs'
import { eventDraw, readDraw } from '../server/forge/bricks.mjs'
import { applyFinding, changedPieces, restorePieces, snapshot, staleChange, withEdits } from '../server/forge/check-apply.mjs'
import { checkRequest, readCheck, vetSuggestions } from '../server/forge/check-model.mjs'
import { cardFacts, checkCard, statusLines } from '../server/forge/check.mjs'
import { creationOf, randomSheet } from '../server/forge/creation.mjs'
import { cleanCardOptions, normalizePlan, withCardOptions } from '../server/forge/prompts.mjs'
import { OWN_STATUS_SCRIPT } from '../server/forge/status.mjs'
import { cardJson, newCard } from '../server/forge/write.mjs'
import { helperScriptsOf } from '../server/schema.mjs'
import { initTemplates } from '../server/template.mjs'
import { PLACEMENT, applyScripts } from '../web/shared/regex.js'
import { EVENT_RATES } from '../web/shared/status.js'

await initTemplates()

const PLAN = {
  name: '春日便当',
  summary: '同桌每天多带一份便当。',
  user_role: { identity: '转学生' },
  world: { kind: '真实', overview: '海边小城的高中', places: [{ name: '天台', description: '午休去的地方' }] },
  characters: [{ name: '林小满', kind: 'core', aliases: ['小满'], gender: '女', identity: '同桌', relationship: '每天给你带便当', personality: { base: '嘴硬', main: ['认真'] } }],
  style: { perspective: '第二人称' },
  tracking: { enabled: true, variables: [
    { path: '林小满.好感度', label: '好感', type: 'number', initial: '20', range: '0~100', check: '真心相待时 +2' },
    { path: '主角.回忆', label: '回忆', type: 'book', show: 'table', columns: ['日子', '心情'], initial: [{ name: '第一份便当', 日子: 1, 心情: '紧张' }], check: '一起吃饭时加一行' },
    { path: '主角.去过', label: '去过', type: 'list', initial: '天台、车站', check: '去了新地方时加一项' },
  ] },
  greetings: [{ title: '午休', scene: '天台', situation: '她把便当推过来', state: {} }, { title: '放学', scene: '车站', situation: '她在等车', state: { '林小满.好感度': '30' } }],
  avatar: { character: '林小满' },
  selfcheck: ['她嘴硬的时候有没有直接说喜欢？', '便当的菜色和前文对得上吗？'],
  random_events: { rate: 'rare', groups: [{ when: '在学校', items: ['班主任突然点名', '隔壁班的人来借东西'] }, { when: '放学路上', items: ['下起了雨', '老同学打来电话', '猫挡在路中间'] }] },
  judge: { measure: '关系', when: '<user> 想让她做超出现在关系的事时', ranks: ['同学', '朋友', '恋人'], rank_path: '主角.关系', gaps: [{ gap: 0, result: '她半推半就' }, { gap: 1, result: '她笑着躲开' }, { gap: 2, result: '她翻脸走人' }], known: [{ name: '牵手', rank: '朋友' }] },
}
const EVERY_BRICK = { format: 'mvu-ui', bricks: ['books', 'selfcheck', 'events', 'judge'] }
const COLORS = { bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' }
const planWith = (options = EVERY_BRICK, raw = {}) => withCardOptions(normalizePlan({ ...PLAN, ...raw }), cleanCardOptions(options))

/** A card as 创作角色卡 saves it, with its writing done. */
function madeCard(plan = planWith()) {
  const draft = newCard(plan)
  const written = { ...draft, entries: draft.entries.map(item => ({ ...item, content: item.content || '写好的内容。' })), greetings: draft.greetings.map(item => ({ ...item, text: '她把便当推了过来。' })) }
  const raw = cardJson(plan, written)
  return { card: normalizeCard(raw), helpers: helperScriptsOf(raw.data.extensions) }
}

const plainCard = () => madeCard(planWith({ format: 'mvu-ui' }, { tracking: { enabled: true, variables: PLAN.tracking.variables.filter(variable => variable.type !== 'book') } }))
const rules = found => found.map(item => item.rule).sort()
const brickEntry = (card, tag) => card.book.entries.find(item => item.content.includes(`<${tag}>`))
const brickScript = (card, id) => card.regexScripts.find(item => item.id === id)
const without = (card, ...ids) => ({ ...card, regexScripts: card.regexScripts.filter(item => !ids.includes(item.id)) })
const edited = (card, id, change) => ({ ...card, regexScripts: card.regexScripts.map(item => (item.id === id ? { ...item, ...change } : item)) })
const rewritten = (card, tag, write) => ({ ...card, book: { ...card.book, entries: card.book.entries.map(item => (item.content.includes(`<${tag}>`) ? { ...item, content: write(item.content) } : item)) } })
const turnedOff = (card, tag) => ({ ...card, book: { ...card.book, entries: card.book.entries.map(item => (item.content.includes(`<${tag}>`) ? { ...item, enabled: false } : item)) } })
const dropLine = text => part => part.split('\n').filter(line => !line.includes(text)).join('\n')
const linesGone = (old, now) => old.split('\n').filter(line => !now.split('\n').includes(line)).length

const taken = (card, finding) => {
  const copy = structuredClone(card)
  applyFinding(copy, finding)
  return copy
}

// ─── What the program finds ───────────────────────────────────────────────

test('a card 创作角色卡 made with every brick has nothing to say, and says what it has', () => {
  const { card, helpers } = madeCard()
  assert.deepEqual(checkCard(card, { helpers }), [])
  assert.deepEqual(cardFacts(card, { helpers }).bricks, ['books', 'selfcheck', 'events', 'judge'])
})

test('a card with no bricks has none to report, in the facts or the findings', () => {
  const { card, helpers } = plainCard()
  assert.deepEqual(checkCard(card, { helpers }), [])
  assert.deepEqual(cardFacts(card, { helpers }).bricks, [])
})

test('写前自查: its regex gone is put back as the brick has it', () => {
  const { card, helpers } = madeCard()
  const lost = without(card, 'cicatavern-self-check-prompt', 'cicatavern-self-check-display')
  const found = checkCard(lost, { helpers })
  assert.deepEqual(rules(found), ['self-check-read', 'self-check-shown'])
  assert.ok(found.every(item => !item.risky && !item.manual), 'nothing about how the card plays changes')
  const fixed = found.reduce(taken, lost)
  assert.deepEqual(checkCard(fixed, { helpers }), [])
  const back = fixed.regexScripts.find(item => item.promptOnly && item.findRegex.includes('self_check'))
  assert.equal(back.minDepth, 4)
  assert.deepEqual(back.placement, [2])
})

test('写前自查: a script turned off comes back on, at the depth it needs', () => {
  const { card, helpers } = madeCard()
  const off = edited(card, 'cicatavern-self-check-prompt', { disabled: true, minDepth: null })
  const [found, ...rest] = checkCard(off, { helpers })
  assert.deepEqual([found.rule, found.changes[0].kind, found.changes[0].enabled, found.changes[0].minDepth, rest.length], ['self-check-read', 'regex', true, 4, 0])
  assert.deepEqual(checkCard(taken(off, found), { helpers }), [])
})

test('写前自查: any depth but 4 is found and moved', () => {
  const { card, helpers } = madeCard()
  for (const depth of [null, 2, 6]) {
    const moved = edited(card, 'cicatavern-self-check-prompt', { minDepth: depth })
    const [found, ...rest] = checkCard(moved, { helpers })
    assert.deepEqual([found.rule, found.level, found.risky, rest.length], ['self-check-depth', 'warn', undefined, 0])
    assert.equal(brickScript(taken(moved, found), 'cicatavern-self-check-prompt').minDepth, 4)
  }
})

test('写前自查: a script of the author\'s own counts, a pattern that leaves the text behind does not, and a rule turned off is not looked at', () => {
  const { card, helpers } = madeCard()
  const own = edited(card, 'cicatavern-self-check-prompt', { id: 'mine', findRegex: '/<self_check>[\\s\\S]*?<\\/self_check>/g' })
  assert.deepEqual(checkCard(own, { helpers }), [])
  assert.deepEqual(rules(checkCard(edited(card, 'cicatavern-self-check-display', { findRegex: '/<self_check>/g' }), { helpers })), ['self-check-shown'])
  const lost = without(card, 'cicatavern-self-check-prompt', 'cicatavern-self-check-display')
  assert.deepEqual(checkCard(turnedOff(lost, 'self_check_rules'), { helpers }), [])
})

test('写前自查: a script that works both ways cannot move without showing the block, so it is left to a person', () => {
  const { card, helpers } = madeCard()
  const both = edited(without(card, 'cicatavern-self-check-display'), 'cicatavern-self-check-prompt', { promptOnly: false, markdownOnly: false, minDepth: null })
  const [found, ...rest] = checkCard(both, { helpers })
  assert.deepEqual([found.rule, found.manual, rest.length], ['self-check-depth', true, 0])
})

test('a token with no regex: the die is the code\'s to add, a lost list is for someone to write', () => {
  const { card, helpers } = madeCard()
  const lost = without(card, 'cicatavern-event-2', 'cicatavern-judge-dice')
  const found = checkCard(lost, { helpers })
  assert.deepEqual(rules(found), ['draw-missing', 'draw-missing'])
  assert.ok(found.every(item => item.level === 'error'))
  const dice = found.find(item => item.id === 'draw-missing:JUDGE_DICE')
  assert.equal(dice.manual, undefined)
  assert.deepEqual([dice.changes[0].replace, dice.changes[0].effect, dice.changes[0].world], ['{{roll:1d20}}', 'prompt', true])
  const list = found.find(item => item.id === 'draw-missing:RANDOM_EVENT_2')
  assert.equal(list.manual, true)
  assert.throws(() => withEdits(lost, list, {}), /还没有改动/)
  assert.throws(() => withEdits(lost, list, { [list.changes[0].id]: { replace: '  ' } }), /还没有改动/)
  const written = withEdits(lost, list, { [list.changes[0].id]: { replace: '{{random::下雨::无}}' } })
  const fixed = taken(taken(lost, written), dice)
  assert.deepEqual(checkCard(fixed, { helpers }), [])
  const script = fixed.regexScripts.find(item => item.findRegex.includes('RANDOM_EVENT_2'))
  assert.deepEqual([script.placement, script.promptOnly, script.markdownOnly, script.replaceString], [[5], true, false, '{{random::下雨::无}}'])
})

test('a draw that does not answer to its token is put right, its list kept', () => {
  const { card, helpers } = madeCard()
  const id = 'cicatavern-event-1'
  const broken = {
    'turned off': { disabled: true },
    'only on display': { promptOnly: false, markdownOnly: true },
    'on the reply': { placement: [2] },
    'not escaped': { findRegex: '/[RANDOM_EVENT_1]/g' },
  }
  for (const [label, change] of Object.entries(broken)) {
    const moved = edited(card, id, change)
    const [found, ...rest] = checkCard(moved, { helpers })
    assert.deepEqual([found?.rule, found?.manual, rest.length], ['draw-missing', undefined, 0], label)
    const fixed = taken(moved, found)
    assert.deepEqual(checkCard(fixed, { helpers }), [], label)
    assert.equal(brickScript(fixed, id).replaceString, brickScript(card, id).replaceString, label)
  }
})

test('a draw with nothing to come up with: the die gets its roll back, a list waits for someone to write it', () => {
  const { card, helpers } = madeCard()
  const [list] = checkCard(edited(card, 'cicatavern-event-1', { replaceString: '' }), { helpers })
  assert.deepEqual([list.rule, list.manual], ['draw-missing', true])
  const noRoll = edited(card, 'cicatavern-judge-dice', { replaceString: ' ' })
  const [die] = checkCard(noRoll, { helpers })
  assert.equal(die.changes[0].replaceAfter, '{{roll:1d20}}')
  assert.deepEqual(checkCard(taken(noRoll, die), { helpers }), [])
})

test('a draw no rule reads goes back in the rule, if wanted', () => {
  const { card, helpers } = madeCard()
  const dropped = rewritten(card, 'random_event_rules', dropLine('[RANDOM_EVENT_2]'))
  const [found, ...rest] = checkCard(dropped, { helpers })
  assert.deepEqual([found.rule, found.level, found.risky, rest.length], ['draw-unread', 'warn', true, 0])
  assert.match(found.changes[0].after, /第 2 组：\[RANDOM_EVENT_2\]\n- 只看和当前场合/)
  assert.deepEqual(checkCard(taken(dropped, found), { helpers }), [])
  const noDie = rewritten(card, 'judge_rules', dropLine('[JUDGE_DICE]'))
  const [die] = checkCard(noDie, { helpers })
  assert.deepEqual([die.rule, die.risky], ['draw-unread', true])
  assert.equal(brickEntry(taken(noDie, die), 'judge_rules').content, brickEntry(card, 'judge_rules').content)
})

test('token 10 is not token 1, and a table with no die has none to miss', () => {
  const { card, helpers } = madeCard()
  const ten = rewritten(card, 'random_event_rules', text => text.replace('</random_event_rules>', '[RANDOM_EVENT_10]\n</random_event_rules>'))
  assert.deepEqual(checkCard(ten, { helpers }).map(item => item.id), ['draw-missing:RANDOM_EVENT_10'])
  const plain = madeCard(planWith({ ...EVERY_BRICK, judgeDice: 'off' }))
  assert.deepEqual(checkCard(plain.card, { helpers: plain.helpers }), [])
})

test('the one list of a card reads as the only one when it goes back', () => {
  const plan = planWith({ format: 'text', bricks: ['events'] }, { tracking: { enabled: false, variables: [] }, random_events: { rate: 'often', groups: [{ when: '', items: ['下起了雨', '猫挡在路中间'] }] } })
  const { card, helpers } = madeCard(plan)
  assert.deepEqual(checkCard(card, { helpers }), [])
  const dropped = rewritten(card, 'random_event_rules', dropLine('[RANDOM_EVENT_1]'))
  assert.deepEqual(cardFacts(dropped, { helpers }).bricks, ['events'])
  const [found] = checkCard(dropped, { helpers })
  assert.equal(found.changes[0].after, brickEntry(card, 'random_event_rules').content)
})

test('裁判表: ranks without numbers get them, in the words the rule has now', () => {
  const { card, helpers } = madeCard()
  const now = brickEntry(card, 'judge_rules').content
  const old = now
    .replace('等级从低到高：1 同学、2 朋友、3 恋人', '等级从低到高：同学 < 朋友 < 恋人')
    .replace('已知的等级：牵手 朋友（2）', '已知的等级：牵手 朋友')
    .replace('差距是两边等级的序号相减。做的是一件事、不是和人较量时，「对方的等级」就是这件事要求的等级：', '差距按这张表数格子：')
    .replace('对比：<user>的等级（序号）对 对方的等级（序号）', '对比：<user>的等级 对 对方的等级')
  assert.equal(linesGone(old, now), 4, 'every line the old rule had')
  const older = rewritten(card, 'judge_rules', () => old)
  const [found, ...rest] = checkCard(older, { helpers })
  assert.deepEqual([found.rule, found.level, found.risky, rest.length], ['judge-unnumbered', 'warn', undefined, 0])
  assert.equal(found.changes[0].after, now)
  assert.deepEqual(checkCard(taken(older, found), { helpers }), [])
})

test('裁判表: one number left out is found; numbers of another style, or a rule with no such line, are left alone', () => {
  const { card, helpers } = madeCard()
  assert.deepEqual(rules(checkCard(rewritten(card, 'judge_rules', text => text.replace('2 朋友', '朋友')), { helpers })), ['judge-unnumbered'])
  assert.deepEqual(checkCard(rewritten(card, 'judge_rules', text => text.replace('1 同学、2 朋友、3 恋人', '1.同学、2.朋友、3.恋人')), { helpers }), [])
  assert.deepEqual(checkCard(rewritten(card, 'judge_rules', text => text.replace(/^等级从低到高：.*$/m, '等级写在下面的表里')), { helpers }), [])
})

test('裁判表 in English numbers its ranks the same way', () => {
  const plan = withCardOptions(normalizePlan({ ...PLAN, judge: { ...PLAN.judge, ranks: ['Stranger', 'Friend', 'Partner'], known: [{ name: 'Holding hands', rank: 'Friend' }] } }, { language: 'English' }), cleanCardOptions({ format: 'mvu-ui', bricks: ['judge'] }))
  const { card, helpers } = madeCard(plan)
  const now = brickEntry(card, 'judge_rules').content
  const old = now
    .replace('Ranks, low to high: 1 Stranger, 2 Friend, 3 Partner', 'Ranks, low to high: Stranger < Friend < Partner')
    .replace('Known ranks: Holding hands Friend (2)', 'Known ranks: Holding hands Friend')
    .replace('The gap is the two rank numbers subtracted. When what is tried is a feat and not a contest with someone, the other side\'s rank is the rank the feat calls for:', 'Count the steps between the two on that list:')
    .replace('Match: rank of <user> (its number) against the other side (its number)', 'Match: rank of <user> against the other side')
  assert.equal(linesGone(old, now), 4, 'every line the old rule had')
  const found = checkCard(rewritten(card, 'judge_rules', () => old), { helpers }).find(item => item.rule === 'judge-unnumbered')
  assert.equal(found.changes[0].after, now)
})

test('裁判表 turned off by 游戏规则: its scripts stay, and it is not looked at', () => {
  const { card, helpers } = madeCard()
  const off = turnedOff(rewritten(card, 'judge_rules', text => text.replace('1 同学、2 朋友、3 恋人', '同学 < 朋友 < 恋人')), 'judge_rules')
  assert.deepEqual(checkCard(off, { helpers }), [])
  assert.deepEqual(checkCard(without(off, 'cicatavern-judge-dice', 'cicatavern-judge-prompt', 'cicatavern-judge-display', 'cicatavern-judge-hide'), { helpers }), [])
  assert.ok(!cardFacts(off, { helpers }).bricks.includes('judge'))
})

test('裁判表 with its block regex gone: kept from the model and the player, and the player gets the line back', () => {
  const { card, helpers } = madeCard()
  const lost = without(card, 'cicatavern-judge-prompt', 'cicatavern-judge-display', 'cicatavern-judge-hide')
  const found = checkCard(lost, { helpers })
  assert.deepEqual(rules(found), ['judge-read', 'judge-shown'])
  const fixed = found.reduce(taken, lost)
  assert.deepEqual(checkCard(fixed, { helpers }), [])
  const reply = '<judge>\n对比：同学（1）对 恋人（3）\n差距：2\n结果：她翻脸走人\n</judge>\n她把便当收了回去。'
  assert.equal(applyScripts(reply, fixed.regexScripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0, macros: text => text }), '〔判定：她翻脸走人〕\n\n她把便当收了回去。')
  assert.equal(applyScripts(reply, fixed.regexScripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: 1, macros: text => text }), '她把便当收了回去。')
})

const unmarked = text => text.replace(/\n\s*- \$__META_EXTENSIBLE__\$/g, '').replace(/\n\s*\$meta:\n\s*extensible: true/g, '')

test('册子 and lists of a card made here that cannot grow are marked, in the entry and in an opening of its own', () => {
  const { card, helpers } = madeCard()
  const older = {
    ...card,
    alternateGreetings: card.alternateGreetings.map(unmarked),
    book: { ...card.book, entries: card.book.entries.map(item => ({ ...item, content: unmarked(item.content) })) },
  }
  const [found, ...rest] = checkCard(older, { helpers })
  assert.deepEqual([found.rule, found.level, rest.length], ['extensible', 'warn', 0])
  assert.match(found.title, /主角\.回忆/)
  assert.match(found.title, /主角\.去过/)
  assert.deepEqual(found.changes.map(change => change.kind), ['entry', 'greeting'])
  const fixed = taken(older, found)
  assert.deepEqual(checkCard(fixed, { helpers }), [])
  const state = YAML.parse(fixed.book.entries.find(item => item.content.includes('第一份便当') && !item.content.includes('<')).content)
  assert.deepEqual(state.主角.回忆.$meta, { extensible: true })
  assert.ok(state.主角.去过.includes('$__META_EXTENSIBLE__$'))
  assert.match(fixed.alternateGreetings[0], /\$__META_EXTENSIBLE__\$/)
})

test('a list on someone else\'s card is theirs: only what its rules add to has to grow', () => {
  const { card, helpers } = madeCard()
  const other = { ...card, creator: '别人', book: { ...card.book, entries: card.book.entries.map(item => ({ ...item, content: item.content.replace(/\n\s*- \$__META_EXTENSIBLE__\$/g, '') })) } }
  assert.deepEqual(checkCard(other, { helpers: helpers.map(item => ({ ...item, id: 'someone-elses' })) }), [])
})

test('a card made here is checked when its helper could not be read: it has no schema to wait for', () => {
  const { card } = madeCard()
  assert.ok(card.helperScripts > 0)
  assert.equal(cardFacts(card).schema, false)
  const older = { ...card, book: { ...card.book, entries: card.book.entries.map(item => ({ ...item, content: unmarked(item.content) })) } }
  assert.deepEqual(rules(checkCard(older)), ['extensible'])
})

// ─── The status bar's look ────────────────────────────────────────────────

const pagedCard = () => {
  const { card, helpers } = madeCard(planWith({ ...EVERY_BRICK, statusPages: true, statusTheme: 'auto' }, { status_colors: COLORS }))
  return { helpers, card: { ...card, statusBar: { ...card.statusBar, fields: card.statusBar.fields.map((field, i) => ({ ...field, page: i ? '册子' : '她' })) } } }
}
const withLostField = card => ({ ...card, statusBar: { ...card.statusBar, fields: [...card.statusBar.fields, { path: '林小满.心情', label: '心情', show: 'text', page: '她' }] } })

test('a change reads out the colors and the pages', () => {
  const { card } = pagedCard()
  const lines = statusLines(card.statusBar)
  assert.match(lines, /配色: 背景 #101820 · 文字 #f2f2f2 · 强调 #e0a030/)
  assert.match(lines, /好感 \(林小满\.好感度\): meter · 页: 她/)
  assert.match(statusLines({ ...card.statusBar, palette: undefined, theme: 'gothic' }), /主题: 暗夜/)
})

test('a fix to the fields leaves the look; written over, it reaches both bars and comes back on undo', () => {
  const { card, helpers } = pagedCard()
  const lost = withLostField(card)
  const [found] = checkCard(lost, { helpers })
  assert.equal(found.rule, 'status-path-missing')
  assert.deepEqual(found.changes[0].spec.palette, COLORS)
  assert.equal(found.changes[0].spec.fields[0].page, '她')

  const palette = { bg: '#000000', ink: '#ffffff', accent: '#ff00ff' }
  const spec = { ...found.changes[0].spec, palette, fields: found.changes[0].spec.fields.map(field => ({ ...field, page: '全部' })) }
  const next = withEdits(lost, found, { statusBar: { spec } })
  assert.match(next.changes[0].after, /配色: 背景 #000000/)
  assert.match(next.changes[0].after, /页: 全部/)
  const before = snapshot(lost)
  const copy = structuredClone(lost)
  applyFinding(copy, next)
  assert.deepEqual(copy.statusBar.palette, palette)
  assert.ok(copy.statusBar.fields.every(field => field.page === '全部'))
  const bar = copy.regexScripts.find(item => item.id === OWN_STATUS_SCRIPT).replaceString
  assert.match(bar, /--bg:#000000/)
  assert.match(bar, /"page":"全部"/)
  restorePieces(copy, changedPieces(before, copy))
  assert.deepEqual(copy.statusBar, lost.statusBar)
  assert.deepEqual(copy.regexScripts, lost.regexScripts)
})

test('a field that lost its variable is not sent to a cell of a book: rows come and go', () => {
  const { card, helpers } = pagedCard()
  const [found] = checkCard(withLostField(card), { helpers })
  assert.ok(!found.changes[0].spec.fields.some(field => field.path.includes('第一份便当')))
  assert.deepEqual(found.changes[0].spec.fields.map(field => field.path), card.statusBar.fields.map(field => field.path))
})

test('a change goes out of date when only the colors or the pages moved', () => {
  const { card, helpers } = pagedCard()
  const lost = withLostField(card)
  const [{ changes: [change] }] = checkCard(lost, { helpers })
  assert.equal(staleChange(lost, change), false)
  assert.equal(staleChange({ ...lost, statusBar: { ...lost.statusBar, palette: { ...COLORS, accent: '#ff00ff' } } }, change), true)
  assert.equal(staleChange({ ...lost, statusBar: { ...lost.statusBar, fields: lost.statusBar.fields.map(field => ({ ...field, page: '别的' })) } }, change), true)
})

test('a look picked by hand takes the other one\'s place, and text out of reach of its background is put right', () => {
  const { card, helpers } = madeCard(planWith({ ...EVERY_BRICK, statusTheme: 'gothic' }))
  const lost = withLostField(card)
  const [found] = checkCard(lost, { helpers })
  const { theme, ...own } = found.changes[0].spec
  assert.equal(theme, 'gothic')
  const next = withEdits(lost, found, { statusBar: { spec: { ...own, palette: { bg: '#ffffff', ink: '#f0f0f0', accent: '#2b5869' } } } })
  assert.equal(next.changes[0].spec.palette.ink, '#1c1c1c')
  assert.equal(next.changes[0].spec.theme, undefined)
  assert.doesNotMatch(next.changes[0].after, /主题/)
})

// ─── What the model is told, and what it writes ───────────────────────────

test('the model is told of the bricks only on a card that has them, and sees what it can change', () => {
  const { card } = madeCard()
  const { request } = checkRequest(card, [])
  assert.match(request.system, /\[RANDOM_EVENT_1\]、\[JUDGE_DICE\] 这样的占位符原样保留/)
  assert.match(request.system, /<events group="1" rate="normal">/)
  const sent = request.messages[0].content
  assert.match(sent, /写前自查：uid=/)
  assert.match(sent, /裁判表：uid=/)
  assert.match(sent, /册子：主角\.回忆/)
  assert.match(sent, /<events group="2" rate="rare">\n下起了雨\n老同学打来电话\n猫挡在路中间\n<\/events>/)
  assert.match(sent, /随机事件的名单，见 <bricks>/)
  assert.doesNotMatch(sent, /\{\{random::/)
  const plain = checkRequest(plainCard().card, [])
  assert.doesNotMatch(plain.request.system, /RANDOM_EVENT|<events|<bricks>/)
  assert.doesNotMatch(plain.request.messages[0].content, /<bricks>/)
  assert.match(plain.request.system, /"palette": \{"bg"/)
  assert.match(plain.request.system, /"page": "页名/)
})

test('a {{random}} of the author\'s own is shown as it is: there are no <bricks> to point to', () => {
  const { card } = plainCard()
  const own = { ...card, regexScripts: [...card.regexScripts, { id: 'mine', scriptName: '天气', findRegex: '/\\[天气\\]/g', replaceString: '{{random::晴::雨}}', placement: [2], markdownOnly: true, promptOnly: false, disabled: false, trimStrings: [], substituteRegex: 0, minDepth: null, maxDepth: null }] }
  const sent = checkRequest(own, []).request.messages[0].content
  assert.match(sent, /<replace>\{\{random::晴::雨\}\}<\/replace>/)
  assert.doesNotMatch(sent, /见 <bricks>/)
})

test('a list the model rewrites is drawn by the code at the odds it had; one too short, or of no group, goes no further', () => {
  const { card, helpers } = madeCard()
  const answer = `<reply>名单可以更贴日子。</reply>
<suggestion title="第二组更贴放学路上" level="tip"><why>现在太普通。</why>
<events group="2">
- 同校的学长在站台递来一张传单
- 公交晚点十分钟
</events>
</suggestion>
<suggestion title="改得更常发生" level="tip"><why>太少了。</why><events group="1" rate="often">点名
借东西
走廊撞见班主任</events></suggestion>
<suggestion title="太短了" level="tip"><why>只留一条。</why><events group="1">点名</events></suggestion>
<suggestion title="没有这一组" level="tip"><why>不存在。</why><events group="9">点名
借东西</events></suggestion>`
  const [second, often, short, none] = readCheck(answer, card).suggestions
  assert.equal(second.changes.length, 1)
  assert.equal(second.changes[0].sid, 'cicatavern-event-2')
  assert.equal(second.changes[0].replaceAfter, `{{random::同校的学长在站台递来一张传单::公交晚点十分钟${'::无'.repeat(14)}}}`)
  assert.equal(often.changes[0].replaceAfter, `{{random::点名::借东西::走廊撞见班主任${'::无'.repeat(6)}}}`)
  assert.deepEqual([short.changes, none.changes], [[], []])
  assert.equal(vetSuggestions(card, [second], { helpers })[0].broken, undefined)
  assert.match(brickScript(taken(card, second), 'cicatavern-event-2').replaceString, /公交晚点十分钟/)
})

test('a list the card has lost can be written by the model: it gets its script from the code', () => {
  const { card, helpers } = madeCard()
  const lost = without(card, 'cicatavern-event-2')
  const { suggestions } = readCheck('<reply>补上。</reply><suggestion title="补第二组" level="warn"><why>缺了。</why><events group="2">下雨\n打电话</events></suggestion>', lost)
  const [change] = suggestions[0].changes
  assert.deepEqual([change.kind, change.world, change.effect], ['newRegex', true, 'prompt'])
  assert.deepEqual(checkCard(taken(lost, suggestions[0]), { helpers }), [])
})

test('a suggestion that breaks a brick cannot be taken; one that changes what it holds can', () => {
  const { card, helpers } = madeCard()
  const uid = tag => brickEntry(card, tag).uid
  const answer = `<reply>x</reply>
<suggestion title="去掉占位符" level="tip"><why>x</why><patch target="entry:${uid('random_event_rules')}"><old>[RANDOM_EVENT_1]</old><new>随便来点什么</new></patch></suggestion>
<suggestion title="等级写回去" level="tip"><why>x</why><patch target="entry:${uid('judge_rules')}"><old>1 同学、2 朋友、3 恋人</old><new>同学、朋友、恋人</new></patch></suggestion>
<suggestion title="改一条自查" level="tip"><why>x</why><patch target="entry:${uid('self_check_rules')}"><old>她嘴硬的时候</old><new>她说狠话的时候</new></patch></suggestion>`
  const { suggestions } = readCheck(answer, card, { shown: card.book.entries.map(item => item.uid) })
  const [token, ranks, fine] = vetSuggestions(card, suggestions, { helpers })
  assert.ok(token.broken?.length)
  assert.ok(ranks.broken?.length)
  assert.equal(fine.broken, undefined)
})

test('a status bar from the model: a look and pages go in; what it leaves out stays as the card has it', () => {
  const { card } = pagedCard()
  const field = '{"path": "林小满.好感度", "label": "好感", "show": "rating", "max": 5}'
  const ask = bar => readCheck(`<reply>x</reply><suggestion title="排一下" level="tip"><why>x</why><status_bar>${bar}</status_bar></suggestion>`, card).suggestions[0].changes[0]
  const left = ask(`{"title": "便当", "fields": [${field}]}`)
  assert.deepEqual(left.spec.palette, COLORS)
  assert.equal(left.spec.fields[0].page, '她')
  const own = ask('{"title": "便当", "palette": {"bg": "#000000", "ink": "#ffffff", "accent": "#ff00ff"}, "fields": [{"path": "林小满.好感度", "show": "number", "page": "总览"}]}')
  assert.equal(own.spec.palette.accent, '#ff00ff')
  assert.equal(own.spec.fields[0].page, '总览')
  assert.match(own.after, /配色: 背景 #000000/)
  const themed = ask(`{"theme": "gothic", "fields": [${field}]}`)
  assert.equal(themed.spec.theme, 'gothic')
  assert.equal(themed.spec.palette, undefined, 'a theme asked for shows, not the colors over it')
  const plainly = ask(`{"theme": "plain", "fields": [${field}]}`)
  assert.deepEqual([plainly.spec.theme, plainly.spec.palette], [undefined, undefined])
})

test('what a draw holds reads back as it went in', () => {
  for (const rate of Object.keys(EVENT_RATES)) assert.deepEqual(readDraw(eventDraw(['下雨', '猫'], rate, '无')), { items: ['下雨', '猫'], rate })
  assert.deepEqual(readDraw(eventDraw(['rain', 'a cat'], 'often', 'nothing')), { items: ['rain', 'a cat'], rate: 'often' })
  assert.equal(readDraw('{{roll:1d20}}'), null)
  assert.equal(readDraw('{{random::无::无}}'), null)
  assert.equal(readDraw(''), null)
  assert.equal(readDraw(undefined), null)
})

// 世界动态 and 建角页, which came after the first four.
const NEW_PLAN = {
  ...PLAN,
  world_moves: { rate: 'normal', lines: [{ name: '台风', stages: ['还远', '逼近', '登陆'] }, { name: '文化祭', stages: ['筹备', '排练', '开幕'] }] },
  creation: { intro: '先定几件事。', fields: [{ label: '身份', kind: 'pick', options: ['转学生', '本地人'] }, { label: '来历', kind: 'text' }] },
}
const newBrickCard = () => madeCard(planWith({ format: 'mvu-ui', bricks: ['world', 'creation'] }, NEW_PLAN)).card

test('世界动态 and 建角页 are named, and a card that has them whole has nothing to say about them', () => {
  const card = newBrickCard()
  const { bricks } = cardFacts(card)
  assert.ok(bricks.includes('world') && bricks.includes('creation'), bricks.join())
  const found = rules(checkCard(card))
  assert.ok(!found.some(rule => rule.startsWith('creation-') || rule.startsWith('draw-')), found.join())
})

test('a world draw with no script says so, and is left to write by hand', () => {
  const card = newBrickCard()
  card.regexScripts = card.regexScripts.filter(script => !script.findRegex.includes('WORLD_MOVE'))
  const found = checkCard(card).find(item => item.rule === 'draw-missing')
  assert.equal(found.title, '世界动态抽不出来')
  assert.equal(found.manual, true)
  assert.match(found.why, /\[WORLD_MOVE\]/)
})

test('a world draw the rule no longer reads can be put back', () => {
  const card = newBrickCard()
  const rule = card.book.entries.find(entry => entry.content.includes('<world_move_rules>'))
  rule.content = rule.content.split('\n').filter(line => !line.includes('[WORLD_MOVE]')).join('\n')
  const found = checkCard(card).find(item => item.rule === 'draw-unread')
  assert.equal(found.title, '世界动态抽了也没用上')
  assert.match(found.changes[0].after, /\[WORLD_MOVE\]\n- 抽到「/)
})

test('a form that cannot show, that nothing opens on, or that no rule reads', () => {
  const off = newBrickCard()
  off.regexScripts.find(script => script.findRegex.includes('CreationPage')).disabled = true
  const stopped = checkCard(off).find(item => item.rule === 'creation-page')
  assert.equal(stopped.level, 'error')
  assert.equal(stopped.changes[0].enabled, true)

  const gone = newBrickCard()
  gone.regexScripts = gone.regexScripts.filter(script => !script.findRegex.includes('CreationPage'))
  assert.deepEqual(checkCard(gone).find(item => item.rule === 'creation-page').changes, [])

  const unused = newBrickCard()
  unused.firstMes = '她把便当推过来。'
  unused.alternateGreetings = []
  assert.ok(checkCard(unused).some(item => item.rule === 'creation-unused'))

  const unread = newBrickCard()
  unread.book.entries = unread.book.entries.filter(entry => !entry.keys.includes('【建角】'))
  assert.ok(checkCard(unread).some(item => item.rule === 'creation-rule'))
})

// 世界动态 and 建角页 in 让模型再看看: what the model is shown of them, and what it may change.
const askModel = (card, body) => readCheck(`<reply>x</reply>${body}`, card, { shown: card.book.entries.map(entry => entry.uid) }).suggestions
const suggestion = (title, changes) => `<suggestion title="${title}" level="tip"><why>x</why>${changes}</suggestion>`
const worldRule = card => brickEntry(card, 'world_move_rules')
const creationRule = card => brickEntry(card, 'creation_rules')

test('the model sees 世界动态 and 建角页 in <bricks>, and is told what of them is the code\'s', () => {
  const card = newBrickCard()
  const { request } = checkRequest(card, [])
  const sent = request.messages[0].content
  assert.match(sent, new RegExp(`世界动态：uid=${worldRule(card).uid}，`))
  assert.match(sent, /<world_moves rate="normal">\n台风：还远 → 逼近 → 登陆\n文化祭：筹备 → 排练 → 开幕\n<\/world_moves>/)
  assert.match(sent, new RegExp(`建角页：规则 uid=${creationRule(card).uid}，`))
  assert.match(sent, /<creation>\{"fields":\[\{"label":"身份","kind":"pick","note":"","options":\["转学生","本地人"\]\},\{"label":"来历","kind":"text","note":""\}\]\}<\/creation>/)
  assert.match(sent, /（世界动态抽哪件事，见 <bricks>）/)
  assert.match(sent, /（建角页的表，见 <bricks>）/)
  assert.doesNotMatch(sent, /\{\{random::台风|var SPEC=/)
  assert.match(request.system, /\[WORLD_MOVE\] 和每行开头的「名字（变量 …）：」原样保留/)
  assert.match(request.system, /<CreationPage\/>、规则的关键词 【建角】/)
  assert.match(request.system, /<world_moves rate="normal">/)
  assert.match(request.system, /<creation>\{"fields"/)
  // The first four bricks alone get no word of the two that came after, and the other way round.
  const older = checkRequest(madeCard().card, []).request.system
  assert.doesNotMatch(older, /<world_moves|<creation>|\[WORLD_MOVE\]/)
  assert.doesNotMatch(request.system, /<events group/)
})

test('stages and how often the world moves, as the model writes them: only for what the rule has, from where it starts', () => {
  const card = newBrickCard()
  const [moves] = askModel(card, suggestion('台风走得更细', `<world_moves rate="often">
- 台风：还远 → 进了警戒区 → 逼近 → 登陆
文化祭：开始筹备 → 开幕
地震：没动静 → 来了
</world_moves>`))
  const [rule, draw] = moves.changes
  assert.equal(rule.id, `entry:${worldRule(card).uid}`)
  assert.match(rule.after, /^- 台风（变量 世界\.台风）：还远 → 进了警戒区 → 逼近 → 登陆$/m)
  assert.match(rule.after, /^- 文化祭（变量 世界\.文化祭）：筹备 → 排练 → 开幕$/m, 'a line that starts somewhere else is not taken')
  assert.doesNotMatch(rule.after, /地震/)
  assert.equal(draw.sid, 'cicatavern-world-move')
  assert.equal(draw.replaceAfter, `{{random::台风::文化祭${'::无'.repeat(4)}}}`)
  assert.equal(vetSuggestions(card, [moves])[0].broken, undefined)
  const after = taken(card, moves)
  assert.ok(!rules(checkCard(after)).some(rule => rule.startsWith('draw-')))
  assert.deepEqual(readDraw(brickScript(after, 'cicatavern-world-move').replaceString), { items: ['台风', '文化祭'], rate: 'often' })
  // Nothing it can take: a list just as it is, a name the card does not have.
  assert.deepEqual(askModel(card, suggestion('照旧', '<world_moves>\n台风：还远 → 逼近 → 登陆\n地震：没动静 → 来了\n</world_moves>'))[0].changes, [])
})

test('a form\'s options and notes, as the model writes them: the page is the code\'s, and a name or kind stays', () => {
  const card = newBrickCard()
  const [form] = askModel(card, suggestion('身份多几种', `<creation>{"fields": [
  {"label": "身份", "kind": "text", "options": ["转学生", "本地人", "交换生", "交换生"], "note": "定了就改不了"},
  {"label": "来历", "options": ["不该有"], "note": "一两句，写\${{user}}从哪来"},
  {"label": "不存在", "options": ["甲", "乙"]}
]}</creation>`))
  assert.equal(form.changes.length, 1)
  assert.equal(form.changes[0].sid, 'cicatavern-creation-page')
  assert.equal(vetSuggestions(card, [form])[0].broken, undefined)
  const after = taken(card, form)
  const spec = creationOf(after.regexScripts)
  assert.deepEqual(spec.fields, [
    { label: '身份', kind: 'pick', options: ['转学生', '本地人', '交换生'], note: '定了就改不了' },
    { label: '来历', kind: 'text', options: [], note: '一两句，写   user  从哪来' },
  ])
  assert.equal(spec.mark, '【建角】')
  assert.ok(brickScript(after, 'cicatavern-creation-page').replaceString.startsWith('```html\n<!DOCTYPE html>'))
  assert.ok(!rules(checkCard(after)).some(rule => rule.startsWith('creation-')))
  assert.match(randomSheet(spec, () => 0.99), /^【建角】身份：交换生；来历：/)
  assert.deepEqual(askModel(card, suggestion('照旧', '<creation>{"fields": [{"label": "身份", "options": ["转学生", "本地人"]}]}</creation>'))[0].changes, [])
})

test('a suggestion that breaks 世界动态 or 建角页 cannot be taken; one that changes what they hold can', () => {
  const card = newBrickCard()
  const world = worldRule(card)
  const creation = creationRule(card)
  const answer = [
    suggestion('去掉标签', `<entry uid="${world.uid}">${world.content.replace(/<\/?world_move_rules>\n?/g, '')}</entry>`),
    suggestion('改个名字', `<patch target="entry:${world.uid}"><old>- 台风（变量</old><new>- 飓风（变量</new></patch>`),
    suggestion('抽别的', '<regex id="cicatavern-world-move"><find>/\\[WORLD_MOVE\\]/g</find><replace>{{random::地震::无::无}}</replace></regex>'),
    suggestion('不写变量', `<patch target="entry:${creation.uid}"><old>- 把这些值写进变量：</old><new>- 记住这些：</new></patch>`),
    suggestion('表不要了', '<regex id="cicatavern-creation-page"><find><CreationPage/></find><replace></replace></regex>'),
    suggestion('台风说细点', `<patch target="entry:${world.uid}"><old>逼近 → 登陆</old><new>逼近海岸 → 登陆</new></patch>`),
    suggestion('开场改一句', '<patch target="greeting:1"><old>先定几件事。</old><new>开始之前，先定下你是谁。</new></patch>'),
  ].join('\n')
  const vetted = vetSuggestions(card, askModel(card, answer))
  const broken = vetted.map(item => item.broken ?? [])
  assert.ok(broken[0].includes('世界动态的规则架子被改坏了'), broken[0].join())
  assert.ok(broken[1].includes('世界动态的规则架子被改坏了'), broken[1].join())
  assert.ok(broken[2].includes('世界动态抽的事和规则里的对不上'), broken[2].join())
  assert.ok(broken[3].includes('建角页的规则架子被改坏了'), broken[3].join())
  assert.ok(broken[4].includes('程序写的正则「建角页」被改坏了'), broken[4].join())
  assert.deepEqual(broken.slice(5), [[], []])
})

test('a 世界动态 thing added, or started elsewhere, by a patch or a whole entry cannot be taken', () => {
  const card = newBrickCard()
  const world = worldRule(card)
  const added = '- 地震（变量 世界.地震）：没动静 → 来了'
  const answer = [
    suggestion('台风更远', `<patch target="entry:${world.uid}"><old>还远 → 逼近</old><new>很远 → 逼近</new></patch>`),
    suggestion('加一件', `<patch target="entry:${world.uid}"><old>- 台风（变量</old><new>${added}\n- 台风（变量</new></patch>`),
    suggestion('整条重写', `<entry uid="${world.uid}">${world.content.replace('</world_move_rules>', `${added}\n</world_move_rules>`)}</entry>`),
    suggestion('后面改细', `<entry uid="${world.uid}">${world.content.replace('排练 → 开幕', '排练 → 彩排 → 开幕')}</entry>`),
  ].join('\n')
  const broken = vetSuggestions(card, askModel(card, answer)).map(item => item.broken ?? [])
  const moved = '世界动态加了新的事，或者改了第一步'
  assert.deepEqual(broken, [[moved], [moved], [moved], []])
})

test('a script of the code\'s that was already broken can be put right, but only with what it is for', () => {
  const { card, helpers } = madeCard()
  const fixes = (broken, change) => {
    const [vetted] = vetSuggestions(broken, askModel(broken, suggestion('修好', change)), { helpers })
    return [vetted.broken ?? [], checkCard(taken(broken, vetted), { helpers }).map(item => item.id)]
  }
  // A list lost: the model writes it in <events>, the code draws it.
  const empty = edited(card, 'cicatavern-event-1', { replaceString: '' })
  assert.deepEqual(fixes(empty, '<events group="1" rate="rare">下雨了\n来了个转学生</events>'), [[], []])
  // A token the script no longer answers to: its pattern goes back.
  const nine = edited(card, 'cicatavern-event-1', { findRegex: String.raw`/\[RANDOM_EVENT_9\]/g` })
  assert.deepEqual(rules(checkCard(nine, { helpers })), ['draw-missing', 'draw-unread'])
  assert.deepEqual(fixes(nine, String.raw`<regex id="cicatavern-event-1"><find>/\[RANDOM_EVENT_1\]/g</find></regex>`), [[], []])
  // Something that is no list to draw is still held back.
  assert.deepEqual(fixes(empty, String.raw`<regex id="cicatavern-event-1"><find>/\[RANDOM_EVENT_1\]/g</find><replace>下雨了</replace></regex>`)[0], ['程序写的正则「随机事件抽取 1」被改坏了'])
  // A pattern other than the code's: the finding it had stays the same, so only this says it got worse. One that takes
  // every group's token takes group 2's too, and one over the rule's tags empties the rule.
  const broke = '程序写的正则「随机事件抽取 1」被改坏了'
  assert.deepEqual(fixes(nine, String.raw`<regex id="cicatavern-event-1"><find>/\[RANDOM_EVENT_\d+\]/g</find></regex>`)[0], [broke])
  assert.deepEqual(fixes(empty, String.raw`<regex id="cicatavern-event-1"><find>/<random_event_rules>[\s\S]*?<\/random_event_rules>/g</find></regex>`)[0], [broke])
  assert.deepEqual(fixes(nine, String.raw`<regex id="cicatavern-event-1" enabled="false"><find>/\[RANDOM_EVENT_1\]/g</find></regex>`)[0], [broke])
  // Its list alone may change, broken as it is; a script turned off is still the code's.
  assert.deepEqual(fixes(nine, '<events group="1">下雨了\n来了个转学生</events>')[0], [])
  const off = edited(card, 'cicatavern-event-1', { disabled: true })
  assert.deepEqual(fixes(off, String.raw`<regex id="cicatavern-event-1" enabled="true"><find>/\[RANDOM_EVENT_1\]/g</find></regex>`), [[], []])
  assert.deepEqual(fixes(off, String.raw`<regex id="cicatavern-event-1" enabled="true"><find>/\[RANDOM_EVENT_\d+\]/g</find></regex>`)[0], [broke])

  const world = newBrickCard()
  const still = edited(world, 'cicatavern-world-move', { replaceString: '' })
  const fill = items => String.raw`<regex id="cicatavern-world-move"><find>/\[WORLD_MOVE\]/g</find><replace>{{random::${items}::无::无::无::无}}</replace></regex>`
  assert.deepEqual(fixes(still, fill('台风::文化祭')), [[], []])
  assert.deepEqual(fixes(still, fill('地震'))[0], ['世界动态抽的事和规则里的对不上'])
  // One that works is kept working: its pattern cannot move.
  assert.deepEqual(fixes(world, String.raw`<regex id="cicatavern-world-move"><find>/\[WORLD\]/g</find></regex>`)[0].includes('程序写的正则「世界动向抽取」被改坏了'), true)
})

// ─── Events that happen once ──────────────────────────────────────────────

const EVENTS = [
  { name: '告白', when: '好感很高的时候', requires: { path: '林小满.好感度', op: '>=', value: '80' }, content: '她在天台说出口' },
  { name: '借伞', when: '提到下雨', keywords: ['下雨'], content: '她把伞塞给你' },
]
const ONCE_OLD = '只发生一次：前文已经写过这件事，就把它当作发生过的事，不再重演。'
const eventEntries = card => card.book.entries.filter(item => item.content.includes('<event name='))

/** The card as 创作角色卡 made it before events were kept to once by a list: the reminder in words, no list. */
function beforeTheList(card) {
  const older = text => {
    if (text.includes('<event name=')) {
      return text.split('\n')
        .map(line => (line.startsWith('只发生一次：') ? ONCE_OLD : line.replace(/ && !JSON\.stringify\(.*$/, '')))
        .filter(line => !line.startsWith('@@if !JSON.stringify('))
        .join('\n')
    }
    if (!text.includes('已发生事件:')) return text
    const state = YAML.parse(text)
    if (!state?.已发生事件) return text.split('\n').filter((line, i, all) => !/^ {2}已发生事件:$/.test(line) && !/^ {4}(type: list|check:)$/.test(line) && !/^ {6}- 事件条目里/.test(line)).join('\n')
    delete state.已发生事件
    return YAML.stringify(state, { lineWidth: 0 }).trim()
  }
  const opening = text => text.replace(/\n已发生事件:\n {2}- \$__META_EXTENSIBLE__\$/, '')
  return { ...card, firstMes: opening(card.firstMes), alternateGreetings: card.alternateGreetings.map(opening), book: { ...card.book, entries: card.book.entries.map(item => ({ ...item, content: older(item.content) })) } }
}

test('events kept to once by a list: a card made now has nothing to say about them', () => {
  const { card, helpers } = madeCard(planWith(EVERY_BRICK, { events: EVENTS }))
  assert.equal(eventEntries(card).length, 2)
  assert.ok(eventEntries(card).every(item => item.content.startsWith('@@if ') && item.content.includes('"path": "/已发生事件/-"')))
  assert.deepEqual(checkCard(card, { helpers }), [])
})

test('events told only in words to happen once: a card made here can move to the list, as a choice', () => {
  const { card, helpers } = madeCard(planWith(EVERY_BRICK, { events: EVENTS }))
  const older = beforeTheList(card)
  assert.ok(eventEntries(older).every(item => item.content.includes(ONCE_OLD) && !item.content.includes('已发生事件')))
  const [found, ...rest] = checkCard(older, { helpers })
  assert.deepEqual([found.rule, found.level, found.risky, rest.length], ['event-once', 'tip', true, 0])
  assert.match(found.title, /2 个事件/)
  assert.deepEqual(found.changes.map(change => change.kind), ['entry', 'entry', 'entry', 'greeting'], 'the two events, the starting values, the opening with values of its own')
  const fixed = taken(older, found)
  assert.deepEqual(checkCard(fixed, { helpers }), [])
  // The events come out as a card made now has them; the list starts empty and can grow.
  assert.deepEqual(eventEntries(fixed).map(item => item.content), eventEntries(card).map(item => item.content))
  const init = fixed.book.entries.find(item => item.content.includes('林小满:') && !item.content.includes('<') && !item.content.includes('type:'))
  assert.deepEqual(YAML.parse(init.content).已发生事件, ['$__META_EXTENSIBLE__$'])
  assert.match(fixed.alternateGreetings[0], /<initvar>[\s\S]*已发生事件:\n {2}- \$__META_EXTENSIBLE__\$[\s\S]*<\/initvar>/)
  // Someone else's card, or one with no variables, is left as it is.
  assert.deepEqual(checkCard({ ...older, creator: '别人' }, { helpers: helpers.map(item => ({ ...item, id: 'someone-elses' })) }), [])
  const words = madeCard(planWith({ format: 'text' }, { tracking: { enabled: false, variables: [] }, events: [EVENTS[1]] }))
  assert.ok(eventEntries(words.card)[0].content.includes(ONCE_OLD))
  assert.deepEqual(rules(checkCard(words.card, { helpers: words.helpers })).filter(rule => rule === 'event-once'), [])
})
