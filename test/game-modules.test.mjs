// 玩法模块 (plans/14 第 2 层): 指挥 (the player leads from behind), 类型克制 (what beats what), 收服 (a foe brought down
// taken along), and what of 形态 was left: foes that follow a form, and a form the story alone can give.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EDGE, autoAction, autoCommands, edgeOf, foeSheets, partySize, playerOf, refusal, simulate, startBattle, step, tameTry } from '../web/shared/game/battle.js'
import { encounterSetup, fightResult } from '../web/shared/game/encounter.js'
import { modulesAsk, wornWorth } from '../web/shared/game/growth.js'
import { applyOps, cleanKit, cleanRulebook, cleanTypes, kitBook, sheetOf } from '../web/shared/game/sheet.js'
import { foesRequest, gamePrompt, parseFoes, suggestRequest } from '../server/game.mjs'

const TYPES = { 火: ['草'], 草: ['水'], 水: ['火'] }
const book = (more = {}) => cleanRulebook({
  level: 'full',
  growth: { level: 'standard' },
  skills: { 指挥棒: 'strike', 水枪: 'strike' },
  start: { skills: ['指挥棒', '水枪'], things: [{ name: '伤药', count: 2 }], party: ['小焰'] },
  items: { 伤药: { type: 'heal', size: 'medium' } },
  companions: { 小焰: { attributes: { body: 14 }, skills: { 火花: 'strike' }, type: '火' } },
  foes: { 藤蔓怪: { looks: 'vine monster', moves: ['缠绕', '鞭打'], type: '草' }, 水母: { looks: 'jellyfish', moves: ['水弹'], type: '水' } },
  ...more,
})
const at = (rules, more = {}) => ({ ...sheetOf(rules, null, {}), ...more })
const fight = (rules, sheet, foes, node = 'n') => encounterSetup(sheet, rules, { foes }, 'c', node)
/** A fight played through with 自动. → { state, actions } */
function played(setup) {
  const actions = []
  let state = startBattle(setup)
  while (!state.over && actions.length < 80) {
    const commands = autoCommands(state)
    actions.push(commands)
    state = step(state, commands).state
  }
  return { state, actions }
}

// ── 类型克制 ──────────────────────────────────────────────────────────
test('a card\'s types: what each beats, among those it has; fewer than two is none, and a skill\'s type is one of them', () => {
  assert.deepEqual(cleanTypes({ 火: ['草', '火', '风'], 草: ['水'], 水: '火' }), { 火: ['草'], 草: ['水'], 水: [] })
  assert.deepEqual(cleanTypes({ 火: ['草'] }), {})
  assert.deepEqual(cleanTypes(null), {})
  const rules = book({ types: TYPES, skillTypes: { 水枪: '水', 指挥棒: '风' } })
  assert.deepEqual(rules.types, TYPES)
  assert.deepEqual(rules.skillTypes, { 水枪: '水' })
  assert.equal(rules.companions['小焰'].type, '火')
  assert.equal(rules.foes['藤蔓怪'].type, '草')
  assert.deepEqual(cleanRulebook(rules), rules)
  const plain = book()
  assert.equal(plain.types, undefined)
  assert.equal(plain.skillTypes, undefined)
})

