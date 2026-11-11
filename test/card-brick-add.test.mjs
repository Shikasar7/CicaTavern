// 检查这张卡 → 加玩法积木: a brick of 创作角色卡's for a card that is already there. What the model is asked and how its
// answer is read (server/forge/brick-add.mjs), and the suggestion asked for, taken in, found again by the check, and
// taken back over HTTP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { CARD_BRICKS, brickFinding, brickRequest, readBrick } from '../server/forge/brick-add.mjs'
import { bricksOf } from '../server/forge/check.mjs'

const cardWith = (extra = {}) => normalizeCard({ spec: 'chara_card_v2', data: { name: '林小雨', description: '只在雨夜出现的女孩，来便利店避雨。', scenario: '凌晨两点的便利店。', first_mes: '雨又下起来了。', character_book: { entries: [{ id: 0, comment: '世界观', content: '多雨的港城，便利店开在街角。', keys: [], constant: true, enabled: true }, { id: 1, comment: '老周', content: '店长，爱唠叨。', keys: ['老周'], constant: false, enabled: true }] }, ...extra } })
const CHECKS = { selfcheck: ['她的话是不是还那么少？', '雨停了，她是不是该走了？', '便利店里有没有出现不该有的东西？'] }
const EVENTS = { random_events: { rate: 'often', groups: [{ when: '', items: ['醉汉进来买烟，认错了人', '整条街停电了三秒', '有只湿透的猫蹲在门口'] }] } }
const JUDGE = { judge: { measure: '胆量', when: '<user> 想做吓人的事时', ranks: ['胆小', '平常', '胆大', '不要命'], rank_path: '你.胆量', gaps: [{ gap: 0, result: '勉强做成' }, { gap: 1, result: '高的一方占上风' }, { gap: 2, result: '低的一方做不到' }], known: [{ name: '老周', rank: '平常' }, { name: '没有的人', rank: '没有的等级' }], dice: false } }

test('the model is told the card and the one field to fill in, and to make no variable', () => {
  assert.deepEqual(CARD_BRICKS, ['selfcheck', 'events', 'judge'])
  const card = cardWith()
  const checks = brickRequest(card, 'selfcheck', { wish: '别让她话变多' })
  assert.match(checks.system, /只按这张卡填内容/)
  assert.match(checks.system, /JSON 里写一个 selfcheck 字段/)
  assert.doesNotMatch(checks.system, /方案里多写一个/)
  const content = checks.messages[0].content
  assert.match(content, /<card name="林小雨">\n\n只在雨夜出现的女孩/)
  assert.match(content, /<entry name="世界观">\n多雨的港城/)
  assert.doesNotMatch(content, /爱唠叨/, 'only what is always there')
  assert.match(content, /（这张卡没有变量）/)
  assert.match(content, /用户对这块玩法的想法：别让她话变多$/)
  assert.match(brickRequest(card, 'events').messages[0].content, /用户没有说具体要什么，按这张卡定。$/)
  const judge = brickRequest(card, 'judge', { state: { 你: { 胆量: '平常' } } })
  assert.match(judge.system, /JSON 里写一个 judge 字段/)
  assert.match(judge.system, /不新加变量：rank_path 只能写 <variables> 里已有的/)
  assert.match(judge.system, /多写一个 "user_rank"/)
  assert.doesNotMatch(judge.system, /tracking\.enabled 为 true/)
  assert.match(judge.messages[0].content, /<variables>\n你\.胆量: "平常"\n<\/variables>/)
  assert.match(brickRequest(normalizeCard({ spec: 'chara_card_v2', data: { name: 'Mira', description: 'A lighthouse keeper.', first_mes: 'The lamp is out.' } }), 'selfcheck').system, /用英文写/)
})

