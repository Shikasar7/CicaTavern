// 试玩体检's problems in 检查这张卡: listed with where they came from, out of date once the card has moved on, and fixed
// through the model's suggestions only when asked, taken in and back as any other (trial.mjs, check-session.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { initTemplates } from '../server/template.mjs'
import { checkRequest, readCheck } from '../server/forge/check-model.mjs'
import { playedMark, reportOutdated, trialFindings } from '../server/forge/trial.mjs'

await initTemplates()

const rawCard = () => ({
  spec: 'chara_card_v3',
  data: {
    name: '林青禾',
    description: '旧城茶馆的掌柜。',
    first_mes: '「又下雨了。」',
    extensions: {},
    character_book: { entries: [{ uid: 0, comment: '规矩', content: '茶馆的规矩。', keys: [], constant: true, enabled: true }] },
  },
})

const REPORT = {
  at: '2026-11-07T10:00:00.000Z',
  model: '测试模型',
  lines: [{ level: 'ok', text: '没有后台内容露给玩家' }, { level: 'error', text: '露出了隐藏内容：3 回合' }, { level: 'warn', text: '这些变量一直没变过：好感度' }],
  issues: [{ round: 2, kind: '抢话', what: '替玩家决定了去处', quote: '你决定去旧城', fix: '规则里写明不替玩家做决定' }],
}

test('a report as findings: what went wrong, where it came from, and whether the card has moved on since', () => {
  const card = normalizeCard(rawCard())
  const report = { ...REPORT, mark: playedMark(card) }
  const found = trialFindings(report, card)
  assert.deepEqual(found.map(item => [item.from, item.level, item.title]), [['trial', 'error', '露出了隐藏内容：3 回合'], ['trial', 'warn', '这些变量一直没变过：好感度'], ['trial', 'warn', '替玩家决定了去处']])
  assert.deepEqual([found[2].round, found[2].kind, found[2].quote, found[2].fix], [2, '抢话', '你决定去旧城', '规则里写明不替玩家做决定'])
  assert.ok(found.every(item => item.changes.length === 0 && !item.outdated))
  assert.deepEqual(trialFindings(report, card).map(item => item.id), found.map(item => item.id), 'the same ids each time, for ignoring')
  assert.notDeepEqual(trialFindings({ ...report, at: '2026-11-08T00:00:00.000Z' }, card).map(item => item.id), found.map(item => item.id), 'a new run starts over')

  card.creatorNotes = '作者的话'
  assert.equal(reportOutdated(report, card), false, 'what the run did not play with does not count')
  card.book.entries[0].content = '茶馆的规矩。不替玩家做决定。'
  assert.equal(reportOutdated(report, card), true)
  assert.ok(trialFindings(report, card).every(item => item.outdated))
  assert.ok(trialFindings(REPORT, normalizeCard(rawCard())).every(item => item.outdated), 'a report from before marks were kept cannot tell')
  assert.deepEqual(trialFindings(null, card), [])
})

test('asked about a trial: its problems numbered in place of the focus picks, and the answer says which it fixes', () => {
  const card = normalizeCard(rawCard())
  const trial = trialFindings({ ...REPORT, mark: playedMark(card) }, card)
  const { request } = checkRequest(card, [], { focus: ['rules', 'style'], trial, outdated: true })
  assert.match(request.system, /试玩里读出的问题/)
  assert.doesNotMatch(request.system, /文笔：/)
  assert.match(request.system, /for="1"/)
  const content = request.messages[0].content
  assert.match(content, /<trial>\n（试玩之后卡改过/)
  assert.match(content, /1\. 露出了隐藏内容：3 回合/)
  assert.match(content, /3\. 第 2 回合 · 抢话：替玩家决定了去处\n {3}原文：你决定去旧城\n {3}审读员的改法：规则里写明不替玩家做决定/)
  const plain = checkRequest(card, [], { focus: ['rules'] }).request
  assert.doesNotMatch(plain.system, /试玩里读出的问题|for="1"/)
  assert.doesNotMatch(plain.messages[0].content, /<trial>/)

  const read = readCheck('<reply>好。</reply>\n<suggestion title="写明不替玩家决定" level="warn" for="3, 1"><why>抢话</why><patch target="entry:0"><old>规矩。</old><new>规矩。不替玩家做决定。</new></patch></suggestion>', card)
  assert.deepEqual(read.suggestions[0].for, [3, 1])
  assert.equal(read.suggestions[0].changes.length, 1)
})

// ─── Over HTTP, with a model of our own ───────────────────────────────────

