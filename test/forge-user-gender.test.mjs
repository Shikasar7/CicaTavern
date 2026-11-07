// The player's gender in 创作角色卡 (卡的设定 → 你的性别): picked before or while talking, kept with the
// plan (and changed there), told to the writers so <user> gets the right pronoun and ways of address.
// Left at 不限, nothing about it is sent and drafts and plans stay as they were.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createForge } from '../server/forge/index.mjs'
import { chosenUserGender, cleanCardOptions, discussRequest, editUserGender, emptyBrief, ideaSeeds, ideasRequest, normalizePlan, planRequest, reviseRequest, withCardOptions } from '../server/forge/prompts.mjs'
import { cardJson, entriesRequest, greetingsRequest, newCard, redescribe, rewriteRequest } from '../server/forge/write.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。',
  user_role: { identity: '夜班店员', constraints: [] },
  world: { kind: '真实', overview: '多雨的港城', places: [{ name: '晴空便利店', description: '24 小时便利店' }] },
  characters: [{ name: '林小雨', kind: 'core', aliases: ['小雨'], gender: '女', identity: '雨女', relationship: '下雨就来避雨', personality: { base: '孤独', main: ['温柔'] } }],
  style: { perspective: '第三人称' },
  greetings: [{ title: '第一场雨', start: '初遇', scene: '凌晨两点', situation: '她推门进来' }],
  avatar: { character: '林小雨' },
}

const TALK = '<reply>好。</reply><questions>[]</questions><brief>{"title": "雨宿", "readiness": 80, "items": [{"key": "user", "label": "你的身份", "value": "夜班店员", "by": "user"}]}</brief>'
const rounds = [{ user: { text: '雨夜便利店', picks: [] }, assistant: { raw: TALK, reply: '好。' } }]
const planOf = options => withCardOptions(normalizePlan(structuredClone(PLAN)), options)

test('你的性别: kept only when picked; left at 不限, the options, the prompts and the plan are what they were', () => {
  assert.equal('userGender' in cleanCardOptions({}), false)
  assert.equal('userGender' in cleanCardOptions({ userGender: '' }), false)
  assert.equal('userGender' in cleanCardOptions({ userGender: 'nonbinary' }), false)
  assert.equal('userGender' in cleanCardOptions(null, 'single'), false, 'a draft from before the picks')
  assert.equal(cleanCardOptions({ userGender: 'female' }).userGender, 'female')
  // The core characters' gender is another pick: one does not set the other.
  assert.deepEqual([cleanCardOptions({ gender: 'male', userGender: 'female' }).gender, cleanCardOptions({ gender: 'male' }).userGender], ['male', undefined])

  const base = { cast: 'single', gender: 'female' }
  for (const unset of [{}, { userGender: '' }, { userGender: 'nonsense' }]) {
    const options = { ...base, ...unset }
    assert.equal(discussRequest(rounds, emptyBrief(), undefined, { options }).system, discussRequest(rounds, emptyBrief(), undefined, { options: base }).system)
    assert.deepEqual(planRequest(rounds, emptyBrief(), undefined, { options }), planRequest(rounds, emptyBrief(), undefined, { options: base }))
    assert.deepEqual(planOf(options), planOf(base))
  }
  assert.doesNotMatch(discussRequest(rounds, emptyBrief()).system, /<user> 是(女|男)性/)
  assert.doesNotMatch(planRequest(rounds, emptyBrief()).system, /<user> 是(女|男)性/)
  // The plan has no gender field at all, as plans had before.
  assert.equal('gender' in planOf(base).user_role, false)
  // Ideas never say who the player is.
  const seeds = ideaSeeds(2, () => 0)
  assert.equal(ideasRequest(seeds, {}, { options: { userGender: 'male' } }).system, ideasRequest(seeds, {}, { options: {} }).system)
})

