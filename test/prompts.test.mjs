import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../server/store.mjs'
import { createPromptLibrary } from '../server/prompts.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-prompts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  await store.saveCard({ id: 'card1', name: '顾念念', data: {} })
  const chat = {
    id: 'chat1',
    cardId: 'card1',
    title: '武当',
    nodes: {
      root: { id: 'root', role: 'assistant', text: '开场', createdAt: '2026-10-01T00:00:00.000Z' },
      a1: { id: 'a1', role: 'assistant', parent: 'root', text: '练剑', createdAt: '2026-10-01T00:01:00.000Z', media: { images: [
        { file: 'old.png', prompt: 'girl, sword, moonlight', backend: 'NovelAI', at: '2026-10-01T00:02:00.000Z' },
        { file: 'new.png', prompt: 'girl, sword, moonlight', backend: 'NovelAI', at: '2026-10-02T00:02:00.000Z' },
        { file: 'tea.png', prompt: 'girl, tea house', backend: 'NovelAI', at: '2026-10-03T00:02:00.000Z' },
      ] } },
    },
  }
  await store.saveChat(chat)
  await mkdir(path.join(root, 'media', 'chat1'), { recursive: true })
  for (const file of ['old.png', 'new.png', 'tea.png']) await writeFile(path.join(root, 'media', 'chat1', file), PNG)
  return { root, store, chat, library: createPromptLibrary(store) }
}

test('the first read fills the library from pictures already drawn, one entry per prompt', async t => {
  const { library, root } = await setup(t)
  const entries = await library.list('card1')
  assert.deepEqual(entries.map(e => e.prompt), ['girl, tea house', 'girl, sword, moonlight'], 'newest first')
  const sword = entries[1]
  assert.equal(sword.drawn, 2)
  assert.equal(sword.cardName, '顾念念')
  assert.equal(sword.chatTitle, '武当')
  assert.equal(sword.hasImage, true)
  assert.deepEqual(await library.image(sword.id), PNG)
  assert.ok(JSON.parse(await readFile(path.join(root, 'prompt-library.json'), 'utf8')).entries.length === 2, 'kept on disk')
  assert.deepEqual(await library.list('other'), [])
})

test('a branched chat carrying the same picture does not count as drawing it again', async t => {
  const { library, store, chat } = await setup(t)
  await store.saveChat({ ...structuredClone(chat), id: 'chat2', title: '武当（分支）' })
  await library.recordDrawn({ ...chat, id: 'chat2' }, chat.nodes.a1, chat.nodes.a1.media.images[2])
  const tea = (await library.list('card1')).find(e => e.prompt === 'girl, tea house')
  assert.equal(tea.drawn, 1)
})

test('drawing adds or bumps an entry; a hand-saved prompt is starred and listed first', async t => {
  const { library, chat } = await setup(t)
  await library.list()
  await library.recordDrawn(chat, chat.nodes.a1, { file: 'tea2.png', prompt: 'girl, tea house', backend: 'NovelAI', at: '2026-10-04T00:00:00.000Z' })
  await library.recordDrawn(chat, chat.nodes.a1, { file: 'rain.png', prompt: 'girl, rain', backend: 'NovelAI', at: '2026-10-05T00:00:00.000Z' })
  const manual = await library.saveManual({ cardId: 'card1', prompt: '  girl, snow  ' })
  assert.equal(manual.starred, true)
  assert.equal(manual.drawn, 0)
  const entries = await library.list('card1')
  assert.deepEqual(entries.map(e => e.prompt), ['girl, snow', 'girl, rain', 'girl, tea house', 'girl, sword, moonlight'])
  assert.equal(entries.find(e => e.prompt === 'girl, tea house').drawn, 2)
  await assert.rejects(library.saveManual({ cardId: 'card1', prompt: ' ' }), /空/)
  await assert.rejects(library.saveManual({ cardId: 'nope', prompt: 'x' }), /角色卡不存在/)
})

test('update, star and remove; a removed picture leaves the prompt without a thumbnail', async t => {
  const { library } = await setup(t)
  const [tea, sword] = await library.list('card1')
  assert.equal((await library.update(sword.id, { starred: true, title: '月下练剑' })).title, '月下练剑')
  assert.equal((await library.list('card1'))[0].id, sword.id, 'starred first')
  assert.equal((await library.update(tea.id, { prompt: 'girl, tea house, rain' })).prompt, 'girl, tea house, rain')
  await library.forgetPicture('chat1', 'tea.png')
  assert.equal((await library.list('card1')).find(e => e.id === tea.id).hasImage, false)
  await library.remove(tea.id)
  assert.deepEqual((await library.list('card1')).map(e => e.id), [sword.id])
  await assert.rejects(library.update('missing', { title: 'x' }), /不存在/)
})

test('deleting a chat moves the pictures the library shows into the library', async t => {
  const { library, root } = await setup(t)
  const [, sword] = await library.list('card1')
  assert.deepEqual(await library.adoptChat('chat1'), { kept: 2 })
  await rm(path.join(root, 'media', 'chat1'), { recursive: true, force: true })
  const after = (await library.list('card1')).find(e => e.id === sword.id)
  assert.equal(after.chatId, null)
  assert.match(after.chatTitle, /已删除/)
  assert.equal(after.hasImage, true)
  assert.deepEqual(await library.image(sword.id), PNG)
})
