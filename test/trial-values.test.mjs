// 试玩体检 on a card with variables: the events that wait on a value against the rounds it held in, the values against
// the card's update rules, what the reader is given for the rest, and the problems reaching 检查这张卡 (trial.mjs).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { createApp } from '../server/http.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { estimateRun, playedMark, readReview, reviewRequest, roundChecks, roundNeeds, ruledFields, summaryLines, trialFindings, updateRules, valueChecks, valueEvents } from '../server/forge/trial.mjs'
import { notHappened } from '../server/forge/write.mjs'
import { initTemplates, templateSession } from '../server/template.mjs'
import { preloadEntries } from '../server/worldbook.mjs'

await initTemplates()

const LIKING = 'getvar("stat_data.林.好感", { defaults: 0 })'
// An event as 创作角色卡 writes it on a card with variables: its condition, and kept to once by the list.
const onceEvent = (name, test, extra = {}) => ({ uid: name, comment: `事件_${name}`, content: `@@if ${test} && ${notHappened('zh', name)}\n<event>${name}</event>`, constant: true, enabled: true, keys: [], ...extra })
const RULES = {
  uid: 'rules',
  comment: '变量更新规则',
  constant: true,
  enabled: true,
  keys: [],
  content: '<rules>\n变量更新规则:\n  林:\n    好感:\n      type: number\n      range: 0~100\n      check:\n        - 帮她就加，伤她就减\n  金钱:\n    type: number\n    check: 花了就减\n  天气: 按剧情更新\n</rules>',
}
const state = (liking, done = [], rest = {}) => ({ 林: { 好感: liking }, 金钱: 100, 天气: '晴', 已发生事件: done, ...rest })
const played = (...states) => states.map(each => ({ state: each, triggered: [], problems: [] }))
const texts = out => out.lines.map(line => `${line.level} ${line.text}`)

test('an event the card keeps to once is read with its condition and the list it goes on', () => {
  const books = [{ entries: [
    onceEvent('告白', `${LIKING} >= 60`),
    { uid: 9, comment: '只按关键词', content: `@@if ${notHappened('zh', '偶遇')}\n偶遇`, keys: ['街'], enabled: true },
    { uid: 8, comment: '关了', content: `@@if ${LIKING} > 1\n关`, keys: [], enabled: false },
  ] }]
  assert.deepEqual(valueEvents(books), [{ title: '事件_告白', value: `(${LIKING} >= 60)`, once: { list: '已发生事件', item: '告白' }, keyed: false }])
  assert.equal(valueEvents([{ entries: [{ uid: 1, comment: '心事', content: `@@if ${LIKING} >= 50\n心事`, keys: ['心事'], enabled: true }] }])[0].keyed, true)
})

test('an event that comes in the round its condition holds is fine; one before it holds is told, with the round', () => {
  const events = valueEvents([{ entries: [onceEvent('告白', `${LIKING} >= 60`)] }])
  const ontime = valueChecks(played(state(40), state(65), state(70, ['告白'])), { start: state(30), events })
  assert.deepEqual(texts(ontime), ['ok 「事件_告白」第 3 回合数值条件满足，当回合就发生了'])
  const early = valueChecks(played(state(40, ['告白']), state(45, ['告白'])), { start: state(30), events })
  assert.deepEqual(texts(early), ['error 第 1 回合「事件_告白」提前发生了：数值条件还没满足'])
  assert.equal(early.problems[0][0].kind, 'event', 'the round shows it too')
  const late = valueChecks(played(state(65), state(70), state(70, ['告白'])), { start: state(30), events })
  assert.deepEqual(texts(late), ['ok 「事件_告白」第 2 回合数值条件满足，第 3 回合发生'])
})

