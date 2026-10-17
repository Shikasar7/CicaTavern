// SillyTavern character card import: PNG (tEXt/iTXt "ccv3" or "chara") and
// raw JSON (V1 flat, V2/V3 `{ spec, data }`).
import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { normalizeBook } from './worldbook.mjs'
import { httpError, newId } from './store.mjs'
import { normalizeScripts } from '../web/shared/regex.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Read every text chunk of a PNG into { keyword: text }. */
export function readPngText(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw httpError(400, '不是 PNG 文件')
  const texts = {}
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'tEXt') {
      const sep = data.indexOf(0)
      if (sep > 0) texts[data.toString('latin1', 0, sep)] = data.toString('latin1', sep + 1)
    } else if (type === 'iTXt') {
      const sep = data.indexOf(0)
      if (sep <= 0) continue
      const keyword = data.toString('latin1', 0, sep)
      const compressed = data[sep + 1] === 1
      let cursor = sep + 3
      cursor = data.indexOf(0, cursor) + 1 // language tag
      cursor = data.indexOf(0, cursor) + 1 // translated keyword
      if (cursor <= 0) continue
      const body = data.subarray(cursor)
      texts[keyword] = (compressed ? inflateSync(body) : body).toString('utf8')
    } else if (type === 'IEND') {
      break
    }
  }
  return texts
}

function decodeCardPayload(text) {
  const trimmed = text.trim()
  const json = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8')
  return JSON.parse(json)
}

/**
 * Some editors save a card or worldbook inside their own workspace file, e.g.
 * DSH Tavern's `{ kind, version, raw, meta }`; the SillyTavern JSON is `raw`.
 */
export function unwrapWorkspace(json) {
  if (json && typeof json === 'object' && typeof json.kind === 'string' && json.raw && typeof json.raw === 'object') return json.raw
  return json
}

// A card as this app keeps it (edits made to its data included) with its picture,
// to move it to another device; import it like any card file.
export const CARD_FORMAT = 'agent-tavern-card'

export function exportCard(card, avatar = null) {
  return { format: CARD_FORMAT, version: 1, exportedAt: new Date().toISOString(), card, avatar: avatar ? avatar.toString('base64') : null }
}

/** An exported card → { card (fresh id, no media), avatar }; null when the file is not one. */
export function importOwnCard(json) {
  if (json?.format !== CARD_FORMAT) return null
  const card = json.card
  if (!card || typeof card !== 'object' || typeof card.name !== 'string' || !card.name.trim()) throw httpError(400, '角色卡文件不完整')
  const { media, ...rest } = card
  const avatar = typeof json.avatar === 'string' && json.avatar ? Buffer.from(json.avatar, 'base64') : null
  return { card: { ...rest, id: newId(), worldbookIds: [], hasAvatar: Boolean(avatar), importedAt: new Date().toISOString() }, avatar }
}

/** Extract the card JSON from an uploaded file. */
export function parseCardFile(filename, buffer) {
  if (/\.png$/i.test(filename) || buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const texts = readPngText(buffer)
    const payload = texts.ccv3 ?? texts.chara
    if (!payload) throw httpError(400, '这张 PNG 里没有角色卡数据')
    return { raw: decodeCardPayload(payload), avatar: buffer }
  }
  try {
    return { raw: unwrapWorkspace(JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''))), avatar: null }
  } catch {
    throw httpError(400, '无法解析角色卡 JSON')
  }
}

const str = value => (typeof value === 'string' ? value : '')

/** Flatten V1/V2/V3 into the fields the prompt builder uses. */
export function normalizeCard(raw) {
  const data = raw && typeof raw.data === 'object' && raw.data !== null ? raw.data : raw
  if (!data || typeof data !== 'object' || !str(data.name)) throw httpError(400, '角色卡缺少 name 字段')
  const extensions = data.extensions && typeof data.extensions === 'object' ? data.extensions : {}
  const book = data.character_book ? normalizeBook(data.character_book, `${data.name} 内嵌世界书`) : null
  return {
    id: newId(),
    name: str(data.name).trim(),
    description: str(data.description),
    personality: str(data.personality),
    scenario: str(data.scenario),
    firstMes: str(data.first_mes),
    alternateGreetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings.filter(g => typeof g === 'string') : [],
    mesExample: str(data.mes_example),
    systemPrompt: str(data.system_prompt),
    postHistoryInstructions: str(data.post_history_instructions),
    creatorNotes: str(data.creator_notes || data.creatorcomment),
    creator: str(data.creator),
    tags: Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string').slice(0, 20) : [],
    spec: str(raw.spec) || 'v1',
    book,
    regexScripts: normalizeScripts(extensions.regex_scripts),
    // Character note inserted near the end of the context in SillyTavern; here: the tail of each turn.
    depthPrompt: str(extensions.depth_prompt?.prompt),
    // Tavern Helper scripts are not run; MVU behaviour is built in.
    helperScripts: Array.isArray(extensions.tavern_helper?.scripts) ? extensions.tavern_helper.scripts.length : 0,
    worldbookIds: [],
    hasAvatar: false,
    importedAt: new Date().toISOString(),
  }
}

/**
 * Cards imported before worldbook positions were kept: read them back from
 * the saved PNG (it is the original file). JSON imports keep "before character".
 */
export async function backfillEntryPositions(store) {
  for (const card of await store.listCards()) {
    const entries = card.book?.entries
    if (!entries?.length || entries.every(e => e.position !== undefined) || !card.hasAvatar) continue
    try {
      const { raw } = parseCardFile('card.png', await readFile(store.avatarPath(card.id)))
      const fresh = normalizeCard(raw).book?.entries ?? []
      entries.forEach((entry, i) => {
        entry.position = (fresh.find(f => f.uid === entry.uid) ?? fresh[i])?.position ?? 0
      })
      await store.saveCard(card)
    } catch {
      // Leave the card as it is; its entries count as "before character".
    }
  }
}

export function greetingsOf(card) {
  return [card.firstMes, ...card.alternateGreetings].filter(g => g.trim() !== '')
}

/** A card's name without its version ("林雪-异能抽奖系统-v1.2" → "林雪-异能抽奖系统"), to find older versions of it. */
export function baseName(name) {
  return String(name ?? '')
    .trim()
    .replace(/[\s_-]*[vV]\d+(\.\d+)*$/, '')
    .trim()
}

/** The newest other card with the same base name. */
export function previousVersion(cards, card) {
  const base = baseName(card.name)
  if (!base) return null
  return cards.filter(other => other.id !== card.id && baseName(other.name) === base).sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0] ?? null
}

export function cardSummary(card) {
  return {
    id: card.id,
    name: card.name,
    creator: card.creator,
    tags: card.tags,
    hasAvatar: card.hasAvatar,
    greetings: greetingsOf(card).length,
    bookEntries: card.book?.entries.length ?? 0,
    worldbookIds: card.worldbookIds,
    creatorNotes: card.creatorNotes.slice(0, 400),
    // Cards imported before 0.2 stored only a count.
    regexScripts: Array.isArray(card.regexScripts) ? card.regexScripts.length : Number(card.regexScripts) || 0,
    helperScripts: card.helperScripts ?? 0,
    importedAt: card.importedAt,
  }
}
