// 全本检查: a card longer than one ask reads is asked about the entries it left out, in batches (check-model.mjs
// restRequests), each batch's suggestions held to its own entries, vetted, and kept as they come in (check-session.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { initTemplates } from '../server/template.mjs'
import { initialState } from '../server/worldbook.mjs'
import { checkRequest, readCheck, restRequests, vetSuggestions, withinPart } from '../server/forge/check-model.mjs'

await initTemplates()

const entry = (uid, comment, content, more = {}) => ({ uid, comment, content, keys: [], constant: false, enabled: true, ...more })
const INIT = entry(0, '[initvar]初始变量', '好感度: 10\n')
const RULE = entry(1, '变量更新规则', '每轮末尾写 <UpdateVariable>，用 _.set(\'好感度\', 10, 12);//原因', { constant: true })
// Each person's entry starts with a line of its own, for a batch's answer to patch.
const person = i => entry(i + 2, `人物${i}`, `人物${i}住在城${i}。\n${'长'.repeat(3000)}`, { keys: [`人物${i}`] })
const rawCard = (entries, name = '林青禾') => ({ spec: 'chara_card_v3', data: { name, description: '旧城茶馆的掌柜。', first_mes: '「又下雨了。」', extensions: {}, character_book: { entries } } })
const bigEntries = () => [INIT, RULE, ...Array.from({ length: 60 }, (_, i) => person(i))]

/** The uids a request sends in full in its <worldbook>, not those in <rules>. */
const fullUids = content => {
  const book = /<worldbook>([\s\S]*?)<\/worldbook>/.exec(content)[1]
  return [...book.matchAll(/<entry uid="(\d+)"[^>]*>\n/g)].map(match => match[1])
}

test('全本检查: the entries the ask leaves out, in batches, each with the rules, the variables and the list', () => {
  const card = normalizeCard(rawCard(bigEntries()))
  const state = initialState([card.book])
  const { shown } = checkRequest(card, [], { state })
  const { parts, long, left } = restRequests(card, shown, { state })
  assert.ok(parts.length >= 2, `several batches, not ${parts.length}`)
  assert.deepEqual([long, left], [0, 0])
  const sent = parts.flatMap(part => part.uids)
  assert.equal(new Set(sent).size, sent.length, 'each entry in one batch only')
  assert.deepEqual([...shown, ...sent].sort(), card.book.entries.map(item => item.uid).sort(), 'every entry read, by the ask or a batch')
  for (const [i, part] of parts.entries()) {
    const { content } = part.request.messages[0]
    assert.ok(content.length < 62000, `a batch is about as long as the ask, not ${content.length}`)
    assert.deepEqual(fullUids(content), part.uids)
    assert.match(content, /<rules>[\s\S]*好感度: 10[\s\S]*变量更新规则[\s\S]*<\/rules>/, 'read against the rules')
    assert.match(content, /<variables>\n开局时的变量：\n好感度: 10/)
    assert.match(content, /其余 \d+ 条没有附上全文/, 'the rest by name')
    assert.match(part.request.system, new RegExp(`全本检查，第 ${i + 1} 批，共 ${parts.length} 批`))
    assert.doesNotMatch(part.request.system, /美化：/, 'the look is not asked about again')
  }

  const small = normalizeCard(rawCard([INIT, RULE, person(0)]))
  assert.deepEqual(restRequests(small, checkRequest(small, []).shown).parts, [], 'a card read whole has no batches')
  assert.deepEqual(restRequests(card, shown, { focus: ['look'] }).parts, [], 'nor one asked only about the look')

  // A batch's answer changes its own entries and new ones; what else it writes is left out.
  const [first] = parts
  const own = first.uids[0]
  const other = parts[1].uids[0]
  const answer = [
    '<reply>这一批还行。</reply>',
    `<suggestion title="改自己的"><patch target="entry:${own}"><old>住在</old><new>常住</new></patch></suggestion>`,
    `<suggestion title="改别批的"><entry uid="${other}" mode="constant"></entry></suggestion>`,
    '<suggestion title="改规则"><patch target="entry:1"><old>每轮</old><new>每次</new></patch><new_entry name="新人物" keys="新人物">新来的。</new_entry></suggestion>',
    '<suggestion title="改状态栏"><status_bar>{"fields": [{"path": "好感度", "show": "meter", "min": 0, "max": 100}]}</status_bar></suggestion>',
    '<suggestion title="只提醒"><why>可以再短。</why></suggestion>',
  ].join('\n')
  const kept = withinPart(readCheck(answer, card, { shown: first.uids }).suggestions, first.uids)
  assert.deepEqual(kept.map(item => item.title), ['改自己的', '改规则', '只提醒'])
  assert.deepEqual(kept[1].changes, [], 'reaching past the batch, none of it is taken, not even the new entry')

  // A merge or a move into the rules reaches past the batch: cut down, only its delete would be left, so none of it is taken.
  const merge = [
    `<suggestion title="把人物并进规则"><entry uid="1">合并后的规则。</entry><remove_entry uid="${own}"></remove_entry></suggestion>`,
    `<suggestion title="把规则移到变量更新规则里"><why>规则应该集中在常驻规则条目。</why><patch target="entry:${own}"><old>住在</old><new></new></patch><patch target="entry:1"><old>每轮</old><new>人物住处写清楚。每轮</new></patch></suggestion>`,
    `<suggestion title="删重复的"><remove_entry uid="${own}"></remove_entry></suggestion>`,
  ].join('\n')
  const held = withinPart(readCheck(merge, card, { shown: first.uids }).suggestions, first.uids)
  assert.deepEqual(held.map(item => [item.title, item.changes.map(change => change.id)]), [['把人物并进规则', []], ['把规则移到变量更新规则里', []], ['删重复的', [`remove:${own}`]]])
  assert.deepEqual(vetSuggestions(card, held).filter(item => item.changes.length).map(item => item.title), ['删重复的'], 'only the plain delete can be taken')
  // The first ask too: a merge into an entry it only listed by name is not taken as its delete.
  const unseen = parts[0].uids[0]
  const into = `<suggestion title="并进去"><entry uid="${unseen}">合并后的。</entry><remove_entry uid="${shown.find(uid => !['0', '1'].includes(uid))}"></remove_entry></suggestion>`
  assert.deepEqual(readCheck(into, card, { shown }).suggestions.map(item => [item.title, item.changes]), [['并进去', []]])
})

