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
import { bookSource, digestMaterial, digestRequest, extractRequest, gather, MAX_NOVEL, mergeBatches, mergeRequest, novelBook, novelEstimate, novelMaterial, readDigest, readExtract, readMerge, rosterText, splitNovel } from '../server/forge/novel.mjs'

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
    // A name of one character is in every other sentence: its entry is kept, but off, for the player to give a longer keyword.
    ['物品：伞', ['伞'], false, false],
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
  // One at a time, so that the first two answers are the first stretch's.
  assert.equal((await call('/api/novel', { method: 'PUT', body: { parallel: 1 } })).body.novel.parallel, 1)
  await call('/api/novel/run', { method: 'POST' })
  const read = await settled()
  assert.deepEqual([read.done, read.failed, read.stage], [3, [1], 'ready'])
  assert.equal(seen.length, 5, 'the first stretch twice, the other two, and the place noted twice put together')
  assert.deepEqual(read.entries.map(entry => [entry.name, entry.parts]), [['便利店', 2]])
})

test('stretches are read several at once, their notes still gathered in the book order', async t => {
  const stretchOf = json => Number(/第(\d)章/.exec(json.messages.at(-1).content.split('<text')[1] ?? '')?.[1] ?? 0)
  let open = 0
  let most = 0
  const { call, seen, settled } = await tavern(t, async json => {
    if (json.messages[0].content.includes('整理世界书条目')) return '[{"name": "林小雨", "content": "合成的一条。"}]'
    open += 1
    most = Math.max(most, open)
    const at = stretchOf(json)
    // The second stretch answers after the third.
    await new Promise(resolve => setTimeout(resolve, at === 3 ? 150 : 20))
    open -= 1
    return `[{"type": "人物", "name": "林小雨", "content": "第${at}章的笔记。"}]`
  })
  await call('/api/novel', { method: 'POST', body: { name: '雨宿.txt', text: NOVEL } })
  assert.equal((await call('/api/novel')).body.novel.parallel, 3, 'three at once unless picked')
  assert.equal((await call('/api/novel', { method: 'PUT', body: { parallel: 99 } })).body.novel.parallel, 8)
  await call('/api/novel/run', { method: 'POST' })
  const read = await settled()
  assert.deepEqual([read.done, read.failed, read.stage, read.error], [3, [], 'ready', ''])
  // The first alone, for its names; then the other two at once, each with them.
  assert.equal(most, 2, 'the two after the first were out at once')
  const reads = seen.filter(json => !json.messages[0].content.includes('整理世界书条目'))
  assert.equal(reads[0].messages.at(-1).content.includes('<known>'), false)
  assert.ok(reads.slice(1).every(json => json.messages.at(-1).content.includes('<known>\n林小雨\n</known>')))
  const merge = seen.find(json => json.messages[0].content.includes('整理世界书条目'))
  assert.match(merge.messages.at(-1).content, /【1】第1章的笔记。\n【2】第3章的笔记。\n【3】第5章的笔记。/, 'the slow second stretch still comes before the third')
  assert.equal(read.entries[0].content, '合成的一条。')
})

// ─── 从小说开始 (plans/18): the 梗概 and 名录 a card is made from ───────────────────────────────────

const BOOK = [
  { type: '人物', name: '林小雨', aliases: ['小雨'], content: '只在雨夜出现的女孩。话很少，怕晴天。', parts: 9 },
  { type: '人物', name: '店长', aliases: [], content: '便利店的店长，总在算账。', parts: 2 },
  { type: '地点', name: '便利店', aliases: [], content: '街角那家，二十四小时开着。', parts: 5 },
  { type: '事件', name: '停电', aliases: [], content: '整条街停电，只有便利店亮着。', parts: 1 },
  { type: '事件', name: '放晴', aliases: [], content: '雨停的那天她没有来。', parts: 1 },
]

test('the 梗概 is written from the entries met most, the events in the book\'s order; an answer is its text', () => {
  const material = digestMaterial(BOOK)
  assert.match(material, /<人物>\n- 林小雨（小雨）：只在雨夜出现的女孩。话很少，怕晴天。\n- 店长：/)
  assert.ok(material.indexOf('停电') < material.indexOf('放晴'), 'events as they came')
  const request = digestRequest('雨宿', BOOK)
  assert.match(request.system, /主线/)
  assert.match(request.messages[0].content, /^<book name="雨宿">\n<人物>/)
  assert.equal(readDigest('```markdown\n## 世界和基调\n雨。\n```'), '## 世界和基调\n雨。')
  assert.equal(readDigest('x'.repeat(20000)).length, 8000)
})

