// The player's name in a card made with 创作角色卡: asked in the talk (settings
// name or one of the card's own), never made up by the plan, kept in the card
// and used for chats on it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chosenUserName, cleanUserName, discussRequest, editUserName, emptyBrief, forgeLanguages, normalizePlan } from '../server/forge/prompts.mjs'
import { cardJson, newCard, userTagged } from '../server/forge/write.mjs'
import { createForge } from '../server/forge/index.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { createChat, playerOf, rebuildPrompt } from '../server/chats.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

// A plan that names the player on its own, as one model did: 江砚 in the
// identity, in user_role.name, in the variable paths and an opening.
const INVENTED = {
  name: '青芜谷',
  summary: '没有灵根的药童和不认旧账的师姐。',
  user_role: { name: '江砚', identity: '你叫江砚，十八岁上下，云岚宗外门的杂役药童，没有灵根。', constraints: ['江砚没有灵根'] },
  world: { kind: '架空', overview: '九州，云岚宗', rules: [], places: [], factions: [], history: [] },
  characters: [
    { name: '沈梨', kind: 'core', aliases: ['师姐'], gender: '女', identity: '外门弟子', relationship: '小时候救过江砚', personality: { base: '护短', main: ['毒舌'] } },
    { name: '顾青梧', kind: 'npc', role: '内门女修' },
  ],
  style: { perspective: '第二人称' },
  play_rules: ['不替江砚做决定'],
  tracking: {
    enabled: true,
    variables: [
      { path: '沈梨.好感度', type: 'number', initial: '20', range: '0~100', show: 'meter' },
      { path: '江砚.体力', type: 'number', initial: '80', range: '0~100', show: 'meter', check: '江砚干活时 -5' },
      { path: '<user>.灵石', type: 'number', initial: '3' },
    ],
  },
  greetings: [{ title: '分到她名下', scene: '青芜谷', situation: '管事把新来的杂役（江砚）丢给沈梨', length: '500~700' }],
  avatar: { character: '沈梨', description: '药田里的师姐', tags: '1girl' },
  assumptions: ['主角（<user>）定名江砚，十八岁上下。数值路径需要挂在一个人名底下，所以用了这个名字。', '这个世界叫九州。'],
  verbatim: [],
}

test('the name from the talk: a name, or one of the ways of saying "the one in settings"', () => {
  assert.equal(cleanUserName('「沈观」'), '沈观')
  assert.equal(cleanUserName('江砚（十八岁）'), '江砚')
  assert.equal(cleanUserName('用设置里的名字'), '')
  assert.equal(cleanUserName('Use the name in Settings'), '')
  assert.equal(cleanUserName('你'), '')
  assert.equal(cleanUserName('<user>'), '')
  assert.equal(chosenUserName({ items: [{ key: 'user_name', value: '沈观' }] }), '沈观')
  assert.equal(chosenUserName({ items: [{ key: 'user', value: '杂役药童' }] }), '', 'never asked: the one in settings')
  assert.equal(chosenUserName(null), '')
})

test('the guide asks for the name, offering the one in settings first', () => {
  const ask = name => discussRequest([{ user: { text: '修仙', picks: [] } }], emptyBrief(), forgeLanguages('zh', ''), { userName: name }).system
  assert.match(ask('阿蝉'), /用设置里的名字」，detail 写「设置里填的是「阿蝉」/)
  assert.match(ask('你'), /设置里还没填名字，故事里就叫你「你」/)
  assert.match(ask(''), /设置里还没填名字/)
  assert.match(ask('阿蝉'), /user_name 你的名字/)
  assert.match(ask('阿蝉'), /不替 <user> 起名字/)
})

