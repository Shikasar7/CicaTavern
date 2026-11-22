// 让向导写剧本、改剧本 (plans/22 十二·3, server/plot-draft.mjs): what the guide is asked, how its answer is read, and the
// job in the background, with a fake model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, createChat } from '../server/chats.mjs'
import { cleanDraftInput, createPlotDraft, draftRequest, jsonIn, readDraft } from '../server/plot-draft.mjs'
import { createStore } from '../server/store.mjs'
import { cleanPlot } from '../web/shared/plot.js'

const ANSWER = `好的，大纲如下。
\`\`\`json
{
  "name": "看海", "intro": "一个夏天", "summary": "相识到看海", "tightness": "steady", "start": "s1",
  "scenes": [
    { "id": "s1", "title": "初遇", "what": "在邮局遇见。", "points": ["旧车票", "雨"], "exits": [{ "to": "s2", "when": "答应同行" }, { "to": "s3", "when": "留下", }], "ending": null },
    { "id": "s2", "title": "看海", "exits": [], "ending": { "kind": "good", "text": "说开" } },
    { "id": "s3", "title": "寄信", "exits": [], "ending": { "kind": "sad" } },
  ]
}
\`\`\`
岔路这里我按玩家答不答应来分，对吗？`

test('the JSON in an answer: in its block or bare, stray commas forgiven; none is null', () => {
  assert.equal(jsonIn(ANSWER).scenes.length, 3)
  assert.deepEqual(jsonIn('前面的话 {"a": 1,} 后面'), { a: 1 })
  assert.equal(jsonIn('没有代码块'), null)
  assert.equal(jsonIn('```json\n{ 坏的 }\n```'), null)
})

test('a plot read from the answer: cleaned, the guide’s words beside it kept; points it kept keep their ids', () => {
  const read = readDraft('outline', ANSWER)
  assert.equal(read.plot.scenes.length, 3)
  assert.equal(read.plot.source, 'own')
  assert.match(read.notes, /岔路这里/)
  const before = cleanPlot({ id: 'mine', source: 'imported', scenes: [{ id: 's1', title: '初遇', points: [{ id: 'keep', text: '旧车票' }], exits: [{ to: 's2' }] }, { id: 's2', ending: {} }] })
  const edited = readDraft('edit', ANSWER, { plot: before })
  assert.equal(edited.plot.id, 'mine')
  assert.equal(edited.plot.source, 'imported')
  const points = edited.plot.scenes[0].points
  assert.equal(points[0].id, 'keep')
  assert.notEqual(points[1].id, 'keep')
  assert.equal(readDraft('full', '我写不出来'), null)
})

test('a detour scene: its own fields only, joined back where it may be', () => {
  const answer = '```json\n{ "scene": { "title": "码头", "what": "两人在码头吵了一架。", "points": ["船票"], "done": "和好", "id": "x", "exits": [{ "to": "a" }] }, "back": "b" }\n```'
  const read = readDraft('detour', answer, { back: ['a', 'b'] })
  assert.equal(read.scene.title, '码头')
  assert.equal(read.scene.id, undefined)
  assert.equal(read.scene.exits, undefined)
  assert.deepEqual(read.scene.points.map(point => point.text), ['船票'])
  assert.equal(read.back, 'b')
  assert.equal(readDraft('detour', answer, { back: ['a'] }).back, 'a')
})

