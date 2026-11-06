// 游戏规则: a card's own variables as the sheet's fields, the bag in every shape, the turn's operations.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bagChanged, bagItems, cleanBindings, guessBindings, numberAt, numberWrite, questsAt, variablePaths } from '../web/shared/game/bindings.js'
import { replyMarks } from '../web/shared/game/marks.js'
import { visitedPlaces } from '../web/shared/vn.js'
import { ambienceFor, cleanSound, layerLevel, trackFor } from '../web/shared/game/sound.js'
import { applyOps, cleanOps, cleanRulebook, effectOf, keptSheet, nothingToRestore, opWrites, settleReply, sheetOf, startSheet, usableNow } from '../web/shared/game/sheet.js'
import { reachedBy, reachedWith, tallyOf } from '../web/shared/game/achievements.js'

const names = things => things.map(thing => `${thing.name}×${thing.count}`)

test('a bag is read in every shape cards keep one', () => {
  assert.deepEqual(names(bagItems(['绳', '刀', '绳'])), ['绳×2', '刀×1'])
  assert.deepEqual(bagItems([{ 名称: '回春丹', 品质: '上', 效果: '回血' }]), [{ name: '回春丹', count: 1, note: '回血' }])
  assert.deepEqual(names(bagItems([{ name: '绳', count: 3 }, { name: '刀', 数量: 0 }])), ['绳×3'], 'none left is none')
  assert.deepEqual(names(bagItems({ 绳: 2, 刀: [1, '说明'], 药: { 数量: 3, 效果: '回血' }, 信: '给掌柜的', $meta: 1 })), ['绳×2', '刀×1', '药×3', '信×1'])
  assert.deepEqual(names(bagItems('绳、刀，药')), ['绳×1', '刀×1', '药×1'])
  assert.deepEqual(bagItems([]), [])
  assert.deepEqual(bagItems({}), [])
  assert.deepEqual(bagItems(undefined), [])
  assert.equal(bagItems(7), null, 'a number is no bag')
  assert.equal(bagItems([1, 2]), null)
  assert.equal(bagItems([{ 品质: '上' }]), null, 'things with no name')
})

test('a bag changes in the shape it came in, and the original stays', () => {
  const list = ['绳', '刀', '绳']
  assert.deepEqual(bagChanged(list, '绳', -1), ['绳', '刀'])
  assert.deepEqual(bagChanged(list, '药', 2), ['绳', '刀', '绳', '药', '药'])
  assert.deepEqual(list, ['绳', '刀', '绳'])
  const objects = [{ 名称: '药', 数量: 2 }, { 名称: '刀', 数量: 1 }]
  assert.deepEqual(bagChanged(objects, '药', -1), [{ 名称: '药', 数量: 1 }, { 名称: '刀', 数量: 1 }])
  assert.deepEqual(bagChanged(objects, '刀', -1), [{ 名称: '药', 数量: 2 }])
  assert.deepEqual(bagChanged(objects, '绳', 1), [...objects, { 名称: '绳', 数量: 1 }])
  assert.deepEqual(bagChanged(objects, '药', 1)[0], { 名称: '药', 数量: 3 })
  assert.deepEqual(bagChanged([{ 名称: '药', 品质: '上' }, { 名称: '刀' }], '药', -1), [{ 名称: '刀' }], 'no count: the thing itself goes')
  const map = { 绳: 2, 刀: [1, '说明'], 药: { 数量: 3 }, 信: '给掌柜的' }
  assert.equal(bagChanged(map, '绳', -1).绳, 1)
  assert.equal('绳' in bagChanged(map, '绳', -2), false)
  assert.equal('刀' in bagChanged(map, '刀', -1), false)
  assert.deepEqual(bagChanged(map, '刀', 1).刀, [2, '说明'])
  assert.deepEqual(bagChanged(map, '药', -1).药, { 数量: 2 })
  assert.equal('信' in bagChanged(map, '信', -1), false)
  assert.equal(bagChanged(map, '新', 2).新, 2)
  assert.equal(map.绳, 2)
  assert.equal(bagChanged('绳、刀', '绳', -1), '刀')
  assert.equal(bagChanged('绳', '刀', 1), '绳、刀')
  assert.deepEqual(bagChanged(undefined, '绳', 1), ['绳'])
  assert.deepEqual(bagChanged({}, '绳', 1), { 绳: 1 })
  assert.deepEqual(bagChanged([], '绳', 1), ['绳'])
})