test('the 名录 names every entry, the ones met most with a line; with no room the lines go, never the names', () => {
  const roster = rosterText(BOOK)
  assert.match(roster, /【人物】2 个\n- 林小雨（小雨）：只在雨夜出现的女孩\n- 店长：便利店的店长，总在算账/)
  assert.match(roster, /【事件】2 个/)
  const many = Array.from({ length: 400 }, (_, i) => ({ type: '人物', name: `路人${i}`, aliases: [], content: '一个路过的人，说了很长很长的一段话。', parts: 400 - i }))
  const tight = rosterText(many, 4000)
  assert.ok(tight.length <= 4000)
  assert.match(tight, /路人0/)
  assert.match(tight, /路人399/, 'the least met is still named')
  const material = novelMaterial({ name: '雨宿', digest: '## 主线\n她来了，又走了。', entries: BOOK })
  assert.match(material, /^这是小说《雨宿》整理出来的资料，不是原文。书里一共记了 5 个条目/)
  assert.match(material, /# 梗概\n## 主线\n她来了，又走了。\n\n# 名录\n【人物】/)
  assert.match(novelMaterial({ name: '雨宿', digest: '', entries: BOOK }), /不是原文[^#]*\n\n# 名录/, 'one with no 梗概 yet has its 名录 alone')
})

test('a book carries its 梗概 as an entry always there, and gives it back with its kinds when a card starts from it', () => {
  const book = novelBook('雨宿的世界', BOOK, '## 主线\n她来了，又走了。')
  const digest = book.entries.find(entry => entry.comment === '梗概：雨宿的世界')
  assert.deepEqual([digest.constant, digest.content, digest.keys], [true, '## 主线\n她来了，又走了。', []])
  assert.equal(book.entries.filter(entry => entry.constant).length, 1)
  assert.equal(novelBook('雨宿的世界', BOOK).entries.length, 5, 'no 梗概, no entry for it')
  const source = bookSource(book)
  assert.equal(source.digest, '## 主线\n她来了，又走了。')
  assert.deepEqual(source.entries.map(entry => [entry.type, entry.name, entry.aliases]), [['人物', '林小雨', ['小雨']], ['人物', '店长', []], ['地点', '便利店', []], ['事件', '停电', []], ['事件', '放晴', []]])
  // A book from elsewhere: its comments are names, what has none goes by its first keyword, what is off stays out.
  const other = bookSource({ name: '别处的书', entries: [{ comment: '青梧山', keys: ['青梧山', '青梧'], content: '一座山。', constant: true }, { comment: '', keys: ['灵石'], content: '钱。' }, { comment: '关掉的', keys: [], content: '不用。', enabled: false }, { comment: '空的', keys: [], content: ' ' }] })
  assert.deepEqual(other.entries.map(entry => [entry.type, entry.name, entry.aliases, entry.parts]), [['设定', '青梧山', ['青梧'], 3], ['设定', '灵石', [], 1]])
})

test('从小说开始: the novel read gets its 梗概 on asking, and a card begun from it reads the 梗概 and 名录, the entries kept beside the draft', async t => {
  const { call, seen, settled, app } = await tavern(t, json => {
    const system = json.messages[0].content
    if (system.includes('写梗概')) return '## 主线\n她在雨夜来，天晴就走。'
    if (system.includes('整理世界书条目')) return '[{"name": "林小雨", "content": "只在雨夜出现的女孩；怕晴天。"}]'
    if (system.includes('整理成角色扮演用的世界书')) return '[{"type": "人物", "name": "林小雨", "content": "只在雨夜出现的女孩。"}, {"type": "地点", "name": "便利店", "content": "街角那家。"}]'
    return '好，我们来聊聊这张卡。'
  })
  const draftSettled = async id => {
    for (let i = 0; i < 400; i++) {
      const view = (await call(`/api/forge/${id}`)).body
      if (!view.job) return view
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('the draft never settled')
  }
  assert.equal((await call('/api/forge', { method: 'POST', body: { source: 'novel' } })).status, 404, 'no novel, no card from one')
  await call('/api/novel', { method: 'POST', body: { name: '雨宿.txt', text: NOVEL } })
  assert.equal((await call('/api/novel/digest', { method: 'POST' })).status, 409, 'nothing read, nothing to tell of')
  assert.equal((await call('/api/forge', { method: 'POST', body: { source: 'novel' } })).status, 409)
  await call('/api/novel/run', { method: 'POST' })
  const read = await settled()
  assert.deepEqual([read.stage, read.digest, read.digestStale], ['ready', '', false])
  const before = seen.length

  await call('/api/novel/digest', { method: 'POST' })
  const told = await settled()
  assert.deepEqual([told.digest, told.digestStale, told.error], ['## 主线\n她在雨夜来，天晴就走。', false, ''])
  assert.equal(seen.length, before + 1, 'one request')
  assert.match(seen.at(-1).messages.at(-1).content, /<book name="雨宿">\n<人物>\n- 林小雨：只在雨夜出现的女孩；怕晴天。/)
  // The player's own words for it stay.
  const edited = (await call('/api/novel', { method: 'PUT', body: { digest: '  ## 主线\n改过的。 ' } })).body.novel
  assert.equal(edited.digest, '## 主线\n改过的。')

  // A card from it: no words needed, the first turn is sent with the 梗概 and the 名录.
  const draft = (await call('/api/forge', { method: 'POST', body: { source: 'novel' } })).body
  // Where each entry was read is known, so the card can take the book as far as any of the stretches.
  assert.deepEqual(draft.source, { from: 'novel', name: '雨宿', count: 2, stretches: ['第1章 雨夜之1 … 第2章 雨夜之2', '第3章 雨夜之3 … 第4章 雨夜之4', '第5章 雨夜之5 … 第6章 雨夜之6'] })
  assert.equal((await call(`/api/forge/${draft.id}`, { method: 'PUT', body: { sourceUntil: 2 } })).body.source.until, 2)
  assert.equal((await call(`/api/forge/${draft.id}`, { method: 'PUT', body: { sourceUntil: 9 } })).body.source.until, 0, 'the last stretch or past it is all of the book')
  assert.equal(draft.rounds[0].user.text, '我想照《雨宿》做一张卡')
  assert.deepEqual(draft.references.map(reference => [reference.kind, reference.name]), [['novel', '雨宿']])
  await draftSettled(draft.id)
  const sent = JSON.stringify(seen.at(-1).messages)
  assert.match(sent, /<reference type=\\"小说资料\\" name=\\"雨宿\\">/)
  assert.match(sent, /# 梗概\\n## 主线\\n改过的。/)
  assert.match(sent, /这张卡照这部小说做：.*想怎么玩.*故事从哪里开始/, 'the guide is told what to ask of a novel')
  assert.match(sent, /【人物】1 个\\n- 林小雨：只在雨夜出现的女孩\\n/)
  assert.doesNotMatch(sent, /街角那家。<\/entry>/)
  const { readFile, stat } = await import('node:fs/promises')
  const sourceFile = path.join(app.store.dirs.root, 'forge', `${draft.id}.source.json`)
  const kept = JSON.parse(await readFile(sourceFile, 'utf8'))
  assert.deepEqual([kept.name, kept.digest, kept.entries.map(entry => entry.name)], ['雨宿', '## 主线\n改过的。', ['林小雨', '便利店']])

  // The book made of it has the 梗概; a card can start from that book as well.
  const saved = (await call('/api/novel/save', { method: 'POST', body: { name: '雨宿的世界' } })).body
  assert.equal(saved.entries, 3)
  const again = (await call('/api/forge', { method: 'POST', body: { text: '同一个世界的新故事', source: { bookId: saved.id } } })).body
  assert.deepEqual(again.source, { from: 'book', name: '雨宿的世界', count: 2, bookId: saved.id })
  assert.equal(again.rounds[0].user.text, '同一个世界的新故事')
  await draftSettled(again.id)
  assert.match(JSON.stringify(seen.at(-1).messages), /这是小说《雨宿的世界》整理出来的资料[^#]*# 梗概\\n## 主线\\n改过的。/)
  assert.equal((await call('/api/forge', { method: 'POST', body: { source: { bookId: 'nope' } } })).status, 404)

  // A draft dropped takes its book along.
  await call(`/api/forge/${draft.id}`, { method: 'DELETE' })
  await assert.rejects(stat(sourceFile))
})

test('a note goes to the one it names before one that shares an alias; an alias that is another entry\'s name, or claimed twice, is put right', async () => {
  const { entriesOf } = await import('../server/forge/novel.mjs')
  // The model once called the river 老梁. The watchman's own notes still go to the watchman.
  const notes = gather([], [{ type: '人物', name: '清河', aliases: ['老梁'], content: '河龙。' }])
  gather(notes, [{ type: '人物', name: '梁更夫', aliases: ['老梁'], content: '打更的。' }])
  gather(notes, [{ type: '人物', name: '梁更夫', aliases: [], content: '在水关里。' }])
  gather(notes, [{ type: '人物', name: '老梁', aliases: ['梁更夫'], content: '会打五更。' }])
  assert.deepEqual(notes.map(note => [note.name, note.parts.length]), [['清河', 1], ['梁更夫', 3]])
  // 老梁 is claimed by both: it stays with the one met less. 团儿's alias 阿蛮 is another entry's name: it is 阿蛮's.
  gather(notes, [{ type: '人物', name: '清河', aliases: [], content: '三千七百岁。' }, { type: '人物', name: '清河', aliases: [], content: '住河底。' }, { type: '人物', name: '清河', aliases: [], content: '行雨。' }])
  gather(notes, [{ type: '人物', name: '团儿', aliases: [], content: '范老篾的女儿。' }, { type: '人物', name: '阿蛮', aliases: [], content: '转生后的名字。' }, { type: '人物', name: '团儿', aliases: ['阿蛮', '范团儿'], content: '八岁出痘。' }])
  const entries = entriesOf(notes)
  assert.deepEqual(entries.map(entry => [entry.name, entry.aliases]), [['清河', []], ['梁更夫', ['老梁']], ['团儿', ['范团儿']], ['阿蛮', []]])
  // What reading comes to: what is written back is counted by the text, not a flat number a stretch.
  const stretches = splitNovel(NOVEL)
  const estimate = novelEstimate(NOVEL, stretches)
  assert.ok(estimate.output > estimate.input * 0.5, 'a dense novel writes back about as much as it reads')
  assert.ok(estimate.outputMost >= estimate.output * 2, 'a model that thinks a lot: about twice')
  // Each stretch carries what it comes to: the estimate needs no text; one kept from before that does not, still reads it.
  assert.ok(stretches.every(stretch => stretch.tokens > 0))
  assert.deepEqual(novelEstimate('', stretches), estimate)
  assert.deepEqual(novelEstimate(NOVEL, stretches.map(({ tokens, ...stretch }) => stretch)), estimate)
})

test('the longest novel read, in chapters a little over half a stretch, cuts into fewer stretches than are read', () => {
  // Two such chapters do not fit in one stretch, so each is one: the most stretches 5 000 000 characters can make.
  const chapter = i => `第${i + 1}章 雨\n${'雨一直下。\n'.repeat(1000)}`
  const text = Array.from({ length: Math.floor(MAX_NOVEL / chapter(0).length) }, (_, i) => chapter(i)).join('')
  assert.ok(text.length <= MAX_NOVEL)
  const stretches = splitNovel(text)
  assert.ok(stretches.length > 700 && stretches.length < 1000, String(stretches.length))
  assert.equal(stretches.at(-1).to, text.length, 'the end of the book is read too')
})

test('what anyone may be called is no alias of one person; a name is never dropped for it', async () => {
  const { entriesOf } = await import('../server/forge/novel.mjs')
  const notes = gather([], [
    { type: '人物', name: '沈观', aliases: ['先生', '算盘先生', '师爷', '沈先生'], content: '看客。' },
    { type: '人物', name: '老头', aliases: ['老人家', '臭棋老头'], content: '村里下棋的，没有名字。' },
  ])
  assert.deepEqual(entriesOf(notes).map(entry => [entry.name, entry.aliases]), [['沈观', ['算盘先生', '沈先生']], ['老头', ['臭棋老头']]])
  assert.match(extractRequest('正文', '第一章').system, /谁都能叫的称呼不写/)
})
