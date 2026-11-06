import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCard } from '../server/cards.mjs'
import { asMaterial, cleanReferences, creditsOf, fileReference, referenceBlock, referenceRules, referenceView, studying, withMode, writingMaterial } from '../server/forge/references.mjs'
import { cardStructure, creditText, structureText } from '../server/forge/structure.mjs'
import { cleanCardOptions, discussRequest, emptyBrief, normalizePlan, planRequest, withCardOptions } from '../server/forge/prompts.mjs'
import { cardJson, entriesRequest, newCard } from '../server/forge/write.mjs'

const SECRET = '绝密的人物林晚秋'
const raw = {
  spec: 'chara_card_v3', spec_version: '3.0',
  data: {
    name: '别人的卡', creator: '原作者甲', creator_notes: '禁止二传', description: `${SECRET}的设定`, first_mes: `${SECRET}走进来。`,
    extensions: {
      regex_scripts: [
        { id: 'a', scriptName: '抽事件', findRegex: '/\\[EVENT\\]/g', replaceString: '{{random::甲::乙}}', placement: [5], promptOnly: true, disabled: false, markdownOnly: false },
        { id: 'b', scriptName: '藏自查', findRegex: '/<self_check>[\\s\\S]*?<\\/self_check>/g', replaceString: '', placement: [2], promptOnly: true, disabled: false, markdownOnly: false },
      ],
    },
    character_book: { entries: [
      { uid: 0, keys: [], comment: '[InitVar]', content: `主角:\n  钱: 10\n  背包:\n    $meta:\n      extensible: true\n    ${SECRET}: 1\n`, constant: false, enabled: false },
      { uid: 1, keys: [], comment: '[mvu_update]变量更新规则', content: '每次回复写 <UpdateVariable>', constant: true, enabled: true },
      { uid: 2, keys: [], comment: '规则', content: '每次回复写 <self_check>\n查\n</self_check>', constant: true, enabled: true },
      { uid: 3, keys: [SECRET], comment: SECRET, content: `${SECRET}的故事`, constant: false, enabled: true },
    ] },
  },
}
const card = normalizeCard(raw)

test('the structure says what a card is built of', () => {
  const structure = cardStructure(card)
  assert.equal(structure.title, '别人的卡')
  assert.equal(structure.author, '原作者甲')
  assert.equal(structure.format, 'mvu')
  assert.deepEqual(structure.entries, { total: 3, always: 2, keyword: 1 })
  assert.equal(structure.values.book, 1)
  assert.equal(structure.values.number, 1)
  assert.deepEqual(structure.bricks, ['books', 'selfcheck', 'events'])
})

test('size and form show in what is picked', () => {
  const many = n => ({ ...card, book: { ...card.book, entries: Array.from({ length: n }, (_, i) => ({ uid: String(i), comment: `条目 ${i}`, content: '内容', keys: ['词'], enabled: true, constant: false })) } })
  assert.equal(cardStructure(many(10)).scale, '')
  assert.equal(cardStructure(many(40)).scale, 'standard')
  assert.equal(cardStructure(many(100)).scale, 'epic')
  const form = normalizeCard({ ...raw, data: { ...raw.data, first_mes: '<form><input></form>' } })
  assert.ok(cardStructure(form).bricks.includes('creation'))
})

test('not a word of the card reaches the model while it is only learned from', () => {
  const reference = asMaterial(fileReference({ name: `${SECRET}.json`, text: JSON.stringify(raw) }))
  assert.equal(reference.mode, 'structure')
  assert.ok(studying(reference))
  const block = referenceBlock([reference])
  assert.doesNotMatch(block, new RegExp(SECRET))
  assert.doesNotMatch(block, /原作者甲|禁止二传|别人的卡/)
  assert.match(block, /世界书 3 条/)
  assert.match(block, /能增能减的册子/)
  assert.equal(structureText(reference.structure).includes(SECRET), false)
})

test('the page sees whose it is; the writing steps get none of it', () => {
  const reference = asMaterial(fileReference({ name: 'a.json', text: JSON.stringify(raw) }))
  const view = referenceView(reference)
  assert.equal(view.mode, 'structure')
  assert.equal(view.structure.author, '原作者甲')
  assert.equal(view.text, undefined)
  assert.deepEqual(writingMaterial([reference]), [])
  const plan = withCardOptions(normalizePlan({ name: '卡', user_role: { identity: '学生' }, characters: [{ name: '她', kind: 'core' }] }), cleanCardOptions({}))
  const request = entriesRequest(plan, [plan.entries[0]], [], [reference])
  assert.doesNotMatch(JSON.stringify(request), new RegExp(SECRET))
  assert.doesNotMatch(JSON.stringify(request), /角色卡结构/)
})