test('a blow of a type that beats its target\'s lands half as hard again, one beaten by it a quarter lighter; a card with no types fights as it did', () => {
  const rules = book({ types: TYPES, skillTypes: { 水枪: '水' } })
  const setup = fight(rules, at(rules), [{ name: '藤蔓怪', count: 1, tier: 'boss' }])
  assert.deepEqual(setup.types, TYPES)
  assert.equal(setup.foes[0].type, '草')
  assert.equal(setup.allies[0].type, '火')
  assert.equal(setup.player.skills.find(skill => skill.name === '水枪').type, '水')
  assert.equal(foeSheets(setup)[0].type, '草')
  const state = startBattle(setup)
  assert.equal(edgeOf(state, '火', '草'), 'strong')
  assert.equal(edgeOf(state, '水', '草'), 'weak')
  assert.equal(edgeOf(state, '火', '火'), '')
  assert.equal(edgeOf(state, '', '草'), '')
  const hits = commands => step(state, commands).events.filter(event => event.type === 'hit')
  const [mine, theirs] = hits([{ who: 'player', kind: 'skill', name: '水枪', target: 'foe-0' }, { who: 'ally-0', kind: 'attack', target: 'foe-0' }]).sort((a, b) => (a.by === 'player' ? -1 : 1))
  assert.equal(mine.edge, 'weak')
  assert.equal(theirs.edge, 'strong')
  // The same blows on a card without types: no word of it, and the fire's is two thirds of what it was.
  const bare = book()
  const plain = startBattle(fight(bare, at(bare), [{ name: '藤蔓怪', count: 1, tier: 'boss' }]))
  assert.equal(plain.types, undefined)
  const even = step(plain, [{ who: 'player', kind: 'skill', name: '水枪', target: 'foe-0' }, { who: 'ally-0', kind: 'attack', target: 'foe-0' }]).events.filter(event => event.type === 'hit').find(event => event.by === 'ally-0')
  assert.equal(even.edge, undefined)
  assert.ok(Math.abs(theirs.amount / even.amount - EDGE.strong) < 0.12, `${theirs.amount} against ${even.amount}`)
  // What a foe's blow does to one of the party is moved too: water on fire.
  const wet = startBattle(fight(rules, at(rules), [{ name: '水母', count: 1, tier: 'normal' }]))
  const struck = []
  let now = wet
  for (let i = 0; i < 6 && !now.over; i++) {
    const out = step(now, [{ who: 'player', kind: 'guard' }, { who: 'ally-0', kind: 'guard' }])
    struck.push(...out.events.filter(event => event.type === 'struck'))
    now = out.state
  }
  assert.ok(struck.some(event => event.target === 'ally-0' && event.edge === 'strong'))
  assert.ok(struck.filter(event => event.target === 'player').every(event => !event.edge), 'the player has no type')
  // 自动 picks what the foe is weak to.
  const fiery = book({ types: TYPES, skillTypes: { 水枪: '水', 指挥棒: '火' } })
  assert.equal(autoAction(startBattle(fight(fiery, at(fiery), [{ name: '藤蔓怪', count: 1, tier: 'boss' }])), 'player').name, '指挥棒')
})

// ── 指挥 ──────────────────────────────────────────────────────────────
test('指挥: the player leads from behind where someone stands with them: not struck, not counted against the foes, lost when the others are down', () => {
  const rules = book({ lead: 'command' })
  assert.equal(rules.lead, 'command')
  assert.equal(book().lead, undefined)
  const setup = fight(rules, at(rules), [{ name: '藤蔓怪', count: 1, tier: 'elite' }])
  assert.equal(setup.lead, 'command')
  assert.equal(partySize(setup), 1, 'the foes are as strong as for the one who fights')
  const self = book()
  assert.equal(startBattle(setup).units.at(-1).maxLife < startBattle(fight(self, at(self), [{ name: '藤蔓怪', count: 1, tier: 'elite' }])).units.at(-1).maxLife, true)
  const state = startBattle(setup)
  assert.equal(playerOf(state).commander, true)
  assert.equal(refusal(state, { who: 'player', kind: 'attack', target: 'foe-0' }), 'who')
  assert.equal(refusal(state, { who: 'player', kind: 'skill', name: '指挥棒', target: 'foe-0' }), 'who')
  assert.equal(refusal(state, { who: 'player', kind: 'cheer', target: 'ally-0' }), null)
  assert.equal(refusal(state, { who: 'player', kind: 'cheer', target: 'player' }), 'target')
  assert.equal(refusal(state, { who: 'player', kind: 'item', name: '伤药', target: 'ally-0' }), null)
  assert.equal(refusal(state, { who: 'player', kind: 'guard' }), null)
  assert.equal(refusal(state, { who: 'ally-0', kind: 'cheer', target: 'ally-0' }), 'unknown')
  assert.deepEqual(autoAction(state, 'player'), { who: 'player', kind: 'cheer', target: 'ally-0' })
  const { state: after, events } = step(state, [{ who: 'player', kind: 'cheer', target: 'ally-0' }, { who: 'ally-0', kind: 'attack', target: 'foe-0' }])
  assert.ok(events.some(event => event.type === 'status' && event.status === 'cheer' && event.target === 'ally-0'))
  assert.ok(after.units[1].boost > 0)
  assert.deepEqual(autoAction(after, 'player'), { who: 'player', kind: 'guard' }, 'no need to say it twice')
  // Nobody strikes the one who leads; when the one who fights is down, it is lost.
  const { state: end, actions } = played(fight(rules, at(rules), [{ name: '藤蔓怪', count: 2, tier: 'boss', power: '远强' }], 'hard'))
  assert.equal(end.over, 'lost')
  assert.equal(playerOf(end).life, playerOf(end).maxLife)
  const hard = fight(rules, at(rules), [{ name: '藤蔓怪', count: 2, tier: 'boss', power: '远强' }], 'hard')
  const result = fightResult(hard, { over: 'lost', actions })
  assert.equal(result.op.commanded, true)
  const sheet = applyOps(at(rules), rules, [result.op]).sheet
  assert.equal(sheet.life, sheet.maxLife, 'a fight lost is the companions\' to bear')
  assert.deepEqual(sheet.conditions, [])
  assert.ok(sheet.party[0].life < sheet.party[0].maxLife)
  // Alone, they fight as ever.
  const lone = fight(rules, at(rules, { party: [] }), [{ name: '藤蔓怪', count: 1, tier: 'normal' }])
  assert.equal(lone.lead, undefined)
  assert.equal(playerOf(startBattle(lone)).commander, undefined)
})

