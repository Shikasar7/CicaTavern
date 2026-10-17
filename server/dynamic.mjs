// Dynamic worldbook entries (the variable list) change with the state, and
// anything the model sees is cached and then replayed. Editing an earlier
// message to delete the old copies loses the cache from that message on
// (measured), so that is not done every turn. Each turn sends only the lines
// that changed; once the old copies have piled up they are stripped in one
// pass, which rewrites the history cache once and leaves the frozen prefix.

export const COMPACT_AT = 6000
export const FULL_EVERY = 8

const BLOCK = /<动态设定>([\s\S]*?)<\/动态设定>/g
const STRIP_BLOCK = /[ \t]*<动态设定>[\s\S]*?<\/动态设定>[ \t]*(?:\r?\n)?/g

/** Drop `<动态设定>` blocks from a user-message text. Other text stays. */
export function stripDynamicText(text) {
  if (!text || !text.includes('<动态设定>')) return text
  return text.replace(STRIP_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim()
}

export function dynamicBlockChars(prompt) {
  if (!prompt) return 0
  let chars = 0
  for (const match of String(prompt).matchAll(BLOCK)) chars += match[1].length
  return chars
}

/** Last full snapshot and how many turns have passed since it, from user nodes. */
export function dynamicMemory(path) {
  let anchor = ''
  let lastRendered = ''
  let sinceFull = 0
  for (const node of path) {
    const recorded = node.dynamic
    if (!recorded) continue
    if (recorded.mode === 'full') {
      anchor = recorded.rendered
      sinceFull = 0
    } else if (recorded.mode === 'diff' || recorded.mode === 'omit') {
      sinceFull += 1
    }
    if (recorded.rendered) lastRendered = recorded.rendered
  }
  return { anchor, lastRendered, sinceFull }
}

/**
 * Characters of `<动态设定>` still expected in the transcript. A node marked
 * `compacted` means everything before it was stripped, so only that node and
 * what follows still count.
 */
export function accumulatedDynamic(path) {
  let start = 0
  path.forEach((node, index) => {
    if (node.dynamic?.compacted) start = index
  })
  let chars = 0
  for (const node of path.slice(start)) {
    if (node.role === 'user') chars += dynamicBlockChars(node.prompt)
  }
  return chars
}

// How many full copies may pile up before they are stripped (settings.dynamicStrip).
// Stripping rewrites the history cache from the first message, so stripping less
// is usually cheaper: the old copies are read from the cache at a tenth of the
// price. 'off' leaves them until the next context compaction.
export const STRIP_FACTORS = Object.freeze({ often: 2.5, rare: 6, off: Infinity })

/**
 * When the pile-up is worth stripping. The newest full copy always stays, so a
 * fixed bar below its size would strip (and resend in full) every turn; the bar
 * grows with that copy instead.
 */
export function compactThreshold(path, mode = 'rare') {
  const factor = STRIP_FACTORS[mode] ?? STRIP_FACTORS.rare
  const { anchor } = dynamicMemory(path)
  return Math.max(COMPACT_AT, Math.round(anchor.length * factor))
}

function linesOf(text) {
  return String(text).split('\n').map(line => line.trimEnd()).filter(line => line.trim())
}

/**
 * What this turn's `<动态设定>` should contain.
 * @returns {{ mode: 'omit'|'diff'|'full', text: string, state: { mode: string, rendered: string } }}
 */
export function planDynamic({ rendered, anchor, lastRendered, sinceFull, forceFull = false }) {
  const text = String(rendered ?? '').trim()
  if (!text) return { mode: 'omit', text: '', state: { mode: 'omit', rendered: '' } }
  const refresh = forceFull || !anchor || sinceFull + 1 >= FULL_EVERY
  if (!forceFull && text === lastRendered && !refresh) {
    return { mode: 'omit', text: '', state: { mode: 'omit', rendered: text } }
  }
  if (!refresh && anchor && text !== anchor) {
    const oldLines = new Set(linesOf(anchor))
    const current = linesOf(text)
    const currentSet = new Set(current)
    const added = current.filter(line => !oldLines.has(line))
    const removed = linesOf(anchor).filter(line => !currentSet.has(line))
    const parts = []
    if (added.length) parts.push(`改为或新增：\n${added.map(line => `+ ${line}`).join('\n')}`)
    if (removed.length) parts.push(`去掉：\n${removed.map(line => `- ${line}`).join('\n')}`)
    const body = parts.join('\n')
    const payload = `（增量，相对本对话最近一次完整动态设定。以本块为准，历史里更早的增量作废。）\n${body}`
    if (body && payload.length < text.length * 0.7) {
      return { mode: 'diff', text: payload, state: { mode: 'diff', rendered: text } }
    }
  }
  const header = anchor ? '（当前完整动态设定。历史里更早的动态设定作废。）\n' : ''
  return { mode: 'full', text: header + text, state: { mode: 'full', rendered: text } }
}
