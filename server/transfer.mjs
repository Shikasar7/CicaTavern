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

export const PACKAGE_MAGIC = 'AGENT-TAVERN-CHAT 1\n'
export const PACKAGE_FORMAT = 'agent-tavern-chat'
const FILE = /^[\w-]{1,64}\.(png|jpg|jpeg|webp)$/

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
    chat: { ...chat, tips: {} },
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
  if (header?.format !== PACKAGE_FORMAT || !source || typeof source !== 'object' || !source.nodes?.root) throw httpError(400, '这不是酒馆的对话包')
  const cards = await store.listCards()
  const card = cards.find(c => c.name === header.cardName) ?? cards.find(c => c.id === cardId)
  if (!card) throw httpError(404, `这台设备上没有角色卡「${header.cardName}」，先导入它`)
  const presets = await store.listPresets().catch(() => [])
  const preset = presets.find(p => p.id === source.presetId) ?? presets.find(p => source.presetName && p.name === source.presetName)
  const providers = await store.getProviders()
  const model = typeof source.model === 'string' && isProviderRef(source.model) && providers.some(p => source.model.startsWith(`${p.id}/`)) ? source.model : null
  const now = new Date().toISOString()
  const chat = {
    ...structuredClone(source),
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
  if (!FILE.test(file)) throw httpError(400, '文件名不对')
  const chat = await store.getChat(chatId)
  if (!picturesOf(chat).includes(file)) throw httpError(400, '这个对话里没有这张图')
  await mkdir(mediaDir(store, chatId), { recursive: true })
  await writeFile(path.join(mediaDir(store, chatId), file), buffer)
  return { ok: true }
}
