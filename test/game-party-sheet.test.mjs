// 队伍 on the sheet: who the card has, who is with the player now (出战 and 待命), the 【同伴】 marks, and a fight of
// the party settled for each of them. The fight itself is game-party.test's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replyMarks } from '../web/shared/game/marks.js'
import { MAX_FIELDED, alliesFor, applyOps, cleanKit, cleanOps, cleanRulebook, companionOf, fieldedOf, kitBook, memberOf, partyChanged, settleReply, sheetOf, startSheet } from '../web/shared/game/sheet.js'
import { alivePartyOf, autoCommands, foesOf, partySize, startBattle, step } from '../web/shared/game/battle.js'
import { cleanFight, encounterSetup, fightResult } from '../web/shared/game/encounter.js'
import { gamePrompt } from '../server/game.mjs'

const BOOK = cleanRulebook({
  level: 'full',
  start: { skills: ['破风斩'], party: ['苏挽霜', '温小棠'] },
  companions: {
    苏挽霜: { keys: ['挽霜', '霜姐姐'], attributes: { body: 10, grace: 16, mind: 12, charm: 9 }, skills: { 霜落无声: 'strike', 回风扫叶: 'sweep' } },
    温小棠: { keys: ['小棠'], attributes: { grace: 14 }, skills: { 连珠弩: '' } },
    楚怀瑾: { attributes: { body: 15 }, skills: { 开山: 'strike' }, level: 3 },
    沈知微: { skills: { 回春针: 'heal' } },
  },
})
const names = sheet => (sheet.party ?? []).map(member => member.name)
const marked = text => replyMarks(text)

test('the card\'s companions are kept as given, within bounds', () => {
  assert.deepEqual(BOOK.start.party, ['苏挽霜', '温小棠'])
  assert.equal(BOOK.companions.苏挽霜.attributes.grace, 16)
  assert.equal(BOOK.companions.温小棠.attributes.body, 10, 'what is not said is average')
  assert.deepEqual(BOOK.companions.温小棠.skills, { 连珠弩: '' })
  assert.equal(BOOK.companions.楚怀瑾.level, 3)
  const odd = cleanRulebook({ companions: { 怪: { attributes: { body: 99 }, skills: { 乱: 'nonsense' }, level: -2 }, '': {}, 坏: 'x' } })
  assert.deepEqual(Object.keys(odd.companions), ['怪'])
  assert.equal(odd.companions.怪.attributes.body, 20)
  assert.deepEqual(odd.companions.怪.skills, { 乱: '' })
  assert.equal(odd.companions.怪.level, undefined)
  assert.deepEqual(cleanRulebook({}).companions, {})
  assert.equal(cleanRulebook({}).start.party, undefined)
})

test('a companion is known by any name they go by', () => {
  assert.equal(companionOf(BOOK, '霜姐姐').name, '苏挽霜')
  assert.equal(companionOf(BOOK, '温小棠').name, '温小棠')
  assert.equal(companionOf(BOOK, '路人'), null)
})

test('the story starts with the party the card says, as many fighting as can', () => {
  const sheet = startSheet(BOOK)
  assert.deepEqual(names(sheet), ['苏挽霜', '温小棠'])
  assert.deepEqual(sheet.party[0].skills, ['霜落无声', '回风扫叶'])
  assert.equal(sheet.party[0].life, 100)
  assert.equal(fieldedOf(sheet).length, 2)
  const crowd = startSheet({ ...BOOK, start: { party: ['苏挽霜', '温小棠', '楚怀瑾', '沈知微'] } })
  assert.equal(fieldedOf(crowd).length, MAX_FIELDED)
  assert.deepEqual(crowd.party.map(member => member.bench), [false, false, false, true])
  assert.equal(crowd.party[2].level, 3, 'one the card sets a level for starts there')
  assert.deepEqual(startSheet({}).party, [])
})

