// 开局: what the way into a fight gives or costs. Read from the last field of 【战斗|…|开局:…】, kept on the fight's
// setup, and laid on its first round; the chance a choice shows is the chance of that fight.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPENING_MOST, autoCommands, cleanOpening, foesOf, partyOf, playerOf, startBattle, step } from '../web/shared/game/battle.js'
import { chanceToWin, encounterSetup, fightResult, playedOut } from '../web/shared/game/encounter.js'
import { gateOf, parseChoice } from '../web/shared/game/marks.js'
import { cleanRulebook, sheetOf } from '../web/shared/game/sheet.js'
import { gamePrompt } from '../server/game.mjs'

const book = cleanRulebook({ level: 'full', skills: { 强击: 'strike' }, start: { skills: ['强击'], things: [], party: ['小焰'] }, companions: { 小焰: { attributes: { body: 12 }, skills: { 火花: 'strike' } } } })
const sheet = sheetOf(book, null, {})
const fightOf = text => parseChoice(text).fight
const setupOf = text => encounterSetup(sheet, book, fightOf(text), 'chat', 'node')

test('开局 is read from the last field of a fight, in the words a model would use', () => {
  assert.deepEqual(fightOf('A. 摸到背后【战斗|狼王:精英|灰狼×2:杂兵|开局:先手、狼王血60】').opening, { first: true, lives: { 狼王: 0.6 } })
  assert.deepEqual(fightOf('B. 硬闯【战斗|灰狼×2|开局：被偷袭，敌血 70%】').opening, { caught: true, life: 0.7 })
  assert.deepEqual(fightOf('C. 先喝药【战斗|狼王:首领:远强|开局: 强化、 破绽】').opening, { open: true, boost: true })
  // The foes are the same with it and without.
  assert.deepEqual(fightOf('A【战斗|狼王:精英|灰狼×2:杂兵|开局:先手】').foes, fightOf('A【战斗|狼王:精英|灰狼×2:杂兵】').foes)
  assert.equal(fightOf('D. 迎战【战斗|灰狼×2:杂兵】').opening, undefined)
  // Nothing the rules know, a foe that is not there, a share that is no share: no 开局 at all.
  assert.equal(fightOf('E【战斗|灰狼|开局:天时地利、虎王血50、敌血100、敌血0】').opening, undefined)
  // 开局 alone is no fight.
  assert.equal(fightOf('F【战斗|开局:先手】'), undefined)
})

test('never more than two of what helps, never a foe under a quarter of its life, and surprise cuts one way only', () => {
  const most = cleanOpening({ first: true, open: true, boost: true, life: 0.5 })
  assert.equal(Object.keys(most).length, OPENING_MOST)
  assert.deepEqual(most, { first: true, open: true })
  assert.deepEqual(cleanOpening({ life: 0.05 }), { life: 0.25 })
  assert.deepEqual(cleanOpening({ lives: { 狼王: 0.1, 灰狼: 1 } }), { lives: { 狼王: 0.25 } })
  assert.equal(cleanOpening({ first: true, caught: true }), null)
  assert.equal(cleanOpening({ life: 1 }), null)
  assert.equal(cleanOpening(null), null)
})

test('the first round is as 开局 says', () => {
  const plain = startBattle(setupOf('A【战斗|狼王:精英|灰狼:杂兵】'))
  const ahead = startBattle(setupOf('A【战斗|狼王:精英|灰狼:杂兵|开局:先手、狼王血60】'))
  const [king, wolf] = foesOf(ahead)
  assert.equal(king.maxLife, foesOf(plain)[0].maxLife)
  assert.equal(king.life, Math.round(king.maxLife * 0.6))
  assert.equal(wolf.life, wolf.maxLife)
  assert.ok(foesOf(ahead).every(foe => foe.stun === 1 && foe.late))
  // The foes lose their turn, and are told to have been slow: after it they act as ever.
  const first = step(ahead, autoCommands(ahead))
  assert.ok(first.events.some(event => event.type === 'stunned' && event.late && event.by === 'foe-0'))
  assert.ok(partyOf(first.state).every(unit => unit.life === unit.maxLife))
  assert.ok(foesOf(first.state).every(foe => !foe.stun && !foe.late))

  const ready = startBattle(setupOf('A【战斗|狼王:精英|开局:强化、破绽】'))
  assert.ok(partyOf(ready).every(unit => unit.boost > 0))
  assert.ok(foesOf(ready).every(foe => foe.open > 0 && foe.openBy > 0))

  const caught = startBattle(setupOf('A【战斗|狼王:精英|开局:被偷袭】'))
  assert.ok(partyOf(caught).every(unit => unit.stun === 1))
  const round = step(caught, autoCommands(caught))
  assert.ok(round.events.some(event => event.type === 'stunned' && event.late && event.by === 'player'))
  assert.ok(foesOf(round.state).every(foe => foe.life === foe.maxLife))
  assert.ok(!playerOf(round.state).stun)
})

test('the chance a choice shows moves with its 开局, and the server settles the same fight', () => {
  const base = '【战斗|狼王:精英:稍强|灰狼×2:普通'
  const chance = text => chanceToWin(setupOf(`A${text}`))
  const plain = chance(`${base}】`)
  assert.ok(chance(`${base}|开局:先手、敌血50】`) > plain)
  assert.ok(chance(`${base}|开局:被偷袭】`) < plain)
  // What the page played is what the server plays again: the setup comes from the same mark.
  const setup = setupOf(`A${base}|开局:先手、敌血50】`)
  const played = playedOut(setup)
  assert.equal(fightResult(setup, played).op.over, played.over)
})

test('a reply that stops on a fight can carry 开局 too, and the model is told of it with the fights', () => {
  assert.deepEqual(gateOf('黑影扑了过来。【战斗|刺客:精英|开局:被偷袭】').opening, { caught: true })
  assert.match(gamePrompt({ sheet, pausing: true, fights: true, check: null }, []).text, /开局:先手/)
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true, fights: false, check: null }, []).text, /开局:/)
  // A chat whose copy of the rules is from before 开局 is sent them again.
  const old = gamePrompt({ sheet, pausing: true, fights: true, check: null }, []).text.replace(/\|开局:/g, '')
  assert.match(gamePrompt({ sheet, pausing: true, fights: true, check: null }, [{ role: 'user', prompt: old }]).text, /开局:先手/)
})
