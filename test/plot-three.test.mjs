// 剧本 三期 (plans/22 十二): exits the program judges (variables, the scene's roll and fight, 满足就走), 故事岔开了, the
// guide's changes taken one by one, and the structure problems the page says in its own words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMark, applyPlotChanges, applySet, cleanPlot, exitLacks, exitOpen, plotBlock, plotChanges, plotProblems, startProgress, strayOf, varHolds, varOf } from '../web/shared/plot.js'

const plot = cleanPlot({
  id: 'p', name: '看海', start: 'a',
  scenes: [
    { id: 'a', title: '初遇', what: '在邮局遇见她。', points: [{ id: 'pa', text: '旧车票' }], minTurns: 3, maxTurns: 4, exits: [
      { to: 'b', when: '好感够了', needs: { vars: [{ path: '好感度', op: '>=', value: '60' }] }, auto: true },
      { to: 'c', when: '检定成功', needs: { check: 'pass' } },
      { to: 'd', when: '打输了', needs: { battle: 'lost' }, auto: true },
      { to: 'e', when: '离开' },
    ] },
    { id: 'b', title: '靠近', ending: { kind: 'good' } },
    { id: 'c', title: '识破', ending: { kind: 'hidden' } },
    { id: 'd', title: '败走', ending: { kind: 'sad' } },
    { id: 'e', title: '离开', ending: { kind: 'normal' } },
  ],
})

test('an exit keeps what the program judges; 满足就走 only with such a need, a bad comparison dropped', () => {
  const [toB, toC, toD, toE] = plot.scenes[0].exits
  assert.deepEqual(toB.needs, { vars: [{ path: '好感度', op: '>=', value: 60 }] })
  assert.equal(toB.auto, true)
  assert.deepEqual(toC.needs, { check: 'pass' })
  assert.equal(toD.auto, true)
  assert.equal(toE.needs, undefined)
  const odd = cleanPlot({ scenes: [{ id: 'x', exits: [{ to: 'y', auto: true, needs: { vars: [{ path: 'a', op: '~', value: 1 }, { path: '', op: '>', value: 1 }], check: 'maybe', battle: 'draw' } }] }, { id: 'y', ending: {} }] })
  assert.deepEqual(odd.scenes[0].exits[0], { to: 'y', when: '', hint: '' })
})

test('a variable is read by its path, under stat_data on an MVU card, described values unwrapped; numbers compare as numbers', () => {
  assert.equal(varOf({ 好感度: 70 }, '好感度'), 70)
  assert.equal(varOf({ stat_data: { 林雪: { 好感度: [65, '好感'] } } }, '林雪.好感度'), 65)
  assert.equal(varHolds({ path: '好感度', op: '>=', value: 60 }, { 好感度: '70' }), true)
  assert.equal(varHolds({ path: '好感度', op: '<', value: 60 }, { 好感度: 70 }), false)
  assert.equal(varHolds({ path: '地点', op: '=', value: '海边' }, { 地点: '海边' }), true)
  assert.equal(varHolds({ path: '地点', op: '!=', value: '海边' }, { 地点: '邮局' }), true)
  assert.equal(varHolds({ path: '地点', op: '>', value: '海边' }, { 地点: '邮局' }), false)
  assert.equal(varHolds({ path: '没有', op: '!=', value: 1 }, {}), false)
  assert.equal(varHolds({ path: '好感度', op: '>=', value: 60 }, null), false)
})

test('what an exit still needs: the variables, the scene’s latest roll and fight', () => {
  const [toB, toC, toD] = plot.scenes[0].exits
  const progress = startProgress(plot)
  assert.deepEqual(exitLacks(toB, progress, { 好感度: 30 }), [{ kind: 'var', path: '好感度', op: '>=', value: 60 }])
  assert.equal(exitOpen(toB, progress, { 好感度: 60 }), true)
  assert.deepEqual(exitLacks(toC, progress), [{ kind: 'check', want: 'pass' }])
  assert.equal(exitOpen(toC, { ...progress, check: 'pass' }), true)
  assert.equal(exitOpen(toD, { ...progress, battle: 'won' }), false)
})

test('the block offers only the exits open now, and 拉回来 asks for the story back once', () => {
  const progress = startProgress(plot)
  const low = plotBlock(plot, progress, { state: { 好感度: 10 } })
  assert.deepEqual(low.sent.exits, ['e'])
  assert.doesNotMatch(low.text, /去「靠近」/)
  const high = plotBlock(plot, { ...progress, check: 'pass' }, { state: { 好感度: 90 }, pull: true })
  assert.deepEqual(high.sent.exits, ['b', 'c', 'e'])
  assert.match(high.text, /把场面带回这一幕/)
  assert.doesNotMatch(low.text, /把场面带回这一幕/)
})