test('a story from before there were parties gets the card\'s', () => {
  const old = { ...startSheet({}) }
  delete old.party
  assert.deepEqual(names(sheetOf(BOOK, old, {})), ['苏挽霜', '温小棠'])
  assert.deepEqual(sheetOf(BOOK, { ...old, party: [] }, {}).party, [], 'one that has a party, even none, keeps it')
})

test('the marks: who joins, leaves, is hurt and comes back; a skill learned by one of them', () => {
  assert.deepEqual(marked('她点点头。【同伴|加入|楚怀瑾】'), [{ kind: 'party', act: 'join', name: '楚怀瑾' }])
  assert.deepEqual(marked('【同伴|入队|小棠】【同伴|离队|楚怀瑾】【同伴|负伤|挽霜】【同伴|归队|挽霜】').map(mark => mark.act), ['join', 'leave', 'hurt', 'back'])
  assert.deepEqual(marked('【学会|寒江雪|苏挽霜】'), [{ kind: 'learn', name: '寒江雪', who: '苏挽霜' }])
  assert.deepEqual(marked('【学会|寒江雪】'), [{ kind: 'learn', name: '寒江雪' }])
  assert.deepEqual(marked('【同伴|跳舞|楚怀瑾】'), [], 'a mark that makes no sense is left alone')
})

test('a reply\'s marks change the party, and a night\'s rest mends it', () => {
  const sheet = startSheet(BOOK)
  const joined = settleReply(sheet, marked('【同伴|加入|楚怀瑾】【同伴|加入|楚怀瑾】【学会|寒江雪|霜姐姐】'), { book: BOOK })
  assert.deepEqual(names(joined), ['苏挽霜', '温小棠', '楚怀瑾'])
  assert.deepEqual(joined.party[0].skills, ['霜落无声', '回风扫叶', '寒江雪'])
  const stranger = settleReply(joined, marked('【同伴|加入|路人甲】'), { book: BOOK })
  assert.deepEqual(stranger.party.at(-1), { ...memberOf(BOOK, '路人甲'), bench: true })
  assert.deepEqual(stranger.party.at(-1).skills, ['强击'])
  const hurt = settleReply(stranger, marked('【同伴|负伤|小棠】【同伴|离开|路人甲】'), { book: BOOK })
  assert.equal(hurt.party[1].hurt, true)
  assert.deepEqual(names(hurt), ['苏挽霜', '温小棠', '楚怀瑾'])
  assert.deepEqual(fieldedOf(hurt).map(member => member.name), ['苏挽霜', '楚怀瑾'])
  const worn = { ...hurt, party: hurt.party.map(member => ({ ...member, life: 20 })) }
  const morning = settleReply(worn, [], { book: BOOK, newDay: true })
  assert.deepEqual(morning.party.map(member => [member.life, member.hurt]), [[70, false], [70, false], [70, false]])
  assert.equal(settleReply(worn, [], { book: BOOK }).party[1].hurt, true, 'no new day, still hurt')
})

test('the 队伍 window: who fights, who stands by, in what order, and the points of one of them', () => {
  const ops = cleanOps([{ op: 'party', act: 'bench', name: '苏挽霜' }, { op: 'party', act: 'up', name: '温小棠' }, { op: 'party', act: 'hurt', name: '温小棠' }, { op: 'party', act: 'dance', name: '温小棠' }, { op: 'point', id: 'grace', who: '苏挽霜' }])
  assert.deepEqual(ops, [{ op: 'party', act: 'bench', name: '苏挽霜' }, { op: 'party', act: 'up', name: '温小棠' }, { op: 'point', id: 'grace', who: '苏挽霜' }], 'the page cannot hurt anyone')
  const sheet = startSheet(BOOK)
  const { sheet: after, lines, dropped } = applyOps({ ...sheet, party: sheet.party.map(member => ({ ...member, points: 2 })) }, BOOK, ops)
  assert.deepEqual(names(after), ['温小棠', '苏挽霜'])
  assert.deepEqual(after.party.map(member => member.bench), [false, true])
  assert.equal(after.party[1].attributes.grace, 17)
  assert.equal(after.party[1].points, 1)
  assert.deepEqual(lines, ['苏挽霜这次不上场，在队伍里待命', '温小棠在队伍里往前站了一位', '玩家给苏挽霜的灵巧加了 1 点'])
  assert.deepEqual(dropped, [])
  // Three are fighting: a fourth stays standing by.
  const full = startSheet({ ...BOOK, start: { party: ['苏挽霜', '温小棠', '楚怀瑾', '沈知微'] } })
  assert.equal(partyChanged(full, BOOK, 'field', '沈知微'), null)
  assert.equal(partyChanged(full, BOOK, 'join', '苏挽霜'), null, 'one already there does not join twice')
  const swapped = applyOps(full, BOOK, [{ op: 'party', act: 'bench', name: '温小棠' }, { op: 'party', act: 'field', name: '沈知微' }]).sheet
  assert.deepEqual(fieldedOf(swapped).map(member => member.name), ['苏挽霜', '楚怀瑾', '沈知微'])
})