test('an answer is read as the brick\'s content, or as nothing', () => {
  assert.deepEqual(readBrick(JSON.stringify(CHECKS), 'selfcheck'), CHECKS)
  assert.deepEqual(readBrick('```json\n' + JSON.stringify(CHECKS) + '\n```', 'selfcheck'), CHECKS)
  assert.deepEqual(readBrick(JSON.stringify(CHECKS.selfcheck), 'selfcheck'), CHECKS, 'a bare list')
  assert.equal(readBrick(JSON.stringify({ selfcheck: Array.from({ length: 9 }, (_, i) => `第 ${i} 条？`) }), 'selfcheck').selfcheck.length, 6)
  assert.equal(readBrick('{"selfcheck": []}', 'selfcheck'), null)
  assert.equal(readBrick('我做不了。', 'selfcheck'), null)
  assert.deepEqual(readBrick(JSON.stringify(EVENTS), 'events').random_events.groups[0].items, EVENTS.random_events.groups[0].items)
  assert.equal(readBrick(JSON.stringify({ random_events: { groups: [{ items: ['只有一件'] }] } }), 'events'), null, 'a group of one is no draw')
  // The rank is kept in a variable only when the card has it; someone of no rank on the ladder is left out.
  const judged = readBrick(JSON.stringify(JUDGE), 'judge', { state: { 你: { 胆量: '平常' } } }).judge
  assert.equal(judged.rank_path, '你.胆量')
  assert.deepEqual(judged.known, [{ name: '老周', rank: '平常' }])
  assert.equal(readBrick(JSON.stringify(JUDGE), 'judge', { state: {} }).judge.rank_path, '')
  // With no variable for it, where <user> starts is said in the rule itself; with one, the variable tells.
  const started = { judge: { ...JUDGE.judge, user_rank: '胆小', when: '<user> 想做吓人的事时。' } }
  assert.deepEqual(readBrick(JSON.stringify(started), 'judge', { state: {} }).judge.known, [{ name: '<user>', rank: '胆小' }, { name: '老周', rank: '平常' }])
  assert.deepEqual(readBrick(JSON.stringify(started), 'judge', { state: { 你: { 胆量: '平常' } } }).judge.known, [{ name: '老周', rank: '平常' }])
  assert.deepEqual(readBrick(JSON.stringify({ judge: { ...JUDGE.judge, user_rank: '没有的等级' } }), 'judge').judge.known, [{ name: '老周', rank: '平常' }])
  const rule = brickFinding(cardWith(), 'judge', readBrick(JSON.stringify(started), 'judge')).changes[0].after
  assert.match(rule, /这一轮里，是不是<user> 想做吓人的事？是，就必须先写下面的 <judge> 块再写正文/, 'asked as a question: no full stop or 时 of the plan\'s left in it')
  assert.match(rule, /已知的等级：<user> 胆小（1）；老周 平常（2）/)
  assert.equal(readBrick(JSON.stringify({ judge: { ranks: ['只有一级'], gaps: [{ gap: 0, result: 'x' }] } }), 'judge'), null)
})

test('the content becomes a rule sent every turn and the regex it runs on; taken in, the check knows the brick', () => {
  const card = cardWith()
  const checks = brickFinding(card, 'selfcheck', CHECKS)
  assert.deepEqual([checks.id, checks.from, checks.brick, checks.level], ['brick-add:selfcheck', 'model', 'selfcheck', 'tip'])
  assert.match(checks.why, /规则每轮都发，约 \d+ 字；模型每轮大约多写 \d+ 字。$/)
  const [rule, ...scripts] = checks.changes
  assert.deepEqual([rule.kind, rule.name, rule.constant, rule.late], ['newEntry', '[每轮]写前自查', true, true])
  assert.match(rule.after, /^<self_check_rules>[\s\S]*1\. 她的话是不是还那么少？[\s\S]*<\/self_check_rules>$/)
  assert.deepEqual(scripts.map(change => change.kind), ['newRegex', 'newRegex'])
  const events = brickFinding(card, 'events', EVENTS)
  assert.match(events.changes[0].after, /本轮抽到：\[RANDOM_EVENT_1\]/)
  assert.match(events.changes[1].replace, /^\{\{random::醉汉进来买烟，认错了人::整条街停电了三秒::有只湿透的猫蹲在门口::无::无/)
  assert.equal(events.changes[1].world, true)
  const judge = brickFinding(card, 'judge', readBrick(JSON.stringify(JUDGE), 'judge'))
  assert.match(judge.changes[0].after, /这张卡靠「胆量」定成败/)
  assert.doesNotMatch(judge.changes[0].after, /本轮骰子/, 'no luck asked for: no die')
  assert.equal(judge.changes.length, 4, 'the rule, and three scripts for the judgment')
  // An English card gets an English rule.
  const english = normalizeCard({ spec: 'chara_card_v2', data: { name: 'Mira', description: 'A lighthouse keeper.', first_mes: 'The lamp is out.' } })
  assert.equal(brickFinding(english, 'selfcheck', { selfcheck: ['Does she still speak in short lines?'] }).changes[0].name, '[Each turn] Self-check')
  assert.equal(brickFinding(card, 'events', { random_events: { rate: 'normal', groups: [] } }), null)
})

async function tavern(t, card, answers) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-brick-add-'))
  const seen = []
  const model = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(json)
    const system = json.messages[0].content
    const text = system.includes('加一块玩法') ? answers[/JSON 里写一个 (\w+) 字段/.exec(system)[1]] ?? '我做不了。' : '<reply>没有要改的。</reply>'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }))
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    model.close()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await app.store.saveCard(card)
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  const url = `/api/cards/${card.id}/check`
  const settled = async first => {
    let view = first
    for (let i = 0; i < 300 && view.job; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      view = (await call(url)).body
    }
    return view
  }
  const ask = async (pathname, body) => settled((await call(`${url}${pathname}`, { method: 'POST', body })).body)
  return { call, ask, url, seen, card: () => app.store.getCard(card.id) }
}

