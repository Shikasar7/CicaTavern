// Moving a whole chat — every turn, branch and picture — to another device.
// A package is one file: a magic line, the header's byte length on its own line,
// the header JSON, then the pictures back to back (header.media gives each one's
// offset and length after the header). The importing page reads the header,
// creates the chat, then uploads the pictures one request at a time, so a chat
// with a hundred pictures never has to fit in one request.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isProviderRef } from './providers.mjs'
import { httpError, newId } from './store.mjs'
import { msg } from './i18n.mjs'
import { isBuiltinPreset } from '../web/shared/basic.js'
import { withoutOldImages } from './draw-history.mjs'

export const PACKAGE_MAGIC = 'AGENT-TAVERN-CHAT 1\n'
export const PACKAGE_FORMAT = 'agent-tavern-chat'
const FILE = /^[\w-]{1,64}\.(png|jpg|jpeg|webp)$/
const NODE_ID = /^[\w-]{1,64}$/

/**
 * A package's nodes as a tree this app can walk, or null: each id its own key, the root without a parent,
 * every other parent there, and every node reaching the root (a loop kept the chat list from ever loading).
 */
function cleanTree(nodes, now) {
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return null
  const tree = {}
  for (const [id, node] of Object.entries(nodes)) {
    if (!NODE_ID.test(id) || !node || typeof node !== 'object' || Array.isArray(node) || (node.id ?? id) !== id) return null
    tree[id] = { ...node, id, createdAt: typeof node.createdAt === 'string' ? node.createdAt : now }
  }
  if (!tree.root || tree.root.parent) return null
  const reaches = new Set(['root'])
  for (const start of Object.values(tree)) {
    const trail = new Set()
    for (let node = start; !reaches.has(node.id); node = tree[node.parent]) {
      if (trail.has(node.id) || typeof node.parent !== 'string' || !tree[node.parent]) return null
      trail.add(node.id)
    }
    for (const id of trail) reaches.add(id)
  }
  return tree
}

const mediaDir = (store, chatId) => path.join(store.dirs.root, 'media', chatId)
const picturesOf = chat => [...new Set(Object.values(chat.nodes ?? {}).flatMap(node => node.media?.images?.map(image => image.file) ?? []))].filter(file => FILE.test(file))

/** The package for one chat, as a Buffer. Pictures missing on disk are left out. */
export async function chatPackage(store, chatId) {
  const chat = await store.getChat(chatId)
  const card = await store.getCard(chat.cardId).catch(() => null)
  const blobs = []
  const media = []
  let offset = 0
  for (const file of picturesOf(chat)) {
    const buffer = await readFile(path.join(mediaDir(store, chat.id), file)).catch(() => null)
    if (!buffer) continue
    media.push({ file, offset, length: buffer.length })
    blobs.push(buffer)
    offset += buffer.length
  }
  const header = Buffer.from(JSON.stringify({
    format: PACKAGE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    cardName: card?.name ?? chat.names?.char ?? '',
    presetName: chat.presetName ?? null,
    // The pictures in use only: their old ones (抽图历史) stay on this device.
    chat: { ...chat, tips: {}, nodes: withoutOldImages(chat.nodes) },
    media,
  }), 'utf8')
  return Buffer.concat([Buffer.from(`${PACKAGE_MAGIC}${header.length}\n`, 'utf8'), header, ...blobs])
}

/**
 * Create the chat from a package header. The card is the one with the same
 * name, else `cardId`; the preset the same id or name, else none (reported);
 * the model is kept only when it names a provider this device has.
 * @returns { chat, card, missingPreset }
 */
export async function importChatPackage(store, { header, cardId = '' }) {
  const source = header?.chat
  if (header?.format !== PACKAGE_FORMAT || !source || typeof source !== 'object' || !source.nodes?.root) throw httpError(400, msg`这不是酒馆的对话包`)
  const cards = await store.listCards()
  const card = cards.find(c => c.name === header.cardName) ?? cards.find(c => c.id === cardId)
  if (!card) throw httpError(404, msg`这台设备上没有角色卡「${header.cardName}」，先导入它`)
  // The built-in presets exist on every device.
  const presets = isBuiltinPreset(source.presetId) ? [{ id: source.presetId, name: source.presetName }] : await store.listPresets().catch(() => [])
  const preset = presets.find(p => p.id === source.presetId) ?? presets.find(p => source.presetName && p.name === source.presetName)
  const providers = await store.getProviders()
  const model = typeof source.model === 'string' && isProviderRef(source.model) && providers.some(p => source.model.startsWith(`${p.id}/`)) ? source.model : null
  const now = new Date().toISOString()
  const nodes = cleanTree(structuredClone(source.nodes), now)
  if (!nodes) throw httpError(400, msg`对话包里的对话树是坏的，导入不了`)
  const chat = {
    ...structuredClone(source),
    nodes,
    id: newId(),
    cardId: card.id,
    presetId: preset?.id ?? null,
    presetName: preset?.name ?? source.presetName ?? null,
    model,
    tips: {},
    importedFrom: { chatId: source.id, exportedAt: header.exportedAt ?? null, at: now },
    createdAt: source.createdAt ?? now,
  }
  await store.saveChat(chat)
  return { chat, card, missingPreset: !preset && source.presetName ? source.presetName : null }
}

/** One picture of an imported chat; only files its replies refer to are accepted. */
export async function savePackagePicture(store, chatId, file, buffer) {
  if (!FILE.test(file)) throw httpError(400, msg`文件名不对`)
  const chat = await store.getChat(chatId)
  if (!picturesOf(chat).includes(file)) throw httpError(400, msg`这个对话里没有这张图`)
  await mkdir(mediaDir(store, chatId), { recursive: true })
  await writeFile(path.join(mediaDir(store, chatId), file), buffer)
  return { ok: true }
}
