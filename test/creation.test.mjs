import assert from 'node:assert/strict'
import test from 'node:test'
import { CREATION_TAG, cleanCreation, creationEntry, creationHtml, creationOf, creationOpening, creationScripts, creationText, creationVariables, randomSheet } from '../server/forge/creation.mjs'
import { brickCost, brickEntries } from '../server/forge/bricks.mjs'
import { configureEntries } from '../server/forge/configure.mjs'
import { cleanCardOptions, emptyBrief, normalizePlan, planRequest, withCardOptions } from '../server/forge/prompts.mjs'
import { cardJson, newCard } from '../server/forge/write.mjs'
import { applyScripts } from '../server/regex-guard.mjs'
import { displayText } from '../server/state.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { segments } from '../web/render.js'
import { PLACEMENT, applyScripts as applyOnPage } from '../web/shared/regex.js'
import { isCreationPage } from '../web/shared/vn.js'

const form = {
  intro: '开局前先定几件事。',
  fields: [
    { label: '出身', kind: 'pick', options: ['寒门', '世家', '流民'], note: '决定开局的钱' },
    { label: '属性', kind: 'points', options: ['力量', '智谋'], total: 6 },
    { label: '来历', kind: 'text' },
  ],
}
const creation = cleanCreation(form)
const rawPlan = { name: '卡', user_role: { identity: '领主' }, characters: [{ name: '她', kind: 'core' }], greetings: [{ title: '开场', start: '第一天', scene: '城门口', situation: '有人拦路' }], creation: form }

test('a form keeps what it can show, and nothing that would break a path or a slash command', () => {
  const clean = cleanCreation({ fields: [
    { label: '出|身 ', kind: 'odd', options: ['甲|一', '乙{{x}}', '乙{{x}}'] },
    { label: '只有一项', kind: 'pick', options: ['甲'] },
    { label: '属性', kind: 'points', options: ['力.量', '智谋'], total: 999 },
    { label: '来历', kind: 'text', options: ['丢掉'] },
    { label: '来历', kind: 'text' },
  ] })
  assert.deepEqual(clean.fields.map(field => field.label), ['出身', '属性', '来历'])
  assert.equal(clean.fields[0].kind, 'pick')
  assert.doesNotMatch(clean.fields[0].options.join(), /[|{}]/)
  assert.deepEqual(clean.fields[1].options, ['力量', '智谋'])
  assert.equal(clean.fields[1].total, 40)
  assert.deepEqual(clean.fields[2].options, [])
  assert.equal(cleanCreation(null), null)
})

test('each value gets a variable, and one the plan already keeps is used', () => {
  const kept = cleanCreation({ fields: [{ label: '出身', options: ['甲', '乙'], path: '主角.家世' }, { label: '属性', kind: 'points', options: ['力量', '智谋'], total: 6 }, { label: '来历', kind: 'text' }] })
  const added = creationVariables(kept, '主角', [{ path: '主角.家世' }], false)
  assert.deepEqual(added.map(v => v.path), ['主角.力量', '主角.智谋', '主角.来历'])
  assert.equal(added[0].type, 'number')
  assert.equal(added[0].initial, '0')
  assert.equal(added[2].show, 'text')
})

test('the rule is there for one message only, and says where the story starts', () => {
  const plan = { creation, greetings: rawPlan.greetings }
  const text = creationText(plan, false, '主角')
  assert.match(text, /【建角】开头时有效/)
  assert.match(text, /其余时候这条作废/)
  assert.match(text, /出身 → 主角\.出身/)
  assert.match(text, /力量 → 主角\.力量/)
  assert.match(text, /城门口/)
  const [entry] = configureEntries([creationEntry(plan, false)])
  assert.equal(entry.strategy, 'keyword')
  assert.deepEqual(entry.keywords, ['【建角】'])
})

test('a pick going into a list says to add to it; the player is no 他; the start reads as sentences', () => {
  const plan = { creation: cleanCreation({ fields: [{ label: '第一家', options: ['钟表铺', '杂货铺'], path: '主角.到过的地方' }, { label: '缘由', options: ['找人', '躲债'] }] }), tracking: { variables: [{ path: '主角.到过的地方', type: 'list' }] }, greetings: [{ start: '钟表铺门口。', scene: '雨夜', situation: '她刚到' }] }
  const zh = creationText(plan, false, '主角')
  assert.match(zh, /第一家 → 主角\.到过的地方（这是列表：把值加成其中一项，不要把整个列表换掉）/)
  assert.match(zh, /缘由 → 主角\.缘由\s/, 'not a list: as before')
  assert.match(zh, /从这里开始：钟表铺门口；雨夜；她刚到。玩家选的/)
  assert.doesNotMatch(zh, /替他/)
  assert.match(creationText(plan, true, '主角'), /a list: add the value to it as one more item/)
})

