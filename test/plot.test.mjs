// 剧本 (plans/22): a plot kept to its shape, the 剧本进度 mark a reply ends with read and taken out, the progress it
// makes, and the <剧本> block a turn sends (web/shared/plot.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMark, applySet, cleanPace, strayOf, turnsOf, cleanPlot, cleanPlots, enter, exitOpen, fitProgress, MAX_EXITS, MAX_POINTS, plotBlock, plotProblems, progressOn, shown, startProgress, takePlotMark, withoutOpenMark } from '../web/shared/plot.js'

const PLOT = cleanPlot({
  id: 'p1', name: '看海', summary: '从相识到看海的一个夏天',
  scenes: [
    { id: 'a', title: '初遇', what: '你在旧邮局遇见林雪。她在整理信件。', points: [{ id: 'pa1', text: '林雪的名牌' }, { id: 'pa2', text: '那张旧车票' }], done: '两人说上话', exits: [{ to: 'b' }] },
    { id: 'b', title: '雨夜', chapter: '第一章', what: '大雨把两人困在邮局。', points: ['停电'], minTurns: 1, exits: [{ to: 'sea', when: '玩家答应同行', hint: '跟她去看海' }, { to: 'stay', when: '玩家留下寄信' }, { to: 'secret', when: '找到地下室', needs: { seen: 'a', unseen: 'stay' } }] },
    { id: 'sea', title: '看海', what: '两人坐上去海边的火车。', ending: { kind: 'good', text: '在海边把话说开' } },
    { id: 'stay', title: '寄信', what: '你留下来把信寄出去。', ending: { kind: 'sad' } },
    { id: 'secret', title: '地下室', what: '邮局下面另有一层。', ending: { kind: 'hidden' } },
  ],
})

test('a plot is kept to its shape: ids, limits, exits to scenes that are there, the start', () => {
  assert.equal(PLOT.start, 'a')
  assert.deepEqual(PLOT.scenes[1].points.map(point => point.text), ['停电'])
  assert.ok(PLOT.scenes[1].points[0].id)
  assert.equal(PLOT.scenes[2].exits.length, 0, 'an ending has no way on')
  const messy = cleanPlot({ scenes: [{ title: 'x'.repeat(99), points: Array(9).fill('点'), exits: [{ to: 'nowhere' }, ...Array(6).fill({ to: 'dup' })] }, { id: 'dup' }, { id: 'dup' }], start: 'gone', tightness: 'wild' })
  assert.equal(messy.scenes[0].title.length, 40)
  assert.equal(messy.scenes[0].points.length, MAX_POINTS)
  assert.equal(messy.scenes[0].exits.length, MAX_EXITS)
  assert.notEqual(messy.scenes[1].id, messy.scenes[2].id, 'a second scene with a taken id gets its own')
  assert.equal(messy.start, messy.scenes[0].id)
  assert.equal(messy.tightness, 'steady')
  assert.equal(messy.name, '未命名剧本')
  assert.equal(cleanPlot({ scenes: [] }), null)
  assert.equal(cleanPlots([PLOT, PLOT, { scenes: [] }]).length, 2)
  assert.notEqual(cleanPlots([PLOT, PLOT])[1].id, 'p1', 'a copy gets an id of its own')
})

test('what is wrong with a plot: a dead end, a scene out of reach, no ending at all', () => {
  assert.deepEqual(plotProblems(PLOT).blocking, [])
  const broken = cleanPlot({ scenes: [{ id: 'a', exits: [{ to: 'b' }] }, { id: 'b' }, { id: 'c', ending: { kind: 'good' } }] })
  assert.deepEqual(plotProblems(broken).blocking.map(item => item.text), ['「第 2 幕」既没有出口也不是结局', '从开头走不到「第 3 幕」'])
  assert.match(plotProblems(cleanPlot({ scenes: [{ id: 'a', exits: [{ to: 'b' }] }, { id: 'b', exits: [{ to: 'a' }] }] })).blocking.at(-1).text, /还没有结局/)
  assert.deepEqual(plotProblems(cleanPlot({ scenes: [{ what: '只有一幕的大纲' }] })).blocking, [], 'one scene is a plot too')
})

