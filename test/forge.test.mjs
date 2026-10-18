import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { configureEntries } from '../server/forge/configure.mjs'
import { createForge } from '../server/forge/index.mjs'
import { cleanQuestions, discussRequest, mergeBrief, normalizePlan, partialReply, readDiscussion, readPlan } from '../server/forge/prompts.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const FIRST = `<reply>
雨夜、便利店、安静，这个画面已经很有味道了。先定两件事。
</reply>
<questions>
[{"id": "who", "title": "她是什么来头？", "why": "决定世界里有多少不寻常的东西", "kind": "single", "options": [{"label": "普通人", "sample": "「雨停之前，能让我在这儿待一会儿吗？」"}, {"label": "雨女", "detail": "只在雨夜出现", "sample": "「你看得见我？」"}]},
 {"id": "pen", "title": "喜欢哪一段？", "kind": "taste", "options": [{"label": "第一段", "sample": "雨点敲着玻璃，她站在门口。"}, {"label": "第二段", "sample": "她把伞收好，抖了抖水。"}]},
 {"id": "bad", "title": "只有一个选项的问题", "options": [{"label": "唯一"}]}]
</questions>
<brief>
{"title": "雨宿", "readiness": 30, "items": [{"key": "stage", "label": "舞台", "value": "现代都市，深夜便利店，下雨", "by": "user"}, {"key": "tone", "label": "基调", "value": "安静", "by": "user"}], "open": ["她是谁"]}
</brief>`

const SECOND = `<reply>她是只在雨夜出现的雨女，你是夜班店员。差不多可以出方案了。</reply>
<questions>[{"id": "track", "title": "要记录她对你的好感吗？", "options": [{"label": "要"}, {"label": "不要"}]}]</questions>
<brief>{"title": "雨宿", "readiness": 82, "items": [{"key": "tone", "label": "基调", "value": "热闹欢快", "by": "assistant"}, {"key": "lead", "label": "核心角色", "value": "雨女林小雨", "by": "user"}], "open": []}</brief>`

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。',
  user_role: { identity: '晴空便利店的夜班店员', constraints: [] },
  world: { kind: '真实', overview: '现代都市，多雨的港城', rules: ['雨女只在下雨时能被看见'], places: [{ name: '晴空便利店', description: '24 小时便利店' }], factions: [], history: [] },
  characters: [
    { name: '林小雨', kind: 'core', aliases: ['小雨', '雨'], age: '看起来十九岁', gender: '女', identity: '雨女', relationship: '每逢下雨就来店里避雨', appearance: ['发梢总是湿的'], personality: { base: '孤独', main: ['温柔', '倔强'], accent: [] }, looks_tags: 'black hair, wet hair', outfit_tags: 'white raincoat' },
    { name: '王店长', kind: 'npc', role: '偶尔来查岗' },
  ],
  style: { perspective: '第三人称', tone: '克制', mood: '安静' },
  play_rules: ['不替<user>说话'],
  tracking: { enabled: true, variables: [{ path: '林小雨.好感度', type: 'number', initial: '10', range: '0~100', check: '真心相待时 +2~4' }] },
  greetings: [{ title: '第一场雨', scene: '凌晨两点，店里', situation: '她推门进来', length: '500~700' }],
  avatar: { character: '林小雨', description: '湿发的女孩', tags: 'black hair' },
  assumptions: ['港城这个名字是向导取的'],
  verbatim: [],
}

async function fakeProvider() {
  const seen = []
  let slow = null
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(json)
    const system = json.messages[0]?.role === 'system' ? json.messages[0].content : ''
    if (req.url.startsWith('/slow')) {
      slow = res
      return
    }
    let text = FIRST
    if (system.includes('角色卡策划')) text = `<plan>\n${JSON.stringify(PLAN)}\n</plan>`
    else if (json.messages.some(m => m.role === 'assistant')) text = SECOND
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: json.model, choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, seen, close: () => { slow?.destroy(); server.close() } }
}

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-'))
  const fake = await fakeProvider()
  t.after(async () => {
    fake.close()
    await rm(root, { recursive: true, force: true })
  })
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `${fake.base}/v1`, apiKey: 'sk-forge-test', models: ['writer'] })
  const slow = normalizeProvider({ name: '慢', api: 'openai-completions', baseURL: `${fake.base}/slow/v1`, apiKey: 'sk-forge-test', models: ['slow'] }, null, new Set([provider.id]))
  await store.saveProviders([provider, slow])
  await store.saveSettings({ model: `${provider.id}/writer` })
  const recorded = []
  const forge = createForge(store, { ledger: { recordTurn: async (chat, node) => recorded.push({ chat, node }) } })
  return { root, store, forge, fake, provider, slow, recorded }
}

/** The draft once its background call is done. */
async function settled(forge, id) {
  for (let i = 0; i < 200; i++) {
    const draft = await forge.get(id)
    if (!draft.job) return draft
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('the job never finished')
}

test('a round is read back: reply, questions with two or more options, sketch; partial reply as it streams', () => {
  const read = readDiscussion(FIRST, { title: '', readiness: 0, items: [], open: [] })
  assert.match(read.reply, /^雨夜/)
  assert.deepEqual(read.questions.map(q => [q.id, q.kind, q.options.length]), [['who', 'single', 2], ['pen', 'taste', 2]])
  assert.equal(read.questions[0].options[1].detail, '只在雨夜出现')
  assert.equal(read.brief.readiness, 30)
  assert.equal(read.brief.title, '雨宿')
  assert.equal(partialReply('<reply>雨夜、便利'), '雨夜、便利')
  assert.equal(partialReply('<reply>好的</reply><questions>['), '好的')
  // An answer without the tags is still shown; the sketch stays as it was.
  const plain = readDiscussion('随便聊聊', { title: '旧', readiness: 10, items: [], open: [] })
  assert.equal(plain.reply, '随便聊聊')
  assert.equal(plain.readable, false)
  assert.equal(plain.brief.title, '旧')
  // Fenced or slightly malformed JSON still reads.
  assert.equal(cleanQuestions(JSON.parse('[{"title":"x","options":["a","b"]}]'))[0].options[0].label, 'a')
})

test('the sketch keeps what the user locked and what the model left out', () => {
  const before = { title: '雨宿', readiness: 30, items: [{ key: 'tone', label: '基调', value: '安静', by: 'user', locked: true }, { key: 'stage', label: '舞台', value: '便利店', by: 'user', locked: false }], open: [] }
  const after = mergeBrief({ readiness: 80, items: [{ key: 'tone', label: '基调', value: '热闹', by: 'assistant' }, { key: 'lead', label: '核心角色', value: '林小雨', by: 'user' }] }, before)
  assert.deepEqual(after.items.map(i => [i.key, i.value, i.locked]), [['tone', '安静', true], ['lead', '林小雨', false], ['stage', '便利店', false]])
  assert.equal(after.readiness, 80)
  assert.equal(after.title, '雨宿')
})

test('entries are configured by rule: one core character', () => {
  const plan = normalizePlan(PLAN)
  const row = name => {
    const e = plan.entries.find(x => x.name === name)
    return [e.strategy, e.position, e.order]
  }
  assert.deepEqual(row('世界设定'), ['constant', 'before', 10])
  assert.deepEqual(row('扮演准则'), ['constant', 'before', 20])
  assert.deepEqual(row('林小雨_基础信息'), ['constant', 'after', 30])
  assert.deepEqual(row('林小雨_性格调色盘'), ['constant', 'after', 31])
  assert.deepEqual(row('王店长'), ['keyword', 'after', 40])
  assert.equal(row('[InitVar]请勿打开')[0], 'off')
  assert.deepEqual(row('[mvu_update]变量输出格式').slice(0, 2), ['constant', 'depth'])
  // The notes on reading her come last, at the end of the context.
  const notes = plan.entries.find(e => e.name === '林小雨_二次解释')
  assert.equal(notes.position, 'depth')
  assert.equal(notes.order, Math.max(...plan.entries.map(e => e.order)))
  // No single-character keywords: they would match everywhere.
  assert.deepEqual(plan.entries.find(e => e.name === '林小雨_基础信息').keywords, ['林小雨', '小雨'])
  assert.equal(plan.characters[1].kind, 'npc')
  assert.ok(plan.warnings.length === 0, plan.warnings.join())
})

test('entries are configured by rule: bigger casts and many places turn into keyword entries', () => {
  const core = name => [
    { name: `${name}_基础信息`, owner: name, type: '角色', part: 'basic', keywords: [name] },
    { name: `${name}_性格调色盘`, owner: name, type: '角色', part: 'personality', keywords: [name] },
  ]
  const two = configureEntries([...core('甲乙'), ...core('丙丁')])
  assert.deepEqual(two.map(e => e.strategy), ['constant', 'keyword', 'constant', 'keyword'])
  assert.deepEqual(two.map(e => e.order), [10, 11, 20, 21])
  const five = configureEntries(['一一', '二二', '三三', '四四', '五五'].flatMap(core))
  assert.ok(five.every(e => e.strategy === 'keyword'))
  const places = configureEntries(['东街', '西街', '南街', '北街'].map(name => ({ name, type: '地理', part: 'region', keywords: [name] })))
  assert.ok(places.every(e => e.strategy === 'keyword' && e.position === 'before'))
  // A keyword entry without keywords would never be sent: it stays on.
  assert.equal(configureEntries([{ name: '路人', type: 'NPC', part: '', keywords: [] }])[0].strategy, 'constant')
  // The plan adds a catalog once there are five or more characters.
  const crowd = normalizePlan({ ...PLAN, characters: ['一一', '二二', '三三', '四四', '五五'].map(name => ({ name, kind: 'core' })) })
  assert.equal(crowd.entries.find(e => e.part === 'catalog').strategy, 'constant')
})

test('talking a card into a plan: rounds, picks, locks, plan, revision, undo', async t => {
  const { forge, fake, store, root, recorded } = await setup(t)
  await assert.rejects(forge.create({ text: '  ' }), /先说说/)
  const started = await forge.create({ text: '雨夜便利店里的神秘女孩' })
  assert.equal(started.job.kind, 'discuss')
  let draft = await settled(forge, started.id)
  assert.equal(draft.rounds[0].assistant.questions.length, 2)
  assert.equal(draft.brief.items.length, 2)
  assert.equal(draft.title, '雨宿')
  assert.equal(recorded[0].chat.title, '创作：雨宿')
  // The page never gets the raw answer.
  assert.equal(draft.rounds[0].assistant.raw, undefined)

  // Lock the tone, then answer: one pick, one 你来定, an unknown question ignored.
  draft = await forge.update(draft.id, { brief: { items: draft.brief.items.map(i => (i.key === 'tone' ? { ...i, locked: true } : i)) } })
  await assert.rejects(forge.say(draft.id, {}), /先选一个/)
  await forge.say(draft.id, { text: '安静一点', picks: [{ id: 'who', labels: ['雨女', '不存在的选项'] }, { id: 'pen', delegate: true }, { id: 'nope', labels: ['x'] }] })
  draft = await settled(forge, draft.id)
  const asked = fake.seen.at(-1).messages
  assert.deepEqual(asked.map(m => m.role), ['system', 'user', 'assistant', 'user'])
  assert.equal(asked[2].content, FIRST)
  assert.match(asked[3].content, /她是什么来头？ → 雨女\n- 喜欢哪一段？ → 你来定\n我想补充：安静一点/)
  assert.match(asked[3].content, /<sketch>[\s\S]*"locked":true/)
  assert.deepEqual(draft.rounds[1].user.picks.map(p => [p.id, p.labels, p.delegate]), [['who', ['雨女'], false], ['pen', [], true]])
  // The model tried to change the locked tone: it stays.
  assert.equal(draft.brief.items.find(i => i.key === 'tone').value, '安静')
  assert.equal(draft.brief.readiness, 82)

  // The plan: from the talk, entries configured.
  await forge.plan(draft.id)
  draft = await settled(forge, draft.id)
  assert.equal(draft.stage, 'plan')
  assert.equal(draft.plan.name, '雨宿')
  assert.ok(draft.plan.entries.length >= 8)
  assert.match(fake.seen.at(-1).messages.at(-1).content, /【用户】\n我的想法：雨夜便利店里的神秘女孩/)

  // Comments revise it; the current plan goes along, without what the app derives.
  await assert.rejects(forge.revise(draft.id, {}), /先写下/)
  await forge.revise(draft.id, { text: '配角不要了', notes: [{ section: '角色', text: '王店长删掉' }] })
  draft = await settled(forge, draft.id)
  const revision = fake.seen.at(-1).messages.at(-1).content
  assert.match(revision, /关于「角色」：王店长删掉/)
  assert.match(revision, /总体：配角不要了/)
  assert.doesNotMatch(revision, /"entries"/)

  // Back to talking keeps the plan; undo takes back the last exchange.
  draft = await forge.update(draft.id, { stage: 'discuss' })
  assert.ok(draft.plan)
  draft = await forge.undo(draft.id)
  assert.equal(draft.rounds.length, 1)
  await assert.rejects(forge.undo(draft.id), /第一轮/)

  const list = await forge.list()
  assert.deepEqual(list.map(d => [d.id, d.title, d.rounds]), [[draft.id, '雨宿', 1]])
  assert.ok((await store.getSettings()).model)
  assert.ok(root)
})

test('a call can be stopped; one cut off by a restart shows as such; no model, no talk', async t => {
  const { forge, store, slow, root, provider } = await setup(t)
  const draft = await forge.create({ text: '慢一点', model: `${slow.id}/slow` })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(forge.busy(), true)
  assert.deepEqual(forge.stop(draft.id), { stopped: true })
  const stopped = await settled(forge, draft.id)
  assert.equal(stopped.error.message, '已经停下了。')
  assert.equal(forge.busy(), false)

  // A draft whose job was running when the server stopped.
  await mkdir(path.join(root, 'forge'), { recursive: true })
  const cut = { ...(await forge.get(draft.id)), job: { kind: 'plan', startedAt: new Date().toISOString() }, rounds: [{ user: { text: 'x', picks: [] }, assistant: null }], brief: { title: '', readiness: 0, items: [], open: [] } }
  await writeFile(path.join(root, 'forge', 'cutoff.json'), JSON.stringify({ ...cut, id: 'cutoff' }))
  const fresh = createForge(store)
  assert.match((await fresh.get('cutoff')).error.message, /服务就停了/)

  // No provider model chosen anywhere: a clear message instead of a call.
  await store.saveSettings({ model: '' })
  await assert.rejects(fresh.create({ text: '想要一张卡' }), /先选一个模型/)
  assert.ok(provider)
  await assert.rejects(fresh.get('../x'), /无效/)
})

test('the plan request carries the talk; a cut-off plan reads as nothing', () => {
  const rounds = [{ user: { text: '想要雨夜的卡', picks: [] }, assistant: { raw: FIRST, reply: '好', questions: [] } }, { user: { text: '', picks: [{ title: '她是谁', labels: ['雨女'] }] }, assistant: null }]
  const request = discussRequest(rounds, { title: '', readiness: 0, items: [], open: [] })
  assert.equal(request.messages.length, 3)
  assert.match(request.messages[2].content, /她是谁 → 雨女/)
  assert.equal(readPlan('<plan>{"name": "x", "characters": []}'), null)
  assert.equal(readPlan('不是方案'), null)
})
