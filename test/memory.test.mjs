// 长期记忆（Beta）: the 记忆簿's parser, merge, snapshots and recall (server/memory.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanEntry, cleanMemory, locateEntry, memoryOf, memoryText, memoryWorldFile, mergeEntries, parseEntries, recallEntries, recalledSince, turnTexts } from '../server/memory.mjs'
import { extractSummary, summaryInstruction } from '../server/recap.mjs'
import { normalizeBook } from '../server/worldbook.mjs'

test('settings: both switches off by default, the interval and budget kept in range', () => {
  assert.deepEqual(cleanMemory(null), { enabled: false, tidy: { enabled: false, every: 10, model: 'helper' }, budget: 1500 })
  assert.deepEqual(cleanMemory({ enabled: true, tidy: { enabled: true, every: 99, model: 'chat' }, budget: 10 }), { enabled: true, tidy: { enabled: true, every: 30, model: 'chat' }, budget: 300 })
  assert.equal(cleanMemory({ enabled: 'yes' }).enabled, false)
})

test('the entries a model wrote: tolerant of brackets, bold, list marks and stray lines', () => {
  const reply = `<剧情存档>\n很长的存档\n</剧情存档>

<记忆条目>
[人物] 林雪 | 林雪, 雪儿、班长
学生会长，表面冷淡。
- 在天台承认讨厌被叫"会长"。
**【约定】看海之约｜看海，海边**
文化祭后一起去看海。
[地点] 旧邮局 | 邮局
镇东头，屋顶漏雨。
[第12轮] 这一行不是条目的开头
[删除] 旧的误会
[事件] 没有正文的条目 | 空
……
</记忆条目>`
  const { entries, removed } = parseEntries(reply)
  assert.deepEqual(entries.map(e => [e.kind, e.title]), [['person', '林雪'], ['promise', '看海之约'], ['thing', '旧邮局']])
  assert.deepEqual(entries[0].keys, ['林雪', '雪儿', '班长'])
  assert.equal(entries[0].text, '学生会长，表面冷淡。\n在天台承认讨厌被叫"会长"。')
  assert.deepEqual(entries[1].keys, ['看海', '海边'])
  assert.match(entries[2].text, /屋顶漏雨。\n\[第12轮\] 这一行不是条目的开头/, 'a bracket that is not a kind stays in the text')
  assert.deepEqual(removed, ['旧的误会'])
  assert.equal(parseEntries('<剧情存档>只有存档</剧情存档>'), null, 'no block at all')
  assert.deepEqual(parseEntries('<记忆条目>\n[人物] 林雪\n她来了。').entries.map(e => e.title), ['林雪'], 'a missing closing tag')
  assert.equal(extractSummary(reply), '很长的存档', 'the archive keeps out of it')
  assert.equal(extractSummary('<剧情存档>\n存档正文\n<记忆条目>\n[人物] 林雪\n她来了'), '存档正文', 'even without its closing tag')
})

test('the compaction request asks for entries only when 长期记忆 is on, and otherwise stays as it was', () => {
  const names = { user: '你', char: '林雪' }
  const plain = summaryInstruction(names)
  assert.match(plain, /只输出存档本身/)
  const asked = summaryInstruction(names, '另外，写 <记忆条目>')
  assert.ok(asked.startsWith(plain.slice(0, plain.indexOf('只输出存档本身'))))
  assert.match(asked, /先写存档，放在 <剧情存档> 和 <\/剧情存档> 之间。\n\n另外，写 <记忆条目>$/)
})

test('merging: same title replaces (id and pin kept), new titles are added, removed ones go, the player’s own stay', () => {
  const book = [
    cleanEntry({ id: 'a', kind: 'person', title: '林雪', keys: ['雪儿'], text: '冷淡。', pinned: true }),
    cleanEntry({ id: 'b', kind: 'event', title: '雨夜', text: '一起躲雨。' }),
    cleanEntry({ id: 'c', kind: 'thing', title: '怀表', text: '玩家写的。', edited: true }),
  ]
  const merged = mergeEntries(book, {
    entries: [
      { kind: 'person', title: '林 雪', keys: ['雪儿', '班长'], text: '开始信任你。' },
      { kind: 'promise', title: '看海之约', keys: ['看海'], text: '文化祭后。' },
      { kind: 'thing', title: '怀表', keys: [], text: '模型想改它。' },
    ],
    removed: ['雨夜', '怀表'],
  }, { locate: entry => (entry.title === '看海之约' ? { from: 3, to: 5 } : {}) })
  assert.deepEqual(merged.map(e => [e.id, e.title, e.text]), [['a', '林雪', '开始信任你。'], ['c', '怀表', '玩家写的。'], [merged[2].id, '看海之约', '文化祭后。']])
  assert.equal(merged[0].pinned, true)
  assert.deepEqual([merged[2].from, merged[2].to], [3, 5])
  assert.equal(mergeEntries(book, null), book, 'no notes, no change')
})

test('turns are numbered as the story counts them and an entry is placed by where it is named', () => {
  const node = (id, role, text, extra = {}) => ({ id, role, text, ...extra })
  const path = [
    node('root', 'assistant', '开场', { compaction: { imported: true, turns: 10, summary: 's' } }),
    node('u1', 'user', '去邮局'), node('a1', 'assistant', '旧邮局的屋顶在漏雨。'),
    node('u2', 'user', '隐藏的'), node('a2', 'assistant', '邮局', { hidden: true }),
    node('u3', 'user', '回家'), node('a3', 'assistant', '林雪说起邮局。'),
  ]
  const turns = turnTexts(path)
  assert.deepEqual(turns.map(t => [t.turn, t.id]), [[11, 'u1'], [13, 'u3']], 'after the ten imported; the hidden round keeps its number but is left out')
  assert.deepEqual(locateEntry({ title: '旧邮局', keys: ['邮局'] }, turns), { from: 11, to: 13 })
  assert.deepEqual(locateEntry({ title: '灯塔', keys: [] }, turns, { from: 11, to: 13 }), { from: 11, to: 13 }, 'not named: the range written')
  assert.deepEqual(locateEntry({ title: '灯塔', keys: [] }, turns), {})
})

