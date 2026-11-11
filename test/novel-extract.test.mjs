// 世界书 → 从小说抽取: a long text read a stretch at a time into worldbook entries (server/forge/novel.mjs). How it is
// cut, what a stretch's answer is read as, how the same name gathers its notes, and the whole of it over HTTP: nothing
// sent till it is run, stopped part way and taken up again, the names noted twice put together, a book made of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { extractRequest, gather, mergeBatches, mergeRequest, novelBook, novelEstimate, readExtract, readMerge, splitNovel } from '../server/forge/novel.mjs'

const chapter = (n, body = '她走进雨里，没有回头。\n') => `第${n}章 雨夜之${n}\n${body.repeat(380)}`
const NOVEL = [1, 2, 3, 4, 5, 6].map(n => chapter(n)).join('\n')

test('a novel is cut by its chapters, short ones together and a long one apart; a text with none, by length', () => {
  const stretches = splitNovel(NOVEL)
  assert.equal(stretches.length, 3)
  assert.deepEqual(stretches.map(stretch => stretch.title), ['第1章 雨夜之1 … 第2章 雨夜之2', '第3章 雨夜之3 … 第4章 雨夜之4', '第5章 雨夜之5 … 第6章 雨夜之6'])
  assert.equal(stretches[0].from, 0)
  assert.equal(stretches.at(-1).to, NOVEL.length)
  stretches.forEach((stretch, i) => i && assert.equal(stretch.from, stretches[i - 1].to, 'nothing between two stretches'))
  assert.match(NOVEL.slice(stretches[1].from, stretches[1].from + 12), /^第3章 雨夜之3/)
  // What comes before the first heading is read too; a chapter too long for one request is cut at a line's end.
  const long = `楔子前的一段话。\n第一章 开头\n${'很长的一行。\n'.repeat(6000)}第二章 中\n短。\n第三章 尾\n完。`
  const cut = splitNovel(long)
  assert.ok(cut.length >= 4)
  assert.ok(cut.every(stretch => stretch.to - stretch.from <= 18000))
  assert.equal(cut.at(-1).to, long.length)
  assert.equal(long.slice(cut[1].to - 1, cut[1].to), '\n')
  const plain = splitNovel('没有章节的文字。\n'.repeat(5000))
  assert.equal(plain.length, 4)
  assert.equal(plain[0].title, '第 1 段')
  assert.equal(splitNovel('Chapter 1\nA.\nChapter 2\nB.\nChapter 3\nC.').length, 1, 'short chapters go together')
})

test('a stretch is sent with the names noted so far; its answer is a list of notes or nothing', () => {
  const request = extractRequest('她叫林小雨。', '第1章', ['林小雨', '便利店'])
  assert.match(request.system, /只输出一个 JSON 数组/)
  assert.match(request.messages[0].content, /^<known>\n林小雨、便利店\n<\/known>\n\n<text title="第1章">\n她叫林小雨。\n<\/text>$/)
  assert.doesNotMatch(extractRequest('x', '第1章').messages[0].content, /<known>/)
  const notes = readExtract('```json\n[{"type": "人物", "name": " 林小雨 ", "aliases": ["小雨", "林小雨", ""], "content": "只在雨夜出现。"}, {"type": "place", "name": "便利店", "content": "街角那家。"}, {"type": "怪东西", "name": "伞", "content": "黑色长柄。"}, {"name": "", "content": "没有名字"}, {"name": "空的"}, "不是对象"]\n```')
  assert.deepEqual(notes, [
    { type: '人物', name: '林小雨', aliases: ['小雨'], content: '只在雨夜出现。' },
    { type: '地点', name: '便利店', aliases: [], content: '街角那家。' },
    { type: '设定', name: '伞', aliases: [], content: '黑色长柄。' },
  ])
  assert.deepEqual(readExtract('[]'), [])
  assert.equal(readExtract('我读不了这一段。'), null)
})