test('the mark: read in any of the ways a model writes it, taken out, the last one counting', () => {
  const read = text => takePlotMark(text)
  assert.deepEqual(read('正文。\n<剧本进度 要点="1,3" 完成="是" 出口="2"/>').mark, { points: [1, 3], done: true, exit: '2', astray: false })
  assert.equal(read('正文。\n<剧本进度 要点="1,3" 完成="是" 出口="2"/>').text, '正文。')
  assert.deepEqual(read('正文\n＜剧本进度 出口=“雨夜”，完成=是 要点=无＞').mark, { points: [], done: true, exit: '雨夜', astray: false })
  assert.deepEqual(read('正文\n【剧本进度 要点：2 完成=否 偏离="是"】').mark.astray, true)
  assert.equal(read('<剧本进度 完成="是"></剧本进度>').text, '')
  const two = read('开头<剧本进度 完成="否"/>中间\n<剧本进度 完成="是" 出口="1"/>')
  assert.equal(two.text, '开头中间')
  assert.equal(two.mark.done, true)
  const fenced = '```\n<剧本进度 完成="是"/>\n```'
  assert.equal(read(fenced).text, fenced, 'inside a code fence it stays')
  assert.equal(read(fenced).mark, null)
  const odd = read('正文\n<剧本进度 随便写写/>')
  assert.equal(odd.text, '正文')
  assert.equal(odd.mark, null, 'unreadable: taken out, counted as not written')
  const other = '<UpdateVariable>x</UpdateVariable>\n<剧本进度 完成="否"/>'
  assert.equal(read(other).text, '<UpdateVariable>x</UpdateVariable>')
  assert.equal(read('没有标记的回复\n').text, '没有标记的回复\n')
})

test('while it is written, a mark never shows, not even its first character for long', () => {
  const reply = '雨还在下。\n<剧本进度 要点="1" 完成="否"/>'
  for (let i = 1; i <= reply.length; i++) {
    const shown = withoutOpenMark(takePlotMark(reply.slice(0, i)).text)
    assert.ok(!shown.includes('剧本') && !/[<＜【]$/.test(shown), `at ${i}: ${shown}`)
  }
  assert.equal(withoutOpenMark('一个 < 号后面是别的'), '一个 < 号后面是别的')
  assert.equal(withoutOpenMark('写到<剧'), '写到')
})

const at = (id, extra = {}) => ({ ...startProgress(PLOT, id), ...extra })
const sentFor = progress => plotBlock(PLOT, progress).sent

test('a reply’s progress: points only add up, a scene ends after its turns, on an open exit only', () => {
  const start = at('a')
  let next = applyMark(PLOT, start, { points: [2, 9], done: false, exit: '', astray: false }, sentFor(start))
  assert.deepEqual(next.ticks, ['pa2'])
  assert.equal(next.turns, 1)
  next = applyMark(PLOT, next, { points: [1], done: true, exit: '', astray: false }, sentFor(next))
  assert.equal(next.at, 'b', 'one exit: taken without naming it')
  assert.deepEqual(next.seen, ['a'])
  assert.equal(next.from, 'a')
  assert.equal(next.turns, 0)
  // 雨夜: three ways; the hidden one is open (初遇 walked, 寄信 not).
  const rain = next
  assert.deepEqual(sentFor(rain).exits, ['sea', 'stay', 'secret'])
  assert.equal(applyMark(PLOT, rain, { points: [], done: true, exit: '', astray: false }, sentFor(rain)).at, 'b', 'two or more ways and none named: it stays')
  assert.equal(applyMark(PLOT, rain, { points: [], done: true, exit: '7', astray: false }, sentFor(rain)).at, 'b', 'a way not offered')
  assert.equal(applyMark(PLOT, rain, { points: [], done: true, exit: '2', astray: false }, sentFor(rain)).at, 'stay')
  assert.equal(applyMark(PLOT, rain, { points: [], done: true, exit: '看海', astray: false }, sentFor(rain)).at, 'sea', 'named by its title')
  assert.equal(applyMark(PLOT, rain, { points: [], done: true, exit: '1', astray: false }, sentFor(rain), { whole: false }).at, 'b', 'a reply cut off does not move on')
  // 初遇 needs two turns.
  assert.equal(applyMark(PLOT, at('a'), { points: [], done: true, exit: '', astray: false }, sentFor(at('a'))).at, 'a', 'too soon')
  const ending = applyMark(PLOT, at('sea', { turns: 1 }), { points: [], done: true, exit: '', astray: false }, sentFor(at('sea')))
  assert.equal(ending.ended, true, 'an ending, played its two turns')
  assert.equal(applyMark(PLOT, at('a'), null, sentFor(at('a'))).turns, 1, 'no mark: a turn all the same')
  assert.equal(applyMark(PLOT, at('a'), { points: [], done: false, exit: '', astray: true }, sentFor(at('a'))).astray, 1)
})