test('an event sent round after round that never comes is told; one waiting on keywords that never came up is not held against it', () => {
  const constant = valueEvents([{ entries: [onceEvent('告白', `${LIKING} >= 60`)] }])
  assert.deepEqual(texts(valueChecks(played(state(65), state(70), state(75)), { start: state(30), events: constant })), ['warn 「事件_告白」第 2 回合起数值条件满足，发给了模型 2 回合，到最后都没发生'])
  const keyed = valueEvents([{ entries: [onceEvent('告白', `${LIKING} >= 60`, { constant: false, keys: ['告白'] })] }])
  assert.deepEqual(texts(valueChecks(played(state(65), state(70)), { start: state(30), events: keyed })), ['ok 「事件_告白」第 2 回合起数值条件满足，但没有提到它的关键词，没发给模型'])
  const sent = played(state(65), state(70))
  sent[1].triggered = ['事件_告白']
  assert.match(texts(valueChecks(sent, { start: state(30), events: keyed }))[0], /^warn .*发给了模型 1 回合/)
  assert.deepEqual(texts(valueChecks(played(state(40)), { start: state(30), events: constant })), ['ok 这些按数值触发的事件条件一直没满足：事件_告白。也许只是没玩到'])
})

test('an event taken off the list of what happened is told', () => {
  const events = valueEvents([{ entries: [onceEvent('告白', `${LIKING} >= 60`)] }])
  const out = valueChecks(played(state(65), state(70, ['告白']), state(70)), { start: state(30), events })
  assert.ok(texts(out).includes('error 「已发生事件」里的「告白」第 3 回合被删掉了，规则是加过的不删'))
  assert.equal(out.problems[2][0].kind, 'event')
})

test('without a list of what happened, the rounds an event was due go to the reader, who tells whether it came', () => {
  const events = valueEvents([{ entries: [{ uid: 1, comment: '吵架', content: `@@if ${LIKING} < 20\n她发了火。`, constant: true, enabled: true, keys: [] }] }])
  const out = valueChecks(played(state(25), state(15), state(10)), { start: state(30), events })
  assert.deepEqual(texts(out), ['ok 「吵架」第 3 回合数值条件满足'])
  assert.match(out.notes, /「吵架」条件：.*< 20\)；满足的回合：3；发给模型的回合：3/)
  assert.match(reviewRequest({ name: '卡' }, [{ input: '我走', shown: '她说。' }], { values: out.notes }).system, /事件：按数值触发的事件/)
})

test('the update rules are read from the card, ranges and all, and joined to the status bar', () => {
  const rules = updateRules([{ entries: [RULES] }])
  assert.deepEqual(rules, [
    { path: '林.好感', label: '好感', check: '帮她就加，伤她就减', min: 0, max: 100 },
    { path: '金钱', label: '金钱', check: '花了就减' },
    { path: '天气', label: '天气', check: '按剧情更新' },
  ])
  assert.deepEqual(updateRules([{ entries: [{ uid: 1, comment: '变量更新规则', content: '不是 YAML: [', enabled: true }] }]), [])
  const fields = ruledFields([{ path: 'stat_data.林.好感', label: '好感度' }], rules)
  assert.deepEqual(fields.map(field => [field.label, field.min, field.max]), [['好感度', 0, 100], ['金钱', undefined, undefined], ['天气', undefined, undefined]])
  assert.deepEqual(roundNeeds({ mvu: true, choices: false, blocks: [], fields }).ranged.map(field => field.label), ['好感度'], 'a range from the rules is held to every round')
})

test('a value whose kind changed, or that went, is told with the round and the variable', () => {
  const fields = updateRules([{ entries: [RULES] }])
  const out = valueChecks(played(state(40), state(45, [], { 金钱: '很多' }), { 林: { 好感: [50, '好感描述'] }, 金钱: '很多', 已发生事件: [] }), { start: state(30), fields })
  assert.deepEqual(texts(out), ['error 「金钱」开局是数字，第 2 回合变成了文字', 'error 「天气」第 3 回合被删掉了'])
  assert.deepEqual(out.problems.map(found => found.map(problem => problem.what)), [[], ['「金钱」从数字变成了文字："很多"'], ['「天气」被删掉了']], 'an old MVU [value, description] is still a number')
  assert.match(out.notes, /- 好感（林\.好感）：帮她就加，伤她就减；范围 0 到 100/)
  assert.match(out.notes, /第 1 回合：好感 30→40\n- 第 2 回合：好感 40→45；金钱 100→很多\n- 第 3 回合：好感 45→50；天气 晴→/)
})