test('a brick is asked for, listed, taken in with its rule and regex, known to the check, and taken back', async t => {
  const card = cardWith()
  const { call, ask, url, seen, card: saved } = await tavern(t, card, { selfcheck: JSON.stringify(CHECKS), random_events: JSON.stringify(EVENTS) })
  const before = (await call(url)).body
  assert.deepEqual(before.brickAdd.open, ['selfcheck', 'events', 'judge'])
  assert.equal(before.brickAdd.estimate.ready, true)
  assert.ok(before.brickAdd.estimate.input > 200)
  assert.equal(seen.length, 0, 'opening the window sends nothing')

  const asked = await ask('/brick', { brick: 'selfcheck', wish: '别让她话变多' })
  assert.equal(asked.error, null)
  const found = asked.findings.find(item => item.id === 'brick-add:selfcheck')
  assert.deepEqual([found.brick, found.from, found.broken], ['selfcheck', 'model', undefined])
  assert.match(seen[0].messages.at(-1).content, /别让她话变多/)
  assert.deepEqual((await saved()).book.entries.map(entry => entry.comment), ['世界观', '老周'], 'nothing in the card yet')
  // Another brick asked for, and the usual look: the first suggestion is still there.
  const more = await ask('/brick', { brick: 'events' })
  assert.deepEqual(more.findings.filter(item => item.brick).map(item => item.brick).sort(), ['events', 'selfcheck'])
  const looked = await ask('/ask', {})
  assert.equal(looked.findings.filter(item => item.brick).length, 2, '让模型再看看 leaves them')

  // Taken in: the rule goes late in every turn, the scripts hide the block, and the check lists the brick.
  const applied = (await call(`${url}/apply`, { method: 'POST', body: { items: [{ id: 'brick-add:selfcheck' }] } })).body
  assert.equal(applied.taken, 1)
  const now = await saved()
  const rule = now.book.entries.find(entry => entry.comment === '[每轮]写前自查')
  assert.deepEqual([rule.constant, rule.position, rule.enabled], [true, 4, true])
  assert.equal(now.regexScripts.length, 2)
  assert.ok(bricksOf(now).selfcheck)
  assert.deepEqual(applied.check.facts.bricks, ['selfcheck'])
  assert.deepEqual(applied.check.brickAdd.open, ['events', 'judge'])
  assert.ok(!applied.check.findings.some(item => item.level !== 'tip' && /自查/.test(item.title)), 'the check finds nothing wrong with what was added')
  // Asked for again while the card has it: refused before anything is sent.
  const sent = seen.length
  assert.equal((await call(`${url}/brick`, { method: 'POST', body: { brick: 'selfcheck' } })).status, 409)
  assert.equal((await call(`${url}/brick`, { method: 'POST', body: { brick: 'world' } })).status, 400)
  assert.equal(seen.length, sent)

  // Taken back: the card is as it was, and the brick can be asked for again.
  const undone = (await call(`${url}/undo`, { method: 'POST', body: { record: applied.check.records.at(-1).id } })).body
  assert.deepEqual((await saved()).book.entries.map(entry => entry.comment), ['世界观', '老周'])
  assert.equal((await saved()).regexScripts.length, 0)
  assert.deepEqual(undone.check.brickAdd.open, ['selfcheck', 'events', 'judge'])
})

test('an answer with nothing to use is said so, and leaves the list as it was', async t => {
  const { ask } = await tavern(t, cardWith(), {})
  const failed = await ask('/brick', { brick: 'judge' })
  assert.equal(failed.error.kind, 'check-brick')
  assert.match(failed.error.message, /没有写出能用的内容/)
  assert.equal(failed.findings.filter(item => item.brick).length, 0)
})