test('the guide is told to learn the shape, and where the way to the text is', () => {
  const reference = asMaterial(fileReference({ name: 'a.json', text: JSON.stringify(raw) }))
  const talk = discussRequest([], emptyBrief(), { card: '简体中文', reply: '简体中文' }, { references: [reference] })
  assert.match(talk.system, /不要猜原卡写了什么/)
  assert.match(talk.system, /使用原文/)
  assert.doesNotMatch(talk.system, /照着它写/)
  assert.match(planRequest([], emptyBrief(), {}, { references: [reference] }).system, /人物、世界和文字都是新的/)
})

test('other material is read as it always was, and rules go by what is there', () => {
  const file = asMaterial(fileReference({ name: 'a.txt', text: '一段小说' }))
  assert.equal(file.mode, undefined)
  assert.match(referenceBlock([file]), /一段小说/)
  assert.equal(referenceRules([file], '内容规则', '结构规则'), '内容规则')
  const reference = asMaterial(fileReference({ name: 'a.json', text: JSON.stringify(raw) }))
  assert.equal(referenceRules([reference], '内容规则', '结构规则'), '结构规则')
  assert.equal(referenceRules([file, reference], '内容规则', '结构规则'), '内容规则结构规则')
  assert.equal(referenceRules([], '内容规则', '结构规则'), '')
})

test('修改角色卡 and 直连对话 read a card as before: only 创作角色卡 sets the mode', () => {
  const reference = fileReference({ name: 'a.json', text: JSON.stringify(raw) })
  assert.equal(reference.mode, undefined)
  assert.match(referenceBlock([reference]), new RegExp(SECRET))
  assert.deepEqual(writingMaterial([reference]), [reference])
})

test('the text opens only on the word that the author allows it', () => {
  const reference = asMaterial(fileReference({ name: 'a.json', text: JSON.stringify(raw) }))
  assert.throws(() => withMode(reference, { mode: 'content' }), /确认原作者/)
  assert.throws(() => withMode({ kind: 'file' }, { mode: 'content', confirmed: true }), /角色卡/)
  const open = withMode(reference, { mode: 'content', confirmed: true })
  assert.match(referenceBlock([open]), new RegExp(SECRET))
  assert.deepEqual(creditsOf([open]), [{ title: '别人的卡', author: '原作者甲' }])
  assert.equal(withMode(open, { mode: 'structure' }).mode, 'structure')
})

test('a page cannot open a card by saying so at the start', () => {
  const reference = fileReference({ name: 'a.json', text: JSON.stringify(raw) })
  const kept = cleanReferences([{ ...reference, mode: 'content' }]).map(asMaterial)
  assert.equal(kept[0].mode, 'structure')
  const confirmed = cleanReferences([{ ...reference, mode: 'content', confirmed: true }]).map(asMaterial)
  assert.equal(confirmed[0].mode, 'content')
})

const plan = () => withCardOptions(normalizePlan({ name: '新卡', summary: '简介', user_role: { identity: '学生' }, characters: [{ name: '她', kind: 'core' }] }), cleanCardOptions({}))

test('a card that used another: the player is its author, and its notes say where it came from', () => {
  const made = plan()
  const { data } = cardJson(made, newCard(made), { author: '小明', credits: [{ title: '别人的卡', author: '原作者甲' }, { title: '无名卡', author: '' }] })
  assert.equal(data.creator, '小明')
  assert.deepEqual(data.tags, [])
  assert.doesNotMatch(data.creator_notes, /CicaTavern/)
  assert.match(data.creator_notes, /《别人的卡》，原作者：原作者甲/)
  assert.match(data.creator_notes, /《无名卡》，原作者：原卡未注明/)
  assert.match(data.creator_notes, /相关权利归原作者所有/)
  assert.ok(data.creator_notes.endsWith(creditText([{ title: '别人的卡', author: '原作者甲' }, { title: '无名卡', author: '' }], false)))
})

test('with the default name the author stays empty, not 你', () => {
  const made = plan()
  assert.equal(cardJson(made, newCard(made), { author: '你', credits: [{ title: '卡', author: '' }] }).data.creator, '')
})

test('a card that used nothing is signed as it always was', () => {
  const made = plan()
  const { data } = cardJson(made, newCard(made), { author: '小明' })
  assert.equal(data.creator, '小明 + CicaTavern')
  assert.deepEqual(data.tags, ['CicaTavern'])
  assert.match(data.creator_notes, /CicaTavern/)
})