test('an exit that needs a scene walked or not walked opens and closes with the story', () => {
  const secret = PLOT.scenes[1].exits[2]
  assert.equal(exitOpen(secret, at('b', { seen: ['a'] })), true)
  assert.equal(exitOpen(secret, at('b', { seen: [] })), false)
  assert.equal(exitOpen(secret, at('b', { seen: ['a', 'stay'] })), false)
  assert.deepEqual(sentFor(at('b', { seen: [] })).exits, ['sea', 'stay'])
})

test('the player’s own change, and the progress on a path: the latest reply’s, a message’s change on it, or the start', () => {
  assert.equal(applySet(PLOT, at('a'), { at: 'b' }).at, 'b')
  assert.deepEqual(applySet(PLOT, at('a'), { ticks: ['pa1'] }).ticks, ['pa1'])
  assert.equal(applySet(PLOT, at('sea'), { ended: true }).ended, true)
  assert.equal(applySet(PLOT, at('a'), { ended: true }).ended, undefined, 'only an ending ends')
  const path = [
    { id: 'root' },
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant', plot: { ...at('a'), turns: 1, ticks: ['pa1'] } },
    { id: 'u2', role: 'user', plotSet: { of: 'p1', at: 'b' } },
  ]
  assert.equal(progressOn(PLOT, path.slice(0, 1)).at, 'a')
  assert.equal(progressOn(PLOT, path.slice(0, 1), 'b').at, 'b', 'a chat put on the plot from another scene')
  assert.deepEqual(progressOn(PLOT, path.slice(0, 3)).ticks, ['pa1'])
  assert.equal(progressOn(PLOT, path).at, 'b')
  assert.deepEqual(progressOn(PLOT, path).seen, ['a'])
  assert.equal(progressOn(PLOT, [{ id: 'x', plot: { ...at('b'), of: 'another' } }]).at, 'a', 'another plot’s progress is passed over')
  // A scene deleted since: the latest walked one still there.
  const smaller = cleanPlot({ ...PLOT, scenes: PLOT.scenes.filter(scene => scene.id !== 'b') })
  assert.equal(fitProgress(smaller, { ...at('b'), seen: ['a'] }).at, 'a')
  assert.deepEqual(fitProgress(PLOT, { ...at('a'), ticks: ['pa1', 'gone'] }).ticks, ['pa1'])
  assert.equal(enter(at('a'), 'a').turns, 0)
})