test('the same name, or another way of calling it, gathers its notes; only those noted twice take putting together', () => {
  const notes = []
  gather(notes, readExtract('[{"type": "人物", "name": "林小雨", "aliases": ["小雨"], "content": "雨女。"}, {"type": "地点", "name": "便利店", "content": "街角。"}]'))
  gather(notes, readExtract('[{"type": "人物", "name": "小雨", "aliases": ["雨女"], "content": "话很少。"}, {"type": "人物", "name": "老周", "content": "店长。"}]'))
  gather(notes, readExtract('[{"type": "人物", "name": "雨女", "content": "怕晴天。"}]'))
  assert.deepEqual(notes.map(note => [note.name, note.aliases, note.parts.length]), [['林小雨', ['小雨', '雨女'], 3], ['便利店', [], 1], ['老周', [], 1]])
  const batches = mergeBatches(notes)
  assert.deepEqual(batches.map(batch => batch.map(note => note.name)), [['林小雨']])
  const request = mergeRequest(batches[0])
  assert.match(request.messages[0].content, /^<entry name="林小雨">\n【1】雨女。\n【2】话很少。\n【3】怕晴天。\n<\/entry>$/)
  assert.equal(readMerge('[{"name": "林小雨", "content": "只在雨夜出现的女孩，话很少，怕晴天。"}, {"name": "没给的", "content": ""}]').get('林小雨'), '只在雨夜出现的女孩，话很少，怕晴天。')
  assert.equal(readMerge('不是 JSON').size, 0)
  // Many names with long notes go out a batch at a time.
  const many = Array.from({ length: 6 }, (_, i) => ({ name: `人物${i}`, parts: ['长'.repeat(2500), '长'.repeat(2500)] }))
  assert.deepEqual(mergeBatches(many).map(batch => batch.length), [2, 2, 2])
})

test('the entries become a book found by name, a kind after another', () => {
  const book = novelBook('雨宿', [
    { type: '地点', name: '便利店', aliases: [], content: '街角。' },
    { type: '人物', name: '林小雨', aliases: ['小雨', '雨'], content: '雨女。' },
    { type: '物品', name: '伞', aliases: [], content: '黑色长柄。' },
  ])
  assert.equal(book.name, '雨宿')
  assert.deepEqual(book.entries.map(entry => [entry.comment, entry.keys, entry.constant, entry.enabled]), [
    ['人物：林小雨', ['林小雨', '小雨'], false, true],
    ['地点：便利店', ['便利店'], false, true],
    // A name of one character is all this one has to be found by.
    ['物品：伞', ['伞'], false, true],
  ])
  const estimate = novelEstimate(NOVEL, splitNovel(NOVEL), 1)
  assert.equal(estimate.stretches, 2)
  assert.ok(estimate.input > 5000 && estimate.output > 0)
})

async function tavern(t, answer) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-novel-'))
  const seen = []
  const model = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(json)
    const text = await answer(json, seen.length)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }))
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    model.close()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  const settled = async () => {
    let view
    for (let i = 0; i < 400; i++) {
      view = (await call('/api/novel')).body
      if (!view.novel?.job) return view.novel
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('the reading never ended')
  }
  return { call, seen, settled, app }
}

