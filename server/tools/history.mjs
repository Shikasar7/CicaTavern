// What 直连对话's file tools changed, kept so that it can be taken back (撤销这一轮的文件改动): one folder per turn under
// data/file-history, with each file as it was before. Written down before the change is made, so a crash in the middle
// still leaves the old version here. Deleting a file puts it here too. Kept for 30 days, 500 MB at most.
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { httpError } from '../store.mjs'
import { msg } from '../i18n.mjs'
import { hashOf } from './text.mjs'

const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const KEEP_BYTES = 500 * 1024 * 1024
const RUN = /^[a-f0-9]{16}$/

export const newRun = () => randomBytes(8).toString('hex')

/** Bytes into a file whole or not at all: a new file beside it, then its name. */
export async function putFile(real, bytes, { mode } = {}) {
  const temp = path.join(path.dirname(real), `.cica-${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, bytes, { flag: 'wx', flush: true, ...(mode ? { mode } : {}) })
    // Windows refuses while another program has the old one open for a moment (a virus scanner, a reader).
    for (let tries = 0; ; tries++) {
      try {
        await rename(temp, real)
        break
      } catch (error) {
        if (tries >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * 2 ** tries))
      }
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

const hashAt = async real => {
  const bytes = await readFile(real).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  return bytes ? hashOf(bytes) : null
}

/** @param guard - paths.mjs createGuard(): what is put back is checked as what was changed. */
export function createFileHistory({ dir, guard }) {
  const folderOf = run => {
    if (!RUN.test(String(run))) throw httpError(400, msg`无效的 ID`)
    return path.join(dir, run)
  }
  const load = async run => {
    try {
      return JSON.parse(await readFile(path.join(folderOf(run), 'run.json'), 'utf8'))
    } catch (error) {
      if (error.status) throw error
      return null
    }
  }
  const save = async state => putFile(path.join(folderOf(state.run), 'run.json'), Buffer.from(JSON.stringify(state)))

  // One change to a run at a time.
  let queue = Promise.resolve()
  const serial = fn => {
    const next = queue.then(fn)
    queue = next.catch(() => {})
    return next
  }

  /**
   * Before a change: the file as it is, kept. → its number in the run, for done().
   * @param entry - { op: 'write' | 'move' | 'delete', path (as shown), real, to?, toReal?, before: bytes or null, after: hash or null }
   */
  function begin(run, chatId, { before = null, ...entry }) {
    return serial(async () => {
      const folder = folderOf(run)
      await mkdir(folder, { recursive: true })
      const state = (await load(run)) ?? { run, chatId, at: new Date().toISOString(), entries: [] }
      const index = state.entries.length
      const blob = before ? `${index}.bin` : null
      if (before) await writeFile(path.join(folder, blob), before, { flush: true })
      state.entries.push({ ...entry, blob, beforeHash: before ? hashOf(before) : null, done: false, parent: path.dirname(entry.real), ...(entry.toReal ? { toParent: path.dirname(entry.toReal) } : {}) })
      await save(state)
      return index
    })
  }

  /** The change was made (or, `failed`, was not). */
  function done(run, index, { failed = false, made = [] } = {}) {
    return serial(async () => {
      const state = await load(run)
      if (!state?.entries[index]) return
      if (failed) state.entries[index].failed = true
      else state.entries[index].done = true
      // Folders that were made for it: gone again with it, when empty.
      if (made.length) state.entries[index].made = made
      await save(state)
    })
  }

  // Where an entry's file would go back to is still the place it was: its folder not turned into a link elsewhere.
  async function samePlace(real, parent) {
    if (guard.blocked(real)) return false
    // The nearest folder still there: those below it are made again, so it must not lead elsewhere either.
    for (let at = parent; ; at = path.dirname(at)) {
      const now = await realpath(at).catch(() => null)
      if (now) return path.relative(now, at) === ''
      if (path.dirname(at) === at) return false
    }
  }

  /** What undoing one entry would come to: 'ready', 'nothing' (already as it was), or 'changed' (by something since). */
  async function standing(entry) {
    if (entry.failed || entry.undone) return 'nothing'
    if (entry.op === 'move') {
      if (await stat(entry.toReal).catch(() => null)) return (await stat(entry.real).catch(() => null)) || (await hashAt(entry.toReal)) !== entry.after ? 'changed' : 'ready'
      return 'nothing'
    }
    const now = await hashAt(entry.real)
    if (entry.op === 'delete') return now === null ? 'ready' : now === entry.beforeHash ? 'nothing' : 'changed'
    if (now === entry.after) return 'ready'
    return now === entry.beforeHash ? 'nothing' : 'changed'
  }

  /** The run as the page shows it: { run, chatId, at, undone, files: [{ op, path, to?, undone }] }, or null. */
  const view = run => serial(async () => shown(await load(run)))
  function shown(state) {
    if (!state) return null
    const { run } = state
    const entries = state.entries.filter(entry => !entry.failed)
    return { run, chatId: state.chatId, at: state.at, undone: entries.length > 0 && entries.every(entry => entry.undone), files: entries.map(({ op, path, to, undone, blob }) => ({ op: op === 'write' && !blob ? 'create' : op, path, ...(to ? { to } : {}), undone: Boolean(undone) })) }
  }

  /**
   * Everything the run changed, put back, the last change first. Files changed since are named and nothing is done,
   * unless `force`: then they go back too, what they are now being kept first. → { undone: [path], changed: [path], failed: [path] }
   */
  function undo(run, { force = false } = {}) {
    return serial(async () => {
      const state = await load(run)
      if (!state) throw httpError(404, msg`这一轮改动的旧版已经不在了（只留 30 天）`)
      // An entry the one after it wrote over is judged by that one: only a file's last change is compared with the disk.
      const last = new Map()
      state.entries.forEach((entry, index) => {
        if (entry.failed || entry.undone) return
        if (entry.op === 'move') last.delete(entry.real)
        last.set(entry.op === 'move' ? entry.toReal : entry.real, index)
      })
      const changed = []
      for (const [, index] of last) if ((await standing(state.entries[index])) === 'changed') changed.push(state.entries[index].to ?? state.entries[index].path)
      if (changed.length && !force) return { undone: [], changed: [...new Set(changed)], failed: [] }
      const undone = []
      const failed = []
      for (let index = state.entries.length - 1; index >= 0; index--) {
        const entry = state.entries[index]
        if (entry.failed || entry.undone) continue
        try {
          const how = await standing(entry)
          if (how !== 'nothing') {
            if (!(await samePlace(entry.real, entry.parent)) || (entry.toReal && !(await samePlace(entry.toReal, entry.toParent)))) throw new Error('moved')
            // What is there now stays in the history.
            if (how === 'changed') await copyFile(entry.op === 'move' ? entry.toReal : entry.real, path.join(folderOf(run), `${index}.now`)).catch(() => {})
            await putBack(run, entry)
          }
          entry.undone = true
          undone.push(entry.path)
        } catch {
          failed.push(entry.to ?? entry.path)
        }
        await save(state)
      }
      return { undone: [...new Set(undone)], changed: [], failed: [...new Set(failed)] }
    })
  }

  async function putBack(run, entry) {
    if (entry.op === 'move') {
      if (await stat(entry.real).catch(() => null)) throw new Error('taken')
      await mkdir(entry.parent, { recursive: true })
      await rename(entry.toReal, entry.real)
    } else if (entry.blob) {
      await mkdir(entry.parent, { recursive: true })
      await putFile(entry.real, await readFile(path.join(folderOf(run), entry.blob)))
    } else await unlink(entry.real)
    // The deepest first; one with anything in it stays.
    for (const made of [...(entry.made ?? [])].reverse()) await rmEmpty(made)
  }
  // Only when empty (rmdir refuses another).
  const rmEmpty = folder => rmdir(folder).catch(() => {})

  /** The turns of a chat that changed files, the newest first. */
  const runsOf = chatId => serial(async () => {
    const runs = []
    for (const name of await readdir(dir).catch(() => [])) {
      if (!RUN.test(name)) continue
      const state = await load(name)
      if (state?.chatId === chatId && state.entries.some(entry => !entry.failed)) runs.push(shown(state))
    }
    return runs.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50)
  })

  /** The oldest go: past 30 days, and past 500 MB in all. */
  async function prune(now = Date.now()) {
    const runs = []
    for (const name of await readdir(dir).catch(() => [])) {
      if (!RUN.test(name)) continue
      let bytes = 0
      for (const file of await readdir(path.join(dir, name)).catch(() => [])) bytes += (await stat(path.join(dir, name, file)).catch(() => null))?.size ?? 0
      runs.push({ name, bytes, at: (await stat(path.join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })
    }
    runs.sort((a, b) => b.at - a.at)
    let total = 0
    for (const run of runs) {
      total += run.bytes
      if (now - run.at > KEEP_MS || total > KEEP_BYTES) await rm(path.join(dir, run.name), { recursive: true, force: true }).catch(() => {})
    }
  }

  return { begin, done, view, undo, runsOf, prune }
}