test('numbers out of range are listed by variable and round, and the lines that are not fine reach 检查这张卡', () => {
  const ranged = roundNeeds({ mvu: true, choices: false, blocks: [], fields: updateRules([{ entries: [RULES] }]) })
  const rounds = [120, 50, 130, -5].map(liking => ({ problems: roundChecks({ text: '<UpdateVariable>[]</UpdateVariable>', shown: '故事。', node: { state: state(liking) } }, ranged), state: state(liking), triggered: [] }))
  const lines = summaryLines(rounds, { needs: ranged, fields: [], start: state(30) })
  assert.ok(lines.some(line => line.level === 'error' && line.text === '数值超出范围：「好感」第 1、3、4 回合'), JSON.stringify(lines))
  const events = valueEvents([{ entries: [onceEvent('告白', `${LIKING} >= 60`)] }])
  const values = valueChecks(played(state(40, ['告白'])), { start: state(30), events })
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '卡', description: '', first_mes: '' } })
  const issues = readReview('<review>{"summary":"","issues":[{"round":2,"kind":"数值","variable":"金钱","what":"买了茶却没扣钱","fix":"规则写明花钱就减"}]}</review>', 3).issues
  const report = { at: '2026-11-07T10:00:00.000Z', mark: playedMark(card), lines: [...lines, ...values.lines, { level: 'ok', text: '「事件_甲」第 2 回合数值条件满足，当回合就发生了' }], issues }
  const found = trialFindings(report, card)
  assert.deepEqual(found.map(item => item.title).filter(title => /好感|告白|金钱/.test(title)), ['数值超出范围：「好感」第 1、3、4 回合', '第 1 回合「事件_告白」提前发生了：数值条件还没满足', '「金钱」买了茶却没扣钱'])
  assert.ok(!found.some(item => item.title.includes('当回合就发生了')), 'what went right stays in the report')
  assert.deepEqual([found.at(-1).round, found.at(-1).kind], [2, '数值'])
})

test('the reader gets the values and the events in its one call, and the estimate counts them', () => {
  const plain = reviewRequest({ name: '卡' }, [{ input: '我走', shown: '她说。' }])
  assert.doesNotMatch(plain.system, /数值：|variable/, 'a card without variables is read as before')
  const out = valueChecks(played(state(40)), { start: state(30), fields: updateRules([{ entries: [RULES] }]) })
  const request = reviewRequest({ name: '卡' }, [{ input: '我走', shown: '她说。' }], { values: out.notes })
  assert.match(request.system, /数值：.*该变没变/)
  assert.match(request.messages[0].content, /<变量和事件>\n变量和它的更新规则：[\s\S]*好感 30→40[\s\S]*<\/变量和事件>/)
  const card = { description: '设定' }
  const format = { uid: 'f', comment: '变量输出格式', content: '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>', constant: true, enabled: true, keys: [] }
  assert.ok(estimateRun(card, [{ entries: [format] }], 6).input > estimateRun(card, [], 6).input + 6 * 100, 'the review input grows by the values sent with it')
  assert.ok(estimateRun(card, [{ entries: [format, RULES] }], 6).input > estimateRun(card, [{ entries: [format] }], 6).input, 'and by the rules')
})

