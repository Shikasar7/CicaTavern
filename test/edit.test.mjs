import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activePath, chatView, editMessage } from '../server/chats.mjs'

const at = n => `2026-10-07T10:00:0${n}.000Z`

function chat() {
  return {
    id: 'c1',
    names: { user: '你', char: '她' },
    systemPrompt: '',
    tips: {},
    nodes: {
      root: { id: 'root', role: 'assistant', parent: null, text: '开场', display: '开场', createdAt: at(0) },
      u1: { id: 'u1', role: 'user', parent: 'root', text: '去客栈', prompt: '<lore>江湖</lore>\n<玩家输入>去客栈</玩家输入>', createdAt: at(1) },
      a1: { id: 'a1', role: 'assistant', parent: 'u1', text: '她跟上来。\n<status>心情：好</status>', display: '她跟上来。', historyTrim: { removedChars: 3 }, createdAt: at(2) },
      u2: { id: 'u2', role: 'user', parent: 'a1', text: '坐下', prompt: '坐下', createdAt: at(3) },
      a2: { id: 'a2', role: 'assistant', parent: 'u2', text: '她坐下。', display: '她坐下。', createdAt: at(4) },
    },
  }
}

test('editMessage rewrites a reply: shown and sent text change, state stays, the edit is marked', () => {
  const c = chat()
  c.nodes.a1.state = { 心情: '好' }
  const result = editMessage(c, 'a1', '她跟上来。\r\n')
  assert.equal(result.before, '她跟上来。\n<status>心情：好</status>')
  assert.equal(c.nodes.a1.text, '她跟上来。')
  assert.equal(c.nodes.a1.display, '她跟上来。')
  assert.equal(c.nodes.a1.historyTrim, undefined, 'the prompt-side regex runs again on the new text')
  assert.deepEqual(c.nodes.a1.state, { 心情: '好' })
  assert.equal(c.nodes.a1.edited.count, 1)
  assert.equal(chatView(c).path.find(n => n.id === 'a1').edited.count, 1)
  assert.equal(result.behindCompaction, false)
})

test('editMessage swaps a user input inside its recorded prompt, keeping the lore around it', () => {
  const c = chat()
  const result = editMessage(c, 'u1', '去酒楼')
  assert.equal(result.beforePrompt, '<lore>江湖</lore>\n<玩家输入>去客栈</玩家输入>')
  assert.equal(c.nodes.u1.prompt, '<lore>江湖</lore>\n<玩家输入>去酒楼</玩家输入>')
})

test('editMessage finds the input as its turn sent it (regex and macros), and the preset copy of it', () => {
  const c = chat()
  c.nodes.u1.text = '{{user}}去客栈'
  c.nodes.u1.prompt = '<世界书>\n客栈在东街\n</世界书>\n\n<玩家输入>\n【你去客栈】\n</玩家输入>\n\n<预设指令>\n玩家说：【你去客栈】\n</预设指令>'
  const sentInput = input => `【${input.replace(/\{\{user\}\}/g, '你')}】`
  const result = editMessage(c, 'u1', '{{user}}去酒楼', { sentInput })
  assert.equal(c.nodes.u1.prompt, '<世界书>\n客栈在东街\n</世界书>\n\n<玩家输入>\n【你去酒楼】\n</玩家输入>\n\n<预设指令>\n玩家说：【你去酒楼】\n</预设指令>')
  assert.equal(result.promptMissed, false)

  // A card regex changed since: the last input block is rewritten all the same.
  c.nodes.u1.prompt = '<玩家输入>\n你去酒楼\n</玩家输入>'
  editMessage(c, 'u1', '回家', { sentInput })
  assert.equal(c.nodes.u1.prompt, '<玩家输入>\n【回家】\n</玩家输入>')

  // Nowhere to be found: said, the prompt left as it was.
  c.nodes.u1.prompt = '别的内容'
  assert.equal(editMessage(c, 'u1', '出城', { sentInput }).promptMissed, true)
  assert.equal(c.nodes.u1.prompt, '别的内容')
})

test('editMessage refuses the opening, empty text and messages off the active path; same text is a no-op', () => {
  const c = chat()
  assert.throws(() => editMessage(c, 'root', 'x'), /开场/)
  assert.throws(() => editMessage(c, 'a1', '  '), /不能为空/)
  c.nodes.a1b = { id: 'a1b', role: 'assistant', parent: 'u1', text: '另一版', display: '另一版', createdAt: at(9) }
  c.nodes.u1.sel = 'a1'
  assert.throws(() => editMessage(c, 'a1b', 'x'), /不在当前对话/)
  assert.equal(editMessage(c, 'a2', '她坐下。').unchanged, true)
  assert.equal(c.nodes.a2.edited, undefined)
  assert.equal(activePath(c).length, 5)
})

test('editMessage notes when a later compaction already replaced the message in the context', () => {
  const c = chat()
  c.nodes.a2.compaction = { summary: '前情', turns: 2 }
  assert.equal(editMessage(c, 'a1', '她跟上来。').behindCompaction, true)
})
