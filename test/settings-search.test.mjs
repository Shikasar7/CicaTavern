// 设置里的搜索: what matches a query and in what order.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byGroup, findSettings, markedParts, snippetOf } from '../web/settings-search.js'

const item = (title, group, place = '', text = '') => ({ title, group, place, text, go: () => {} })
const ITEMS = [
  item('上下文压缩', '模型', '', '上下文用到 70% 时自动压缩'),
  item('压缩的百分比', '模型', '上下文压缩', '用到多少时压缩'),
  item('网络代理', '连接', '', '不用代理 proxy'),
  item('Thinking', '模型', '', 'Reasoning effort'),
  item('剧情推进', '写作', '预设 · 基础预设', '每轮把故事往前推多少 慢 快'),
  item('剧情推进', '写作', '预设 · 视觉小说预设', '每轮把故事往前推多少 慢 快'),
]
const titles = (query, items = ITEMS) => findSettings(items, query).map(found => found.title)

test('a word finds what has it in its name, its place or its words, the name first', () => {
  assert.deepEqual(titles('压缩'), ['压缩的百分比', '上下文压缩'], 'starting with it, then holding it')
  assert.deepEqual(titles('proxy'), ['网络代理'], 'by what it says')
  assert.deepEqual(titles('连接'), ['网络代理'], 'by where it is')
  assert.deepEqual(titles('REASONING'), ['Thinking'], 'in any case')
})

test('every word has to match, and nothing typed finds nothing', () => {
  assert.deepEqual(titles('压缩 百分比'), ['压缩的百分比'])
  assert.deepEqual(titles('压缩 代理'), [])
  assert.deepEqual(titles('   '), [])
})

test('the same name in two places is both, the same place twice is one', () => {
  assert.equal(titles('剧情推进').length, 2)
  assert.equal(titles('剧情', [...ITEMS, ITEMS[4]]).length, 2)
})

test('why something was found: the words around it, unless its name says so', () => {
  const found = item('网络代理', '连接', '', '走系统设置里的代理，也可以填一个 socks5 地址')
  assert.equal(snippetOf(found, '代理'), '')
  assert.match(snippetOf(found, 'socks5'), /socks5 地址/)
  assert.equal(snippetOf(found, '连接'), '', 'not in its words: found by its place')
})

test('what was found goes under its category, the best one\'s first, the order kept within each', () => {
  const found = [item('文风', '写作'), item('思考', '模型'), item('人称', '写作', '预设 · 基础预设')]
  assert.deepEqual(byGroup(found).map(([group, items]) => [group, items.map(one => one.title)]), [['写作', ['文风', '人称']], ['模型', ['思考']]])
})

test('the words searched for are marked, every time they come, in any case', () => {
  assert.deepEqual(markedParts('你的角色和角色卡', '角色'), [{ text: '你的', hit: false }, { text: '角色', hit: true }, { text: '和', hit: false }, { text: '角色', hit: true }, { text: '卡', hit: false }])
  assert.deepEqual(markedParts('Reasoning', 'reason'), [{ text: 'Reason', hit: true }, { text: 'ing', hit: false }])
  assert.deepEqual(markedParts('上下文压缩', '压缩 上下'), [{ text: '上下', hit: true }, { text: '文', hit: false }, { text: '压缩', hit: true }])
  assert.deepEqual(markedParts('文风', '角色'), [{ text: '文风', hit: false }])
})
