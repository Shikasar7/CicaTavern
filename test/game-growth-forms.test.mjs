// 成长的最后几样 (plans/16, plans/17 S5): a 天赋 that teaches a skill, what a card has a 突破 bring, the companions'
// 大天赋, and 形态: a chain of forms for one of the party, come to for good or taken for one fight.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoAction, battleSetup, fieldFoes, playerOf, refusal, shiftCost, skillsOf, startBattle, step } from '../web/shared/game/battle.js'
import { encounterSetup, fightResult } from '../web/shared/game/encounter.js'
import { FORM_BUDGET, PLAYER_FORMS, bigsOwed, bonusOf, cleanForms, cleanGrowth, cleanPerks, fightOnly, formAt, formForFight, formNeeds, formOf, formReady, nextForm, formsAsk, formsTold, perkEveryOf, perksAsk, perksOwed, rankGives, stageOf, usualGrowth } from '../web/shared/game/growth.js'
import { replyMarks } from '../web/shared/game/marks.js'
import { DEFAULT_WORDS, alliesFor, applyOps, cleanKit, cleanOps, cleanRulebook, grownSheet, kitBook, levelNeeds, playerGrowth, settleReply, sheetOf } from '../web/shared/game/sheet.js'
import { gamePrompt, suggestRequest } from '../server/game.mjs'

const RANKS = ['成长期', '成熟期', '完全体']
const book = (more = {}) => cleanRulebook({ level: 'full', growth: { level: 'rich', ...(more.growth ?? {}) }, ranks: RANKS, ...more, ...(more.growth ? { growth: { level: 'rich', ...more.growth } } : {}) })
const at = (rules, level, more = {}) => ({ ...sheetOf(rules, null, {}), level, ...more })
const expTo = (rules, from, to) => Array.from({ length: to - from }, (_, i) => levelNeeds(from + i, rules)).reduce((sum, need) => sum + need, 0)

// ── 天赋给一个技能 ────────────────────────────────────────────────────
const TEACH = [
  { name: '剑心通明', note: '悟出一式', skill: { name: '一剑西来', kind: 'finish' }, effects: [{ id: 'crit', size: 'small' }, { id: 'attack', size: 'large' }] },
  { name: '只会一招', note: '', skill: '回风拂柳' },
  { name: '破境剑意', note: '', big: true, skill: { name: '万剑归宗', kind: 'sweep' }, effects: [{ id: 'attack', size: 'medium' }] },
]

