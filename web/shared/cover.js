// 开场页: what a card shows above its opening before the story starts, drawn by the app (web/cover.js): the card's
// name large, a line under it, a few lines of what the story is, and the openings to pick from. It is words only; the
// pictures on it are the app's own (the card's picture, 角色名册的立绘, 视觉小说的场景, or one picked for the cover in
// 修改角色卡, card.coverArt), and its colors are the status bar's three when the card has them.
//   cover: { tagline: '零点以后才开门的钟表店', lines: ['…', '…'], openings: [{ title: '第一夜', brief: '雨夜，巷口' }], effect: 'rain' }
//   `figure: false`: no one stands at its side (the picture behind it has them already).
import { cleanEffect } from './status.js'

// A card on its way to SillyTavern has the cover as its first opening: this mark, which a display regex of the card
// turns into a page (server/forge/cover-frame.mjs). A card kept here never has it.
export const COVER_MARK = '<CoverPage/>'
export const COVER_SCRIPT = 'cicatavern-cover'
export const COVER_HIDE_SCRIPT = 'cicatavern-cover-hide'

const MAX_LINES = 4
const MAX_OPENINGS = 12

const words = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** A cover as a card keeps it, or null when the card has none. */
export function cleanCover(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).map(line => words(line, 80)).filter(Boolean).slice(0, MAX_LINES)
  const openings = (Array.isArray(raw.openings) ? raw.openings : []).slice(0, MAX_OPENINGS).map(item => ({ title: words(item?.title, 24), brief: words(item?.brief, 60) }))
  const effect = cleanEffect(raw.effect)
  // `st: false`: the cover stays here; the card goes to SillyTavern with its own openings, as it would without one.
  return { tagline: words(raw.tagline, 60), lines, ...(openings.some(item => item.title || item.brief) ? { openings } : {}), ...(effect ? { effect } : {}), ...(raw.figure === false ? { figure: false } : {}), ...(raw.st === false ? { st: false } : {}) }
}

/** A few sentences as lines of a cover: cut at the full stops, the first one the line under the name. */
export function coverWords(summary) {
  const parts = String(summary ?? '').replace(/\s+/g, ' ').trim().match(/[^。！？!?.…]+[。！？!?.…]*/g) ?? []
  const lines = parts.map(part => part.trim()).filter(Boolean)
  const first = (lines.shift() ?? '').replace(/[。.]$/, '')
  return { tagline: first.slice(0, 60), lines: lines.slice(0, MAX_LINES).map(line => line.slice(0, 80)) }
}

const plainStart = text => String(text ?? '')
  .replace(/<[^<>]{0,200}>/g, ' ')
  .replace(/\{\{[^{}]{0,80}\}\}/g, '\u0000')
  .replace(/\s+/g, ' ')
  .trim()

/** What to call an opening that has no name: its first words. */
export function openingStart(text, max = 22) {
  const start = plainStart(text).replaceAll('\u0000', '…')
  const cut = /^[^。！？!?\n]{4,}?[。！？!?]/.exec(start)?.[0] ?? start
  return cut.length > max ? `${cut.slice(0, max)}…` : cut
}

/**
 * Which of a card's openings a chat started with (the chat keeps the text, with its macros filled in): the one whose
 * words before its first macro the chat's first message starts with. -1 when none can be told.
 */
export function pickedOpening(greetings, rootText) {
  const shown = plainStart(rootText)
  if (!shown) return -1
  let best = -1
  let most = 0
  for (const [index, greeting] of (greetings ?? []).entries()) {
    // The longest run of plain words near its start, free of macros: that much must be in the chat's first message.
    const run = plainStart(greeting).slice(0, 400).split('\u0000').sort((a, b) => b.length - a.length)[0]?.trim().slice(0, 60) ?? ''
    if (run.length >= 6 && run.length > most && shown.includes(run)) {
      best = index
      most = run.length
    }
  }
  return best
}

// A variable that says how someone feels right now: its word picks the face (web/shared/stage.js faceOf). One kept
// for the face itself (表情; 创作角色卡 gives the card one, off the bar) comes before a mood in the card's own words.
const FACE = /^(?:表情|神情|expression|face)$/i
const MOOD = /心情|情绪|表情|神情|神色|mood|emotion|feeling/i

/** The field of a bar that holds a face or a mood, in the group named `owner` first: its path, or ''. */
export function moodPath(spec, owner = '') {
  const key = field => String(field.path).split('.').at(-1)
  const own = fields => fields.find(field => owner && String(field.path).split('.')[0] === owner) ?? fields[0]
  const faces = (spec?.fields ?? []).filter(field => FACE.test(key(field)))
  const moods = (spec?.fields ?? []).filter(field => field.show !== 'hidden' && (MOOD.test(field.label ?? '') || MOOD.test(key(field))))
  return (own(faces) ?? own(moods))?.path ?? ''
}
