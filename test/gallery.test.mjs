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
  const gallery = createGallery(store, { scenes, media })
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

  const { items } = await gallery.list()
  assert.deepEqual(items.map(item => item.kind).sort(), ['reply', 'scene', 'sprite'])
  const reply = items.find(item => item.kind === 'reply')
  assert.deepEqual([reply.cardName, reply.chatId, reply.prompt, reply.src], ['林雪/警官', chat.id, 'a quiet street', `/api/media/${chat.id}/a1.png`])
  assert.equal(items.find(item => item.kind === 'sprite').name, '林雪')
  assert.equal(items.find(item => item.kind === 'scene').name, '雨巷')
  assert.ok(items[0].at >= items.at(-1).at, 'newest first')

  const { parts, size, count, missing } = await gallery.exportZip([...items.map(item => item.id), 'reply:nochat:x.png'])
  const buffer = Buffer.concat(parts)
  assert.equal(size, buffer.length)
  assert.deepEqual([count, missing], [3, 1])
  const names = listZip(buffer).map(entry => entry.name).sort()
  assert.equal(names.length, 3)
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
