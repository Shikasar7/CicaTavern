import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { normalizeCard, parseCardFile, unwrapWorkspace } from '../server/cards.mjs'
import { extractSummary, recapBlock, recentExchanges, turnsSinceCompaction } from '../server/recap.mjs'

const CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '小雨',
    description: '{{char}}是咖啡店店员。',
    first_mes: '欢迎光临～',
    character_book: { entries: [{ keys: [], content: '好感度: 10', constant: true, enabled: true, comment: '[initvar]初始变量' }] },
  },
}

const SUMMARY = `<剧情存档>\n${'小雨和你在咖啡店聊起了桂花拿铁。'.repeat(20)}\n</剧情存档>`

/** Stands in for the SDK's query(): records each call and answers like Claude Code would. */
function fakeQuery() {
  const calls = []
  let sessions = 0
  let messages = 0
  // Like the real SDK, modelUsage keeps counting across a resumed session.
  const sessionUsage = new Map()
  const run = ({ prompt, options }) => {
    calls.push({ prompt, options })
    const sessionId = options.resume && !options.forkSession ? options.resume : `s${++sessions}`
    const text = prompt.includes('暂停扮演') ? SUMMARY : `第 ${calls.length} 次回复`
    const modelUsage = { ...(options.resume ? sessionUsage.get(options.resume) : {}) }
    modelUsage[options.model] = { outputTokens: (modelUsage[options.model]?.outputTokens ?? 0) + 5 }
    sessionUsage.set(sessionId, modelUsage)
    return (async function* () {
      yield { type: 'assistant', session_id: sessionId, uuid: `m${++messages}`, message: { model: options.model, content: [{ type: 'text', text }] } }
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage }
    })()
  }
  return { run, calls }
}

test('recap helpers: summary extraction, turn counting, recent exchanges', () => {
  assert.equal(extractSummary('前言<剧情存档>\n正文<UpdateVariable>x</UpdateVariable>\n</剧情存档>后记'), '正文')
  assert.equal(extractSummary('没有标签的存档'), '没有标签的存档')
  const node = (id, role, text, extra = {}) => ({ id, role, text, ...extra })
  const path = [node('root', 'assistant', '开场'), node('u1', 'user', '一'), node('a1', 'assistant', '甲', { compaction: { summary: 's' } }), node('u2', 'user', '二'), node('a2', 'assistant', '乙'), node('u3', 'user', '三'), node('a3', 'assistant', '丙')]
  assert.equal(turnsSinceCompaction(path), 2)
  assert.equal(turnsSinceCompaction(path.slice(0, 3)), 0, 'nothing new since a compaction at the tip')
  const names = { user: '你', char: '小雨' }
  assert.equal(recentExchanges(path, names, ({ text, depth }) => `${text}@${depth}`), '【你】\n二@3\n\n【小雨】\n乙@2\n\n【你】\n三@1\n\n【小雨】\n丙@0')
  assert.equal(recentExchanges(path.slice(0, 3), names), '【你】\n一\n\n【小雨】\n甲', 'the opening is left to the summary')
  assert.match(recapBlock('存档', '原文'), /<前情提要>[\s\S]*<剧情存档>\n存档\n<\/剧情存档>[\s\S]*<最近原文>\n原文/)
})

test('cards and worldbooks wrapped in an editor workspace import', () => {
  const wrapped = Buffer.from(JSON.stringify({ kind: 'dsh-tavern-character-workspace', version: 1, raw: CARD, meta: {} }))
  const { raw } = parseCardFile('林雪.json', wrapped)
  assert.equal(normalizeCard(raw).name, '小雨')
  assert.equal(unwrapWorkspace({ name: 'x', entries: {} }).name, 'x')
})
