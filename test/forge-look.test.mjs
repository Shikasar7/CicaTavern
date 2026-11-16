// 创作角色卡 → 状态栏与门面: a stage of its own between the plan and the writing. It can be gone to once there is a
// plan (and only then), a draft saved before it keeps its stage, and a revision asked for from it comes back to it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createForge } from '../server/forge/index.mjs'
import { normalizePlan, withCardOptions } from '../server/forge/prompts.mjs'
import { newCard } from '../server/forge/write.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。',
  user_role: { identity: '夜班店员' },
  world: { kind: '真实', overview: '多雨的港城', places: [{ name: '晴空便利店', description: '24 小时便利店' }] },
  characters: [{ name: '林小雨', kind: 'core', gender: '女', identity: '雨女', relationship: '下雨就来避雨', personality: { base: '孤独', main: ['温柔'] } }],
  style: { perspective: '第三人称' },
  tracking: { enabled: true, variables: [{ path: '林小雨.好感度', label: '好感', type: 'number', initial: '10', range: '0~100', check: '真心相待时 +2' }] },
  greetings: [{ title: '第一场雨', start: '初遇', scene: '凌晨两点', situation: '她推门进来', state: {} }],
  avatar: { character: '林小雨' },
}

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-look-'))
  // The revised plan a model would write: the same plan under another name.
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...PLAN, name: '雨宿·改' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/writer` })
  const forge = createForge(store, {})
  const now = new Date().toISOString()
  const seed = async (id, fields) => {
    const file = path.join(root, 'forge', `${id}.json`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ id, createdAt: now, updatedAt: now, model: '', rounds: [{ user: { text: '雨夜', picks: [] }, assistant: { reply: '好', questions: [], at: now } }], brief: { title: '雨宿', readiness: 1 }, options: { format: 'mvu-ui' }, ...fields }))
  }
  const settled = async id => {
    let view = await forge.get(id)
    for (let i = 0; i < 300 && view.job; i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      view = await forge.get(id)
    }
    return view
  }
  return { forge, seed, settled }
}

const plan = () => withCardOptions(normalizePlan(PLAN), { format: 'mvu-ui' })

test('状态栏与门面 is reachable with a plan, and not before one', async t => {
  const { forge, seed } = await setup(t)
  await seed('talking', { stage: 'discuss', plan: null, card: null })
  assert.equal((await forge.update('talking', { stage: 'look' })).stage, 'discuss')

  // A draft saved at the plan before this stage existed opens where it was, and can go on to it and back.
  await seed('planned', { stage: 'plan', plan: plan(), card: null })
  assert.equal((await forge.get('planned')).stage, 'plan')
  const looking = await forge.update('planned', { stage: 'look' })
  assert.equal(looking.stage, 'look')
  assert.equal(looking.plan.tracking.variables[0].label, '好感')
  assert.equal((await forge.update('planned', { stage: 'plan' })).stage, 'plan')
})

test('the status bar edited from 状态栏与门面 follows into a card already written', async t => {
  const { forge, seed } = await setup(t)
  const start = plan()
  await seed('written', { stage: 'polish', plan: start, card: { ...newCard(start), writtenAt: new Date().toISOString() } })
  assert.equal((await forge.update('written', { stage: 'look' })).stage, 'look')
  const variables = [...start.tracking.variables, { path: '林小雨.信任', label: '信任', type: 'number', initial: '5', range: '0~100', show: 'meter', check: '' }]
  const view = await forge.update('written', { tracking: { enabled: true, title: '', variables } })
  assert.equal(view.stage, 'look')
  assert.deepEqual(view.plan.tracking.variables.map(v => v.label), ['好感', '信任'])
  // The front is kept with the draft from here as from the plan.
  const front = await forge.update('written', { front: { cover: true, effect: 'rain' } })
  assert.ok(front.plan.cover)
  assert.equal(front.plan.cover.effect ?? front.plan.status.effect, 'rain')
  assert.equal(front.stage, 'look')
})

test('a revision asked for from 状态栏与门面 comes back there; one from the plan, to the plan', async t => {
  const { forge, seed, settled } = await setup(t)
  await seed('fromlook', { stage: 'look', plan: plan(), card: null })
  await forge.revise('fromlook', { notes: [{ section: '状态栏', text: '加一个信任' }] })
  const looked = await settled('fromlook')
  assert.equal(looked.plan.name, '雨宿·改')
  assert.equal(looked.stage, 'look')

  await seed('fromplan', { stage: 'plan', plan: plan(), card: null })
  await forge.revise('fromplan', { text: '换个名字' })
  const planned = await settled('fromplan')
  assert.equal(planned.plan.name, '雨宿·改')
  assert.equal(planned.stage, 'plan')
})
