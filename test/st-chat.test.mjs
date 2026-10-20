// SillyTavern chats (.jsonl) brought in: every turn, swipes as other versions,
// MVU variables kept; a long one compacted in parts before it continues.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { dateOf, readSillyTavernChat } from '../server/st-chat.mjs'

const lines = rows => rows.map(row => JSON.stringify(row)).join('\n')
const header = { user_name: '小蝉', character_name: '顾念念', create_date: '2026-08-04@04h35m41s', chat_metadata: { variables: {} } }
const said = (mes, extra = {}) => ({ name: '小蝉', is_user: true, is_system: false, send_date: 'August 4, 2026 4:35am', mes, extra: {}, ...extra })
const reply = (mes, extra = {}) => ({ name: '顾念念', is_user: false, is_system: false, send_date: 'August 4, 2026 4:36am', mes, extra: { reasoning: '先想想' }, ...extra })

test('reading: names from the header, hidden messages left out, two in a row as one, swipes and their variables', () => {
  const chat = readSillyTavernChat(lines([
    header,
    reply('「师兄？」', { swipes: ['「师兄？」', '「师兄!」'], swipe_id: 0, variables: [{ stat_data: { 好感: 1 } }, { stat_data: { 好感: 2 } }] }),
    said('我回头。'),
    said('（又看了她一眼）'),
    { name: 'System', is_user: false, is_system: true, mes: '隐藏的备注' },
    reply('她笑了。', { swipes: ['她哭了。', '她笑了。'], swipe_id: 1 }),
  ]))
  assert.equal(chat.userName, '小蝉')
  assert.equal(chat.characterName, '顾念念')
  assert.deepEqual(chat.messages.map(m => [m.role, m.selected, m.versions.map(v => v.text)]), [
    ['assistant', 0, ['「师兄？」', '「师兄!」']],
    ['user', 0, ['我回头。\n\n（又看了她一眼）']],
    ['assistant', 1, ['她哭了。', '她笑了。']],
  ])
  assert.deepEqual(chat.messages[0].versions.map(v => v.state), [{ 好感: 1 }, { 好感: 2 }])
  assert.equal(chat.messages[0].versions[0].at, new Date('August 4, 2026 4:36').toISOString())
  // Newer SillyTavern: "unused" in the header, the names on the messages.
  const newer = readSillyTavernChat(lines([{ user_name: 'unused', character_name: 'unused', chat_metadata: {} }, reply('开场'), said('嗯')]))
  assert.deepEqual([newer.userName, newer.characterName], ['小蝉', '顾念念'])
  assert.throws(() => readSillyTavernChat('not json'), /SillyTavern/)
  assert.throws(() => readSillyTavernChat(lines([header])), /没有对话消息/)
})

test('dates: SillyTavern\'s own format, ISO, epoch ms', () => {
  assert.equal(dateOf('August 4, 2026 4:35pm'), new Date('August 4, 2026 16:35').toISOString())
  assert.equal(dateOf('August 4, 2026 12:05am'), new Date('August 4, 2026 0:05').toISOString())
  assert.equal(dateOf('2026-08-04T04:35:00.000Z'), '2026-08-04T04:35:00.000Z')
  assert.equal(dateOf(0), '1970-01-01T00:00:00.000Z')
  assert.equal(dateOf('someday'), null)
})

async function tavern(t) {
  const asked = []
  const fake = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const json = JSON.parse(raw || '{}')
    asked.push(json)
    const archive = `<剧情存档>\n${`第 ${asked.length} 段存档。`.repeat(40)}\n</剧情存档>`
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: 'fake', choices: [{ message: { content: archive } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
  })
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-st-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    fake.close()
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${fake.address().port}/v1`, apiKey: 'sk-st', models: ['fake'] })
  await app.store.saveProviders([provider])
  await app.store.saveSettings({ model: `${provider.id}/fake` })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, body) => {
    const res = await fetch(`${base}${pathname}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const card = { spec: 'chara_card_v2', data: { name: '顾念念', description: '小师妹', first_mes: '卡里的开场。', character_book: { entries: [{ keys: ['[InitVar]'], content: '{"好感": 0, "地点": "山门"}', enabled: false, comment: '[InitVar]' }] } } }
  const { id } = (await call('/api/cards/import', { filename: 'card.json', data: Buffer.from(JSON.stringify(card)).toString('base64') })).body
  return { asked, call, cardId: id, app }
}

