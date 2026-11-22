// 剧本 四期 (plans/22 十三): 支线 (kept, opened, sent, reported, moved on by the player, laid out on the map), the
// helper's judging (its question and how its answer is read), and the model that writes no progress.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMark, applySet, cleanPlot, plotBlock, plotProblems, progressOn, shown, startProgress, takePlotMark } from '../web/shared/plot.js'
import { layoutMap } from '../web/shared/plot-map.js'
import { changePlot, judgeRequest, readJudge } from '../server/plot.mjs'

const plot = cleanPlot({
  id: 'p', name: '看海', start: 'a',
  sides: [
    { id: 'cat', name: '流浪猫', start: 'c1', opens: 'b' },
    { id: 'old', name: '旧信', start: 'o1' },
    { id: 'gone', name: '空的' },
  ],
  scenes: [
    { id: 'a', title: '初遇', minTurns: 1, exits: [{ to: 'b' }, { to: 'c1' }] },
    { id: 'b', title: '雨夜', minTurns: 1, exits: [{ to: 'end' }] },
    { id: 'end', title: '看海', minTurns: 1, ending: { kind: 'good' } },
    { id: 'c1', side: 'cat', title: '屋檐下的猫', what: '邮局屋檐下有只猫。', points: [{ id: 'pc', text: '猫叫' }], minTurns: 1, exits: [{ to: 'c2', when: '喂它' }, { to: 'c3', when: '赶走它' }, { to: 'a' }] },
    { id: 'c2', side: 'cat', title: '收养', minTurns: 1, ending: { kind: 'good', text: '猫跟回了家' } },
    { id: 'c3', side: 'cat', title: '走散', minTurns: 1, ending: { kind: 'sad' } },
    { id: 'o1', side: 'old', title: '旧信', minTurns: 0, exits: [{ to: 'o2' }] },
    { id: 'o2', side: 'old', title: '回信', ending: { kind: 'normal' } },
    { id: 'x', side: 'nowhere', title: '没有这条线', exits: [{ to: 'a' }] },
  ],
})

test('支线 kept: each with its scenes and start; a way on never crosses lines; a scene of no line is the main line’s', () => {
  assert.deepEqual(plot.sides, [{ id: 'cat', name: '流浪猫', start: 'c1', opens: 'b' }, { id: 'old', name: '旧信', start: 'o1', opens: '' }])
  assert.deepEqual(plot.scenes.find(scene => scene.id === 'a').exits.map(exit => exit.to), ['b'])
  assert.deepEqual(plot.scenes.find(scene => scene.id === 'c1').exits.map(exit => exit.to), ['c2', 'c3'])
  assert.equal(plot.scenes.find(scene => scene.id === 'x').side, undefined)
  assert.equal(cleanPlot({ start: 'c', sides: [{ id: 's', start: 'c' }], scenes: [{ id: 'm', title: '主' }, { id: 'c', side: 's' }] }).start, 'm', 'the start is on the main line')
  const only = cleanPlot({ sides: [{ id: 's' }], scenes: [{ id: 'c', side: 's' }] })
  assert.equal(only.sides, undefined)
  assert.equal(only.scenes[0].side, undefined)
  // The structure is checked line by line: a side line with no ending is one problem.
  const kinds = plotProblems(cleanPlot({ sides: [{ id: 's', name: '猫' }], scenes: [{ id: 'm', exits: [{ to: 'e' }] }, { id: 'e', ending: {} }, { id: 'c1', side: 's', exits: [{ to: 'c2' }] }, { id: 'c2', side: 's', exits: [{ to: 'c1' }] }] })).blocking.map(item => item.kind)
  assert.deepEqual(kinds, ['sideNoEnding'])
  assert.ok(!plotProblems(plot).blocking.some(item => item.kind === 'unreached' && ['c2', 'o2'].includes(item.scene)))
})

test('a side line opens from the start, or when the main line reaches the scene that opens it', () => {
  const start = startProgress(plot)
  assert.deepEqual(Object.keys(start.sides), ['old'])
  const atB = progressOn(plot, [{ role: 'assistant', plot: { of: 'p', at: 'b', ticks: [], turns: 0, seen: ['a'], astray: 0 } }])
  assert.deepEqual(Object.keys(atB.sides).sort(), ['cat', 'old'])
  assert.deepEqual(atB.sides.cat, { at: 'c1', ticks: [], turns: 0, seen: [] })
})

