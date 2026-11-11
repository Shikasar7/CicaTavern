// 角色采访 (检查这张卡): a model writes the card's character into a few moments as example exchanges. What it is
// asked and how its answer is read (server/forge/interview.mjs), and the suggestion asked for, listed, taken in and
// taken back over HTTP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { DEFAULT_SCENES, cleanScenes, interviewFinding, interviewRequest, readInterview, withExamples } from '../server/forge/interview.mjs'

const cardWith = (extra = {}) => normalizeCard({ spec: 'chara_card_v2', data: { name: '林小雨', description: '只在雨夜出现的女孩，来便利店避雨。话很少。', personality: '安静，记仇。', scenario: '凌晨两点的便利店。', first_mes: '「雨又下起来了。」她把伞靠在门边。', character_book: { entries: [{ id: 0, comment: '世界观', content: '多雨的港城，便利店开在街角。', keys: [], constant: true, enabled: true }] }, ...extra } })

const ANSWER = `好的，下面是示例。
<examples>
<example scene="daily">
{{user}}: 今天也下雨。
林小雨：「嗯。」她看了一眼窗外，没有多说。
</example>
<example scene="tease">
<user>: 你是不是只有下雨才出门？
{{char}}:「……你管得真宽。」她把热可可往自己这边挪了挪。
</example>
<example scene="refuse">
旁白没有人说话，这段不算。
</example>
<example scene="daily">
{{user}}: 今天也下雨。
林小雨：「嗯。」她看了一眼窗外，没有多说。
</example>
</examples>`

test('the model is told the card, the moments and what the card already has', () => {
  assert.deepEqual(cleanScenes(['quiet', 'nonsense', 'daily']), ['daily', 'quiet'], 'known ones, in the offered order')
  assert.deepEqual(cleanScenes([]), DEFAULT_SCENES)
  assert.deepEqual(cleanScenes('daily'), DEFAULT_SCENES)
  const plain = interviewRequest(cardWith())
  assert.match(plain.system, /写「对话示例」/)
  assert.match(plain.system, /用中文写/)
  assert.match(plain.system, /照开场白/)
  const content = plain.messages[0].content
  assert.match(content, /<card name="林小雨">[\s\S]*只在雨夜出现的女孩[\s\S]*性格：安静，记仇。[\s\S]*开场白：「雨又下起来了。」/)
  assert.match(content, /<entry name="世界观">/)
  assert.doesNotMatch(content, /<variables>|没有变量/, 'variables are nothing to how someone talks')
  assert.match(content, /要写的场合：\n- daily：平常搭话[\s\S]*- soft：/)
  assert.doesNotMatch(content, /- quiet：|kept_examples|用户对示例的想法/)

  const asked = interviewRequest(cardWith({ mes_example: '<START>\n{{char}}: 「伞借你。」' }), { scenes: ['quiet'], wish: '她生气时不骂人' }).messages[0].content
  assert.match(asked, /<kept_examples>\n<START>\n\{\{char\}\}: 「伞借你。」\n<\/kept_examples>\n这张卡已经有上面这些示例：新写的不要和它们重复/)
  assert.match(asked, /要写的场合：\n- quiet：话很少的时候/)
  assert.match(asked, /用户对示例的想法：她生气时不骂人/)
  assert.match(interviewRequest(normalizeCard({ spec: 'chara_card_v2', data: { name: 'Rain', description: 'A girl who only comes when it rains.', first_mes: 'It is raining again.' } })).system, /用英文写/)
})

