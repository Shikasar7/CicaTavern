import assert from 'node:assert/strict'
import test from 'node:test'
import { CREATION_TAG, cleanCreation, creationEntry, creationHtml, creationOf, creationOpening, creationScripts, creationText, creationVariables, randomSheet } from '../server/forge/creation.mjs'
import { brickCost, brickEntries } from '../server/forge/bricks.mjs'
import { configureEntries } from '../server/forge/configure.mjs'
import { cleanCardOptions, emptyBrief, normalizePlan, planRequest, withCardOptions } from '../server/forge/prompts.mjs'
import { cardJson, newCard } from '../server/forge/write.mjs'
import { applyScripts } from '../server/regex-guard.mjs'
import { displayText } from '../server/state.mjs'
import { PLACEMENT } from '../web/shared/regex.js'

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
