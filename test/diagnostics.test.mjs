// 错误日志 (server/diagnostics.mjs): failed requests, turns and the page's own
// mistakes are kept in <data>/logs/errors.jsonl; the report has the setup and the
// latest errors, keys and the user's folder taken out, and the open chat's last
// turn only when asked for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { redact, savedSecrets } from '../server/diagnostics.mjs'
import { normalizeProvider } from '../server/providers.mjs'

const KEY = 'sk-test-abcdef0123456789abcdef'

/** A model that refuses every request, quoting the key it was given (as some do). */
async function refusingModel(t) {
  const server = createServer((req, res) => {
    req.resume()
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization?.slice(7)}` } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}/v1`
}

async function tavern(t, dataRoot) {
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(() => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  return { app, base, call }
}

async function dataFolder(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-errors-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return root
}

const report = async (call, body = {}) => (await call('/api/diagnostics/report', { method: 'POST', body })).body

test('error log: a failed request, the page\'s own mistake and a refused turn, with the setup and no keys', async t => {
  const root = await dataFolder(t)
  const { app, base, call } = await tavern(t, root)
  const provider = normalizeProvider({ name: 'Refuser', api: 'openai-completions', baseURL: await refusingModel(t), apiKey: KEY, models: [{ id: 'm1' }] })
  await app.store.saveProviders([provider])
  await app.store.saveSettings({ model: `${provider.id}/m1` })

  assert.match((await report(call)).text, /还没有记录到错误/)

  // A PNG with no card in it.
  const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex')
  const failed = await call('/api/cards/import', { method: 'POST', body: { filename: 'card.png', data: png.toString('base64') } })
  assert.equal(failed.status, 400)
  // Written before the answer went out: a test deleting the folder right after, or a crash, finds it there.
  const logFile = path.join(root, 'logs', 'errors.jsonl')
  assert.match(await readFile(logFile, 'utf8'), /POST \/api\/cards\/import.*这张 PNG 里没有角色卡数据/)

  // The page's own mistake, its stack naming the page's address and this computer's user folder.
  const home = homedir()
  await call('/api/diagnostics/page', { method: 'POST', body: { kind: 'error', message: "Cannot read properties of undefined (reading 'plain')", stack: `TypeError: Cannot read properties of undefined (reading 'plain')\n    at render (${base}/vn.js:603:20)\n    at ${path.join(home, 'x.js')}:1:1` } })

  // A turn the model refuses, its message quoting the key.
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '林雪', first_mes: '雪下了一整夜。' } })).toString('base64') } })).body
  const chat = (await call('/api/chats', { method: 'POST', body: { cardId: card.id } })).body
  const res = await fetch(`${base}/api/chats/${chat.id}/turn`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: JSON.stringify({ parentId: chat.path.at(-1).id, input: '我推门进去。' }) })
  assert.match(await res.text(), /"type":"error"/)
  assert.match(await readFile(logFile, 'utf8'), /"source":"turn"/, 'in the log before the stream ended')

  const { text, count } = await report(call, { page: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130', screen: '412×915 @2.6x' } })
  assert.equal(count, 3)
  assert.match(text, /CicaTavern 错误日志/)
  assert.match(text, /版本 \S+（release）/)
  assert.match(text, /Android 14/, 'the page it was made on')
  assert.match(text, /模型 Refuser · m1/)
  assert.match(text, /Refuser · openai-completions · 127\.0\.0\.1:\d+ · 1 个模型/)
  assert.match(text, /卡 1 张 · 对话 1 个/)
  assert.match(text, /POST \/api\/cards\/import {2}400\n {2}这张 PNG 里没有角色卡数据/)
  assert.match(text, /页面（error）\n {2}Cannot read properties of undefined \(reading 'plain'\)\n {4}at render \(\/vn\.js:603:20\)/, 'the page\'s address goes, its stack line stays')
  assert.match(text, /生成回复 · Refuser · m1 {2}\d{3}/)
  // Newest first.
  assert.ok(text.indexOf('生成回复') < text.indexOf('页面（error）') && text.indexOf('页面（error）') < text.indexOf('/api/cards/import'))
  assert.ok(!text.includes(KEY) && !text.includes(KEY.slice(3)), 'the provider\'s key is not in it')
  assert.ok(!text.includes(home) && !text.includes(home.replace(/\\/g, '/')), 'nor the user folder')
  assert.match(text, /~[\\/]x\.js/)
  assert.ok(!text.includes('我推门进去') && !text.includes('雪下了一整夜'), 'no story unless asked')
  // Nor on disk.
  const kept = await readFile(path.join(root, 'logs', 'errors.jsonl'), 'utf8')
  assert.ok(!kept.includes(KEY) && !kept.includes(home), 'the file has no key or user folder either')
})