test('it takes up no room between turns', () => {
  const plan = { creation, tracking: { variables: [] } }
  assert.ok(brickEntries(plan, false).some(entry => entry.part === 'creation'))
  assert.equal(brickCost(plan, false).always, 0)
})

test('the page is a whole page, and the model reads none of it', () => {
  const scripts = creationScripts({ creation, tracking: { title: '建角' } }, false)
  const opening = creationOpening(creation, false)
  assert.match(opening, /<CreationPage\/>/)
  const shown = applyScripts(opening, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0 })
  assert.match(shown, /```html\n<!DOCTYPE html>/)
  assert.match(shown, /<body>/)
  assert.equal(applyScripts(opening, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: 0 }).trim(), '开局前先定几件事。')
  assert.equal(displayText(opening).trim(), '开局前先定几件事。')
})

test('nothing in the page reads as a group in a regex replacement', () => {
  assert.doesNotMatch(creationHtml(creation), /\$\d|\$</)
})

test('the page falls back on the page around it, and shows the sheet when it cannot send', () => {
  const html = creationHtml(creation)
  assert.match(html, /parent\.TavernHelper/)
  assert.match(html, /\/send /)
  assert.match(html, /\| \/trigger/)
})

test('a filled form reads as the rule expects, and comes back out of the card for 试玩体检', () => {
  const scripts = creationScripts({ creation, tracking: { title: '' } }, false)
  const spec = creationOf(scripts)
  assert.equal(spec.mark, '【建角】')
  assert.equal('path' in spec.fields[0], false)
  const sheet = randomSheet(spec, () => 0)
  assert.equal(sheet, '【建角】出身：寒门；力量：6；智谋：0；来历：没写')
  assert.equal(creationOf([]), null)
})

test('the card opens on the form, with the written openings behind it', () => {
  const plan = withCardOptions(normalizePlan(rawPlan), cleanCardOptions({ bricks: ['creation'], format: 'mvu-ui' }))
  assert.equal(plan.tracking.enabled, true)
  assert.ok(plan.tracking.variables.some(v => v.path === '主角.出身'))
  const card = newCard(plan)
  card.greetings = [{ title: '开场', text: '第一段开场' }]
  const { data } = cardJson(plan, card)
  assert.ok(data.first_mes.includes(CREATION_TAG))
  assert.deepEqual(data.alternate_greetings.map(text => text.split('\n')[0]), ['第一段开场'])
  assert.ok(data.extensions.regex_scripts.some(script => script.id === 'cicatavern-creation-page'))
  const entry = data.character_book.entries.find(item => (item.comment ?? item.name) === '[开局]建角')
  assert.equal(entry.constant, false)
  assert.deepEqual(entry.keys, ['【建角】'])
})

test('not picked, no form: the planner is not told and the card is as it was', () => {
  assert.doesNotMatch(planRequest([], emptyBrief(), {}, { options: cleanCardOptions({}) }).system, /creation/)
  assert.match(planRequest([], emptyBrief(), {}, { options: cleanCardOptions({ bricks: ['creation'] }) }).system, /creation 字段/)
  const plan = withCardOptions(normalizePlan(rawPlan), cleanCardOptions({}))
  assert.equal(plan.creation, undefined)
})

// 视觉小说模式 (web/vn.js stepsOf) shows HTML after a reply's words only behind 状态; the form is a step instead.
test('in 视觉小说模式 the form is told apart from the opening and from a status bar', () => {
  const plan = withCardOptions(normalizePlan({ ...rawPlan, tracking: { enabled: true, variables: [{ path: '她.好感', label: '好感', type: 'number', initial: '1' }] } }), cleanCardOptions({ bricks: ['creation'], format: 'mvu-ui' }))
  const draft = newCard(plan)
  draft.greetings = [{ title: '开场', text: '第一段开场' }]
  const raw = cardJson(plan, draft)
  const { regexScripts } = normalizeCard(raw)
  const shown = text => segments(applyOnPage(text, regexScripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0, macros: value => value }))
  const opening = shown(raw.data.first_mes)
  assert.deepEqual(opening.map(part => part.kind), ['story', 'html'])
  assert.equal(isCreationPage(opening[0]), false)
  assert.equal(isCreationPage(opening[1]), true)
  const bar = shown('她点了点头。\n\n<StatusPlaceHolderImpl/>')
  assert.equal(bar.at(-1).kind, 'html')
  assert.equal(isCreationPage(bar.at(-1)), false)
  assert.equal(isCreationPage(undefined), false)
})