test('importing: every turn on one path, the other swipes beside it, variables kept or replayed, the last unanswered line handed back', async t => {
  const { call, cardId, app } = await tavern(t)
  const text = lines([
    header,
    reply('「师兄？」'),
    said('我回头。'),
    reply('她笑了。', { swipes: ['她哭了。', '她笑了。'], swipe_id: 1, variables: [{ stat_data: { 好感: 1 } }, { stat_data: { 好感: 5 } }] }),
    said('走吧。'),
    reply('<UpdateVariable><JSONPatch>[{"op":"replace","path":"/地点","value":"后山"}]</JSONPatch></UpdateVariable>她跟上来。'),
    said('还没回的一句。'),
  ])
  const view = (await call('/api/chats/import-sillytavern', { cardId, filename: '顾念念 - 2026-08-04@04h35m41s023ms.jsonl', text })).body
  assert.equal(view.title, '顾念念 - 2026-08-04@04h35m41s023ms（导入）')
  assert.deepEqual(view.names, { char: '顾念念', user: '小蝉' })
  assert.deepEqual(view.path.map(n => [n.role, n.raw]), [
    ['assistant', '「师兄？」'],
    ['user', '我回头。'],
    ['assistant', '她笑了。'],
    ['user', '走吧。'],
    ['assistant', '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/地点","value":"后山"}]</JSONPatch></UpdateVariable>她跟上来。'],
  ])
  assert.deepEqual(view.imported, { turns: 2, chars: view.path.reduce((sum, n) => sum + n.raw.length, 0), pendingInput: '还没回的一句。' })
  // The swipe the chat was on, its sibling beside it; variables from the swipe, the card's others kept.
  assert.equal(view.path[2].siblingCount, 2)
  assert.equal(view.path[2].siblingIndex, 1)
  assert.deepEqual(view.path[2].state, { 好感: 5, 地点: '山门' })
  // No variables saved: the update block plays as it would have.
  assert.deepEqual(view.path[4].state, { 好感: 5, 地点: '后山' })
  assert.equal(view.path.every(n => n.imported), true)
  assert.equal(view.compactable, 2)
  // A user line answered by nothing of ours: what the model is sent is the line itself.
  const saved = await app.store.getChat(view.id)
  assert.equal(saved.nodes[view.path[1].id].prompt, '我回头。')
})

test('compacting an imported chat: a long history is summarised in parts, each carrying the one before', async t => {
  const { asked, call, cardId } = await tavern(t)
  const long = '雨下了很久。'.repeat(4000) // 24000 characters a reply
  const rows = [header, reply('开场。')]
  for (let i = 0; i < 8; i++) rows.push(said(`第 ${i + 1} 轮。`), reply(long))
  const view = (await call('/api/chats/import-sillytavern', { cardId, filename: 'long.jsonl', text: lines(rows) })).body
  assert.ok(view.imported.chars > 190000)
  const compacted = (await call(`/api/chats/${view.id}/compact`, {})).body
  assert.ok(compacted.path, JSON.stringify(compacted))
  assert.match(compacted.path.at(-1).compaction.summary, /存档/)
  // More than one part, and every part after the first reads the archive so far.
  assert.ok(asked.length >= 2, `${asked.length} requests`)
  assert.ok(asked.slice(1).every(request => JSON.stringify(request.messages).includes('前情提要')))
  assert.ok(asked.every(request => JSON.stringify(request.messages).length < 400000))
})