test('a condition the program cannot run gets no verdict: the reader is told which rounds, nothing reaches 检查这张卡', () => {
  // A helper from an @@preload entry the bare sandbox does not have.
  const events = valueEvents([{ entries: [onceEvent('告白', `够了(${LIKING}, 60)`)] }])
  const out = valueChecks(played(state(65), state(70, ['告白'])), { start: state(30), events })
  assert.deepEqual(texts(out), ['ok 这些按数值触发的事件，程序算不出条件，交给审读按故事判断：事件_告白'])
  assert.deepEqual(out.problems, [[], []])
  assert.match(out.notes, /满足的回合：无；程序算不出条件的回合：1、2（按故事和变量判断该不该发生）；发给模型的回合：无（算不出的回合不知道）；记为已发生：第 2 回合/)
  assert.match(reviewRequest({ name: '卡' }, [{ input: '我走', shown: '她说。' }], { values: out.notes }).system, /程序算不出条件的/)
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '卡', description: '', first_mes: '' } })
  assert.deepEqual(trialFindings({ at: '2026-11-07T10:00:00.000Z', mark: playedMark(card), lines: out.lines, issues: [] }, card), [])
  // Known not to hold before the round it came in: still early, even with a round after it unknown.
  const mixed = valueEvents([{ entries: [onceEvent('翻脸', `(${LIKING} <= 10 || (${LIKING} >= 50 && 没有这个()))`)] }])
  assert.deepEqual(texts(valueChecks(played(state(55, ['翻脸']), state(60, ['翻脸'])), { start: state(30), events: mixed })), ['error 第 1 回合「事件_翻脸」提前发生了：数值条件还没满足'])
  // Unknown before it: no verdict.
  assert.deepEqual(texts(valueChecks(played(state(55), state(60, ['翻脸'])), { start: state(30), events: mixed })), ['ok 这些按数值触发的事件，程序算不出条件，交给审读按故事判断：事件_翻脸'])
  // A keyword entry the engine sent held there, whatever the program made of it.
  const keyed = valueEvents([{ entries: [onceEvent('心事', `够了(${LIKING}, 60)`, { constant: false, keys: ['心事'] })] }])
  const sent = played(state(65), state(70, ['心事']))
  sent[1].triggered = ['事件_心事']
  assert.deepEqual(texts(valueChecks(sent, { start: state(30), events: keyed })), ['ok 「事件_心事」第 2 回合数值条件满足，当回合就发生了'])
})

test('conditions run in the sandbox the run gives, with the @@preload helpers and the chat variables the engine has', () => {
  const books = [{ entries: [{ uid: 'p', comment: '预载', content: '@@only_preload\n<% define("够了", (v, n) => v >= n) %>', enabled: false, keys: [] }, onceEvent('告白', `够了(${LIKING}, 60) && getvar("见过面")`)] }]
  const events = valueEvents(books)
  const local = [{}, { 见过面: true }]
  const sandbox = (each, i) => templateSession({ state: each, local: local[i], preload: preloadEntries(books) })
  const out = valueChecks(played(state(65), state(70, ['告白'])), { start: state(30), events, sandbox })
  assert.deepEqual(texts(out), ['ok 「事件_告白」第 2 回合数值条件满足，当回合就发生了'])
  // Without them it can't say, and says nothing against the card.
  assert.ok(!texts(valueChecks(played(state(65), state(70, ['告白'])), { start: state(30), events })).some(line => line.startsWith('error')))
})

// ─── On the real engine ───────────────────────────────────

