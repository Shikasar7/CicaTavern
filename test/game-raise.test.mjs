// 养成 (web/shared/game/raise.js): creatures raised as ones of their own.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, cleanOps, cleanRulebook, dexKnown, dexOf, formWrites, grownSheet, joinedByTable, knowsOf, leftOut, levelNeeds, luresOf, memberOf, partyChanged, settleReply, startSheet } from '../web/shared/game/sheet.js'
import { cleanFight, encounterSetup, fightResult, playedOut } from '../web/shared/game/encounter.js'
import { NATURES, TALENTS, bornAttributes, born, catchUp, foeGrown, foeLevel, grownBy, liftOf, raisedPower, raisesOn, speciesOf, wildLevel } from '../web/shared/game/raise.js'
import { tameTry } from '../web/shared/game/battle.js'
import { gamePrompt } from '../server/game.mjs'

const RANKS = ['幼生期', '成长期', '统领级', '君王级', '神话级']
const book = (more = {}) => cleanRulebook({
  level: 'full',
  tame: true,
  ranks: RANKS,
  growth: { level: 'standard', raise: true },
  companions: { 小豹: { attributes: { body: 11, grace: 15, mind: 11, charm: 11 }, skills: { 突袭: 'strike' } } },
  start: { party: ['小豹'], rank: '幼生期' },
  foes: {
    鬣狗: { moves: ['撕咬', '猛扑'], rank: '成长期', attributes: { body: 16, grace: 13, mind: 15, charm: 11 } },
    巨蟒: { moves: ['毒牙', '绞杀', '凝视'], rank: '统领级', attributes: { body: 19, grace: 14, mind: 19, charm: 13 } },
    蛇后: { moves: ['毒牙'], rank: '君王级' },
    野猫: { moves: ['抓挠'] },
  },
  forms: {
    小豹: [{ name: '小豹', stage: '幼生期', effects: [] }, { name: '影豹', stage: '成长期', effects: [{ id: 'speed', size: 'small' }], skills: { 影袭: 'finish' }, attributes: { body: 14, grace: 19, mind: 14, charm: 12 }, at: { level: 5 } }],
    巨蟒: [{ name: '巨蟒', stage: '统领级', effects: [] }, { name: '蛇后', stage: '君王级', effects: [{ id: 'attack', size: 'medium' }], skills: { 千蛇: 'sweep' }, attributes: { body: 23, grace: 17, mind: 23, charm: 14 }, at: { level: 13 } }, { name: '永夜', stage: '神话级', effects: [], at: { level: 17 } }],
  },
  ...more,
})
const at = (rules, more = {}) => ({ ...startSheet(rules), ...more })
const total = who => Object.values(who.attributes).reduce((sum, value) => sum + value, 0)

test('raising is off unless the card says so, and off it is as it was: an average one at the player’s level', () => {
  const plain = book({ growth: { level: 'standard' } })
  assert.equal(raisesOn(plain), false)
  assert.equal(raisesOn(book()), true)
  assert.equal(raisesOn(book({ growth: { level: 'off', raise: true } })), false)
  const one = memberOf(plain, '巨蟒', 3)
  assert.deepEqual(one.attributes, { body: 10, grace: 10, mind: 10, charm: 10 })
  assert.equal(one.level, 3)
  assert.equal(levelNeeds(4, plain), 400)
  assert.ok(levelNeeds(4, book()) < 200)
})

test('a kind has its own attributes and level: the higher its rank, the more of both', () => {
  const rules = book()
  const join = name => partyChanged(at(rules), rules, 'join', name).party.at(-1)
  const [dog, snake] = [join('鬣狗'), join('巨蟒')]
  assert.equal(dog.level, 6)
  assert.equal(snake.level, 10)
  assert.ok(total(snake) > total(dog) + 8)
  assert.ok(raisedPower(snake, rules) > raisedPower(dog, rules) * 1.5)
  // One whose kind the card says nothing of comes at the player's level, by what rank it is said to be of.
  assert.equal(partyChanged(at(rules, { level: 4 }), rules, 'join', '野猫').party.at(-1).level, 4)
  // What the card does not know joins as ever.
  assert.equal(partyChanged(at(rules, { level: 4 }), rules, 'join', '路人').party.at(-1).attributes.body, 10)
  assert.equal(wildLevel(rules, '巨蟒', 1), 14)
  assert.equal(speciesOf(rules, '巨蟒', 2).body > speciesOf(rules, '巨蟒', 1).body, true)
})

