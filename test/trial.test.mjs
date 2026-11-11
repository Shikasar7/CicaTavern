import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { createApp } from '../server/http.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { PLAYER_KINDS, cleanPlayer, cleanRounds, createTrial, estimateRun, playerLine, playerRequest, playerWords, readReview, reviewRequest, roundChecks, roundNeeds, stopLine, stopNeeds, summaryLines } from '../server/forge/trial.mjs'
import { withLanguage } from '../server/i18n.mjs'

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

test('the stand-in can be a kind of player, or one described; the round is still tried, and the reader is told', () => {
  assert.deepEqual(PLAYER_KINDS, ['', 'eager', 'quiet', 'bargain', 'heart', 'wild', 'own'])
  assert.deepEqual(cleanPlayer({ kind: 'quiet', text: '多余的' }), { kind: 'quiet', text: '' })
  assert.deepEqual(cleanPlayer({ kind: 'own', text: '  胆小，\n凡事先问清楚  ' }), { kind: 'own', text: '胆小， 凡事先问清楚' })
  assert.deepEqual(cleanPlayer({ kind: 'own', text: ' ' }), { kind: '', text: '' }, 'nothing written is no one in particular')
  assert.deepEqual(cleanPlayer({ kind: 'nobody' }), { kind: '', text: '' })
  assert.deepEqual(cleanPlayer(undefined), { kind: '', text: '' })
  assert.equal(cleanPlayer({ kind: 'own', text: '长'.repeat(500) }).text.length, 200)
  const story = [{ you: '', reply: '开场' }]
  // No one in particular: as it always was.
  const plain = playerRequest({ name: '卡' }, story, 'push')
  assert.equal(playerRequest({ name: '卡' }, story, 'push', cleanPlayer(null)).system, plain.system)
  assert.match(plain.system, /一到三句/)
  assert.doesNotMatch(plain.system, /这位玩家是这样的人/)
  const quiet = playerRequest({ name: '卡' }, story, 'push', { kind: 'quiet', text: '' })
  assert.match(quiet.system, /一句，越短越好/)
  assert.match(quiet.system, /这位玩家是这样的人：话很少.*这一轮要做的事还是要做/)
  assert.match(quiet.messages[0].content, /超出你本事或规矩/)
  assert.match(playerRequest({ name: '卡' }, story, 'go', { kind: 'own', text: '胆小' }).system, /这位玩家是这样的人：胆小。每一轮/)
  assert.equal(playerWords({ kind: 'own', text: '胆小！' }), '胆小！')
  assert.equal(playerWords({ kind: '', text: '' }), '')
  // The reader does not hold the player's ways against the card.
  const rounds = [{ input: '嗯。', told: '她看着你。' }]
  assert.doesNotMatch(reviewRequest({ name: '卡' }, rounds).system, /照这个性子扮的/)
  assert.match(reviewRequest({ name: '卡' }, rounds, { player: { kind: 'wild', text: '' } }).system, /这一局的玩家是照这个性子扮的：不按常理来.*不算卡的毛病/)
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
  assert.doesNotMatch(request.messages[0].content, /<开场>/)
  // The opening the rounds go on from, and the program's own rolls and fights, are not the card's to answer for.
  const full = reviewRequest({ name: '卡', description: '设定' }, [{ input: '我走', shown: '她说。' }], { opening: '她递来五十个铜子。', game: true })
  assert.match(full.messages[0].content, /<开场>\s+她递来五十个铜子。\s+<\/开场>\s+<试玩记录>/)
  assert.match(full.system, /开场里有的人物、东西和说法，后面再提不算矛盾/)
  assert.match(full.system, /程序按游戏规则替玩家掷骰、自动打完的/)
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

async function setup(t, { fail = null, rulebooks = null, gated = false } = {}) {
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
    keptToSchema: async (_, state) => ({ state }),
    cardWithSchema: async cardId => store.getCard(cardId),
    async runTurn(chatId, { parentId, input }) {
      if (fail && turns === fail) throw new Error('模型挂了')
      turns++
      const chat = await store.getChat(chatId)
      // As the engine keeps them: the entries' refs, and their titles beside.
      const user = { id: `u${turns}`, role: 'user', text: input, parent: parentId, injected: ['book1:0'], injectedTitles: ['世界'] }
      const node = { id: `a${turns}`, role: 'assistant', text: `第 ${turns} 回合的回复`, parent: user.id, state: {}, usage: { input: 100, output: 20 } }
      // The first reply stops on a roll, as the engine leaves one with the rules on.
      if (gated && turns === 1) node.gate = { kind: 'check', stat: '灵巧', dc: 12 }
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
    store, engine, jobs, run, rulebooks, cutNote: () => '',
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

test('a reply that stops on a roll or a fight is not held to what comes after the mark', () => {
  const stop = stopNeeds(needs)
  assert.deepEqual(kinds(roundChecks({ text: '她伸手。\n【检定|灵巧|DC12】', shown: '她伸手。', node: { gate: { kind: 'check' } } }, stop)), [])
  assert.deepEqual(stop.ranged, needs.ranged, 'numbers are still checked')
})

test('with the rules on, the report says how many stops were settled, and that the choices\' rolls were not tried', () => {
  const round = stops => ({ problems: [], state: {}, triggered: [], ...(stops ? { stops } : {}) })
  const text = rules => summaryLines([round(['check', 'battle']), round(['check']), round()], { needs, fields: [], start: {}, ruled: rules }).map(line => line.text).join('\n')
  assert.match(text(true), /检定 2 次、战斗 1 场/)
  assert.match(text(true), /选项上的检定和战斗没有试/)
  assert.doesNotMatch(text(false), /检定/)
  assert.match(summaryLines([round()], { needs, fields: [], start: {}, ruled: true }).at(-1).text, /没有停下来/)
})

// ─── A run on the real engine, with the 游戏规则 on ────────────────────────────

/**
 * A trial on the real app, the replies from `story` in order. `during(call, cardId)` runs while the first reply is being
 * written, as a player changing the rules then would.
 */
async function gameRun(t, story, { during = null, settings = {} } = {}) {
  const told = []
  let cardId
  let call
  const model = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const all = JSON.stringify(JSON.parse(body).messages)
    let content = '……'
    if (all.includes('替一位玩家试玩')) content = '我往前走。'
    else if (all.includes('审读员')) {
      told.push(all)
      content = '<review>{"summary":"能玩","issues":[]}</review>'
    } else {
      told.push(all)
      if (told.length === 1 && during) await during(call, cardId)
      content = story.shift() ?? content
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'trial-game-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    model.closeAllConnections()
    model.close()
    app.network?.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  call = async (pathname, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(base + pathname, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const provider = (await call('/api/providers', { name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'x', models: ['writer'] })).body
  await call('/api/settings', { model: `${provider.id}/writer`, ...settings }, 'PUT')
  const file = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '林青禾', description: '茶馆掌柜', first_mes: '欢迎光临。' } })).toString('base64')
  const card = (await call('/api/cards/import', { filename: 'c.json', data: file })).body
  cardId = card.id
  await call(`/api/cards/${card.id}/game`, { level: 'full' }, 'PUT')
  await call(`/api/cards/${card.id}/trial`, { rounds: 3, player: { kind: 'quiet' } }, 'PUT')
  assert.equal((await call(`/api/cards/${card.id}/trial/run`, {})).status, 200)
  let view
  for (let i = 0; i < 200; i++) {
    view = (await call(`/api/cards/${card.id}/trial`)).body
    if (!view.job) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  // Who the stand-in played as is kept with the pick and with the report.
  assert.deepEqual(view.player, { kind: 'quiet', text: '' })
  assert.deepEqual(view.report?.player ?? view.player, { kind: 'quiet', text: '' })
  assert.ok(view.players.includes('own'))
  return { view, told, root, cardId }
}

test('a card with the rules on: a stop is rolled or fought through as the player would, and the round is checked whole', async t => {
  const story = [
    '她伸手去够绳子。\n【检定|灵巧|DC12】\n<choices>\nA. 走\n</choices>',
    '你抓住了绳子。\n<choices>\nA. 继续\nB. 停\n</choices>',
    '林子里窜出一只灰狼。\n【战斗|灰狼:普通】',
    '你收起刀。\n<choices>\nA. 继续\n</choices>',
    '路边有间茶馆。\n<choices>\nA. 进去\n</choices>',
  ]
  const { view, told, root, cardId } = await gameRun(t, story)
  assert.equal(view.error, null)
  const { rounds, lines } = view.report
  assert.equal(rounds.length, 3)
  assert.deepEqual(rounds.map(round => round.stops ?? []), [['check'], ['battle'], []])
  assert.deepEqual(rounds.flatMap(round => round.problems), [], 'a stop writes no choices, and is not told off for it')
  assert.match(rounds[0].shown, /^她伸手去够绳子。\n\n（灵巧检定：\d+，需要 12，(大成功|成功|险胜|失败)）\n\n你抓住了绳子。$/)
  assert.match(rounds[1].shown, /^林子里窜出一只灰狼。\n\n（战斗：(胜利|战败|逃脱)，\d+ 回合，(击倒 [^，]+，)?生命 \d+\/\d+）\n\n你收起刀。$/)
  assert.ok(!rounds.some(round => round.shown.includes('【')), 'the marks are not what the player sees')
  assert.ok(rounds.every(round => !('told' in round)), 'what the models were given is not kept')
  assert.match(lines.map(line => line.text).join('\n'), /行动选项：3 回合写了 3 回合/)
  assert.match(lines.at(-1).text, /检定 1 次、战斗 1 场/)
  assert.equal(told.length, 6, 'a stop takes one more reply, then the reader')
  assert.match(told[1], /<检定结果>/)
  assert.match(told[3], /<战斗结果>/)
  assert.match(told[5], /掷骰：灵巧 \d+，需要 12/, 'the reader gets the roll as the engine wrote it')
  assert.deepEqual(await createStore(root).listChats(cardId), [], 'the chat it played in is gone')
})

test('rules changed while a trial is playing: the fight is played on the rules the engine settles it with', async t => {
  for (const fightDifficulty of ['hard', 'easy']) {
    const story = ['林子里窜出一群灰狼。\n【战斗|灰狼×3】', '你收起刀。\n<choices>\nA. 继续\n</choices>']
    const during = (call, cardId) => call(`/api/cards/${cardId}/game`, { fightDifficulty }, 'PUT')
    const { view } = await gameRun(t, story, { during })
    assert.equal(view.error, null, fightDifficulty)
    assert.deepEqual(view.report.rounds[0].stops, ['battle'])
    assert.match(view.report.rounds[0].shown, /你收起刀。$/)
  }
})

test('rules turned off while a trial is playing: the stop is left as it is, and the trial goes on', async t => {
  let reads = 0
  // On when the run begins, off by the time the first reply has stopped.
  const rulebooks = { read: async () => (reads++ ? { level: 'off' } : { level: 'full' }) }
  const { trial, done } = await setup(t, { rulebooks, gated: true })
  await trial.trialUpdate('card1', { rounds: 3 })
  const view = await trial.trialRun('card1')
  await done
  assert.equal(view.error, null)
  assert.equal(view.report.rounds.length, 3)
  assert.equal(view.report.rounds[0].stops, undefined, 'nothing was settled')
  assert.equal(view.report.rounds[0].shown, '第 1 回合的回复')
  assert.equal(view.report.rounds[1].shown, '第 2 回合的回复')
})

test('the roll and the fight between two replies come in the page\'s language', async t => {
  const story = ['她伸手去够绳子。\n【检定|灵巧|DC12】', '你抓住了绳子。\n<choices>\nA. 继续\n</choices>']
  const { view } = await gameRun(t, story, { settings: { uiLanguage: 'en' } })
  assert.match(view.report.rounds[0].shown, /\n\n\(灵巧 check: \d+, needs 12, (Critical success|Success|Success at a cost|Failure)\)\n\n/)
  assert.doesNotMatch(view.report.rounds[0].shown, /掷骰|（/)
  assert.equal(withLanguage('en', () => stopLine({ battle: { over: 'story', foes: '灰狼' } })), '(No fight, left to the story: 灰狼)')
  assert.equal(withLanguage('zh', () => stopLine({ battle: { over: 'won', rounds: 3, downed: '山贼头目、山贼 ×3', life: 77, maxLife: 100 } })), '（战斗：胜利，3 回合，击倒 山贼头目、山贼 ×3，生命 77/100）')
  assert.equal(withLanguage('zh', () => stopLine({ check: { stat: '', total: 9, dc: 12, lacks: '绳子', tier: 'fail' } })), '（检定：9，需要 12，缺绳子，失败）')
})
