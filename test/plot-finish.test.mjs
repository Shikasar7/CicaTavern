// 剧本 补完 (plans/22 第五节): the chapters folded on the map, the arrow keys, two more hints of the structure check, the
// guide's 帮我写 and 从哪一幕开始, and which chats play which plot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { chatSummary, createChat } from '../server/chats.mjs'
import { createPlotDraft, draftRequest, readDraft } from '../server/plot-draft.mjs'
import { createStore } from '../server/store.mjs'
import { cleanPlot, plotProblems } from '../web/shared/plot.js'
import { chaptersOf, foldChapters, layoutMap, neighbour } from '../web/shared/plot-map.js'

const plot = cleanPlot({
  id: 'p', start: 'a1',
  sides: [{ id: 'cat', name: '猫', start: 'c1', opens: 'a2' }],
  scenes: [
    { id: 'a1', chapter: '一', title: '开场', exits: [{ to: 'a2' }] },
    { id: 'a2', chapter: '一', title: '雨夜', exits: [{ to: 'b1', when: '答应' }, { to: 'b2', when: '拒绝' }] },
    { id: 'b1', chapter: '二', title: '同行', exits: [{ to: 'end' }] },
    { id: 'b2', chapter: '二', title: '独行', exits: [{ to: 'end' }, { to: 'a1' }] },
    { id: 'end', chapter: '三', title: '海边', ending: { kind: 'good' } },
    { id: 'c1', side: 'cat', chapter: '一', title: '猫', ending: { kind: 'good' } },
  ],
})

test('a chapter folded is one point: ways into its scenes lead to it, its ways out leave from it; side lines stay', () => {
  assert.deepEqual(chaptersOf(plot), ['一', '二', '三'])
  const folded = foldChapters(plot, new Set(['二']))
  const two = folded.scenes.find(scene => scene.id === 'chapter:二')
  assert.deepEqual(two.members, ['b1', 'b2'])
  assert.equal(two.folded, true)
  assert.deepEqual(two.exits.map(exit => exit.to), ['end', 'a1'])
  assert.deepEqual(folded.scenes.find(scene => scene.id === 'a2').exits.map(exit => exit.to), ['chapter:二'])
  assert.ok(folded.scenes.some(scene => scene.id === 'c1'))
  const first = foldChapters(plot, new Set(['一']))
  assert.equal(first.start, 'chapter:一')
  assert.equal(first.sides[0].opens, 'chapter:一')
  const map = layoutMap(first)
  assert.ok(map.nodes.some(node => node.id === 'chapter:一'))
  assert.ok(map.edges.some(edge => edge.opens && edge.from === 'chapter:一'))
  assert.equal(foldChapters(plot, new Set()), plot)
})

test('the arrow keys: down and up to the nearest point of the next row, left and right along the row', () => {
  const nodes = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: -90, y: 60 }, { id: 'c', x: 90, y: 60 }, { id: 'd', x: 10, y: 120 }]
  assert.equal(neighbour(nodes[0], 'ArrowDown', nodes).id, 'b')
  assert.equal(neighbour(nodes[2], 'ArrowLeft', nodes).id, 'b')
  assert.equal(neighbour(nodes[1], 'ArrowRight', nodes).id, 'c')
  assert.equal(neighbour(nodes[3], 'ArrowUp', nodes).id, 'c')
  assert.equal(neighbour(nodes[0], 'ArrowUp', nodes), null)
  assert.equal(neighbour(nodes[0], 'Tab', nodes), null)
})

test('two more hints: two ways on the same words; forks that all come to one ending', () => {
  const kinds = item => plotProblems(item).hints.map(hint => hint.kind)
  assert.ok(kinds(plot).includes('fewEndings'))
  const same = cleanPlot({ scenes: [{ id: 'x', what: '有事', exits: [{ to: 'y', when: '当玩家答应' }, { to: 'z', when: '玩家 答应' }] }, { id: 'y', what: '有事', ending: {} }, { id: 'z', what: '有事', ending: {} }] })
  assert.ok(kinds(same).includes('sameWhen'))
  assert.ok(!kinds(same).includes('fewEndings'))
})

test('帮我写 asks for one box of one scene and reads it back; 从哪一幕开始 names a scene of the main line', () => {
  const field = draftRequest('field', { plot, scene: 'a2', field: 'points' }, { material: '' })
  assert.match(field.messages[0].content, /只替「雨夜」（id a2）这一幕写要点[\s\S]*"value": \["要点"/)
  assert.deepEqual(readDraft('field', '```json\n{"value": ["1. 停电", "猫叫", ""]}\n```', { plot, field: 'points' }).value, ['停电', '猫叫'])
  assert.equal(readDraft('field', '{"value": "  大雨  "}', { plot, field: 'done' }).value, '大雨')
  assert.equal(readDraft('field', '{"value": ""}', { plot, field: 'what' }), null)
  const where = draftRequest('where', { plot }, { story: '<reply>雨停了</reply>' })
  assert.match(where.messages[0].content, /雨停了[\s\S]*a2「雨夜」[\s\S]*"at"/)
  assert.doesNotMatch(where.messages[0].content, /c1「猫」/, 'a side line is not where a story starts')
  assert.deepEqual(readDraft('where', '{"at": "b1", "why": "已经答应了"}', { plot }), { at: 'b1', why: '已经答应了', notes: '' })
  assert.equal(readDraft('where', '{"at": "c1"}', { plot }), null)
})

test('the guide’s 帮我写 runs in the background like the rest; a chat’s summary says which plot it plays', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-plot-finish-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const card = { ...normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', description: '邮局职员。', first_mes: '雨。' } }), plots: [{ ...plot, name: '看海' }] }
  await store.saveCard(card)
  const drafts = createPlotDraft(store, { engine: { sideCall: async () => ({ text: '{"value": "两人说上了话"}', model: 'fake/m' }) } })
  await drafts.ask(`card-${card.id}`, { kind: 'field', plot, scene: 'a1', field: 'done' })
  let view = await drafts.view(`card-${card.id}`)
  for (let i = 0; view.job && i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    view = await drafts.view(`card-${card.id}`)
  }
  assert.equal(view.result.value, '两人说上了话')
  await assert.rejects(drafts.ask(`card-${card.id}`, { kind: 'field', plot, scene: 'nope', field: 'done' }), { status: 400 })
  await assert.rejects(drafts.ask(`card-${card.id}`, { kind: 'field', plot, scene: 'a1', field: 'title' }), { status: 400 })
  const chat = await createChat(store, card.id, 0, { plotId: 'p' })
  assert.deepEqual(chatSummary(chat).plot, { id: 'p', name: '看海' })
  assert.equal(chatSummary(await createChat(store, card.id, 0)).plot, undefined)
})