test('by a later form’s name it is one of that kind, come to it already', () => {
  const rules = book()
  const queen = partyChanged(at(rules), rules, 'join', '蛇后').party.at(-1)
  assert.equal(queen.name, '巨蟒')
  assert.equal(queen.form, '蛇后')
  assert.equal(queen.level, 14)
  assert.ok(queen.skills.includes('千蛇') && queen.skills.includes('毒牙'))
  // And nobody is there twice.
  assert.equal(partyChanged({ ...at(rules), party: [queen] }, rules, 'join', '巨蟒'), null)
})

test('a nature and a talent are the same for the same seed, and count', () => {
  assert.deepEqual(born('a', 'b'), born('a', 'b'))
  const seen = new Set(Array.from({ length: 200 }, (_, i) => born(i).talent))
  assert.equal(seen.size, TALENTS.length)
  assert.equal(TALENTS.reduce((sum, item) => sum + item.odds, 0), 100)
  const rules = book()
  const plain = bornAttributes(rules, '巨蟒', 0, { nature: 'body-charm', talent: 'plain' })
  assert.equal(plain.body, 21)
  assert.equal(plain.charm, 12)
  const best = bornAttributes(rules, '巨蟒', 0, { nature: 'body-charm', talent: 'peerless' })
  assert.equal(Object.values(best).reduce((a, b) => a + b) - Object.values(plain).reduce((a, b) => a + b), 9)
  assert.equal(new Set(NATURES.map(item => item.id)).size, 12)
})

test('one caught in a fight comes at the level it was met at, as it was born', () => {
  const rules = book()
  let sheet = at(rules, { level: 9, attributes: { body: 20, grace: 20, mind: 20, charm: 20 } })
  sheet = grownSheet({ ...sheet, party: sheet.party.map(member => ({ ...member, level: 9 })) }, rules)
  let got = null
  for (let i = 0; i < 60 && !got; i++) {
    const setup = encounterSetup(sheet, rules, { foes: [{ name: '巨蟒', tier: 'normal', power: '统领级', count: 1 }] }, 'chat', `n${i}`)
    assert.equal(setup.foes[0].level, 9)
    const { op, battle } = fightResult(setup, { ...playedOut(setup), tame: '巨蟒' })
    if (op.tamed) got = { op, battle, setup }
  }
  assert.ok(got, 'nobody was caught in sixty fights')
  assert.equal(got.op.caught.level, 9)
  assert.equal(got.battle.tame.rank, '统领级')
  const told = gamePrompt({ sheet, pausing: true, fights: true, battle: got.battle }, []).text
  assert.match(told, /它是统领级，9 级，性格.{2}，资质.{2}；变量里记它的阶位和属性照这里写/)
  assert.deepEqual({ nature: got.op.caught.nature, talent: got.op.caught.talent }, born(got.setup.seed, '巨蟒'))
  const after = applyOps(sheet, rules, [got.op]).sheet.party.find(member => member.name === '巨蟒')
  assert.equal(after.nature, got.op.caught.nature)
  assert.ok(after.level >= 9)
  // Once there, it (in any of its forms) cannot be tried for again.
  const again = encounterSetup(applyOps(sheet, rules, [got.op]).sheet, rules, { foes: [{ name: '蛇后', tier: 'normal', power: '君王级', count: 1 }] }, 'chat', 'x')
  assert.ok(again.tame.have.includes('蛇后'))
})

