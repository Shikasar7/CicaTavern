// 角色卡自检: what the program finds on a card (forge/check.mjs), taking a finding in and back (check-apply.mjs), what
// the model is sent and how its suggestions are read (check-model.mjs), and all of it over HTTP (check-session.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard, sillyTavernCard } from '../server/cards.mjs'
import { initTemplates } from '../server/template.mjs'
import { initialState } from '../server/worldbook.mjs'
import { cardFacts, checkCard } from '../server/forge/check.mjs'
import { applyFinding, changedPieces, restorePieces, snapshot, staleChange, withEdits } from '../server/forge/check-apply.mjs'
import { checkRequest, cleanFocus, readCheck, vetSuggestions } from '../server/forge/check-model.mjs'

await initTemplates()

const entry = (uid, comment, content, more = {}) => ({ uid, comment, content, keys: [], constant: false, enabled: true, ...more })
const script = (id, scriptName, findRegex, replaceString = '', more = {}) => ({ id, scriptName, findRegex, replaceString, placement: [2], markdownOnly: true, ...more })

const rawCard = ({ entries = [], scripts = [], first = '「又下雨了。」', extensions = {}, ...fields } = {}) => ({
  spec: 'chara_card_v3',
  data: {
    name: '林青禾',
    description: '旧城茶馆的掌柜。',
    first_mes: first,
    extensions: { regex_scripts: scripts, ...extensions },
    ...(entries.length ? { character_book: { entries } } : {}),
    ...fields,
  },
})
const cardOf = options => normalizeCard(rawCard(options))
const rules = (found, level = null) => found.filter(item => !level || item.level === level).map(item => item.rule).sort()
const one = (found, rule) => found.find(item => item.rule === rule)

// A card with variables and everything in its place.
const INIT = entry(0, '[initvar]初始变量', '好感度: 10\n背包:\n  $meta:\n    extensible: true\n  木剑:\n    数量: 1\n')
const RULE = entry(1, '变量更新规则', '每轮末尾写 <UpdateVariable>，用 _.set(\'好感度\', 10, 12);//原因', { constant: true })
const HIDE = script('hide', '隐藏变量', '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/g')
const BAR = script('bar', '状态栏', '<StatusPlaceHolderImpl/>', '<div>状态</div>')

test('MVU marks stay in the entry, out of the variables', () => {
  const state = initialState([{ entries: [entry(0, '[initvar]', '背包:\n  $meta:\n    extensible: true\n  木剑: 1\n任务:\n  - 找到师父\n  - $__META_EXTENSIBLE__$\n名册:\n  - 青禾\n  - { $arrayMeta: true, extensible: true }\n', { initvar: true })] }])
  assert.deepEqual(state, { 背包: { 木剑: 1 }, 任务: ['找到师父'], 名册: ['青禾'] })
})

test('a card with nothing wrong has nothing to say', () => {
  assert.deepEqual(checkCard(cardOf()), [])
  assert.deepEqual(checkCard(cardOf({ entries: [INIT, RULE], scripts: [HIDE, BAR] })), [])
})

test('keywords: joined ones split, single characters, patterns that do not compile', () => {
  const found = checkCard(cardOf({ entries: [
    entry(0, '化形', '妖兽化形的规矩。', { keys: ['化形、妖兽化形', '化形大妖'] }),
    entry(1, '茶', '茶的讲究。', { keys: ['茶', '喝茶'] }),
    entry(2, '水', '水的讲究。', { keys: ['水'] }),
    entry(3, '暗号', '接头暗号。', { keys: ['/(未闭合/'] }),
    entry(4, '正常', '可以用逗号的正则。', { keys: ['/(甲|乙)、丙/'] }),
  ] }))
  assert.deepEqual(rules(found), ['key-invalid', 'key-joined', 'key-single', 'key-single'])
  const joined = one(found, 'key-joined')
  assert.equal(joined.level, 'error')
  assert.deepEqual(joined.changes[0].keys, ['化形', '妖兽化形', '化形大妖'])
  assert.equal(joined.risky, undefined, 'a keyword that never fired is safe to fix')
  const [tea, water] = found.filter(item => item.rule === 'key-single')
  assert.deepEqual([tea.risky, tea.changes[0].keys], [true, ['喝茶']])
  assert.deepEqual([water.manual, water.changes[0].keys], [true, undefined], 'no keyword would be left, so a person picks one')
})

