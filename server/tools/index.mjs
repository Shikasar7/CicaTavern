// 直连对话's tools as the app has them (plans/24): whether they are on, which folders each chat has, what waits for the
// player's yes. The folders are kept here, by chat id (data/tools.json), never in the chat itself: a chat brought in from
// someone else's file cannot bring folders along. Backups leave this file out.
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { blockSent } from '../blockwords.mjs'
import { httpError } from '../store.mjs'
import { msg } from '../i18n.mjs'
import { createFileHistory, newRun, putFile } from './history.mjs'
import { createFileTools, FILE_TOOLS, fileToolDefs, fileToolsText, ToolError, WRITE_TOOLS } from './files.mjs'
import { createGuard, PathError } from './paths.mjs'
import { toolsText } from './calls.mjs'

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAX_FOLDERS = 10
const MAX_KNOWN = 40
const WAIT_MS = 30 * 60 * 1000
const BROWSE_ENTRIES = 500
export const WORKSPACE = 'workspace'

/**
 * @param features - the edition's: `files` ('any' folder of this computer, or only the 'workspace').
 * @param onPending - (chatId) => …: what waits in a chat changed (the pages look again).
 */
export function createTools(store, { features = {}, onPending = () => {}, guard: given = null } = {}) {
  const dataRoot = store.dirs.root
  const file = path.join(dataRoot, 'tools.json')
  const workspace = path.join(dataRoot, 'workspace')
  const guard = given ?? createGuard({ dataRoot, appRoot: APP_ROOT, workspace })
  const history = createFileHistory({ dir: path.join(dataRoot, 'file-history'), guard })
  const files = createFileTools({ guard, history })
  const available = Boolean(features.files)
  const anyFolder = features.files === 'any'

  // ─── Kept ──────────────────────────────────────────────────────────────

  let cached = null
  async function load() {
    if (cached) return cached
    let value = {}
    try {
      value = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      // Not read is not the same as not there: an unreadable file is not written over.
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    cached = {
      on: value.on === true,
      known: Array.isArray(value.known) ? value.known.filter(item => typeof item?.id === 'string' && typeof item.path === 'string') : [],
      chats: value.chats && typeof value.chats === 'object' && !Array.isArray(value.chats) ? value.chats : {},
    }
    return cached
  }
  let queue = Promise.resolve()
  /** One change at a time, on disk before it counts. */
  function change(fn) {
    const next = queue.then(async () => {
      const state = structuredClone(await load())
      const result = await fn(state)
      await mkdir(dataRoot, { recursive: true })
      await putFile(file, Buffer.from(JSON.stringify(state, null, 1)))
      cached = state
      return result
    })
    queue = next.catch(() => {})
    return next
  }

  const labelOf = real => path.basename(real).replace(/[\\/:*?"<>|]/g, '').trim() || 'folder'

  /** The folders of a chat as the tools use them, their names all different. */
  async function foldersOf(chatId) {
    const state = await load()
    if (!available || !state.on) return []
    const out = []
    const names = new Set()
    for (const item of state.chats[chatId] ?? []) {
      const known = item.id === WORKSPACE ? { id: WORKSPACE, path: workspace } : state.known.find(folder => folder.id === item.id)
      if (!known || (!anyFolder && item.id !== WORKSPACE)) continue
      let label = item.id === WORKSPACE ? '工作文件夹' : labelOf(known.path)
      for (let n = 2; names.has(label.toLowerCase()); n++) label = `${labelOf(known.path)} ${n}`
      names.add(label.toLowerCase())
      out.push({ id: known.id, label, path: known.path, mode: item.mode === 'write' ? 'write' : 'read', free: item.free === true && item.mode === 'write' })
    }
    return out
  }

  // ─── For the page ──────────────────────────────────────────────────────

  /** @param local - the request comes from this computer: only there may folders be added and the switch be turned on. */
  async function view(chatId, { local = false } = {}) {
    const state = await load()
    const folders = chatId ? await foldersOf(chatId) : []
    return {
      available, on: available && state.on, local, anyFolder, workspace: local ? workspace : '',
      // Where they are on this computer's disk is for this computer.
      folders: folders.map(folder => ({ ...folder, path: local ? folder.path : '' })),
      known: anyFolder ? state.known.map(({ id, path: at }) => ({ id, path: local ? at : '', label: labelOf(at) })) : [],
      pending: chatId ? pendingOf(chatId) : [],
      runs: chatId && state.on ? await history.runsOf(chatId) : [],
    }
  }

  async function setOn(on, { local = false } = {}) {
    if (!available) throw httpError(400, msg`这个版本不能用文件工具`)
    if (on && !local) throw httpError(403, msg`只能在运行 CicaTavern 的这台电脑上打开`)
    await change(state => {
      state.on = on === true
    })
    if (!on) for (const id of [...pending.keys()]) settle(id, { ok: false, gone: true })
  }

  /** A folder picked or typed in, checked: its real path. */
  async function checkFolder(value) {
    const text = String(value ?? '').trim().replace(/^"(.*)"$/, '$1')
    if (!text || !path.isAbsolute(text)) throw httpError(400, msg`写出完整的路径，比如 D:\\小说`)
    if (/^[\\/]{2}/.test(text)) throw httpError(400, msg`不能加网络上的文件夹（\\\\开头的）`)
    const real = await realpath(text).catch(() => null)
    if (!real || !(await stat(real).catch(() => null))?.isDirectory()) throw httpError(400, msg`没有这个文件夹`)
    const why = guard.unfit(real)
    if (why) throw httpError(400, why)
    return real
  }

  /** The chat's folders set: [{ id or path, mode, free }]. */
  async function setFolders(chatId, list, { local = false } = {}) {
    if (!available) throw httpError(400, msg`这个版本不能用文件工具`)
    if (!(await load()).on) throw httpError(400, msg`先打开文件工具`)
    if (!Array.isArray(list) || list.length > MAX_FOLDERS) throw httpError(400, msg`一段对话最多 ${MAX_FOLDERS} 个文件夹`)
    const wanted = []
    for (const item of list) {
      const mode = item?.mode === 'write' ? 'write' : 'read'
      const free = mode === 'write' && item.free === true
      if (item?.path !== undefined) {
        if (!anyFolder) throw httpError(400, msg`这个版本只能用工作文件夹`)
        if (!local) throw httpError(403, msg`只能在运行 CicaTavern 的这台电脑上加文件夹`)
        wanted.push({ real: await checkFolder(item.path), mode, free })
      } else wanted.push({ id: String(item?.id ?? ''), mode, free })
    }
    if (wanted.some(item => item.id === WORKSPACE)) await mkdir(workspace, { recursive: true })
    await change(state => {
      const out = []
      for (const item of wanted) {
        let id = item.id
        if (item.real) {
          const same = state.known.find(folder => path.relative(folder.path, item.real) === '')
          id = same?.id ?? randomBytes(6).toString('hex')
          if (!same) state.known = [...state.known, { id, path: item.real }].slice(-MAX_KNOWN)
        } else if (id !== WORKSPACE && !(anyFolder && state.known.some(folder => folder.id === id))) throw httpError(400, msg`没有这个文件夹`)
        if (!out.some(folder => folder.id === id)) out.push({ id, mode: item.mode, free: item.free })
      }
      if (out.length) state.chats[chatId] = out
      else delete state.chats[chatId]
    })
  }

  /** A folder taken off the list of those added before, and out of every chat. */
  async function forget(id) {
    await change(state => {
      state.known = state.known.filter(folder => folder.id !== id)
      for (const [chatId, list] of Object.entries(state.chats)) {
        state.chats[chatId] = list.filter(item => item.id !== id)
        if (!state.chats[chatId].length) delete state.chats[chatId]
      }
    })
  }

  async function dropChat(chatId) {
    if ((await load()).chats[chatId]) await change(state => { delete state.chats[chatId] })
  }

  /** The folders in a folder, to pick one (only from this computer): { path, parent, dirs: [{ name, path, why }] }. */
  async function browse(value, { local = false } = {}) {
    if (!local) throw httpError(403, msg`只能在运行 CicaTavern 的这台电脑上加文件夹`)
    if (!available || !anyFolder || !(await load()).on) throw httpError(400, msg`先打开文件工具`)
    const home = os.homedir()
    const text = String(value ?? '').trim()
    if (!text) {
      const starts = ['Documents', 'Desktop', 'Downloads'].map(name => path.join(home, name))
      const drives = process.platform === 'win32' ? await Promise.all([...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map(async letter => ((await stat(`${letter}:\\`).catch(() => null)) ? `${letter}:\\` : null))) : [home]
      const dirs = []
      for (const at of [...starts, ...drives.filter(Boolean)]) if ((await stat(at).catch(() => null))?.isDirectory()) dirs.push({ name: starts.includes(at) ? path.basename(at) : at, path: at, why: guard.unfit(at) })
      return { path: '', parent: null, why: msg`选一个文件夹`, dirs }
    }
    if (!path.isAbsolute(text) || /^[\\/]{2}/.test(text)) throw httpError(400, msg`写出完整的路径，比如 D:\\小说`)
    const real = await realpath(text).catch(() => null)
    const entries = real && (await readdir(real, { withFileTypes: true }).catch(() => null))
    if (!entries) throw httpError(400, msg`打不开这个文件夹`)
    const dirs = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('$')).map(entry => ({ name: entry.name, path: path.join(real, entry.name) })).filter(dir => !guard.blocked(dir.path))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh')).slice(0, BROWSE_ENTRIES)
    const up = path.dirname(real)
    return { path: real, parent: up === real ? '' : up, why: guard.unfit(real), dirs }
  }

  // ─── The player's yes ──────────────────────────────────────────────────

  // id → { id, chatId, view, resolve, timer }: what a turn under way waits for.
  const pending = new Map()
  const pendingOf = chatId => [...pending.values()].filter(item => item.chatId === chatId).map(({ id, view: shown, canFree, at }) => ({ id, ...shown, canFree, at }))

  function settle(id, answer) {
    const item = pending.get(id)
    if (!item) return false
    pending.delete(id)
    clearTimeout(item.timer)
    item.resolve(answer)
    onPending(item.chatId)
    return true
  }

  /** Asks the player: { ok, reason?, free? }. No answer in half an hour, or the turn stopped, is a no. */
  function ask(chatId, shown, { canFree = false, signal } = {}) {
    if (signal?.aborted) return Promise.resolve({ ok: false, gone: true })
    return new Promise(resolve => {
      const id = randomBytes(12).toString('hex')
      const stop = () => settle(id, { ok: false, gone: true })
      const timer = setTimeout(() => settle(id, { ok: false, late: true }), WAIT_MS)
      timer.unref?.()
      signal?.addEventListener('abort', stop, { once: true })
      pending.set(id, { id, chatId, view: shown, canFree, at: new Date().toISOString(), timer, resolve: answer => {
        signal?.removeEventListener('abort', stop)
        resolve(answer)
      } })
      onPending(chatId)
    })
  }

  /** The player's answer, once, to exactly what was shown. */
  async function answer(chatId, id, { ok, reason = '', free = false } = {}) {
    const item = pending.get(String(id))
    if (!item || item.chatId !== chatId) throw httpError(409, msg`这一步已经不用确认了`)
    settle(item.id, { ok: ok === true, reason: String(reason ?? '').trim().slice(0, 1000), free: ok === true && free === true && item.canFree })
  }

  // ─── In a turn ─────────────────────────────────────────────────────────

  // chat id → what its model has read of each file, while the server runs: a turn later it need not read again.
  const seen = new Map()
  function seenOf(chatId) {
    if (!seen.has(chatId) && seen.size > 50) seen.delete(seen.keys().next().value)
    if (!seen.has(chatId)) seen.set(chatId, new Map())
    return seen.get(chatId)
  }

  /** The tools of a turn: null when the chat has none; else { names, system(native), defs, run, step(call, { signal }) }. */
  async function forTurn(chatId) {
    const folders = await foldersOf(chatId)
    if (!folders.length) return null
    const run = newRun()
    const words = await store.getBlockWords()
    let changed = false
    history.prune().catch(() => {})
    return {
      names: new Set(FILE_TOOLS),
      system: native => toolsText([fileToolsText(folders, { native })], { native }),
      defs: fileToolDefs(folders),
      run,
      changed: () => changed,
      /** One call done: { text (for the model), ok, summary? }. Never throws for what the model or the player did. */
      async step(call, { signal, onWait = () => {} } = {}) {
        if (call.problem) return { text: `出错：${call.problem}`, ok: false }
        // As they are now: the player may have taken a folder away, or made it read-only, since the turn began.
        const now = await foldersOf(chatId)
        const ctx = { folders: now, seen: seenOf(chatId), run, chatId, signal, masked: text => blockSent(text, words) !== text }
        try {
          const made = await files.prepare(call, ctx)
          if (made.result !== undefined) return { text: made.result, ok: true }
          if (made.ask !== 'no') {
            onWait()
            const said = await ask(chatId, { kind: 'tool', name: call.name, said: call.said, ...made.view }, { canFree: made.ask === 'write' && Boolean(made.free), signal })
            if (signal?.aborted) return { text: '用户停止了', ok: false, summary: made.summary }
            if (!said.ok) return { text: said.late ? '等了半小时用户没有确认，没有做' : `用户不同意，没有做${said.reason ? `。用户说：${said.reason}` : ''}`, ok: false, summary: { ...made.summary, refused: true } }
            if (said.free) await freeFolder(chatId, made.free)
            // As they are after the wait: a folder taken away meanwhile is not used.
            ctx.folders = await foldersOf(chatId)
          }
          const text = await made.run()
          if (WRITE_TOOLS.has(call.name)) changed = true
          return { text, ok: true, summary: made.summary }
        } catch (error) {
          if (error instanceof ToolError || error instanceof PathError) return { text: `出错：${error.message}`, ok: false }
          throw error
        }
      },
      /** Asked when the turn has used a lot: true to go on. */
      async goOn(tokens, { signal } = {}) {
        return (await ask(chatId, { kind: 'tokens', tokens }, { signal })).ok
      },
    }
  }

  const freeFolder = (chatId, id) => change(state => {
    for (const item of state.chats[chatId] ?? []) if (item.id === id && item.mode === 'write') item.free = true
  })

  return { view, setOn, setFolders, forget, dropChat, browse, answer, pendingOf, forTurn, undo: history.undo, runView: history.view, foldersOf }
}