test('指挥 is about as hard as fighting beside them: one who leads a companion wins about as often as the two together', () => {
  const command = book({ lead: 'command' })
  const self = book()
  const chance = rules => simulate(fight(rules, at(rules), [{ name: '藤蔓怪', count: 1, tier: 'boss' }]), 400).chance
  const led = chance(command)
  const beside = chance(self)
  assert.ok(Math.abs(led - beside) < 25, `led ${led}, beside ${beside}`)
})

// ── 收服 ──────────────────────────────────────────────────────────────
test('收服: a foe brought down in a fight that was won may be tried for once, on a roll of the rules\' own; a 首领 never', () => {
  const rules = book({ tame: true, attributes: { charm: 16 } })
  assert.equal(rules.tame, true)
  const setup = fight(rules, at(rules), [{ name: '藤蔓怪', count: 1, tier: 'minion' }, { name: '水母', count: 1, tier: 'boss' }])
  assert.deepEqual(setup.tame, { charm: 3, have: ['小焰'] })
  const vine = tameTry(setup, { name: '藤蔓怪', tier: 'minion', gap: 0 })
  assert.equal(vine.dc, 8)
  assert.equal(vine.ok, vine.total >= 8 || vine.roll === 20)
  assert.deepEqual(tameTry(setup, { name: '藤蔓怪', tier: 'minion', gap: 0 }), vine, 'the same however often')
  assert.equal(tameTry(setup, { name: '水母', tier: 'boss' }), null)
  assert.equal(tameTry(setup, { name: '小焰', tier: 'minion' }), null, 'one by that name is with them already')
  assert.equal(tameTry(fight(book(), at(book()), [{ name: '藤蔓怪', count: 1, tier: 'minion' }]), { name: '藤蔓怪', tier: 'minion' }), null)
  // A fight won, with one tried for: the roll decides, and one tamed is of the party from then on.
  const easy = fight(rules, at(rules), [{ name: '藤蔓怪', count: 1, tier: 'minion' }], 'tame')
  const { state, actions } = played(easy)
  assert.equal(state.over, 'won')
  const tried = tameTry(easy, { name: '藤蔓怪', tier: 'minion', gap: 0 })
  const result = fightResult(easy, { over: 'won', actions, tame: '藤蔓怪' })
  assert.deepEqual(result.battle.tame, { name: '藤蔓怪', ok: tried.ok, roll: tried.roll, total: tried.total, dc: 8 })
  assert.equal(result.op.tamed, tried.ok ? '藤蔓怪' : undefined)
  assert.equal(fightResult(easy, { over: 'won', actions, tame: '没有的' }).battle.tame, undefined)
  assert.equal(fightResult(easy, { over: 'won', actions }).battle.tame, undefined)
  const joined = applyOps(at(rules), rules, [{ ...result.op, tamed: '藤蔓怪' }]).sheet.party
  assert.deepEqual(joined.map(member => member.name), ['小焰', '藤蔓怪'])
  assert.deepEqual(joined[1].skills, ['缠绕', '鞭打'], 'its moves are its skills')
  assert.equal(joined[1].type, '草')
  assert.equal(joined[1].tamed, true)
})

