import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../server/store.mjs'
import { chatPackage, importChatPackage, PACKAGE_MAGIC, savePackagePicture } from '../server/transfer.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex')

async function storeAt(t, name) {
  const root = await mkdtemp(path.join(tmpdir(), `tavern-${name}-`))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  return { root, store }
}

/** Split a package the way the page does: header, then pictures by offset. */
function unpack(buffer) {
  const text = buffer.subarray(0, 64).toString('utf8')
  assert.ok(text.startsWith(PACKAGE_MAGIC))
  const line = text.slice(PACKAGE_MAGIC.length, text.indexOf('\n', PACKAGE_MAGIC.length))
  const start = Buffer.byteLength(`${PACKAGE_MAGIC}${line}\n`)
  const end = start + Number(line)
  const header = JSON.parse(buffer.subarray(start, end).toString('utf8'))
  return { header, picture: m => buffer.subarray(end + m.offset, end + m.offset + m.length) }
}

test('a chat travels whole: every node and picture, under the card and preset of the same name', async t => {
  const pc = await storeAt(t, 'pc')
  await pc.store.saveCard({ id: 'pcCard', name: '顾念念', data: {} })
  await pc.store.savePreset({ id: 'pcPreset', name: '捌', importedAt: '2026-10-01T00:00:00.000Z', prompts: [] })
  await pc.store.saveProviders([{ id: 'modelflare', name: 'M', api: 'anthropic-messages', baseURL: 'https://x' }])
  const chat = {
    id: 'pcChat', cardId: 'pcCard', presetId: 'pcPreset', presetName: '捌', model: 'modelflare/claude-opus-5-5', title: '武当（分支）',
    names: { user: '你', char: '顾念念' }, systemPrompt: '前缀', tips: { s1: 'u1' },
    nodes: {
      root: { id: 'root', role: 'assistant', text: '开场', createdAt: '2026-10-01T00:00:00.000Z' },
      u1: { id: 'u1', role: 'user', parent: 'root', text: '练剑', createdAt: '2026-10-01T00:01:00.000Z' },
      a1: { id: 'a1', role: 'assistant', parent: 'u1', text: '她拔剑。', createdAt: '2026-10-01T00:02:00.000Z', media: { images: [{ file: 'p1.png', prompt: 'sword' }, { file: 'gone.png', prompt: 'x' }] } },
      a2: { id: 'a2', role: 'assistant', parent: 'u1', text: '另一版', createdAt: '2026-10-01T00:03:00.000Z' },
    },
  }
  await pc.store.saveChat(chat)
  await mkdir(path.join(pc.root, 'media', 'pcChat'), { recursive: true })
  await writeFile(path.join(pc.root, 'media', 'pcChat', 'p1.png'), PNG)

  const { header, picture } = unpack(await chatPackage(pc.store, 'pcChat'))
  assert.equal(header.cardName, '顾念念')
  assert.deepEqual(header.media.map(m => m.file), ['p1.png'], 'a picture missing on disk is left out')
  assert.deepEqual(header.chat.tips, {})

  const phone = await storeAt(t, 'phone')
  await phone.store.saveCard({ id: 'phoneCard', name: '顾念念', data: {} })
  await phone.store.savePreset({ id: 'phonePreset', name: '捌', importedAt: '2026-10-01T00:00:00.000Z', prompts: [] })
  const { media, ...rest } = header
  const { chat: imported, card, missingPreset } = await importChatPackage(phone.store, { header: rest, cardId: '' })
  assert.equal(card.id, 'phoneCard')
  assert.equal(imported.cardId, 'phoneCard')
  assert.equal(imported.presetId, 'phonePreset', 'matched by name')
  assert.equal(missingPreset, null)
  assert.equal(imported.model, null, 'that provider is not on this device')
  assert.notEqual(imported.id, 'pcChat')
  assert.deepEqual(Object.keys(imported.nodes).sort(), ['a1', 'a2', 'root', 'u1'], 'every branch')
  for (const m of media) await savePackagePicture(phone.store, imported.id, m.file, picture(m))
  assert.deepEqual(await readFile(path.join(phone.root, 'media', imported.id, 'p1.png')), PNG)
  await assert.rejects(savePackagePicture(phone.store, imported.id, 'other.png', PNG), /没有这张图/)
  await assert.rejects(savePackagePicture(phone.store, imported.id, '../x.png', PNG), /文件名/)
})

test('a package without its card on this device asks for the card; the preset is reported when missing', async t => {
  const phone = await storeAt(t, 'phone')
  const header = { format: 'agent-tavern-chat', cardName: '林雪', chat: { id: 'c', presetName: '捌', nodes: { root: { id: 'root', role: 'assistant', text: '' } } } }
  await assert.rejects(importChatPackage(phone.store, { header }), /没有角色卡「林雪」/)
  await phone.store.saveCard({ id: 'selected', name: '别的卡', data: {} })
  const { chat, missingPreset } = await importChatPackage(phone.store, { header, cardId: 'selected' })
  assert.equal(chat.cardId, 'selected', 'falls back to the selected card')
  assert.equal(missingPreset, '捌')
  await assert.rejects(importChatPackage(phone.store, { header: { format: 'x' } }), /不是酒馆的对话包/)
})
