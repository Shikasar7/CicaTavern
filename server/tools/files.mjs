// 直连对话's file tools (plans/24 四): list, search, read, write, edit, move, delete, in the folders the player added to the
// chat. Each tool is prepared first: what it would do and whether the player must be asked, then run. What a file was is
// kept before it is changed (history.mjs). Text for the model stays Chinese.
import { chmod, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { putFile } from './history.mjs'
import { isSensitive, PathError, pathParts, runsThings } from './paths.mjs'
import { decodeText, diffLines, encodeText, hashOf, lineEnd, notInGbk, replaceOnce, toLf, withEnds } from './text.mjs'

export const MAX_FILE = 2 * 1024 * 1024
const MAX_DELETE = 50 * 1024 * 1024
export const READ_LINES = 400
export const READ_CHARS = 20_000
const LIST_ENTRIES = 200
const MATCHES = 50
const MATCH_CHARS = 200
const WALK_ENTRIES = 20_000
const WALK_FILES = 4000
const WALK_MS = 10_000
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', '$recycle.bin', 'system volume information'])
// Formats with no text to read here, by what the model is told.
const NOT_TEXT = { '.pdf': 'PDF', '.doc': 'Word 文档', '.docx': 'Word 文档', '.xls': '表格', '.xlsx': '表格', '.ppt': '演示文稿', '.pptx': '演示文稿', '.epub': '电子书', '.png': '图片', '.jpg': '图片', '.jpeg': '图片', '.webp': '图片', '.gif': '图片', '.mp3': '音频', '.mp4': '视频', '.zip': '压缩包' }
// What long content stands as in a later turn's history (engine.mjs): never to be written into a file.
export const LEFT_OUT = '（内容已写进文件，这里不重复）'

export const FILE_TOOLS = ['list_files', 'search_files', 'read_file', 'write_file', 'edit_file', 'move_file', 'delete_file']
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'move_file', 'delete_file'])

/** A tool that cannot be done: said to the model as it is. */
export class ToolError extends Error {}

const fold = text => String(text).normalize('NFC').toLowerCase()
const oneNewline = text => text.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '')

/** The <old>/<new> pairs of an edit's body. */
export function editsOf(body) {
  const edits = []
  const pair = /<old>([\s\S]*?)<\/old>\s*<new>([\s\S]*?)<\/new>/g
  let rest = String(body ?? '')
  for (const [whole, from, to] of rest.matchAll(pair)) {
    edits.push({ from: toLf(from), to: toLf(to) })
    rest = rest.replace(whole, '')
  }
  if (!edits.length || /<\/?(?:old|new)>/.test(rest)) throw new ToolError('edit_file 要写成一组或几组 <old>原文</old><new>改成</new>')
  return edits
}

/**
 * @param history - createFileHistory()
 * ctx of a call: { folders: [{ id, label, path, mode: 'read' | 'write', free }], seen: Map (real → what the model has read
 * of it), run, chatId, masked(text): whether 屏蔽词 change what the model is sent of it }
 */
