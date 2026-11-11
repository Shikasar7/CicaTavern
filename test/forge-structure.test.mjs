import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCard } from '../server/cards.mjs'
import { asMaterial, cleanReferences, creditsOf, fileReference, keptMaterial, MAX_REFERENCE_CHARS, readMaterial, readReference, referenceBlock, referenceRules, referenceView, studying, withMode, writingMaterial } from '../server/forge/references.mjs'
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

test('a card that cannot be read as one is turned away, not read as text', () => {
  const whole = JSON.stringify(raw)
  const nameless = { ...raw, data: { ...raw.data, name: '' } }
  const cases = {
    'cut short': { name: 'a.json', text: whole.slice(0, -5) },
    'a comma missing': { name: 'a.json', text: whole.replace('"spec_version"', ' "spec_version"').replace('",', '"') },
    'cut before the spec is any use': { name: 'a.json', text: `{"name":"别人的卡","first_mes":"${SECRET}` },
    'named as text': { name: 'a.txt', text: whole.slice(0, -5) },
    'a note before it': { name: 'a.txt', text: `我的卡：\n${whole.slice(0, -5)}` },
    'in a code block': { name: 'a.md', text: `\`\`\`json\n${whole}\n\`\`\`` },
    'no name': { name: 'a.json', text: JSON.stringify(nameless) },
    'in a list': { name: 'a.json', text: `[${whole}]` },
    'inside something else': { name: 'a.json', text: JSON.stringify({ cards: [raw.data] }) },
    'own format, incomplete': { name: 'a.json', text: JSON.stringify({ format: 'agent-tavern-card', card: { description: SECRET } }) },
    'own format, broken': { name: 'a.json', text: `{"format":"agent-tavern-card","card":{"name":"别人的卡","firstMes":"${SECRET}` },
    'as yaml': { name: 'a.yaml', text: `name: 别人的卡\nfirst_mes: ${SECRET}\nmes_example: ${SECRET}\n` },
    'its fields past what is kept': { name: 'a.json', text: `{"name":"别人的卡","description":"${'长'.repeat(MAX_REFERENCE_CHARS + 10)}","first_mes":"${SECRET}` },
  }
  for (const [label, body] of Object.entries(cases)) {
    assert.throws(() => readMaterial(body), error => error.status === 400 && /看起来是角色卡/.test(error.message), label)
  }
})

// The order SillyTavern writes: the plain fields first, spec and data far below.
const exported = {
  name: '别人的卡', description: `${SECRET}的设定`, personality: `${SECRET}的性格`, scenario: `${SECRET}的场景`, first_mes: `${SECRET}走进来。`, mes_example: '',
  creatorcomment: '', avatar: 'none', chat: '别人的卡 - 2026', talkativeness: 0.5, fav: false, tags: [], spec: 'chara_card_v2', spec_version: '2.0', data: raw.data,
}

test('a card cut short gives the model nothing, wherever the cut falls', () => {
  for (const whole of [JSON.stringify(exported), JSON.stringify(exported, null, 4), JSON.stringify({ data: exported })]) {
    for (let end = whole.indexOf(SECRET) + 1; end < whole.length; end++) {
      const body = { name: 'a.json', text: whole.slice(0, end) }
      assert.throws(() => readMaterial(body), error => error.status === 400 && /看起来是角色卡/.test(error.message), whole.slice(end - 20, end))
    }
  }
})

