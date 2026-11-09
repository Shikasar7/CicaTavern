// 角色卡自检: taking a finding in. Its changes go through the code 对话修改 uses (edit.mjs, book-edit.mjs,
// regex-edit.mjs); what is added here is a person's own edit of a change before it goes in, a change gone out of date,
// and taking any of them back: each one remembers the pieces of the card it touched, so they can be undone one by one.
import YAML from 'yaml'
import { CARD_FIELDS, greetingList } from '../../web/shared/card-edit.js'
import { regexFromString } from '../../web/shared/regex.js'
import { cleanStatusSpec } from '../../web/shared/status.js'
import { msg } from '../i18n.mjs'
import { cleanScripts } from '../regex.mjs'
import { httpError } from '../store.mjs'
import { entryText, isInitvar } from '../worldbook.mjs'
import { splitKeys } from './blocks.mjs'
import { applyBookChanges } from './book-edit.mjs'
import { englishCard, statusLines } from './check.mjs'
import { applyChanges, ensureBook } from './edit.mjs'
import { applyRegexChanges } from './regex-edit.mjs'
import { OWN_STATUS_SCRIPT, statusScripts } from './status.mjs'

const TEXT_KINDS = new Set(['field', 'greeting'])
const BOOK_KINDS = new Set(['entry', 'newEntry', 'removeEntry'])
const REGEX_KINDS = new Set(['regex', 'newRegex', 'removeRegex'])
const OWN_SCRIPTS = new Set([OWN_STATUS_SCRIPT, `${OWN_STATUS_SCRIPT}-hide`])
const SCRIPT_WORDS = { zh: { hidePlaceholder: '对模型隐藏状态栏', statusBar: '状态栏' }, en: { hidePlaceholder: 'Hide the status bar from the model', statusBar: 'Status bar' } }

const scriptsOf = card => (Array.isArray(card.regexScripts) ? card.regexScripts : [])

/** Whether the card has moved on from what a change was written against. */
export function staleChange(card, change) {
  if (change.kind === 'field') return (change.key === 'tags' ? (card.tags ?? []).join(', ') : String(card[change.key] ?? '')) !== change.before
  if (change.kind === 'greeting') return (greetingList(card)[change.index] ?? '') !== change.before
  if (change.kind === 'entry' || change.kind === 'removeEntry') return card.book?.entries.find(entry => entry.uid === change.uid)?.content !== change.before
  if (change.kind === 'regex') {
    const script = scriptsOf(card).find(item => item.id === change.sid)
    return script?.findRegex !== change.findBefore || script?.replaceString !== change.replaceBefore
  }
  if (change.kind === 'removeRegex') return !scriptsOf(card).some(item => item.id === change.sid)
  if (change.kind === 'statusBar') return statusLines(card.statusBar) !== change.before
  return false
}

// ─── A change written against text that has moved on ─────────────────────

// How much of what a change kept on each side of its edit finds the place again.
const AROUND = 24

/**
 * A text change made again on text that has changed since it was written (`now`): its edit, the part between what
 * before and after share, goes where that part and a little on each side of it still stand, once. null when that is
 * gone (the same words were changed) or found twice (no telling which).
 */
export function rebaseText(now, before, after) {
  if (typeof now !== 'string' || typeof before !== 'string' || typeof after !== 'string' || !before) return null
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  // Less around it when the words next to the edit were changed too, as long as the place stays one.
  for (const around of [AROUND, 12, 6, 2]) {
    const lead = before.slice(Math.max(0, start - around), start)
    const tail = before.slice(before.length - end, before.length - end + around)
    const piece = lead + before.slice(start, before.length - end) + tail
    if (!piece) return null
    const at = now.indexOf(piece)
    if (at < 0) continue
    if (now.indexOf(piece, at + 1) >= 0) return null
    return now.slice(0, at) + lead + after.slice(start, after.length - end) + tail + now.slice(at + piece.length)
  }
  return null
}

/** The text a field, opening or entry change is about, as the card has it now; undefined when it is gone. */
function textNow(card, change) {
  if (change.kind === 'field') return change.key === 'tags' ? undefined : String(card[change.key] ?? '')
  if (change.kind === 'greeting') return greetingList(card)[change.index]
  if (change.kind === 'entry') return card.book?.entries.find(entry => entry.uid === change.uid)?.content
  return undefined
}

