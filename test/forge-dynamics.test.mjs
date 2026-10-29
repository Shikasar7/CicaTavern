// 创作角色卡: what changes as the story goes. A personality in stages by a
// tracked value, events that come in when named or when a value holds, both put
// under EJS by the code; and the cast written into 配图 → 角色名单.
import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createForge } from '../server/forge/index.mjs'
import { editTracking, eventConditions, normalizePlan, stagesOf } from '../server/forge/prompts.mjs'
import { cardJson, conditionExpression, entriesRequest, newCard, previewDynamics, stagedText, wrapped, writeSteps } from '../server/forge/write.mjs'
import { initTemplates, renderTemplate } from '../server/template.mjs'
import { createStore } from '../server/store.mjs'

before(() => initTemplates())

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636060f80f0000010100005a4d6b8a0000000049454e44ae426082', 'hex')
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。',
  user_role: { identity: '夜班店员' },
  world: { kind: '真实', overview: '多雨的港城' },
  characters: [
    {
      name: '林小雨', kind: 'core', aliases: ['小雨'], gender: '女', identity: '雨女', relationship: '下雨就来避雨',
      personality: { base: '孤独', main: ['温柔'] }, looks_tags: 'black hair, wet hair', outfit_tags: 'white raincoat',
      stage_by: '林小雨.好感度',
      stages: [
        { name: '戒备', until: '30', main: ['警惕'], shift: '只在门口站着' },
        { name: '试探', until: '70', main: ['好奇'] },
        { name: '依赖', main: ['依赖'], accent: ['脆弱'] },
      ],
    },
    { name: '王店长', kind: 'npc', role: '偶尔来查岗', gender: '男', looks_tags: 'old man, glasses' },
  ],
  tracking: { enabled: true, variables: [
    { path: '林小雨.好感度', label: '好感', type: 'number', initial: '10', range: '0~100', check: '真心相待 +2' },
    { path: '<user>.体力', label: '体力', type: 'number', initial: '80', range: '0~100', check: '熬夜 -5' },
    { path: '林小雨.收到的东西', label: '收到', type: 'list', initial: '', check: '送她东西时加' },
  ] },
  greetings: [{ title: '第一场雨' }],
  events: [
    { name: '告白', when: '好感很高的雨夜', requires: { path: '林小雨.好感度', op: '>=', value: '80' }, content: '她在关门前说出口' },
    { name: '晕倒', when: '你累倒时', keywords: ['头晕'], requires: { path: '<user>.体力', op: '<', value: '20' }, content: '她第一次走进柜台' },
    { name: '店长查岗', when: '提到店长', keywords: ['店长', '查岗'], content: '王店长推门进来' },
    { name: '伞', when: '收到伞以后', requires: { path: '林小雨.收到的东西', op: 'has', value: '伞' }, content: '她第一次撑伞离开' },
    { name: '没有触发', when: '某天', content: '什么都不会发生' },
    { name: '坏条件', when: '好感是字', requires: { path: '林小雨.好感度', op: '>=', value: '很高' }, content: '不会写进卡' },
  ],
  avatar: { character: '林小雨' },
}