test('a changed bag reads back as the change', () => {
  for (const bag of [['药', '药', '刀'], [{ 名称: '药', 数量: 2 }, { 名称: '刀', 数量: 1 }], { 药: 2, 刀: 1 }, { 药: { 数量: 2 }, 刀: { 数量: 1 } }, '药、药、刀']) {
    assert.deepEqual(names(bagItems(bagChanged(bag, '药', -1))).sort(), ['刀×1', '药×1'], JSON.stringify(bag))
    assert.deepEqual(names(bagItems(bagChanged(bag, '绳', 1))).sort(), ['刀×1', '绳×1', '药×2'], JSON.stringify(bag))
  }
})

test('quests are read in the shapes cards keep them', () => {
  assert.deepEqual(questsAt({ 寻找铜钥匙: '掌柜托的', 送信: '已完成' }), [{ title: '寻找铜钥匙', note: '掌柜托的', status: 'new' }, { title: '送信', note: '已完成', status: 'done' }])
  assert.deepEqual(questsAt({ 甲: true, 乙: false }).map(item => item.status), ['done', 'new'])
  assert.deepEqual(questsAt('送信、找钥匙').map(item => item.title), ['送信', '找钥匙'])
  assert.deepEqual(questsAt([{ 名称: '送信', 状态: '失败' }]).map(item => item.status), ['failed'])
  assert.deepEqual(questsAt(undefined), [])
  assert.equal(questsAt(3), null)
})

test('which variables could stand for what, and a first guess by their names', () => {
  const state = { 主角: { 体力: 80, $最大耐力: 120, 内力: [500, '说明'], 背包: [], 银两: 30, 名字: '阿岚' }, 世界: { 体力: 1, 任务: { 送信: '进行中' } } }
  assert.deepEqual(variablePaths({ 甲: { 乙: 1 }, 丙: '字' }), [{ path: '甲', kind: 'list' }, { path: '甲.乙', kind: 'number' }, { path: '丙', kind: 'words' }])
  assert.deepEqual(guessBindings(state), { maxLife: '主角.$最大耐力', life: '主角.体力', energy: '主角.内力', money: '主角.银两', things: '主角.背包', quests: '世界.任务' })
  assert.deepEqual(guessBindings({}), {})
  assert.deepEqual(cleanBindings({ life: ' 主角.体力 ', nope: 'x', things: 3 }), { life: '主角.体力' })
  assert.equal(numberAt(state, '主角.内力'), 500)
  assert.equal(numberAt(state, '主角.名字'), null)
  assert.equal(numberAt(state, '没有'), null)
  assert.deepEqual(numberWrite(state, '主角.内力', 400), { op: 'replace', path: '主角.内力.0', value: 400 })
  assert.deepEqual(numberWrite(state, '主角.体力', 70), { op: 'replace', path: '主角.体力', value: 70 })
})

const bound = cleanRulebook({ level: 'light', bindings: { life: '主角.体力', maxLife: '主角.最大', things: '主角.背包', quests: '任务' } })

test('the sheet reads the card\'s variables, and keeps the last good value when one stops making sense', () => {
  const state = { 主角: { 体力: 60, 最大: 120, 背包: { 药: 2 } }, 任务: { 送信: '进行中' } }
  const sheet = sheetOf(bound, null, state)
  assert.equal(sheet.life, 60)
  assert.equal(sheet.maxLife, 120)
  assert.deepEqual(names(sheet.things), ['药×2'])
  assert.deepEqual(sheet.quests.map(item => item.title), ['送信'])
  assert.deepEqual(sheet.broken, [])
  assert.equal('bound' in keptSheet(sheet), false)
  const worded = sheetOf(bound, keptSheet(sheet), { 主角: { 体力: '重伤', 最大: 120, 背包: 3 }, 任务: {} })
  assert.equal(worded.life, 60, 'the last good value')
  assert.deepEqual(names(worded.things), ['药×2'])
  assert.deepEqual(worded.broken, ['life', 'things'])
  assert.equal(sheetOf(cleanRulebook({ bindings: { life: '体力' } }), null, { 体力: 500 }).maxLife, 500, 'no maximum to read: the most it has been')
})