test('the snapshot in force is the latest on the path, so a branch or a new version of a reply has its own', () => {
  const one = { entries: [{ id: '1' }], turns: 5, at: '2026-11-01T00:00:00Z' }
  const two = { entries: [{ id: '2' }], turns: 9, at: '2026-11-02T00:00:00Z' }
  const path = [{ id: 'root' }, { id: 'a1', compaction: { summary: 's', memory: one } }, { id: 'a2', memory: two }, { id: 'a3' }]
  assert.equal(memoryOf(path).entries[0].id, '2')
  assert.equal(memoryOf(path).nodeId, 'a2')
  assert.equal(memoryOf(path.slice(0, 2)).entries[0].id, '1')
  assert.equal(memoryOf(path.slice(0, 2)).onCompaction, true)
  assert.equal(memoryOf([{ id: 'root' }]), null)
  const both = [{ id: 'a', memory: one, compaction: { memory: two } }]
  assert.equal(memoryOf(both).entries[0].id, '2', 'the newer of the two on one node')
})

const entry = (id, kind, title, text, extra = {}) => cleanEntry({ id, kind, title, text, from: 1, to: 1, ...extra })

test('recall: only what was compacted away, pinned first, named ones next, within the budget and once per compaction', () => {
  const snapshot = {
    entries: [
      entry('p', 'person', '林雪', '学生会长。', { keys: ['雪儿'], pinned: true }),
      entry('s', 'promise', '看海之约', '文化祭后一起去看海。', { keys: ['看海', '海边'], to: 8 }),
      entry('e', 'event', '雨夜', '两人在邮局躲雨。', { keys: ['躲雨'] }),
      entry('late', 'event', '新的事', '还在上下文里。', { keys: ['看海'], from: 12, to: 12 }),
    ],
  }
  const recalled = recallEntries(snapshot, { compactedTurns: 10, scanText: '周末去海边吗？', focusText: '周末去海边吗？' })
  assert.deepEqual(recalled.map(e => e.id), ['p', 's'], 'the pinned one, then the one named; not the one from after the compaction')
  assert.deepEqual(recallEntries(snapshot, { compactedTurns: 10, recalled: new Set(['p', 's']), scanText: '海边' }).map(e => e.id), [], 'not again while it is still in the context')
  assert.deepEqual(recallEntries(snapshot, { compactedTurns: 0, scanText: '海边' }), [], 'nothing before the first compaction')
  const big = { entries: Array.from({ length: 12 }, (_, i) => entry(`n${i}`, i % 2 ? 'event' : 'thing', `地方${i}`, '很长的正文'.repeat(20), { keys: ['码头'] })) }
  const picked = recallEntries(big, { compactedTurns: 5, scanText: '去码头', budget: 1500 })
  assert.ok(picked.length <= 8)
  assert.ok(picked.reduce((sum, e) => sum + e.title.length + e.text.length + 8, 0) <= 1500)
  const things = recallEntries({ entries: [...big.entries.filter(e => e.kind === 'thing'), entry('ev', 'event', '一件事', '短。', { keys: ['码头'] })] }, { compactedTurns: 5, scanText: '码头', budget: 1000 })
  assert.ok(things.some(e => e.id === 'ev'), 'one kind does not take the whole budget while another waits')
})

test('recall without a keyword: an entry sharing several uncommon character pairs with this turn', () => {
  const snapshot = { entries: [entry('w', 'thing', '祖母的怀表', '银色怀表，表盖内侧刻着外婆的名字，停在三点十七分。'), entry('x', 'event', '集市', '买了糖葫芦。'), entry('y', 'event', '火车站', '送别。'), entry('z', 'person', '老周', '修钟表的师傅。'), entry('v', 'event', '大雪', '封山三天。')] }
  const recalled = recallEntries(snapshot, { compactedTurns: 3, scanText: '那块表还停在三点十七分吗', focusText: '你掏出那块表盖内侧刻着字的旧表，它还停在三点十七分吗' })
  assert.deepEqual(recalled.map(e => e.id), ['w'])
  assert.deepEqual(recallEntries(snapshot, { compactedTurns: 3, scanText: '今天天气不错', focusText: '我们一起出去走走吧，看看外面的风景' }), [], 'common words bring nothing back')
})

test('recalled entries are remembered on the player messages since the compaction; the block and the world file', () => {
  const path = [{ id: 'root' }, { id: 'u1', role: 'user', recalled: ['old'] }, { id: 'a1', compaction: { summary: 's' } }, { id: 'u2', role: 'user', recalled: ['p'] }, { id: 'a2' }, { id: 'u3', role: 'user', recalled: ['q'] }, { id: 'a3', hidden: true }]
  assert.deepEqual([...recalledSince(path)], ['p'], 'not before the compaction, not in a hidden round')
  const entries = [entry('p', 'person', '林雪', '学生会长。', { keys: ['雪儿'], pinned: true })]
  assert.match(memoryText(entries), /^以下是更早剧情里[\s\S]*\n【人物｜林雪】学生会长。$/)
  assert.equal(memoryText([]), '')
  const book = normalizeBook(memoryWorldFile(entries, '记忆簿'), 'x', { standalone: true })
  assert.deepEqual(book.entries.map(e => [e.comment, e.keys, e.content, e.constant]), [['人物｜林雪', ['林雪', '雪儿'], '学生会长。', true]])
})