/** A card played on the real app with its book `entries`, the replies from `story` in order. */
async function valueRun(t, story, entries, { game = null, player = '我往前走。' } = {}) {
  const told = []
  let reviewed = ''
  let calls = 0
  const model = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    calls++
    const messages = JSON.parse(body).messages
    const all = JSON.stringify(messages)
    let content = '……'
    if (all.includes('替一位玩家试玩')) content = player
    else if (all.includes('审读员')) {
      reviewed = messages.map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n')
      content = '<review>{"summary":"能玩","issues":[{"round":2,"kind":"数值","variable":"金钱","what":"买了茶钱却变成了文字","fix":"规则写明金钱只写数字"}]}</review>'
    } else {
      told.push(all)
      content = story.shift() ?? content
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'trial-values-'))
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
  const call = async (pathname, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(base + pathname, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const provider = (await call('/api/providers', { name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'x', models: ['writer'] })).body
  await call('/api/settings', { model: `${provider.id}/writer` }, 'PUT')
  const raw = { spec: 'chara_card_v2', data: { name: '林', description: '茶馆掌柜', first_mes: '欢迎光临。', character_book: { entries: entries.map((entry, i) => ({ insertion_order: i, extensions: {}, ...entry, uid: i })) } } }
  const imported = (await call('/api/cards/import', { filename: 'c.json', data: Buffer.from(JSON.stringify(raw)).toString('base64') })).body
  const id = imported.card?.id ?? imported.id
  if (game) assert.equal((await call(`/api/cards/${id}/game`, { level: 'full', ...game }, 'PUT')).status, 200)
  await call(`/api/cards/${id}/trial`, { rounds: 3 }, 'PUT')
  assert.equal((await call(`/api/cards/${id}/trial/run`, {})).status, 200)
  let view
  for (let i = 0; i < 200; i++) {
    view = (await call(`/api/cards/${id}/trial`)).body
    if (!view.job) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return { view, told, reviewed: () => reviewed, calls: () => calls, call, id }
}

const update = patch => `\n<UpdateVariable>\n<JSONPatch>\n${JSON.stringify(patch)}\n</JSONPatch>\n</UpdateVariable>`

test('on the real engine: events against the rounds their condition held in, values against the rules, in the report and the check list', async t => {
  const entries = [
    { comment: '[InitVar]初始变量', content: '{"林":{"好感":30},"金钱":100,"天气":"晴","已发生事件":[]}', keys: [], constant: false, enabled: false },
    RULES,
    { comment: '变量输出格式', content: '每次回复的最后写 <UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable>。', keys: [], constant: true, enabled: true },
    onceEvent('告白', `${LIKING} >= 60`),
    onceEvent('翻脸', `${LIKING} <= 10`),
  ].map(({ uid, ...entry }) => entry)
  const story = [
    `她笑了。${update([{ op: 'replace', path: '/林/好感', value: 45 }, { op: 'add', path: '/已发生事件/-', value: '翻脸' }])}`,
    `你付了茶钱。${update([{ op: 'replace', path: '/林/好感', value: 65 }, { op: 'replace', path: '/金钱', value: '很多' }])}`,
    `她红着脸说了心里话。${update([{ op: 'replace', path: '/林/好感', value: 70 }, { op: 'add', path: '/已发生事件/-', value: '告白' }])}`,
  ]
  const { view, told, reviewed, calls, call, id } = await valueRun(t, story, entries)
  assert.equal(view.error, null)
  const lines = view.report.lines.map(line => `${line.level} ${line.text}`)
  assert.ok(lines.includes('error 第 1 回合「事件_翻脸」提前发生了：数值条件还没满足'), lines.join('\n'))
  assert.ok(lines.includes('ok 「事件_告白」第 3 回合数值条件满足，当回合就发生了'), lines.join('\n'))
  assert.ok(lines.includes('error 「金钱」开局是数字，第 2 回合变成了文字'), lines.join('\n'))
  assert.deepEqual(view.report.rounds.map(round => round.problems.map(problem => problem.kind).filter(kind => kind !== 'choices')), [['event'], ['shape'], []])
  // The program's reading matches what the engine sent: the event only in the round its condition held.
  assert.equal(told.length, 3)
  assert.deepEqual(told.map(prompt => prompt.includes('<event>告白</event>')), [false, false, true])
  assert.ok(!told.some(prompt => prompt.includes('<event>翻脸</event>')))
  // Still one call to read it, with the values in it: three player lines, three replies, the reader.
  assert.equal(calls(), 7)
  assert.match(reviewed(), /<变量和事件>[\s\S]*好感 45→65；金钱 100→很多[\s\S]*「事件_告白」条件：[\s\S]*记为已发生：第 3 回合/)
  assert.deepEqual(view.report.issues.map(issue => [issue.round, issue.kind, issue.what]), [[2, '数值', '「金钱」买了茶钱却变成了文字']])
  const check = (await call(`/api/cards/${id}/check`)).body
  const titles = check.findings.filter(item => item.from === 'trial').map(item => item.title)
  assert.ok(titles.includes('第 1 回合「事件_翻脸」提前发生了：数值条件还没满足'), titles.join('\n'))
  assert.ok(titles.includes('「金钱」开局是数字，第 2 回合变成了文字'))
  assert.ok(titles.includes('「金钱」买了茶钱却变成了文字'))
  assert.ok(!titles.some(title => title.includes('当回合就发生了')))
})

test('a card without variables is played and read as before: no value lines, nothing more for the reader', async t => {
  const { view, reviewed, calls } = await valueRun(t, ['路边有间茶馆。', '你坐下。', '茶来了。'], [{ comment: '世界', content: '旧城。', keys: [], constant: true, enabled: true }])
  assert.equal(view.error, null)
  assert.equal(calls(), 7)
  assert.doesNotMatch(reviewed(), /变量和事件|数值：/)
  assert.ok(!view.report.lines.some(line => /数值条件|开局是|被删掉了/.test(line.text)))
})

test('on the real engine: a condition on an @@preload helper or a chat variable is run as the engine runs it, not called early', async t => {
  const entries = [
    { comment: '[InitVar]初始变量', content: '{"林":{"好感":30},"已发生事件":[]}', keys: [], constant: false, enabled: false },
    { comment: '变量输出格式', content: '每次回复的最后写 <UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable>。', keys: [], constant: true, enabled: true },
    { comment: '预载', content: '@@only_preload\n<% define("够了", function (v, n) { return v >= n }) %>', keys: [], constant: false, enabled: false },
    onceEvent('告白', `够了(${LIKING}, 60) && getvar("见过面")`),
  ]
  const story = [
    // A chat variable the reply's own template sets.
    `<% setLocalVar("见过面", true) %>她笑了。${update([{ op: 'replace', path: '/林/好感', value: 65 }])}`,
    `她说了心里话。${update([{ op: 'add', path: '/已发生事件/-', value: '告白' }])}`,
    `茶凉了。${update([])}`,
  ]
  const { view, told, call, id } = await valueRun(t, story, entries.map(({ uid, ...entry }) => entry))
  assert.equal(view.error, null)
  // The engine sent it in the second round, and it came then.
  assert.deepEqual(told.map(prompt => prompt.includes('<event>告白</event>')).slice(0, 2), [false, true])
  const lines = view.report.lines.map(line => `${line.level} ${line.text}`)
  assert.ok(lines.includes('ok 「事件_告白」第 2 回合数值条件满足，当回合就发生了'), lines.join('\n'))
  assert.ok(!lines.some(line => line.includes('提前发生了')), lines.join('\n'))
  assert.ok(!view.report.rounds.some(round => 'vars' in round || 'from' in round), 'what the run kept for the conditions stays out of the report')
  const titles = (await call(`/api/cards/${id}/check`)).body.findings.filter(item => item.from === 'trial').map(item => item.title)
  assert.ok(!titles.some(title => title.includes('告白')), titles.join('\n'))
})

test('a round the rules stopped is several turns: a condition met on any of them was met that round', () => {
  const events = valueEvents([{ entries: [onceEvent('告白', `${LIKING} >= 60`)] }])
  // The reply wrote the value before its roll; the settle turn began on it, was sent the event, and the event came.
  const rounds = played(state(65, ['告白']), state(70, ['告白']))
  rounds[0].turns = [{ state: state(30) }, { state: state(65) }]
  const out = valueChecks(rounds, { start: state(30), events })
  assert.deepEqual(texts(out), ['ok 「事件_告白」第 1 回合数值条件满足，当回合就发生了'])
  assert.match(out.notes, /满足的回合：1、2；发给模型的回合：1；记为已发生：第 1 回合/)
  // Marked already when the settle turn began: not sent again.
  const before = played(state(65, ['告白']))
  before[0].turns = [{ state: state(65) }, { state: state(65, ['告白']) }]
  assert.match(valueChecks(before, { start: state(30), events }).notes, /发给模型的回合：1；/)
})

const BASE = [
  { comment: '[InitVar]初始变量', content: '{"林":{"好感":30},"主角":{"生命":20},"已发生事件":[]}', keys: [], constant: false, enabled: false },
  { comment: '变量输出格式', content: '每次回复的最后写 <UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable>。', keys: [], constant: true, enabled: true },
]
const eventTitles = async (call, id) => (await call(`/api/cards/${id}/check`)).body.findings.filter(item => item.from === 'trial').map(item => item.title)

test('on the real engine: an event sent on its keywords is counted as sent, and one that never came reaches the check list', async t => {
  const entries = [...BASE, onceEvent('告白', `${LIKING} >= 60`, { constant: false, keys: ['茶'] })]
  const story = [`她笑了。${update([{ op: 'replace', path: '/林/好感', value: 65 }])}`, `茶凉了。${update([])}`, `茶又凉了。${update([])}`]
  const { view, told, reviewed, call, id } = await valueRun(t, story, entries.map(({ uid, ...entry }) => entry), { player: '我要一杯茶。' })
  assert.equal(view.error, null)
  assert.deepEqual(told.map(prompt => prompt.includes('<event>告白</event>')), [false, true, true])
  assert.deepEqual(view.report.rounds.map(round => round.triggered), [[], ['事件_告白'], []], 'the titles, as the events and the report go by')
  const lines = view.report.lines.map(line => `${line.level} ${line.text}`)
  assert.ok(lines.includes('warn 「事件_告白」第 2 回合起数值条件满足，发给了模型 1 回合，到最后都没发生'), lines.join('\n'))
  assert.ok(lines.includes('ok 按关键词的世界书触发了 1 条，共 1 条'), lines.join('\n'))
  assert.match(reviewed(), /发给模型的回合：2；没有记为已发生/)
  assert.ok((await eventTitles(call, id)).includes('「事件_告白」第 2 回合起数值条件满足，发给了模型 1 回合，到最后都没发生'))
})

test('on the real engine: an event sent on the turn after a fight, on the life the fight left, came on time', async t => {
  const entries = [...BASE, { comment: '事件_负伤', content: `@@if getvar("stat_data.主角.生命", { defaults: 20 }) != 20 && ${notHappened('zh', '负伤')}\n<event>负伤</event>`, keys: [], constant: true, enabled: true }]
  const story = ['林子里窜出一群灰狼。\n【战斗|灰狼×3】', `你负了伤。${update([{ op: 'add', path: '/已发生事件/-', value: '负伤' }])}`, `茶凉了。${update([])}`, `茶凉了。${update([])}`]
  const { view, told, call, id } = await valueRun(t, story, entries, { game: { bindings: { life: '主角.生命' } } })
  assert.equal(view.error, null)
  assert.deepEqual(view.report.rounds[0].stops, ['battle'])
  // The fight's own reply was not sent it, the settle turn was.
  assert.deepEqual(told.slice(0, 2).map(prompt => prompt.includes('<event>负伤</event>')), [false, true])
  const lines = view.report.lines.map(line => `${line.level} ${line.text}`)
  assert.ok(lines.includes('ok 「事件_负伤」第 1 回合数值条件满足，当回合就发生了'), lines.join('\n'))
  assert.ok(!(await eventTitles(call, id)).some(title => title.includes('负伤')))
  assert.ok(!view.report.rounds.some(round => 'turns' in round), 'what the run kept for the conditions stays out of the report')
})

test('on the real engine: a value written before a roll, the event sent on the settle turn, came on time', async t => {
  const entries = [...BASE, onceEvent('告白', `${LIKING} >= 60`)]
  const story = [`她笑了。${update([{ op: 'replace', path: '/林/好感', value: 65 }])}\n【检定|灵巧|DC12】`, `她说了心里话。${update([{ op: 'add', path: '/已发生事件/-', value: '告白' }])}`, `茶凉了。${update([])}`, `茶凉了。${update([])}`]
  const { view, call, id } = await valueRun(t, story, entries.map(({ uid, ...entry }) => entry), { game: {} })
  assert.equal(view.error, null)
  assert.deepEqual(view.report.rounds[0].stops, ['check'])
  const lines = view.report.lines.map(line => `${line.level} ${line.text}`)
  assert.ok(lines.includes('ok 「事件_告白」第 1 回合数值条件满足，当回合就发生了'), lines.join('\n'))
  assert.ok(!(await eventTitles(call, id)).some(title => title.includes('告白')))
})

test('on the real engine: a condition on an app-wide variable reads it as each turn found it, not as the run left it', async t => {
  const entries = [...BASE, onceEvent('告白', `${LIKING} >= 60 && getvar("季节", { scope: "global", defaults: "春" }) == "春"`)]
  const story = [`她笑了。${update([{ op: 'replace', path: '/林/好感', value: 65 }])}`, `她说了心里话。<% setvar("季节", "夏", { scope: "global" }) %>${update([{ op: 'add', path: '/已发生事件/-', value: '告白' }])}`, `茶凉了。${update([])}`]
  const { view, told } = await valueRun(t, story, entries.map(({ uid, ...entry }) => entry))
  assert.equal(view.error, null)
  assert.deepEqual(told.slice(0, 2).map(prompt => prompt.includes('<event>告白</event>')), [false, true])
  const lines = view.report.lines.map(line => `${line.level} ${line.text}`)
  assert.ok(lines.includes('ok 「事件_告白」第 2 回合数值条件满足，当回合就发生了'), lines.join('\n'))
})