export function createFileTools({ guard, history }) {
  /** Which folder a path means and where it is on disk. */
  async function resolve(ctx, value, { write = false } = {}) {
    if (!ctx.folders.length) throw new ToolError('这段对话没有能用的文件夹')
    const parts = pathParts(value)
    const named = ctx.folders.find(folder => fold(folder.label) === fold(parts[0]))
    const folder = named ?? (ctx.folders.length === 1 ? ctx.folders[0] : null)
    if (!folder) throw new ToolError(`没有「${parts[0]}」这个文件夹，能用的是：${ctx.folders.map(item => item.label).join('、')}`)
    const inner = named ? parts.slice(1) : parts
    const shown = [folder.label, ...inner].join('/')
    if (write && folder.mode !== 'write') throw new ToolError(`「${folder.label}」是只读的，不能改。用户可以在「工具」里改成「可以改」`)
    const place = await guard.locate(folder, inner)
    if (write && guard.inGit(place.real, place.root)) throw new ToolError('.git 里面的文件只能读，不能改')
    return { folder, shown, ...place }
  }

  const bytesOf = async place => {
    if (!place.exists) throw new ToolError(`没有「${place.shown}」这个文件`)
    if (place.kind === 'dir') throw new ToolError(`「${place.shown}」是文件夹`)
    if (place.size > MAX_FILE) throw new ToolError(`「${place.shown}」太大了（${Math.round(place.size / 1024)} KB），最多 2 MB`)
    return readFile(place.real)
  }
  const textOf = async place => {
    const bytes = await bytesOf(place)
    const decoded = decodeText(bytes)
    if (!decoded) throw new ToolError(`「${place.shown}」读不了：${NOT_TEXT[path.extname(place.real).toLowerCase()] ?? '不是文字文件'}，这里只能读文字文件（UTF-8 或 GBK）`)
    return { ...decoded, bytes, hash: hashOf(bytes) }
  }

  // ─── Reading ───────────────────────────────────────────────────────────

  async function listed(place) {
    const entries = await readdir(place.real, { withFileTypes: true })
    const out = []
    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh'))) {
      const real = path.join(place.real, entry.name)
      if (guard.blocked(real) || /^\.cica-[0-9a-f]+\.tmp$/.test(entry.name)) continue
      if (entry.isSymbolicLink()) out.push(`${entry.name}（链接）`)
      else if (entry.isDirectory()) out.push(`${entry.name}/`)
      else if (entry.isFile()) {
        const info = await stat(real).catch(() => null)
        out.push(`${entry.name}（${size(info?.size ?? 0)}）`)
      }
    }
    return out
  }
  const size = bytes => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

  /** Every file under `place`, no links followed; { real, rel } in order, until the walk has gone far enough. */
  async function* walk(place, signal) {
    const until = Date.now() + WALK_MS
    let visited = 0
    const queue = [{ real: place.real, rel: '' }]
    while (queue.length) {
      const dir = queue.shift()
      for (const entry of (await readdir(dir.real, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
        if (signal?.aborted) return
        if (++visited > WALK_ENTRIES || Date.now() > until) {
          yield { stopped: true }
          return
        }
        const real = path.join(dir.real, entry.name)
        const rel = dir.rel ? `${dir.rel}/${entry.name}` : entry.name
        if (entry.isSymbolicLink() || guard.blocked(real)) continue
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name.toLowerCase())) queue.push({ real, rel })
          yield { real, rel: `${rel}/`, dir: true }
        } else if (entry.isFile()) yield { real, rel }
      }
    }
  }

  async function list(ctx, { path: where = '', find = '' }) {
    if (!String(where).trim() && (!String(find).trim() || ctx.folders.length > 1)) {
      return ['能用的文件夹：', ...ctx.folders.map(folder => `${folder.label}/（${folder.mode === 'write' ? '可以改' : '只读'}）`)].join('\n')
    }
    const place = await resolve(ctx, String(where).trim() || ctx.folders[0].label)
    if (!place.exists) throw new ToolError(`没有「${place.shown}」这个文件夹`)
    if (place.kind !== 'dir') throw new ToolError(`「${place.shown}」是文件，用 read_file 读`)
    const word = fold(String(find).trim())
    if (!word) {
      const names = await listed(place)
      if (!names.length) return `「${place.shown}」是空的`
      return [`「${place.shown}」里有：`, ...names.slice(0, LIST_ENTRIES), ...(names.length > LIST_ENTRIES ? [`……还有 ${names.length - LIST_ENTRIES} 项，用 find 按名字找`] : [])].join('\n')
    }
    const found = []
    let stopped = false
    for await (const item of walk(place, ctx.signal)) {
      if (item.stopped) stopped = true
      else if (fold(item.rel.split('/').filter(Boolean).at(-1)).includes(word)) found.push(`${place.shown}/${item.rel}`)
      if (found.length >= LIST_ENTRIES) break
    }
    if (!found.length) return `没有找到名字里有「${find}」的${stopped ? '（文件太多，没有找完）' : ''}`
    return [...found, ...(found.length >= LIST_ENTRIES || stopped ? ['……（没有列完，用更具体的词或文件夹）'] : [])].join('\n')
  }

  async function search(ctx, { query = '', path: where = '' }) {
    // Words as they are, never a pattern the model writes (no runaway search).
    const words = String(query).split('|').map(word => fold(word.trim())).filter(Boolean)
    if (!words.length) throw new ToolError('要搜的内容是空的')
    const places = String(where).trim() ? [await resolve(ctx, where)] : await Promise.all(ctx.folders.map(folder => resolve(ctx, folder.label)))
    const out = []
    let files = 0
    let stopped = false
    const look = async (real, shown) => {
      if (isSensitive(path.basename(real))) return
      const info = await stat(real).catch(() => null)
      if (!info || info.size > MAX_FILE) return
      if (++files > WALK_FILES) {
        stopped = true
        return
      }
      const text = decodeText(await readFile(real).catch(() => Buffer.from([0])))?.text
      if (!text) return
      const lines = toLf(text).split('\n')
      for (let i = 0; i < lines.length && out.length < MATCHES; i++) {
        const line = fold(lines[i])
        const at = words.map(word => line.indexOf(word)).filter(index => index >= 0)
        if (!at.length) continue
        const from = Math.max(0, Math.min(...at) - 60)
        out.push(`${shown}:${i + 1}: ${from ? '…' : ''}${lines[i].slice(from, from + MATCH_CHARS).trim()}`)
      }
    }
    for (const place of places) {
      if (!place.exists) throw new ToolError(`没有「${place.shown}」`)
      if (place.kind === 'file') await look(place.real, place.shown)
      else {
        for await (const item of walk(place, ctx.signal)) {
          if (item.stopped) stopped = true
          else if (!item.dir) await look(item.real, `${place.shown}/${item.rel}`)
          if (out.length >= MATCHES || stopped) break
        }
      }
    }
    if (!out.length) return `没有搜到${stopped ? '（文件太多，没有搜完，换一个小一点的文件夹）' : ''}`
    return [...out, ...(out.length >= MATCHES ? [`……（只列前 ${MATCHES} 条）`] : stopped ? ['……（文件太多，没有搜完）'] : [])].join('\n')
  }

  async function read(ctx, place, { from, to }) {
    const { text, hash } = await textOf(place)
    const lines = toLf(text).split('\n')
    // A last line end begins no line of its own.
    if (lines.length > 1 && lines.at(-1) === '') lines.pop()
    const total = lines.length
    const first = Math.max(1, Math.trunc(Number(from)) || 1)
    if (first > total) throw new ToolError(`「${place.shown}」一共只有 ${total} 行`)
    const last = Math.min(total, Math.trunc(Number(to)) || first + READ_LINES - 1, first + READ_LINES - 1)
    let chars = 0
    let end = first - 1
    let cut = false
    const shown = []
    for (let i = first; i <= last; i++) {
      const line = lines[i - 1]
      if (chars + line.length > READ_CHARS) {
        if (shown.length) break
        // One line longer than a whole read: its beginning, and no more of it can be had.
        shown.push(line.slice(0, READ_CHARS))
        cut = true
        end = i
        break
      }
      chars += line.length + 1
      shown.push(line)
      end = i
    }
    // What of the file the model has read, for write_file: a file rewritten whole must have been read whole.
    const known = ctx.seen.get(place.real)
    const ranges = known?.hash === hash ? known.ranges : []
    if (!cut) ranges.push([first, end])
    ctx.seen.set(place.real, { hash, ranges, full: covers(ranges, total), masked: ctx.masked?.(text) === true })
    return [
      `「${place.shown}」第 ${first}–${end} 行，共 ${total} 行${ctx.seen.get(place.real).masked ? '（里面有用户设的屏蔽词，你看到的和原文不完全一样：不能整份重写，只能用 edit_file 改没有屏蔽词的段落）' : ''}：`,
      shown.join('\n'),
      ...(cut ? ['……（这一行太长，只能看到开头）'] : end < total ? [`……（后面还有 ${total - end} 行，从 ${end + 1} 行接着读）`] : []),
    ].join('\n')
  }
  function covers(ranges, total) {
    let next = 1
    for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
      if (from > next) return false
      next = Math.max(next, to + 1)
    }
    return next > total
  }

  // ─── Writing ───────────────────────────────────────────────────────────

  /** The bytes of `text` (with \n) for a file like `like`, or a new one. */
  function bytesFor(text, like, shown) {
    const bytes = encodeText(text, like ?? {})
    if (!bytes) throw new ToolError(`「${shown}」是 GBK 编码的，写不了这些字：${notInGbk(text).join(' ')}。换个写法，或者写成一个新文件`)
    if (bytes.length > MAX_FILE) throw new ToolError('内容太长了，一个文件最多 2 MB')
    return bytes
  }

  /** Changed by something else since the model read it, or never read: not written. */
  function mustKnow(ctx, place, hash, { whole = false } = {}) {
    const known = ctx.seen.get(place.real)
    if (!known) throw new ToolError(`先用 read_file 读「${place.shown}」，再改`)
    if (known.hash !== hash) throw new ToolError(`「${place.shown}」在你读过之后变了，先重新读一遍再改`)
    if (whole && known.masked) throw new ToolError(`「${place.shown}」里有屏蔽词，你看到的不是原文，不能整份重写，用 edit_file`)
    if (whole && !known.full) throw new ToolError(`「${place.shown}」你还没有读完，不能整份重写。读完，或者用 edit_file 只改要改的地方`)
  }

  /**
   * `bytes` into `place`, what was there kept first. What the player agreed to is this content on that file: if either
   * changed while they looked, nothing is written.
   */
  async function put(ctx, value, agreed, bytes) {
    const place = await resolve(ctx, value, { write: true })
    if (place.real !== agreed.real) throw new ToolError(`「${place.shown}」指的地方变了，没有写`)
    const before = place.exists ? await readFile(place.real) : null
    if ((before ? hashOf(before) : null) !== agreed.hash) throw new ToolError(`「${place.shown}」在等用户确认的时候变了，没有写。重新读一遍再改`)
    const made = []
    const folder = path.dirname(place.real)
    const entry = await history.begin(ctx.run, ctx.chatId, { op: 'write', path: place.shown, real: place.real, before, after: hashOf(bytes) })
    try {
      // The folders it needs, remembered: taken back with it.
      for (let at = folder; !(await stat(at).catch(() => null)); at = path.dirname(at)) made.unshift(at)
      if (made.length) await mkdir(folder, { recursive: true })
      // Looked at again with the folder there: nothing has put a link in its way.
      const again = await resolve(ctx, value, { write: true })
      if (again.real !== place.real) throw new ToolError(`「${place.shown}」指的地方变了，没有写`)
      const mode = before ? (await stat(place.real)).mode : undefined
      await putFile(place.real, bytes)
      if (mode !== undefined && process.platform !== 'win32') await chmod(place.real, mode).catch(() => {})
      await history.done(ctx.run, entry, { made })
    } catch (error) {
      await history.done(ctx.run, entry, { failed: true }).catch(() => {})
      throw error
    }
    return place
  }

  const asks = (place, free) => (runsThings(path.basename(place.real)) || isSensitive(path.basename(place.real)) ? 'always' : free ? 'no' : 'write')

  async function prepareWrite(ctx, args, body, whole) {
    const place = await resolve(ctx, args.path, { write: true })
    if (place.kind === 'dir') throw new ToolError(`「${place.shown}」是文件夹`)
    if (place.real === place.root) throw new ToolError('要写出文件名')
    const content = toLf(whole ?? oneNewline(body))
    if (content.includes(LEFT_OUT)) throw new ToolError('content 里是历史记录的占位文字，不是真正的内容。把要写的内容完整写出来')
    let old = null
    if (place.exists) {
      old = await textOf(place)
      mustKnow(ctx, place, old.hash, { whole: true })
    }
    // A file's last line end is kept: a tool call's own new lines are not part of it.
    const ended = old ? /\n$/.test(old.text) : true
    const text = withEnds(content === '' ? '' : `${content}${ended && !content.endsWith('\n') ? '\n' : ''}`, old ? lineEnd(old.text) : '\n')
    const bytes = bytesFor(text, old, place.shown)
    if (old && bytes.equals(old.bytes)) return { result: `「${place.shown}」和要写的内容一样，没有改` }
    const diff = diffLines(old?.text ?? '', text)
    return change(ctx, args.path, place, { op: old ? 'write' : 'create', old, bytes, diff })
  }

  async function prepareEdit(ctx, args, body, edits) {
    const place = await resolve(ctx, args.path, { write: true })
    const old = await textOf(place)
    mustKnow(ctx, place, old.hash)
    let text = old.text
    const list = edits ?? editsOf(body)
    if (!list.length) throw new ToolError('没有写要改什么')
    for (const { from, to } of list) {
      if (to.includes(LEFT_OUT)) throw new ToolError('改成的内容里是历史记录的占位文字，不是真正的内容。把要写的完整写出来')
      // As written, else without the new line after <old> and the one before </old>.
      let made = replaceOnce(text, from, to)
      if (!made.text && !made.found) made = replaceOnce(text, oneNewline(from), oneNewline(to))
      if (made.text === undefined) {
        const said = oneNewline(from).slice(0, 60)
        throw new ToolError(made.found ? `「${said}」在文件里有 ${made.found} 处，多写几行让它只有一处` : `文件里没有「${said}」，要和原文一字不差（含空格和标点）。没有改任何地方`)
      }
      text = made.text
    }
    const bytes = bytesFor(text, old, place.shown)
    if (bytes.equals(old.bytes)) return { result: `「${place.shown}」改完和原来一样，没有改` }
    return change(ctx, args.path, place, { op: 'edit', old, bytes, diff: diffLines(old.text, text) })
  }

  function change(ctx, value, place, { op, old, bytes, diff }) {
    const known = ctx.seen.get(place.real)
    return {
      ask: asks(place, place.folder.free),
      free: place.folder.id,
      view: { op, path: place.shown, diff, runs: runsThings(path.basename(place.real)) },
      summary: { op, path: place.shown, added: diff.added, removed: diff.removed },
      async run() {
        await put(ctx, value, { real: place.real, hash: old?.hash ?? null }, bytes)
        ctx.seen.set(place.real, { hash: hashOf(bytes), ranges: known?.ranges ?? [], full: op === 'edit' ? known?.full === true : true, masked: op === 'edit' && known?.masked === true })
        return `已${op === 'create' ? '新建' : '改好'}「${place.shown}」（+${diff.added} −${diff.removed} 行）`
      },
    }
  }

  async function prepareMove(ctx, args) {
    const place = await resolve(ctx, args.path, { write: true })
    const target = await resolve(ctx, args.to, { write: true })
    if (!place.exists) throw new ToolError(`没有「${place.shown}」这个文件`)
    if (place.kind !== 'file') throw new ToolError('只能移动文件，不能移动文件夹')
    if (target.exists) throw new ToolError(target.kind === 'dir' ? `「${target.shown}」是文件夹，to 要写到文件名` : `「${target.shown}」已经有了，没有移动`)
    if (place.size > MAX_DELETE) throw new ToolError(`「${place.shown}」太大了，最多 50 MB`)
    const hash = hashOf(await readFile(place.real))
    const ask = [asks(place, place.folder.free), asks(target, target.folder.free)]
    return {
      ask: ask.includes('always') ? 'always' : ask.includes('write') ? 'write' : 'no',
      free: place.folder.id === target.folder.id ? place.folder.id : '',
      view: { op: 'move', path: place.shown, to: target.shown, runs: runsThings(path.basename(target.real)) },
      summary: { op: 'move', path: place.shown, to: target.shown },
      async run() {
        const [now, then] = [await resolve(ctx, args.path, { write: true }), await resolve(ctx, args.to, { write: true })]
        if (now.real !== place.real || then.real !== target.real || then.exists) throw new ToolError('文件在等用户确认的时候变了，没有移动')
        if (!now.exists || hashOf(await readFile(now.real)) !== hash) throw new ToolError(`「${place.shown}」在等用户确认的时候变了，没有移动`)
        const made = []
        for (let at = path.dirname(then.real); !(await stat(at).catch(() => null)); at = path.dirname(at)) made.unshift(at)
        const entry = await history.begin(ctx.run, ctx.chatId, { op: 'move', path: place.shown, real: now.real, to: target.shown, toReal: then.real, after: hash })
        try {
          if (made.length) await mkdir(path.dirname(then.real), { recursive: true })
          const again = await resolve(ctx, args.to, { write: true })
          if (again.real !== then.real || again.exists) throw new ToolError('文件在等用户确认的时候变了，没有移动')
          await rename(now.real, then.real)
          await history.done(ctx.run, entry, { made })
        } catch (error) {
          await history.done(ctx.run, entry, { failed: true }).catch(() => {})
          throw error.code === 'EXDEV' ? new ToolError('不能移到另一个盘上') : error
        }
        const known = ctx.seen.get(now.real)
        ctx.seen.delete(now.real)
        if (known) ctx.seen.set(then.real, known)
        return `已移到「${target.shown}」`
      },
    }
  }

  async function prepareDelete(ctx, args) {
    const place = await resolve(ctx, args.path, { write: true })
    if (!place.exists) throw new ToolError(`没有「${place.shown}」这个文件`)
    if (place.kind !== 'file') throw new ToolError('只能删除文件，不能删除文件夹')
    if (place.size > MAX_DELETE) throw new ToolError(`「${place.shown}」太大了，最多 50 MB`)
    const before = await readFile(place.real)
    const hash = hashOf(before)
    return {
      ask: 'always',
      free: '',
      view: { op: 'delete', path: place.shown, bytes: place.size },
      summary: { op: 'delete', path: place.shown },
      async run() {
        const now = await resolve(ctx, args.path, { write: true })
        const bytes = now.exists ? await readFile(now.real) : null
        if (now.real !== place.real || !bytes || hashOf(bytes) !== hash) throw new ToolError(`「${place.shown}」在等用户确认的时候变了，没有删`)
        const entry = await history.begin(ctx.run, ctx.chatId, { op: 'delete', path: place.shown, real: now.real, before: bytes, after: null })
        try {
          await unlink(now.real)
          await history.done(ctx.run, entry)
        } catch (error) {
          await history.done(ctx.run, entry, { failed: true }).catch(() => {})
          throw error
        }
        ctx.seen.delete(now.real)
        return `已删除「${place.shown}」（旧版留在应用里，用户可以撤销）`
      },
    }
  }

  // What the disk said, in words: a file another program has open, no right to it.
  const diskWords = { EACCES: '没有权限', EPERM: '没有权限，或者文件正被别的程序占用', EBUSY: '文件正被别的程序占用', ENOSPC: '磁盘满了', EROFS: '这个位置只能读', ENOENT: '文件或文件夹不在了', ENAMETOOLONG: '文件名太长', EMFILE: '打开的文件太多' }
  const said = error => {
    if (error instanceof ToolError || error instanceof PathError) return error
    if (diskWords[error.code]) return new ToolError(`没有做成：${diskWords[error.code]}`)
    throw error
  }

  /**
   * A call made ready: { result } (done, nothing to ask), or { ask: 'no' | 'write' | 'always', view, summary, free, run() }.
   * ToolError for what cannot be done.
   */
  async function prepare(call, ctx) {
    const { name, args, body, content, edits } = call
    try {
      if (name === 'list_files') return { result: await list(ctx, args) }
      if (name === 'search_files') return { result: await search(ctx, args) }
      if (name === 'read_file') {
        const place = await resolve(ctx, args.path)
        if (!isSensitive(path.basename(place.real)) || !place.exists || place.kind === 'dir') return { result: await read(ctx, place, args) }
        return { ask: 'always', free: '', view: { op: 'read', path: place.shown }, summary: { op: 'read', path: place.shown }, run: guarded(async () => read(ctx, await resolve(ctx, args.path), args)) }
      }
      const made = name === 'write_file' ? await prepareWrite(ctx, args, body, content)
        : name === 'edit_file' ? await prepareEdit(ctx, args, body, edits)
          : name === 'move_file' ? await prepareMove(ctx, args)
            : name === 'delete_file' ? await prepareDelete(ctx, args) : null
      if (!made) throw new ToolError(`没有「${name}」这个工具`)
      return made.run ? { ...made, run: guarded(made.run) } : made
    } catch (error) {
      throw said(error)
    }
  }
  const guarded = run => async () => {
    try {
      return await run()
    } catch (error) {
      throw said(error)
    }
  }

  return { prepare }
}

