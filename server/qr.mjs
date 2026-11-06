// QR codes for the phone links (设置 → 手机访问): byte mode at error correction level M, drawn as an SVG.
// The links are short, so versions 1 to 15 (up to 412 bytes) are all there is here.

const MAX_VERSION = 15
// Level M, by version: error correction codewords in each block, and how many blocks.
const CHECK_WORDS = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24]
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10]
// The white margin a scanner needs around the code, in modules.
const QUIET = 4

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/** Arithmetic in GF(256), for the error correction. */
const EXP = new Array(510)
const LOG = new Array(256)
for (let i = 0, value = 1; i < 255; i++) {
  EXP[i] = EXP[i + 255] = value
  LOG[value] = i
  value = (value << 1) ^ (value & 0x80 ? 0x11d : 0)
}
const times = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)

/** The Reed-Solomon generator of this degree, its leading 1 left out. */
function generator(degree) {
  const poly = new Array(degree).fill(0)
  poly[degree - 1] = 1
  for (let i = 0, root = 1; i < degree; i++, root = times(root, 2)) {
    for (let j = 0; j < degree; j++) poly[j] = times(poly[j], root) ^ (poly[j + 1] ?? 0)
  }
  return poly
}

function checkWords(data, poly) {
  const out = new Array(poly.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ out.shift()
    out.push(0)
    poly.forEach((word, i) => { out[i] ^= times(word, factor) })
  }
  return out
}

/** All the codewords a version holds, data and error correction together. */
function totalWords(version) {
  let bits = (16 * version + 128) * version + 64
  if (version >= 2) {
    const aligns = Math.floor(version / 7) + 2
    bits -= (25 * aligns - 10) * aligns - 55
    if (version >= 7) bits -= 36
  }
  return Math.floor(bits / 8)
}

const dataWords = version => totalWords(version) - CHECK_WORDS[version] * BLOCKS[version]
const lengthBits = version => (version < 10 ? 8 : 16)

/** The smallest version the bytes fit in; 0 when they fit in none. */
function versionFor(bytes) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (4 + lengthBits(version) + bytes.length * 8 <= dataWords(version) * 8) return version
  }
  return 0
}

function encode(bytes, version) {
  const bits = []
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(4, 4)
  put(bytes.length, lengthBits(version))
  for (const byte of bytes) put(byte, 8)
  const room = dataWords(version) * 8
  put(0, Math.min(4, room - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < room; pad ^= 0xec ^ 0x11) put(pad, 8)
  const words = []
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((word, bit) => (word << 1) | bit, 0))
  return words
}

/** The data split into its blocks, each with its check words, read across the blocks. */
function interleaved(data, version) {
  const count = BLOCKS[version]
  const poly = generator(CHECK_WORDS[version])
  const short = Math.floor(data.length / count)
  const longer = data.length % count
  const blocks = []
  for (let i = 0, at = 0; i < count; i++) {
    const length = short + (i >= count - longer ? 1 : 0)
    const words = data.slice(at, at + length)
    at += length
    blocks.push({ words, check: checkWords(words, poly) })
  }
  const out = []
  for (let i = 0; i <= short; i++) for (const { words } of blocks) if (i < words.length) out.push(words[i])
  for (let i = 0; i < CHECK_WORDS[version]; i++) for (const { check } of blocks) out.push(check[i])
  return out
}

function alignCenters(version) {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2
  const centers = [6]
  for (let at = version * 4 + 10; centers.length < count; at -= step) centers.splice(1, 0, at)
  return centers
}

/** The fixed parts of the symbol: `cells` what they show, `fixed` where the data cannot go. */
function layout(version) {
  const size = version * 4 + 17
  const cells = Array.from({ length: size }, () => new Array(size).fill(0))
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, dark) => {
    cells[y][x] = dark ? 1 : 0
    fixed[y][x] = true
  }
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        const ring = Math.max(Math.abs(dx), Math.abs(dy))
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4)
      }
    }
  }
  const centers = alignCenters(version)
  const last = centers.length - 1
  centers.forEach((cx, i) => centers.forEach((cy, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  if (version >= 7) {
    let rest = version
    for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25)
    const bits = (version << 12) | rest
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, dark)
      set(b, a, dark)
    }
  }
  return { size, cells, fixed, set }
}

/** Level M and the mask, in the two places the format is written. */
function writeFormat({ size, set }, mask) {
  let rest = mask
  for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537)
  const bits = ((mask << 10) | rest) ^ 0x5412
  const bit = i => ((bits >>> i) & 1) === 1
  for (let i = 0; i <= 5; i++) set(8, i, bit(i))
  set(8, 7, bit(6))
  set(8, 8, bit(7))
  set(7, 8, bit(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
  set(8, size - 8, true)
}

/** The codewords up and down the columns, two at a time from the right, around what is fixed. */
function writeData({ size, cells, fixed }, words) {
  let at = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step
      for (const x of [right, right - 1]) {
        if (fixed[y][x] || at >= words.length * 8) continue
        cells[y][x] = (words[at >>> 3] >>> (7 - (at & 7))) & 1
        at++
      }
    }
  }
}

/** How hard a symbol is to read, by the standard's four rules; the lowest is drawn. */
function penalty(cells) {
  const size = cells.length
  let score = 0
  for (const line of [...cells, ...cells.map((_, x) => cells.map(row => row[x]))]) {
    for (let i = 1, run = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++
      else {
        if (run >= 5) score += run - 2
        run = 1
      }
    }
    const text = line.join('')
    for (const finder of ['10111010000', '00001011101']) {
      for (let at = text.indexOf(finder); at >= 0; at = text.indexOf(finder, at + 1)) score += 40
    }
  }
  let dark = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      dark += cells[y][x]
      if (x && y && cells[y][x] === cells[y][x - 1] && cells[y][x] === cells[y - 1][x] && cells[y][x] === cells[y - 1][x - 1]) score += 3
    }
  }
  const total = size * size
  return score + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
}

/** The modules of a code for `text`, rows of 0 and 1; null when it is too long for one. */
export function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')]
  const version = versionFor(bytes)
  if (!version) return null
  const words = interleaved(encode(bytes, version), version)
  let best = null
  let lowest = Infinity
  MASKS.forEach((masked, mask) => {
    const symbol = layout(version)
    writeFormat(symbol, mask)
    writeData(symbol, words)
    const { size, cells, fixed } = symbol
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && masked(x, y)) cells[y][x] ^= 1
    const score = penalty(cells)
    if (score < lowest) [best, lowest] = [cells, score]
  })
  return best
}

/** A code for `text` as an SVG with its margin; '' when it is too long for one. The white behind it is the page's to draw. */
export function qrSvg(text) {
  const cells = qrMatrix(text)
  if (!cells) return ''
  const paths = []
  cells.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue
      const start = x
      while (row[x + 1]) x++
      paths.push(`M${start + QUIET} ${y + QUIET}h${x - start + 1}v1h-${x - start + 1}z`)
    }
  })
  const size = cells.length + QUIET * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="#000" d="${paths.join('')}"/></svg>`
}
