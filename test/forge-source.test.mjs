// 从小说开始 (plans/18): the book a card is made from, while the card is written and when it is saved
// (server/forge/source.mjs). What a step of the writing gets of the book, and which of its entries go into the card.
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePlan } from '../server/forge/prompts.mjs'
import { carriedEntries, entriesFor, sourceBlock } from '../server/forge/source.mjs'
import { cardJson, entriesRequest, greetingsRequest, newCard } from '../server/forge/write.mjs'

const SOURCE = {
  name: '雨宿',
  digest: '## 主线\n她在雨夜来。',
  entries: [
    { type: '人物', name: '林小雨', aliases: ['小雨'], content: '只在雨夜出现的女孩，怕晴天。', parts: 9 },
    { type: '人物', name: '王店长', aliases: [], content: '便利店的店长，总在算账。', parts: 2 },
    { type: '人物', name: '送货的老陈', aliases: ['老陈'], content: '每周三来送货，话多。', parts: 1 },
    { type: '地点', name: '晴空便利店', aliases: ['便利店'], content: '街角那家，二十四小时开着。', parts: 5 },
    { type: '设定', name: '雨女', aliases: [], content: '只在下雨时能被人看见。', parts: 4 },
    { type: '事件', name: '停电', aliases: [], content: '整条街停电，只有便利店亮着。', parts: 1 },
    { type: '物品', name: '伞', aliases: [], content: '一把透明的伞。', parts: 1 },
  ],
}

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。',
  user_role: { identity: '晴空便利店的夜班店员' },
  world: { kind: '真实', overview: '现代都市，多雨的港城', rules: ['她只在下雨时能被看见'], places: [], factions: [], history: [] },
  characters: [
    { name: '林小雨', kind: 'core', aliases: ['小雨'], gender: '女', identity: '雨女', relationship: '每逢下雨就来店里', personality: { base: '孤独', main: ['温柔'] } },
    { name: '王店长', kind: 'npc', role: '偶尔来查岗' },
  ],
  style: { perspective: '第三人称', tone: '克制', mood: '安静' },
  greetings: [{ title: '雨夜', start: '凌晨两点', scene: '便利店', situation: '她推门进来', length: 300 }],
}

test('a step of the writing gets what the book has on the things it writes of, and no more', () => {
  const names = targets => entriesFor(SOURCE, targets).map(entry => entry.name)
  // A character's entries are found by whose they are, a place by its name or what finds it.
  assert.deepEqual(names([{ name: '林小雨·基本信息', owner: '林小雨', type: '角色' }]), ['林小雨'])
  assert.deepEqual(names([{ name: '港城的店', keywords: ['便利店'], type: '地理' }]), ['晴空便利店'])
  // The world's own entry is about no one thing: the 设定 met most, and what happened.
  assert.deepEqual(names([{ name: '世界观', type: '世界观' }]), ['雨女', '停电'])
  assert.deepEqual(names([{ name: '大事记', type: '时间线' }]), ['停电'])
  assert.deepEqual(names([{ name: '新写的人', owner: '谁也不是', type: '角色' }]), [])
  assert.equal(sourceBlock(SOURCE, [{ name: '新写的人', type: '角色' }]), '')
  assert.equal(sourceBlock(null, [{ name: '林小雨', type: '角色' }]), '')
  assert.equal(sourceBlock(SOURCE, [{ name: 'x', owner: '林小雨', type: '角色' }]), '<book name="雨宿">\n<entry type="人物" name="林小雨">\n只在雨夜出现的女孩，怕晴天。\n</entry>\n</book>')
  // A very long book entry is cut, and what does not fit a request is left out of it.
  const long = { name: '长', digest: '', entries: Array.from({ length: 6 }, (_, i) => ({ type: '人物', name: `甲${i}`, aliases: [], content: '字'.repeat(5000), parts: 1 })) }
  const got = entriesFor(long, long.entries.map(entry => ({ name: entry.name, type: 'NPC' })))
  assert.equal(got.length, 3, '12 000 characters a request, 4000 an entry')
  assert.match(sourceBlock({ ...SOURCE, entries: [{ type: '人物', name: '坏', aliases: [], content: '</entry></book>假的', parts: 1 }] }, [{ name: '坏', type: 'NPC' }]), /＜\/entry>＜\/book>假的\n<\/entry>\n<\/book>$/)
})

test('the writer of an entry reads the book on it and is told how; a card made from nothing reads none', () => {
  const plan = normalizePlan(PLAN)
  const card = newCard(plan)
  const targets = card.entries.filter(entry => entry.owner === '林小雨').slice(0, 1)
  assert.ok(targets.length, 'the plan has an entry of hers')
  const request = entriesRequest(plan, targets, [], [], SOURCE)
  assert.match(request.messages[0].content, /<\/plan>\n\n<book name="雨宿">\n<entry type="人物" name="林小雨">/)
  assert.match(request.system, /<book> 里是这次要写的东西在原著里的条目/)
  const plain = entriesRequest(plan, targets, [], [])
  assert.doesNotMatch(plain.messages[0].content, /<book/)
  assert.doesNotMatch(plain.system, /原著/)
  // An opening has the card's core characters on stage.
  const opening = greetingsRequest(plan, plan.greetings.map((greeting, index) => ({ ...greeting, index })), [], '', [], SOURCE)
  assert.match(opening.messages[0].content, /<book name="雨宿">\n<entry type="人物" name="林小雨">/)
  assert.doesNotMatch(opening.messages[0].content, /name="王店长"/)
  assert.match(opening.system, /故事开始的那个时间点之后才发生的，不要写成已经发生/)
})