test('what a thing does: set for the card, else by its name, else nothing', () => {
  const book = cleanRulebook({ items: { 回春丹: { type: 'heal', size: 'large' }, 钥匙: { type: 'none', size: 'large' }, 怪: { type: 'x' } } })
  assert.deepEqual(effectOf(book, '回春丹'), { type: 'heal', size: 'large' })
  assert.deepEqual(effectOf(book, '钥匙'), { type: 'none' })
  assert.deepEqual(effectOf(book, '止血膏'), { type: 'heal', size: 'medium' })
  assert.deepEqual(effectOf(book, '灵泉水'), { type: 'energy', size: 'medium' })
  assert.deepEqual(effectOf(book, '雷符'), { type: 'damage', size: 'medium' })
  assert.equal(effectOf(book, '怪'), null)
  assert.equal(effectOf(book, '石头'), null)
  assert.equal(usableNow({ type: 'heal' }), true)
  assert.equal(usableNow({ type: 'energy' }), true)
  assert.equal(usableNow({ type: 'damage' }), false, 'only in a fight')
  assert.equal(usableNow(null), false)
})

test('operations: done in order, what cannot be done left out, and the sheet given stays', () => {
  const book = cleanRulebook({ items: { 大还丹: { type: 'heal', size: 'large' }, 回气散: { type: 'energy', size: 'small' } } })
  const sheet = { ...startSheet({ start: { things: [{ name: '回春丹', count: 2 }, { name: '大还丹', count: 1 }, { name: '回气散', count: 1 }, { name: '钥匙', count: 1 }] } }), life: 30, energy: 3 }
  const frozen = JSON.stringify(sheet)
  const done = applyOps(sheet, book, cleanOps([{ op: 'use', name: '回春丹' }, { op: 'use', name: '回气散' }, { op: 'use', name: '钥匙' }, { op: 'use', name: '没有的' }, { op: 'gain', name: '绳', count: 2 }, { op: 'lose', name: '绳' }, { op: 'life', value: 999 }, { op: 'quest', name: '送信', status: 'done' }, { op: 'nope' }]))
  assert.equal(JSON.stringify(sheet), frozen)
  assert.equal(done.sheet.energy, 13)
  assert.equal(done.sheet.life, 100, 'held to the most there is')
  assert.deepEqual(names(done.sheet.things), ['回春丹×1', '大还丹×1', '钥匙×1', '绳×1'])
  assert.deepEqual(done.sheet.quests, [{ title: '送信', note: '', status: 'done' }])
  assert.deepEqual(done.dropped.map(op => op.name), ['钥匙', '没有的'])
  assert.deepEqual(done.spent, ['回春丹', '回气散', '绳'])
  assert.equal(done.lines[0], '玩家使用了回春丹，已扣除，生命 +50')
  assert.equal(done.lines[1], '玩家使用了回气散，已扣除，气力 +10')
  const twice = applyOps({ ...sheet, things: [{ name: '回春丹', count: 1 }] }, book, [{ op: 'use', name: '回春丹' }, { op: 'use', name: '回春丹' }])
  assert.equal(twice.ops.length, 1, 'one left: the second cannot be done')
})

test('operations reach the card\'s own variables: a number as what it comes to, a bag in its shape', () => {
  const book = cleanRulebook({ bindings: { life: '主角.体力', things: '主角.背包' } })
  const state = { 主角: { 体力: [40, '说明'], 背包: [{ 名称: '回春丹', 数量: 2 }] } }
  const before = sheetOf(book, null, state)
  const { sheet, ops } = applyOps(before, book, [{ op: 'use', name: '回春丹' }])
  assert.deepEqual(opWrites(book, state, before, sheet, ops), [
    { op: 'replace', path: '主角.体力.0', value: 90 },
    { op: 'replace', path: '主角.背包', value: [{ 名称: '回春丹', 数量: 1 }] },
  ])
  assert.deepEqual(opWrites(book, state, before, before, []), [])
  const unbound = cleanRulebook({})
  assert.deepEqual(opWrites(unbound, {}, before, sheet, ops), [])
})