test('evolving changes what it is made of for good, keeps what was grown and learnt, and makes it whole', () => {
  const rules = book()
  const snake = { ...partyChanged(at(rules), rules, 'join', '巨蟒', { caught: { level: 13, nature: 'body-charm', talent: 'plain' } }).party.at(-1), life: 12 }
  const sheet = grownSheet({ ...at(rules), party: [snake] }, rules)
  const { sheet: after } = applyOps(sheet, rules, cleanOps([{ op: 'form', who: '巨蟒' }]))
  const [was, now] = [sheet.party[0], after.party[0]]
  assert.equal(now.form, '蛇后')
  assert.equal(now.attributes.body - was.attributes.body, 4)
  assert.equal(now.attributes.mind - was.attributes.mind, 4)
  assert.equal(now.life, now.maxLife)
  assert.ok(['毒牙', '绞杀', '凝视', '千蛇'].every(name => now.skills.includes(name)))
  assert.ok(raisedPower(now, rules) > raisedPower(was, rules) * 1.1)
  // The story's own mark does the same, and back again is as it was.
  const back = settleReply(after, [{ kind: 'form', who: '巨蟒', name: '巨蟒' }], { book: rules }).party[0]
  assert.deepEqual(back.attributes, was.attributes)
  // A form the card gave nothing: more than the one before all the same.
  const last = settleReply(after, [{ kind: 'form', who: '巨蟒', name: '永夜' }], { book: rules }).party[0]
  assert.ok(total(last) > total(now))
})

test('each earns for itself: those who stand by half, the young more, and all grow as their kind does', () => {
  const rules = book()
  let sheet = partyChanged(at(rules, { level: 5 }), rules, 'join', '鬣狗', { caught: { level: 5, nature: 'body-charm', talent: 'plain' } })
  sheet = partyChanged(sheet, rules, 'join', '野猫', { caught: { level: 5, nature: 'body-charm', talent: 'plain' } })
  sheet = grownSheet({ ...sheet, party: sheet.party.map(member => (member.name === '野猫' ? { ...member, bench: true } : member)) }, rules)
  const op = { op: 'battle', over: 'won', life: 90, energy: 30, used: {}, experience: 40, party: [{ name: '小豹', life: 50 }, { name: '鬣狗', life: 50, fell: true }] }
  const { sheet: after } = applyOps(sheet, rules, [op])
  const by = Object.fromEntries(after.party.map(member => [member.name, member]))
  // 小豹 is at 1 and the player at 5: twice as much and more, and levels of it.
  assert.ok(by.小豹.level > 1)
  assert.ok(total(by.小豹) > total(sheet.party[0]))
  assert.equal(by.小豹.points, 0)
  assert.equal(by.鬣狗.experience, 20)
  assert.equal(by.野猫.experience, 20)
  assert.equal(catchUp(5, 5), 1)
  assert.ok(catchUp(1, 5) > 2 && catchUp(9, 5) < 0.6)
  const lost = applyOps(sheet, rules, [{ ...op, over: 'lost' }]).sheet
  assert.equal(lost.party.find(member => member.name === '野猫').experience, 0)
})

test('levels apart from the player’s count in a fight, as far as they are heeded', () => {
  assert.equal(liftOf(5, 5), null)
  const [above, far, bonded, below] = [liftOf(7, 5), liftOf(20, 5), liftOf(20, 5, 2), liftOf(1, 9)]
  assert.ok(above.deal > 1.3 && above.take < 0.8)
  assert.deepEqual(far, liftOf(11, 5))
  assert.ok(bonded.deal > far.deal)
  assert.ok(below.deal < 0.7 && below.take > 1.2)
  const rules = book()
  const sheet = partyChanged(at(rules, { party: [] }), rules, 'join', '巨蟒')
  const setup = encounterSetup(sheet, rules, { foes: [{ name: '鬣狗', tier: 'normal', power: '成长期', count: 1 }] }, 'c', 'n')
  assert.deepEqual(setup.allies[0].lift, liftOf(10, 1))
  assert.equal(encounterSetup(sheet, book({ growth: { level: 'standard' } }), { foes: [{ name: '鬣狗', tier: 'normal', power: '成长期', count: 1 }] }, 'c', 'n').allies[0].lift, undefined)
  // A foe has a level of its own, and more of everything for it.
  assert.equal(foeLevel(rules, { rank: '统领级', tier: 'boss' }), 11)
  assert.equal(foeLevel(rules, { rank: '统领级巅峰', tier: 'boss' }), 12)
  assert.equal(foeLevel(rules, { tier: 'boss' }), null)
  assert.ok(foeGrown(12).life > foeGrown(5).life && foeGrown(5).damage > 1)
  assert.equal(foeGrown(1), null)
})

