// 玩法积木: 日程, 关系网 and 路线与结局 (server/forge/bricks.mjs). Each keeps what it tracks in variables the code
// adds, so they are for 创作角色卡 only: what the planner is told, what a plan keeps, the rule the code writes, the
// variables, and the card that comes of it.
import assert from 'node:assert/strict'
import test from 'node:test'
import YAML from 'yaml'
import { normalizeCard } from '../server/cards.mjs'
import { CARD_BRICKS } from '../server/forge/brick-add.mjs'
import { brickContent, brickCost, brickGaps, brickScripts, cleanRelations, cleanRoutes, cleanSchedule, endingLine } from '../server/forge/bricks.mjs'
import { bricksOf, cardFacts } from '../server/forge/check.mjs'
import { cleanCardOptions, discussRequest, emptyBrief, normalizePlan, planRequest, withCardOptions } from '../server/forge/prompts.mjs'
import { statusSpecOf } from '../server/forge/status.mjs'
import { cardJson, initialState, newCard } from '../server/forge/write.mjs'
import { BRICKS, needsVariables, settlePicks } from '../web/shared/status.js'

const SCHEDULE = { periods: ['清晨', '上午', '午后', '傍晚', '深夜'], people: [
  { name: '林雪', slots: ['后山练剑', '藏经阁抄经', '藏经阁抄经', '斋堂', '自己房里'], off: '下雪天不出门。' },
  { name: '老周', slots: ['山门扫雪', '', '柴房', '', '山门守夜'], off: '' },
] }
const RELATIONS = { pairs: [
  { a: '林雪', b: '老周', now: '师徒，面上客气', knot: '老周瞒着她师父的死因。' },
  { a: '老周', b: '阿梅', now: '父女', knot: '' },
] }
const ROUTES = { routes: [
  { name: '留在山上', enter: '<user> 答应林雪不下山', marks: ['拜入门下', '闭关', '接过掌门印'], ending: '多年以后，<user> 站在山门前送走下山的弟子。' },
  { name: '下山', enter: '<user> 执意要查清师父的死因', marks: ['夜探柴房', '与老周对质'], ending: '真相大白，<user> 再没有回过青梧山。' },
] }
const RAW = { name: '青梧山', user_role: { identity: '新入门的弟子' }, characters: [{ name: '林雪', kind: 'core' }, { name: '老周', kind: 'npc' }, { name: '阿梅', kind: 'npc' }], schedule: SCHEDULE, relations: RELATIONS, routes: ROUTES }
const read = (options, plan = RAW, more) => withCardOptions(normalizePlan(plan, more), cleanCardOptions(options))
const ALL = ['schedule', 'relations', 'routes']

test('the three are bricks that keep variables, offered in the wizard and not for a card already there', () => {
  for (const brick of ALL) {
    assert.ok(BRICKS.includes(brick))
    assert.ok(needsVariables([brick]))
    assert.ok(!CARD_BRICKS.includes(brick), 'they write variables: a card already there is not given them')
  }
  assert.deepEqual(cleanCardOptions({ bricks: [...ALL, 'nonsense'] }).bricks, ALL)
  // Picked for a plain-text card, the card becomes one with variables.
  assert.notEqual(settlePicks({ bricks: ['routes'], format: 'text', play: [] }, { bricks: [], format: 'text', play: [] }).format, 'text')
})

test('the planner and the talk hear of a brick only when it is picked', () => {
  const plan = options => planRequest([], emptyBrief(), {}, { options }).system
  const talk = options => discussRequest([], emptyBrief(), { card: '简体中文', reply: '简体中文' }, { options: cleanCardOptions(options) }).system
  const none = plan(cleanCardOptions({}))
  for (const [brick, field, said] of [['schedule', /多写一个 schedule 字段/, /这张卡有日程/], ['relations', /多写一个 relations 字段/, /角色之间的关系/], ['routes', /多写一个 routes 字段/, /几条路线，各有结局/]]) {
    assert.match(plan(cleanCardOptions({ bricks: [brick] })), field)
    assert.doesNotMatch(none, field)
    assert.match(talk({ bricks: [brick] }), said)
    assert.doesNotMatch(talk({}), said)
  }
})

