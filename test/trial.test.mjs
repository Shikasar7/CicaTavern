import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../server/store.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { cleanRounds, createTrial, estimateRun, playerLine, playerRequest, readReview, reviewRequest, roundChecks, roundNeeds, summaryLines } from '../server/forge/trial.mjs'

const needs = roundNeeds({ mvu: true, choices: true, blocks: ['self_check', 'judge'], fields: [{ path: 'stat_data.a', label: '好感', min: 0, max: 100 }, { path: 'b', label: '钱' }] })
const good = '<self_check>\n1. 没问题\n</self_check>\n故事。\n<choices>\nA. 走\n</choices>\n<UpdateVariable>\n<JSONPatch>[]</JSONPatch>\n</UpdateVariable>'
const kinds = list => list.map(item => item.kind)

test('rounds come as offered, anything else as the usual six', () => {
  assert.equal(cleanRounds(3), 3)
  assert.equal(cleanRounds('10'), 10)
  assert.equal(cleanRounds(99), 6)
})

test('a block asked for only sometimes is not held against a reply; the self-check every turn is', () => {
  assert.deepEqual(needs.always, ['self_check'])
  assert.deepEqual(needs.ranged.map(field => field.label), ['好感'])
  assert.deepEqual(roundChecks({ text: good, shown: '故事。', node: {} }, needs), [])
})

test('what a round is checked for, each on its own', () => {
  const found = (text, node = {}, shown = '故事。') => kinds(roundChecks({ text, shown, node }, needs))
  assert.ok(found('').includes('empty'))
  assert.ok(found(good, { api: { truncated: 'length' } }).includes('cut'))
  assert.ok(found(good.replace(/<UpdateVariable>[\s\S]*/, '')).includes('update'))
  assert.ok(found(good, { updateUnread: true }).includes('update'))
  assert.ok(found(good.replace(/<choices>[\s\S]*<\/choices>/, '')).includes('choices'))
  assert.ok(found(good.replace(/<self_check>[\s\S]*<\/self_check>/, '')).includes('block'))
  assert.ok(found(good, { schemaProblem: '不合规则' }).includes('schema'))
  assert.ok(found(good, { templateErrors: ['x'] }).includes('template'))
  assert.ok(found(good, {}, '故事<secret>藏着</secret>').includes('leak'))
  assert.ok(!found(good, {}, '<b>故事</b><br>').includes('leak'))
})

test('a number past its range is told; one in range or without a range is not', () => {
  const out = value => kinds(roundChecks({ text: good, shown: '', node: { state: { a: value, b: 9999 } } }, needs))
  assert.ok(out(120).includes('range'))
  assert.ok(!out(50).includes('range'))
})

test('the stand-in player only speaks for the player, and quotes around its line go', () => {
  const request = playerRequest({ name: '卡' }, [{ you: '', reply: '开场' }, { you: '走', reply: '下一段' }], 'claim')
  assert.match(request.system, /不写别人的反应/)
  assert.match(request.messages[0].content, /和前文不符/)
  assert.match(request.messages[0].content, /下一段/)
  assert.equal(playerLine('「我去门口看看。」'), '我去门口看看。')
  assert.equal(playerLine('玩家：我去门口看看。'), '我去门口看看。')
})

test('the report opens with what was written, what went wrong and what never moved', () => {
  const round = (problems = [], state = { a: 1 }, triggered = []) => ({ problems, state, triggered })
  const rounds = [round([{ kind: 'update', what: '没写变量更新' }]), round(), round(), round(), round()]
  const lines = summaryLines(rounds, { needs, fields: [{ path: 'a', label: '好感' }], start: { a: 1 }, keyed: ['甲', '乙'] })
  const text = lines.map(line => line.text).join('\n')
  assert.match(text, /变量更新：5 回合写了 4 回合/)
  assert.match(text, /一直没变过：好感/)
  assert.match(text, /触发了 0 条，共 2 条/)
  assert.match(text, /没有后台内容露给玩家/)
  assert.equal(lines.find(line => line.text.startsWith('变量更新')).level, 'warn')
})

test('too few rounds to tell does not call a variable stuck', () => {
  const lines = summaryLines([{ problems: [], state: { a: 1 }, triggered: [] }], { needs, fields: [{ path: 'a' }], start: { a: 1 } })
  assert.ok(!lines.some(line => line.text.includes('一直没变过')))
})