test('a full party: the next is boarded out, fetched, left behind, let go of', () => {
  const rules = book()
  const names = ['鬣狗', '巨蟒', '野猫']
  let sheet = at(rules, { party: Array.from({ length: 6 }, (_, i) => ({ ...memberOf(rules, '小豹'), name: `伙伴${i}`, bench: true })) })
  for (const name of names) sheet = partyChanged(sheet, rules, 'join', name)
  assert.equal(sheet.party.length, 8)
  assert.deepEqual(sheet.box.map(member => member.name), ['野猫'])
  assert.equal(partyChanged(sheet, rules, 'fetch', '野猫'), null)
  const ops = cleanOps([{ op: 'party', act: 'store', name: '鬣狗' }, { op: 'party', act: 'fetch', name: '野猫' }])
  const done = applyOps(sheet, rules, ops)
  assert.deepEqual(done.sheet.box.map(member => member.name), ['鬣狗'])
  assert.ok(done.sheet.party.some(member => member.name === '野猫'))
  assert.match(gamePrompt({ sheet: done.sheet, pausing: true, fights: true, companions: true }, []).text, /寄养着、不在身边的：鬣狗/)
  assert.match(gamePrompt({ sheet: done.sheet, pausing: true, fights: true, companions: true }, []).text, /巨蟒（10 级/)
  assert.deepEqual(partyChanged(done.sheet, rules, 'leave', '鬣狗').box, [])
  assert.equal(partyChanged(at(book({ growth: { level: 'standard' } })), book({ growth: { level: 'standard' } }), 'store', '小豹'), null)
})

test('one new in the card’s own table comes in the form its row says, at that form’s level', () => {
  const rules = book({ bindings: { party: '魔宠' } })
  const before = { 魔宠: { 小豹: { 阶位: '幼生期' } } }
  const after = { 魔宠: { 小豹: { 阶位: '幼生期' }, 巨蟒: { 阶位: '君王级' } } }
  const snake = joinedByTable(at(rules), rules, before, after).party.find(member => member.name === '巨蟒')
  assert.equal(snake.form, '蛇后')
  assert.equal(snake.level, 14)
})

test('a story from before: those already there get the difference once, what was added by hand kept', () => {
  const plain = book({ growth: { level: 'standard' } })
  const rules = book()
  let sheet = partyChanged(at(plain, { level: 3 }), plain, 'join', '巨蟒')
  sheet = { ...sheet, party: sheet.party.map(member => (member.name === '巨蟒' ? { ...member, attributes: { ...member.attributes, body: 13 }, points: 0 } : { ...member, form: '影豹', level: 6 })) }
  const raised = grownSheet(sheet, rules)
  const snake = raised.party.find(member => member.name === '巨蟒')
  assert.equal(snake.level, 10)
  assert.ok(snake.attributes.body >= 19 + 3 - 1)
  assert.ok(snake.talent && snake.nature)
  assert.ok(snake.skills.includes('绞杀'))
  const panther = raised.party.find(member => member.name === '小豹')
  assert.ok(panther.attributes.grace >= 19)
  assert.equal(panther.level, 6)
  assert.deepEqual(grownSheet(raised, rules).party, raised.party)
})

test('points go to what a kind is best at, by itself', () => {
  const rules = book()
  const { attributes, left } = grownBy(speciesOf(rules, '巨蟒'), 10, rules, '巨蟒')
  assert.equal(left, 0)
  assert.ok(attributes.body + attributes.mind - 38 >= 6)
  assert.ok(attributes.charm - 13 <= 2)
})

test('the rule book keeps what raising needs, and only what is whole', () => {
  const rules = book({ foes: { 甲: { rank: '成长期', attributes: { body: 99, grace: 1, mind: 12, charm: 10 } }, 乙: { attributes: { body: 12 } } } })
  assert.deepEqual(rules.foes.甲.attributes, { body: 40, grace: 6, mind: 12, charm: 10 })
  assert.equal(rules.foes.甲.rank, '成长期')
  assert.equal('attributes' in rules.foes.乙, false)
  assert.equal(rules.forms.巨蟒[1].attributes.body, 23)
  assert.equal(rules.growth.raise, true)
})