const REVIEW = '<review>{"summary":"能玩，有抢话。","issues":[{"round":2,"kind":"抢话","what":"替玩家决定了去处","quote":"你决定去旧城","fix":"规则里写明不替玩家做决定"},{"round":3,"kind":"放水","what":"硬闯轻易成功","quote":"守卫让开了","fix":"写明守卫不放人"}]}</review>'
const FIX = '<reply>抢话可以在规矩里写清。</reply>\n<suggestion title="规矩里写明不替玩家做决定" level="warn" for="1"><why>第 2 回合替玩家决定了去处。</why><patch target="entry:0"><old>茶馆的规矩。</old><new>茶馆的规矩。不替玩家做决定。</new></patch></suggestion>'

/** Answers by who is asking: the stand-in player, the reader, the card checker, or the card in a chat. */
async function fakeModel() {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const system = body.messages.filter(item => item.role === 'system').map(item => item.content).join('\n')
    const kind = /替一位玩家试玩/.test(system) ? 'player' : /角色卡的检查员/.test(system) ? 'check' : /审读员/.test(system) ? 'review' : 'reply'
    seen.push({ kind, body })
    const content = { player: '我往旧城走。', review: REVIEW, check: FIX, reply: '她点点头。<memo>后台备注</memo>' }[kind]
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-trial-check-'))
  const model = await fakeModel()
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    model.close()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (url, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: res.status, body: await res.json() }
  }
  const until = async (url, done) => {
    for (let i = 0; i < 300; i++) {
      const view = (await call(url)).body
      if (done(view)) return view
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`${url} never got there`)
  }
  return { call, until, model, dataRoot }
}

test('a card saved before schemas were kept: what its first turn fills in leaves the new report up to date', async t => {
  const { call, until, model, dataRoot } = await tavern(t)
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `${model.base}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  const imported = (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(rawCard())).toString('base64') } })).body
  const id = imported.card?.id ?? imported.id
  const file = path.join(dataRoot, 'cards', id, 'card.json')
  const old = JSON.parse(await readFile(file, 'utf8'))
  delete old.mvuSchema
  await writeFile(file, JSON.stringify(old))

  await call(`/api/cards/${id}/trial`, { method: 'PUT', body: { rounds: 3 } })
  await call(`/api/cards/${id}/trial/run`, { method: 'POST' })
  const played = await until(`/api/cards/${id}/trial`, view => !view.job && (view.report || view.error))
  assert.equal(played.error, null)
  assert.equal(typeof JSON.parse(await readFile(file, 'utf8')).mvuSchema, 'string', 'the run filled it in')
  assert.equal(played.report.outdated, false)
  const check = (await call(`/api/cards/${id}/check`)).body
  assert.equal(check.trial.outdated, false)
  assert.ok(check.findings.filter(item => item.from === 'trial').every(item => !item.outdated))
})

test('a card with a schema whose fields have no defaults: a trial logs no schema error the turns themselves never had', async t => {
  const { call, until, model, dataRoot } = await tavern(t)
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `${model.base}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  const raw = rawCard()
  const schema = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';\nexport const Schema = z.object({ 主角: z.object({ 生命: z.number() }) });\n$(() => { registerMvuSchema(Schema); });"
  raw.data.extensions = { tavern_helper: { scripts: [{ name: 'Zod', content: schema, enabled: true }] } }
  raw.data.character_book.entries.push({ uid: 1, comment: '[initvar]', content: '{"主角":{"生命":100}}', keys: [], constant: false, enabled: false })
  const imported = (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(raw)).toString('base64') } })).body
  const id = imported.card?.id ?? imported.id

  await call(`/api/cards/${id}/trial`, { method: 'PUT', body: { rounds: 3 } })
  await call(`/api/cards/${id}/trial/run`, { method: 'POST' })
  const played = await until(`/api/cards/${id}/trial`, view => !view.job && (view.report || view.error))
  assert.equal(played.error, null)
  const logged = await readFile(path.join(dataRoot, 'logs', 'errors.jsonl'), 'utf8').catch(() => '')
  assert.ok(!logged.includes('变量规则'), logged)
})

