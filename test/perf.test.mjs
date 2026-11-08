// 性能记录 and what it found slow in a chat of hundreds of rounds: the active path walked once (not a scan of every
// node per step), the chat list read from a summary kept while a file is unchanged, the frames off the screen
// made only when they come near, messages that show the same kept at a redraw, one reading of a chat's file per open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { activePath, chatView, childIndex, childrenOf, foldedTurns } from '../server/chats.mjs'
import { createStore } from '../server/store.mjs'
import { span, timed, trace, traced, traceReport } from '../server/perf.mjs'
import { storyDay, timesIn } from '../web/shared/vn.js'
import { createApp } from '../server/http.mjs'

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const read = file => readFileSync(path.join(web, file), 'utf8').replace(/\r\n/g, '\n')

/** A chat of `rounds` rounds, a second version of every fifth reply, and a rollback `cutAt` rounds from the end. */
function longChat(rounds, { cutAt = 0 } = {}) {
  const nodes = { root: { id: 'root', parent: null, role: 'assistant', text: '开场', display: '开场', state: {}, createdAt: '2026-01-01T00:00:00.000Z' } }
  let parent = 'root'
  let clock = 0
  const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString()
  for (let i = 1; i <= rounds; i++) {
    const user = { id: `u${i}`, parent, role: 'user', text: `第${i}轮`, createdAt: stamp() }
    const reply = { id: `a${i}`, parent: user.id, role: 'assistant', text: `回复${i}`, display: `回复${i}`, state: { n: i }, createdAt: stamp() }
    nodes[user.id] = user
    nodes[reply.id] = reply
    if (i % 5 === 0) {
      // An older version first, then the one the path takes (`sel`).
      nodes[`b${i}`] = { id: `b${i}`, parent: user.id, role: 'assistant', text: `旧版${i}`, display: `旧版${i}`, state: {}, createdAt: new Date(Date.parse(reply.createdAt) - 500).toISOString() }
      user.sel = reply.id
    }
    parent = reply.id
  }
  if (cutAt) nodes[`a${rounds - cutAt}`].cut = true
  return { id: 'c1', cardId: 'k1', title: 't', names: { char: '她', user: '你' }, systemPrompt: '', nodes, createdAt: '', updatedAt: '' }
}

// The walk as it was: childrenOf at each step.
function pathTheOldWay(chat) {
  const path = []
  const seen = new Set()
  let node = chat.nodes.root
  while (node && !seen.has(node)) {
    seen.add(node)
    path.push(node)
    if (node.cut) break
    const kids = childrenOf(chat, node.id)
    node = kids.find(kid => kid.id === node.sel) ?? kids.at(-1) ?? null
  }
  return path
}

test('the active path comes out as before, walked once over an index of children', () => {
  for (const chat of [longChat(40), longChat(40, { cutAt: 6 })]) {
    assert.deepEqual(activePath(chat).map(node => node.id), pathTheOldWay(chat).map(node => node.id))
    const index = childIndex(chat)
    for (const id of ['root', 'u5', 'u7', 'a40']) assert.deepEqual((index.get(id) ?? []).map(node => node.id), childrenOf(chat, id).map(node => node.id))
  }
  assert.equal(foldedTurns(longChat(40, { cutAt: 6 })), 6)
  assert.equal(foldedTurns(longChat(40)), 0)
  // A damaged file whose nodes go round in a circle still ends.
  const loop = longChat(3)
  loop.nodes.root.parent = 'a3'
  assert.equal(activePath(loop).length, 7)
})

test('a chat of 600 rounds is viewed in well under the time the walk node by node took', () => {
  const chat = longChat(600)
  const view = chatView(chat)
  assert.equal(view.path.length, 1201)
  assert.equal(view.path.find(node => node.id === 'a5').siblingCount, 2)
  assert.deepEqual(view.path.find(node => node.id === 'a5').siblingIds, ['b5', 'a5'])
  const started = performance.now()
  for (let i = 0; i < 5; i++) chatView(chat)
  // The old walk took seconds here (1801 nodes, each step a scan of all of them, sorted).
  assert.ok((performance.now() - started) / 5 < 250, 'chatView of a 600-round chat')
})