test('picked, the guide and the planner are told, and the plan keeps it', () => {
  const talk = discussRequest(rounds, emptyBrief(), undefined, { options: { userGender: 'female' } }).system
  assert.match(talk, /用户开始前选好了这些.*<user> 是女性：样例和试写里指代 <user> 用「她」/)
  const plan = planRequest(rounds, emptyBrief(), undefined, { options: { userGender: 'male' } }).system
  assert.match(plan, /- <user> 是男性：指代 <user> 用「他」/)
  const female = planOf({ userGender: 'female' })
  assert.equal(female.user_role.gender, 'female')
  assert.equal(female.user_role.identity, '夜班店员')
  // A revision is told too (the plan it sends has it), and the plan read back gets it from the picks again.
  assert.match(reviseRequest(rounds, female, { text: '改改' }, { options: { userGender: 'female' } }).system, /<user> 是女性/)
  assert.equal(withCardOptions(normalizePlan(structuredClone(PLAN)), { userGender: 'female' }).user_role.gender, 'female')
  // Set by hand, and taken back out.
  assert.equal(editUserGender(female, 'male').user_role.gender, 'male')
  assert.equal('gender' in editUserGender(female, '').user_role, false)
  assert.equal('gender' in editUserGender(female, 'other').user_role, false)
})

test('the writers get the pronoun when the plan has one; without it, every request is as before', () => {
  const plain = planOf({})
  const female = planOf({ userGender: 'female' })
  const male = planOf({ userGender: 'male' })
  const targets = plain.entries.filter(e => e.type !== '状态').slice(0, 2)
  const greeting = [{ ...plain.greetings[0], index: 0 }]
  const card = { ...newCard(plain), greetings: [{ title: '第一场雨', text: '雨夜。' }] }
  const pieces = [{ greeting: true, index: 0, text: '雨夜。', note: '再紧一点' }]
  const requests = plan => [entriesRequest(plan, targets, []), greetingsRequest(plan, greeting, [], ''), rewriteRequest(plan, card, pieces)]

  for (const [i, request] of requests(plain).entries()) {
    assert.doesNotMatch(request.system, /方案里 <user> 是/)
    // The same plan as one from before the field: the same request, word for word.
    const old = structuredClone(plain)
    delete old.user_role.gender
    assert.deepEqual(request, requests(old)[i])
  }
  for (const request of requests(female)) {
    assert.match(request.system, /方案里 <user> 是女性：指代 <user> 用「她」（别的语言用对应的代词），称呼和关系的叫法也按女性来。/)
    assert.match(request.messages.at(-1).content, /"gender":"female"/)
  }
  for (const request of requests(male)) assert.match(request.system, /方案里 <user> 是男性：指代 <user> 用「他」/)
})

test('the card says the player\'s gender beside who they are, in the card\'s language', () => {
  const description = plan => newCard(plan).description
  assert.match(description(planOf({})), /^<user>：夜班店员$/m)
  assert.match(description(planOf({ userGender: 'female' })), /^<user>：女性；夜班店员$/m)
  const english = withCardOptions(normalizePlan({ ...structuredClone(PLAN), user_role: { identity: 'night clerk' } }, { language: 'English' }), { userGender: 'male' })
  assert.match(description(english), /^<user>: male; night clerk$/m)
  // No identity: the gender alone.
  const bare = withCardOptions(normalizePlan({ ...structuredClone(PLAN), user_role: {} }), { userGender: 'female' })
  assert.match(description(bare), /^<user>：女性$/m)
  assert.doesNotMatch(description(normalizePlan({ ...structuredClone(PLAN), user_role: {} })), /^<user>/m)
  assert.match(cardJson(planOf({ userGender: 'female' }), newCard(planOf({ userGender: 'female' }))).data.description, /<user>：女性；夜班店员/)
})

