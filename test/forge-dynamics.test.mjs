// 创作角色卡: what changes as the story goes. A personality in stages by a
// tracked value, events that come in when named or when a value holds, both put
// under EJS by the code; and the cast written into 配图与朗读 → 角色名册.
import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pictureMark, writeCardPng } from '../server/cards.mjs'
import { createDrawHistory } from '../server/draw-history.mjs'
import { createForge } from '../server/forge/index.mjs'
import { editTracking, eventConditions, normalizePlan, stagesOf } from '../server/forge/prompts.mjs'
import { cardJson, conditionExpression, entriesRequest, greetingState, initialState, newCard, previewDynamics, stagedText, wrapped, writeSteps } from '../server/forge/write.mjs'
import { autoStatusSpec } from '../web/shared/status.js'
import { initTemplates, renderTemplate } from '../server/template.mjs'
import { createStore } from '../server/store.mjs'
import { createApp } from '../server/http.mjs'
import { applyStateUpdates } from '../server/state.mjs'
import { checkCard } from '../server/forge/check.mjs'

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
  assert.equal(text.split('\n')[0], String.raw`@@if getvar("stat_data.林小雨.好感度", { defaults: 10 }) >= 80 && !JSON.stringify(getvar("stat_data.已发生事件", { defaults: [] })).includes("\"告白\"")`)
  const at = (value, done) => renderTemplate(text, { variables: { stat_data: { 林小雨: { 好感度: value }, ...(done ? { 已发生事件: done } : {}) } } }).text.trim()
  assert.equal(at(50), '')
  assert.match(at(85), /^<event name="事件_告白">\n只发生一次：.*\{ "op": "add", "path": "\/已发生事件\/-", "value": "告白" \}.*\n她在关门前说/)
  // Once it is on the list of what happened, it is out for good, whatever the value.
  assert.equal(at(85, ['$__META_EXTENSIBLE__$', '告白']), '')
  assert.equal(at(85, '告白'), '', 'a list written back as one string')
  assert.equal(at(85, { '-': '告白' }), '', 'an add where no list was')
  assert.match(at(85, ['告白之后']), /她在关门前说/, 'another name that starts the same')
  assert.match(at(85, ['$__META_EXTENSIBLE__$', '晕倒']), /她在关门前说/)
  // Conditions together: all of them. One met at the starting values would be there from the first reply: not used.
  const more = normalizePlan({ ...PLAN, events: [
      { name: '开局就成立', when: '好感跌下去', requires: [{ path: '林小雨.好感度', op: '<=', value: '20' }], content: '开局好感是 10，不会写进卡' },
      { name: '久别', when: '体力见底又很亲近', requires: [{ path: '<user>.体力', op: '<', value: '30' }, { path: '林小雨.好感度', op: '>=', value: '60' }], content: '她守了你一夜' },
  ] })
  assert.equal(eventConditions(more, more.events[0]), null)
  assert.deepEqual(more.entries.filter(e => e.type === '事件').map(e => e.name), ['事件_久别'])
  const both = wrapped({ ...more.entries.find(e => e.type === '事件'), content: '她守了你一夜。' }, more)
  assert.equal(both.split('\n')[0], String.raw`@@if getvar("stat_data.主角.体力", { defaults: 80 }) < 30 && getvar("stat_data.林小雨.好感度", { defaults: 10 }) >= 60 && !JSON.stringify(getvar("stat_data.已发生事件", { defaults: [] })).includes("\"久别\"")`)
  const night = (体力, 好感度) => renderTemplate(both, { variables: { stat_data: { 主角: { 体力 }, 林小雨: { 好感度 } } } }).text.trim()
  assert.equal(night(20, 40), '')
  assert.equal(night(50, 80), '')
  assert.match(night(20, 80), /她守了你一夜/)
  // A keyword event without a condition is kept to once all the same.
  assert.equal(wrapped({ ...events[2], content: '他来了' }, plan).split('\n')[0], String.raw`@@if !JSON.stringify(getvar("stat_data.已发生事件", { defaults: [] })).includes("\"店长查岗\"")`)
})

