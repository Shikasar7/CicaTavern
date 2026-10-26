// 抽图历史: a picture drawn or uploaded again keeps the ones before it (as many
// as the setting says, the oldest going first), any of them can be taken back
// or deleted, and they go with the chat, the cast member, the scene or the
// card; chat packages carry only the pictures in use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { createApp } from '../server/http.mjs'
import { cleanMedia } from '../server/media.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { cleanKeep, dropImage, dropOldImage, pickImage, redrawImage, withoutOldImages } from '../server/draw-history.mjs'
import { PACKAGE_MAGIC } from '../server/transfer.mjs'

// PNG chunk checksums (zlib.crc32 needs Node 22).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = bytes => {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A real 1×1 PNG of its own colour, so each picture can be told apart. */
function png(n) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, n & 255, (n >> 8) & 255, 7]))), chunk('IEND', Buffer.alloc(0))])
}
const dataUrl = buffer => `data:image/png;base64,${buffer.toString('base64')}`

/** An image endpoint drawing picture 1, 2, 3…, and a helper model for prompts. */
async function fakeModel(t) {
  let drawn = 0
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ model: 'helper', choices: [{ message: { content: 'An empty room.' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    drawn++
    res.end(JSON.stringify({ data: [{ b64_json: png(drawn).toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { base: `http://127.0.0.1:${server.address().port}`, picture: n => png(n) }
}

async function tavern(t, { keep = 2 } = {}) {
  const fake = await fakeModel(t)
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-history-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `${fake.base}/v1`, apiKey: 'sk-history', models: ['helper'] })
  await app.store.saveProviders([provider])
  await app.store.saveSettings({ media: cleanMedia({ helperModel: `${provider.id}/helper`, imageProvider: provider.id, imageModel: 'img', drawHistory: keep }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const bytes = async pathname => {
    const res = await fetch(`${base}${pathname}`)
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null
  }
  const card = { spec: 'chara_card_v2', data: { name: '林青禾', description: '茶馆的女儿', first_mes: '欢迎光临。' } }
  const { id } = (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(card)).toString('base64') } })).body
  const files = async (...parts) => (await readdir(path.join(dataRoot, ...parts)).catch(() => [])).sort()
  return { fake, dataRoot, call, bytes, files, cardId: id }
}

test('a reply\'s pictures: drawn again in place, taken back, one deleted, the oldest past the setting gone', () => {
  const a = { file: 'a.png', prompt: 'p1', backend: 'x', at: '1', note: 'quota low' }
  const b = { file: 'b.png', prompt: 'p1', backend: 'y', at: '2' }
  const c = { file: 'c.png', prompt: 'p2', backend: 'y', at: '3' }
  const other = { file: 'o.png', prompt: 'o', backend: 'x', at: '0' }
  let step = redrawImage([other, a], 'a.png', b, 2)
  assert.deepEqual(step.images, [other, { ...b, history: [{ file: 'a.png', prompt: 'p1', backend: 'x', at: '1' }] }], 'the old one keeps what it was drawn with, not its note')
  assert.deepEqual(step.dropped, [])
  step = redrawImage(step.images, 'b.png', c, 1)
  assert.deepEqual(step.images[1].history.map(item => item.file), ['b.png'])
  assert.deepEqual(step.dropped.map(item => item.file), ['a.png'], 'past what is kept, the oldest goes')
  assert.equal(redrawImage(step.images, 'gone.png', a, 2), null)
  assert.deepEqual(redrawImage([a], 'a.png', b, 0), { images: [b], dropped: [{ file: 'a.png', prompt: 'p1', backend: 'x', at: '1' }] }, 'none kept: the old one goes at once')

  const picked = pickImage(step.images, 'c.png', 'b.png')
  assert.equal(picked[1].file, 'b.png')
  assert.deepEqual(picked[1].history.map(item => item.file), ['c.png'])
  assert.equal(pickImage(step.images, 'c.png', 'nope.png'), null)

  const dropped = dropOldImage(picked, 'b.png', 'c.png')
  assert.deepEqual(dropped.images[1], { file: 'b.png', prompt: 'p1', backend: 'y', at: '2' })
  assert.deepEqual(dropped.dropped.map(item => item.file), ['c.png'])
  assert.deepEqual(dropImage(picked, 'b.png').dropped.map(item => item.file), ['b.png', 'c.png'])
  assert.deepEqual(dropImage(picked, 'nope.png').dropped, [])

  const nodes = withoutOldImages({ n1: { id: 'n1', media: { images: picked } }, n2: { id: 'n2', text: 'x' } })
  assert.deepEqual(nodes.n1.media.images.map(image => Object.keys(image).includes('history')), [false, false])
  assert.deepEqual(nodes.n2, { id: 'n2', text: 'x' })

  assert.equal(cleanKeep('3'), 3)
  assert.equal(cleanKeep(99), 20)
  assert.equal(cleanKeep(-1), 0)
  assert.equal(cleanKeep(undefined, 5), 5)
  assert.equal(cleanMedia({}).drawHistory, 5, 'five by default')
  assert.equal(cleanMedia({ drawHistory: 0 }).drawHistory, 0)
})

test('chat pictures: 重画 keeps the old ones on the reply, any comes back or goes, packages carry none, deleting the chat takes them', async t => {
  const { call, bytes, files, cardId, dataRoot, fake } = await tavern(t, { keep: 2 })
  const chat = (await call('/api/chats', { method: 'POST', body: { cardId } })).body
  const node = chat.path.find(item => item.role === 'assistant')
  const draw = async body => (await call(`/api/chats/${chat.id}/nodes/${node.id}/image`, { method: 'POST', body: { prompt: 'a teahouse', ...body } })).body
  const shown = view => view.path.find(item => item.id === node.id).media.images
  // Picture 1, then drawn again three times over whatever is shown.
  const drawn = [await draw({})]
  for (let i = 0; i < 3; i++) drawn.push(await draw({ replace: shown(drawn.at(-1).chat)[0].file }))
  const [one, two, three, four] = drawn.map(result => result.image.file)
  // One picture shown (4), the two before it kept, the first one gone from disk.
  let view = drawn.at(-1).chat
  let [image] = shown(view)
  assert.equal(shown(view).length, 1)
  assert.equal(image.file, four)
  assert.deepEqual(await bytes(`/api/media/${chat.id}/${four}`), fake.picture(4))
  assert.deepEqual(image.history.map(item => item.file), [three, two])
  assert.equal(image.history[0].prompt, 'a teahouse')
  assert.equal(await bytes(`/api/media/${chat.id}/${one}`), null)
  assert.deepEqual(await files('media', chat.id), [two, three, four].sort())

  // Picture 2 back: it is shown, 4 leads the old ones.
  view = (await call(`/api/chats/${chat.id}/nodes/${node.id}/image/use`, { method: 'POST', body: { file: four, old: two } })).body
  ;[image] = shown(view)
  assert.equal(image.file, two)
  assert.deepEqual(image.history.map(item => item.file), [four, three])
  assert.equal((await call(`/api/chats/${chat.id}/nodes/${node.id}/image/use`, { method: 'POST', body: { file: two, old: 'missing.png' } })).status, 404)

  // One old one deleted: its file goes, the rest stay.
  view = (await call(`/api/chats/${chat.id}/nodes/${node.id}/image?file=${two}&old=${three}`, { method: 'DELETE' })).body
  assert.deepEqual(shown(view)[0].history.map(item => item.file), [four])
  assert.equal(await bytes(`/api/media/${chat.id}/${three}`), null)

  // A package carries the picture in use only.
  const pack = await bytes(`/api/chats/${chat.id}/package`)
  const rest = pack.subarray(PACKAGE_MAGIC.length)
  const length = Number(rest.subarray(0, rest.indexOf(10)).toString())
  const header = JSON.parse(rest.subarray(rest.indexOf(10) + 1, rest.indexOf(10) + 1 + length).toString())
  assert.deepEqual(header.media.map(item => item.file), [two])
  assert.equal(header.chat.nodes[node.id].media.images[0].history, undefined)

  // A fork keeps them all.
  const fork = (await call(`/api/chats/${chat.id}/fork`, { method: 'POST', body: { nodeId: node.id } })).body
  assert.deepEqual(await files('media', fork.id), [two, four].sort())

  // The picture deleted: its old ones with it.
  view = (await call(`/api/chats/${chat.id}/nodes/${node.id}/image?file=${two}`, { method: 'DELETE' })).body
  assert.equal(view.path.find(item => item.id === node.id).media, undefined)
  assert.deepEqual(await files('media', chat.id), [])

  // A new one drawn again, then the chat deleted: nothing left.
  const again = await draw({})
  await draw({ replace: again.image.file })
  assert.equal((await files('media', chat.id)).length, 2)
  await call(`/api/chats/${chat.id}`, { method: 'DELETE' })
  assert.deepEqual(await readdir(path.join(dataRoot, 'media')).then(names => names.includes(chat.id)), false)
})

test('立绘 and 表情: drawn or uploaded again, the old ones kept to the setting, taken back, deleted, and gone with the cast member', async t => {
  const { call, bytes, files, cardId, fake } = await tavern(t, { keep: 2 })
  await call(`/api/cards/${cardId}/media`, { method: 'PUT', body: { roster: [{ id: 'qinghe', name: '林青禾', looks: 'long black hair' }, { id: 'zhouguan', name: '周管事', looks: 'old man' }] } })
  let view
  for (let i = 0; i < 3; i++) view = (await call(`/api/cards/${cardId}/sprites/qinghe/draw`, { method: 'POST', body: {} })).body
  assert.deepEqual(await bytes(`/api/sprites/${cardId}/${view.sprites.qinghe.file}`), fake.picture(3))
  let kept = (await call(`/api/cards/${cardId}/history`)).body
  assert.equal(kept.keep, 2)
  assert.deepEqual(Object.keys(kept.slots), ['sprite:qinghe'])
  const [two, one] = kept.slots['sprite:qinghe']
  assert.deepEqual(await bytes(`/api/cards/${cardId}/history/${one.file}`), fake.picture(1))
  assert.equal(two.source, 'drawn')
  assert.equal((await files('cards', cardId, 'history')).length, 2)

  // A fourth: the first goes.
  await call(`/api/cards/${cardId}/sprites/qinghe/draw`, { method: 'POST', body: {} })
  kept = (await call(`/api/cards/${cardId}/history`)).body
  assert.deepEqual(await bytes(`/api/cards/${cardId}/history/${kept.slots['sprite:qinghe'][1].file}`), fake.picture(2))
  assert.equal(await bytes(`/api/cards/${cardId}/history/${one.file}`), null)

  // Picture 2 back as the 立绘; picture 4 kept in its place.
  const back = (await call(`/api/cards/${cardId}/history/${kept.slots['sprite:qinghe'][1].file}/use`, { method: 'POST' })).body
  assert.deepEqual(await bytes(`/api/sprites/${cardId}/${back.sprites.qinghe.file}`), fake.picture(2))
  assert.equal(back.sprites.qinghe.source, 'drawn')
  const now = back.history.slots['sprite:qinghe']
  assert.deepEqual(await Promise.all(now.map(entry => bytes(`/api/cards/${cardId}/history/${entry.file}`))), [fake.picture(4), fake.picture(3)])
  assert.equal((await call(`/api/cards/${cardId}/history/nothere-1.png/use`, { method: 'POST' })).status, 404)

  // Deleted: gone from the list and the disk.
  const left = (await call(`/api/cards/${cardId}/history/${now[1].file}`, { method: 'DELETE' })).body
  assert.deepEqual(left.slots['sprite:qinghe'].map(entry => entry.file), [now[0].file])
  assert.equal(await bytes(`/api/cards/${cardId}/history/${now[1].file}`), null)

  // An expression uploaded twice keeps the first; someone else's stay apart.
  await call(`/api/cards/${cardId}/sprites/qinghe/expressions/smile`, { method: 'PUT', body: { image: dataUrl(png(101)) } })
  const smiled = (await call(`/api/cards/${cardId}/sprites/qinghe/expressions/smile`, { method: 'PUT', body: { image: dataUrl(png(102)) } })).body
  assert.deepEqual(await bytes(`/api/sprites/${cardId}/${smiled.expressions.qinghe.smile.file}`), png(102))
  await call(`/api/cards/${cardId}/sprites/zhouguan`, { method: 'PUT', body: { image: dataUrl(png(201)) } })
  await call(`/api/cards/${cardId}/sprites/zhouguan`, { method: 'PUT', body: { image: dataUrl(png(202)) } })
  kept = (await call(`/api/cards/${cardId}/history`)).body
  assert.deepEqual(Object.keys(kept.slots).sort(), ['face:qinghe:smile', 'sprite:qinghe', 'sprite:zhouguan'])
  const face = (await call(`/api/cards/${cardId}/history/${kept.slots['face:qinghe:smile'][0].file}/use`, { method: 'POST' })).body
  assert.deepEqual(await bytes(`/api/sprites/${cardId}/${face.expressions.qinghe.smile.file}`), png(101))
  assert.equal(face.expressions.qinghe.smile.source, 'upload')

  // Deleting the 立绘 itself leaves its old ones to take back.
  await call(`/api/cards/${cardId}/sprites/qinghe`, { method: 'DELETE' })
  assert.ok((await call(`/api/cards/${cardId}/history`)).body.slots['sprite:qinghe'].length)

  // 林青禾 off the cast list: her old 立绘 and expressions go, 周管事's stay.
  await call(`/api/cards/${cardId}/media`, { method: 'PUT', body: { roster: [{ id: 'zhouguan', name: '周管事', looks: 'old man' }] } })
  kept = (await call(`/api/cards/${cardId}/history`)).body
  assert.deepEqual(Object.keys(kept.slots), ['sprite:zhouguan'])
  assert.deepEqual(await files('cards', cardId, 'history'), [kept.slots['sprite:zhouguan'][0].file])
})

test('人设图, 场景 and the card\'s picture keep theirs too; with none kept, nothing is', async t => {
  const { call, bytes, files, cardId, dataRoot } = await tavern(t, { keep: 3 })
  await call(`/api/cards/${cardId}/media`, { method: 'PUT', body: { roster: [{ id: 'qinghe', name: '林青禾', looks: 'long black hair' }] } })
  // 人设图: uploaded over, then the first taken back; it is the one drawn from now on (GET …/ref).
  await call(`/api/cards/${cardId}/roster/qinghe/ref`, { method: 'PUT', body: { image: dataUrl(png(11)) } })
  await call(`/api/cards/${cardId}/roster/qinghe/ref`, { method: 'PUT', body: { image: dataUrl(png(12)) } })
  let kept = (await call(`/api/cards/${cardId}/history`)).body
  assert.equal(kept.slots['roster:qinghe'].length, 1)
  const ref = (await call(`/api/cards/${cardId}/history/${kept.slots['roster:qinghe'][0].file}/use`, { method: 'POST' })).body
  assert.equal(ref.ref, true)
  assert.deepEqual(await bytes(`/api/cards/${cardId}/roster/qinghe/ref`), png(11))
  assert.deepEqual(await bytes(`/api/cards/${cardId}/history/${ref.history.slots['roster:qinghe'][0].file}`), png(12))
  // Saving the cast (the same members) keeps them.
  await call(`/api/cards/${cardId}/media`, { method: 'PUT', body: { roster: [{ id: 'qinghe', name: '林青禾', looks: 'long black hair' }] } })
  assert.equal((await call(`/api/cards/${cardId}/history`)).body.slots['roster:qinghe'].length, 1)

  // 场景: an upload over a drawn one keeps the drawn one with its prompt; taken back, the scene has that prompt again.
  const drawn = (await call(`/api/cards/${cardId}/scenes/draw`, { method: 'POST', body: { place: '茶馆' } })).body
  const sceneId = drawn.scene.id
  const prompt = drawn.scene.prompt
  await call(`/api/cards/${cardId}/scenes/${sceneId}/image`, { method: 'PUT', body: { image: dataUrl(png(21)) } })
  kept = (await call(`/api/cards/${cardId}/history`)).body
  const [old] = kept.slots[`scene:${sceneId}`]
  assert.equal(old.prompt, prompt)
  const scene = (await call(`/api/cards/${cardId}/history/${old.file}/use`, { method: 'POST' })).body
  assert.equal(scene.scene.source, 'drawn')
  assert.equal(scene.scene.prompt, prompt)
  assert.equal(scene.history.slots[`scene:${sceneId}`][0].source, 'upload')
  // The scene deleted: its old pictures with it.
  await call(`/api/cards/${cardId}/scenes/${sceneId}`, { method: 'DELETE' })
  assert.equal((await call(`/api/cards/${cardId}/history`)).body.slots[`scene:${sceneId}`], undefined)

  // The card's picture: the one replaced is kept; one drawn is kept until taken, and taking it drops it from there.
  await call(`/api/cards/${cardId}/avatar`, { method: 'PUT', body: { image: dataUrl(png(31)) } })
  await call(`/api/cards/${cardId}/avatar`, { method: 'PUT', body: { image: dataUrl(png(32)) } })
  kept = (await call(`/api/cards/${cardId}/history`)).body
  assert.deepEqual(kept.slots.avatar.map(entry => entry.source), ['avatar'])
  assert.equal((await call(`/api/cards/${cardId}/history/${kept.slots.avatar[0].file}/use`, { method: 'POST' })).status, 400, 'the page takes an avatar back (as a PNG)')
  const candidate = (await call(`/api/cards/${cardId}/avatar/draw`, { method: 'POST', body: {} })).body
  assert.ok(candidate.history)
  kept = (await call(`/api/cards/${cardId}/history`)).body
  assert.deepEqual(kept.slots.avatar.map(entry => entry.source), ['drawn', 'avatar'])
  await call(`/api/cards/${cardId}/avatar`, { method: 'PUT', body: { image: candidate.image.replace(/^data:image\/\w+/, 'data:image/png'), history: candidate.history } })
  kept = (await call(`/api/cards/${cardId}/history`)).body
  assert.deepEqual(kept.slots.avatar.map(entry => entry.source), ['avatar', 'avatar'])
  assert.equal(kept.slots.avatar.some(entry => entry.file === candidate.history), false)

  // None kept: drawing again deletes the old one, as before.
  await call('/api/media/settings', { method: 'PUT', body: { drawHistory: 0 } })
  const before = await files('cards', cardId, 'history')
  await call(`/api/cards/${cardId}/roster/qinghe/ref`, { method: 'PUT', body: { image: dataUrl(png(13)) } })
  assert.deepEqual(await files('cards', cardId, 'history'), before)

  // The card deleted: everything it kept goes with it.
  await call(`/api/cards/${cardId}`, { method: 'DELETE' })
  assert.deepEqual(await readdir(path.join(dataRoot, 'cards')).then(names => names.includes(cardId)), false)
  assert.equal((await call(`/api/cards/${cardId}/history`)).status, 404)
})