test('the block lists the open side lines after the main scene, and asks for their progress in the same mark', () => {
  const progress = progressOn(plot, [{ role: 'assistant', plot: { of: 'p', at: 'b', ticks: [], turns: 0, seen: ['a'], astray: 0 } }])
  const { text, sent } = plotBlock(plot, progress)
  assert.match(text, /支线（[\s\S]*支线1「流浪猫」，现在是「屋檐下的猫」：邮局屋檐下有只猫。[\s\S]*1\. 猫叫[\s\S]*演完后：1\. 当喂它 → 「收养」；2\. 当赶走它 → 「走散」[\s\S]*支线2「旧信」/)
  assert.match(text, /支线N="是"/)
  assert.deepEqual(sent.sides, [{ id: 'cat', at: 'c1', points: ['pc'], exits: ['c2', 'c3'] }, { id: 'old', at: 'o1', points: [], exits: ['o2'] }])
  assert.doesNotMatch(plotBlock(cleanPlot({ scenes: [{ id: 'm' }] }), startProgress(cleanPlot({ scenes: [{ id: 'm' }] }))).text, /支线/)
})

test('the mark reports side lines by number; the reply moves each on as it says, read against what was sent', () => {
  const { mark, text } = takePlotMark('她笑了。\n<剧本进度 要点="无" 完成="否" 支线1要点="1" 支线1="是" 支线1出口="2" 支线2="是"/>')
  assert.equal(text, '她笑了。')
  assert.deepEqual(mark.sides, { 1: { points: [1], done: true, exit: '2' }, 2: { points: [], done: true, exit: '' } })
  const base = progressOn(plot, [{ role: 'assistant', plot: { of: 'p', at: 'b', ticks: [], turns: 0, seen: ['a'], astray: 0 } }])
  const { sent } = plotBlock(plot, base)
  const next = applyMark(plot, base, mark, sent)
  assert.equal(next.at, 'b')
  assert.deepEqual(next.sides.cat, { at: 'c3', ticks: [], turns: 0, seen: ['c1'], from: 'c1' })
  assert.deepEqual(next.sides.old, { at: 'o2', ticks: [], turns: 0, seen: ['o1'], from: 'o1' })
  // The next reply: the side line's `from` is gone; its ending played out ends it.
  const later = applyMark(plot, next, takePlotMark('x\n<剧本进度 要点="无" 完成="否" 支线1="是"/>').mark, plotBlock(plot, next).sent)
  assert.equal(later.sides.cat.from, undefined)
  assert.equal(later.sides.cat.ended, true)
  assert.match(plotBlock(plot, later).text, /支线1「旧信」/, 'an ended one is no longer sent; the numbers follow')
  // Before its turns, a scene of a side line does not end.
  const fresh = plotBlock(plot, base)
  const tooSoon = applyMark(plot, { ...base, sides: { ...base.sides, cat: { ...base.sides.cat, turns: -5 } } }, takePlotMark('x\n<剧本进度 支线1="是" 支线1出口="1"/>').mark, fresh.sent)
  assert.equal(tooSoon.sides.cat.at, 'c1')
})

test('the player moves a side line on: a way taken, an ending played out; a main scene changing keeps them', () => {
  const base = progressOn(plot, [{ role: 'assistant', plot: { of: 'p', at: 'b', ticks: [], turns: 0, seen: ['a'], astray: 0 } }])
  const moved = applySet(plot, base, { side: { id: 'cat', to: 'c2' } })
  assert.equal(moved.sides.cat.at, 'c2')
  assert.equal(applySet(plot, moved, { side: { id: 'cat', ended: true } }).sides.cat.ended, true)
  assert.equal(applySet(plot, base, { side: { id: 'cat', to: 'b' } }).sides.cat.at, 'c1', 'not a scene of that line')
  const on = applySet(plot, moved, { at: 'end' })
  assert.equal(on.sides.cat.at, 'c2')
  // A side scene walked is one the reader has seen.
  assert.equal(shown(plot.scenes.find(scene => scene.id === 'c1'), 'blind', moved), 'full')
})