test('the reader is held to the story, and its answer is kept in bounds', () => {
  const request = reviewRequest({ name: '卡', description: '设定' }, [{ input: '我走', shown: '她说。' }], { rules: '不许抢话' })
  assert.match(request.system, /放水/)
  assert.match(request.messages[0].content, /不许抢话/)
  const read = readReview('<review>{"summary":"还行","issues":[{"round":99,"kind":"乱写","what":"替玩家说了话","quote":"你说","fix":"写明不替玩家说话"},{"what":""}]}</review>', 6)
  assert.equal(read.issues.length, 1)
  assert.equal(read.issues[0].round, 6)
  assert.equal(read.issues[0].kind, '其他')
  assert.equal(readReview('不是 JSON', 6), null)
})

test('the estimate grows with the rounds', () => {
  const card = { description: '设定'.repeat(200) }
  const small = estimateRun(card, [], 3)
  const large = estimateRun(card, [], 10)
  assert.ok(large.input > small.input * 3)
  assert.ok(large.output > small.output * 2)
})

// ─── A run ────────────────────────────────────────────────

async function setup(t, { fail = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'trial-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = createStore(dir)
  await store.init()
  const card = normalizeCard({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: '测试卡', description: '设定', first_mes: '开场', extensions: {} } })
  card.id = 'card1'
  await store.saveCard(card)
  const sessions = new Map()
  const jobs = new Map()
  let turns = 0
  const engine = {
    stopped: [],
    stop: id => engine.stopped.push(id),
    async runTurn(chatId, { parentId, input }) {
      if (fail && turns === fail) throw new Error('模型挂了')
      turns++
      const chat = await store.getChat(chatId)
      const user = { id: `u${turns}`, role: 'user', text: input, parent: parentId, injected: ['世界'] }
      const node = { id: `a${turns}`, role: 'assistant', text: `第 ${turns} 回合的回复`, parent: user.id, state: {}, usage: { input: 100, output: 20 } }
      chat.nodes[user.id] = user
      chat.nodes[node.id] = node
      await store.saveChat(chat)
      return { nodeId: node.id, chat }
    },
  }
  const said = []
  let finished
  const done = new Promise(resolve => { finished = resolve })
  const run = async (session, kind, work) => {
    const controller = new AbortController()
    jobs.set(session.id, { step: null, startedAt: 'now', controller })
    const ctx = {
      label: '测试模型',
      languages: { reply: '简体中文' },
      signal: controller.signal,
      step: () => {},
      call: async request => {
        said.push(request)
        return { text: request.system.includes('审读员') ? '<review>{"summary":"能玩","issues":[]}</review>' : '我往前走。' }
      },
      update: async fn => {
        const fresh = sessions.get(session.id) ?? session
        fn(fresh)
        sessions.set(session.id, fresh)
      },
    }
    await work(ctx).catch(error => {
      const fresh = sessions.get(session.id) ?? session
      fresh.error = { message: error.message }
      sessions.set(session.id, fresh)
    })
    jobs.delete(session.id)
    finished()
    return session
  }
  const trial = createTrial({
    store, engine, jobs, run, cutNote: () => '',
    load: async id => {
      if (!sessions.has(id)) throw Object.assign(new Error('none'), { status: 404 })
      return sessions.get(id)
    },
    save: async session => sessions.set(session.id, session),
    serial: (_, fn) => fn(),
    removeFile: async id => sessions.delete(id),
  })
  return { store, trial, engine, said, done }
}

test('a run plays the rounds, leaves no chat behind and keeps a report', async t => {
  const { store, trial, said, done } = await setup(t)
  await trial.trialUpdate('card1', { rounds: 3 })
  const view = await trial.trialRun('card1')
  await done
  assert.equal(view.report.rounds.length, 3)
  assert.equal(view.report.summary, '能玩')
  assert.equal(view.report.rounds[0].input, '我往前走。')
  assert.deepEqual(view.report.rounds[0].triggered, ['世界'])
  assert.ok(!('state' in view.report.rounds[0]))
  assert.equal(said.length, 4)
  assert.deepEqual(await store.listChats('card1'), [])
})

test('a run that fails halfway still takes its chat with it, and says why', async t => {
  const { store, trial, done } = await setup(t, { fail: 1 })
  await trial.trialUpdate('card1', { rounds: 3 })
  const view = await trial.trialRun('card1')
  await done
  assert.equal(view.error.message, '模型挂了')
  assert.deepEqual(await store.listChats('card1'), [])
})

test('a deleted card takes its report along', async t => {
  const { trial } = await setup(t)
  await trial.trialUpdate('card1', { rounds: 3 })
  await trial.dropTrial('card1')
  assert.equal((await trial.trialGet('card1')).report, null)
})