test('changed after the card is written, the description follows; a line rewritten by hand stays', () => {
  const female = planOf({ userGender: 'female' })
  const male = planOf({ userGender: 'male' })
  const card = newCard(female)
  assert.equal(redescribe(card, female, female), card)
  assert.equal(redescribe(card, female, male).description, newCard(male).description)
  assert.equal(redescribe(card, female, planOf({})).description, newCard(planOf({})).description)
  // Edited by hand elsewhere: only the <user> line changes.
  const edited = { ...card, description: `雨夜的故事。\n${card.description}` }
  assert.equal(redescribe(edited, female, male).description, `雨夜的故事。\n${newCard(male).description}`)
  // The <user> line itself rewritten by hand: kept as it is.
  const own = { ...card, description: '林小雨：雨女\n<user>：一个爱下雨的姑娘' }
  assert.equal(redescribe(own, female, male), own)
  // No identity: the line goes with the gender.
  const bare = plan => withCardOptions(normalizePlan({ ...structuredClone(PLAN), user_role: {} }), plan)
  const lone = { ...newCard(bare({ userGender: 'female' })), description: `开头\n${newCard(bare({ userGender: 'female' })).description}` }
  assert.equal(redescribe(lone, bare({ userGender: 'female' }), bare({})).description, `开头\n${newCard(bare({})).description}`)
  // Written from an earlier plan (revised since, or another of three versions) that had another identity: the
  // line is found by the gender, and keeps the identity the card has.
  const clerk = (identity, options) => withCardOptions(normalizePlan({ ...structuredClone(PLAN), user_role: { identity } }), options)
  assert.match(redescribe(edited, clerk('便利店店长', { userGender: 'female' }), clerk('便利店店长', { userGender: 'male' })).description, /^雨夜的故事。\n.*\n<user>：男性；夜班店员$/)
  assert.match(redescribe(card, clerk('便利店店长', { userGender: 'female' }), clerk('便利店店长', {})).description, /^<user>：夜班店员$/m)
  const plain = { ...newCard(planOf({})), description: `雨夜的故事。\n${newCard(planOf({})).description}` }
  assert.match(redescribe(plain, clerk('便利店店长', {}), clerk('便利店店长', { userGender: 'male' })).description, /^雨夜的故事。\n.*\n<user>：男性；夜班店员$/)
  assert.doesNotMatch(redescribe(card, clerk('便利店店长', { userGender: 'female' }), clerk('便利店店长', { userGender: 'male' })).description, /女性/)
  const english = (identity, options) => withCardOptions(normalizePlan({ ...structuredClone(PLAN), user_role: { identity } }, { language: 'English' }), options)
  const written = newCard(english('night clerk', { userGender: 'female' }))
  assert.match(redescribe(written, english('store manager', { userGender: 'female' }), english('store manager', { userGender: 'male' })).description, /^<user>: male; night clerk$/m)
  // Rewritten by hand with the gender still up front: the gender is the one thing that changes.
  const kept = { ...card, description: '林小雨：雨女\n<user>：女性；一个夜里看店的人' }
  assert.equal(redescribe(kept, clerk('便利店店长', { userGender: 'female' }), clerk('便利店店长', { userGender: 'male' })).description, '林小雨：雨女\n<user>：男性；一个夜里看店的人')
})

test('not picked, the guide asks with the name, and what the sketch says is read in either language', () => {
  const asked = discussRequest(rounds, emptyBrief(), undefined, { options: {} }).system
  assert.match(asked, /<user> 在故事里是男是女，选项给「女」「男」「不限」/)
  assert.match(asked, /key 为 user_gender/)
  assert.doesNotMatch(discussRequest(rounds, emptyBrief(), undefined, { options: { userGender: 'male' } }).system, /在故事里是男是女/, 'picked: not asked again')
  const said = value => chosenUserGender({ items: [{ key: 'user_gender', value }] })
  assert.deepEqual(['女', '女性', '女生', 'Female', 'a woman'].map(said), ['female', 'female', 'female', 'female', 'female'])
  assert.deepEqual(['男', '男性', 'male', 'Man', 'boy'].map(said), ['male', 'male', 'male', 'male', 'male'])
  assert.deepEqual(['不限', '不写明', 'any', '男女都行', ''].map(said), ['', '', '', '', ''])
  assert.equal(chosenUserGender(emptyBrief()), null)
  assert.equal(chosenUserGender(undefined), null)
})

