// 图库 (server/gallery.mjs): every picture of every card and chat in one list; the ones picked as a zip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { createChat } from '../server/chats.mjs'
import { createMedia } from '../server/media.mjs'
import { createScenes } from '../server/scenes.mjs'
import { createCardCgs } from '../server/card-cgs.mjs'
import { createGallery } from '../server/gallery.mjs'
import { createStore } from '../server/store.mjs'
import zlib from 'node:zlib'
import { listZip, zipEntries } from '../server/update/zip.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`

test('图库: 配图 of every chat, a card\'s 背景 and 立绘, newest first; a zip of the ones picked, in folders', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-gallery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard({ name: '林雪/警官', description: '', first_mes: '你好' })
  await store.saveCard(card)
  const media = createMedia(store, {})
  const scenes = createScenes(store, { media })
  const cgs = createCardCgs(store)
  const gallery = createGallery(store, { scenes, media, cgs })
  assert.deepEqual((await gallery.list()).items, [])

  const chat = await createChat(store, card.id)
  const saved = await store.getChat(chat.id)
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(path.join(root, 'media', chat.id), { recursive: true })
  await writeFile(path.join(root, 'media', chat.id, 'a1.png'), PNG)
  saved.nodes.root.media = { images: [{ file: 'a1.png', prompt: 'a quiet street', at: '2026-11-10T08:00:00.000Z' }] }
  await store.saveChat(saved)
  await scenes.add(card.id, { name: '雨巷', image: dataUrl })
  const cardNow = await store.getCard(card.id)
  cardNow.media = { ...(cardNow.media ?? {}), roster: [{ id: 'lx', name: '林雪', kind: 'girl', looks: 'short hair' }] }
  await store.saveCard(cardNow)
  await scenes.setSprite(card.id, 'lx', dataUrl)
  await scenes.setExpression(card.id, 'lx', 'shy', dataUrl)
  // 卡的 CG: a group of two.
  await cgs.bring(card.id, [{ name: '林雪-雨夜', note: '告白', pictures: [PNG, PNG] }])

  const { items } = await gallery.list()
  assert.deepEqual(items.map(item => item.kind).sort(), ['cg', 'cg', 'reply', 'scene', 'sprite', 'sprite'])
  assert.deepEqual(items.filter(item => item.kind === 'cg').map(item => [item.name, item.group, item.prompt]).sort(), [['林雪-雨夜 1', '林雪-雨夜', '告白'], ['林雪-雨夜 2', '林雪-雨夜', '告白']])
  assert.ok((await gallery.read(items.find(item => item.kind === 'cg').id)).equals(PNG))
  const reply = items.find(item => item.kind === 'reply')
  assert.deepEqual([reply.cardName, reply.chatId, reply.prompt, reply.src], ['林雪/警官', chat.id, 'a quiet street', `/api/media/${chat.id}/a1.png`])
  // 立绘 and expressions say whose and which face, for the 立绘 list (web/gallery.js).
  assert.deepEqual(items.filter(item => item.kind === 'sprite').map(item => [item.name, item.who, item.entryId, item.face]).sort(), [['林雪', '林雪', 'lx', 'neutral'], ['林雪·shy', '林雪', 'lx', 'shy']])
  assert.equal(items.find(item => item.kind === 'scene').name, '雨巷')
  assert.ok(items[0].at >= items.at(-1).at, 'newest first')

  const { parts, size, count, missing } = await gallery.exportZip([...items.map(item => item.id), 'reply:nochat:x.png'])
  const buffer = Buffer.concat(parts)
  assert.equal(size, buffer.length)
  assert.deepEqual([count, missing], [6, 1])
  const names = listZip(buffer).map(entry => entry.name).sort()
  assert.equal(names.length, 6)
  assert.ok(names.some(name => name.startsWith('林雪_警官/卡的CG/林雪-雨夜 1')), names.join(' '))
  assert.ok(names.every(name => name.startsWith('林雪_警官/')), names.join(' '))
  assert.ok(names.some(name => name.startsWith('林雪_警官/背景/雨巷')))
  assert.ok(names.some(name => name.startsWith('林雪_警官/立绘/林雪')))
  assert.ok(names.some(name => /^林雪_警官\/配图和CG\/.+\/2026-11-10-08-00-00\.png$/.test(name)))
  await assert.rejects(gallery.exportZip([]), /没有选图/)
  await assert.rejects(gallery.exportZip(['../../x']), /都已经不在了/)
})

test('zipEntries: stored entries any zip tool reads, the CRC right without zlib.crc32 (Node 18 on the phone)', t => {
  const own = zlib.crc32
  zlib.crc32 = undefined
  t.after(() => { zlib.crc32 = own })
  const zip = zipEntries([{ name: '图/一.png', data: PNG, when: new Date('2026-01-02T03:04:05') }, { name: 'b.txt', data: Buffer.from('hello'), when: new Date('x') }])
  const entries = listZip(zip)
  assert.deepEqual(entries.map(entry => [entry.name, entry.method, entry.size]), [['图/一.png', 0, PNG.length], ['b.txt', 0, 5]])
  assert.equal(entries[1].crc, 0x3610a686, 'crc32("hello")')
})
