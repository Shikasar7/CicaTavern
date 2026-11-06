// A JSON Patch the model got wrong in one place: what can be read is applied, and one nothing can be read from says so.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyStateUpdates } from '../server/state.mjs'

const block = patch => `正文\n<UpdateVariable>\n<JSONPatch>\n${patch}\n</JSONPatch>\n</UpdateVariable>\n<choices>A</choices>`
const open = patch => `正文\n<UpdateVariable>\n<JSONPatch>\n${patch}`
const start = () => ({ 世界: { 时间: '未知', 冷却: 20 }, 榜: {} })

test('a stray closing brace costs nothing: the operations around it are read', () => {
  const { state, changes, unread } = applyStateUpdates(start(), block(`[
  { "op": "replace", "path": "/世界/时间", "value": "午后" },
  { "op": "insert", "path": "/榜/红蝶", "value": { "排名": "十九", "词": "血蝶" } } },
  { "op": "delta", "path": "/世界/冷却", "value": -1 }
]`))
  assert.deepEqual(state, { 世界: { 时间: '午后', 冷却: 19 }, 榜: { 红蝶: { 排名: '十九', 词: '血蝶' } } })
  assert.deepEqual(changes, ['世界.时间', '榜.红蝶', '世界.冷却'])
  assert.equal(unread, undefined)
})

test('a missing closing brace is made up, in the middle of the patch and at its end', () => {
  const { state } = applyStateUpdates(start(), block(`[
  { "op": "insert", "path": "/榜/甲", "value": { "排名": "一" },
  { "op": "replace", "path": "/世界/时间", "value": "午后" },
  { "op": "insert", "path": "/榜/乙", "value": { "排名": "二" }
]`))
  assert.deepEqual(state, { 世界: { 时间: '午后', 冷却: 20 }, 榜: { 甲: { 排名: '一' }, 乙: { 排名: '二' } } })
})

test('quotes and line breaks left in story text are part of the text', () => {
  const { state } = applyStateUpdates(start(), block(`[
  { "op": "replace", "path": "/世界/时间", "value": "碑上写着"入集纳石"四字
第二行" },
  { "op": "delta", "path": "/世界/冷却", "value": -1 }
]`))
  assert.deepEqual(state.世界, { 时间: '碑上写着"入集纳石"四字\n第二行', 冷却: 19 })
})

test('an operation nothing can be made of is the only one lost', () => {
  const { state, unread } = applyStateUpdates(start(), block(`[
  { "op": "replace" "path": "/世界/时间", "value": "午后" },
  { "op": "delta", "path": "/世界/冷却", "value": -1 }
]`))
  assert.deepEqual(state.世界, { 时间: '未知', 冷却: 19 })
  assert.equal(unread, undefined)
})

test('a reply cut off in the patch keeps what was finished and guesses nothing', () => {
  const { state } = applyStateUpdates(start(), open(`[
  { "op": "replace", "path": "/世界/时间", "value": "午后" },
  { "op": "insert", "path": "/榜/红蝶", "value": { "排名": "十九", "词": "写到一半`))
  assert.deepEqual(state, { 世界: { 时间: '午后', 冷却: 20 }, 榜: {} })
  const closedValue = applyStateUpdates(start(), open(`[
  { "op": "replace", "path": "/世界/时间", "value": "午后" },
  { "op": "insert", "path": "/榜/红蝶", "value": { "排名": "十九",`))
  assert.deepEqual(closedValue.state.榜, {}, 'an unfinished value is not closed up and applied')
})

test('an operation written with its path first, and one alone without the array', () => {
  assert.equal(applyStateUpdates(start(), block('[ { "path": "/世界/冷却", "op": "delta", "value": -5 } } ]')).state.世界.冷却, 15)
  assert.equal(applyStateUpdates(start(), block('{ "op": "delta", "path": "/世界/冷却", "value": -5 }')).state.世界.冷却, 15)
})

test('text inside a value that looks like an operation stays text', () => {
  const value = '{\\"op\\":\\"remove\\",\\"path\\":\\"/世界\\"}'
  const { state } = applyStateUpdates(start(), block(`[ { "op": "replace", "path": "/世界/时间", "value": "${value}" } }, { "op": "delta", "path": "/世界/冷却", "value": -1 } ]`))
  assert.deepEqual(state.世界, { 时间: '{"op":"remove","path":"/世界"}', 冷却: 19 })
})

test('salvage goes by the same rules: no reaching the prototype', () => {
  applyStateUpdates({}, block('[ { "op": "replace", "path": "/__proto__/polluted", "value": 1 } } ]'))
  assert.equal({}.polluted, undefined)
})

test('a block nothing can be read from says so; an empty patch or a good one does not', () => {
  assert.equal(applyStateUpdates(start(), block('这不是补丁 { 还少了引号')).unread, true)
  assert.equal(applyStateUpdates(start(), '<UpdateVariable><Analysis>只有分析</Analysis></UpdateVariable>').unread, true)
  assert.equal(applyStateUpdates(start(), block('[]')).unread, undefined, 'the model said nothing changed')
  assert.equal(applyStateUpdates(start(), block('[{"op":"delta","path":"/世界/冷却","value":-1}]')).unread, undefined)
  assert.equal(applyStateUpdates(start(), "<UpdateVariable>_.set('世界.冷却', 20, 3);</UpdateVariable>").unread, undefined)
  assert.equal(applyStateUpdates(start(), '没有更新块').unread, undefined)
  assert.equal(applyStateUpdates(start(), `${block('坏的 {')}\n\n${block('[{"op":"delta","path":"/世界/冷却","value":-1}]')}`).unread, undefined, 'a block written afterwards (补写变量) counts')
})
