// 修改角色卡: the fields of an imported card the page edits, shared by the
// server (which applies an edit to the stored card, server/http.mjs, and the
// assistant's proposals, server/forge/edit.mjs) and the page (web/card-edit.js,
// which shows a proposal as before and after).
//
// A chat renders the card into its frozen prefix when it starts (server/prompt.mjs):
// the fields marked `prefix` reach an open chat only once its prefix is built
// again. The character note goes with every turn; the openings only start new
// chats; the notes, the creator and the tags never reach the model.

export const CARD_FIELDS = Object.freeze([
  { key: 'name', prefix: true, max: 200 },
  { key: 'description', prefix: true },
  { key: 'personality', prefix: true },
  { key: 'scenario', prefix: true },
  { key: 'mesExample', prefix: true },
  { key: 'systemPrompt', prefix: true },
  { key: 'postHistoryInstructions', prefix: true },
  { key: 'depthPrompt', prefix: false },
  { key: 'creatorNotes', prefix: false },
  { key: 'creator', prefix: false, max: 200 },
])

const MAX_TEXT = 200000
const MAX_GREETINGS = 60
const MAX_TAGS = 20

/** The card's openings in order: the first message, then the alternates. */
export const greetingList = card => [card.firstMes ?? '', ...(Array.isArray(card.alternateGreetings) ? card.alternateGreetings : [])]

/** Tags from a list or "a, b，c": trimmed, one each, at most 20 as the importer keeps them. */
export function cleanTags(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、]/) : []
  return [...new Set(list.map(tag => String(tag).replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean))].slice(0, MAX_TAGS)
}

/**
 * Apply `patch` to a stored card in place: any of CARD_FIELDS (strings),
 * `greetings` (the whole list; blank alternates are dropped) and `tags`.
 * Returns the keys that changed and whether a chat's prefix would now come out
 * different. A blank name is refused (the caller says so).
 */
export function editCard(card, patch = {}) {
  const changed = []
  for (const { key, max = MAX_TEXT } of CARD_FIELDS) {
    if (typeof patch[key] !== 'string') continue
    const value = key === 'name' || key === 'creator' ? patch[key].replace(/\s+/g, ' ').trim().slice(0, max) : patch[key].slice(0, max)
    if (key === 'name' && !value) throw Object.assign(new Error('blank name'), { blankName: true })
    if (value === (card[key] ?? '')) continue
    card[key] = value
    changed.push(key)
  }
  if (Array.isArray(patch.greetings)) {
    const [first = '', ...rest] = patch.greetings.slice(0, MAX_GREETINGS).map(text => (typeof text === 'string' ? text.slice(0, MAX_TEXT) : ''))
    const alternates = rest.filter(text => text.trim())
    if (first !== (card.firstMes ?? '') || JSON.stringify(alternates) !== JSON.stringify(card.alternateGreetings ?? [])) {
      card.firstMes = first
      card.alternateGreetings = alternates
      changed.push('greetings')
    }
  }
  if (patch.tags !== undefined) {
    const tags = cleanTags(patch.tags)
    if (JSON.stringify(tags) !== JSON.stringify(card.tags ?? [])) {
      card.tags = tags
      changed.push('tags')
    }
  }
  return { changed, prefix: changed.some(key => CARD_FIELDS.find(f => f.key === key)?.prefix) }
}

// ─── Before and after ────────────────────────────────────────────────────
// Line by line (longest common run), and inside a changed line the part that
// differs, so a proposal shows what it would change without a wall of text.

const MAX_CELLS = 400000

/** Inside one changed line: the common start and end, and what differs between. */
export function inlineDiff(before, after) {
  const a = [...before]
  const b = [...after]
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  return [
    { op: 'same', text: a.slice(0, start).join('') },
    { op: 'del', text: a.slice(start, a.length - end).join('') },
    { op: 'add', text: b.slice(start, b.length - end).join('') },
    { op: 'same', text: a.slice(a.length - end).join('') },
  ].filter(part => part.text)
}

/**
 * Lines of `before` and `after` as [{ op: 'same' | 'del' | 'add' | 'change', text, parts? }];
 * a removed line followed by an added one is a 'change' with its inline parts.
 * Very long texts on both sides are shown as all removed, then all added.
 */
export function diffLines(before, after) {
  const a = String(before ?? '').split('\n')
  const b = String(after ?? '').split('\n')
  if (!String(before ?? '')) return String(after ?? '') ? b.map(text => ({ op: 'add', text })) : []
  if (!String(after ?? '')) return a.map(text => ({ op: 'del', text }))
  let ops
  if (a.length * b.length > MAX_CELLS) {
    ops = [...a.map(text => ({ op: 'del', text })), ...b.map(text => ({ op: 'add', text }))]
  } else {
    // lengths[i][j]: the longest common run of a[i..] and b[j..].
    const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
    ops = []
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        ops.push({ op: 'same', text: a[i] })
        i++
        j++
      } else if (j < b.length && (i === a.length || lengths[i][j + 1] >= lengths[i + 1][j])) {
        ops.push({ op: 'add', text: b[j++] })
      } else {
        ops.push({ op: 'del', text: a[i++] })
      }
    }
  }
  return pairChanges(ops)
}

/** Each run of removed lines and the added run right after it, paired line by line. */
function pairChanges(ops) {
  const out = []
  for (let k = 0; k < ops.length; ) {
    if (ops[k].op !== 'del' && ops[k].op !== 'add') {
      out.push(ops[k++])
      continue
    }
    const dels = []
    const adds = []
    while (k < ops.length && (ops[k].op === 'del' || ops[k].op === 'add')) (ops[k].op === 'del' ? dels : adds).push(ops[k++].text)
    const pairs = Math.min(dels.length, adds.length)
    for (let n = 0; n < pairs; n++) out.push({ op: 'change', text: adds[n], parts: inlineDiff(dels[n], adds[n]) })
    for (const text of dels.slice(pairs)) out.push({ op: 'del', text })
    for (const text of adds.slice(pairs)) out.push({ op: 'add', text })
  }
  return out
}

/** Long runs of unchanged lines folded to `context` lines on each side: { op: 'skip', count }. */
export function foldSame(lines, context = 1) {
  const out = []
  for (let k = 0; k < lines.length; ) {
    if (lines[k].op !== 'same') {
      out.push(lines[k++])
      continue
    }
    let end = k
    while (end < lines.length && lines[end].op === 'same') end++
    const run = lines.slice(k, end)
    const head = k === 0 ? 0 : context
    const tail = end === lines.length ? 0 : context
    if (run.length > head + tail + 1) out.push(...run.slice(0, head), { op: 'skip', count: run.length - head - tail }, ...run.slice(run.length - tail))
    else out.push(...run)
    k = end
  }
  return out
}
