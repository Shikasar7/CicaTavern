// 导出文本: a whole conversation as .txt / .md (web/render.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/http.mjs'
import { chatText, messageText } from '../web/render.js'

// A small chat as the page sorts it: the opening, a round with a status block and options, a hidden round,
// a reply where the context was compacted, and one more round after it.
const path = [
  { id: 'root', role: 'assistant', parts: [{ kind: 'story', text: '雨下了一夜。' }] },
  { id: 'u1', role: 'user', parts: [{ kind: 'story', text: '我推开门。' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      { kind: 'status', text: '10月19日 傍晚｜旧城茶馆' },
      { kind: 'story', text: '她抬头看你。\n\n“来了？”' },
      { kind: 'status', text: '好感：12\n心情：平静' },
      { kind: 'choices', text: 'A. 坐下\nB. 转身离开' },
    ],
  },
  { id: 'u2', role: 'user', hidden: true, parts: [{ kind: 'story', text: '（被审查拦下的一句）' }] },
  { id: 'a2', role: 'assistant', hidden: true, parts: [{ kind: 'story', text: '（拒绝的回复）' }] },
  { id: 'u3', role: 'user', parts: [{ kind: 'story', text: '我坐下。' }] },
  { id: 'a3', role: 'assistant', compaction: { turns: 2 }, parts: [{ kind: 'story', text: '茶凉了。' }] },
  { id: 'u4', role: 'user', parts: [{ kind: 'story', text: '再来一壶。' }] },
  // A card that draws its whole reply in its own page: nothing is story, so it keeps what it has.
  { id: 'a4', role: 'assistant', parts: [{ kind: 'status', text: '店小二端上新茶' }] },
]

const options = (extra = {}) => ({
  title: '茶馆',
  date: '导出于 2026/11/10 14:00',
  nameOf: node => (node.role === 'user' ? '沈观' : '小雨'),
  partsOf: node => node.parts,
  notesOf: node => (node.compaction ? { after: `这里压缩了上下文：前 ${node.compaction.turns} 轮写成了剧情存档` } : null),
  ...extra,
})

test('text: each turn under its speaker, story only, hidden round out, compaction kept as a note', () => {
  const text = chatText(path, options())
  assert.equal(
    text,
    [
      '茶馆',
      '导出于 2026/11/10 14:00',
      '',
      '',
      '【小雨】',
      '雨下了一夜。',
      '',
      '【沈观】',
      '我推开门。',
      '',
      '【小雨】',
      '她抬头看你。',
      '',
      '“来了？”',
      '',
      '【沈观】',
      '我坐下。',
      '',
      '【小雨】',
      '茶凉了。',
      '',
      '（这里压缩了上下文：前 2 轮写成了剧情存档）',
      '',
      '【沈观】',
      '再来一壶。',
      '',
      '【小雨】',
      '店小二端上新茶',
      '',
    ].join('\n'),
  )
  assert.doesNotMatch(text, /好感|旧城茶馆|坐下\nB|审查|拒绝/)
})

test('text: with 仅正文 off, the status, time and options stay, in the order shown', () => {
  const text = chatText(path, options({ storyOnly: false }))
  assert.match(text, /【小雨】\n10月19日 傍晚｜旧城茶馆\n\n她抬头看你。\n\n“来了？”\n\n好感：12\n心情：平静\n\nA\. 坐下\nB\. 转身离开\n\n【沈观】/)
  // Hidden is hidden either way.
  assert.doesNotMatch(text, /审查|拒绝/)
})

test('markdown: a title, **名字** lines, --- between turns, notes as quotes', () => {
  const text = chatText(path, options({ format: 'md' }))
  assert.ok(text.startsWith('# 茶馆\n\n导出于 2026/11/10 14:00\n\n---\n\n**小雨**\n\n雨下了一夜。\n\n---\n\n**沈观**\n\n我推开门。\n\n---\n\n'))
  assert.match(text, /\*\*小雨\*\*\n\n茶凉了。\n\n---\n\n> 这里压缩了上下文：前 2 轮写成了剧情存档\n\n---\n\n\*\*沈观\*\*\n\n再来一壶。/)
  assert.ok(text.endsWith('**小雨**\n\n店小二端上新茶\n'))
  assert.doesNotMatch(text, /好感|审查/)
  // Lines a single line break parts stay apart (hard breaks); paragraphs stay paragraphs.
  const whole = chatText(path, options({ format: 'md', storyOnly: false }))
  assert.match(whole, /\n\n她抬头看你。\n\n“来了？”\n\n好感：12  \n心情：平静\n\nA\. 坐下  \nB\. 转身离开\n\n---/)
})

test('a note before a message (a chat continued from a story archive) and empty messages', () => {
  const imported = [
    { id: 'root', role: 'assistant', compaction: { imported: true }, parts: [{ kind: 'story', text: '上回说到……' }] },
    { id: 'u1', role: 'user', parts: [] },
    { id: 'a1', role: 'assistant', parts: [{ kind: 'story', text: '  ' }] },
  ]
  const text = chatText(imported, options({ notesOf: node => (node.compaction?.imported ? { before: '从剧情存档接着写' } : null) }))
  assert.equal(text, '茶馆\n导出于 2026/11/10 14:00\n\n\n（从剧情存档接着写）\n\n【小雨】\n上回说到……\n')
})

test('messageText: story parts with 仅正文, everything without; a message with no story keeps what it has', () => {
  const parts = [{ kind: 'status', text: 'HP 10' }, { kind: 'story', text: ' 正文 ' }, { kind: 'choices', text: 'A. 走' }]
  assert.equal(messageText(parts, true), '正文')
  assert.equal(messageText(parts, false), 'HP 10\n\n正文\n\nA. 走')
  assert.equal(messageText([{ kind: 'status', text: 'HP 10' }], true), 'HP 10')
  assert.equal(messageText([], true), '')
})

test('the Android hand-over: a text posted is served as an attachment of its kind, and unknown tokens are not', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'tavern-text-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = body => fetch(`${base}/api/text-exports`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: JSON.stringify(body) }).then(res => res.json())
  const { path: served } = await post({ type: 'text/markdown', text: '# 茶馆\n\n**小雨**\n\n雨下了一夜。\n' })
  assert.match(served, /^\/api\/text-exports\/[0-9a-f]{24}$/)
  const res = await fetch(base + served)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8')
  assert.equal(res.headers.get('content-disposition'), 'attachment')
  assert.equal(await res.text(), '# 茶馆\n\n**小雨**\n\n雨下了一夜。\n')
  // Any other kind is plain text.
  const other = await post({ type: 'text/html', text: '<b>x</b>' })
  assert.equal((await fetch(base + other.path)).headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal((await fetch(`${base}/api/text-exports/nope`)).status, 404)
})