test('a plan keeps what it can use of each', () => {
  const schedule = cleanSchedule({ periods: ['早', '早', '晚'], people: [{ name: '林雪', slots: ['练剑', '抄经', '多出来的'], off: '下雪天。' }, { name: '没有日程的', slots: [] }, { name: '林雪', slots: ['重名'] }, { slots: ['没有名字'] }, '不是对象'] })
  assert.deepEqual(schedule, { periods: ['早', '晚'], people: [{ name: '林雪', slots: ['练剑', '抄经'], off: '下雪天' }] })
  // Two slots the same are two slots: they stay beside their periods.
  assert.deepEqual(cleanSchedule(SCHEDULE).people[0].slots, ['后山练剑', '藏经阁抄经', '藏经阁抄经', '斋堂', '自己房里'])
  assert.deepEqual(cleanSchedule(SCHEDULE).people[1].slots, ['山门扫雪', '', '柴房', '', '山门守夜'])
  assert.equal(cleanSchedule(null), null)

  const relations = cleanRelations({ pairs: [{ a: '林 雪', b: '老.周', now: '师徒', knot: '瞒着一件事。' }, { a: '老周', b: '林雪', now: '反过来还是这一对' }, { a: '林雪', b: '林雪', now: '自己' }, { a: '林雪', b: '阿梅' }, { a: '', b: '阿梅', now: '少一个人' }] })
  assert.deepEqual(relations.pairs, [{ a: '林雪', b: '老周', now: '师徒', knot: '瞒着一件事' }])
  assert.equal(cleanRelations('x'), null)

  const routes = cleanRoutes({ routes: [{ name: '下 山', enter: '执意要走。', marks: ['甲', '甲', '乙 → 丙'], ending: '再没回来。' }, { name: '下山', ending: '重名' }, { name: '没有结局', marks: ['甲'] }, { ending: '没有名字' }] })
  assert.deepEqual(routes.routes, [{ name: '下山', enter: '执意要走', marks: ['甲', '乙   丙'], ending: '再没回来' }])
  assert.equal(cleanRoutes(undefined), null)
})

test('日程: the rule says the periods, where everyone is, and when time moves; two variables keep the day', () => {
  const plan = read({ bricks: ['schedule'], statusPages: true, format: 'mvu-ui' })
  assert.equal(plan.tracking.enabled, true)
  const [day, period] = ['世界.第几天', '世界.时段'].map(path => plan.tracking.variables.find(v => v.path === path))
  assert.deepEqual([day.type, day.initial, day.show, day.page], ['number', '1', 'number', '世界'])
  assert.deepEqual([period.type, period.initial, period.show, period.page], ['string', '清晨', 'badge', '世界'])
  assert.deepEqual(initialState(plan).世界, { 第几天: 1, 时段: '清晨' })
  assert.ok(plan.entries.some(entry => entry.part === 'schedule'))
  const text = brickContent('schedule', plan, false)
  assert.match(text, /^<schedule_rules>\n这张卡的一天分成几个时段，按先后：清晨 → 上午 → 午后 → 傍晚 → 深夜。现在是第几天、哪个时段，看变量 世界\.第几天 和 世界\.时段。/)
  assert.match(text, /- 林雪：清晨 后山练剑；上午 藏经阁抄经；午后 藏经阁抄经；傍晚 斋堂；深夜 自己房里（不照日程的时候：下雪天不出门）/)
  assert.match(text, /- 老周：清晨 山门扫雪；午后 柴房；深夜 山门守夜\n/, 'a period with nothing said of it is left out')
  assert.match(text, /找人要去他这个时段在的地方/)
  assert.match(text, /过了最后一个时段是第二天的第一个时段，第几天加 1/)
  assert.match(text, /<\/schedule_rules>$/)
  const english = read({ bricks: ['schedule'] }, RAW, { language: 'English' })
  assert.ok(english.tracking.variables.some(v => v.path === 'World.Day') && english.tracking.variables.some(v => v.path === 'World.Time'))
  assert.match(brickContent('schedule', english, true), /the variables World\.Day and World\.Time[\s\S]*- 林雪: 清晨 后山练剑; [\s\S]*\(off the schedule: 下雪天不出门\)/)
  // A day variable the plan already has is not added twice.
  const own = read({ bricks: ['schedule'] }, { ...RAW, tracking: { enabled: true, variables: [{ path: '世界.时段', label: '时辰', type: 'string', initial: '卯时' }] } })
  assert.equal(own.tracking.variables.filter(v => v.path === '世界.时段').length, 1)
  assert.equal(own.tracking.variables.find(v => v.path === '世界.时段').label, '时辰')
})

test('关系网: a variable for each pair, starting as they stand; the rule keeps what is unsettled under the story', () => {
  const plan = read({ bricks: ['relations'], statusPages: true, format: 'mvu-ui' })
  const pair = plan.tracking.variables.find(v => v.path === '关系.林雪和老周')
  assert.deepEqual([pair.type, pair.initial, pair.show, pair.page, pair.label], ['string', '师徒，面上客气', 'text', '关系', '林雪和老周'])
  assert.ok(plan.tracking.variables.some(v => v.path === '关系.老周和阿梅'))
  assert.deepEqual(initialState(plan).关系, { 林雪和老周: '师徒，面上客气', 老周和阿梅: '父女' })
  const text = brickContent('relations', plan, false)
  assert.match(text, /- 林雪和老周（变量 关系\.林雪和老周）：师徒，面上客气。没解开的事：老周瞒着她师父的死因\n/)
  assert.match(text, /- 老周和阿梅（变量 关系\.老周和阿梅）：父女\n/)
  assert.match(text, /不由你主动揭开/)
  assert.match(text, /不要让所有人都只围着 <user> 转/)
  const english = read({ bricks: ['relations'] }, RAW, { language: 'English' })
  assert.ok(english.tracking.variables.some(v => v.path === 'Bonds.林雪&老周'))
  assert.match(brickContent('relations', english, true), /- 林雪 and 老周 \(variable Bonds\.林雪&老周\): 师徒，面上客气\. Unsettled between them: /)
})