test('entries: never sent, empty, a template that does not compile', () => {
  const found = checkCard(cardOf({ entries: [
    entry(0, '老周', '码头的船夫。'),
    entry(1, '【说明】这是很长的条目名：不适合当关键词', '说明。'),
    entry(2, '南千夏', '被别的条目读的。'),
    entry(3, '读取', '<%= await getwi("南千夏") %>', { constant: true }),
    entry(4, '空的', ''),
    entry(5, '-----', ''),
    entry(6, '坏模板', '<% if (a { %>', { constant: true }),
    entry(7, '关着的', '', { enabled: false }),
  ] }))
  assert.deepEqual(rules(found), ['entry-empty', 'entry-unreachable', 'entry-unreachable', 'template-syntax'])
  const [named, long] = found.filter(item => item.rule === 'entry-unreachable')
  assert.deepEqual(named.changes[0].keys, ['老周'], 'a short name can be its keyword')
  assert.equal(long.manual, true)
  assert.equal(one(found, 'entry-empty').changes[0].kind, 'removeEntry')
  assert.equal(one(found, 'entry-empty').risky, true)
  assert.equal(one(found, 'template-syntax').manual, true)
})

test('regex: one that does not compile, a group that is not there; plain text patterns are fine', () => {
  const found = checkCard(cardOf({ scripts: [
    script('a', '坏的', '/(/g'),
    script('b', '多一组', '/(甲)/g', '$1和$2'),
    script('c', '纯文字', '<StatusPlaceHolderImpl/>', '<div></div>'),
    script('d', '关着的坏的', '/(/g', '', { disabled: true }),
    script('e', '脚本里的钱', '/(甲)/g', '<script>const price = "$9"</script>'),
  ] }))
  assert.deepEqual(rules(found), ['regex-group', 'regex-invalid'])
  assert.equal(one(found, 'regex-invalid').level, 'error')
  assert.equal(one(found, 'regex-invalid').manual, true)
})

test('openings: none at all, a block left open, broken macros', () => {
  assert.deepEqual(rules(checkCard(cardOf({ first: '' }))), ['no-greeting'])
  const found = checkCard(cardOf({ first: '{{char}看着{user}}。\n<UpdateVariable>\n_.set(\'a\', 1, 2);', description: '{{user} 的朋友。' }))
  assert.deepEqual(rules(found), ['greeting-unclosed', 'macro-broken', 'macro-broken'])
  const macro = found.find(item => item.id === 'macro-broken:greeting-0')
  assert.match(macro.changes[0].after, /^\{\{char\}\}看着\{\{user\}\}。/)
  assert.match(one(found, 'greeting-unclosed').changes[0].after, /<\/UpdateVariable>$/)
  assert.deepEqual(checkCard(cardOf({ first: '<% if (x) { %>{user}}<% } %>' })).filter(item => item.rule === 'macro-broken'), [], 'inside a template a brace is code')
})