// ── 形态剩下的 ────────────────────────────────────────────────────────
test('a foe follows a form come to for good as it follows what is worn', () => {
  const rules = book({ forms: { 小焰: [{ name: '小焰' }, { name: '炎牙兽', at: { level: 2 }, effects: [{ id: 'attack', size: 'large' }, { id: 'guard', size: 'small' }] }] } })
  const start = at(rules)
  assert.equal(wornWorth([start, ...start.party], rules), null)
  const grown = { ...start, party: [{ ...start.party[0], form: '炎牙兽' }] }
  assert.deepEqual(wornWorth([grown, ...grown.party], rules), { deal: 0.05, take: 0.015 })
})

test('the models are told of what a card has of these, and of nothing it has not', () => {
  const ask = suggestRequest({ description: '驯兽师', book: { entries: [] } }, []).messages[0].content
  assert.ok(ask.includes(modulesAsk()))
  assert.match(modulesAsk(), /"types"[\s\S]*"lead"[\s\S]*"tame"/)
  const kit = cleanKit({ types: TYPES, lead: 'command', tame: true, skills: [{ name: '水枪', kind: 'strike', type: '水' }], foes: [{ name: '藤蔓怪', looks: 'x', type: '草' }], companions: [{ name: '小焰', type: '火', skills: [{ name: '火花', kind: 'strike', type: '火' }] }] })
  const made = cleanRulebook({ level: 'full', ...kitBook(kit) })
  assert.deepEqual(made.types, TYPES)
  assert.deepEqual(made.skillTypes, { 水枪: '水', 火花: '火' })
  assert.equal(made.lead, 'command')
  assert.equal(made.tame, true)
  assert.equal(made.foes['藤蔓怪'].type, '草')
  assert.equal(made.companions['小焰'].type, '火')
  assert.equal(kitBook(cleanKit({})).types, undefined)
  assert.match(foesRequest(['甲'], '故事', ['火', '草']).messages[0].content, /type：它的属性，从这些里选一个：火、草/)
  assert.doesNotMatch(foesRequest(['甲'], '故事').messages[0].content, /type/)
  assert.deepEqual(parseFoes('[{"name":"甲","looks":"a","moves":["咬"],"type":"火"},{"name":"乙","looks":"b","moves":[],"type":"风"}]', ['甲', '乙'], ['火', '草']), { 甲: { looks: 'a', moves: ['咬'], type: '火' }, 乙: { looks: 'b', moves: [] } })
  const rules = book({ lead: 'command', tame: true })
  const sheet = at(rules)
  const told = gamePrompt({ sheet, pausing: true, fights: true, companions: true, lead: true, tame: true }, []).text
  assert.match(told, /玩家自己不上场/)
  assert.match(told, /打赢以后可以收服/)
  const plain = gamePrompt({ sheet, pausing: true, fights: true, companions: true }, []).text
  assert.doesNotMatch(plain, /不上场|收服/)
  const won = { over: 'won', foes: '藤蔓怪', downed: '藤蔓怪', rounds: 3, life: 100, maxLife: 100, used: {}, skills: [], worth: 'fair' }
  assert.match(gamePrompt({ sheet, pausing: true, fights: true, lead: true, battle: { ...won, commanded: true, tame: { name: '藤蔓怪', ok: true } } }, []).text, /玩家在后面指挥，没有亲自动手[\s\S]*玩家收服了藤蔓怪/)
  assert.match(gamePrompt({ sheet, pausing: true, fights: true, battle: { ...won, tame: { name: '藤蔓怪', ok: false } } }, []).text, /玩家想收服藤蔓怪，没有成/)
  // 形态: a fight worth the name is where a form only the story can give is offered.
  const forms = { now: ['小焰现在是小焰'], chains: ['小焰：小焰 → 炎牙兽'], story: ['小焰的炎牙兽'] }
  assert.match(gamePrompt({ sheet, pausing: true, fights: true, forms, battle: won }, []).text, /这一仗是个转折点：小焰的炎牙兽只能由剧情给/)
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true, fights: true, forms, battle: { ...won, worth: 'small' } }, []).text, /这一仗是个转折点/)
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true, fights: true, forms: { ...forms, story: [] }, battle: won }, []).text, /这一仗是个转折点/)
})