test('events happen once: the list of what happened starts empty, the rules name it, the status bar leaves it out; no variables, words alone', () => {
  const plan = normalizePlan(PLAN)
  // Empty, and able to grow in SillyTavern (MVU refuses additions to a list without the mark).
  assert.deepEqual(initialState(plan).已发生事件, ['$__META_EXTENSIBLE__$'])
  const card = newCard(plan)
  card.greetings[0].text = '雨下起来了。'
  for (const entry of card.entries) if (!entry.content) entry.content = '内容'
  assert.match(card.entries.find(e => e.part === 'initvar').content, /^已发生事件:\n {2}- \$__META_EXTENSIBLE__\$$/m)
  assert.match(card.entries.find(e => e.part === 'rules').content, /已发生事件:\n {4}type: list\n {4}check:\n {6}- 事件条目里的事真正写进故事的那一轮/)
  // An opening with values of its own starts with the list too.
  const own = normalizePlan({ ...PLAN, greetings: [{ title: '第一场雨', state: { '林小雨.好感度': '40' } }] })
  assert.deepEqual(greetingState(own, own.greetings[0]).已发生事件, ['$__META_EXTENSIBLE__$'])
  // Not on the card's bar, nor on one laid out from the variables.
  const json = cardJson(plan, card)
  assert.ok(json.data.extensions.cicatavern.status_bar.fields.every(field => !field.path.includes('已发生事件')))
  assert.ok(autoStatusSpec(initialState(plan)).fields.every(field => !field.path.includes('已发生事件')))
  assert.ok(autoStatusSpec({ ...initialState(plan), 已发生事件: ['告白'] }).fields.every(field => !field.path.includes('已发生事件')))
  // An English card keeps it under its own name.
  const english = normalizePlan(PLAN, { language: 'English' })
  assert.deepEqual(initialState(english).PastEvents, ['$__META_EXTENSIBLE__$'])
  assert.match(wrapped({ ...english.entries.find(e => e.type === '事件'), content: 'x' }, english), /\{ "op": "add", "path": "\/PastEvents\/-", "value": "告白" \}/)
  // No variables: no list, and the event says it in words as before.
  const words = normalizePlan({ ...PLAN, tracking: { enabled: false, variables: [] }, events: [PLAN.events[2]] })
  assert.equal(Object.hasOwn(initialState(words), '已发生事件'), false)
  const keyword = wrapped({ ...words.entries.find(e => e.type === '事件'), content: '他来了' }, words)
  assert.doesNotMatch(keyword, /@@if|已发生事件/)
  assert.match(keyword, /^<event name="事件_店长查岗">\n只发生一次：前文已经写过这件事/)
  // No events: no list either.
  assert.equal(Object.hasOwn(initialState(normalizePlan({ ...PLAN, events: [] })), '已发生事件'), false)
})

test('events happen once in play: a fake model writes one in and puts it on the list, and it is not sent again', t => playEventsOnce(t))

// A chat started before the card kept events by the list (检查这张卡 fixed it later): its state has none. The first add
// starts one; as an object, the second add overwrote the first and that event came back.
test('events happen once in a chat whose state has no list yet: each add keeps the ones before', t => playEventsOnce(t, { withoutList: true }))