test('what the guide is asked, for each kind; scenes played are named as fixed', () => {
  const plot = cleanPlot({ scenes: [{ id: 's1', title: '初遇', exits: [{ to: 's2' }] }, { id: 's2', title: '结局', ending: {} }] })
  const outline = draftRequest('outline', { text: '一个夏天', scenes: 8, endings: 3 }, { material: '<description>邮局</description>' })
  assert.match(outline.messages[0].content, /邮局[\s\S]*一个夏天[\s\S]*大约 8 幕（不算支线）\n- 3 个结局[\s\S]*不要支线/)
  // The finer settings, one line each; the opening the plot goes on from.
  const fine = draftRequest('whole', { text: '', scenes: 10, endings: 3, endingKinds: ['good', 'hidden'], forks: 'many', sides: 2, chapters: 3, tightness: 'tight', tone: '慢热', avoid: '死亡', opening: '雨下了一整夜。' }).messages[0].content
  assert.match(fine, /类型要有：圆满、隐藏[\s\S]*岔路多[\s\S]*2 条支线[\s\S]*分 3 章[\s\S]*松紧：紧[\s\S]*基调和写法：慢热[\s\S]*不要写：死亡[\s\S]*<开场>\n雨下了一整夜。/)
  assert.match(outline.system, /```json/)
  assert.match(draftRequest('outline', { text: '再加一条路', plot, scenes: 2, endings: 1 }).messages[0].content, /现在的大纲[\s\S]*再加一条路/)
  assert.match(draftRequest('full', { plot }).messages[0].content, /写成完整的剧本/)
  assert.match(draftRequest('split', { text: '第一章：相遇' }).messages[0].content, /第一章：相遇/)
  assert.match(draftRequest('edit', { plot, text: '加一场误会' }, { locked: ['「初遇」（s1）'] }).messages[0].content, /不能改也不能删：「初遇」（s1）[\s\S]*加一场误会/)
  assert.match(draftRequest('detour', { plot, at: { id: 's1', title: '初遇' }, back: ['s1', 's2'] }, { story: '<reply>去了码头</reply>' }).messages[0].content, /去了码头[\s\S]*「初遇」[\s\S]*s1、s2/)
  assert.ok(draftRequest('full', { plot }).maxTokens > draftRequest('detour', { plot, at: { id: 's1', title: '' }, back: [] }).maxTokens)
})

test('what the page asks is checked: the kind, the length, a plot where one is needed', () => {
  assert.throws(() => cleanDraftInput('poem', {}), { status: 400 })
  assert.throws(() => cleanDraftInput('full', {}), { status: 400 })
  assert.throws(() => cleanDraftInput('split', { text: ' ' }), { status: 400 })
  assert.throws(() => cleanDraftInput('outline', { text: 'x'.repeat(9000) }), { status: 400 })
  assert.deepEqual(cleanDraftInput('outline', { scenes: 99, endings: 0, tightness: 'odd' }), { text: '', plot: null, scenes: 20, endings: 1, tightness: '', sides: 0, forks: '', endingKinds: [], chapters: 0, tone: '', avoid: '', opening: '' })
})

async function setup(t, answer) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-plot-draft-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const card = { ...normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', description: '邮局职员。', first_mes: '雨下了一整夜。' } }), plots: [{ id: 'p1', scenes: [{ id: 'a', title: '初遇', exits: [{ to: 'b' }] }, { id: 'b', title: '雨夜', ending: { kind: 'good' } }] }] }
  await store.saveCard(card)
  const asked = []
  const engine = {
    async sideCall(chat, preferred, request, { onText }) {
      asked.push({ chat, request })
      onText('写')
      const text = typeof answer === 'function' ? answer(request) : answer
      if (text instanceof Error) throw text
      return { text, model: 'fake/m' }
    },
  }
  const drafts = createPlotDraft(store, { engine })
  const until = async key => {
    for (let i = 0; i < 100; i++) {
      const view = await drafts.view(key)
      if (!view.job) return view
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('the draft never finished')
  }
  return { store, card, drafts, asked, until }
}

test('a card’s draft is written in the background and read back; the card and its lore go with the question', async t => {
  const { card, drafts, asked, until } = await setup(t, ANSWER)
  const key = `card-${card.id}`
  const started = await drafts.ask(key, { kind: 'outline', text: '一个夏天' })
  assert.equal(started.kind, 'outline')
  const done = await until(key)
  assert.equal(done.error, null)
  assert.equal(done.result.plot.scenes.length, 3)
  assert.equal(done.result.model, 'fake/m')
  assert.equal(asked[0].chat, null)
  assert.match(asked[0].request.messages[0].content, /邮局职员[\s\S]*雨下了一整夜/)
  // Kept: the window opened again shows it.
  assert.equal((await drafts.view(key)).result.plot.name, '看海')
  await drafts.clear(key)
  assert.equal((await drafts.view(key)).result, null)
})

test('an answer with no plot in it, or a model that fails, is an error to try again; another key is refused', async t => {
  const { card, drafts, until } = await setup(t, '我想想……')
  const key = `card-${card.id}`
  await drafts.ask(key, { kind: 'outline' })
  assert.match((await until(key)).error.message, /读不出来/)
  await assert.rejects(drafts.view('evil-../x'), { status: 400 })
})

test('a chat’s draft: the story’s last turns for 就这样走, the scenes played named as fixed for 问问向导改', async t => {
  const { store, card, drafts, asked, until } = await setup(t, request => (/新的一幕/.test(request.messages[0].content) ? '```json\n{ "scene": { "title": "码头", "what": "吵架" }, "back": "b" }\n```' : ANSWER))
  const chat = await createChat(store, card.id, 0, { plotId: 'p1' })
  const key = `chat-${chat.id}`
  await drafts.ask(key, { kind: 'detour' })
  const detour = await until(key)
  assert.equal(detour.result.scene.title, '码头')
  assert.equal(detour.result.back, 'b')
  assert.equal(asked[0].chat.id, chat.id)
  assert.match(asked[0].request.messages[0].content, /雨下了一整夜[\s\S]*「初遇」（id a）/)
  // Walk the story on a scene and ask for a change: that scene is fixed.
  const now = await store.getChat(chat.id)
  activePath(now).at(-1).plot = { of: 'p1', at: 'b', ticks: [], turns: 0, seen: ['a'], astray: 0 }
  await store.saveChat(now)
  await drafts.ask(key, { kind: 'edit', plot: now.plot.copy, text: '加一场误会' })
  const edit = await until(key)
  assert.deepEqual(edit.result.locked, ['a'])
  assert.match(asked[1].request.messages[0].content, /不能改也不能删：「初遇」（a）/)
})