test('error log: the open chat\'s last turn only when ticked; the same error again is counted; kept across restarts; cleared', async t => {
  const root = await dataFolder(t)
  const first = await tavern(t, root)
  const card = (await first.call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '林青禾', first_mes: '雨下了一下午。' } })).toString('base64') } })).body
  const lines = rows => rows.map(row => JSON.stringify(row)).join('\n')
  const chat = (await first.call('/api/chats/import-sillytavern', {
    method: 'POST',
    body: {
      cardId: card.id,
      filename: 'teahouse.jsonl',
      text: lines([
        { user_name: '你', character_name: '林青禾', create_date: '2026-10-25@21h00m00s', chat_metadata: {} },
        { name: '林青禾', is_user: false, is_system: false, send_date: 'October 25, 2026 9:00pm', mes: '雨下了一下午。', extra: {} },
        { name: '你', is_user: true, is_system: false, send_date: 'October 25, 2026 9:01pm', mes: '我收起伞。', extra: {} },
        { name: '林青禾', is_user: false, is_system: false, send_date: 'October 25, 2026 9:02pm', mes: '【林青禾|微笑】「来了？」', extra: {} },
      ]),
    },
  })).body

  // The same error three times, another one in between: one entry, counted and moved up to the newest.
  await first.call('/api/cards/nope0000/edit')
  await first.call('/api/cards/nope0000/edit')
  await first.call('/api/worldbooks/nope0000')
  await first.call('/api/cards/nope0000/edit')
  let { text, count } = await report(first.call, { chatId: chat.id })
  assert.equal(count, 2, 'three of the same make one entry')
  assert.match(text, /最近的错误（2 条，新的在前）：\n\n\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}GET \/api\/cards\/nope0000\/edit {2}404 {2}共 3 次，第一次 \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\n[^\n]+\n\n[^\n]+GET \/api\/worldbooks\/nope0000 {2}404/)
  assert.ok(!text.includes('来了？'), 'not ticked')

  ;({ text } = await report(first.call, { chatId: chat.id, lastTurn: true }))
  assert.match(text, /当前对话的最后一轮/)
  assert.match(text, /卡「林青禾」/)
  assert.match(text, /你的输入：\n我收起伞。\n\n模型的原始输出：\n【林青禾\|微笑】「来了？」/)

  // Another server on the same data: the log is still there.
  const second = await tavern(t, root)
  assert.deepEqual((await second.call('/api/diagnostics')).body, { count: 2 })
  assert.deepEqual((await second.call('/api/diagnostics', { method: 'DELETE' })).body, { count: 0 })
  assert.match((await report(second.call)).text, /还没有记录到错误/)
})

test('error log: keys, tokens and passwords are taken out of error texts; the ones saved in the data folder too', async t => {
  assert.equal(redact('401 Incorrect API key provided: sk-proj-AbCdEf1234567890xyz'), '401 Incorrect API key provided: [redacted]')
  assert.equal(redact('GET https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyA1234567890abcdefghijklmnop'), 'GET https://generativelanguage.googleapis.com/v1beta/models?key=[redacted]')
  assert.match(redact('Authorization: Bearer pst-abcdef1234567890'), /^Authorization: \[redacted\]/)
  assert.doesNotMatch(redact('Authorization: Bearer pst-abcdef1234567890'), /pst-|abcdef/)
  assert.equal(redact('proxy http://me:hunter22@10.0.0.2:7890 refused'), 'proxy http://[redacted]@10.0.0.2:7890 refused')
  assert.equal(redact('{"apiKey":"0123456789abcdef"}'), '{"apiKey":"[redacted]"}')
  assert.equal(redact('data:image/png;base64,' + 'A'.repeat(80)), 'data:image/png;base64,…')
  assert.equal(redact('a plain message with key words, keys: 3'), 'a plain message with key words, keys: 3')

  const root = await dataFolder(t)
  await writeFile(path.join(root, 'providers.json'), JSON.stringify({ providers: [{ name: 'Relay', apiKey: 'relaykey9876543', headers: { 'X-Relay': 'hdr-secret-42x' }, models: [] }] }))
  await writeFile(path.join(root, 'novelai.json'), JSON.stringify({ token: 'naitok3n_0001', mode: 'always' }))
  const known = await savedSecrets(root)
  assert.deepEqual(new Set(known), new Set(['relaykey9876543', 'hdr-secret-42x', 'naitok3n_0001']), 'not words like "always"')
  assert.equal(redact('failed with relaykey9876543 and naitok3n_0001 (always)', known), 'failed with [redacted] and [redacted] (always)')
})