async function playEventsOnce(t, { withoutList = false } = {}) {
  const asked = []
  const replies = []
  const model = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    // What this turn sends: the last message (the history keeps earlier turns' entries as they were).
    asked.push(JSON.parse(body).messages.at(-1).content)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: replies.shift() ?? '雨还在下。\n<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'forge-once-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    model.closeAllConnections()
    model.close()
    app.network?.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const provider = await (await send('/api/providers', { name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] })).json()
  await send('/api/settings', { model: `${provider.id}/writer` }, 'PUT')

  const plan = normalizePlan(PLAN)
  const card = newCard(plan)
  card.greetings[0].text = '雨下起来了。'
  const contents = { 事件_告白: '【告白场面】她在关门前说出口。', 事件_店长查岗: '【查岗场面】王店长推门进来。' }
  for (const entry of card.entries) if (!entry.content) entry.content = contents[entry.name] ?? `${entry.name}的内容`
  const json = cardJson(plan, card)
  if (withoutList) {
    const init = json.data.character_book.entries.find(entry => entry.content.includes('已发生事件:'))
    init.content = init.content.replace(/\n?已发生事件:\n {2}- \$__META_EXTENSIBLE__\$/, '')
    assert.doesNotMatch(init.content, /已发生事件/)
  }
  const imported = await (await send('/api/cards/import', { filename: '雨宿.json', data: Buffer.from(JSON.stringify(json)).toString('base64') })).json()
  const chat = await (await send('/api/chats', { cardId: imported.id })).json()
  const turn = async input => {
    const now = await (await fetch(`${base}/api/chats/${chat.id}`)).json()
    assert.match(await (await send(`/api/chats/${chat.id}/turn`, { parentId: now.path.at(-1).id, input })).text(), /"type":"done"/)
    return asked.at(-1)
  }
  const patch = ops => `\n<UpdateVariable>\n<Analysis>x</Analysis>\n<JSONPatch>\n${JSON.stringify(ops)}\n</JSONPatch>\n</UpdateVariable>`

  // Named: 店长查岗 comes in; the model writes it, puts it on the list, and 好感 goes up past 告白's condition.
  replies.push(`王店长推门进来。${patch([{ op: 'add', path: '/已发生事件/-', value: '店长查岗' }, { op: 'replace', path: '/林小雨/好感度', value: 85 }])}`)
  const first = await turn('店长今晚会来吗？')
  assert.match(first, /【查岗场面】/)
  assert.doesNotMatch(first, /【告白场面】/)
  assert.match(first, /\{ "op": "add", "path": "\/已发生事件\/-", "value": "店长查岗" \}/, 'the update to write is spelled out')

  // Named again: not sent. 告白's condition now holds: sent; written without the update, it stays.
  replies.push(`她看着门口。${patch([])}`)
  const second = await turn('店长又来查岗了？')
  assert.doesNotMatch(second, /【查岗场面】/)
  assert.match(second, /【告白场面】/)
  // Nothing changed: the engine sends no new 动态设定, the last one (with 告白) still stands.
  replies.push(`她在关门前说出口。${patch([{ op: 'add', path: '/已发生事件/-', value: '告白' }])}`)
  assert.doesNotMatch(await turn('雨好大。'), /<动态设定>/)

  // On the list now: the value still holds, and the settings sent again leave the event out.
  const fourth = await turn('店长，雨好大。')
  assert.match(fourth, /<动态设定>[\s\S]*已发生事件:/)
  assert.doesNotMatch(fourth, /【告白场面】|【查岗场面】/)
  const after = await (await fetch(`${base}/api/chats/${chat.id}`)).json()
  const state = after.path.at(-1).state
  assert.deepEqual(state.已发生事件.filter(item => !item.startsWith('$')), ['店长查岗', '告白'])
  assert.equal(state.林小雨.好感度, 85)
  assert.equal(asked.length, 4, 'one request a turn')
}

test('the list of what happened, written back other ways: an add where none is, or over one value, starts one with what was there', () => {
  const plan = normalizePlan(PLAN)
  const text = wrapped({ ...plan.entries.find(e => e.name === '事件_店长查岗'), content: '他来了' }, plan)
  const sent = state => renderTemplate(text, { variables: { stat_data: state } }).text.trim() !== ''
  const add = (state, name) => applyStateUpdates(state, `<UpdateVariable><JSONPatch>${JSON.stringify([{ op: 'add', path: '/已发生事件/-', value: name }])}</JSONPatch></UpdateVariable>`).state
  // No list: the first add starts it, the second goes after it.
  const none = add(add({ 林小雨: { 好感度: 85 } }, '店长查岗'), '告白')
  assert.deepEqual(none.已发生事件, ['店长查岗', '告白'])
  assert.equal(sent(none), false)
  // A model that replaced the list with one name: kept, not lost to the next add.
  const one = add(applyStateUpdates({}, `<UpdateVariable><JSONPatch>${JSON.stringify([{ op: 'replace', path: '/已发生事件', value: '店长查岗' }])}</JSONPatch></UpdateVariable>`).state, '告白')
  assert.deepEqual(one.已发生事件, ['店长查岗', '告白'])
  assert.equal(sent(one), false)
  // What an add where none was made before: {"-": name}, its name kept.
  assert.deepEqual(add({ 已发生事件: { '-': '店长查岗' } }, '告白').已发生事件, ['店长查岗', '告白'])
  // An object of its own keeps its keys; a list grows as before.
  assert.deepEqual(add({ 已发生事件: { a: 1 } }, '告白').已发生事件, { a: 1, '-': '告白' })
  assert.deepEqual(add({ 已发生事件: ['$__META_EXTENSIBLE__$'] }, '告白').已发生事件, ['$__META_EXTENSIBLE__$', '告白'])
})