test('a fight is the player and those fielded, against more foes for more of them', () => {
  const sheet = sheetOf(BOOK, startSheet(BOOK), {})
  const gate = { kind: 'battle', foes: [{ name: '黑鹞子', count: 1, tier: 'boss' }, { name: '马贼', count: 2, tier: 'normal' }] }
  const setup = encounterSetup(sheet, BOOK, gate, 'chat', 'node')
  assert.equal(partySize(setup), 3)
  assert.deepEqual(setup.allies.map(ally => ally.name), ['苏挽霜', '温小棠'])
  assert.deepEqual(setup.allies[0].skills, [{ name: '霜落无声', kind: 'strike' }, { name: '回风扫叶', kind: 'sweep' }])
  assert.equal(setup.allies[1].skills[0].kind, 'flurry', 'a skill the card leaves unset goes by its name')
  assert.deepEqual(setup.foes.map(foe => foe.tier), ['boss', 'normal', 'normal'], 'twelve points is not too many for three')
  const alone = encounterSetup({ ...sheet, party: [] }, BOOK, gate, 'chat', 'node')
  assert.equal(alone.allies, undefined)
  assert.deepEqual(alone.foes.map(foe => foe.tier), ['boss', 'minion', 'minion'])
  const hurt = encounterSetup({ ...sheet, party: sheet.party.map((member, i) => ({ ...member, hurt: i === 0 })) }, BOOK, gate, 'chat', 'node')
  assert.deepEqual(hurt.allies.map(ally => ally.name), ['温小棠'])
  assert.deepEqual(alliesFor(sheet, BOOK).map(ally => ally.kinds), [{ 霜落无声: 'strike', 回风扫叶: 'sweep' }, {}])
})

/** A fight played by 自动 to its end, reported the way the page reports it. */
function play(setup) {
  let state = startBattle(setup)
  const actions = []
  while (!state.over) {
    const commands = autoCommands(state)
    actions.push(commands)
    state = step(state, commands).state
  }
  return { over: state.over, attempt: 0, actions }
}

test('a party fight is reported, played again and settled for each of them', () => {
  const sheet = sheetOf(BOOK, startSheet(BOOK), {})
  const gate = { kind: 'battle', foes: [{ name: '马贼', count: 3, tier: 'normal' }] }
  const setup = encounterSetup(sheet, BOOK, gate, 'chat', 'won')
  const report = play(setup)
  assert.equal(report.over, 'won')
  const fight = cleanFight(JSON.parse(JSON.stringify(report)))
  assert.ok(Array.isArray(fight.actions[0]) && fight.actions[0][1].who === 'ally-0')
  const { battle, op } = fightResult(setup, fight)
  assert.deepEqual(battle.party.map(member => member.name), ['苏挽霜', '温小棠'])
  assert.deepEqual(op.party.map(member => member.name), ['苏挽霜', '温小棠'])
  const { sheet: after } = applyOps(sheet, BOOK, [op])
  assert.deepEqual(after.party.map(member => member.life), op.party.map(member => member.life))
  for (const member of after.party) assert.ok(member.experience > 0 || member.level > 1)
  assert.throws(() => fightResult(setup, { ...fight, over: 'lost' }), /does not match/)
})