test('two change places, wherever they are; one who is hurt takes no place in the fight', () => {
  const rules = book()
  let sheet = at(rules)
  for (const name of ['鬣狗', '巨蟒', '野猫']) sheet = partyChanged(sheet, rules, 'join', name)
  sheet = partyChanged(sheet, rules, 'store', '鬣狗')
  // 小豹、巨蟒 fight (and 野猫, with room for it); 鬣狗 is boarded out.
  const names = one => [one.party.map(member => `${member.name}${member.bench ? '-' : ''}`).join(' '), (one.box ?? []).map(member => member.name).join(' ')]
  assert.deepEqual(names(sheet), ['小豹 巨蟒 野猫-', '鬣狗'])
  const ops = cleanOps([{ op: 'party', act: 'swap', name: '野猫', with: '小豹' }, { op: 'party', act: 'swap', name: '鬣狗', with: '巨蟒' }])
  const done = applyOps(sheet, rules, ops)
  assert.deepEqual(names(done.sheet), ['野猫 鬣狗 小豹-', '巨蟒'])
  assert.deepEqual(done.lines, ['野猫现在出战，小豹现在待命，跟在身边', '鬣狗现在出战，巨蟒现在寄养着，不在身边'])
  const hurt = partyChanged(sheet, rules, 'hurt', '野猫')
  assert.equal(partyChanged(hurt, rules, 'swap', '野猫', { with: '小豹' }), null)
  assert.equal(partyChanged(sheet, rules, 'swap', '野猫', { with: '没有的' }), null)
  assert.equal(partyChanged(sheet, rules, 'swap', '野猫', { with: '野猫' }), null)
})

test('the 图鉴 lists each kind once, and knows what the story has met and had', () => {
  const rules = book({ foes: { 巨蟒: { moves: ['毒牙'], rank: '统领级', where: '断崖' }, 蛇后: { rank: '君王级' }, 鬣狗: { rank: '成长期' }, 野猫: { moves: ['抓挠'] } } })
  assert.equal(rules.foes.巨蟒.where, '断崖')
  // A later form is no kind of its own, and one the card says nothing of is left out.
  assert.deepEqual(dexOf(rules).sort(), ['小豹', '巨蟒', '鬣狗'].sort())
  const path = [{ gate: { foes: [{ name: '蛇后' }] } }, { battle: { foes: '鬣狗A ×2、路人' } }, { game: { party: [{ name: '小豹' }], box: [{ name: '鬣狗' }] } }]
  const { caught, seen } = dexKnown(rules, path, { party: [{ name: '小豹' }] })
  assert.deepEqual([...caught].sort(), ['小豹', '鬣狗'])
  assert.ok(seen.has('巨蟒') && seen.has('鬣狗'))
})

test('one moved in or out of the fight has it written in the card’s own table', () => {
  const rules = book()
  let before = at(rules)
  for (const name of ['鬣狗', '巨蟒', '野猫']) before = partyChanged(before, rules, 'join', name)
  const state = { 魔宠: { 小豹: { 状态: '出战', 阶位: '幼生期' }, 鬣狗: { 状态: '出战' }, 野猫: { 状态: '待命', 来历: '待命' }, 巨蟒: { 状态: '负伤' } } }
  const after = applyOps(before, rules, cleanOps([{ op: 'party', act: 'swap', name: '野猫', with: '小豹' }, { op: 'party', act: 'store', name: '鬣狗' }, { op: 'party', act: 'bench', name: '巨蟒' }])).sheet
  const writes = formWrites(rules, state, before, after)
  assert.deepEqual(writes.filter(one => one.path.endsWith('状态')).map(one => `${one.path}=${one.value}`).sort(), ['/魔宠/小豹/状态=待命', '/魔宠/野猫/状态=出战', '/魔宠/鬣狗/状态=待命'].sort())
  assert.deepEqual(formWrites(rules, state, before, before), [])
  // What the model made of it meanwhile is put right too.
  assert.equal(formWrites(rules, { 魔宠: { 野猫: { 状态: '寄养' } } }, before, after)[0].value, '出战')
})

