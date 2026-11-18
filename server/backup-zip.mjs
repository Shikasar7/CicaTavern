// Zips of any size, written as they go and read from a file (备份与换设备, backup.mjs): a whole data folder runs to
// gigabytes, so neither side ever holds the zip in memory. Written: each file read (or, past STREAM_AT, streamed
// twice, once for its CRC), its header, its bytes; the central directory at the end. Zip64 where a size, an offset
// or the count needs it, so other zip tools open it too. Read: the end, the central directory, then each entry from
// the file on its own. Runs on the phone's Node 18 (no zlib.crc32 there: crcOf).
import { createReadStream, createWriteStream } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { crcOf } from './update/zip.mjs'

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const END64 = 0x06064b50
const LOCATOR64 = 0x07064b50
const MAX32 = 0xffffffff
const MAX16 = 0xffff
// Files larger than this are not read whole: streamed once for the CRC, once into the zip, stored as they are.
const STREAM_AT = 64 * 1024 * 1024
// Text this size or under is deflated (chats, books, presets: JSON shrinks to a fifth); pictures are stored.
const DEFLATE_MAX = STREAM_AT
const TEXT = /\.(json|jsonl|txt|md|yaml|yml)$/i

function dosTime(when) {
  const at = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date()
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  }
}

/** A CRC-32 carried on chunk by chunk (crcOf over one buffer, continued). */
let table = null
function crcUpdate(crc, bytes) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(bytes, crc)
  table ??= Int32Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c
  })
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function crcOfFile(file) {
  let crc = 0
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) crc = crcUpdate(crc, chunk)
  return crc >>> 0
}

/**
 * A zip written piece by piece through `write(buffer)` (a promise that settles when it may go on: the response
 * drained). → { addBuffer(name, data, when), addFile(name, file), finish() → bytes written, entries }.
 * @param always64 - zip64 fields on every entry and at the end, needed or not (tests: the same format a 4 GB backup has).
 */