test('a card in a workspace shell cut short gives the model nothing either', () => {
  const shells = [
    { kind: 'workspace', version: 1, raw: exported, meta: { note: '' } },
    { version: 1, kind: 'workspace', raw: exported },
    { kind: 'workspace', meta: { raw: { saved: 1 }, tags: ['甲'] }, raw: exported },
    { raw: exported, kind: 'workspace' },
    { kind: 'workspace', version: 1, raw: { data: exported } },
  ]
  for (const shell of shells) {
    assert.equal(readMaterial({ name: 'a.json', text: JSON.stringify(shell) }).kind, 'card', 'whole, it is a card')
    for (const whole of [JSON.stringify(shell), JSON.stringify(shell, null, 2), JSON.stringify(shell, null, 2).replace(/\n/g, '\r\n')]) {
      for (let end = whole.indexOf(SECRET) + 1; end < whole.length; end++) {
        const body = { name: 'a.json', text: whole.slice(0, end) }
        assert.throws(() => readMaterial(body), error => error.status === 400 && /看起来是角色卡/.test(error.message), whole.slice(end - 20, end))
      }
    }
  }
  const broken = `{"kind":"card","raw":{"name":"别人的卡","description":"${SECRET}`
  assert.throws(() => readMaterial({ name: 'a.json', text: '{"kind":"card","version":1,"raw":{"name":"X","description":"D","personality":"P' }), /看起来是角色卡/)
  assert.throws(() => readMaterial({ name: 'a.txt', text: broken }), /看起来是角色卡/, 'the file name does not matter')
  assert.throws(() => keptMaterial([{ kind: 'file', name: 'a.json', text: broken }]), /看起来是角色卡/)
})

test('a raw that holds no card is still only a broken file', () => {
  const cases = {
    'a shell with something else in it': `{"kind":"server","version":1,"raw":{"host":"a","port":1,`,
    'one field in common': `{"kind":"log","raw":{"name":"甲","level":1,"text":"${SECRET}`,
    'two, then something else': `{"kind":"item","raw":{"name":"甲","description":"乙","price":1,"text":"${SECRET}`,
    'the words in a value': `{"title":"写 \\"raw\\": {\\"name\\":\\"甲\\",\\"description\\":\\"乙\\"} 这样","text":"${SECRET}`,
    'raw that is not an object': `{"kind":"note","raw":"name description","text":"${SECRET}`,
  }
  for (const [label, text] of Object.entries(cases)) {
    const reference = readMaterial({ name: '设定.json', text })
    assert.equal(reference.kind, 'file', label)
    assert.equal(reference.text, text, label)
  }
})

test('a card that has only its plain fields is one too', () => {
  // Whole and readable, it is a card to learn from, not a broken file: its text stays out all the same.
  const whole = readMaterial({ name: 'a.json', text: JSON.stringify({ name: '别人的卡', personality: SECRET, scenario: SECRET }) })
  assert.deepEqual([whole.kind, whole.mode], ['card', 'structure'])
  assert.equal(readMaterial({ name: '学院.json', text: JSON.stringify({ name: '学院', scenario: SECRET, rooms: ['甲'] }) }).kind, 'card')
  const cases = {
    'cut in the personality': `{"name":"别人的卡","personality":"${SECRET}`,
    'no name': `{"description":"${SECRET}","personality":"${SECRET}`,
    'another field after them': `{"name":"别人的卡","description":"${SECRET}","personality":"${SECRET}","scenario":"${SECRET}","tags":[`,
    'what looks like a key in a value': `{"name":"别人的卡","description":"写 \\"rooms\\": 这样的词","personality":"${SECRET}`,
  }
  for (const [label, text] of Object.entries(cases)) {
    assert.throws(() => readMaterial({ name: 'a.json', text }), error => error.status === 400 && /看起来是角色卡/.test(error.message), label)
  }
  assert.throws(() => readMaterial({ name: 'a.txt', text: `{\n  "name": "别人的卡",\n  "description": "${SECRET}` }), /看起来是角色卡/)
})

test('what the page kept goes through the same door', () => {
  const broken = JSON.stringify(raw).slice(0, -5)
  assert.throws(() => keptMaterial([{ kind: 'file', name: 'a.json', text: broken }]), /看起来是角色卡/)
  // A long settings file that is not whole: taken as text when attached (all of it was looked at), and kept as text,
  // though what a reference keeps of it ends inside its second field.
  const long = `{"name":"世界","description":"${'设定'.repeat(35000)}","rooms":[{"a":1},],"x":1}`
  const attached = readMaterial({ name: '世界.json', text: long })
  assert.equal(attached.kind, 'file')
  assert.ok(attached.total > attached.chars)
  assert.deepEqual(keptMaterial([attached]).map(item => item.kind), ['file'])
  // Short enough to be kept whole, a file that opens as a card and breaks off is still refused.
  assert.throws(() => keptMaterial([{ kind: 'file', name: 'a.json', text: '{"name":"别人的卡","description":"x' }]), /看起来是角色卡/)
  const [card] = keptMaterial([asMaterial(fileReference({ name: 'a.json', text: JSON.stringify(raw) }))])
  assert.equal(card.mode, 'structure')
  assert.deepEqual(keptMaterial([{ kind: 'file', name: '设定.txt', text: '学院设定' }]).map(item => item.kind), ['file'])
})