test('the <剧本> block: the scene now, its points, the open ways with a line each, the rules, the mark asked for', () => {
  const rain = enter(at('a', { turns: 2 }), 'b')
  const { text, sent } = plotBlock(PLOT, rain)
  assert.match(text, /^<剧本>\n/)
  assert.match(text, /故事总览：从相识到看海的一个夏天/)
  assert.match(text, /已经走过：初遇/)
  assert.match(text, /当前这一幕：「雨夜」（第一章）/)
  assert.match(text, /这一轮刚从「初遇」进入这一幕/)
  assert.match(text, /1\. 停电/)
  assert.match(text, /1\. 当玩家答应同行 → 去「看海」：两人坐上去海边的火车/)
  assert.match(text, /3\. 当找到地下室 → 去「地下室」/)
  assert.match(text, /两三轮内找自然的机会带回来/)
  // Both ways shown: not done yet, and done with the way the player took; a fork waits for the player.
  assert.match(text, /还没演完：<剧本进度 要点="1" 完成="否"\/>；演完了：<剧本进度 要点="2" 完成="是" 出口="1"\/>/)
  assert.match(text, /玩家还没表态，就把场面停在要做选择的地方/)
  assert.match(text, /\n<\/剧本>$/)
  assert.deepEqual(sent, { at: 'b', points: [PLOT.scenes[1].points[0].id], exits: ['sea', 'stay', 'secret'] })
  assert.match(plotBlock(PLOT, at('sea')).text, /这一幕是结局。收场要求：在海边把话说开/)
  assert.match(plotBlock(PLOT, at('a'), { tightness: 'tight' }).text, /要点必须出现/)
  assert.match(plotBlock(PLOT, { ...at('a'), ticks: ['pa1'] }).text, /1\. 林雪的名牌（已经演到）/)
  assert.match(plotBlock(PLOT, at('a')).text, /至少要演 2 轮才能结束/)
})

test('what a reader sees of a scene: all of it where they have been, its title in outline, nothing blind', () => {
  const progress = at('b', { seen: ['a'] })
  const [a, , sea] = PLOT.scenes
  assert.equal(shown(a, 'blind', progress), 'full')
  assert.equal(shown(sea, 'blind', progress), 'none')
  assert.equal(shown(sea, 'outline', progress), 'title')
  assert.equal(shown(sea, 'all', progress), 'full')
})

const PACED = cleanPlot({ scenes: [
  { id: 'a', title: '初遇', what: '遇见林雪。', points: [{ id: 'p1', text: '名牌' }, { id: 'p2', text: '车票' }], done: '两人说上话', minTurns: 4, maxTurns: 6, exits: [{ to: 'b' }] },
  { id: 'b', title: '雨夜', minTurns: 0, exits: [{ to: 'c', when: '同行' }, { to: 'd', when: '留下' }], maxTurns: 2 },
  { id: 'c', title: '看海', minTurns: 5, ending: { kind: 'good' } }, { id: 'd', ending: { kind: 'sad' } },
] })
const DONE = { points: [], done: true, exit: '', astray: false }