test('a novel is cut and kept without a request, read as far as asked, taken up again, put together and made a book', async t => {
  const stretchOf = json => Number(/第(\d)章/.exec(json.messages.at(-1).content.split('<text')[1] ?? '')?.[1] ?? 0)
  const { call, seen, settled, app } = await tavern(t, json => {
    if (json.messages[0].content.includes('整理世界书条目')) return '[{"name": "林小雨", "content": "只在雨夜出现的女孩；话很少；怕晴天。"}]'
    const at = stretchOf(json)
    if (at === 1) return '[{"type": "人物", "name": "林小雨", "aliases": ["小雨"], "content": "只在雨夜出现的女孩。"}, {"type": "地点", "name": "便利店", "content": "街角那家。"}]'
    if (at === 3) return '[{"type": "人物", "name": "小雨", "content": "话很少。"}]'
    return '[{"type": "人物", "name": "林小雨", "content": "怕晴天。"}, {"type": "事件", "name": "停电", "content": "整条街停电。"}]'
  })
  assert.equal((await call('/api/novel')).body.novel, null)
  assert.equal((await call('/api/novel', { method: 'POST', body: { name: '太短.txt', text: '就一句。' } })).status, 400)

  const started = (await call('/api/novel', { method: 'POST', body: { name: '雨宿.txt', text: `﻿${NOVEL.replace(/\n/g, '\r\n')}` } })).body.novel
  assert.deepEqual([started.name, started.stretches.length, started.done, started.stage, started.limit], ['雨宿', 3, 0, 'reading', 3])
  assert.equal(started.estimate.ready, true)
  assert.equal(started.estimate.stretches, 3)
  assert.equal(seen.length, 0, 'choosing a file sends nothing')

  // The first stretch only, to try it.
  assert.equal((await call('/api/novel', { method: 'PUT', body: { limit: 1 } })).body.novel.estimate.stretches, 1)
  await call('/api/novel/run', { method: 'POST' })
  const tried = await settled()
  assert.deepEqual([tried.done, tried.stage, tried.error], [1, 'ready', ''])
  assert.equal(tried.rest.stretches, 2, 'what is past the part asked for can be read on')
  assert.ok(tried.rest.input > 0)
  assert.deepEqual(tried.entries.map(entry => [entry.type, entry.name, entry.parts]), [['人物', '林小雨', 1], ['地点', '便利店', 1]])
  assert.equal(seen.length, 1, 'one noted once needs no putting together')
  assert.match(seen[0].messages.at(-1).content, /<text title="第1章 雨夜之1 … 第2章 雨夜之2">\n第1章/)

  // All of it: read on from the second stretch, with the names noted so far; then the name noted three times is put together.
  await call('/api/novel', { method: 'PUT', body: { limit: 0 } })
  await call('/api/novel/run', { method: 'POST' })
  const read = await settled()
  assert.deepEqual([read.done, read.stage, read.failed], [3, 'ready', []])
  assert.equal(read.rest.stretches, 0)
  assert.equal(seen.length, 4, 'two more stretches and one request to put together')
  assert.match(seen[1].messages.at(-1).content, /<known>\n林小雨、便利店\n<\/known>/)
  assert.match(seen[3].messages.at(-1).content, /<entry name="林小雨">\n【1】只在雨夜出现的女孩。\n【2】话很少。\n【3】怕晴天。/)
  const she = read.entries.find(entry => entry.name === '林小雨')
  assert.deepEqual([she.content, she.parts, she.aliases], ['只在雨夜出现的女孩；话很少；怕晴天。', 3, ['小雨']])
  assert.deepEqual(read.counts, { 人物: 1, 地点: 1, 势力: 0, 物品: 0, 设定: 0, 事件: 1 })
  // Run again with nothing left: no request.
  await call('/api/novel/run', { method: 'POST' })
  await settled()
  assert.equal(seen.length, 4)

  // A book of what is picked; the novel stays till it is dropped.
  assert.equal((await call('/api/novel/save', { method: 'POST', body: { picked: [] } })).status, 400)
  const saved = (await call('/api/novel/save', { method: 'POST', body: { name: '雨宿的世界', picked: ['林小雨', '停电'] } })).body
  assert.deepEqual([saved.name, saved.entries], ['雨宿的世界', 2])
  const book = await app.store.getBook(saved.id)
  assert.deepEqual(book.entries.map(entry => [entry.comment, entry.keys]), [['人物：林小雨', ['林小雨', '小雨']], ['事件：停电', ['停电']]])
  assert.equal((await call('/api/novel')).body.novel.name, '雨宿')
  assert.equal((await call('/api/novel', { method: 'DELETE' })).body.novel, null)
  assert.equal((await call('/api/novel')).body.novel, null)
})

test('a stretch that will not read is asked for once more, then left out and named; the rest goes on', async t => {
  const { call, seen, settled } = await tavern(t, (json, n) => (n <= 2 ? '我读不了。' : '[{"type": "地点", "name": "便利店", "content": "街角那家。"}]'))
  await call('/api/novel', { method: 'POST', body: { name: '雨宿.txt', text: NOVEL } })
  await call('/api/novel/run', { method: 'POST' })
  const read = await settled()
  assert.deepEqual([read.done, read.failed, read.stage], [3, [1], 'ready'])
  assert.equal(seen.length, 5, 'the first stretch twice, the other two, and the place noted twice put together')
  assert.deepEqual(read.entries.map(entry => [entry.name, entry.parts]), [['便利店', 2]])
})