test('the chat list is read from summaries kept while each file stays as it was', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-perf-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root, { subscription: false })
  await store.init()
  let summaries = 0
  const summarize = chat => {
    summaries++
    return { id: chat.id, title: chat.title, turns: Object.values(chat.nodes).filter(node => node.role === 'user').length }
  }
  const a = { ...longChat(3), id: 'aaaaaaaaaaaaaaaa', cardId: 'k1' }
  const b = { ...longChat(2), id: 'bbbbbbbbbbbbbbbb', cardId: 'k2' }
  const trial = { ...longChat(1), id: 'cccccccccccccccc', cardId: 'k1', trial: true }
  for (const chat of [a, b, trial]) await store.saveChat(chat)
  const first = await store.chatHeads('k1', summarize)
  assert.deepEqual(first.map(head => [head.id, head.trial]).sort(), [['aaaaaaaaaaaaaaaa', false], ['cccccccccccccccc', true]])
  assert.equal(summaries, 3)
  // Asked again with nothing changed: no file read.
  assert.equal((await store.chatHeads(null, summarize)).length, 3)
  assert.equal(summaries, 3)
  // One saved again: only that one.
  a.title = '改过的标题'
  await store.saveChat(a)
  const again = await store.chatHeads('k1', summarize)
  assert.equal(summaries, 4)
  assert.equal(again.find(head => head.id === a.id).summary.title, '改过的标题')
  // Newest first; a deleted one is gone.
  assert.equal(again[0].id, a.id)
  await store.deleteChat(trial.id)
  assert.deepEqual((await store.chatHeads('k1', summarize)).map(head => head.id), [a.id])
  // A file written by something else (an import, a copy) counts as changed.
  await writeFile(path.join(root, 'chats', `${b.id}.json`), JSON.stringify({ ...b, title: '别处写的' }))
  assert.equal((await store.chatHeads('k2', summarize))[0].summary.title, '别处写的')
})

test('the server keeps timings only for a request asked to be timed', async () => {
  // Outside a trace: nothing kept, nothing to report.
  span('chat.read')()
  assert.equal(trace(), undefined)
  assert.equal(traceReport(), null)
  const report = await traced(true, async () => {
    const end = span('chat.read')
    await new Promise(resolve => setTimeout(resolve, 5))
    end({ nodes: 10 })
    span('chat.read')({ nodes: 12 })
    await timed('prompt', async () => 'x')
    return traceReport()
  })
  const read = report.spans.find(item => item.name === 'chat.read')
  assert.equal(read.count, 2)
  assert.equal(read.nodes, 12)
  assert.ok(read.ms >= 4)
  assert.ok(report.spans.some(item => item.name === 'prompt'))
  assert.ok(report.total >= read.ms)
  assert.equal(await traced(false, async () => trace()), undefined)
})

test('a chat opened with its frame info, and timed when the page records', async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-perf-app-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(() => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
  })
  const base = `http://127.0.0.1:${server.address().port}/api`
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const card = await (await fetch(`${base}/cards/import`, { method: 'POST', headers, body: JSON.stringify({ filename: 'a.json', data: Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '她', first_mes: '雨。' } })).toString('base64') }) })).json()
  const chat = await (await fetch(`${base}/chats`, { method: 'POST', headers, body: JSON.stringify({ cardId: card.id }) })).json()

  const plain = await fetch(`${base}/chats/${chat.id}`)
  assert.equal(plain.headers.get('x-perf-trace'), null, 'not timed unless asked')
  assert.equal((await plain.json()).frameInfo, undefined)

  const timedOpen = await fetch(`${base}/chats/${chat.id}?frameInfo=1`, { headers: { 'x-perf': '1' } })
  const view = await timedOpen.json()
  const frameInfo = await (await fetch(`${base}/chats/${chat.id}/frame-info`)).json()
  assert.deepEqual(view.frameInfo, frameInfo)
  const report = JSON.parse(decodeURIComponent(timedOpen.headers.get('x-perf-trace')))
  assert.deepEqual(report.spans.map(item => item.name).filter(name => ['chat.read', 'chat.view', 'json'].includes(name)).sort(), ['chat.read', 'chat.view', 'json'])
  assert.equal(report.spans.filter(item => item.name === 'chat.read').length, 1, 'one reading of the file for both')
  assert.equal(report.spans.find(item => item.name === 'chat.read').count, 1)

  const list = await fetch(`${base}/chats?cardId=${card.id}`, { headers: { 'x-perf': '1' } })
  assert.equal((await list.json())[0].id, chat.id)
  assert.ok(JSON.parse(decodeURIComponent(list.headers.get('x-perf-trace'))).spans.some(item => item.name === 'chat.list'))
})

test('the day a story has reached counts on from an earlier count, and the times of a reply are read once', () => {
  const replies = ['<time_box>第1天｜茶馆</time_box>雨。', '次日清晨，雨停了。', '<time_box>第3天｜渡口</time_box>风。', '没有日期。']
  assert.deepEqual(storyDay(replies.slice(2), storyDay(replies.slice(0, 2))), storyDay(replies))
  const times = timesIn(replies[2])
  times.push('changed by the caller')
  assert.deepEqual(timesIn(replies[2]), timesIn(replies[2]).slice(), 'a copy each time')
  assert.notDeepEqual(timesIn(replies[2]), times)
})

