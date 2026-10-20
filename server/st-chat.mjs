// SillyTavern chats (.jsonl): a header line (the player's and the character's
// names, the chat's metadata), then one line per message. Read here into
// messages that alternate player and reply; chats.mjs importSillyTavern turns
// them into a chat. A reply's swipes are its versions; the variables a
// message carries (MVU keeps them under stat_data, one set per swipe) are that
// version's state. Hidden and system messages were never sent to the model,
// so they stay out; so does the reasoning SillyTavern keeps beside a reply.
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// SillyTavern's own date format: "August 4, 2026 4:35am".
const ST_DATE = /^([A-Za-z]+ \d{1,2}, \d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)$/i

/** A message's date as an ISO string: SillyTavern's own format, an ISO string or epoch ms; null when unreadable. */
export function dateOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value !== 'string' || !value.trim()) return null
  const own = ST_DATE.exec(value.trim())
  if (own) {
    const hour = (Number(own[2]) % 12) + (own[5].toLowerCase() === 'pm' ? 12 : 0)
    const date = new Date(`${own[1]} ${hour}:${own[3]}:${own[4] ?? '00'}`)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/** The variables one version of a message carries (MVU's stat_data when there is one), or null. */
function variablesOf(message, index, selected) {
  const all = message.variables
  const value = Array.isArray(all) ? all[index] : index === selected ? all : null
  if (!isPlainObject(value)) return null
  if (isPlainObject(value.stat_data)) return value.stat_data
  return Object.keys(value).length ? value : null
}

/**
 * The text of a SillyTavern chat file → { userName, characterName, messages }.
 * Each message is { role: 'user'|'assistant', selected, versions: [{ text, state, at }] };
 * roles alternate (two in a row become one), the first may be either.
 */
export function readSillyTavernChat(text) {
  const rows = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      throw httpError(400, msg`这不是 SillyTavern 的对话记录（.jsonl）`)
    }
  }
  const header = rows.find(row => isPlainObject(row) && typeof row.mes !== 'string' && ('chat_metadata' in row || 'user_name' in row || 'character_name' in row))
  const messages = []
  for (const row of rows) {
    if (!isPlainObject(row) || typeof row.mes !== 'string' || row.is_system) continue
    const role = row.is_user ? 'user' : 'assistant'
    const swipes = role === 'assistant' && Array.isArray(row.swipes) && row.swipes.length > 1 ? row.swipes.map(swipe => String(swipe ?? '')) : [row.mes]
    const selected = swipes.length > 1 ? Math.min(Math.max(0, Math.trunc(Number(row.swipe_id)) || 0), swipes.length - 1) : 0
    const at = dateOf(row.send_date)
    const versions = swipes.map((swipe, i) => ({
      // The chosen swipe is what the message shows (an edit may have changed only mes).
      text: i === selected ? row.mes : swipe,
      state: variablesOf(row, i, selected),
      at: dateOf(row.swipe_info?.[i]?.send_date) ?? at,
    }))
    const last = messages.at(-1)
    if (last?.role === role) {
      // Two in a row (several player lines, a reply continued in a new message): one turn.
      const before = last.versions[last.selected]
      if (role === 'user') before.text = `${before.text}\n\n${versions[0].text}`
      else messages[messages.length - 1] = { role, selected, versions: versions.map(version => ({ ...version, text: `${before.text}\n\n${version.text}`, state: version.state ?? before.state })) }
      continue
    }
    messages.push({ role, selected, versions })
  }
  if (!messages.length) throw httpError(400, msg`这个文件里没有对话消息`)
  // Newer SillyTavern writes "unused" in the header; the names are on the messages.
  const name = value => (typeof value === 'string' && value.trim() !== 'unused' ? value.trim() : '')
  const spoken = isUser => name(rows.find(row => isPlainObject(row) && typeof row.mes === 'string' && !row.is_system && Boolean(row.is_user) === isUser)?.name)
  return { userName: name(header?.user_name) || spoken(true), characterName: name(header?.character_name) || spoken(false), messages }
}