/**
 * A finding with each change gone out of date made again on the card as it is (rebaseText): two suggestions that both
 * add a line to one entry go in together, as ticked. null when one of them cannot be placed; the finding itself when
 * none is out of date.
 */
export function rebased(card, finding) {
  if (!finding.changes.some(change => staleChange(card, change))) return finding
  const changes = []
  for (const change of finding.changes) {
    if (!staleChange(card, change)) {
      changes.push(change)
      continue
    }
    if (change.kind !== 'field' && change.kind !== 'greeting' && change.kind !== 'entry') return null
    const now = textNow(card, change)
    const after = rebaseText(now, change.before, change.after)
    if (after === null) return null
    changes.push({ ...change, before: now, after })
  }
  return { ...finding, changes }
}

/** What a person wrote over a change, checked as a model's would be. */
function editedChange(card, change, edit) {
  const out = { ...change }
  if (typeof edit.after === 'string') out.after = edit.after
  if (edit.keys !== undefined && (change.kind === 'entry' || change.kind === 'newEntry')) out.keys = splitKeys(edit.keys)
  if (change.kind === 'regex' || change.kind === 'newRegex') {
    const find = typeof edit.find === 'string' ? edit.find.trim() : change.findAfter ?? change.find
    const replace = typeof edit.replace === 'string' ? edit.replace : change.replaceAfter ?? change.replace
    if (!regexFromString(find)) throw httpError(400, msg`查找的表达式读不出来，改好再采用`)
    Object.assign(out, change.kind === 'regex' ? { findAfter: find, replaceAfter: replace } : { find, replace })
    delete out.invalid
  }
  if (change.kind === 'statusBar' && edit.spec !== undefined) {
    const spec = cleanStatusSpec(edit.spec)
    if (!spec) throw httpError(400, msg`状态栏至少要显示一项`)
    Object.assign(out, { spec, after: statusLines(spec) })
  }
  const entry = change.kind === 'entry' ? card.book?.entries.find(item => item.uid === change.uid) : null
  if (typeof edit.after === 'string' && entry && isInitvar(entry)) {
    try {
      YAML.parse(entryText({ content: edit.after }))
    } catch (error) {
      throw httpError(400, msg`初始变量读不出来：${String(error.message).split('\n')[0]}`)
    }
  }
  return out
}

/** Whether a change would do anything; one that waits for a list to be written does nothing without it. */
function changesAnything(change) {
  if (change.fill && !String(change.replaceAfter ?? change.replace ?? '').trim()) return false
  if (change.kind === 'regex') return change.findAfter !== change.findBefore || change.replaceAfter !== change.replaceBefore || change.name || change.newOn || change.newEffect || change.enabled !== undefined || change.minDepth !== undefined || change.world
  if (change.kind === 'entry') return change.after !== change.before || change.name || change.keys || change.mode || change.enabled !== undefined
  if (change.kind === 'field' || change.kind === 'greeting' || change.kind === 'statusBar') return change.after !== change.before
  return true
}

/**
 * A finding with a person's edits over it: `edits`, by change id, { after, keys, find, replace, spec }.
 * One with nothing to take in yet is refused: a piece shown for writing by hand, left as it was.
 */
export function withEdits(card, finding, edits) {
  const changes = finding.changes.map(change => (edits?.[change.id] ? editedChange(card, change, edits[change.id]) : change))
  if (!changes.some(changesAnything)) throw httpError(400, msg`「${finding.title}」还没有改动，先写好再采用`)
  return { ...finding, changes }
}

/** The status bar's SillyTavern copy, kept to the layout: it is there when asked for, or when it was already. */
function syncStatusScripts(card, wanted) {
  const scripts = scriptsOf(card)
  if (!wanted && !scripts.some(script => OWN_SCRIPTS.has(script.id))) return
  const words = SCRIPT_WORDS[englishCard(card) ? 'en' : 'zh']
  card.regexScripts = [...scripts.filter(script => !OWN_SCRIPTS.has(script.id)), ...(card.statusBar ? statusScripts(card.statusBar, words) : [])]
}