test('a 天赋 may teach a skill: it takes two of its points, and the card knows the skill\'s kind from then on', () => {
  const perks = cleanPerks(TEACH)
  assert.deepEqual(perks[0], { name: '剑心通明', note: '悟出一式', effects: [{ id: 'crit', size: 'small' }], skill: '一剑西来', skillKind: 'finish' }, 'one point is left for effects')
  assert.deepEqual(perks[1], { name: '只会一招', note: '', effects: [], skill: '回风拂柳' }, 'a skill alone is a 天赋')
  assert.deepEqual(perks[2].effects, [{ id: 'attack', size: 'medium' }], 'a 大天赋 has two left')
  const rules = book({ perks: TEACH, skills: { 一剑西来: 'strike' } })
  assert.equal(rules.skills['一剑西来'], 'strike', 'what the card set itself stays')
  assert.equal(rules.skills['万剑归宗'], 'sweep')
  assert.deepEqual(cleanRulebook(rules), rules, 'cleaned again it is the same')
  assert.match(perksAsk(), /"skill": \{"name"/)
})

test('taking it teaches the skill at once, to the player and to a companion alike; the skills everybody has are not lost for it', () => {
  const rules = book({ perks: TEACH, companions: { 阿青: { attributes: { grace: 14 }, skills: { 越女剑: 'strike' } } }, start: { party: ['阿青'] }, growth: { companions: 'manual' } })
  const start = at(rules, 3)
  assert.deepEqual(start.skills, [])
  const taken = applyOps(start, rules, cleanOps([{ op: 'perk', key: '剑心通明' }])).sheet
  assert.deepEqual(taken.skills, ['强击', '横扫', '一剑西来'])
  assert.equal(encounterSetup(taken, rules, { foes: [{ name: '贼', count: 1, tier: 'normal' }] }, 'c', 'n').player.skills.find(skill => skill.name === '一剑西来').kind, 'finish')
  const friend = applyOps({ ...start, party: start.party.map(member => ({ ...member, level: 3 })) }, rules, cleanOps([{ op: 'perk', key: '只会一招', who: '阿青' }])).sheet.party[0]
  assert.deepEqual(friend.skills, ['越女剑', '回风拂柳'])
  assert.deepEqual(grownSheet(taken, rules).skills, taken.skills, 'once')
})

// ── 里程碑：这张卡的突破给什么 ────────────────────────────────────────
test('a card says how often a 天赋 comes and what a 突破 brings; said nothing, it is as it was', () => {
  assert.deepEqual(cleanGrowth({ level: 'rich', perkEvery: 3, rankPoints: 0, rankBig: true, rankSkills: false }), { level: 'rich' })
  assert.deepEqual(cleanGrowth({ level: 'rich', perkEvery: 2, rankPoints: 9, rankBig: false, rankSkills: true }), { level: 'rich', perkEvery: 2, rankBig: false, rankPoints: 4, rankSkills: true })
  assert.equal(cleanGrowth({ level: 'rich', perkEvery: 7 }).perkEvery, undefined)
  const plain = book()
  assert.equal(perkEveryOf(plain), 3)
  assert.deepEqual(rankGives(plain), { big: true, points: 0, skills: false })
  const quick = book({ growth: { perkEvery: 2 } })
  assert.equal(perksOwed(at(quick, 4), quick), 2)
  assert.equal(perksOwed(at(plain, 4), plain), 1)
  assert.ok(usualGrowth(7, quick).deal > usualGrowth(7, plain).deal, 'foes follow a card that gives more')
})

test('a 突破 brings the points and the stages the card says, and no 大天赋 where it says none', () => {
  const rules = book({ growth: { rankPoints: 2, rankSkills: true, rankBig: false }, skills: { 火球: 'strike' }, start: { skills: ['火球'] } })
  const start = at(rules, 4, { mastery: { 火球: 5 } })
  const grown = applyOps(start, rules, [{ op: 'grow', experience: expTo(rules, 4, 5) }]).sheet
  assert.equal(grown.level, 5)
  assert.equal(grown.points, 2 + 2, 'a level\'s two and the card\'s two')
  assert.equal(stageOf(grown.mastery['火球']), 3, 'a stage further')
  assert.equal(bigsOwed(grown, rules), 0)
  assert.equal(grown.bigs, undefined)
  const within = applyOps(at(rules, 2, { mastery: { 火球: 5 } }), rules, [{ op: 'grow', experience: expTo(rules, 2, 3) }]).sheet
  assert.equal(within.points, 2, 'a level within a rank brings only its own')
  assert.equal(stageOf(within.mastery['火球']), 2)
})

// ── 同伴的大天赋 ──────────────────────────────────────────────────────
test('a companion who crosses a rank has a 大天赋 too: chosen for them, or theirs to be chosen where the card leaves it to the player', () => {
  const companions = { 阿青: { attributes: { grace: 14 }, skills: { 越女剑: 'strike' } } }
  const auto = book({ companions, start: { party: ['阿青'] } })
  const won = { op: 'battle', over: 'won', life: 100, energy: 30, used: {}, experience: expTo(auto, 4, 5), party: [{ name: '阿青', life: 100 }] }
  const grown = applyOps({ ...at(auto, 4), party: at(auto, 4).party.map(member => ({ ...member, level: 4 })) }, auto, [won]).sheet.party[0]
  assert.equal(grown.level, 5)
  assert.equal(grown.bigs, 1)
  assert.equal(bigsOwed(grown, auto), 0, 'chosen already')
  assert.equal(grown.perks.length, 2, 'the one of the third level and the big one')
  const manual = book({ companions, start: { party: ['阿青'] }, growth: { companions: 'manual' } })
  const waiting = applyOps({ ...at(manual, 4), party: at(manual, 4).party.map(member => ({ ...member, level: 4 })) }, manual, [won]).sheet
  assert.equal(bigsOwed(waiting.party[0], manual), 1)
  const chosen = applyOps(waiting, manual, cleanOps([{ op: 'perk', key: '#titan', who: '阿青' }])).sheet.party[0]
  assert.ok(chosen.perks.includes('#titan'))
  assert.equal(bigsOwed(chosen, manual), 0)
  const skipped = applyOps(waiting, manual, cleanOps([{ op: 'perk', skip: true, big: true, who: '阿青' }])).sheet.party[0]
  assert.equal(skipped.bigSkips, 1)
})

// ── 形态 ──────────────────────────────────────────────────────────────
const FORMS = {
  火芽兽: [
    { name: '火芽兽', stage: '成长期', skills: { 小型火焰: 'strike' } },
    { name: '炎角兽', stage: '成熟期', at: { level: 3, bond: 1 }, effects: [{ id: 'attack', size: 'large' }, { id: 'life', size: 'medium' }], skills: { 超级火焰: 'sweep' } },
    { name: '钢角兽', stage: '完全体', at: { level: 9, item: '勇气徽章' }, temp: true, effects: [{ id: 'attack', size: 'large' }, { id: 'guard', size: 'large' }], skills: { 盖亚能量炮: 'finish' } },
  ],
  玩家: [{ name: '凡人' }, { name: '假面形态', temp: true, effects: [{ id: 'attack', size: 'large' }, { id: 'guard', size: 'small' }], skills: { 骑士踢: 'finish' } }],
  只有一个: [{ name: '孤零零' }],
}
const MONSTERS = book({ forms: FORMS, companions: { 火芽兽: { attributes: { body: 14 }, skills: { 利爪: 'strike' } } }, start: { party: ['火芽兽'], things: [{ name: '勇气徽章', count: 1 }] } })

test('a card\'s 形态: chains of two and more, each form with as many points as it is far along, the player\'s under their own key', () => {
  const forms = cleanForms(FORMS)
  assert.deepEqual(Object.keys(forms), ['火芽兽', PLAYER_FORMS])
  assert.deepEqual(forms['火芽兽'][0], { name: '火芽兽', stage: '成长期', effects: [], skills: { 小型火焰: 'strike' } })
  assert.deepEqual(forms['火芽兽'][1].at, { level: 3, bond: 1 })
  assert.deepEqual(forms['火芽兽'][2].effects, [{ id: 'attack', size: 'large' }, { id: 'guard', size: 'large' }], 'six points for the third')
  assert.deepEqual(cleanForms({ 甲: [{ name: '一' }, { name: '二', effects: [{ id: 'attack', size: 'large' }, { id: 'guard', size: 'large' }] }] })['甲'][1].effects, [{ id: 'attack', size: 'large' }, { id: 'guard', size: 'small' }], 'four for the second')
  assert.equal(forms[PLAYER_FORMS][1].temp, true)
  assert.equal(forms['火芽兽'][0].temp, undefined)
  assert.deepEqual(FORM_BUDGET, [2, 4, 6, 8])
  assert.deepEqual(cleanRulebook(MONSTERS), MONSTERS)
  assert.equal(MONSTERS.skills['盖亚能量炮'], 'finish', 'a form\'s skills are the card\'s')
  assert.equal(cleanRulebook({ level: 'full' }).forms, undefined)
  assert.equal(DEFAULT_WORDS.form, '形态')
  assert.equal(DEFAULT_WORDS.evolve, '进化')
})

test('one starts in the first form with its skills; the next is come to when all it asks for is met, and only its own effects count', () => {
  const start = at(MONSTERS, 1)
  const agu = start.party[0]
  assert.equal(formAt(agu, MONSTERS), 0)
  assert.deepEqual(agu.skills, ['利爪', '小型火焰'])
  assert.deepEqual(formNeeds(MONSTERS.forms['火芽兽'][1], agu, start.things), [{ kind: 'level', need: 3, met: false }, { kind: 'bond', need: 1, met: false }])
  assert.equal(formReady(agu, MONSTERS, start.things), null)
  assert.deepEqual(applyOps(start, MONSTERS, cleanOps([{ op: 'form', who: '火芽兽' }])).dropped.length, 1, 'not yet')
  const ready = { ...start, party: [{ ...agu, level: 3, bond: 3 }] }
  assert.equal(formReady(ready.party[0], MONSTERS, ready.things).name, '炎角兽')
  const done = applyOps(ready, MONSTERS, cleanOps([{ op: 'form', who: '火芽兽' }]))
  const grey = done.sheet.party[0]
  assert.equal(grey.form, '炎角兽')
  assert.equal(grey.name, '火芽兽', 'who they are stays')
  assert.deepEqual(grey.skills, ['利爪', '超级火焰'], 'the skill of the form left goes, the new one comes')
  assert.match(done.lines[0], /火芽兽进化成了「炎角兽」（成熟期）/)
  assert.equal(bonusOf(grey, MONSTERS).attack, bonusOf({ ...grey, form: undefined }, MONSTERS).attack + 0.1)
  assert.ok(grey.maxLife > ready.party[0].maxLife, 'more life at once')
  assert.equal(formOf(grey, MONSTERS).stage, '成熟期')
  // The third asks for a level and a thing in the bag.
  assert.deepEqual(formNeeds(MONSTERS.forms['火芽兽'][2], { ...grey, level: 9 }, start.things).map(need => need.met), [true, true])
  assert.equal(formReady({ ...grey, level: 9 }, MONSTERS, []), null, 'not without the thing')
  // One with no conditions is the story's alone to give.
  assert.equal(formReady(start, MONSTERS, start.things), null)
})

test('【进化】 puts one of the party into a form of their chain whatever it asks, and back to the first', () => {
  assert.deepEqual(replyMarks('他变了。【进化|火芽兽|炎角兽】'), [{ kind: 'form', who: '火芽兽', name: '炎角兽' }])
  assert.deepEqual(replyMarks('【进化|假面形态】'), [{ kind: 'form', name: '假面形态' }])
  const start = at(MONSTERS, 1)
  const after = settleReply(start, replyMarks('【进化|火芽兽|炎角兽】'), { book: MONSTERS, ranks: RANKS })
  assert.equal(after.party[0].form, '炎角兽')
  assert.deepEqual(after.party[0].skills, ['利爪', '超级火焰'])
  const unnamed = settleReply(start, replyMarks('【进化|钢角兽】'), { book: MONSTERS, ranks: RANKS })
  assert.equal(unnamed.party[0].form, '钢角兽', 'whoever has a form by that name')
  const back = settleReply(after, replyMarks('【进化|火芽兽|火芽兽】'), { book: MONSTERS, ranks: RANKS })
  assert.equal(back.party[0].form, undefined)
  assert.deepEqual(back.party[0].skills, ['利爪', '小型火焰'])
  const hero = settleReply(start, replyMarks('【进化|假面形态】'), { book: MONSTERS, ranks: RANKS })
  assert.equal(hero.form, '假面形态')
  assert.deepEqual(hero.skills, ['强击', '横扫', '骑士踢'])
  assert.equal(settleReply(start, replyMarks('【进化|火芽兽|没有的】'), { book: MONSTERS, ranks: RANKS }).party[0].form, undefined)
})

test('临时进化: the next form, where the card lets it, is taken for one fight at a cost, and the sheet is as it was after', () => {
  const start = at(MONSTERS, 1)
  assert.equal(alliesFor(start, MONSTERS)[0].shift, undefined, 'the companion\'s next is not for a fight')
  const shift = playerGrowth(start, MONSTERS).shift
  assert.equal(shift.name, '假面形态')
  assert.deepEqual(shift.names, ['强击', '横扫', '骑士踢'])
  assert.equal(shift.bonus.attack, 0.1)
  const setup = encounterSetup(start, MONSTERS, { foes: [{ name: '怪人', count: 1, tier: 'boss' }] }, 'c', 'n')
  assert.equal(setup.player.shift.skills.at(-1).kind, 'finish')
  const state = startBattle(setup)
  const hurt = { ...state, units: state.units.map(unit => (unit.id === 'player' ? { ...unit, life: 50 } : unit)) }
  assert.equal(refusal(hurt, { who: 'player', kind: 'shift' }), null)
  assert.equal(refusal(hurt, { who: 'ally-0', kind: 'shift' }), 'unknown')
  assert.deepEqual(autoAction(hurt, 'player'), { who: 'player', kind: 'shift' }, '自动 takes it against a 首领')
  const cost = shiftCost(playerOf(hurt))
  assert.equal(cost, 18)
  const { state: after, events } = step(hurt, [{ who: 'player', kind: 'shift' }, { who: 'ally-0', kind: 'guard' }])
  const me = playerOf(after)
  const told = events.find(event => event.type === 'shift')
  assert.deepEqual({ by: told.by, name: told.name, heal: told.heal }, { by: 'player', name: '假面形态', heal: 25 })
  assert.equal(me.shifted, '假面形态')
  assert.equal(me.shift, undefined)
  assert.equal(me.bonus.attack, 0.1)
  assert.ok(me.boost > 0, 'and a few rounds of hitting harder')
  assert.ok(events.findIndex(event => event.type === 'hit' && (event.by ?? 'player') === 'player') > events.indexOf(told), 'and a blow with it')
  assert.ok(skillsOf(after).some(skill => skill.name === '骑士踢'))
  assert.equal(refusal(after, { who: 'player', kind: 'shift' }), 'unknown', 'once')
  const poor = { ...state, units: state.units.map(unit => (unit.id === 'player' ? { ...unit, energy: cost - 1 } : unit)) }
  assert.equal(refusal(poor, { who: 'player', kind: 'shift' }), 'energy')
  // A fight played through with it says so, and leaves the sheet in the form it was.
  const actions = []
  let now = startBattle(setup)
  while (!now.over && actions.length < 60) {
    const commands = [autoAction(now, 'player'), ...(now.units.find(unit => unit.id === 'ally-0').life > 0 ? [autoAction(now, 'ally-0')] : [])].filter(command => now.units.find(unit => unit.id === command.who).life > 0)
    actions.push(commands)
    now = step(now, commands).state
  }
  const result = fightResult(setup, { over: now.over, actions })
  assert.deepEqual(result.battle.shifted, [{ form: '假面形态' }])
  const settled = applyOps(start, MONSTERS, [result.op]).sheet
  assert.equal(settled.form, undefined)
  assert.deepEqual(settled.skills, start.skills)
})

test('a form for a fight only, put between two stages, does not stand in the way of the second', () => {
  const rules = book({ forms: { 炽芽: [{ name: '炽芽' }, { name: '超频炽芽', temp: true, effects: [{ id: 'attack', size: 'medium' }] }, { name: '炎尾蜥', at: { level: 3 }, effects: [{ id: 'attack', size: 'large' }] }] }, companions: { 炽芽: { attributes: {}, skills: { 芽火: 'strike' } } }, start: { party: ['炽芽'] } })
  const start = at(rules, 3)
  const bud = { ...start.party[0], level: 3 }
  assert.equal(fightOnly(rules.forms['炽芽'][1]), true)
  assert.equal(nextForm(bud, rules).name, '炎尾蜥')
  assert.equal(formForFight(bud, rules).name, '超频炽芽')
  assert.equal(formReady(bud, rules, []).name, '炎尾蜥')
  const grown = applyOps({ ...start, party: [bud] }, rules, cleanOps([{ op: 'form', who: '炽芽' }])).sheet.party[0]
  assert.equal(grown.form, '炎尾蜥')
  assert.equal(formForFight(grown, rules), null, 'the one for a fight was the first stage\'s')
  assert.equal(nextForm(grown, rules), null)
})

test('a card with no 形态 sets a fight up as it did, and one that does not count growth has none', () => {
  const plain = book()
  const setup = encounterSetup(at(plain, 1), plain, { foes: [{ name: '贼', count: 1, tier: 'normal' }] }, 'c', 'n')
  assert.equal(setup.player.shift, undefined)
  const off = cleanRulebook({ level: 'full', forms: FORMS, companions: MONSTERS.companions, start: { party: ['火芽兽'] } })
  assert.equal(formOf(at(off, 1).party[0], off), null)
  assert.deepEqual(at(off, 1).party[0].skills, ['利爪'])
  assert.equal(formsTold(at(off, 1), off), null)
})

test('the models are told: who writes a card\'s rules is asked for 形态, who tells the story knows the forms and the mark', () => {
  assert.match(formsAsk(), /"forms"/)
  assert.ok(suggestRequest({ description: '电子兽', book: { entries: [] } }, []).messages[0].content.includes(formsAsk()))
  const kit = cleanKit({ forms: FORMS, perks: TEACH })
  assert.deepEqual(Object.keys(kitBook(kit).forms), ['火芽兽', PLAYER_FORMS])
  assert.equal(cleanKit({}).forms, undefined)
  const sheet = at(MONSTERS, 1)
  const told = formsTold(sheet, MONSTERS)
  assert.deepEqual(told.now, ['玩家现在是凡人', '火芽兽现在是火芽兽（成长期）'])
  assert.deepEqual(told.story, [], 'a form for a fight only is not for the story to give')
  const lone = book({ forms: { 玩家: [{ name: '凡人' }, { name: '觉醒者', effects: [{ id: 'attack', size: 'medium' }] }] } })
  assert.deepEqual(formsTold(at(lone, 1), lone).story, ['玩家的觉醒者'])
  assert.match(gamePrompt({ sheet: at(lone, 1), ranks: RANKS, pausing: true, fights: true, forms: formsTold(at(lone, 1), lone) }, []).text, /玩家的觉醒者没有条件可达，只能由你在故事里给/)
  const prompt = gamePrompt({ sheet, ranks: RANKS, pausing: true, fights: true, forms: told, words: { evolve: '变身' } }, []).text
  assert.match(prompt, /【进化\|谁\|形态名】/)
  assert.match(prompt, /火芽兽：火芽兽 → 炎角兽 → 钢角兽/)
  assert.match(prompt, /确实变身了/)
  assert.match(prompt, /形态：玩家现在是凡人、火芽兽现在是火芽兽（成长期）/)
  assert.doesNotMatch(gamePrompt({ sheet, ranks: RANKS, pausing: true, fights: true }, []).text, /进化/)
  const again = gamePrompt({ sheet, ranks: RANKS, pausing: true, fights: true, forms: told, battle: { over: 'won', foes: '怪人', downed: '怪人', rounds: 3, life: 80, maxLife: 100, used: {}, skills: [], shifted: [{ form: '假面形态' }, { who: '火芽兽', form: '炎角兽' }] } }, []).text
  assert.match(again, /玩家临时变成了假面形态，火芽兽临时变成了炎角兽/)
})