test('a draft whose starting values and rules were filled before events were kept by the list gets the list in both when saved', () => {
  const plan = normalizePlan(PLAN)
  const card = newCard(plan)
  card.greetings[0].text = '雨下起来了。'
  for (const entry of card.entries) if (!entry.content) entry.content = `${entry.name}的内容`
  const init = card.entries.find(e => e.part === 'initvar')
  const rules = card.entries.find(e => e.part === 'rules')
  // As they were written then: no list.
  init.content = init.content.replace(/\n?已发生事件:\n {2}- \$__META_EXTENSIBLE__\$/, '')
  rules.content = rules.content.replace(/\n {2}已发生事件:\n {4}type: list\n {4}check:\n {6}- .*/, '')
  assert.doesNotMatch(init.content + rules.content, /已发生事件/)
  const json = cardJson(plan, card)
  const book = json.data.character_book.entries
  const saved = book.find(entry => /^林小雨:/m.test(entry.content) && /^已发生事件:/m.test(entry.content))
  assert.ok(saved, 'the starting values have the list')
  assert.match(saved.content, /^已发生事件:\n {2}- \$__META_EXTENSIBLE__\$$/m)
  assert.match(saved.content, /^林小雨:\n {2}好感度: 10/m, 'the rest as it was')
  assert.ok(book.some(entry => /已发生事件:\n {4}type: list\n {4}check:/.test(entry.content)), 'the rules name it')
  // 检查这张卡 finds no rule without a starting value, and nothing to change about events.
  const found = checkCard(json.data).map(f => f.rule)
  assert.ok(!found.includes('rule-path-missing') && !found.includes('event-once'), found.join())
  // A draft written now has it once; one without events or variables gets none.
  const fresh = newCard(plan)
  for (const entry of fresh.entries) if (!entry.content) entry.content = `${entry.name}的内容`
  fresh.greetings[0].text = '雨下起来了。'
  const freshBook = cardJson(plan, fresh).data.character_book.entries.map(e => e.content).join('\n')
  assert.equal(freshBook.match(/^ *已发生事件:/gm).length, 2, 'once in the starting values, once in the rules')
  const quiet = normalizePlan({ ...PLAN, events: [] })
  const plain = newCard(quiet)
  for (const entry of plain.entries) if (!entry.content) entry.content = `${entry.name}的内容`
  plain.greetings[0].text = '雨下起来了。'
  assert.doesNotMatch(JSON.stringify(cardJson(quiet, plain)), /已发生事件/)
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

test('the cast goes into 配图与朗读 → 角色名册; saved again, someone new is added and what was set there stays', async t => {
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

test('更新这张卡 after the saved card was edited elsewhere: the page is asked first; 配图 alone does not count', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-elsewhere-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const forge = createForge(store)
  const plan = normalizePlan(PLAN)
  const card = { ...newCard(plan), writtenAt: new Date().toISOString() }
  card.greetings[0].text = '雨下起来了。'
  const now = new Date().toISOString()
  const draft = { id: 'elsewhere', createdAt: now, updatedAt: now, stage: 'polish', model: '', rounds: [{ user: { text: '雨夜', picks: [] }, assistant: null }], brief: { title: '雨宿', readiness: 80, items: [], open: [] }, plan, card, job: null, error: null }
  await mkdir(path.join(root, 'forge'), { recursive: true })
  await writeFile(path.join(root, 'forge', 'elsewhere.json'), JSON.stringify(draft))

  const { card: { id } } = await forge.saveCard('elsewhere', { avatar: PNG_URL })
  assert.equal((await forge.saveCard('elsewhere', { avatar: PNG_URL, ask: true })).updated, true, 'nothing changed elsewhere: saved without asking')
  const inMedia = await store.getCard(id)
  inMedia.media.style = 'watercolor'
  await store.saveCard(inMedia)
  assert.equal((await forge.saveCard('elsewhere', { avatar: PNG_URL, ask: true })).updated, true, '配图 is kept by the save, so not asked about')

  // As 去修改这张卡 from 试玩体检 does: the saved card, not the draft.
  const edited = await store.getCard(id)
  edited.description = '在修改角色卡里改的描述'
  await store.saveCard(edited)
  const asked = await forge.saveCard('elsewhere', { avatar: PNG_URL, ask: true })
  assert.equal(asked.changedElsewhere, true)
  assert.equal(asked.card.id, id)
  assert.equal((await store.getCard(id)).description, '在修改角色卡里改的描述', 'nothing saved while asking')
  // Confirmed: the draft goes over it, and the next save has nothing to ask about.
  await forge.saveCard('elsewhere', { avatar: PNG_URL })
  assert.notEqual((await store.getCard(id)).description, '在修改角色卡里改的描述')
  assert.equal((await forge.saveCard('elsewhere', { avatar: PNG_URL, ask: true })).changedElsewhere, undefined)
  // A draft saved before the mark was kept cannot tell: saved as before.
  await writeFile(path.join(root, 'forge', 'elsewhere.json'), JSON.stringify({ ...draft, card: { ...card, savedCardId: id } }))
  assert.equal((await forge.saveCard('elsewhere', { avatar: PNG_URL, ask: true })).updated, true)
})

test('更新这张卡 after the picture was changed elsewhere: asked first, and the one it replaces goes into 抽图历史', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-picture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const history = createDrawHistory(store, { keep: async () => 5 })
  const forge = createForge(store, { history })
  const plan = normalizePlan(PLAN)
  const card = { ...newCard(plan), writtenAt: new Date().toISOString() }
  card.greetings[0].text = '雨下起来了。'
  const now = new Date().toISOString()
  const draft = { id: 'picture', createdAt: now, updatedAt: now, stage: 'polish', model: '', rounds: [{ user: { text: '雨夜', picks: [] }, assistant: null }], brief: { title: '雨宿', readiness: 80, items: [], open: [] }, plan, card, job: null, error: null }
  await mkdir(path.join(root, 'forge'), { recursive: true })
  await writeFile(path.join(root, 'forge', 'picture.json'), JSON.stringify(draft))
  const { card: { id } } = await forge.saveCard('picture', { avatar: PNG_URL })
  const avatarFile = store.avatarPath(id)

  // The card text in the picture rewritten (any edit of the card does that), the picture the same: not asked.
  await writeFile(avatarFile, writeCardPng(await readFile(avatarFile), { name: 'rewritten' }))
  assert.equal((await forge.saveCard('picture', { avatar: PNG_URL, ask: true })).updated, true)

  // As 修改角色卡 → 上传图片 / 生成头像 does (PUT /api/cards/:id/avatar): a new picture.
  const other = writeCardPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M9Qz0AEYBxVSF0BAD7FAv9wO3m3AAAAAElFTkSuQmCC', 'base64'), { name: 'elsewhere' })
  await writeFile(avatarFile, other)
  const asked = await forge.saveCard('picture', { avatar: PNG_URL, ask: true })
  assert.equal(asked.changedElsewhere, true)
  assert.equal(asked.pictureChanged, true)
  assert.ok((await readFile(avatarFile)).equals(other), 'nothing saved while asking')
  assert.deepEqual((await history.list(id)).slots, {})

  // Confirmed: the draft's picture goes back, the one set elsewhere is kept in 抽图历史.
  await forge.saveCard('picture', { avatar: PNG_URL })
  assert.equal(pictureMark(await readFile(avatarFile)), pictureMark(PNG))
  const kept = (await history.list(id)).slots.avatar
  assert.equal(kept.length, 1)
  assert.equal(pictureMark((await history.readPicture(id, kept[0].file)).data), pictureMark(other))
  // Nothing changed since: not asked, nothing more kept.
  assert.equal((await forge.saveCard('picture', { avatar: PNG_URL, ask: true })).changedElsewhere, undefined)
  assert.equal((await history.list(id)).slots.avatar.length, 1)
  // The author, which 修改角色卡 edits too and the save writes over.
  const edited = await store.getCard(id)
  edited.creator = '我自己'
  await store.saveCard(edited)
  const byAuthor = await forge.saveCard('picture', { avatar: PNG_URL, ask: true })
  assert.equal(byAuthor.changedElsewhere, true)
  assert.equal(byAuthor.pictureChanged, false)
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