/** A finding's changes into the card, in place → { applied, prefix }. */
export function applyFinding(card, finding) {
  const ids = finding.changes.map(change => change.id)
  const pick = kinds => finding.changes.filter(change => kinds.has(change.kind))
  let applied = 0
  let prefix = false
  const texts = pick(TEXT_KINDS)
  if (texts.length) {
    const done = applyChanges(card, texts, ids)
    applied += done.applied
    prefix ||= done.prefix
  }
  const entries = pick(BOOK_KINDS)
  if (entries.length) {
    const done = applyBookChanges(ensureBook(card), entries, ids)
    applied += done.applied
    prefix ||= done.prefix
  }
  const scripts = pick(REGEX_KINDS)
  if (scripts.length) {
    const subject = { scripts: scriptsOf(card) }
    const done = applyRegexChanges(subject, scripts, ids)
    card.regexScripts = cleanScripts(subject.scripts)
    applied += done.applied
    prefix ||= done.prefix
  }
  const status = finding.changes.find(change => change.kind === 'statusBar')
  if (status) applied += applyStatusChange(card, status)
  return { applied, prefix }
}

/**
 * A layout change into the card, its SillyTavern copy kept in step (检查这张卡, 对话修改) → how many went in (0 or 1).
 * It is display only: never in a chat's prefix.
 */
export function applyStatusChange(card, change) {
  const spec = cleanStatusSpec(change.spec)
  if (!spec) return 0
  card.statusBar = spec
  syncStatusScripts(card, change.scripts === true)
  return 1
}

// ─── Taking it back ───────────────────────────────────────────────────────

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The card as pieces that can be put back one at a time: key → { value, at, label }. */
function piecesOf(card) {
  const pieces = new Map()
  for (const { key } of CARD_FIELDS) pieces.set(`field:${key}`, { value: card[key] ?? '', label: key })
  pieces.set('field:tags', { value: card.tags ?? [], label: 'tags' })
  pieces.set('greetings', { value: greetingList(card), label: 'greetings' })
  pieces.set('statusBar', { value: card.statusBar ?? null, label: 'statusBar' })
  ;(card.book?.entries ?? []).forEach((entry, at) => pieces.set(`entry:${entry.uid}`, { value: entry, at, label: entry.comment || entry.uid }))
  scriptsOf(card).forEach((script, at) => pieces.set(`script:${script.id}`, { value: script, at, label: script.scriptName || script.id }))
  return pieces
}

/** A copy of the card's pieces, to compare with after a change (changedPieces). */
export const snapshot = card => {
  const pieces = piecesOf(card)
  return new Map([...pieces].map(([key, piece]) => [key, { ...piece, text: JSON.stringify(piece.value) }]))
}

/** What differs between a snapshot and the card now: [{ key, label, before, after, at }]. */
export function changedPieces(before, card) {
  const after = piecesOf(card)
  const changed = []
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key)
    const now = after.get(key)
    if (was?.text === JSON.stringify(now?.value ?? null) || (was && now && was.text === JSON.stringify(now.value))) continue
    changed.push({ key, label: (now ?? was).label, before: was ? JSON.parse(was.text) : null, after: now ? structuredClone(now.value) : null, at: was?.at ?? null })
  }
  return changed
}

/** One entry or script back in its list: in place, or at the spot it was removed from, or out again when it was new. */
function putBack(list, piece, idOf) {
  const id = piece.key.slice(piece.key.indexOf(':') + 1)
  const index = list.findIndex(item => idOf(item) === id)
  if (piece.before === null) {
    if (index >= 0) list.splice(index, 1)
  } else if (index >= 0) list[index] = piece.before
  else list.splice(Math.min(piece.at ?? list.length, list.length), 0, piece.before)
}

/** Put pieces back as they were; refused when one has changed since (nothing is changed then). */
export function restorePieces(card, pieces) {
  const now = piecesOf(card)
  for (const piece of pieces) {
    if (!same(now.get(piece.key)?.value, piece.after)) throw httpError(409, msg`采用之后「${piece.label}」又改过，不能撤销了`)
  }
  for (const piece of pieces) {
    if (piece.key.startsWith('field:')) {
      const key = piece.key.slice(6)
      card[key] = piece.before
    } else if (piece.key === 'greetings') {
      ;[card.firstMes, ...card.alternateGreetings] = piece.before
    } else if (piece.key === 'statusBar') {
      card.statusBar = piece.before
    } else if (piece.key.startsWith('entry:')) {
      putBack(ensureBook(card).entries, piece, entry => entry.uid)
    } else {
      card.regexScripts = scriptsOf(card)
      putBack(card.regexScripts, piece, script => script.id)
    }
  }
}