test('in the card creator: picked in the sketch or set on the plan, one value for both; old drafts open as they were', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-user-gender-'))
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(json)
    const system = json.messages[0]?.content ?? ''
    const text = system.includes('角色卡策划') ? `<plan>\n${JSON.stringify(PLAN)}\n</plan>` : TALK
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: json.model, choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/writer` })
  const forge = createForge(store)
  const settled = async id => {
    for (let i = 0; i < 300; i++) {
      const draft = await forge.get(id)
      if (!draft.job) return draft
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('the job never finished')
  }
  const systemOf = request => request.messages[0].content

  // Not picked: nothing about it anywhere.
  let draft = await settled((await forge.create({ text: '雨夜便利店', options: { cast: 'single' } })).id)
  assert.equal('userGender' in draft.options, false)
  await assert.rejects(forge.update(draft.id, { userGender: 'female' }), /还没有方案/)
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  assert.equal('gender' in draft.plan.user_role, false)
  assert.doesNotMatch(systemOf(seen.at(-1)), /<user> 是(女|男)性/)

  // Set on the plan: the picks take it too, and a revision keeps it.
  draft = await forge.update(draft.id, { userGender: 'female' })
  assert.deepEqual([draft.plan.user_role.gender, draft.options.userGender, draft.options.cast], ['female', 'female', 'single'])
  await forge.revise(draft.id, { text: '开场再紧一点' })
  draft = await settled(draft.id)
  assert.match(systemOf(seen.at(-1)), /- <user> 是女性：指代 <user> 用「她」/)
  assert.equal(draft.plan.user_role.gender, 'female')

  // Changed in the sketch's picks: the plan follows. 不限 takes the field away again.
  draft = await forge.update(draft.id, { options: { ...draft.options, userGender: 'male' } })
  assert.equal(draft.plan.user_role.gender, 'male')
  draft = await forge.update(draft.id, { options: { ...draft.options, userGender: '' } })
  assert.equal('gender' in draft.plan.user_role, false)
  assert.equal('userGender' in draft.options, false)
  draft = await forge.update(draft.id, { userGender: 'nonsense' })
  assert.equal('gender' in draft.plan.user_role, false)

  // Another of three versions picked: it takes the gender as picked, not the one it was written with.
  draft = await forge.update(draft.id, { userGender: 'male' })
  await forge.plan(draft.id, { variants: true })
  draft = await settled(draft.id)
  assert.ok(draft.planOptions.length > 1)
  draft = await forge.update(draft.id, { userGender: 'female' })
  draft = await forge.update(draft.id, { planPick: 1 })
  assert.equal(draft.plan.user_role.gender, 'female')
})

// A fake model for the whole way: the talk (the sketch says what the user's words say), the plan, the writing.
async function fakeModel() {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const system = json.messages[0]?.content ?? ''
    const asked = json.messages.at(-1).content
    seen.push({ system, asked })
    let text = '<issues>[]</issues>'
    if (system.includes('共创向导')) {
      const gender = /我是个女生/.test(asked) ? '女' : /其实我是男的/.test(asked) ? '男' : ''
      const items = [{ key: 'user', label: '你的身份', value: '夜班店员', by: 'user' }, ...(gender ? [{ key: 'user_gender', label: '你的性别', value: gender, by: 'user' }] : [])]
      text = `<reply>好。</reply><questions>[]</questions><brief>${JSON.stringify({ title: '雨宿', readiness: 80, items })}</brief>`
    } else if (system.includes('角色卡策划')) {
      const plan = asked.includes('改成店长') ? { ...PLAN, user_role: { identity: '便利店店长', constraints: [] } } : PLAN
      text = `<plan>\n${JSON.stringify(plan)}\n</plan>`
    } else if (system.includes('开场白作者')) text = [...asked.matchAll(/^- 开场 (\d+)「/gm)].map(m => `<greeting index="${m[1]}">\n雨夜，<user> 抬起头。\n</greeting>`).join('\n')
    else if (system.includes('角色卡写手')) {
      const wanted = asked.split('这次要写下面这些条目：')[1] ?? ''
      text = [...wanted.matchAll(/^- (.+?)：/gm)].map(m => `<entry name="${m[1]}">\n${m[1]}的内容\n</entry>`).join('\n')
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: json.model, choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, seen }
}

async function forgeWith(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-user-gender-'))
  const { server, seen } = await fakeModel()
  t.after(async () => {
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/writer` })
  const forge = createForge(store)
  const settled = async id => {
    for (let i = 0; i < 500; i++) {
      const draft = await forge.get(id)
      if (!draft.job) return draft
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('the job never finished')
  }
  return { forge, seen, settled }
}

