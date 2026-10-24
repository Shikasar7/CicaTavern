// A zip read in the page (导入表情包, web/vn.js): its files and their bytes.
// Pure but for inflating, which the caller passes (DecompressionStream in the
// page, zlib in the tests). No zip64 and no encryption: an expression pack has
// neither.

const END = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** A name as stored: UTF-8 when flagged, else UTF-8 if it reads as such, else GBK (zips made on Chinese Windows). */
function nameOf(bytes, utf8) {
  if (!utf8) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      try {
        return new TextDecoder('gbk').decode(bytes)
      } catch {
        // No GBK here: read it as UTF-8 anyway.
      }
    }
  }
  return new TextDecoder().decode(bytes)
}

/** A zip's files (folders left out): { name, method, encrypted, compressed, size, offset }. Throws when it cannot be read. */
export function zipEntries(bytes) {
  const view = viewOf(bytes)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('not a zip')
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) throw new Error('broken zip')
    const flags = view.getUint16(at + 8, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const name = nameOf(bytes.subarray(at + 46, at + 46 + nameLength), flags & 0x0800).replace(/\\/g, '/')
    if (!name.endsWith('/')) {
      entries.push({
        name,
        method: view.getUint16(at + 10, true),
        encrypted: Boolean(flags & 1),
        compressed: view.getUint32(at + 20, true),
        size: view.getUint32(at + 24, true),
        offset: view.getUint32(at + 42, true),
      })
    }
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * An entry's bytes.
 * @param inflateRaw - (Uint8Array) → Promise<Uint8Array>, for the deflated ones.
 */
export async function zipData(bytes, entry, inflateRaw) {
  if (entry.encrypted) throw new Error('encrypted')
  const view = viewOf(bytes)
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== LOCAL) throw new Error('broken zip')
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  const data = bytes.subarray(start, start + entry.compressed)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRaw(data)
  throw new Error(`compression ${entry.method}`)
}