test('over HTTP: a trial\'s problems in the check, fixed by the model when asked, taken in and back', async t => {
  const { call, until, model } = await tavern(t)
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `${model.base}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  const imported = (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(rawCard())).toString('base64') } })).body
  const id = imported.card?.id ?? imported.id

  // Before any trial: nothing from one.
  let check = (await call(`/api/cards/${id}/check`)).body
  assert.equal(check.trial, null)
  assert.equal(check.findings.some(item => item.from === 'trial'), false)

  await call(`/api/cards/${id}/trial`, { method: 'PUT', body: { rounds: 3 } })
  await call(`/api/cards/${id}/trial/run`, { method: 'POST' })
  const played = await until(`/api/cards/${id}/trial`, view => !view.job && (view.report || view.error))
  assert.equal(played.error, null)
  assert.equal(played.report.issues.length, 2)
  assert.equal(played.report.outdated, false)
  const sent = model.seen.length

  // Opening the check sends nothing; the trial's problems are there, each saying where it came from.
  check = (await call(`/api/cards/${id}/check`)).body
  assert.equal(model.seen.length, sent)
  const trial = check.findings.filter(item => item.from === 'trial')
  // The stand-in never writes <choices>, so the program counts them missing too.
  assert.deepEqual(trial.map(item => item.title), ['行动选项：3 回合写了 0 回合', '露出了隐藏内容：3 回合', '替玩家决定了去处', '硬闯轻易成功'])
  const grab = trial[2]
  assert.deepEqual([grab.round, grab.kind, grab.fix], [2, '抢话', '规则里写明不替玩家做决定'])
  assert.ok(trial.every(item => !item.outdated && item.changes.length === 0))
  assert.equal(check.trial.model, played.report.model)
  assert.equal(check.trial.outdated, false)
  assert.equal(check.trial.estimate.ready, true)
  assert.ok(check.trial.estimate.chars > check.estimate.chars, 'the problems go along with the card')
  assert.match(check.trial.estimate.model, /writer/)

  // Nothing to take in from a problem itself.
  assert.equal((await call(`/api/cards/${id}/check/apply`, { method: 'POST', body: { items: [{ id: grab.id }] } })).status, 409)
  // Ignored and brought back as any other.
  check = (await call(`/api/cards/${id}/check`, { method: 'PUT', body: { ignore: trial[0].id } })).body
  assert.deepEqual(check.ignored.map(item => item.id), [trial[0].id])
  assert.ok(check.trial.estimate.chars < (await call(`/api/cards/${id}/check`, { method: 'PUT', body: { restore: trial[0].id } })).body.trial.estimate.chars, 'an ignored problem is not sent')
  assert.equal((await call(`/api/cards/${id}/check/ask`, { method: 'POST', body: { trial: ['trial:gone'] } })).status, 409)
  assert.equal(model.seen.length, sent)

  // Asked about one problem: the model is sent that one, and its change comes under it.
  await call(`/api/cards/${id}/check/ask`, { method: 'POST', body: { trial: [grab.id] } })
  check = await until(`/api/cards/${id}/check`, view => !view.job && (view.trial.askedModel || view.error))
  assert.equal(check.error, null)
  const asked = model.seen.slice(sent)
  assert.deepEqual(asked.map(item => item.kind), ['check'])
  const content = asked[0].body.messages.at(-1).content
  assert.match(content, /<trial>\n1\. 第 2 回合 · 抢话：替玩家决定了去处/)
  assert.doesNotMatch(content, /硬闯轻易成功/)
  assert.equal(check.trial.reply, '抢话可以在规矩里写清。')
  assert.equal(check.reply, '', 'the usual look\'s answer is left alone')
  const fix = check.findings.find(item => item.from === 'model')
  assert.deepEqual([fix.trial, fix.answers, fix.risky], [true, [grab.id], true])

  // Taken in through the usual way: the card changes, the problem it answers goes, the rest are marked out of date.
  const taken = (await call(`/api/cards/${id}/check/apply`, { method: 'POST', body: { items: [{ id: fix.id }] } })).body
  assert.equal(taken.applied, 1)
  assert.equal(taken.check.records.at(-1).title, '规矩里写明不替玩家做决定')
  const rule = async () => (await call(`/api/cards/${id}/book`)).body.entries[0].content
  assert.equal(await rule(), '茶馆的规矩。不替玩家做决定。')
  const left = taken.check.findings.filter(item => item.from === 'trial')
  assert.deepEqual(left.map(item => item.title), ['行动选项：3 回合写了 0 回合', '露出了隐藏内容：3 回合', '硬闯轻易成功'])
  assert.ok(left.every(item => item.outdated))
  assert.equal(taken.check.trial.outdated, true)
  assert.equal((await call(`/api/cards/${id}/trial`)).body.report.outdated, true)

  // Taken back: the card as it was, the problem back, the report up to date again.
  const back = (await call(`/api/cards/${id}/check/undo`, { method: 'POST', body: { record: taken.check.records.at(-1).id } })).body
  assert.equal(await rule(), '茶馆的规矩。')
  assert.deepEqual(back.check.findings.filter(item => item.from === 'trial').map(item => [item.title, item.outdated]), [['行动选项：3 回合写了 0 回合', false], ['露出了隐藏内容：3 回合', false], ['替玩家决定了去处', false], ['硬闯轻易成功', false]])
  assert.ok(back.check.findings.some(item => item.id === fix.id), 'its change is offered again')

  // The usual look leaves the trial's changes be.
  await call(`/api/cards/${id}/check/ask`, { method: 'POST', body: {} })
  check = await until(`/api/cards/${id}/check`, view => !view.job && (view.askedAt || view.error))
  assert.ok(check.findings.some(item => item.id === fix.id))
})