test('a personality in stages: kept to a tracked number with rising bounds, written in parts, put under EJS', () => {
  const plan = normalizePlan(PLAN)
  const xiaoyu = plan.characters[0]
  const staged = stagesOf(plan, xiaoyu)
  assert.deepEqual(staged.stages.map(s => [s.name, s.below]), [['戒备', 30], ['试探', 70], ['依赖', null]])
  // The palette and the notes are staged; the profile is not.
  assert.deepEqual(plan.entries.filter(e => e.staged).map(e => e.name), ['林小雨_性格调色盘', '林小雨_二次解释'])
  assert.match(plan.entries.find(e => e.name === '林小雨_性格调色盘').purpose, /分阶段：戒备 → 试探 → 依赖/)

  // Its writer is told the stages and how to mark them.
  const asked = entriesRequest(plan, plan.entries.filter(e => e.staged), []).messages[0].content
  assert.match(asked, /「【阶段：阶段名】」/)
  assert.match(asked, /「戒备」（好感 < 30；主色调警惕；只在门口站着）、「试探」（好感 ≥ 30，好感 < 70；主色调好奇）、「依赖」（好感 ≥ 70；主色调依赖；点缀脆弱）/)

  // Parts become branches; what comes before the first mark is always there.
  const written = '底色：孤独\n孤独衍生一：总在窗边坐着\n\n【阶段：戒备】\n警惕衍生一：不接你递的伞\n【阶段：试探】\n好奇衍生一：问你值班到几点\n【阶段：依赖】\n依赖衍生一：等你下班'
  const ejs = stagedText(written, plan, '林小雨')
  assert.match(ejs, /^底色：孤独\n孤独衍生一：总在窗边坐着\n\n<%_ if \(getvar\("stat_data\.林小雨\.好感度", \{ defaults: 10 \}\) < 30\) \{ _%>/)
  const at = value => renderTemplate(ejs, { variables: { stat_data: { 林小雨: { 好感度: value } } } }).text
  assert.match(at(10), /不接你递的伞/)
  assert.doesNotMatch(at(10), /问你值班|等你下班/)
  assert.match(at(50), /问你值班到几点/)
  assert.match(at(90), /等你下班/)
  assert.ok([10, 50, 90].every(v => at(v).startsWith('底色：孤独')))
  // A value not there yet reads as its starting one.
  assert.match(renderTemplate(ejs, { variables: {} }).text, /不接你递的伞/)
  // Parts named otherwise go by order; no marks, no EJS.
  assert.match(stagedText('共有\n【阶段：甲】\nA\n【阶段：乙】\nB\n【阶段：丙】\nC', plan, '林小雨'), /< 70\) \{ _%>\nB\n/)
  assert.equal(stagedText('只有一段', plan, '林小雨'), '只有一段')

  // Bounds that do not rise, a value that is not a number, a value not tracked: no stages, the marks taken out.
  for (const broken of [
    { stages: [{ name: '甲', until: '50' }, { name: '乙', until: '20' }, { name: '丙' }] },
    { stage_by: '林小雨.收到的东西' },
    { stage_by: '林小雨.不存在' },
    { stages: [{ name: '只有一个' }] },
  ]) {
    const other = normalizePlan({ ...PLAN, characters: [{ ...PLAN.characters[0], ...broken }, PLAN.characters[1]] })
    assert.equal(stagesOf(other, other.characters[0]), null, JSON.stringify(broken))
    assert.equal(other.entries.some(e => e.staged), false)
  }
  const off = editTracking(plan, { variables: plan.tracking.variables.filter(v => v.path !== '林小雨.好感度') })
  assert.equal(off.entries.some(e => e.staged), false)
  assert.equal(stagedText(written, off, '林小雨'), '底色：孤独\n孤独衍生一：总在窗边坐着\n\n警惕衍生一：不接你递的伞\n\n好奇衍生一：问你值班到几点\n\n依赖衍生一：等你下班')
})

test('events: in when named or when a value holds, under @@if; one with no way in stays out', () => {
  const plan = normalizePlan(PLAN)
  const events = plan.entries.filter(e => e.type === '事件')
  assert.deepEqual(events.map(e => [e.name, e.strategy, e.keywords]), [
    ['事件_告白', 'constant', []],
    ['事件_晕倒', 'keyword', ['头晕']],
    ['事件_店长查岗', 'keyword', ['店长', '查岗']],
    ['事件_伞', 'constant', []],
  ])
  assert.ok(events.every(e => e.position === 'depth'))
  // The player's value moved under 主角.
  assert.equal(plan.events[1].requires[0].path, '主角.体力')
  assert.equal(eventConditions(plan, plan.events[5]), null, 'a number compared with words')
  assert.equal(conditionExpression(eventConditions(plan, plan.events[3])[0]), 'getvar("stat_data.林小雨.收到的东西", { defaults: [] }).includes("伞")')

  // Written in their own step, with what the plan says happens.
  const card = newCard(plan)
  assert.deepEqual(writeSteps(plan, card).find(s => s.id === 'events').names, events.map(e => e.name))
  assert.match(entriesRequest(plan, events.slice(0, 1), []).messages[0].content, /事件内容：好感很高的雨夜；她在关门前说出口/)

  // In the card: the condition first, then the event in its tag; sent only while it holds.
  const confess = { ...events[0], content: '她在关门前说：「明天也下雨吧。」' }
  const text = wrapped(confess, plan)
  assert.equal(text.split('\n')[0], '@@if getvar("stat_data.林小雨.好感度", { defaults: 10 }) >= 80')
  const at = value => renderTemplate(text, { variables: { stat_data: { 林小雨: { 好感度: value } } } }).text.trim()
  assert.equal(at(50), '')
  assert.match(at(85), /^<event name="事件_告白">\n只发生一次：.*\n她在关门前说/)
  // Conditions together: all of them. One met at the starting values would be there from the first reply: not used.
  const more = normalizePlan({ ...PLAN, events: [
      { name: '开局就成立', when: '好感跌下去', requires: [{ path: '林小雨.好感度', op: '<=', value: '20' }], content: '开局好感是 10，不会写进卡' },
      { name: '久别', when: '体力见底又很亲近', requires: [{ path: '<user>.体力', op: '<', value: '30' }, { path: '林小雨.好感度', op: '>=', value: '60' }], content: '她守了你一夜' },
  ] })
  assert.equal(eventConditions(more, more.events[0]), null)
  assert.deepEqual(more.entries.filter(e => e.type === '事件').map(e => e.name), ['事件_久别'])
  const both = wrapped({ ...more.entries.find(e => e.type === '事件'), content: '她守了你一夜。' }, more)
  assert.equal(both.split('\n')[0], '@@if getvar("stat_data.主角.体力", { defaults: 80 }) < 30 && getvar("stat_data.林小雨.好感度", { defaults: 10 }) >= 60')
  const night = (体力, 好感度) => renderTemplate(both, { variables: { stat_data: { 主角: { 体力 }, 林小雨: { 好感度 } } } }).text.trim()
  assert.equal(night(20, 40), '')
  assert.equal(night(50, 80), '')
  assert.match(night(20, 80), /她守了你一夜/)
  // A keyword event without a condition is left as it is.
  assert.doesNotMatch(wrapped({ ...events[2], content: '他来了' }, plan), /@@if/)
})

test('the card says it needs ST-Prompt-Template only when it uses EJS', () => {
  const plan = normalizePlan(PLAN)
  const card = newCard(plan)
  card.greetings[0].text = '雨下起来了。'
  for (const entry of card.entries) if (!entry.content) entry.content = entry.staged ? '共有\n【阶段：戒备】\nA\n【阶段：试探】\nB\n【阶段：依赖】\nC' : '内容'
  const json = cardJson(plan, card)
  assert.match(json.data.creator_notes, /ST-Prompt-Template/)
  assert.match(json.data.character_book.entries.find(e => e.comment === '林小雨_性格调色盘').content, /^<character_palette character="林小雨">\n共有\n\n<%_ if/)
  const plain = normalizePlan({ ...PLAN, characters: PLAN.characters.map(({ stages, stage_by, ...c }) => c), events: [] })
  const plainCard = newCard(plain)
  plainCard.greetings[0].text = '雨下起来了。'
  assert.doesNotMatch(cardJson(plain, plainCard).data.creator_notes, /ST-Prompt-Template/)
})

test('the cast goes into 配图 → 角色名单; saved again, someone new is added and what was set there stays', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-cast-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const forge = createForge(store)
  const plan = normalizePlan(PLAN)
  const card = { ...newCard(plan), writtenAt: new Date().toISOString() }
  card.greetings[0].text = '雨下起来了。'
  const now = new Date().toISOString()
  const draft = { id: 'castdraft', createdAt: now, updatedAt: now, stage: 'polish', model: '', rounds: [{ user: { text: '雨夜', picks: [] }, assistant: null }], brief: { title: '雨宿', readiness: 80, items: [], open: [] }, plan, card, job: null, error: null }
  await mkdir(path.join(root, 'forge'), { recursive: true })
  await writeFile(path.join(root, 'forge', 'castdraft.json'), JSON.stringify(draft))

  const first = await forge.saveCard('castdraft', { avatar: PNG_URL })
  let saved = await store.getCard(first.card.id)
  assert.deepEqual(saved.media.roster.map(r => [r.name, r.kind, r.looks]), [['林小雨', 'girl', 'black hair, wet hair'], ['王店长', 'boy', 'old man, glasses']])

  // Changed in 配图: her looks and voice; his outfit left empty. The plan gains someone.
  saved.media.roster[0] = { ...saved.media.roster[0], looks: 'silver hair', voice: 'zh-CN-Xiaoyi' }
  saved.media.roster[1] = { ...saved.media.roster[1], outfit: '' }
  saved.media.style = 'watercolor'
  await store.saveCard(saved)
  const more = normalizePlan({ ...PLAN, characters: [...PLAN.characters, { name: '阿青', kind: 'npc', gender: '女', looks_tags: 'green hair' }] })
  await writeFile(path.join(root, 'forge', 'castdraft.json'), JSON.stringify({ ...draft, plan: more, card: { ...card, savedCardId: first.card.id } }))
  await forge.saveCard('castdraft', { avatar: PNG_URL })
  saved = await store.getCard(first.card.id)
  assert.deepEqual(saved.media.roster.map(r => [r.name, r.looks, r.outfit, r.voice]), [
    ['林小雨', 'silver hair', 'white raincoat', 'zh-CN-Xiaoyi'],
    ['王店长', 'old man, glasses', '', ''],
    ['阿青', 'green hair', '', ''],
  ])
  assert.equal(saved.media.style, 'watercolor', 'the rest of 配图 stays')
})