test('全本检查: an entry over 20,000 characters is left out of the batches too, so a cut-off rewrite cannot replace it', () => {
  const filler = Array.from({ length: 12 }, (_, i) => entry(i + 2, `条目${i}`, `条目${i}。\n${'长'.repeat(5000)}`))
  const big = entry(20, '大设定', `大设定开头。\n${'设'.repeat(30000)}`)
  const card = normalizeCard(rawCard([INIT, RULE, ...filler, big]))
  const state = initialState([card.book])
  const { shown } = checkRequest(card, [], { state })
  assert.ok(!shown.includes('20'), 'the ask leaves it out')
  const { parts, long } = restRequests(card, shown, { state })
  assert.ok(parts.length >= 1)
  assert.equal(long, 1, 'counted as too long')
  assert.ok(parts.every(part => !part.uids.includes('20') && !fullUids(part.request.messages[0].content).includes('20')), 'no batch sends it in full')
  // An answer cut off in the middle of a rewrite of it is not taken as a change to it.
  const cut = '<suggestion title="压缩大设定"><entry uid="20">大设定开头。' + '设'.repeat(800)
  const kept = withinPart(readCheck(cut, card, { shown: parts[0].uids }).suggestions, parts[0].uids)
  assert.ok(kept.every(item => item.changes.every(change => change.uid !== '20')))
})

// ─── Over HTTP, with a model that answers each batch about one of its entries ──

async function fakeModel({ holdPart = null, emptyPart = null } = {}) {
  const seen = []
  const held = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const system = body.messages.find(item => item.role === 'system')?.content ?? ''
    const content = body.messages.find(item => item.role === 'user').content
    const part = Number(/全本检查，第 (\d+) 批/.exec(system)?.[1] ?? 0)
    seen.push({ part, uids: fullUids(content) })
    if (part && part === holdPart) {
      // Never answers: the job waits here till it is stopped.
      held.push(res)
      return
    }
    const uid = fullUids(content).find(id => !['0', '1'].includes(id))
    const text = part === emptyPart
      ? ''
      : part
      ? `<reply>第 ${part} 批。</reply><suggestion title="第 ${part} 批：改人物住处" level="tip"><why>说清楚。</why><patch target="entry:${uid}"><old>住在</old><new>常住</new></patch></suggestion>`
      : '<reply>整张卡看过了。</reply>'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => {
      for (const res of held) res.destroy()
      server.closeAllConnections?.()
      server.close()
    },
  }
}