test('the map lays each side line out to the right of the main one, level with the scene that opens it', () => {
  const map = layoutMap(plot)
  const at = id => map.nodes.find(node => node.id === id)
  const mainRight = Math.max(...['a', 'b', 'end', 'x'].map(id => at(id).x))
  assert.ok(['c1', 'c2', 'c3', 'o1', 'o2'].every(id => at(id).x > mainRight))
  assert.equal(at('c1').y, at('b').y)
  assert.ok(at('o1').x > Math.max(at('c2').x, at('c3').x), 'one line after another')
  assert.deepEqual(map.labels.map(label => label.text), ['流浪猫', '旧信'])
  assert.ok(map.edges.some(edge => edge.opens && edge.from === 'b' && edge.to === 'c1'))
  assert.ok(map.nodes.every(node => node.x <= map.width && node.y <= map.height))
  assert.ok(!at('c1').lost)
})

test('the helper’s question names the scene, its points and ways as sent; its answer is read as a mark', () => {
  const base = startProgress(plot)
  const { sent } = plotBlock(plot, { ...base, at: 'c1' } , {})
  const request = judgeRequest(plot, base, { at: 'a', points: [], exits: ['b'] }, '<reply>她点头。</reply>')
  assert.match(request.messages[0].content, /当前这一幕：「初遇」[\s\S]*1\. 演完后 → 去「雨夜」[\s\S]*她点头。[\s\S]*只回 JSON/)
  assert.ok(sent)
  assert.deepEqual(readJudge('```json\n{"points":[1,"2"],"done":true,"exit":2,"astray":false}\n```'), { points: [1, 2], done: true, exit: '2', astray: false })
  assert.deepEqual(readJudge('{"done":"是","exit":null}'), { points: [], done: true, exit: '', astray: false })
  assert.equal(readJudge('看不出来'), null)
  // 支线 too, numbered as the turn sent them.
  const atB = progressOn(plot, [{ role: 'assistant', plot: { of: 'p', at: 'b', ticks: [], turns: 0, seen: ['a'], astray: 0 } }])
  const both = plotBlock(plot, atB, { mark: false }).sent
  assert.match(judgeRequest(plot, atB, both, '').messages[0].content, /支线1「流浪猫」现在是「屋檐下的猫」[\s\S]*1\. 当喂它 → 「收养」[\s\S]*"sides"/)
  const said = readJudge('{"done": false, "sides": [{"n": 1, "points": [1], "done": true, "exit": 1}, {"n": "x"}]}')
  assert.deepEqual(said.sides, { 1: { points: [1], done: true, exit: '1' } })
  assert.equal(applyMark(plot, atB, said, both, { judged: true }).sides.cat.at, 'c2')
})

test('a model that writes no progress is counted; one asked for none (the helper judges) is not', () => {
  let progress = startProgress(plot)
  for (let i = 0; i < 3; i++) progress = applyMark(plot, progress, null, plotBlock(plot, progress).sent)
  assert.equal(progress.silent, 3)
  progress = applyMark(plot, progress, takePlotMark('x\n<剧本进度 要点="无" 完成="否"/>').mark, plotBlock(plot, progress).sent)
  assert.equal(progress.silent, 0)
  const quiet = plotBlock(plot, startProgress(plot), { mark: false })
  assert.doesNotMatch(quiet.text, /每次回复的最后/)
  assert.equal(quiet.sent.mark, false)
  assert.equal(applyMark(plot, startProgress(plot), null, quiet.sent).silent, undefined)
})

test('跳到 a side line’s scene: that line goes there, opened if it was not; the main story stays', () => {
  const base = startProgress(plot)
  assert.equal(base.sides.cat, undefined, 'not open yet')
  const jumped = applySet(plot, base, { side: { id: 'cat', to: 'c2' } })
  assert.equal(jumped.at, 'a')
  assert.deepEqual(jumped.sides.cat, { at: 'c2', ticks: [], turns: 0, seen: ['c1'], from: 'c1' })
  const chat = { plot: { copy: plot, start: 'a', pending: null }, nodes: { root: { id: 'root', role: 'assistant' } } }
  changePlot(chat, { action: 'jump', at: 'c3' }, { id: 'root' })
  assert.deepEqual(chat.plot.pending.set, { side: { id: 'cat', to: 'c3' } })
  changePlot(chat, { action: 'jump', at: 'b' }, { id: 'root' })
  assert.equal(chat.plot.pending.set.at, 'b')
})