/** The tools for a model's own tool calling: [{ name, description, parameters }]. */
export function fileToolDefs(folders) {
  const text = description => ({ type: 'string', description })
  const tool = (name, description, properties, required) => ({ name, description, parameters: { type: 'object', properties, required } })
  const at = text('文件夹名/里面的路径')
  return [
    tool('list_files', '看一个文件夹里有什么，或者按名字往下找', { path: text('文件夹名或里面的文件夹；不写就列出能用的文件夹'), find: text('名字里的关键词') }, []),
    tool('search_files', '按文字搜文件内容（不分大小写，几个词用 | 隔开）', { query: text('要搜的文字'), path: text('在哪个文件夹或文件里搜；不写就全搜') }, ['query']),
    tool('read_file', '读文字文件，一次最多 400 行', { path: at, from: { type: 'integer', description: '从第几行，默认 1' }, to: { type: 'integer', description: '到第几行' } }, ['path']),
    ...(folders.some(folder => folder.mode === 'write') ? [
      tool('edit_file', '把文件里的一处原文换成别的，改之前要先读过。改几处就调用几次', { path: at, old: text('要换掉的原文，一字不差，在文件里只有一处'), new: text('换成的内容') }, ['path', 'old', 'new']),
      tool('write_file', '新建文件，或者整份重写（已有的文件要先读完；只改几处用 edit_file）', { path: at, content: text('文件的完整内容') }, ['path', 'content']),
      tool('move_file', '改名或移动文件', { path: text('原来的路径'), to: text('新的路径，写到文件名') }, ['path', 'to']),
      tool('delete_file', '删除文件（旧版会留着）', { path: at }, ['path']),
    ] : []),
  ]
}