test('a file that only looks broken, or only talks about cards, is still read as text', () => {
  const read = body => readMaterial(body)
  const settings = read({ name: '设定.json', text: `{"name":"学院","description":"${SECRET}","rooms":["甲",` })
  assert.equal(settings.kind, 'file')
  assert.match(referenceBlock([settings]), new RegExp(SECRET))
  const book = read({ name: 'book.json', text: '{"entries":{"0":{"uid":0,"key":["学院"],"comment":"学院","content":"设定",' })
  assert.equal(book.kind, 'file')
  assert.equal(read({ name: '笔记.md', text: '开场白存在 first_mes 字段里，世界书存在 character_book 里。写卡时先想好开场。' }).kind, 'file')
  assert.equal(read({ name: '笔记.md', text: '字段 first_mes: 就是开场白。' }).kind, 'file')
  assert.equal(read({ name: '小说.txt', text: '{第一章} 她说：spec 这个词我不懂。' }).kind, 'file')
  assert.equal(read({ name: 'list.json', text: JSON.stringify({ tip: '开场白写在 first_mes: 里' }) }).kind, 'file')
  const person = `{"name":"林雪","description":"${SECRET}","personality":"话少","scenario":"雨夜"}`
  for (const text of [
    `{"characters":[${person},${person}`,
    `[${person},${person}`,
    `[{"name":"村庄","description":"${SECRET}"},{"name":"城堡","description":"石头"`,
    `{"name":"村庄","description":"${SECRET}"},{"name":"城堡","description":"石头"`,
    `{"name":"学院","tip":"写 \\"personality\\": 和 \\"scenario\\": 都行","rooms":[`,
    `{"地点":"学院","name":"${SECRET}","description":"很大`,
    '{"name":"学院"',
  ]) assert.equal(read({ name: '设定.json', text }).kind, 'file', text)
})

test('a whole card or book is read as it always was', () => {
  assert.equal(readMaterial({ name: 'a.json', text: JSON.stringify(raw) }).mode, 'structure')
  const book = readMaterial({ name: 'b.json', text: JSON.stringify({ entries: { 0: { uid: 0, key: ['词'], comment: '条', content: '设定' } } }) })
  assert.equal(book.kind, 'book')
})

test('修改角色卡 still reads a broken card as the text it is', () => {
  for (const text of [JSON.stringify(raw).slice(0, -5), JSON.stringify(exported).split('"first_mes"')[0]]) {
    const reference = readReference({ name: 'a.json', text })
    assert.equal(reference.kind, 'file')
    assert.match(referenceBlock([reference]), new RegExp(SECRET))
  }
})

/** A PNG with one text chunk, or with `chunks` as given. */
function png(payload, chunks) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    return out
  }
  const text = chunks ?? chunk('tEXt', Buffer.from(`chara\0${payload}`, 'latin1'))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), text, chunk('IEND', Buffer.alloc(0))])
}
const inPicture = bytes => ({ filename: 'a.png', data: bytes.toString('base64') })
const encoded = text => Buffer.from(text).toString('base64')

test('a card PNG with damaged data says so, everywhere, and gives the model nothing', () => {
  const good = inPicture(png(encoded(JSON.stringify(raw))))
  assert.equal(readMaterial(good).mode, 'structure')
  const damaged = {
    'not base64': inPicture(png('!!!')),
    'JSON cut short': inPicture(png(encoded(JSON.stringify(raw).slice(0, -5)))),
    'the file cut short': inPicture(png(encoded(JSON.stringify(raw))).subarray(0, 60)),
  }
  for (const [label, body] of Object.entries(damaged)) {
    for (const read of [readMaterial, readReference]) {
      assert.throws(() => read(body), error => error.status === 400 && /PNG 里的角色卡数据损坏了/.test(error.message), label)
    }
  }
  assert.throws(() => readMaterial(inPicture(png(encoded('[1,2]')))), error => error.status === 400)
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
