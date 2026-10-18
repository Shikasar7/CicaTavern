// Picture prompts kept apart from the chats, so they can be drawn again on any
// reply later, as they were or edited. Every picture drawn adds its prompt (the
// same prompt on the same card is one entry, with the newest picture as its
// thumbnail); the dialog can also save a prompt by hand. The first read fills
// the library from the pictures already in the chats. When a chat is deleted,
// the pictures the library shows are moved into the library first.
//
// <data>/prompt-library.json and <data>/prompt-library/<entry>.<ext>.
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { httpError, newId } from './store.mjs'
import { msg } from './i18n.mjs'

const FILE = /^[\w-]{1,64}\.(png|jpg|jpeg|webp)$/
const MAX_PROMPT = 8000
const MAX_TITLE = 60

export function createPromptLibrary(store) {
  const root = store.dirs.root
  const file = path.join(root, 'prompt-library.json')
  const ownDir = path.join(root, 'prompt-library')
  const mediaDir = chatId => path.join(root, 'media', chatId)
  let cache = null
  let queue = Promise.resolve()

  /** One change at a time: read, change, write. */
  function change(fn) {
    const run = queue.then(async () => {
      const library = await load()
      const result = await fn(library)
      await save(library)
      return result
    })
    queue = run.catch(() => {})
    return run
  }

  async function load() {
    if (cache) return cache
    try {
      cache = JSON.parse(await readFile(file, 'utf8'))
      if (!Array.isArray(cache.entries)) cache = { entries: [] }
    } catch {
      cache = { entries: await seed() }
      await save(cache)
    }
    return cache
  }

  async function save(library) {
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(library, null, 2), 'utf8')
    await rename(tmp, file)
  }

  /** Every picture already in the chats, oldest first so the newest wins a duplicate. */
  async function seed() {
    const entries = []
    const cards = new Map((await store.listCards().catch(() => [])).map(card => [card.id, card.name]))
    const chats = await store.listChats().catch(() => [])
    const found = []
    for (const chat of chats) {
      for (const node of Object.values(chat.nodes ?? {})) {
        for (const image of node.media?.images ?? []) {
          if (image?.prompt) found.push({ chat, node, image })
        }
      }
    }
    found.sort((a, b) => String(a.image.at).localeCompare(String(b.image.at)))
    for (const { chat, node, image } of found) add(entries, { chat, node, image, cardName: cards.get(chat.cardId) ?? '' })
    return entries
  }

  /** Add a drawn picture's prompt to `entries`, or bump the entry with the same prompt. */
  function add(entries, { chat, node, image, cardName }) {
    const prompt = String(image.prompt).trim().slice(0, MAX_PROMPT)
    const existing = entries.find(e => e.cardId === chat.cardId && e.prompt === prompt)
    const picture = { chatId: chat.id, chatTitle: chat.title ?? '', nodeId: node.id, file: image.file, own: null }
    if (existing) {
      // The same picture again: a branched chat copied it. Not drawn again.
      if (existing.file === image.file || existing.files?.includes(image.file)) return existing
      existing.files = [...(existing.files ?? []), existing.file].filter(Boolean).slice(-20)
      dropOwn(existing)
      Object.assign(existing, picture, { backend: image.backend ?? '', drawn: (existing.drawn ?? 0) + 1, at: image.at ?? new Date().toISOString() })
      return existing
    }
    const entry = { id: newId(), cardId: chat.cardId, cardName, prompt, title: '', starred: false, drawn: 1, backend: image.backend ?? '', at: image.at ?? new Date().toISOString(), ...picture }
    entries.push(entry)
    return entry
  }

  function dropOwn(entry) {
    if (entry.own && FILE.test(entry.own)) rm(path.join(ownDir, entry.own), { force: true }).catch(() => {})
  }

  function view(entry) {
    const { id, cardId, cardName, prompt, title, starred, drawn, backend, at, chatId, chatTitle, nodeId, file: image, own } = entry
    return { id, cardId, cardName, prompt, title, starred, drawn, backend, at, chatId, chatTitle, nodeId, hasImage: Boolean(own || image) }
  }

  return {
    /** Entries for a card (all cards when cardId is empty): starred first, then newest. */
    async list(cardId = '') {
      const { entries } = await load()
      return entries
        .filter(e => !cardId || e.cardId === cardId)
        .sort((a, b) => Number(b.starred) - Number(a.starred) || String(b.at).localeCompare(String(a.at)))
        .map(view)
    },

    /** A picture was drawn and kept on a reply. */
    async recordDrawn(chat, node, image) {
      if (!image?.prompt) return null
      const card = await store.getCard(chat.cardId).catch(() => null)
      return change(library => view(add(library.entries, { chat, node, image, cardName: card?.name ?? '' })))
    },

    /** Saved by hand from the dialog (an edited or unused prompt). */
    async saveManual({ cardId, prompt, title = '' }) {
      const text = String(prompt ?? '').trim().slice(0, MAX_PROMPT)
      if (!text) throw httpError(400, msg`提示词是空的`)
      const card = await store.getCard(String(cardId ?? '')).catch(() => null)
      if (!card) throw httpError(404, msg`角色卡不存在`)
      return change(library => {
        const existing = library.entries.find(e => e.cardId === card.id && e.prompt === text)
        if (existing) {
          if (title) existing.title = String(title).slice(0, MAX_TITLE)
          existing.starred = true
          return view(existing)
        }
        const entry = { id: newId(), cardId: card.id, cardName: card.name, prompt: text, title: String(title).slice(0, MAX_TITLE), starred: true, drawn: 0, backend: '', at: new Date().toISOString(), chatId: null, chatTitle: '', nodeId: null, file: null, own: null }
        library.entries.push(entry)
        return view(entry)
      })
    },

    async update(id, { prompt, title, starred }) {
      return change(library => {
        const entry = library.entries.find(e => e.id === id)
        if (!entry) throw httpError(404, msg`提示词不存在`)
        if (typeof prompt === 'string') {
          const text = prompt.trim().slice(0, MAX_PROMPT)
          if (!text) throw httpError(400, msg`提示词是空的`)
          entry.prompt = text
        }
        if (typeof title === 'string') entry.title = title.trim().slice(0, MAX_TITLE)
        if (typeof starred === 'boolean') entry.starred = starred
        return view(entry)
      })
    },

    async remove(id) {
      return change(library => {
        const index = library.entries.findIndex(e => e.id === id)
        if (index < 0) return { ok: true }
        dropOwn(library.entries[index])
        library.entries.splice(index, 1)
        return { ok: true }
      })
    },

    /** The entry's thumbnail: its own copy, or the picture in its chat. */
    async image(id) {
      const { entries } = await load()
      const entry = entries.find(e => e.id === id)
      if (entry?.own && FILE.test(entry.own)) return readFile(path.join(ownDir, entry.own))
      if (entry?.file && FILE.test(entry.file) && entry.chatId) return readFile(path.join(mediaDir(entry.chatId), entry.file))
      throw httpError(404, msg`没有图`)
    },

    /** Before a chat's pictures are deleted: keep the ones the library shows. */
    async adoptChat(chatId) {
      return change(async library => {
        let kept = 0
        for (const entry of library.entries) {
          if (entry.chatId !== chatId) continue
          if (entry.file && FILE.test(entry.file) && !entry.own) {
            const own = `${entry.id}${path.extname(entry.file)}`
            try {
              await mkdir(ownDir, { recursive: true })
              await copyFile(path.join(mediaDir(chatId), entry.file), path.join(ownDir, own))
              entry.own = own
              kept++
            } catch {
              // the picture was already gone
            }
          }
          entry.chatTitle = entry.chatTitle ? msg`${entry.chatTitle}（已删除）` : msg`（已删除的对话）`
          entry.chatId = null
          entry.nodeId = null
          entry.file = null
        }
        return { kept }
      })
    },

    /** A picture removed from a reply no longer stands for its prompt (the prompt stays). */
    async forgetPicture(chatId, file) {
      return change(library => {
        for (const entry of library.entries) {
          if (entry.chatId === chatId && entry.file === file && !entry.own) entry.file = null
        }
      })
    },
  }
}