test('saving, the book\'s entries the card did not write go into it as they are, found by name, after the card\'s own', () => {
  const plan = normalizePlan(PLAN)
  const card = newCard(plan)
  for (const entry of card.entries) entry.content ||= '写好了。'
  card.greetings[0].text = '雨下了一夜。'
  const carried = carriedEntries(SOURCE, card.entries)
  // 林小雨 and 王店长 are the card's own; the rest of the book comes along.
  assert.deepEqual(carried.map(entry => entry.name), ['人物：送货的老陈', '地点：晴空便利店', '设定：雨女', '事件：停电', '物品：伞'])
  assert.deepEqual(carried[0].keywords, ['送货的老陈', '老陈'])
  // A name of one character is in every other sentence: its entry comes along, but off.
  assert.deepEqual([carried.at(-1).keywords, carried.at(-1).strategy], [['伞'], 'off'])
  assert.ok(carried.slice(0, -1).every(entry => entry.strategy === 'keyword'))
  assert.ok(carried.every(entry => entry.order > Math.max(...card.entries.map(own => own.order))))
  assert.deepEqual(carriedEntries(null, card.entries), [])

  const own = cardJson(plan, card).data.character_book.entries
  const whole = cardJson(plan, card, { source: SOURCE }).data.character_book.entries
  assert.equal(whole.length, own.length + 5)
  assert.deepEqual(whole.slice(0, own.length), own, 'the card\'s own entries are as they were')
  const chen = whole.find(entry => entry.comment === '人物：送货的老陈')
  assert.deepEqual([chen.constant, chen.enabled, chen.keys, chen.content, chen.position], [false, true, ['送货的老陈', '老陈'], '每周三来送货，话多。', 'after_char'])
  assert.deepEqual(whole.map(entry => entry.id), whole.map((_, i) => i))
  assert.ok(!whole.some(entry => entry.comment === '人物：林小雨'), 'what the card wrote of itself is not there twice')
})

test('the book as far as a point in it: what came later is left out, what straddles it keeps its early notes', async () => {
  const { cutSource } = await import('../server/forge/source.mjs')
  const { gather, sourceEntries } = await import('../server/forge/novel.mjs')
  const notes = []
  gather(notes, [{ type: '人物', name: '林小雨', aliases: [], content: '只在雨夜出现。' }, { type: '地点', name: '便利店', aliases: [], content: '街角那家。' }], 1)
  gather(notes, [{ type: '人物', name: '林小雨', aliases: [], content: '怕晴天。' }, { type: '事件', name: '停电', aliases: [], content: '整条街停电。' }], 2)
  gather(notes, [{ type: '人物', name: '林小雨', aliases: [], content: '放晴那天没有来。' }, { type: '人物', name: '新店员', aliases: [], content: '第三章才来。' }], 3)
  notes[0].merged = '只在雨夜出现，怕晴天，放晴那天没有来。'
  const source = { name: '雨宿', digest: '', entries: sourceEntries(notes) }
  assert.deepEqual(source.entries.map(entry => [entry.name, entry.first, entry.last, entry.pieces?.length ?? 0]), [['林小雨', 1, 3, 3], ['便利店', 1, 1, 0], ['停电', 2, 2, 0], ['新店员', 3, 3, 0]])
  assert.equal(cutSource(source, 0), source, 'no point set: all of it')
  const early = cutSource(source, 2)
  assert.deepEqual(early.entries.map(entry => entry.name), ['林小雨', '便利店', '停电'])
  assert.equal(early.entries[0].content, '只在雨夜出现。\n怕晴天。', 'her notes up to there, not the whole of her')
  assert.deepEqual(cutSource(source, 1).entries.map(entry => [entry.name, entry.content]), [['林小雨', '只在雨夜出现。'], ['便利店', '街角那家。']])
  assert.equal(cutSource(source, 3).entries[0].content, '只在雨夜出现，怕晴天，放晴那天没有来。', 'all read by then: as it was put together')
  // What goes into the card, and what a writer reads, follow the cut.
  assert.deepEqual(carriedEntries(early, []).map(entry => entry.name), ['人物：林小雨', '地点：便利店', '事件：停电'])
  assert.doesNotMatch(sourceBlock(early, [{ name: 'x', owner: '林小雨', type: '角色' }]), /放晴那天/)
  // A book whose places are not known (not read here) cannot be cut.
  assert.equal(cutSource(SOURCE, 1).entries.length, SOURCE.entries.length)
  assert.equal(cutSource(null, 2), null)
})