test('a reply settles what the card does not keep itself, once', () => {
  const sheet = { ...startSheet({ start: { things: [{ name: '药', count: 2 }] } }), life: 50 }
  assert.equal(settleReply(sheet, replyMarks('【受伤|中】'), { bound: ['life'] }).life, 50, 'the card counts its own')
  assert.equal(settleReply(sheet, replyMarks('【获得|绳】'), { bound: ['things'] }).things.length, 1)
  assert.equal(settleReply(sheet, replyMarks('【任务|新|送信】'), { bound: ['quests'] }).quests.length, 0)
  assert.deepEqual(names(settleReply(sheet, replyMarks('【失去|药】'), { spent: ['药'] }).things), ['药×2'], 'it says what the turn already did')
  assert.deepEqual(names(settleReply(sheet, replyMarks('【失去|药】【失去|药】'), { spent: ['药'] }).things), ['药×1'], 'once for each')
  const rested = settleReply({ ...sheet, life: 20, energy: 2 }, [], { newDay: true })
  assert.equal(rested.life, 70)
  assert.equal(rested.energy, 17)
  assert.equal(settleReply({ ...sheet, life: 90 }, [], { newDay: true }).life, 100)
  assert.equal(settleReply({ ...sheet, life: 20 }, [], { newDay: true, bound: ['life'] }).life, 20)
})

const told = (place, text = '她点头。') => ({ role: 'assistant', raw: `<time_box>午后｜${place}｜雨</time_box>\n${text}`, state: {} })

test('where the story has been: each place once, as first reached, and where it is now', () => {
  const path = [{ role: 'assistant', raw: '开场，没写地点。', state: {} }, { role: 'user', raw: '走' }, told('茶馆'), told('后院'), told('茶馆'), told('茶馆'), told('山道')]
  const { places, here } = visitedPlaces(path)
  assert.deepEqual(places.map(place => [place.name, place.visits]), [['茶馆', 2], ['后院', 1], ['山道', 1]])
  assert.equal(here, places[2].key)
  assert.deepEqual(visitedPlaces([]), { places: [], here: null })
  assert.deepEqual(visitedPlaces([{ role: 'assistant', raw: '没写。', state: {} }]), { places: [], here: null })
})

test('two names for one scene are one place; a place the reply does not name comes from the variables', () => {
  const scene = { id: 's1', name: '旧城茶馆', aliases: ['茶馆'], file: 'a.jpg' }
  const { places } = visitedPlaces([told('旧城茶馆'), told('茶馆')], [scene])
  assert.equal(places.length, 1)
  assert.equal(places[0].name, '旧城茶馆')
  assert.equal(places[0].scene, scene)
  assert.deepEqual(visitedPlaces([{ role: 'assistant', raw: '她点头。', state: { 系统: { 当前地点: '古驿站' } } }]).places.map(place => place.name), ['古驿站'])
})

test('a long story does not slow the map down', () => {
  const story = '她看了你一眼，把茶碗推过来。「雨大，歇歇再走。」窗外的雨声一阵紧一阵松。\n'.repeat(30)
  const path = Array.from({ length: 800 }, (_, i) => (i % 2 ? told(`地点${i % 40}`, story) : { role: 'user', raw: '走' }))
  const scenes = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, name: `场景${i}`, aliases: Array.from({ length: 12 }, (__, a) => `别名${i}-${a}`) }))
  const started = performance.now()
  const { places } = visitedPlaces(path, scenes)
  const took = performance.now() - started
  assert.equal(places.length, 20)
  assert.ok(took < 200, `${took.toFixed(0)} ms for 400 replies`)
})

test('the sound settings: what is missing is the default, music waits to be asked for', () => {
  assert.deepEqual(cleanSound(null), { on: true, effects: 0.7, ambience: 0.5, music: 0, off: [] })
  assert.deepEqual(cleanSound({ on: false, effects: 9, ambience: -1, music: 'x' }), { on: false, effects: 1, ambience: 0, music: 0, off: [] })
  assert.deepEqual(cleanSound({ off: ['music', 'nothing'] }).off, ['music'])
  assert.equal(layerLevel(cleanSound({ music: 0.8, off: ['music'] }), 'music'), 0, 'switched off, whatever its volume')
  assert.equal(layerLevel(cleanSound({ music: 0.8, off: ['music'] }), 'effects'), 0.7, 'the others go on')
  const prefs = cleanSound({ music: 0.8 })
  assert.equal(layerLevel(prefs, 'effects'), 0.7)
  assert.equal(layerLevel({ ...prefs, on: false }, 'effects'), 0, 'off is off')
  assert.equal(layerLevel(prefs, 'effects', true), 0.7, 'a blow still lands under a voice')
  assert.equal(layerLevel(prefs, 'ambience', true), 0.5 * 0.35, 'the rain steps back')
  assert.equal(layerLevel(prefs, 'music', true), 0.8 * 0.35)
})