test('a lost fight leaves the party standing, a little; those who fell get half of a won one', () => {
  const sheet = sheetOf(BOOK, startSheet(BOOK), {})
  const lost = applyOps(sheet, BOOK, [{ op: 'battle', over: 'lost', life: 0, energy: 0, used: {}, experience: 0, party: [{ name: '苏挽霜', life: 0 }, { name: '温小棠', life: 0 }] }]).sheet
  assert.deepEqual(lost.party.map(member => member.life), [30, 30])
  const won = applyOps(sheet, BOOK, [{ op: 'battle', over: 'won', life: 50, energy: 0, used: {}, experience: 60, party: [{ name: '苏挽霜', life: 1, fell: true }, { name: '温小棠', life: 77 }] }]).sheet
  assert.deepEqual(won.party.map(member => [member.life, member.experience]), [[1, 30], [77, 60]])
  assert.equal(won.experience, 60)
})

test('the model is told of the party: who it is, the marks, and what each did in a fight', () => {
  const sheet = sheetOf(BOOK, startSheet(BOOK), {})
  const benched = { ...sheet, party: [...sheet.party, { ...memberOf(BOOK, '楚怀瑾'), hurt: true }, { ...memberOf(BOOK, '沈知微'), bench: true }] }
  const told = gamePrompt({ sheet: benched, pausing: true, fights: true, check: null, companions: true }, []).text
  assert.match(told, /队伍：苏挽霜（生命 100\/100）、温小棠（生命 100\/100）、楚怀瑾（负伤）、沈知微（待命）/)
  assert.match(told, /【同伴\|加入\|名字】/)
  assert.doesNotMatch(gamePrompt({ sheet: { ...sheet, party: [] }, pausing: true, fights: true, check: null }, []).text, /同伴\|加入/, 'no companions, nothing of them')
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true, fights: false, check: null, companions: true }, []).text, /同伴\|加入/, 'no fights, no party rules')
  const battle = { over: 'won', foes: '马贼 ×2', downed: '马贼 ×2', rounds: 4, life: 70, maxLife: 100, used: {}, skills: [], party: [{ name: '苏挽霜', life: 1, maxLife: 100, fell: true, skills: ['霜落无声'] }] }
  const after = gamePrompt({ sheet, pausing: true, fights: true, check: null, battle, companions: true }, []).text
  assert.match(after, /同伴：苏挽霜 生命 1\/100，用过 霜落无声，被打倒过。/)
  assert.match(after, /被打倒过的同伴受了伤/)
})

test('a kit\'s companions become the card\'s, those who start with the player in the party', () => {
  const kit = cleanKit({ companions: [{ name: '苏挽霜', keys: ['挽霜'], attributes: { grace: 18, body: 12 }, skills: [{ name: '霜落无声', kind: 'strike' }, { name: '怪招', kind: 'odd' }] }, { name: '陆砚之', start: false }, { name: '' }] })
  assert.equal(kit.companions.length, 2)
  // Eight points over the average, shared out in order as the player's are: 12 body leaves 6 for grace.
  assert.deepEqual([kit.companions[0].attributes.body, kit.companions[0].attributes.grace], [12, 16])
  assert.deepEqual(kit.companions[0].skills, [{ name: '霜落无声', kind: 'strike' }, { name: '怪招', kind: '' }])
  const book = kitBook(kit)
  assert.deepEqual(book.start.party, ['苏挽霜'])
  assert.deepEqual(book.companions.苏挽霜.skills, { 霜落无声: 'strike', 怪招: '' })
  assert.deepEqual(Object.keys(book.companions), ['苏挽霜', '陆砚之'])
  assert.equal(kitBook(cleanKit({})).companions, undefined)
})