export function createZipWriter(write, { always64 = false } = {}) {
  const wide64 = value => always64 || value >= MAX32
  const central = []
  let offset = 0
  let count = 0
  const put = async buffer => {
    if (!buffer.length) return
    await write(buffer)
    offset += buffer.length
  }

  async function entry(text, { crc, size, compressed, method, when }, body) {
    const name = Buffer.from(text, 'utf8')
    const { time, date } = dosTime(when)
    const at = offset
    const big = wide64(size) || wide64(compressed)
    // Local header: zip64 sizes only when they need it (both then, as the format asks).
    const localExtra = big ? Buffer.alloc(20) : Buffer.alloc(0)
    if (big) {
      localExtra.writeUInt16LE(0x0001, 0)
      localExtra.writeUInt16LE(16, 2)
      localExtra.writeBigUInt64LE(BigInt(size), 4)
      localExtra.writeBigUInt64LE(BigInt(compressed), 12)
    }
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL, 0)
    local.writeUInt16LE(big ? 45 : 20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(big ? MAX32 : compressed, 18)
    local.writeUInt32LE(big ? MAX32 : size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(localExtra.length, 28)
    await put(Buffer.concat([local, name, localExtra]))
    await body()
    // The central entry: zip64 fields for whichever of size, compressed size and offset do not fit.
    const wide = [wide64(size) ? size : null, wide64(compressed) ? compressed : null, wide64(at) ? at : null].filter(v => v !== null)
    const extra = Buffer.alloc(wide.length ? 4 + 8 * wide.length : 0)
    if (wide.length) {
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(8 * wide.length, 2)
      wide.forEach((value, i) => extra.writeBigUInt64LE(BigInt(value), 4 + 8 * i))
    }
    const head = Buffer.alloc(46)
    head.writeUInt32LE(CENTRAL, 0)
    head.writeUInt16LE(45, 4) // made by: MS-DOS, zip 4.5
    head.writeUInt16LE(wide.length ? 45 : 20, 6)
    head.writeUInt16LE(0x0800, 8)
    head.writeUInt16LE(method, 10)
    head.writeUInt16LE(time, 12)
    head.writeUInt16LE(date, 14)
    head.writeUInt32LE(crc, 16)
    head.writeUInt32LE(wide64(compressed) ? MAX32 : compressed, 20)
    head.writeUInt32LE(wide64(size) ? MAX32 : size, 24)
    head.writeUInt16LE(name.length, 28)
    head.writeUInt16LE(extra.length, 30)
    head.writeUInt32LE(wide64(at) ? MAX32 : at, 42)
    central.push(head, name, extra)
    count++
  }

  async function addBuffer(name, data, when = new Date()) {
    const crc = crcOf(data) >>> 0
    const deflated = TEXT.test(name) && data.length > 256 && data.length <= DEFLATE_MAX ? zlib.deflateRawSync(data, { level: 6 }) : null
    const body = deflated && deflated.length < data.length ? deflated : data
    await entry(name, { crc, size: data.length, compressed: body.length, method: body === data ? 0 : 8, when }, () => put(body))
  }

  /** A file from disk: read whole, or, past STREAM_AT, streamed (stored). → its size, or -1 when it went missing. */
  async function addFile(name, file) {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) return -1
    if (info.size <= STREAM_AT) {
      const data = await readFile(file).catch(() => null)
      if (!data) return -1
      await addBuffer(name, data, info.mtime)
      return data.length
    }
    const crc = await crcOfFile(file)
    let sent = 0
    await entry(name, { crc, size: info.size, compressed: info.size, method: 0, when: info.mtime }, async () => {
      for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024, end: info.size - 1 })) {
        await put(chunk)
        sent += chunk.length
      }
      // Changed while it was read: the zip would be broken, so the export stops here rather than lie.
      if (sent !== info.size) throw new Error(`${name} changed while it was exported`)
    })
    return info.size
  }

  async function finish() {
    const directory = Buffer.concat(central)
    const start = offset
    await put(directory)
    const needs64 = always64 || count >= MAX16 || start >= MAX32 || directory.length >= MAX32
    if (needs64) {
      const at = offset
      const record = Buffer.alloc(56)
      record.writeUInt32LE(END64, 0)
      record.writeBigUInt64LE(44n, 4)
      record.writeUInt16LE(45, 12)
      record.writeUInt16LE(45, 14)
      record.writeBigUInt64LE(BigInt(count), 24)
      record.writeBigUInt64LE(BigInt(count), 32)
      record.writeBigUInt64LE(BigInt(directory.length), 40)
      record.writeBigUInt64LE(BigInt(start), 48)
      const locator = Buffer.alloc(20)
      locator.writeUInt32LE(LOCATOR64, 0)
      locator.writeBigUInt64LE(BigInt(at), 8)
      locator.writeUInt32LE(1, 16)
      await put(Buffer.concat([record, locator]))
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END, 0)
    end.writeUInt16LE(needs64 ? MAX16 : count, 8)
    end.writeUInt16LE(needs64 ? MAX16 : count, 10)
    end.writeUInt32LE(needs64 ? MAX32 : directory.length, 12)
    end.writeUInt32LE(needs64 ? MAX32 : start, 16)
    await put(end)
    return { bytes: offset, entries: count }
  }

  return { addBuffer, addFile, finish, get offset() { return offset } }
}

const broken = message => Object.assign(new Error(message), { status: 400, code: 'BAD_ZIP' })

/**
 * A zip file opened for reading: { entries: [{ name, method, crc, size, compressed, offset, encrypted }], read(entry,
 * most) → Buffer, copyTo(entry, dest file), close() }. Zip64 read where the file has it. Throws (status 400) on one it
 * cannot read.
 */