/** What the model is told of the tools and the folders of this chat; `native`: the tools themselves are told apart. */
export function fileToolsText(folders, { native = false } = {}) {
  const writes = folders.some(folder => folder.mode === 'write')
  const asked = '改动多半要用户确认，用户可能不同意或者让你换个做法。只改用户要你改的。'
  const where = `能用的文件夹：${folders.map(folder => `「${folder.label}」（${folder.mode === 'write' ? '可以改' : '只读'}）`).join('、')}。路径写成「文件夹名/里面的路径」，别的地方都用不了。`
  if (native) return ['### 文件', where, ...(writes ? [asked] : [])].join('\n')
  return [
    '### 文件',
    where,
    '<tool name="list_files" path="文件夹名"/>  看一个文件夹里有什么；加 find="关键词" 按名字往下找',
    '<tool name="search_files" query="关键词" path="文件夹名"/>  按文字搜内容（不分大小写，几个词用 | 隔开）',
    '<tool name="read_file" path="文件夹名/文件" from="1" to="200"/>  读文字文件，一次最多 400 行',
    ...(writes ? [
      '<tool name="edit_file" path="文件夹名/文件">',
      '<old>要换掉的原文，一字不差，在文件里只有一处</old>',
      '<new>换成的内容</new>',
      '</tool>  改一处或几处（几组 old/new），改之前要先读过',
      '<tool name="write_file" path="文件夹名/文件">',
      '完整内容',
      '</tool>  新建文件；已有的文件要先读完才能整份重写，只改几处用 edit_file',
      '<tool name="move_file" path="原来的路径" to="新的路径"/>  改名或移动',
      '<tool name="delete_file" path="文件夹名/文件"/>  删除（旧版会留着）',
      asked,
    ] : []),
  ].join('\n')
}
