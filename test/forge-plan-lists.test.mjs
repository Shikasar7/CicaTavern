// 创作角色卡 → 方案页直接改: people, places, factions and events added, changed and removed by hand, without a
// plan written again. What is typed is cleaned as a planner's is; a card already written keeps what still fits and
// is left with what to write.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createForge } from '../server/forge/index.mjs'
import { PLAN_LISTS, editPlanList, normalizePlan, withCardOptions } from '../server/forge/prompts.mjs'
import { newCard, stepDone, writeSteps } from '../server/forge/write.mjs'
import { createStore } from '../server/store.mjs'

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。',
  user_role: { identity: '夜班店员' },
  world: {
    kind: '真实', overview: '多雨的港城',
    places: [{ name: '晴空便利店', description: '24 小时便利店' }, { name: '后巷', description: '堆着纸箱的窄巷' }],
    factions: [{ name: '夜班工会', description: '店员的小圈子' }, { name: '商店街', description: '白天的那些店' }],
  },
  characters: [
    { name: '林小雨', kind: 'core', aliases: ['小雨'], gender: '女', identity: '雨女', relationship: '下雨就来避雨', personality: { base: '孤独', main: ['温柔'] } },
    { name: '老周', kind: 'npc', gender: '男', identity: '店长', relationship: '你的上司' },
  ],
  events: [{ name: '停电的夜晚', when: '整条街停电', content: '她第一次没有走。', keywords: ['停电'] }],
  style: { perspective: '第三人称' },
  tracking: { enabled: true, variables: [{ path: '林小雨.好感度', label: '好感', type: 'number', initial: '10', range: '0~100', check: '真心相待时 +2' }] },
  greetings: [{ title: '第一场雨', start: '初遇', scene: '凌晨两点', situation: '她推门进来', state: {} }],
  avatar: { character: '林小雨' },
}
const plan = () => withCardOptions(normalizePlan(PLAN), { format: 'mvu-ui' })
const names = list => list.map(item => item.name)

test('an item is added as a planner would write it, in the plan\'s entries at once', () => {
  assert.deepEqual(PLAN_LISTS, ['places', 'factions', 'characters', 'events'])
  const placed = editPlanList(plan(), { list: 'places', add: { name: '  天台  ', description: '晾着伞的天台', scenes: ['不该收'] } }).plan
  assert.deepEqual(placed.world.places.at(-1), { name: '天台', aliases: [], description: '晾着伞的天台', scenes: [] })
  assert.ok(placed.entries.some(entry => entry.name === '天台' && entry.type === '地理'))
  const joined = editPlanList(plan(), { list: 'factions', add: { name: '夜市', description: '后半夜才开的摊子' } }).plan
  assert.deepEqual(names(joined.world.factions), ['夜班工会', '商店街', '夜市'])
  // Someone added by hand is a side character, whatever was sent.
  const cast = editPlanList(plan(), { list: 'characters', add: { name: '阿澄', kind: 'core', identity: '送货员', gender: '女', relationship: '总在凌晨来', personality: { base: '不该收' } } }).plan
  const added = cast.characters.at(-1)
  assert.deepEqual([added.name, added.kind, added.identity, added.gender, added.relationship, added.personality.base], ['阿澄', 'npc', '送货员', '女', '总在凌晨来', ''])
  assert.ok(cast.entries.some(entry => entry.name === '阿澄' && entry.type === 'NPC'))
  // An event's words are split as typed; one with none of them and no condition is in the plan, but in no entry.
  const told = editPlanList(plan(), { list: 'events', add: { name: '末班车', when: '错过末班车', keywords: '末班车、 车站，站台', content: '她说可以送你。' } }).plan
  assert.deepEqual(told.events.at(-1).keywords, ['末班车', '车站', '站台'])
  assert.ok(told.entries.some(entry => entry.type === '事件' && entry.event === 1))
  const mute = editPlanList(plan(), { list: 'events', add: { name: '无声', content: '没有触发的事' } }).plan
  assert.equal(mute.events.length, 2)
  assert.ok(!mute.entries.some(entry => entry.type === '事件' && entry.event === 1))

  assert.throws(() => editPlanList(plan(), { list: 'places', add: { name: ' ' } }), /先写个名字/)
  assert.throws(() => editPlanList(plan(), { list: 'places', add: { name: '后巷' } }), /已经有叫「后巷」的了/)
  assert.throws(() => editPlanList(plan(), { list: 'rules', add: { name: 'x' } }), /没有这一类/)
  assert.throws(() => editPlanList(plan(), { list: 'places' }), /没说要改什么/)
  // The card's scale is the most there can be.
  let full = plan()
  for (let i = full.world.places.length; i < 10; i++) full = editPlanList(full, { list: 'places', add: { name: `地点${i}` } }).plan
  assert.throws(() => editPlanList(full, { list: 'places', add: { name: '第十一个' } }), /最多 10 个/)
})

test('an item is changed in what can be typed, its name and the rest kept; what is written from it is named', () => {
  const { plan: changed, touched } = editPlanList(plan(), { list: 'characters', change: { name: '林小雨', name2: 'x', identity: '只在雨夜出现的女孩', personality: { base: '开朗' }, kind: 'npc' } })
  const she = changed.characters[0]
  assert.deepEqual([she.name, she.kind, she.identity, she.relationship, she.personality.base, she.aliases], ['林小雨', 'core', '只在雨夜出现的女孩', '下雨就来避雨', '孤独', ['小雨']])
  assert.ok(touched.length >= 2 && touched.every(name => changed.entries.find(entry => entry.name === name).owner === '林小雨'))
  assert.deepEqual(editPlanList(plan(), { list: 'places', change: { name: '后巷', description: '新装了路灯' } }).touched, ['后巷'])
  const event = editPlanList(plan(), { list: 'events', change: { name: '停电的夜晚', keywords: '停电，蜡烛' } })
  assert.deepEqual(event.plan.events[0].keywords, ['停电', '蜡烛'])
  assert.equal(event.plan.events[0].content, '她第一次没有走。')
  assert.equal(event.touched.length, 1)
  assert.throws(() => editPlanList(plan(), { list: 'places', change: { name: '没有的' } }), /已经没有这一项了/)
})

