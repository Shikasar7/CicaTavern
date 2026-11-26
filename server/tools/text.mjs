// A text file's bytes as text and back, unchanged where nothing was changed: its encoding (UTF-8, GBK), its byte order
// mark and its line ends stay. And what a change comes to, line by line, for the player to look at before it is made.
import { createHash } from 'node:crypto'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

export const hashOf = bytes => createHash('sha256').update(bytes).digest('hex')

/** { text, encoding: 'utf-8' | 'gbk', bom } of a text file's bytes, or null for anything else. */
export function decodeText(bytes) {
  const bom = bytes.length >= 3 && bytes.subarray(0, 3).equals(BOM)
  const body = bom ? bytes.subarray(3) : bytes
  if (body.includes(0)) return null
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body), encoding: 'utf-8', bom }
  } catch {
    // Not UTF-8.
  }
  if (bom) return null
  try {
    const text = new TextDecoder('gbk', { fatal: true }).decode(body)
    // Bytes of some other kind that happen to be GBK: it must also come back as it was.
    return encodeText(text, { encoding: 'gbk' })?.equals(body) ? { text, encoding: 'gbk', bom: false } : null
  } catch {
    // Not GBK either (or a Node without it).
    return null
  }
}

let gbkBytes = null
/** Character → its two GBK bytes: Node can read GBK but not write it. */
function gbkTable() {
  if (gbkBytes) return gbkBytes
  gbkBytes = new Map()
  const decoder = new TextDecoder('gbk')
  for (let high = 0x81; high <= 0xfe; high++) {
    for (let low = 0x40; low <= 0xfe; low++) {
      if (low === 0x7f) continue
      const char = decoder.decode(Uint8Array.of(high, low))
      if ([...char].length === 1 && char !== '�' && !gbkBytes.has(char)) gbkBytes.set(char, [high, low])
    }
  }
  return gbkBytes
}

/** The characters of `text` GBK does not have (a few of them). */
export function notInGbk(text) {
  const table = gbkTable()
  return [...new Set([...text].filter(char => char.codePointAt(0) >= 0x80 && !table.has(char)))].slice(0, 10)
}

/** Text as the bytes of its file; null when its encoding has not all of its characters. */
export function encodeText(text, { encoding = 'utf-8', bom = false } = {}) {
  if (encoding !== 'gbk') return bom ? Buffer.concat([BOM, Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8')
  const table = gbkTable()
  const out = []
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x80) out.push(code)
    else if (table.has(char)) out.push(...table.get(char))
    else return null
  }
  return Buffer.from(out)
}

/** The line end most of a text's lines have. */
export function lineEnd(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

export const toLf = text => text.replace(/\r\n/g, '\n')
export const withEnds = (text, end) => (end === '\r\n' ? toLf(text).replace(/\n/g, '\r\n') : toLf(text))

/**
 * `before` (as it is on disk) with one passage changed: `from` and `to` are the model's, with \n line ends; everything
 * outside the passage stays byte for byte. → { text } or { found: how many times it is there }.
 */
export function replaceOnce(before, from, to) {
  if (!from) return { found: 0 }
  // Where each character of the \n text is in the text as it is.
  const at = []
  let plain = ''
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '\r' && before[i + 1] === '\n') continue
    at.push(i)
    plain += before[i]
  }
  at.push(before.length)
  let found = 0
  let first = -1
  for (let i = plain.indexOf(from); i >= 0 && found < 50; i = plain.indexOf(from, i + 1)) {
    if (!found) first = i
    found++
  }
  if (found !== 1) return { found }
  // A passage that begins at a line end takes its \r along.
  const start = plain[first] === '\n' && before[at[first] - 1] === '\r' ? at[first] - 1 : at[first]
  const stop = first + from.length
  const end = plain[stop] === '\n' && before[at[stop] - 1] === '\r' ? at[stop] - 1 : at[stop]
  return { text: before.slice(0, start) + withEnds(to, lineEnd(before)) + before.slice(end) }
}

// More lines than this on both sides (after what is the same at the ends): shown as all out, all in.
const DIFF_CELLS = 4_000_000

/**
 * What a change comes to: { added, removed, rows: [{ kind: 'same' | 'add' | 'del' | 'gap', text, lines? }], clipped }.
 * Unchanged lines far from a change are one `gap`.
 */
export function diffLines(before, after, { context = 3, max = 400 } = {}) {
  const split = text => (text === '' ? [] : toLf(text).replace(/\n$/, '').split('\n'))
  const a = split(before)
  const b = split(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const middle = []
  if (x.length * y.length > DIFF_CELLS) {
    middle.push(...x.map(text => ({ kind: 'del', text })), ...y.map(text => ({ kind: 'add', text })))
  } else {
    const width = y.length + 1
    const table = new Uint32Array((x.length + 1) * width)
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        middle.push({ kind: 'same', text: x[i] })
        i++
        j++
      } else if (i < x.length && (j >= y.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) middle.push({ kind: 'del', text: x[i++] })
      else middle.push({ kind: 'add', text: y[j++] })
    }
  }
  const all = [...a.slice(0, head).map(text => ({ kind: 'same', text })), ...middle, ...a.slice(a.length - tail).map(text => ({ kind: 'same', text }))]
  const near = new Set()
  all.forEach((row, index) => {
    if (row.kind === 'same') return
    for (let k = index - context; k <= index + context; k++) near.add(k)
  })
  const rows = []
  for (let k = 0; k < all.length; k++) {
    if (near.has(k)) rows.push(all[k])
    else if (rows.at(-1)?.kind === 'gap') rows.at(-1).lines++
    else rows.push({ kind: 'gap', text: '', lines: 1 })
  }
  return {
    added: middle.filter(row => row.kind === 'add').length,
    removed: middle.filter(row => row.kind === 'del').length,
    rows: rows.slice(0, max).map(row => (row.text.length > 2000 ? { ...row, text: `${row.text.slice(0, 2000)}…` } : row)),
    clipped: Math.max(0, rows.length - max),
  }
}