test('路线与结局: which route and the marks reached are kept off the bar; the rule says how one is entered, kept to and ended', () => {
  const plan = read({ bricks: ['routes'], format: 'mvu-ui' })
  const [current, reached] = ['路线.当前', '路线.进度'].map(path => plan.tracking.variables.find(v => v.path === path))
  assert.deepEqual([current.type, current.initial, current.show], ['string', '未定', 'hidden'])
  assert.deepEqual([reached.type, reached.show], ['list', 'hidden'])
  assert.equal(initialState(plan).路线.当前, '未定')
  assert.ok(Array.isArray(initialState(plan).路线.进度))
  // Nothing of it shows under a reply.
  assert.ok(!(statusSpecOf(plan)?.fields ?? []).some(field => field.path.startsWith('路线.') && field.show !== 'hidden'))
  const text = brickContent('routes', plan, false)
  assert.match(text, /看变量 路线\.当前（「未定」是还没走上任何一条），这条线上走到了哪些节点看 路线\.进度。/)
  assert.match(text, /- 留在山上。走上这条线：<user> 答应林雪不下山。节点：拜入门下 → 闭关 → 接过掌门印。结局：多年以后，<user> 站在山门前送走下山的弟子\n/)
  assert.match(text, /走上一条线以后不随便换/)
  assert.match(text, /单独写一行 〔结局：路线名〕/)
  assert.match(text, /不对 <user> 说破/)
  assert.equal(endingLine('下山', false), '〔结局：下山〕')
  const english = read({ bricks: ['routes'] }, RAW, { language: 'English' })
  assert.equal(english.tracking.variables.find(v => v.path === 'Route.current').initial, 'undecided')
  assert.match(brickContent('routes', english, true), /the variable Route\.current \("undecided": on none yet\)[\s\S]*\[Ending: the route's name\]/)
})

test('a brick not picked leaves nothing; one picked with nothing usable is said, and stays out of the card', () => {
  const none = read({})
  assert.deepEqual([none.schedule, none.relations, none.routes, none.bricks], [undefined, undefined, undefined, undefined])
  assert.equal(none.tracking.enabled, false)
  const empty = read({ bricks: ALL }, { ...RAW, schedule: { periods: ['早'], people: [] }, relations: { pairs: [] }, routes: { routes: [ROUTES.routes[0]] } })
  assert.deepEqual(brickGaps(empty), ALL)
  assert.ok(!empty.entries.some(entry => ALL.includes(entry.part)))
  assert.equal(empty.warnings.filter(text => /这块积木不会写进卡里/.test(text)).length, 3)
  assert.match(empty.warnings.join('\n'), /日程的时段或人还没写全[\s\S]*关系网里还没有能用的一对[\s\S]*路线还不到两条/)
})

test('the card: three rules sent every turn, their variables in the starting state, and the check knows the bricks', () => {
  const plan = read({ bricks: ALL, format: 'mvu-ui' })
  assert.deepEqual(brickGaps(plan), [])
  assert.deepEqual(brickScripts(plan, false), [], 'nothing to draw and nothing to hide')
  const cost = brickCost(plan, false)
  assert.ok(cost.always > 600 && cost.reply === 0)
  const draft = newCard(plan)
  const names = ['[规则]日程', '[规则]关系网', '[规则]路线与结局']
  for (const name of names) assert.match(draft.entries.find(entry => entry.name === name).content, /^<\w+_rules>\n/)
  const raw = cardJson(plan, { ...draft, greetings: ['雪下了一整夜。'] })
  const card = normalizeCard(raw)
  const kept = card.book.entries.filter(entry => names.includes(entry.comment))
  assert.equal(kept.length, 3)
  assert.ok(kept.every(entry => entry.constant && entry.enabled !== false))
  const start = YAML.parse(card.book.entries.find(entry => /initvar/i.test(entry.comment)).content)
  assert.deepEqual([start.世界.时段, start.关系.老周和阿梅, start.路线.当前], ['清晨', '父女', '未定'])
  const found = bricksOf(card)
  assert.ok(found.schedule && found.relations && found.routes)
  assert.deepEqual(cardFacts(card).bricks, ALL)
})