test('after a reply: the roll and the fight are kept for the scene; 满足就走 goes whatever the model wrote, on a whole reply', () => {
  const base = startProgress(plot)
  const sent = plotBlock(plot, base, { state: {} }).sent
  const rolled = applyMark(plot, base, null, sent, { facts: { state: {}, check: 'pass' } })
  assert.equal(rolled.check, 'pass')
  assert.equal(rolled.at, 'a')
  const fond = applyMark(plot, base, { points: [], done: false, exit: '', astray: false }, sent, { facts: { state: { 好感度: 75 } } })
  assert.equal(fond.at, 'b', 'taken although the scene wanted 3 turns and the model said not done')
  assert.equal(fond.from, 'a')
  assert.equal(fond.check, undefined)
  const cut = applyMark(plot, base, null, sent, { whole: false, facts: { state: { 好感度: 75 } } })
  assert.equal(cut.at, 'a')
  const beaten = applyMark(plot, rolled, null, sent, { facts: { state: {}, battle: 'lost' } })
  assert.equal(beaten.at, 'd')
  // Into the next scene, what the last one rolled is gone.
  assert.equal(beaten.check, undefined)
  assert.equal(beaten.battle, undefined)
})

test('故事岔开了: when the model says so or the scene runs long; 不用管 quiets it for the scene', () => {
  const base = startProgress(plot)
  assert.equal(strayOf(plot, base), null)
  assert.equal(strayOf(plot, { ...base, astray: 1 }), 'astray')
  assert.equal(strayOf(plot, { ...base, turns: 4 }), 'long')
  const quiet = applySet(plot, { ...base, astray: 2 }, { quiet: true })
  assert.equal(quiet.quiet, true)
  assert.equal(strayOf(plot, { ...quiet, turns: 9, astray: 1 }), null)
  assert.equal(strayOf(plot, { ...base, astray: 1, ended: true }), null)
  // A pull is for the turn's block only.
  assert.equal(applySet(plot, base, { pull: true }), base)
})

test('the guide’s changes one by one: the details, scenes added, changed and taken out; scenes played never', () => {
  const after = cleanPlot({
    ...plot, name: '看海（改）',
    scenes: [
      { ...plot.scenes[0], what: '在邮局遇见她，她在哭。' },
      { ...plot.scenes[1], title: '牵手' },
      plot.scenes[3], plot.scenes[4],
      { id: 'f', title: '新的一幕', exits: [{ to: 'e' }] },
    ],
  })
  const changes = plotChanges(plot, after)
  assert.deepEqual(changes.map(change => [change.id, change.kind]), [['info', 'info'], ['scene:a', 'change'], ['scene:b', 'change'], ['scene:f', 'add'], ['scene:c', 'remove']])
  assert.equal(changes.find(change => change.id === 'scene:b').was, '靠近')
  const locked = plotChanges(plot, after, { locked: new Set(['a', 'c']) })
  assert.deepEqual(locked.map(change => change.id), ['info', 'scene:b', 'scene:f'])
  // Only some taken: the rest stay as they were.
  const some = applyPlotChanges(plot, after, new Set(['scene:b', 'scene:f']))
  assert.equal(some.name, '看海')
  assert.equal(some.scenes.find(scene => scene.id === 'b').title, '牵手')
  assert.equal(some.scenes.find(scene => scene.id === 'a').what, '在邮局遇见她。')
  assert.ok(some.scenes.find(scene => scene.id === 'c'), 'not taken out')
  assert.ok(some.scenes.find(scene => scene.id === 'f'))
  const all = applyPlotChanges(plot, after, new Set(changes.map(change => change.id)))
  assert.deepEqual(all.scenes.map(scene => scene.id), ['a', 'b', 'd', 'e', 'f'])
  assert.equal(all.id, 'p')
  // A scene played is kept, whatever was picked.
  const guarded = applyPlotChanges(plot, after, new Set(['scene:a', 'scene:c']), { locked: new Set(['a', 'c']) })
  assert.equal(guarded.scenes.find(scene => scene.id === 'a').what, '在邮局遇见她。')
  assert.ok(guarded.scenes.find(scene => scene.id === 'c'))
})

test('a structure problem says what kind it is and of which scene, for the page to say in its language', () => {
  const broken = cleanPlot({ scenes: [{ id: 'x', title: '开头', exits: [] }, { id: 'y', title: '孤岛' }] })
  const { blocking, hints } = plotProblems(broken)
  assert.deepEqual(blocking.map(item => [item.kind, item.title ?? '']), [['noExit', '开头'], ['noExit', '孤岛'], ['unreached', '孤岛'], ['noEnding', '']])
  assert.ok(hints.every(item => item.kind && item.text))
  assert.equal(plotProblems(null).blocking[0].kind, 'empty')
  // An exit with a need the program judges says when by itself; one with neither does not.
  const fork = (needs = undefined) => cleanPlot({ scenes: [{ id: 'x', what: '有事', exits: [{ to: 'y', when: '走' }, { to: 'z', needs }] }, { id: 'y', what: '有事', ending: {} }, { id: 'z', what: '有事', ending: {} }] })
  assert.ok(!plotProblems(fork({ check: 'pass' })).hints.some(item => item.kind === 'vagueFork'))
  assert.ok(plotProblems(fork()).hints.some(item => item.kind === 'vagueFork'))
})