test('variables: broken, rules without initial ones, the other way round, a path that is not there', () => {
  const broken = checkCard(cardOf({ entries: [entry(0, '[initvar]', '好感度: [1, 2\n  错: :'), RULE] }))
  assert.equal(one(broken, 'initvar-broken').level, 'error')
  assert.deepEqual(rules(checkCard(cardOf({ entries: [RULE], scripts: [HIDE] }))), ['rules-no-initvar'])

  const norules = checkCard(cardOf({ entries: [entry(0, '[initvar]', '好感度: 10\n心情: 平静\n')], scripts: [BAR] }))
  assert.deepEqual(rules(norules), ['initvar-no-rules'])
  const frame = one(norules, 'initvar-no-rules')
  assert.equal(frame.risky, true)
  assert.match(frame.changes[0].after, /<UpdateVariable>[\s\S]*"path": "\/好感度", "value": 11[\s\S]*- 心情：?/)
  assert.deepEqual(rules(checkCard(cardOf({ entries: [entry(0, '[InitVar]（废弃）', '好感度: 10\n')] }))), [], 'the author gave up on these')
  assert.deepEqual(rules(checkCard(cardOf({ entries: [entry(0, '[initvar]', '好感度: 10\n'), entry(1, '规则', '{{setvar::好感度::11}}', { constant: true })], scripts: [BAR] }))), [], 'it writes them itself')

  const missing = checkCard(cardOf({ entries: [INIT, entry(1, '规则', '<UpdateVariable> _.set(\'好感读\', 1, 2) _.set(\'角色.${名字}.好感度\', 1, 2) _.set(\'背包.新物品\', 0, 1) {"op": "replace", "path": "/好感度", "value": 2}', { constant: true })], scripts: [HIDE, BAR] }))
  assert.deepEqual(missing.map(item => item.id), ['rule-path-missing:好感读'], 'stand-ins and new items in a list of things are no typos')
})