test('a name the plan made up is taken back out: <user> in the text, the values under 主角', () => {
  const plan = normalizePlan(INVENTED, { userName: '' })
  assert.equal(plan.user_role.name, '')
  assert.equal(plan.user_role.identity, '十八岁上下，云岚宗外门的杂役药童，没有灵根。')
  assert.deepEqual(plan.user_role.constraints, ['<user>没有灵根'])
  assert.equal(plan.characters[0].relationship, '小时候救过<user>')
  assert.deepEqual(plan.play_rules, ['不替<user>做决定'])
  assert.equal(plan.greetings[0].situation, '管事把新来的杂役丢给沈梨')
  assert.deepEqual(plan.tracking.variables.map(v => v.path), ['沈梨.好感度', '主角.体力', '主角.灵石'])
  assert.equal(plan.tracking.variables[1].check, '<user>干活时 -5')
  assert.deepEqual(plan.assumptions, ['这个世界叫九州。'], 'the guess about the name goes')
  assert.doesNotMatch(JSON.stringify(plan), /江砚/)
  // Only in the identity, not in user_role.name: caught there too.
  const quiet = normalizePlan({ ...INVENTED, user_role: { identity: '<user>名叫江砚，是个药童。' } }, { userName: '' })
  assert.equal(quiet.user_role.identity, '是个药童。')
  assert.equal(quiet.tracking.variables[1].path, '主角.体力')
})

test('a name the player chose is kept in user_role.name only; the player is no character', () => {
  const plan = normalizePlan({
    ...INVENTED,
    user_role: { name: '沈观', identity: '你叫沈观，落第书生。' },
    characters: [...INVENTED.characters, { name: '沈观', kind: 'core', identity: '主角' }],
    tracking: { enabled: true, variables: [{ path: '沈观.体力', type: 'number', initial: '80' }] },
  }, { userName: '沈观' })
  assert.equal(plan.user_role.name, '沈观')
  assert.equal(plan.user_role.identity, '落第书生。')
  assert.deepEqual(plan.characters.map(c => c.name), ['沈梨', '顾青梧'])
  assert.deepEqual(plan.tracking.variables.map(v => v.path), ['主角.体力'])
  assert.ok(!plan.entries.some(e => e.owner === '沈观'))
  // The talk said nothing: the plan's own name does not count.
  assert.equal(normalizePlan({ ...INVENTED, user_role: { name: '沈观' } }, { userName: '' }).user_role.name, '')
  // A revision: a new name counts only when the player's comment says it.
  assert.equal(normalizePlan({ ...INVENTED, user_role: { name: '沈观' } }, { userName: '江砚', said: '主角改名叫沈观' }).user_role.name, '沈观')
  assert.equal(normalizePlan({ ...INVENTED, user_role: { name: '沈观' } }, { userName: '江砚', said: '配角少一点' }).user_role.name, '江砚')
  // Left out (old callers, tests): the plan's own is taken.
  assert.equal(normalizePlan({ ...INVENTED, user_role: { name: '沈观' } }).user_role.name, '沈观')
})

test('a made-up name inside another name is left alone; an English card keeps the values under Protagonist', () => {
  const plan = normalizePlan({ ...INVENTED, user_role: { name: '青梧', identity: '药童' } }, { userName: '' })
  assert.equal(plan.characters[1].name, '顾青梧', 'not 顾<user>')
  const english = normalizePlan({ ...INVENTED, user_role: { name: 'Jiang', identity: 'Your name is Jiang, a herb boy.' }, tracking: { enabled: true, variables: [{ path: 'Jiang.stamina', type: 'number', initial: '80' }] } }, { userName: '', language: 'English' })
  assert.equal(english.user_role.identity, 'Your name is <user>, a herb boy.')
  assert.deepEqual(english.tracking.variables.map(v => v.path), ['Protagonist.stamina'])
})