test('推进速度: the turns a scene takes, what the turn tells the model, and when the scene may end', () => {
  const [a, b] = PACED.scenes
  assert.deepEqual([-3, -2, -1, 0, 1, 2, 3].map(pace => Object.values(turnsOf(a, pace))), [[12, 18], [8, 12], [6, 9], [4, 6], [3, 5], [2, 3], [2, 2]])
  assert.deepEqual([turnsOf(b, -2), turnsOf(b, 2), turnsOf(null, -2), turnsOf(a, 'nope')], [{ min: 0, max: 4 }, { min: 0, max: 1 }, { min: 0, max: null }, { min: 4, max: 6 }])
  assert.deepEqual([cleanPace(9), cleanPace(-2.2), cleanPace('slow'), cleanPace(NaN), cleanPace(undefined)], [3, -2, 0, 0, 0])

  const start = startProgress(PACED, 'a')
  const at = turns => ({ ...start, turns })
  const usual = plotBlock(PACED, start)
  assert.equal(usual.text, plotBlock(PACED, start, { pace: 0 }).text)
  assert.doesNotMatch(usual.text, /推进/)
  assert.equal(usual.sent.pace, undefined)
  const rules = [-3, -2, -1, 1, 2, 3].map(pace => plotBlock(PACED, start, { pace }).text.match(/^推进.*$/m)?.[0])
  assert.equal(new Set(rules).size, 6, 'each its own words')
  const slow = plotBlock(PACED, start, { pace: -2 })
  assert.match(slow.text, /至少要演 8 轮才能结束/)
  assert.equal(slow.sent.pace, -2)
  const fast = plotBlock(PACED, start, { pace: 2 })

  assert.equal(applyMark(PACED, at(1), DONE, fast.sent).at, 'b', 'two turns are enough when fast')
  assert.equal(applyMark(PACED, at(2), DONE, usual.sent).at, 'a')
  assert.equal(applyMark(PACED, at(3), DONE, usual.sent).at, 'b')
  assert.equal(applyMark(PACED, at(6), DONE, slow.sent).at, 'a', 'the mark is read against what the turn was told')
  assert.equal(applyMark(PACED, at(7), DONE, slow.sent).at, 'b')
  assert.deepEqual([strayOf(PACED, at(6)), strayOf(PACED, at(6), -1), strayOf(PACED, at(5), 1)], ['long', null, 'long'])

  assert.doesNotMatch(plotBlock(PACED, at(5)).text, /已经超过了/)
  assert.match(plotBlock(PACED, at(6)).text, /原定最多演 6 轮，已经超过了：从这一轮起收尾，让还没演到/)
  assert.doesNotMatch(plotBlock(PACED, at(6), { pace: -1 }).text, /已经超过了/)
  const over = plotBlock(PACED, at(9), { pace: -1 }).text
  assert.match(over, /已经超过了/)
  assert.doesNotMatch(over, /推进稍慢|一轮最多演到一条/, 'not asked to go slow and to wrap up at once')
  assert.match(plotBlock(PACED, { ...start, at: 'b', turns: 2 }).text, /把场面推到要选路的地方/)
  assert.doesNotMatch(plotBlock(PACED, at(6), { pull: true }).text, /已经超过了/)
})

test('主动推进: one turn plays a point or the rest of the scene; a scene played out ends whatever the mark says, a fork waits', () => {
  const start = startProgress(PACED, 'a')
  const push = (progress, how, options = {}) => plotBlock(PACED, progress, { push: { how, ...options } })
  assert.match(push(start, 'step').text, /这一轮推进一步：让「名牌」在这一轮里发生/)
  assert.match(push({ ...start, ticks: ['p1'] }, 'step').text, /让「车票」在这一轮里发生/)
  assert.match(push(start, 'step', { point: 'p2' }).text, /让「车票」在这一轮里发生/)
  assert.match(push({ ...start, ticks: ['p1', 'p2'] }, 'step').text, /离「两人说上话」更近一步/)
  assert.equal(push(start, 'step').sent.push, undefined)
  assert.doesNotMatch(plotBlock(PACED, start, { pace: -3, push: { how: 'step' } }).text, /推进极慢/, 'the turn is told one thing')

  const scene = push(start, 'scene')
  assert.match(scene.text, /这一轮演完这一幕：还没演到的要点，要紧的带到/)
  assert.equal(applyMark(PACED, start, null, scene.sent).at, 'b', 'no mark, not enough turns: it ends all the same')
  assert.equal(applyMark(PACED, start, { ...DONE, done: false }, scene.sent).at, 'b')
  assert.equal(applyMark(PACED, start, null, scene.sent, { whole: false }).at, 'a', 'a reply cut off is not the scene played out')
  assert.equal(applyMark(PACED, start, { ...DONE, done: false }, push(start, 'step').sent).at, 'a')

  const forkAt = { ...start, at: 'b', turns: 0 }
  const fork = push(forkAt, 'scene')
  assert.match(fork.text, /这一轮走到岔路口/)
  assert.equal(applyMark(PACED, forkAt, null, fork.sent).at, 'b', 'the way is the player\'s')
  assert.equal(applyMark(PACED, forkAt, { ...DONE, exit: '2' }, fork.sent).at, 'd')
  const ending = { ...start, at: 'c', turns: 0 }
  assert.match(push(ending, 'scene').text, /这一轮把结局写完/)
  assert.equal(applyMark(PACED, ending, null, push(ending, 'scene').sent).ended, true)
})