test('what a weather sounds like', () => {
  assert.deepEqual(ambienceFor('rain'), ['rain'])
  assert.deepEqual(ambienceFor('storm'), ['rain', 'wind', 'thunder'])
  assert.deepEqual(ambienceFor('snow'), ['wind'])
  assert.deepEqual(ambienceFor('clear'), [])
  assert.deepEqual(ambienceFor(''), [])
})

test('which track plays: the fight\'s in a fight, the place\'s at the place, else the story\'s', () => {
  const tracks = [{ id: 'a', use: 'story' }, { id: 'b', use: 'battle' }, { id: 'c', use: '茶馆' }]
  assert.equal(trackFor(tracks, {}).id, 'a')
  assert.equal(trackFor(tracks, { place: '后院' }).id, 'a')
  assert.equal(trackFor(tracks, { place: '茶馆' }).id, 'c')
  assert.equal(trackFor(tracks, { place: '茶馆', fighting: true }).id, 'b')
  assert.equal(trackFor([{ id: 'a', use: 'story' }], { fighting: true }).id, 'a', 'with no fight track the story\'s goes on')
  assert.equal(trackFor([], {}), null)
  assert.equal(trackFor([{ id: 'c', use: '旧城茶馆' }], { place: '旧城 茶馆', same: (a, b) => a.replace(' ', '') === b.replace(' ', '') }).id, 'c')
})


test('achievements are counted from the story line itself: nothing kept, a branch takes them back', () => {
  const won = (life = 50, before = 100) => ({ over: 'won', foes: '灰狼', downed: '灰狼', rounds: 3, before, life, maxLife: 100, used: {}, skills: [], moments: [] })
  const path = [
    { id: 'a', role: 'assistant', gate: { kind: 'battle', foes: [{ name: '山贼头目', count: 1, tier: 'boss' }] } },
    { id: 'b', role: 'user', battle: won(10) },
    { id: 'c', role: 'assistant', game: { level: 2, quests: [{ title: '送信', status: 'done' }, { title: '找人', status: 'new' }] } },
    { id: 'd', role: 'user', check: { tier: 'crit' } },
    { id: 'e', role: 'assistant', gate: { kind: 'battle', foes: [{ name: '灰狼', count: 1, tier: 'minion' }] } },
    { id: 'f', role: 'user', battle: won(100, 100) },
    { id: 'g', role: 'assistant' },
    { id: 'h', role: 'user', battle: { over: 'fled' } },
    { id: 'i', role: 'assistant' },
    { id: 'j', role: 'user', battle: { over: 'lost', life: 0, before: 50, maxLife: 100 } },
    { id: 'k', role: 'assistant' },
  ]
  const before = JSON.stringify(path)
  const tally = tallyOf(path)
  assert.deepEqual(tally, { wins: 2, bosses: 1, narrow: 1, untouched: 1, escapes: 1, crits: 1, quests: 1, level: 2, places: 0 })
  assert.deepEqual(reachedBy(tally).map(item => item.id), ['first-win', 'boss', 'narrow', 'untouched', 'escape', 'first-crit', 'first-quest'])
  assert.equal(JSON.stringify(path), before, 'nothing written')
  assert.deepEqual(reachedBy(tallyOf(path.slice(0, 2))).map(item => item.id), ['first-win', 'boss', 'narrow'], 'rolled back, they go')
  assert.deepEqual(reachedWith(path, 'c').map(item => item.id), ['first-win', 'boss', 'narrow', 'first-quest'], 'the reply the fight was settled in brought them')
  assert.deepEqual(reachedWith(path, 'g').map(item => item.id), ['untouched'])
  assert.deepEqual(reachedWith(path, 'k'), [])
  assert.deepEqual(reachedWith(path, 'nope'), [])
  assert.deepEqual(tallyOf([]), { wins: 0, bosses: 0, narrow: 0, untouched: 0, escapes: 0, crits: 0, quests: 0, level: 1, places: 0 })
})

test('what restores nothing is not worth using now', () => {
  const sheet = { life: 100, maxLife: 100, energy: 10, maxEnergy: 30 }
  assert.equal(nothingToRestore({ type: 'heal' }, sheet), true)
  assert.equal(nothingToRestore({ type: 'energy' }, sheet), false)
  assert.equal(nothingToRestore({ type: 'heal' }, { ...sheet, life: 50 }), false)
  assert.equal(nothingToRestore({ type: 'none' }, sheet), false)
})