test('said in the talk, it reaches the picks, the plan and the writers; said again, it changes', async t => {
  const { forge, seen, settled } = await forgeWith(t)
  let draft = await settled((await forge.create({ text: '雨夜便利店', options: { cast: 'single' } })).id)
  assert.equal('userGender' in draft.options, false, 'not talked about: nothing')
  draft = await settled((await forge.say(draft.id, { text: '我是个女生，在便利店上夜班' })).id)
  assert.equal(draft.brief.items.find(item => item.key === 'user_gender').value, '女')
  assert.equal(draft.options.userGender, 'female')
  // The next round is told, not asked again.
  draft = await settled((await forge.say(draft.id, { text: '开场在凌晨' })).id)
  assert.match(seen.at(-1).system, /<user> 是女性：样例和试写里指代 <user> 用「她」/)
  assert.doesNotMatch(seen.at(-1).system, /在故事里是男是女/)
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  assert.match(seen.at(-1).system, /- <user> 是女性：指代 <user> 用「她」/)
  assert.equal(draft.plan.user_role.gender, 'female')

  // Said otherwise later in the talk: the picks and the plan follow.
  draft = await settled((await forge.say(draft.id, { text: '其实我是男的' })).id)
  assert.deepEqual([draft.options.userGender, draft.plan.user_role.gender], ['male', 'male'])
  // Changed in the sketch by hand: the same.
  const items = draft.brief.items.map(item => (item.key === 'user_gender' ? { ...item, value: '不限' } : item))
  draft = await forge.update(draft.id, { brief: { ...draft.brief, items } })
  assert.equal('userGender' in draft.options, false)
  assert.equal('gender' in draft.plan.user_role, false)
  // Set on the plan page: it stays, though the sketch still says 不限.
  draft = await forge.update(draft.id, { userGender: 'female' })
  draft = await forge.update(draft.id, { stage: 'plan' })
  assert.deepEqual([draft.options.userGender, draft.plan.user_role.gender], ['female', 'female'])
})

test('changed on the plan after the card is written, the card\'s description follows, and writing on keeps it', async t => {
  const { forge, settled } = await forgeWith(t)
  let draft = await settled((await forge.create({ text: '雨夜便利店', options: { cast: 'single', userGender: 'female' } })).id)
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  await forge.write(draft.id)
  draft = await settled(draft.id)
  assert.match(draft.card.description, /^<user>：女性；夜班店员$/m)

  draft = await forge.update(draft.id, { userGender: 'male' })
  assert.match(draft.card.description, /^<user>：男性；夜班店员$/m)
  await forge.write(draft.id)
  draft = await settled(draft.id)
  assert.match(draft.card.description, /^<user>：男性；夜班店员$/m)
  assert.match(cardJson(draft.plan, draft.card).data.description, /<user>：男性；夜班店员/)

  // Left at 不限: the gender goes from the line.
  draft = await forge.update(draft.id, { userGender: '' })
  assert.match(draft.card.description, /^<user>：夜班店员$/m)
  // A description edited by hand keeps what was written, and only the <user> line follows.
  draft = await forge.editCard(draft.id, { description: `一个雨夜的故事。\n${draft.card.description}` })
  draft = await forge.update(draft.id, { userGender: 'female' })
  assert.match(draft.card.description, /^一个雨夜的故事。\n/)
  assert.match(draft.card.description, /^<user>：女性；夜班店员$/m)
})

test('the plan revised after the card is written, a gender changed later still reaches the description', async t => {
  const { forge, settled } = await forgeWith(t)
  let draft = await settled((await forge.create({ text: '雨夜便利店', options: { cast: 'single', userGender: 'female' } })).id)
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  await forge.write(draft.id)
  draft = await settled(draft.id)
  assert.match(draft.card.description, /^<user>：女性；夜班店员$/m)

  // The revision changes who <user> is; the written description is left as it was.
  await forge.revise(draft.id, { text: '改成店长' })
  draft = await settled(draft.id)
  assert.equal(draft.plan.user_role.identity, '便利店店长')
  assert.match(draft.card.description, /^<user>：女性；夜班店员$/m)
  draft = await forge.update(draft.id, { userGender: 'male' })
  assert.equal(draft.plan.user_role.gender, 'male')
  assert.match(draft.card.description, /^<user>：男性；夜班店员$/m)
  assert.doesNotMatch(draft.card.description, /女性/)
  await forge.write(draft.id)
  draft = await settled(draft.id)
  assert.match(cardJson(draft.plan, draft.card).data.description, /<user>：男性；夜班店员/)
})