test('the card keeps the name for chats and says it for SillyTavern; written text says <user>', () => {
  const plan = editUserName(normalizePlan(INVENTED, { userName: '' }), '「沈观」')
  assert.equal(plan.user_role.name, '沈观')
  assert.equal(userTagged('沈观推开门，沈梨抬头。', plan), '<user>推开门，沈梨抬头。')
  assert.equal(userTagged('沈观', { user_role: { name: '沈观' }, characters: [{ name: '沈观音', aliases: [] }] }), '沈观', 'inside another name: left alone')
  const card = newCard(plan)
  const json = cardJson(plan, card)
  assert.equal(json.data.extensions.cicatavern.user_name, '沈观')
  assert.ok(json.data.extensions.cicatavern.status_bar, 'the status bar stays beside it')
  assert.match(json.data.creator_notes, /主角名：沈观。.*把用户名（Persona）设成「沈观」/)
  assert.equal(normalizeCard(json).userName, '沈观')
  // No name of its own: nothing added.
  const plain = normalizePlan({ ...INVENTED, tracking: { enabled: false, variables: [] } }, { userName: '' })
  const bare = cardJson(plain, newCard(plain))
  assert.equal(bare.data.extensions.cicatavern, undefined)
  assert.doesNotMatch(bare.data.creator_notes, /主角名/)
  assert.equal(normalizeCard(bare).userName, '')
})

test('chats on a card with its own name use it, without the settings description', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-username-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  await store.savePersona({ name: '阿蝉', description: '阿蝉是个大学生。' })
  const own = normalizeCard({ name: '青芜谷', description: '<user>：杂役药童', first_mes: '{{user}}，过来。', extensions: { cicatavern: { user_name: '沈观' } } })
  const plain = normalizeCard({ name: '小雨', first_mes: '{{user}}，雨停了。' })
  await store.saveCard(own)
  await store.saveCard(plain)

  const chat = await createChat(store, own.id)
  assert.equal(chat.names.user, '沈观')
  assert.match(chat.systemPrompt, /玩家扮演「沈观」/)
  assert.match(chat.systemPrompt, /沈观：杂役药童/)
  assert.doesNotMatch(chat.systemPrompt, /阿蝉/)
  assert.match(chat.nodes.root.text, /沈观，过来/)
  await rebuildPrompt(store, chat)
  assert.doesNotMatch(chat.systemPrompt, /阿蝉/)

  const other = await createChat(store, plain.id)
  assert.equal(other.names.user, '阿蝉')
  assert.match(other.systemPrompt, /阿蝉是个大学生/)

  // A chat started under another name keeps it, and the description with it.
  assert.deepEqual(playerOf(own, { name: '阿蝉', description: 'd' }, '阿蝉'), { name: '阿蝉', description: 'd' })
  assert.deepEqual(playerOf(own, { name: '阿蝉', description: 'd' }), { name: '沈观', description: '' })
})

test('in the card creator: the plan names the player only as the talk did; the name can be set by hand', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-username-'))
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(json)
    const system = json.messages[0]?.content ?? ''
    const text = system.includes('角色卡策划')
      ? `<plan>\n${JSON.stringify(INVENTED)}\n</plan>`
      : '<reply>好。</reply><questions>[]</questions><brief>{"title": "青芜谷", "readiness": 80, "items": [{"key": "user", "label": "你的身份", "value": "杂役药童", "by": "user"}]}</brief>'
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
  await store.savePersona({ name: '阿蝉', description: '' })
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/writer` })
  const forge = createForge(store)
  const settled = async id => {
    for (let i = 0; i < 200; i++) {
      const draft = await forge.get(id)
      if (!draft.job) return draft
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('the job never finished')
  }

  let draft = await settled((await forge.create({ text: '修仙药童' })).id)
  assert.match(seen[0].messages[0].content, /设置里填的是「阿蝉」/)
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  assert.equal(draft.plan.user_role.name, '', 'never asked: no name of its own')
  assert.doesNotMatch(JSON.stringify(draft.plan), /江砚/)

  // The talk settled on 沈观 (the sketch item the guide keeps): the plan has it.
  await forge.update(draft.id, { stage: 'discuss' })
  await forge.update(draft.id, { brief: { items: [...draft.brief.items, { key: 'user_name', label: '你的名字', value: '沈观', by: 'user' }] } })
  await forge.plan(draft.id)
  draft = await settled(draft.id)
  assert.equal(draft.plan.user_role.name, '沈观')

  // By hand in the plan: cleared, then another.
  draft = await forge.update(draft.id, { userName: '' })
  assert.equal(draft.plan.user_role.name, '')
  draft = await forge.update(draft.id, { userName: '  江离 ' })
  assert.equal(draft.plan.user_role.name, '江离')
})
