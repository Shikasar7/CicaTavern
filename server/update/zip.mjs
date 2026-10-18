// Zip files for the Windows package: written by scripts/stage-release.mjs,
// read back by the in-app updater (server/update/install.mjs).
// Written here rather than by a tool: Windows' tar.exe stores names in the
// console code page and .NET Framework's writer uses backslashes, which garble
// the Chinese launcher names or the folders elsewhere. Names are UTF-8 with the
// flag set (bit 11). The reader takes what these zips use (stored or deflated,
// no zip64), which is also what most zip tools write for a package this size.
import { readdirSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
// zlib.crc32 is Node 20.15+; read at call time so the phone's Node 18 can still load this module.
import zlib from 'node:zlib'

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
// Far more than a package unpacks to (about 100 MB): a cap against zip bombs.
const MAX_TOTAL = 1024 * 1024 * 1024

/** A zip of the folder, with the folder's name as the top directory. */
export async function zipFolder(dir) {
  const top = path.basename(dir)
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort()
  const locals = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(`${top}/${path.relative(dir, file).split(path.sep).join('/')}`, 'utf8')
    const data = await readFile(file)
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    const stored = deflated.length >= data.length
    const body = stored ? data : deflated
    const crc = zlib.crc32(data)
    const { time, date } = dosTime((await stat(file)).mtime)
    const fields = (header, extra) => {
      header.writeUInt16LE(0x0800, extra + 2) // UTF-8 names
      header.writeUInt16LE(stored ? 0 : 8, extra + 4)
      header.writeUInt16LE(time, extra + 6)
      header.writeUInt16LE(date, extra + 8)
      header.writeUInt32LE(crc, extra + 10)
      header.writeUInt32LE(body.length, extra + 14)
      header.writeUInt32LE(data.length, extra + 18)
      header.writeUInt16LE(name.length, extra + 22)
    }
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL, 0)
    local.writeUInt16LE(20, 4)
    fields(local, 4)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(CENTRAL, 0)
    entry.writeUInt16LE(20, 4) // made by: MS-DOS, zip 2.0
    entry.writeUInt16LE(20, 6)
    fields(entry, 6)
    entry.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    central.push(entry, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function dosTime(when) {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((Math.max(when.getFullYear(), 1980) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  }
}

function broken(message) {
  return Object.assign(new Error(`更新包损坏：${message}`), { code: 'BAD_ZIP' })
}

/** The entries of a zip in memory: [{ name, method, crc, compressed, size, offset }]. */
export function listZip(buffer) {
  let end = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === END) {
      end = i
      break
    }
  }
  if (end < 0) throw broken('不是 zip 文件')
  const count = buffer.readUInt16LE(end + 10)
  let at = buffer.readUInt32LE(end + 16)
  if (count === 0xffff || at === 0xffffffff) throw broken('不支持 zip64')
  const entries = []
  for (let i = 0; i < count; i++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) throw broken('目录不完整')
    const flags = buffer.readUInt16LE(at + 8)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const entry = {
      name: buffer.toString(flags & 0x0800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength),
      method: buffer.readUInt16LE(at + 10),
      encrypted: Boolean(flags & 1),
      crc: buffer.readUInt32LE(at + 16),
      compressed: buffer.readUInt32LE(at + 20),
      size: buffer.readUInt32LE(at + 24),
      offset: buffer.readUInt32LE(at + 42),
    }
    if (entry.compressed === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) throw broken('不支持 zip64')
    entries.push(entry)
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * A zip entry's name as a path under the folder, or throws: no absolute paths,
 * drive letters or `..` (a hostile zip must not write outside the folder).
 */
export function safeEntryPath(name) {
  const parts = name.replace(/\\/g, '/').split('/')
  if (!name || name.startsWith('/') || name.startsWith('\\') || /^[a-z]:/i.test(name) || parts.some(p => p === '..' || p.includes(':') || /[\0<>|"?*]/.test(p))) {
    throw broken(`不安全的路径 ${JSON.stringify(name.slice(0, 120))}`)
  }
  return parts.filter(p => p && p !== '.')
}

function entryData(buffer, entry) {
  const at = entry.offset
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL) throw broken(`${entry.name} 的头不对`)
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28)
  const body = buffer.subarray(start, start + entry.compressed)
  if (body.length !== entry.compressed) throw broken(`${entry.name} 不完整`)
  let data
  if (entry.method === 0) data = body
  else if (entry.method === 8) {
    try {
      data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(entry.size, 1) })
    } catch {
      throw broken(`${entry.name} 解不开`)
    }
  } else throw broken(`${entry.name} 用了不支持的压缩方式 ${entry.method}`)
  if (data.length !== entry.size || zlib.crc32(data) >>> 0 !== entry.crc >>> 0) throw broken(`${entry.name} 校验不对`)
  return data
}

/**
 * Unpack a zip whose files all sit in one top folder into `dest` (that
 * folder's contents, not the folder itself). Returns the top folder's name
 * and the number of files.
 * @param top - when given, the top folder must have this name.
 */
export async function extractZip(buffer, dest, { top } = {}) {
  const entries = listZip(buffer)
  const files = []
  const tops = new Set()
  let total = 0
  for (const entry of entries) {
    if (entry.encrypted) throw broken('有加密的文件')
    const parts = safeEntryPath(entry.name)
    if (!parts.length) continue
    tops.add(parts[0])
    if (entry.name.endsWith('/')) continue
    if (parts.length < 2) throw broken(`${entry.name} 不在顶层文件夹里`)
    total += entry.size
    if (total > MAX_TOTAL) throw broken('解压后太大')
    files.push({ entry, rel: parts.slice(1) })
  }
  if (tops.size !== 1) throw broken('顶层应该只有一个文件夹')
  const [name] = tops
  if (top && name !== top) throw broken(`顶层文件夹是 ${name}，应该是 ${top}`)
  for (const { entry, rel } of files) {
    const target = path.join(dest, ...rel)
    // safeEntryPath already refused `..`; this also holds against odd separators.
    if (path.relative(dest, target).startsWith('..')) throw broken(`不安全的路径 ${entry.name}`)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, entryData(buffer, entry))
  }
  return { top: name, files: files.length }
}
