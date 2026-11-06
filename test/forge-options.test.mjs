// 创作角色卡: the player's choices around the talk. The kind of card, ideas to
// start from (给我灵感), three plans to pick from, and each opening's own start.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { createForge } from '../server/forge/index.mjs'
import { createRulebooks } from '../server/game.mjs'
import { cleanCardOptions, discussRequest, editTracking, emptyBrief, ideaSeeds, ideasRequest, normalizePlan, planRequest, readIdeas, withCardOptions } from '../server/forge/prompts.mjs'
import { cardJson, greetingState, greetingsRequest, newCard } from '../server/forge/write.mjs'
import { greetingState as openingState } from '../server/chats.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const TALK = `<reply>好，先定舞台。</reply>
<questions>[{"id": "q1", "title": "放在哪？", "options": [{"label": "便利店"}, {"label": "车站"}]}]</questions>
<brief>{"title": "雨宿", "readiness": 80, "items": [{"key": "stage", "label": "舞台", "value": "便利店", "by": "user"}], "open": []}</brief>`

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。',
  user_role: { identity: '夜班店员' },
  world: { kind: '真实', overview: '多雨的港城', places: [{ name: '晴空便利店', description: '24 小时便利店' }] },
  characters: [{ name: '林小雨', kind: 'core', aliases: ['小雨'], gender: '女', identity: '雨女', relationship: '下雨就来避雨', personality: { base: '孤独', main: ['温柔'] } }],
  style: { perspective: '第三人称' },
  tracking: { enabled: true, variables: [
    { path: '林小雨.好感度', label: '好感', type: 'number', initial: '10', range: '0~100', check: '真心相待时 +2' },
    { path: '<user>.体力', label: '体力', type: 'number', initial: '80', range: '0~100', check: '熬夜 -5' },
  ] },
  greetings: [
    { title: '第一场雨', start: '初遇', scene: '凌晨两点', situation: '她推门进来', state: {} },
    { title: '第一百场雨', start: '已经熟了', scene: '梅雨季', situation: '她带了伞', state: { '林小雨.好感度': '70', '<user>.体力': 40, '不存在.的变量': '1' } },
  ],
  avatar: { character: '林小雨' },
}

const IDEAS = '<ideas>[{"title": "雨宿", "pitch": "只在雨夜出现的女孩来便利店避雨。", "tags": ["都市", "安静"]}, {"title": "", "pitch": "没有名字也算一个"}, {"title": "空的"}]</ideas>'

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-options-'))
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(json)
    const system = json.messages[0]?.role === 'system' ? json.messages[0].content : ''
    let text = TALK
    if (system.includes('角色卡策划')) text = `<plan>\n${JSON.stringify({ ...PLAN, name: `雨宿${seen.length}` })}\n</plan>`
    else if (system.includes('找灵感')) text = IDEAS
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: json.model, choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
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
  const recorded = []
  const forge = createForge(store, { ledger: { recordTurn: async chat => recorded.push(chat) } })
  return { forge, seen, recorded, store }
}

async function settled(forge, id) {
  for (let i = 0; i < 300; i++) {
    const draft = await forge.get(id)
    if (!draft.job) return draft
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('the job never finished')
}

const systemOf = request => request.messages[0].content

test('给我灵感: seeds spread out, shown ideas are left out, what comes back is read leniently', async t => {
  // Five seeds, no stage, bond or twist twice.
  const seeds = ideaSeeds(5)
  for (const key of ['stage', 'bond', 'twist']) assert.equal(new Set(seeds.map(s => s[key])).size, 5)
  const request = ideasRequest(seeds, { reply: 'English' }, { options: { world: true, gender: 'female' }, exclude: ['雨宿'] })
  assert.match(request.system, /用English写/)
  assert.match(request.system, /每个点子都要符合用户选的：重世界观.*核心角色是女性/)
  // A draft's old card type still counts; the format is no business of an idea.
  assert.match(ideasRequest(seeds, {}, { cardType: 'world' }).system, /重世界观/)
  assert.doesNotMatch(ideasRequest(seeds, {}, { options: { format: 'mvu-ui' } }).system, /符合用户选的/)
  assert.match(request.messages[0].content, /舞台：.*；关系：.*；转折：/)
  assert.match(request.messages[0].content, /不要再出一样或很像的：雨宿/)
  // An idea without a pitch is no idea.
  assert.deepEqual(readIdeas(IDEAS).map(idea => idea.title), ['雨宿', ''])
  assert.deepEqual(readIdeas('不是 JSON'), [])

  const { forge, seen, recorded } = await setup(t)
  const { ideas } = await forge.ideas({ cardType: 'single', exclude: ['旧的'] })
  assert.equal(ideas[0].pitch, '只在雨夜出现的女孩来便利店避雨。')
  assert.match(seen.at(-1).messages.at(-1).content, /旧的/)
  assert.equal(recorded.at(-1).title, '创作：找灵感')
})

test('the picks about the card (they combine) and how many openings shape the talk and the plan', async t => {
  const rounds = [{ user: { text: '想要一张冒险卡', picks: [] }, assistant: null }]
  const plain = discussRequest(rounds, emptyBrief())
  assert.doesNotMatch(plain.system, /用户开始前选好了/)
  const combined = discussRequest(rounds, emptyBrief(), undefined, { options: { cast: 'ensemble', world: true, play: ['bond', 'countdown'], format: 'mvu-ui' } }).system
  assert.match(combined, /用户开始前选好了这些.*几个角色（群像）.*重世界观.*好感与关系阶段.*倒计时与事件.*美化的状态栏/)
  assert.equal(discussRequest(rounds, emptyBrief(), undefined, { options: { cast: 'nonsense', play: ['nope'] } }).system, plain.system)
  // A plain-text card with a kind of play: told by the story, nothing tracked.
  const text = planRequest(rounds, emptyBrief(), undefined, { options: { play: ['growth'], format: 'text' } }).system
  assert.match(text, /玩法写进扮演准则/)
  assert.match(text, /tracking.enabled 为 false/)
  assert.doesNotMatch(text, /tracking.enabled 为 true/)
  assert.match(planRequest(rounds, emptyBrief()).system, /开场白默认 2 个/)
  const world = planRequest(rounds, emptyBrief(), undefined, { cardType: 'world', greetings: 9 })
  assert.match(world.system, /至少 3 个地点/)
  assert.match(world.system, /开场白 6 个/, 'six at most')

  const { forge, seen } = await setup(t)
  let draft = await settled(forge, (await forge.create({ text: '冒险', options: { world: true } })).id)
  assert.equal(draft.options.world, true)
  assert.match(systemOf(seen.at(-1)), /用户开始前选好了这些.*重世界观/)
  draft = await forge.update(draft.id, { options: { play: ['growth'], format: 'mvu-ui', statusTheme: 'neon' }, greetingCount: 3 })
  assert.deepEqual([draft.options.play, draft.options.statusTheme, draft.greetingCount], [['growth'], 'neon', 3])
  await forge.plan(draft.id)
  draft = await settled(forge, draft.id)
  assert.match(systemOf(seen.at(-1)), /tracking.enabled 为 true/)
  assert.match(systemOf(seen.at(-1)), /开场白 3 个/)
  assert.deepEqual(draft.planOptions, [])
})

test('出三版来挑: three plans at once, one picked, hand edits kept with it, a revision settles on one', async t => {
  const { forge, seen } = await setup(t)
  let draft = await settled(forge, (await forge.create({ text: '雨夜' })).id)
  const before = seen.length
  await forge.plan(draft.id, { variants: true })
  draft = await settled(forge, draft.id)
  const asked = seen.slice(before).map(r => r.messages.at(-1).content)
  assert.equal(asked.length, 3)
  assert.ok(asked.some(text => /更大胆/.test(text)) && asked.some(text => /换个切入/.test(text)))
  assert.deepEqual(draft.planOptions.map(o => [o.angle, o.picked]), [['close', true], ['bold', false], ['shift', false]])
  assert.equal(draft.plan.name, draft.planOptions[0].name)

  draft = await forge.update(draft.id, { planPick: 2 })
  assert.equal(draft.plan.name, draft.planOptions[2].name)
  await assert.rejects(forge.update(draft.id, { planPick: 7 }), /没有这一版/)
  // A change by hand stays with its version.
  draft = await forge.update(draft.id, { userName: '江砚' })
  draft = await forge.update(draft.id, { planPick: 0 })
  draft = await forge.update(draft.id, { planPick: 2 })
  assert.equal(draft.plan.user_role.name, '江砚')

  await forge.revise(draft.id, { text: '短一点' })
  draft = await settled(forge, draft.id)
  assert.deepEqual(draft.planOptions, [])
})

test('each opening its own start: values of its own, kept to what is tracked, in the card as MVU reads them', () => {
  const plan = normalizePlan(PLAN)
  // The player's values sit under 主角; a variable the plan does not track is dropped.
  assert.deepEqual(plan.greetings.map(g => g.state), [{}, { '林小雨.好感度': '70', '主角.体力': '40' }])
  assert.equal(plan.greetings[1].start, '已经熟了')
  assert.equal(greetingState(plan, plan.greetings[0]), null)
  assert.deepEqual(greetingState(plan, plan.greetings[1]), { 林小雨: { 好感度: 70 }, 主角: { 体力: 40 } })

  // Its writer is told.
  const asked = greetingsRequest(plan, plan.greetings.map((g, index) => ({ ...g, index })), [], '').messages[0].content
  assert.match(asked, /开场 2「第一百场雨」：已经熟了；梅雨季；她带了伞。/)
  assert.match(asked, /开局数值和默认不同：好感（林小雨.好感度）= 70；体力（主角.体力）= 40/)

  // In the card: the second opening ends with the whole state in <initvar>; the first starts from [InitVar].
  const card = newCard(plan)
  card.greetings = [{ title: 'a', text: '雨下起来了。' }, { title: 'b', text: '她收了伞。' }]
  const json = cardJson(plan, card)
  assert.equal(json.data.first_mes, '雨下起来了。')
  // The author: the player's name in settings + CicaTavern; the default name is no one's.
  assert.equal(json.data.creator, 'CicaTavern')
  assert.equal(cardJson(plan, card, { author: '你' }).data.creator, 'CicaTavern')
  assert.equal(cardJson(plan, card, { author: '阿蝉' }).data.creator, '阿蝉 + CicaTavern')
  const second = json.data.alternate_greetings[0]
  const block = /<UpdateVariable>\n<initvar>\n([\s\S]*)\n<\/initvar>\n<\/UpdateVariable>$/.exec(second)
  assert.deepEqual(YAML.parse(block[1]), { 林小雨: { 好感度: 70 }, 主角: { 体力: 40 } })
  // Hidden by the card's own scripts, and read by the app when a chat opens on it.
  assert.equal(second.replace(new RegExp(json.data.extensions.regex_scripts[0].findRegex.slice(1, -3), 'gi'), '').trim(), '她收了伞。')
  assert.deepEqual(openingState({ 林小雨: { 好感度: 10 }, 主角: { 体力: 80 } }, second), { 林小雨: { 好感度: 70 }, 主角: { 体力: 40 } })

  // A variable taken out of the status bar leaves the openings too; no tracking, no values of their own.
  const fewer = editTracking(plan, { variables: plan.tracking.variables.filter(v => v.path !== '主角.体力') })
  assert.deepEqual(fewer.greetings[1].state, { '林小雨.好感度': '70' })
  assert.deepEqual(editTracking(plan, { enabled: false }).greetings[1].state, {})
  assert.deepEqual(normalizePlan({ ...PLAN, tracking: { enabled: false } }).greetings[1].state, {})
})

test('格式 and 状态栏样式: a plain-text card tracks nothing, plain MVU has no bar of its own, a styled bar takes its look', () => {
  const plan = normalizePlan(PLAN)
  const card = newCard(plan)
  for (const entry of card.entries) entry.content ||= `${entry.name}正文`
  for (const greeting of card.greetings) greeting.text ||= '开场'
  const own = json => json.data.extensions.cicatavern?.status_bar ?? null
  const scriptNames = json => (json.data.extensions.regex_scripts ?? []).map(s => s.id)
  // A plain-text card: whatever the planner wrote, nothing is tracked.
  assert.equal(withCardOptions(plan, { format: 'text' }).tracking.enabled, false)
  // Plain MVU: the variables stay, the styled bar (in this app and SillyTavern's regex) does not.
  const mvu = cardJson(withCardOptions(plan, { format: 'mvu' }), card)
  assert.equal(own(mvu), null)
  assert.ok(!scriptNames(mvu).includes('cicatavern-status-bar'))
  // The styled bar with a look of its own: in the layout and in SillyTavern's HTML.
  const neon = cardJson(withCardOptions(plan, { format: 'mvu-ui', statusTheme: 'neon' }), card)
  assert.equal(own(neon).theme, 'neon')
  const bar = neon.data.extensions.regex_scripts.find(s => s.id === 'cicatavern-status-bar')
  assert.match(bar.replaceString, /class="bar theme-neon"/)
  assert.match(bar.replaceString, /\.theme-neon\{/)
  // The picks as kept: a look only goes with the styled bar.
  assert.deepEqual(cleanCardOptions({ format: 'mvu', statusTheme: 'neon', play: ['bond', 'bond', 'nope'] }), { cast: '', world: false, gender: '', play: ['bond'], format: 'mvu', statusTheme: '' })
})


test('战斗与成长: the planner is told, the plan keeps what makes sense, the card comes out ready to fight', () => {
  const rounds = [{ user: { text: '江湖冒险', picks: [] }, assistant: null }]
  const talk = discussRequest(rounds, emptyBrief(), undefined, { options: { play: ['battle'], format: 'text' } }).system
  assert.match(talk, /应用内置的规则/)
  assert.doesNotMatch(talk, /靠叙述体现/, 'it is not told by the story, plain text or not')
  const asked = planRequest(rounds, emptyBrief(), undefined, { options: { play: ['bond', 'battle'], format: 'mvu' } }).system
  assert.match(asked, /多写一个 game 字段/)
  assert.match(asked, /变量围绕这些玩法：好感与关系阶段（/)
  assert.doesNotMatch(planRequest(rounds, emptyBrief(), undefined, { options: { play: ['bond'] } }).system, /game 字段/)

  const game = {
    attributes: { body: 30, grace: 12, mind: 'x', charm: 9 },
    skills: [{ name: '裂石', kind: 'strike' }, { name: '怪招', kind: 'nope' }, { kind: 'sweep' }],
    things: [{ name: '回春丹', count: 2, type: 'heal', size: 'large' }, { name: '铜钥匙', count: 99 }],
    foes: [{ name: '灰狼', looks: 'grey wolf', moves: ['撕咬'] }],
  }
  const plan = withCardOptions(normalizePlan({ ...PLAN, game }), { play: ['battle'] })
  assert.deepEqual(plan.game.attributes, { body: 18, grace: 10, mind: 10, charm: 9 }, 'the points the rule window would give')
  assert.deepEqual(plan.game.skills, [{ name: '裂石', kind: 'strike' }, { name: '怪招', kind: '' }])
  assert.deepEqual(plan.game.things[1], { name: '铜钥匙', count: 9, type: '', size: 'medium' })
  assert.deepEqual(normalizePlan(plan).game, plan.game, 'read again it stays')

  const card = newCard(plan)
  card.greetings = [{ title: 'a', text: '雨下起来了。' }]
  const book = cardJson(plan, card).data.extensions.cicatavern.game
  assert.equal(book.level, 'full')
  assert.deepEqual(book.start, { things: [{ name: '回春丹', count: 2 }, { name: '铜钥匙', count: 9 }], skills: ['裂石', '怪招'] })
  assert.deepEqual(book.items, { 回春丹: { type: 'heal', size: 'large' } })
  assert.deepEqual(book.skills, { 裂石: 'strike' })
  assert.deepEqual(book.foes, { 灰狼: { looks: 'grey wolf', moves: ['撕咬'] } })

  const left = withCardOptions(normalizePlan(PLAN), { play: ['battle'] })
  assert.equal(left.game.skills.length, 0, 'left out by the planner: the defaults')
  assert.equal(withCardOptions(normalizePlan({ ...PLAN, game }), { play: ['bond'] }).game, null, 'not picked: not there')
  assert.equal(cardJson(withCardOptions(normalizePlan(PLAN), {}), card).data.extensions.cicatavern?.game, undefined)
})


test('a card made with 战斗与成长 is saved with its rules on; saved again, what play taught the bestiary stays', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-game-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const rulebooks = createRulebooks(store)
  const forge = createForge(store, { rulebooks })
  const plan = withCardOptions(normalizePlan({ ...PLAN, game: { skills: [{ name: '裂石', kind: 'strike' }], foes: [{ name: '灰狼', looks: 'wolf', moves: [] }] } }), { play: ['battle'] })
  const card = { ...newCard(plan), writtenAt: new Date().toISOString() }
  card.greetings[0].text = '雨下起来了。'
  const now = new Date().toISOString()
  const draft = { id: 'gamedraft', createdAt: now, updatedAt: now, stage: 'polish', model: '', rounds: [{ user: { text: '雨夜', picks: [] }, assistant: null }], brief: { title: '雨宿', readiness: 1 }, plan, card }
  await mkdir(path.join(root, 'forge'), { recursive: true })
  await writeFile(path.join(root, 'forge', 'gamedraft.json'), JSON.stringify(draft))
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const first = await forge.saveCard('gamedraft', { avatar: png })
  const book = await rulebooks.read(first.card.id)
  assert.equal(book.level, 'full', 'ready from the first turn')
  assert.deepEqual(book.start.skills, ['裂石'])
  assert.equal((await store.getCard(first.card.id)).game, undefined)
  await rulebooks.learnFoes(first.card.id, { 狼王: { looks: 'black wolf', moves: ['裂爪'] } })
  await writeFile(path.join(root, 'forge', 'gamedraft.json'), JSON.stringify({ ...draft, card: { ...card, savedCardId: first.card.id } }))
  await forge.saveCard('gamedraft', { avatar: png })
  assert.deepEqual(Object.keys((await rulebooks.read(first.card.id)).foes).sort(), ['灰狼', '狼王'].sort())
})