async function tavern(t, options) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-whole-'))
  const model = await fakeModel(options)
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
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `${model.base}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  const addCard = async raw => {
    const imported = (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(raw)).toString('base64') } })).body
    return imported.card?.id ?? imported.id
  }
  const until = async (id, done) => {
    let view
    for (let i = 0; i < 250; i++) {
      view = (await call(`/api/cards/${id}/check`)).body
      if (done(view)) return view
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail(`never got there: ${JSON.stringify(view?.job)}`)
  }
  return { call, model, addCard, until }
}

test('over HTTP: 全本检查 only when asked, every batch sent, its suggestions taken in and back', async t => {
  const { call, model, addCard, until } = await tavern(t)
  const small = await addCard(rawCard([INIT, RULE, person(0)], '小卡'))
  assert.equal((await call(`/api/cards/${small}/check`)).body.estimate.rest, null, 'a small card has no 全本检查')

  const id = await addCard(rawCard(bigEntries()))
  const before = (await call(`/api/cards/${id}/check`)).body
  const { rest } = before.estimate
  assert.ok(rest.parts >= 2)
  assert.equal(rest.entries + before.estimate.shown, 62)
  assert.ok(rest.input > 0 && rest.output > 0)
  assert.equal(model.seen.length, 0, 'opening the window sends nothing')

  // Not ticked: one ask, as before.
  await call(`/api/cards/${id}/check/ask`, { method: 'POST', body: {} })
  let view = await until(id, item => !item.job && item.askedAt)
  assert.deepEqual([model.seen.length, view.whole], [1, null])

  model.seen.length = 0
  await call(`/api/cards/${id}/check/ask`, { method: 'POST', body: { whole: true } })
  view = await until(id, item => !item.job && item.whole?.done === item.whole?.total)
  assert.equal(view.error, null)
  assert.deepEqual(model.seen.map(item => item.part), [0, ...Array.from({ length: rest.parts }, (_, i) => i + 1)])
  const sent = model.seen.slice(1).flatMap(item => item.uids.filter(uid => !['0', '1'].includes(uid)))
  const read = new Set(model.seen[0].uids)
  assert.deepEqual([...read, ...sent].sort(), Array.from({ length: 62 }, (_, i) => String(i)).sort(), 'every entry went to the model once')
  assert.equal(new Set(sent).size, sent.length)
  assert.deepEqual(view.whole, { total: rest.parts, done: rest.parts, entries: rest.entries, long: 0, left: 0 })
  assert.equal(view.reply, '整张卡看过了。', 'the ask\'s word on the card stays')
  const found = view.findings.filter(item => item.from === 'model')
  assert.equal(found.length, rest.parts, 'a suggestion from each batch')

  const pick = found.at(-1)
  const uid = pick.changes[0].uid
  const taken = (await call(`/api/cards/${id}/check/apply`, { method: 'POST', body: { items: [{ id: pick.id }] } })).body
  assert.equal(taken.applied, 1)
  const entryNow = async () => (await call(`/api/cards/${id}/book`)).body.entries.find(item => item.uid === uid).content
  assert.match(await entryNow(), /^人物\d+常住城/)
  const back = (await call(`/api/cards/${id}/check/undo`, { method: 'POST', body: { record: taken.check.records.at(-1).id } })).body
  assert.match(await entryNow(), /^人物\d+住在城/)
  assert.ok(back.check.findings.some(item => item.id === pick.id), 'taken back, it is offered again')
})

test('over HTTP: 全本检查 stopped part way keeps what the batches before found', async t => {
  const { call, model, addCard, until } = await tavern(t, { holdPart: 2 })
  const id = await addCard(rawCard(bigEntries()))
  const parts = (await call(`/api/cards/${id}/check`)).body.estimate.rest.parts
  await call(`/api/cards/${id}/check/ask`, { method: 'POST', body: { whole: true } })
  await until(id, item => item.job?.step === `part:2:${parts}` && model.seen.some(seen => seen.part === 2))
  assert.equal((await call(`/api/cards/${id}/check/stop`, { method: 'POST' })).body.stopped, true)
  const view = await until(id, item => !item.job)
  assert.equal(view.error.message, '已经停下了。')
  assert.deepEqual(view.whole, { ...view.whole, total: parts, done: 1 })
  assert.equal(view.reply, '整张卡看过了。')
  const found = view.findings.filter(item => item.from === 'model')
  assert.deepEqual(found.map(item => item.title), ['第 1 批：改人物住处'])
  const taken = (await call(`/api/cards/${id}/check/apply`, { method: 'POST', body: { items: [{ id: found[0].id }] } })).body
  assert.equal(taken.applied, 1, 'what it found can still be taken in')
})

test('over HTTP: a batch that comes back empty ends it there, with what came before kept and the batch named', async t => {
  const { call, addCard, until } = await tavern(t, { emptyPart: 2 })
  const id = await addCard(rawCard(bigEntries()))
  await call(`/api/cards/${id}/check/ask`, { method: 'POST', body: { whole: true } })
  const view = await until(id, item => !item.job && item.error)
  assert.match(view.error.message, /^全本检查停在第 2 批，前面几批的建议留着。.*没有回出能读的内容/)
  assert.equal(view.whole.done, 1)
  assert.deepEqual(view.findings.filter(item => item.from === 'model').map(item => item.title), ['第 1 批：改人物住处'])
})