test('an answer is read as examples: who speaks written as SillyTavern reads it, nothing twice, nothing with no one speaking', () => {
  const card = cardWith()
  const examples = readInterview(ANSWER, card)
  assert.deepEqual(examples.map(example => example.scene), ['daily', 'tease'])
  assert.equal(examples[0].text, '{{user}}: 今天也下雨。\n{{char}}: 「嗯。」她看了一眼窗外，没有多说。')
  assert.equal(examples[1].text, '{{user}}: 你是不是只有下雨才出门？\n{{char}}: 「……你管得真宽。」她把热可可往自己这边挪了挪。')
  assert.deepEqual(readInterview('我写不了这个。', card), [])
  // One never closed (the answer was cut) is read as far as it goes.
  assert.equal(readInterview('<examples><example scene="soft">\n{{user}}: 冷吗？\n{{char}}: 「不冷。」', card)[0].text, '{{user}}: 冷吗？\n{{char}}: 「不冷。」')
  // A cast card: whoever speaks is named, and stays named.
  assert.equal(readInterview('<example scene="daily">\n{{user}}: 老周在吗？\n老周: 在。\n</example>', card)[0].text, '{{user}}: 老周在吗？\n老周: 在。')

  assert.equal(withExamples('', examples), `<START>\n${examples[0].text}\n<START>\n${examples[1].text}`)
  assert.equal(withExamples('<START>\n{{char}}: 「伞借你。」\n', examples.slice(0, 1)), `<START>\n{{char}}: 「伞借你。」\n<START>\n${examples[0].text}`)
})

test('the examples become one suggestion: 对话示例 as it would read with them', () => {
  const card = cardWith()
  const examples = readInterview(ANSWER, card)
  const found = interviewFinding(card, examples)
  assert.deepEqual([found.id, found.from, found.interview, found.level], ['interview', 'model', true, 'tip'])
  assert.equal(found.title, '写 2 段对话示例')
  assert.deepEqual(found.changes, [{ id: 'field:mesExample', kind: 'field', key: 'mesExample', before: '', after: withExamples('', examples) }])
  assert.equal(interviewFinding(cardWith({ mes_example: '<START>\n{{char}}: 「伞借你。」' }), examples).title, '对话示例再加 2 段')
  assert.equal(interviewFinding(card, []), null)
})

async function tavern(t, card, answer) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-interview-'))
  const seen = []
  const model = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(json)
    const text = json.messages[0].content.includes('写「对话示例」') ? answer : '<reply>没有要改的。</reply>'
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

test('examples are asked for, listed, kept through another look, taken in and taken back', async t => {
  const card = cardWith()
  const { call, ask, url, seen, card: saved } = await tavern(t, card, ANSWER)
  const before = (await call(url)).body
  assert.equal(before.interview.has, false)
  assert.equal(before.interview.estimate.ready, true)
  assert.ok(before.interview.estimate.input > 200)
  assert.equal(seen.length, 0, 'opening the window sends nothing')

  const asked = await ask('/interview', { scenes: ['daily', 'tease'], wish: '话要少' })
  assert.equal(asked.error, null)
  assert.match(seen[0].messages.at(-1).content, /要写的场合：\n- daily：[^\n]*\n- tease：[^\n]*\n\n用户对示例的想法：话要少/)
  const found = asked.findings.find(item => item.id === 'interview')
  assert.deepEqual([found.interview, found.from, found.broken], [true, 'model', undefined])
  assert.equal((await saved()).mesExample, '', 'nothing in the card yet')
  const looked = await ask('/ask', {})
  assert.ok(looked.findings.some(item => item.id === 'interview'), '让模型再看看 leaves it')

  const applied = (await call(`${url}/apply`, { method: 'POST', body: { items: [{ id: 'interview' }] } })).body
  assert.equal(applied.taken, 1)
  assert.match((await saved()).mesExample, /^<START>\n\{\{user\}\}: 今天也下雨。\n\{\{char\}\}: 「嗯。」[\s\S]*<START>\n\{\{user\}\}: 你是不是只有下雨才出门？/)
  assert.equal(applied.check.interview.has, true)
  // Exported, they are the card's mes_example.
  assert.match((await call(`/api/cards/${card.id}/sillytavern`)).body.data.mes_example, /^<START>\n\{\{user\}\}: 今天也下雨。/)

  const undone = (await call(`${url}/undo`, { method: 'POST', body: { record: applied.check.records.at(-1).id } })).body
  assert.equal((await saved()).mesExample, '')
  assert.equal(undone.check.interview.has, false)
})

test('an answer with no example in it is said so, and leaves the list as it was', async t => {
  const { ask } = await tavern(t, cardWith(), '我做不了。')
  const asked = await ask('/interview', {})
  assert.equal(asked.error.kind, 'check-interview')
  assert.match(asked.error.message, /没有写出能用的内容/)
  assert.ok(!asked.findings.some(item => item.id === 'interview'))
})