test('收服道具: one adds to the roll, a large one needs none; each go at the fight has its own, and what was used is gone', () => {
  const rules = book({ items: { 小契印: { type: 'tame', size: 'small' }, 大契石: { type: 'tame', size: 'large' } } })
  const sheet = at(rules, { things: [{ name: '小契印', count: 1 }, { name: '大契石', count: 1 }, { name: '收服网', count: 1 }] })
  assert.deepEqual(luresOf(sheet, rules), [{ name: '小契印', count: 1, size: 'small' }, { name: '大契石', count: 1, size: 'large' }, { name: '收服网', count: 1, size: 'medium' }])
  // Nothing to fight with, and where nothing is tamed the name says nothing.
  const gate = { foes: [{ name: '野猫', count: 1, tier: 'minion' }] }
  const setup = encounterSetup(sheet, rules, gate, 'c', 'n')
  assert.deepEqual(setup.player.things, [])
  assert.deepEqual(luresOf({ things: [{ name: '收服网', count: 1 }] }, book({ tame: false })), [])
  const cat = { name: '野猫', tier: 'minion', gap: 0 }
  const plain = tameTry(setup, cat)
  assert.equal(tameTry(setup, cat, { lure: '小契印' }).modifier, plain.modifier + 3)
  assert.equal(tameTry(setup, cat, { lure: '没有的' }).modifier, plain.modifier)
  const sure = tameTry(setup, { ...cat, gap: 3 }, { lure: '大契石' })
  assert.deepEqual([sure.ok, sure.chance, sure.sure], [true, 100, true])
  const rolls = new Set([0, 1, 2, 3, 4, 5].map(attempt => tameTry(setup, cat, { attempt }).roll))
  assert.ok(rolls.size > 1)
  // Played again after a try that came to nothing: both things are gone, the second one caught it.
  const fight = { ...playedOut(setup), tame: '野猫', lure: '大契石', spent: '小契印' }
  assert.equal(fight.over, 'won')
  const result = fightResult(setup, fight)
  assert.equal(result.battle.tame.ok, true)
  assert.equal(result.battle.tame.lure, '大契石')
  assert.deepEqual(result.op.used, { 小契印: 1, 大契石: 1 })
  const after = applyOps(sheet, rules, [result.op]).sheet
  assert.deepEqual(after.things.map(thing => thing.name), ['收服网'])
  assert.ok(after.party.some(member => member.name === '野猫'))
  // Not more than there is.
  assert.deepEqual(fightResult(setup, { ...fight, spent: '大契石' }).op.used, { 大契石: 1 })
  assert.deepEqual(cleanFight({ over: 'won', actions: [], tame: ' 野猫 ', lure: '大契石', spent: 3 }), { over: 'won', attempt: 0, actions: [], tame: '野猫', lure: '大契石' })
  assert.equal(cleanFight({ over: 'won', actions: [], lure: '大契石' }).lure, undefined)
})

test('who is in the card’s table and not in the party can be put right; a companion the story never came to is nobody to bring in', () => {
  const rules = book({ bindings: { party: '魔宠' }, companions: { 小豹: { skills: { 突袭: 'strike' } }, 小狐: { skills: { 狐火: 'strike' } } } })
  const sheet = at(rules)
  const rows = { $meta: { extensible: true }, 小豹: { 阶位: '幼生期' }, 巨蟒: { 阶位: '君王级' }, 路人: { 阶位: '幼生期' } }
  assert.deepEqual(leftOut(sheet, rules, { 魔宠: rows }), ['蛇后'])
  assert.deepEqual(leftOut(partyChanged(sheet, rules, 'join', '蛇后'), rules, { 魔宠: rows }), [])
  assert.equal(leftOut(sheet, book(), { 魔宠: rows }), null)
  assert.deepEqual(['小豹', '蛇后', '野猫', '123', ''].map(name => knowsOf(rules, name)), [true, true, true, false, false])
})