test('an item is removed; the last core character stays, and the picture is of someone still there', () => {
  const without = editPlanList(plan(), { list: 'characters', remove: '老周' }).plan
  assert.deepEqual(names(without.characters), ['林小雨'])
  assert.ok(!without.entries.some(entry => entry.name === '老周'))
  assert.throws(() => editPlanList(plan(), { list: 'characters', remove: '林小雨' }), /至少要留一个核心角色/)
  // With another core character, the first can go: the avatar moves to who is left.
  const two = withCardOptions(normalizePlan({ ...PLAN, characters: [...PLAN.characters, { name: '沈雾', kind: 'core', identity: '常客', personality: { base: '冷' } }] }), { format: 'mvu-ui' })
  const moved = editPlanList(two, { list: 'characters', remove: '林小雨' }).plan
  assert.equal(moved.avatar.character, '沈雾')
  // One place left is part of the world, not an entry of its own.
  const one = editPlanList(plan(), { list: 'places', remove: '后巷' }).plan
  assert.ok(!one.entries.some(entry => entry.type === '地理' && entry.part === 'region'))
  assert.throws(() => editPlanList(plan(), { list: 'events', remove: '没有的' }), /已经没有这一项了/)
})

test('something only taken out of a finished card leaves it finished', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-lists-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const store = createStore(root)
  await store.init()
  const forge = createForge(store, {})
  const start = plan()
  const card = { ...newCard(start), writtenAt: '2026-11-10T00:00:00.000Z', reviewed: true, fixed: true }
  for (const entry of card.entries) if (!entry.content) entry.content = `写好的：${entry.name}`
  card.greetings[0].text = '雨下起来了。'
  const now = new Date().toISOString()
  await mkdir(path.join(root, 'forge'), { recursive: true })
  await writeFile(path.join(root, 'forge', 'donedraft.json'), JSON.stringify({ id: 'donedraft', createdAt: now, updatedAt: now, stage: 'plan', model: '', rounds: [{ user: { text: '雨夜', picks: [] }, assistant: null }], brief: { title: '雨宿', readiness: 1 }, options: { format: 'mvu-ui' }, plan: start, card }))
  const removed = await forge.update('donedraft', { planList: { list: 'characters', remove: '老周' } })
  assert.ok(!removed.card.entries.some(entry => entry.name === '老周'))
  assert.equal(removed.card.writtenAt, '2026-11-10T00:00:00.000Z', 'nothing is left to write or to check again')
  assert.equal(removed.stage, 'plan')
})

test('a card already written keeps what still fits, and is left with what to write', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-lists-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const store = createStore(root)
  await store.init()
  const forge = createForge(store, {})
  const start = plan()
  const card = { ...newCard(start), writtenAt: new Date().toISOString(), reviewed: true, fixed: true }
  for (const entry of card.entries) if (!entry.content) entry.content = `写好的：${entry.name}`
  card.greetings[0].text = '雨下起来了。'
  const now = new Date().toISOString()
  await mkdir(path.join(root, 'forge'), { recursive: true })
  await writeFile(path.join(root, 'forge', 'listdraft.json'), JSON.stringify({ id: 'listdraft', createdAt: now, updatedAt: now, stage: 'polish', model: '', rounds: [{ user: { text: '雨夜', picks: [] }, assistant: null }], brief: { title: '雨宿', readiness: 1 }, options: { format: 'mvu-ui' }, plan: start, card }))
  const textOf = (view, name) => view.card.entries.find(entry => entry.name === name)?.content

  const added = await forge.update('listdraft', { planList: { list: 'characters', add: { name: '阿澄', identity: '送货员' } } })
  assert.deepEqual(added.plan.characters.map(c => c.name), ['林小雨', '老周', '阿澄'])
  assert.equal(textOf(added, '阿澄'), '', 'the new one is to write')
  assert.equal(textOf(added, '老周'), '写好的：老周', 'the rest is kept')
  assert.equal(added.card.greetings[0].text, '雨下起来了。')
  assert.equal(added.card.writtenAt, null, 'no finished card any more: the plan page offers 接着写')
  assert.equal(added.stage, 'write')
  const todo = writeSteps(added.plan, added.card).filter(step => !stepDone(step, added.card)).map(step => step.id)
  assert.ok(todo.some(id => id.startsWith('cast')) && todo.includes('review'), `only the side cast and the check are left: ${todo}`)

  const changed = await forge.update('listdraft', { planList: { list: 'places', change: { name: '后巷', description: '新装了路灯' } } })
  assert.equal(textOf(changed, '后巷'), '', 'written from what was changed: to write again')
  assert.equal(textOf(changed, '晴空便利店'), '写好的：晴空便利店')

  const removed = await forge.update('listdraft', { planList: { list: 'characters', remove: '老周' } })
  assert.equal(textOf(removed, '老周'), undefined)
  assert.equal(textOf(removed, '夜班工会'), '写好的：夜班工会')
  await assert.rejects(() => forge.update('listdraft', { planList: { list: 'characters', remove: '林小雨' } }), /至少要留一个核心角色/)
})