export async function openZipFile(file, { maxDirectory = 256 * 1024 * 1024 } = {}) {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const readAt = async (position, length) => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      return buffer.subarray(0, bytesRead)
    }
    const tailLength = Math.min(size, 22 + MAX16 + 20)
    const tail = await readAt(size - tailLength, tailLength)
    let end = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END) {
        end = i
        break
      }
    }
    if (end < 0) throw broken('not a zip')
    let count = tail.readUInt16LE(end + 10)
    let dirLength = tail.readUInt32LE(end + 12)
    let dirStart = tail.readUInt32LE(end + 16)
    if (end >= 20 && tail.readUInt32LE(end - 20) === LOCATOR64) {
      const at = Number(tail.readBigUInt64LE(end - 20 + 8))
      const record = await readAt(at, 56)
      if (record.length < 56 || record.readUInt32LE(0) !== END64) throw broken('broken zip64 end')
      count = Number(record.readBigUInt64LE(32))
      dirLength = Number(record.readBigUInt64LE(40))
      dirStart = Number(record.readBigUInt64LE(48))
    }
    if (dirLength > maxDirectory || dirStart + dirLength > size) throw broken('broken zip directory')
    const dir = await readAt(dirStart, dirLength)
    const entries = []
    let at = 0
    for (let i = 0; i < count; i++) {
      if (at + 46 > dir.length || dir.readUInt32LE(at) !== CENTRAL) throw broken('broken zip directory')
      const flags = dir.readUInt16LE(at + 8)
      const nameLength = dir.readUInt16LE(at + 28)
      const extraLength = dir.readUInt16LE(at + 30)
      const commentLength = dir.readUInt16LE(at + 32)
      const entry = {
        name: dir.toString(flags & 0x0800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength).replace(/\\/g, '/'),
        method: dir.readUInt16LE(at + 10),
        encrypted: Boolean(flags & 1),
        crc: dir.readUInt32LE(at + 16) >>> 0,
        compressed: dir.readUInt32LE(at + 20),
        size: dir.readUInt32LE(at + 24),
        offset: dir.readUInt32LE(at + 42),
      }
      // Zip64: the fields set to all ones are in the extra field, in this order.
      let x = at + 46 + nameLength
      const extraEnd = x + extraLength
      while (x + 4 <= extraEnd) {
        const id = dir.readUInt16LE(x)
        const length = dir.readUInt16LE(x + 2)
        if (id === 0x0001) {
          let p = x + 4
          for (const key of ['size', 'compressed', 'offset']) {
            if (entry[key] === MAX32 && p + 8 <= x + 4 + length) {
              entry[key] = Number(dir.readBigUInt64LE(p))
              p += 8
            }
          }
        }
        x += 4 + length
      }
      if (!entry.name.endsWith('/')) entries.push(entry)
      at += 46 + nameLength + extraLength + commentLength
    }

    const dataStart = async entry => {
      const head = await readAt(entry.offset, 30)
      if (head.length < 30 || head.readUInt32LE(0) !== LOCAL) throw broken(`${entry.name}: broken header`)
      const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
      if (start + entry.compressed > size) throw broken(`${entry.name}: cut off`)
      return start
    }
    const check = entry => {
      if (entry.encrypted) throw broken(`${entry.name}: encrypted`)
      if (entry.method !== 0 && entry.method !== 8) throw broken(`${entry.name}: unsupported method ${entry.method}`)
    }

    return {
      entries,
      size,
      /** An entry's bytes, checked; `most` bytes at most (an entry saying more is refused before it is read). */
      async read(entry, most = 256 * 1024 * 1024) {
        check(entry)
        if (entry.size > most) throw broken(`${entry.name}: too large`)
        const body = await readAt(await dataStart(entry), entry.compressed)
        let data = body
        if (entry.method === 8) {
          try {
            data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(entry.size, 1) })
          } catch {
            throw broken(`${entry.name}: cannot inflate`)
          }
        }
        if (data.length !== entry.size || (crcOf(data) >>> 0) !== entry.crc) throw broken(`${entry.name}: checksum`)
        return data
      },
      /** An entry streamed into the file `dest`, checked on the way: a wrong size or CRC throws at the end. */
      async copyTo(entry, dest) {
        check(entry)
        const start = await dataStart(entry)
        const writable = createWriteStream(dest)
        let crc = 0
        let length = 0
        const counter = new Transform({
          transform(chunk, _, done) {
            length += chunk.length
            if (length > entry.size) return done(broken(`${entry.name}: larger than it says`))
            crc = crcUpdate(crc, chunk)
            done(null, chunk)
          },
        })
        const source = entry.compressed
          ? createReadStream(null, { fd: handle.fd, autoClose: false, start, end: start + entry.compressed - 1, highWaterMark: 1024 * 1024 })
          : null
        const steps = source ? [source, ...(entry.method === 8 ? [zlib.createInflateRaw()] : []), counter, writable] : null
        if (steps) await pipeline(...steps)
        else await new Promise((resolve, reject) => writable.on('error', reject).end(resolve))
        if (length !== entry.size || (crc >>> 0) !== entry.crc) throw broken(`${entry.name}: checksum`)
      },
      close: () => handle.close(),
    }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}