test('what has to grow: marked in the entry, in YAML or JSON, unless a schema says', () => {
  const texts = entry(1, '规则', '<UpdateVariable>\n_.insert(\'任务\', \'新任务\');\n{"op": "add", "path": "/背包/新物品", "value": {}}', { constant: true })
  const found = checkCard(cardOf({ entries: [entry(0, '[initvar]', '# 开局\n背包:\n  木剑:\n    数量: 1\n任务:\n  - 找到师父\n线索: {}\n好感度: 10\n'), texts], scripts: [HIDE, BAR] }))
  assert.deepEqual(rules(found), ['extensible'])
  const fix = one(found, 'extensible')
  assert.equal(fix.risky, undefined)
  const after = fix.changes[0].after
  assert.match(after, /# 开局/, 'comments stay')
  const card = cardOf({ entries: [{ ...entry(0, '[initvar]', after) }, texts], scripts: [HIDE, BAR] })
  assert.deepEqual(rules(checkCard(card)), [], 'once marked it is quiet')
  assert.deepEqual(initialState([card.book]), { 背包: { 木剑: { 数量: 1 } }, 任务: ['找到师父'], 线索: {}, 好感度: 10 }, 'the marks stay out of the variables')

  const json = checkCard(cardOf({ entries: [entry(0, '[initvar]', '{"背包": {}}'), RULE], scripts: [HIDE, BAR] }))
  assert.match(one(json, 'extensible').changes[0].after, /\$meta/)

  const withSchema = cardOf({ entries: [entry(0, '[initvar]', '背包: {}\n'), RULE], scripts: [HIDE, BAR] })
  assert.deepEqual(rules(checkCard(withSchema, { helpers: [{ name: 'Zod 变量结构', content: "import 'https://example.com/x.js'" }] })), [], 'a schema loaded from elsewhere decides')
  withSchema.helperScripts = 2
  assert.deepEqual(rules(checkCard(withSchema)), [], 'scripts not read may hold one')
})

test('status bar: fields that lost their variable, a card without one, the block left showing', () => {
  const spec = { title: '', fields: [{ path: '好感', label: '好感', show: 'number' }, { path: '角色.心情', show: 'text' }, { path: '没了', show: 'text' }, { path: '藏着', show: 'hidden' }] }
  const card = cardOf({ entries: [entry(0, '[initvar]', '好感度: 10\n心情: 平静\n'), RULE], scripts: [HIDE], extensions: { cicatavern: { status_bar: spec } } })
  const found = checkCard(card)
  assert.deepEqual(rules(found), ['status-path-missing'])
  assert.deepEqual(one(found, 'status-path-missing').changes[0].spec.fields.map(field => field.path), ['心情', '藏着'], 'found again by its last key, or dropped')

  const none = checkCard(cardOf({ entries: [INIT, RULE] }))
  assert.deepEqual(rules(none), ['no-hide-regex', 'status-none'])
  assert.deepEqual(one(none, 'status-none').changes[0].spec.fields.map(field => field.path), ['好感度', '背包'])
  assert.equal(one(none, 'status-none').risky, true)
  assert.equal(one(none, 'no-hide-regex').changes[0].effect, 'display')
})

test('too much always on: said once, with the longest entries', () => {
  const big = '设定。'.repeat(11000)
  const found = checkCard(cardOf({ entries: [entry(0, '世界观', big, { constant: true }), entry(1, '小事', '一点。', { constant: true })] }))
  assert.deepEqual(rules(found), ['constant-heavy'])
  assert.match(one(found, 'constant-heavy').why, /世界观/)
  assert.equal(one(found, 'constant-heavy').changes.length, 0, 'which to move is for a person or the model to say')
})

test('what kind of card it is', () => {
  const facts = cardFacts(cardOf({ entries: [INIT, RULE, entry(2, '关着的', 'x', { enabled: false })], scripts: [script('a', '美化', '/甲/', '<img src="https://cdn.example.com/a.png">')] }))
  assert.deepEqual([facts.entries, facts.enabled, facts.variables, facts.scripts, facts.greetings, facts.remote], [3, 2, 2, 1, 1, ['cdn.example.com']])
})

test('taking a finding in: entries, openings, regex, a status bar and its SillyTavern copy', () => {
  const card = cardOf({ first: '{{char}看你一眼。', entries: [entry(0, '化形', '规矩。', { keys: ['化形、大妖'] }), INIT, RULE] })
  const found = checkCard(card)
  for (const item of found.filter(finding => finding.changes.length)) applyFinding(card, item)
  assert.deepEqual(card.book.entries[0].keys, ['化形', '大妖'])
  assert.equal(card.firstMes, '{{char}}看你一眼。')
  assert.equal(card.statusBar.fields[0].path, '好感度')
  const names = card.regexScripts.map(item => item.id.startsWith('cicatavern') ? item.id : item.scriptName)
  assert.deepEqual(names.sort(), ['cicatavern-status-bar', 'cicatavern-status-bar-hide', '对玩家隐藏变量更新'].sort())
  assert.deepEqual(rules(checkCard(card)), [], 'nothing left to say')
  const exported = sillyTavernCard(card, rawCard())
  assert.deepEqual(exported.data.character_book.entries[0].keys, ['化形', '大妖'])
  assert.ok(exported.data.extensions.regex_scripts.some(item => item.id === 'cicatavern-status-bar'))
  assert.ok(exported.data.extensions.cicatavern.status_bar)
})

test('a layout changed again keeps its SillyTavern copy in step', () => {
  const card = cardOf({ entries: [INIT, RULE], scripts: [HIDE] })
  applyFinding(card, one(checkCard(card), 'status-none'))
  const before = card.regexScripts.find(item => item.id === 'cicatavern-status-bar').replaceString
  const spec = { ...card.statusBar, theme: 'neon' }
  applyFinding(card, { changes: [{ id: 'statusBar', kind: 'statusBar', spec }] })
  const after = card.regexScripts.find(item => item.id === 'cicatavern-status-bar').replaceString
  assert.notEqual(after, before)
  assert.match(after, /theme-neon/)
})

test('written over by hand: what is checked, and what cannot go in', () => {
  const card = cardOf({ entries: [entry(0, '[initvar]', 'a: [1'), entry(1, '暗号', '接头。', { keys: ['/(/'] })], scripts: [script('x', '坏的', '/(/')] })
  const found = checkCard(card)
  const byRule = rule => one(found, rule)
  assert.throws(() => withEdits(card, byRule('regex-invalid'), {}), /还没有改动/)
  assert.throws(() => withEdits(card, byRule('regex-invalid'), { 'regex:x': { find: '/(甲/' } }), /读不出来/)
  const regex = withEdits(card, byRule('regex-invalid'), { 'regex:x': { find: '/(甲)/g', replace: '$1' } })
  applyFinding(card, regex)
  assert.deepEqual([card.regexScripts[0].findRegex, card.regexScripts[0].replaceString], ['/(甲)/g', '$1'])

  assert.throws(() => withEdits(card, byRule('initvar-broken'), { 'entry:0': { after: 'b: [2' } }), /初始变量读不出来/)
  applyFinding(card, withEdits(card, byRule('initvar-broken'), { 'entry:0': { after: 'a: 1' } }))
  assert.equal(card.book.entries[0].content, 'a: 1')

  applyFinding(card, withEdits(card, byRule('key-invalid'), { 'entry:1': { keys: '暗号，接头' } }))
  assert.deepEqual(card.book.entries[1].keys, ['暗号', '接头'])
})

test('taking back: piece by piece, and refused once a piece has moved on', () => {
  const card = cardOf({ first: '{{char}看你。', entries: [entry(0, '空的', ''), entry(1, '化形', '规矩。', { keys: ['化形、大妖'] }), entry(2, '老周', '船夫。', { keys: ['老周'] })], scripts: [script('a', '甲', '/甲/')] })
  const taken = []
  for (const rule of ['entry-empty', 'key-joined', 'macro-broken']) {
    const before = snapshot(card)
    applyFinding(card, one(checkCard(card), rule))
    taken.push(changedPieces(before, card))
  }
  assert.deepEqual(taken.map(pieces => pieces.map(piece => piece.key)), [['entry:0'], ['entry:1'], ['greetings']])
  assert.equal(card.book.entries.length, 2)
  restorePieces(card, taken[0])
  assert.deepEqual(card.book.entries.map(item => item.comment), ['空的', '化形', '老周'], 'a removed entry goes back where it was')
  assert.deepEqual(card.book.entries[1].keys, ['化形', '大妖'], 'what was taken in after it stays')

  card.book.entries[1].content = '又改了。'
  assert.throws(() => restorePieces(card, taken[1]), /又改过/)
  assert.deepEqual(card.book.entries[1].keys, ['化形', '大妖'], 'refused, nothing changes')

  restorePieces(card, taken[2])
  assert.equal(card.firstMes, '{{char}看你。')

  const added = snapshot(card)
  applyFinding(card, { changes: [{ id: 'new:0', kind: 'newEntry', name: '新', keys: ['新词'], constant: false, after: '内容' }, { id: 'new:1', kind: 'newRegex', name: '新正则', on: 'ai', effect: 'display', find: '/乙/g', replace: '' }] })
  const pieces = changedPieces(added, card)
  assert.equal(pieces.length, 2)
  restorePieces(card, pieces)
  assert.deepEqual([card.book.entries.length, card.regexScripts.length], [3, 1], 'what was new goes again')
})

test('a card that draws its own status bar is not offered a layout by the model', () => {
  const card = cardOf({ entries: [INIT, RULE], scripts: [BAR, HIDE] })
  assert.match(checkRequest(card, []).request.messages[0].content, /用自己的正则或脚本画状态栏/)
  const { suggestions } = readCheck('<suggestion title="排一个"><status_bar>{"fields": [{"path": "好感度", "show": "number"}]}</status_bar></suggestion>', card)
  assert.deepEqual(suggestions[0].changes, [])
})

test('a change gone out of date', () => {
  const card = cardOf({ first: '开场。', entries: [entry(0, '老周', '船夫。', { keys: ['老周'] })], scripts: [script('a', '甲', '/甲/')] })
  const fresh = [
    { kind: 'field', key: 'description', before: card.description },
    { kind: 'greeting', index: 0, before: '开场。' },
    { kind: 'entry', uid: '0', before: '船夫。' },
    { kind: 'regex', sid: 'a', findBefore: '/甲/', replaceBefore: '' },
    { kind: 'statusBar', before: '' },
  ]
  assert.deepEqual(fresh.map(change => staleChange(card, change)), [false, false, false, false, false])
  assert.equal(staleChange(card, { kind: 'entry', uid: '0', before: '改过了。' }), true)
  assert.equal(staleChange(card, { kind: 'entry', uid: '9', before: '' }), true, 'an entry deleted since')
  assert.equal(staleChange(card, { kind: 'removeRegex', sid: 'zzz' }), true)
})

test('what the model reads: rules first, the rest by name, within the budget', () => {
  const entries = [INIT, RULE, ...Array.from({ length: 60 }, (_, i) => entry(i + 2, `人物${i}`, '长'.repeat(3000), { keys: [`人物${i}`] }))]
  const card = cardOf({ entries, scripts: [script('a', '美化', '/甲/', '<div>'.repeat(200)), HIDE], extensions: { cicatavern: {} } })
  const { request, shown, clipped } = checkRequest(card, [{ title: '一处程序查到的' }], { focus: ['rules', 'tokens'], reply: '简体中文', state: { 好感度: 10 } })
  const { content } = request.messages[0]
  assert.ok(content.length < 62000, `about 60 000 characters, not ${content.length}`)
  assert.ok(shown.includes('0') && shown.includes('1'), 'the rules are always read')
  assert.ok(shown.length < entries.length, 'not all of a long book')
  assert.match(content, /其余 \d+ 条没有附上全文/)
  assert.match(content, /替换内容 1000 字，没有附上/, 'a look is named, not sent')
  assert.match(content, /<found>\n- 一处程序查到的/)
  assert.match(content, /好感度: 10/)
  assert.deepEqual(clipped, [])
  assert.match(request.system, /省上下文/)
  assert.doesNotMatch(request.system, /文笔：/, 'not asked for, not looked at')
  assert.match(checkRequest(card, [], { focus: ['style'] }).request.system, /文笔：/)

  const long = cardOf({ description: '长'.repeat(9000) })
  assert.deepEqual(checkRequest(long, []).clipped, ['field:description'])
})

test('reading a suggestion: patches, keywords, a status bar; what it may not write', () => {
  const card = cardOf({
    first: '「又下雨了。」她说。',
    entries: [INIT, RULE, entry(2, '世界观', '旧城只在雨夜开门。', { constant: true }), entry(3, '老周', '码头的船夫，常年不说话。', { keys: ['老周'] }), entry(4, '没发全文的', '内容。', { keys: ['某词'] })],
    scripts: [script('a', '美化', '/甲/', '<div>旧</div>')],
  })
  const answer = [
    '<reply>整体不错，世界观可以少占一点。</reply>',
    '<suggestion title="把老周改得具体" why="现在太笼统" level="warn"><patch target="entry:3"><old>常年不说话</old><new>只跟青禾说话</new></patch><patch target="entry:3"><old>码头的</old><new>东码头的</new></patch></suggestion>',
    '<suggestion title="世界观改关键词" why="只在提到旧城时才用"><entry uid="2" mode="keyword" keys="旧城, 雨夜"></entry></suggestion>',
    '<suggestion title="开场白点题"><patch target="greeting:1"><old>她说</old><new>青禾说</new></patch></suggestion>',
    '<suggestion title="改没发全文的条目"><entry uid="4">整条重写</entry></suggestion>',
    '<suggestion title="状态栏"><status_bar>{"theme": "paper", "fields": [{"path": "好感度", "label": "好感", "show": "meter", "min": 0, "max": 100}]}</status_bar></suggestion>',
    `<suggestion title="重写美化"><regex id="a"><replace>${'<div style="x">'.repeat(40)}</replace></regex></suggestion>`,
    '<suggestion title="改查找"><regex id="a"><find>/乙/g</find></regex></suggestion>',
    '<suggestion title="原文对不上"><patch target="entry:3"><old>没有这句</old><new>x</new></patch></suggestion>',
    '<suggestion title="只是提醒"><why>开场白可以再短，<UpdateVariable> 放到最后</why></suggestion>',
    '<suggestion title="" why="没有标题的不要"></suggestion>',
  ].join('\n')
  const { reply, suggestions } = readCheck(answer, card, { shown: ['0', '1', '2', '3'] })
  assert.equal(reply, '整体不错，世界观可以少占一点。')
  const byTitle = Object.fromEntries(suggestions.map(item => [item.title, item]))
  assert.ok(suggestions.every(item => item.from === 'model' && item.risky === true), 'none comes ticked')

  const patched = byTitle['把老周改得具体']
  assert.deepEqual([patched.level, patched.why, patched.changes.length], ['warn', '现在太笼统', 1], 'patches on one piece are one change')
  assert.equal(patched.changes[0].after, '东码头的船夫，只跟青禾说话。')
  const mode = byTitle['世界观改关键词'].changes[0]
  assert.deepEqual([mode.mode, mode.keys, mode.after], ['keyword', ['旧城', '雨夜'], '旧城只在雨夜开门。'])
  assert.equal(byTitle['开场白点题'].changes[0].after, '「又下雨了。」青禾说。')
  assert.deepEqual(byTitle['改没发全文的条目'].changes, [], 'not read in full, not rewritten')
  assert.equal(byTitle['状态栏'].changes[0].spec.theme, 'paper')
  assert.equal(byTitle['状态栏'].changes[0].scripts, true)
  assert.deepEqual(byTitle['重写美化'].changes, [], 'a whole look is not a model\'s to write')
  assert.equal(byTitle['改查找'].changes[0].findAfter, '/乙/g')
  assert.deepEqual([byTitle['原文对不上'].missed, byTitle['原文对不上'].changes.length], [1, 0])
  assert.deepEqual(byTitle['只是提醒'].changes, [])
  assert.equal(byTitle['只是提醒'].why, '开场白可以再短，<UpdateVariable> 放到最后')
  assert.equal(byTitle[''], undefined)

  const kept = vetSuggestions(card, suggestions)
  assert.deepEqual(kept.filter(item => item.broken), [])
  const bad = vetSuggestions(card, [{ id: 'm', title: '改坏', changes: [{ id: 'entry:0', kind: 'entry', uid: '0', title: '[initvar]初始变量', before: INIT.content, after: 'a: [1' }] }])
  assert.equal(bad[0].broken.length, 1, 'it would break the format, so it cannot be taken')
  assert.equal(card.book.entries[0].content, INIT.content, 'tried on a copy')
  assert.deepEqual(cleanFocus(['style', 'nope']), ['style'])
  assert.deepEqual(cleanFocus([]), ['rules', 'tokens', 'look'])
})

// ─── Over HTTP ────────────────────────────────────────────────────────────

const ANSWER = [
  '<reply>规则清楚，世界观可以改成关键词。</reply>',
  '<suggestion title="世界观改关键词" why="只在提到旧城时才用" level="tip"><entry uid="1" mode="keyword" keys="旧城, 雨夜"></entry></suggestion>',
].join('\n')

async function fakeModel() {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-check-'))
  const model = await fakeModel()
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    model.close()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (url, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: res.status, body: await res.json() }
  }
  return { call, model }
}