test('数值预览: at given values, the stage each character is in, the events in, the staged entries as rendered', () => {
  const plan = normalizePlan(PLAN)
  const card = newCard(plan)
  for (const entry of card.entries) entry.content = entry.staged ? '底色：孤独\n【阶段：戒备】\n不接伞\n【阶段：试探】\n问你几点下班\n【阶段：依赖】\n等你下班' : `${entry.name}正文`
  const at = values => previewDynamics(plan, card, values, renderTemplate)
  const start = at({})
  assert.deepEqual(start.characters, [{ name: '林小雨', stage: '戒备', main: ['警惕'], accent: [] }])
  assert.deepEqual(start.events.map(e => [e.name, e.on]), [['告白', false], ['晕倒', false], ['店长查岗', true], ['伞', false]])
  assert.match(start.entries.find(e => e.name === '林小雨_性格调色盘').text, /不接伞/)
  // Values come as the sliders send them (numbers, or strings); the rest stay at their start.
  const close = at({ '林小雨.好感度': 85, '主角.体力': '10' })
  assert.equal(close.characters[0].stage, '依赖')
  assert.deepEqual(close.events.filter(e => e.on).map(e => e.name), ['告白', '晕倒', '店长查岗'])
  assert.match(close.entries[0].text, /等你下班/)
  assert.doesNotMatch(close.entries[0].text, /不接伞|<%/)
})