test('the page: frames off the screen wait as slots, kept messages, one drawing per open, broadcasts to loaded frames', () => {
  const app = read('app.js')
  const render = read('render.js')
  // Slots made into frames as their message comes near the screen.
  assert.match(app, /toggle\('near', isIntersecting\)\s*\n\s*if \(isIntersecting\) fillFrameSlots\(target\)/)
  assert.match(app, /lazy \? frameSlot\(part\.body, context\) : htmlFrame\(part\.body, context\(\)\)/)
  assert.match(render, /export function frameSlot\(body, context = \(\) => null\)/)
  // A message whose drawing would be the same is kept; the latest reply and one with a frame made are drawn again.
  assert.match(app, /old\.sig === sig && !old\.article\.querySelector\('iframe'\)/)
  assert.match(app, /const fresh = lastAt < 0 \|\| index >= lastAt/)
  // Buttons that wait while a turn is written follow ui.generating on kept messages too.
  assert.match(app, /function lockWhileWriting\(box\)/)
  // (The options under the latest reply are drawn anew each time: they may read it directly.)
  assert.doesNotMatch(app.slice(app.indexOf('function renderNode('), app.indexOf('// When each reply\'s 想起 line')), /el\('button', \{[^\n]*disabled: ui\.generating/)
  // Its rules and the card's regex loaded before the chat is drawn, once.
  assert.match(app, /await Promise\.all\(\[loadRules\(view\), loadCardDetail\(view\.cardId\), loadPresetDetail\(view\.presetId\)\]\)\s*\n\s*followServerTurn\(view\)\s*\n\s*setChat\(view\)/)
  // Told only to frames that have loaded.
  const compat = read('compat.js')
  assert.doesNotMatch(compat, /document\.querySelectorAll\('iframe\.card-frame'\)\) frame\.contentWindow/)
  assert.match(render, /frame\.dataset\.loaded = ''/)
  // A reply streaming is drawn by the reveal (at most once a frame), each drawing timed as 逐字刷新; the reply's
  // element is looked up again only once it is gone.
  assert.match(app, /timer: \(\) => perf\.start\('live'\)/)
  assert.match(app, /if \(!liveArticle\?\.isConnected \|\| !liveArticle\.classList\.contains\('streaming'\)\) liveArticle = box\.querySelector\('\.msg\.streaming'\)/)
})

test('the recorder does nothing while off, and gathers an action\'s spans while on', async () => {
  globalThis.requestAnimationFrame ??= callback => setTimeout(() => callback(performance.now()), 1)
  globalThis.screen ??= { width: 1280, height: 800 }
  globalThis.devicePixelRatio ??= 1
  const { perf, perfHeaders, perfReport } = await import('../web/render.js')
  assert.equal(perf.on, false)
  assert.equal(perfHeaders(), null)
  const noop = perf.begin('switch', 'x')
  assert.equal(noop, perf.start('render'), 'one function that does nothing, made once')
  noop()
  assert.equal(perf.actions().length, 0)

  perf.setOn(true)
  assert.deepEqual(perfHeaders(), { 'x-perf': '1' })
  const done = perf.begin('switch', '林青禾')
  // Opening its chat is part of switching to the card.
  const inner = perf.begin('open', 'chat', { within: ['switch'] })
  for (let i = 0; i < 3; i++) perf.start('regex')()
  perf.start('messages', { messages: 300 })({ reused: 290 })
  perf.server('/api/chats/abc?frameInfo=1', { total: 12, spans: [{ name: 'chat.read', ms: 9, count: 1 }] })
  inner()
  done()
  await new Promise(resolve => setTimeout(resolve, 30))
  const [action] = perf.actions()
  assert.equal(perf.actions().length, 1)
  assert.equal(action.kind, 'switch')
  assert.equal(action.done, true)
  assert.equal(action.spans.find(item => item.name === 'regex').count, 3)
  assert.deepEqual([action.spans.find(item => item.name === 'messages').messages, action.spans.find(item => item.name === 'messages').reused], [300, 290])
  assert.equal(action.server[0].path, '/api/chats/abc')
  const report = perfReport({ version: '9.9.9' })
  assert.equal(report.version, '9.9.9')
  assert.equal(report.actions[0].label, '林青禾')
  perf.setOn(false)
  assert.equal(perfHeaders(), null)
})