const addCard = async (call, raw) => (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(raw)).toString('base64') } })).body

test('over HTTP: found, ignored, taken in, taken back, and the model asked only when told', async t => {
  const { call, model } = await tavern(t)
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `${model.base}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  const imported = await addCard(call, rawCard({ first: '{{char}看你。', entries: [entry(0, '化形', '规矩。', { keys: ['化形、大妖'] }), entry(1, '世界观', '旧城只在雨夜开门。', { constant: true }), entry(2, '单字', '讲究。', { keys: ['茶', '喝茶'] })] }))
  const id = imported.card?.id ?? imported.id
  assert.ok(id, JSON.stringify(imported).slice(0, 200))

  let check = (await call(`/api/cards/${id}/check`)).body
  assert.deepEqual(rules(check.findings), ['key-joined', 'key-single', 'macro-broken'])
  assert.equal(model.seen.length, 0, 'opening the window sends nothing')
  assert.equal(check.estimate.ready, true)
  assert.ok(check.estimate.input > 0)
  assert.match(check.estimate.model, /writer/)

  check = (await call(`/api/cards/${id}/check`, { method: 'PUT', body: { ignore: 'key-single:2' } })).body
  assert.deepEqual([rules(check.findings).length, check.ignored.map(item => item.id)], [2, ['key-single:2']])
  check = (await call(`/api/cards/${id}/check`, { method: 'PUT', body: { restore: 'key-single:2' } })).body
  assert.equal(check.findings.length, 3)

  const taken = (await call(`/api/cards/${id}/check/apply`, { method: 'POST', body: { items: [{ id: 'key-joined:0' }, { id: 'macro-broken:greeting-0' }] } })).body
  assert.deepEqual(rules(taken.check.findings), ['key-single'])
  assert.deepEqual([taken.applied, taken.prefix], [2, false])
  assert.equal(taken.card.greetings[0], '{{char}}看你。')
  assert.equal(taken.check.records.length, 2)
  assert.equal(taken.check.records[0].batch, taken.check.records[1].batch)

  const one_ = (await call(`/api/cards/${id}/check/undo`, { method: 'POST', body: { record: taken.check.records[1].id } })).body
  assert.equal(one_.card.greetings[0], '{{char}看你。')
  assert.deepEqual(rules(one_.check.findings), ['key-single', 'macro-broken'])
  const rest = (await call(`/api/cards/${id}/check/undo`, { method: 'POST', body: { batch: taken.check.records[0].batch } })).body
  assert.deepEqual(rules(rest.check.findings), ['key-joined', 'key-single', 'macro-broken'])
  assert.equal(rest.check.records.length, 0)
  assert.equal((await call(`/api/cards/${id}/check/undo`, { method: 'POST', body: { batch: 'gone' } })).status, 409)

  const edited = (await call(`/api/cards/${id}/check/apply`, { method: 'POST', body: { items: [{ id: 'key-single:2', edits: { 'entry:2': { keys: '喝茶，品茶' } } }] } })).body
  assert.deepEqual(rules(edited.check.findings), ['key-joined', 'macro-broken'])
  assert.equal((await call(`/api/cards/${id}/check/apply`, { method: 'POST', body: { items: [{ id: 'nothing' }] } })).status, 409)

  const asked = (await call(`/api/cards/${id}/check/ask`, { method: 'POST', body: { focus: ['tokens'] } })).body
  assert.ok(asked.job || asked.askedAt)
  let view = asked
  for (let i = 0; i < 100 && (view.job || !view.askedAt); i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
    view = (await call(`/api/cards/${id}/check`)).body
  }
  assert.equal(model.seen.length, 1)
  assert.equal(view.error, null)
  assert.equal(view.reply, '规则清楚，世界观可以改成关键词。')
  assert.deepEqual(view.focus, ['tokens'])
  const suggestion = view.findings.find(item => item.from === 'model')
  assert.equal(suggestion.title, '世界观改关键词')

  const tookIt = (await call(`/api/cards/${id}/check/apply`, { method: 'POST', body: { items: [{ id: suggestion.id }] } })).body
  assert.equal(tookIt.prefix, true, 'an always-on entry left the prefix')
  assert.equal(tookIt.check.findings.some(item => item.from === 'model'), false)
  const book = (await call(`/api/cards/${id}/edit`)).body
  assert.equal(book.bookConstant, 0)
  const back = (await call(`/api/cards/${id}/check/undo`, { method: 'POST', body: { record: tookIt.check.records.at(-1).id } })).body
  assert.equal(back.check.findings.some(item => item.id === suggestion.id), true, 'taken back, it is offered again')
  assert.equal(back.prefix, true)

  assert.equal((await call(`/api/cards/${id}`, { method: 'DELETE' })).status, 200)
  assert.equal((await call(`/api/cards/${id}/check`)).status, 404)
})
