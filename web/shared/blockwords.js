// 屏蔽词 (设置 → 屏蔽词): words taken out of, masked in, or swapped in what is
// sent to the model (server/blockwords.mjs, the last thing done to a request)
// and what the page shows (web/render.js, before the card's display regex).
// Only the copy on its way changes: what is stored stays as written, so a word
// switched off comes back everywhere.
//
// Chinese has no spaces between words, so 整词 only looks at an edge that is a
// letter, digit or underscore (as a lorebook's whole-word keys do); to spare a
// longer word that holds the blocked one (屏蔽「猫」, not「熊猫」) it is listed
// as an exception.

export const BLOCK_MODES = Object.freeze(['remove', 'mask', 'replace'])
export const BLOCK_SCOPES = Object.freeze(['both', 'display', 'prompt'])

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const WORD_EDGE = /[A-Za-z0-9_]/

/** Keep only the fields the matcher reads; drop entries without a word. */
export function normalizeBlockWords(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter(w => w && typeof w === 'object' && typeof w.word === 'string' && w.word.trim() !== '')
    .map(w => {
      const replacement = typeof w.replacement === 'string' ? w.replacement : ''
      const mode = BLOCK_MODES.includes(w.mode) ? w.mode : 'remove'
      return {
        id: String(w.id ?? ''),
        word: w.word.trim(),
        // 换成 with nothing to put in is 去掉.
        mode: mode === 'replace' && !replacement ? 'remove' : mode,
        replacement: mode === 'replace' ? replacement : '',
        scope: BLOCK_SCOPES.includes(w.scope) ? w.scope : 'both',
        caseSensitive: w.caseSensitive === true,
        wholeWord: w.wholeWord === true,
        exceptions: Array.isArray(w.exceptions) ? [...new Set(w.exceptions.filter(e => typeof e === 'string').map(e => e.trim()).filter(Boolean))] : [],
        disabled: w.disabled === true,
      }
    })
}

/** Whether a word changes `target` ('prompt' or 'display'). */
export const blocksIn = (word, target) => !word.disabled && (word.scope === 'both' || word.scope === target)

function matcherOf(word) {
  const fold = text => (word.caseSensitive ? text : text.toLowerCase())
  const own = word.wholeWord
    ? `${WORD_EDGE.test(word.word[0]) ? '\\b' : ''}${escapeRegex(word.word)}${WORD_EDGE.test(word.word.at(-1)) ? '\\b' : ''}`
    : escapeRegex(word.word)
  // Only an exception that holds the word can spare it; the longest is tried first.
  const spared = word.exceptions
    .filter(e => e.length > word.word.length && fold(e).includes(fold(word.word)))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
  return new RegExp(spared.length ? `(${spared.join('|')})|${own}` : own, word.caseSensitive ? 'g' : 'gi')
}

const matchers = new WeakMap() // a list → [{ word, re }], the longest word first

function matchersFor(words) {
  let list = matchers.get(words)
  if (!list) {
    list = words
      .filter(word => !word.disabled)
      .map(word => ({ word, re: matcherOf(word) }))
      .sort((a, b) => b.word.word.length - a.word.word.length)
    matchers.set(words, list)
  }
  return list
}

const swapFor = (word, match) => (word.mode === 'mask' ? '*'.repeat([...match].length) : word.mode === 'replace' ? word.replacement : '')

// What a word was swapped for waits in a slot (two noncharacters around an index in the
// private use area) until every word has run, so no word ever matches another one's
// replacement, or text that a removal pushed together.
const SLOT = /﷐([-])([-])﷑/g
const slotMark = index => `﷐${String.fromCharCode(0xe000 + Math.floor(index / 6400), 0xe000 + (index % 6400))}﷑`

/**
 * `text` with the words that change `target` taken out, masked or swapped, each
 * place once; the longest word goes first where two overlap.
 * @param words - normalizeBlockWords() entries, in the order the list has them.
 * @param options.partial - text still streaming: an end that may be the start of a word waits for the rest.
 * @returns { text, hits } — hits is how many places changed.
 */
export function blockReport(text, words, { target, partial = false } = {}) {
  let out = String(text ?? '')
  if (!Array.isArray(words) || !words.length || !out) return { text: out, hits: 0 }
  const active = matchersFor(words).filter(m => blocksIn(m.word, target))
  if (!active.length) return { text: out, hits: 0 }
  const slots = []
  for (const { word, re } of active) {
    out = out.replace(re, (match, spared) => {
      if (typeof spared === 'string') return match
      slots.push(swapFor(word, match))
      return slotMark(slots.length - 1)
    })
  }
  if (partial) {
    let cut = 0
    for (const { word } of active) {
      const fold = value => (word.caseSensitive ? value : value.toLowerCase())
      const whole = fold(word.word)
      for (let length = Math.min(whole.length - 1, out.length); length > cut; length--) {
        if (fold(out.slice(-length)) === whole.slice(0, length)) {
          cut = length
          break
        }
      }
    }
    if (cut) out = out.slice(0, -cut)
  }
  if (slots.length) out = out.replace(SLOT, (whole, high, low) => slots[(high.charCodeAt(0) - 0xe000) * 6400 + low.charCodeAt(0) - 0xe000] ?? whole)
  return { text: out, hits: slots.length }
}

/** blockReport()'s text. */
export const blockText = (text, words, options) => blockReport(text, words, options).text

/** The entries that change what is sent, as they decide it: two lists that give the same send the model the same text. */
export const promptRules = words => JSON.stringify(normalizeBlockWords(words).filter(w => blocksIn(w, 'prompt')).map(({ id, scope, disabled, ...rule }) => rule))
