// The Windows package on disk, as the updater sees it. A new version is
// unpacked next to the running one (CicaTavern-1.4.0-win-x64 beside
// CicaTavern-1.3.1-win-x64); the old folder stays for rolling back.
//   <install>/update/state.json       the last check, 自动检查更新, a staged update
//   <install>/update/superseded.json  this folder was replaced: { path, version } of the newer one;
//                                     bin/launch.mjs here forwards there
//   <install>/update/previous.json    the folder this one replaced (回到上一版)
//   <install>/update/result.json      how the last switch went (bin/update-apply.mjs)
// Beside them, CicaTavern (FIXED_NAME) is a junction to the version in use: a
// shortcut to CicaTavern\CicaTavern.exe keeps working through every update.
// The Mac's CicaTavern.app only checks for updates; its state.json goes to
// ~/Library/Application Support/CicaTavern/update, never into the bundle.
// Nothing here reads or writes the data folder (%USERPROFILE%\.cicatavern).
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { extractZip } from './zip.mjs'

export const UPDATE_DIR = 'update'
const REQUIRED = ['edition.json', 'package.json', path.join('bin', 'launch.mjs'), path.join('bin', 'start.mjs'), path.join('server', 'http.mjs')]

/** An install's bundled Node: runtime/node.exe in the Windows package, runtime/node in the Mac app's folder. */
export function runtimeNode(dir) {
  const windows = path.join(dir, 'runtime', 'node.exe')
  return existsSync(windows) ? windows : path.join(dir, 'runtime', 'node')
}

/**
 * A folder's one spelling (Windows' long names, not 8.3 forms such as RUNNER~1),
 * so install folders compare equal however they were reached; as given when it
 * does not exist.
 */
export function canonical(dir) {
  try {
    return realpathSync.native(dir)
  } catch {
    return path.resolve(dir)
  }
}

/** The zip's top folder, which is also the new install's folder name (a Mac version's folder in Application Support: macFolder). */
export const packageFolder = version => `CicaTavern-${version}-win-x64`

function readJsonSync(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n')
  await rename(temp, file)
}

/** A release package folder: edition.json says release and the files the launcher needs are there. */
export function isInstall(dir) {
  if (!dir || !REQUIRED.every(file => existsSync(path.join(dir, file))) || !existsSync(runtimeNode(dir))) return false
  return readJsonSync(path.join(dir, 'edition.json'))?.edition === 'release'
}

export function installVersion(dir) {
  return String(readJsonSync(path.join(dir, 'package.json'))?.version ?? '')
}

/** Whether files can be created in the folder (Program Files usually cannot). */
export async function writable(dir) {
  const probe = path.join(dir, `.cicatavern-probe-${randomBytes(4).toString('hex')}`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(probe, '')
    await rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * The per-user folder for what cannot go next to the install: %LOCALAPPDATA%
 * on Windows, ~/Library/Application Support on macOS (which has neither
 * LOCALAPPDATA nor USERPROFILE).
 */
export function userAppData(env = process.env, platform = process.platform) {
  if (platform === 'darwin') return path.join(env.HOME || homedir(), 'Library', 'Application Support')
  return env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? '', 'AppData', 'Local')
}

/**
 * The app folder inside CicaTavern.app (Contents/Resources/app). Nothing is
 * written there: a changed bundle no longer matches its signature.
 */
export const inAppBundle = dir => /\.app[\\/]Contents([\\/]|$)/i.test(path.resolve(dir))

/** Where downloads go and new versions are unpacked: beside this install, else under LOCALAPPDATA (Application Support on a Mac). */
export async function installBase(root, env = process.env, platform = process.platform) {
  const beside = path.dirname(root)
  if (!inAppBundle(root) && (await writable(beside))) return beside
  return platform === 'darwin' ? path.join(userAppData(env, platform), 'CicaTavern') : path.join(userAppData(env, platform), 'Programs', 'CicaTavern')
}

/**
 * Where an install's marks are (superseded.json, previous.json): its update folder, or for the folder inside
 * CicaTavern.app, which is never written to, the updater folder in Application Support (as stateDir).
 */
export function markDir(root, env = process.env, platform = process.platform) {
  return inAppBundle(root) ? path.join(userAppData(env, platform), 'CicaTavern', UPDATE_DIR) : path.join(root, UPDATE_DIR)
}

/** The updater's own files for this install: <install>/update, else under LOCALAPPDATA (Application Support on a Mac). */
export async function stateDir(root, env = process.env, platform = process.platform) {
  const own = path.join(root, UPDATE_DIR)
  if (!inAppBundle(root) && (await writable(own))) return own
  return path.join(userAppData(env, platform), 'CicaTavern', UPDATE_DIR)
}

/** base/name, or base/name-2, -3… when it is taken. */
export function freeFolder(base, name) {
  for (let i = 1; ; i++) {
    const candidate = path.join(base, i === 1 ? name : `${name}-${i}`)
    if (!existsSync(candidate)) return candidate
  }
}

/**
 * The unpacked programs are whole and readable (an antivirus may have taken
 * them away). Nothing new runs before the restart the user asks for.
 */
export async function checkRuntime(nodeExe) {
  // The Mac's: it runs (nothing it unpacked is quarantined, so it does not ask first).
  if (path.basename(nodeExe) === 'node') {
    const out = await new Promise((resolve, reject) => execFile(nodeExe, ['--version'], { timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))))
      .catch(error => { throw new Error(`新版本的 node 运行不了（${error.code ?? error.message}）`) })
    if (!/^v\d+\./.test(out.trim())) throw new Error('新版本的 node 不完整')
    return
  }
  for (const file of [nodeExe, path.join(path.dirname(path.dirname(nodeExe)), 'CicaTavern.exe')]) {
    let head
    try {
      head = (await readFile(file)).subarray(0, 2).toString('latin1')
    } catch (error) {
      throw new Error(`新版本的 ${path.basename(file)} 读不了（${error.code ?? error.message}）：杀毒软件可能隔离了它。`)
    }
    if (head !== 'MZ') throw new Error(`新版本的 ${path.basename(file)} 不完整`)
  }
}

/**
 * Unpack a verified package next to the others: into a hidden .partial folder
 * first, checked (edition, version, files, the programs are whole), then renamed.
 * Nothing is left behind on failure. → the new install's folder.
 */
// Windows: a scanner still reading the files just unpacked refuses the folder's rename for a moment.
const RENAME_REFUSED = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function renameRetrying(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (error) {
      if (attempt >= 10 || !RENAME_REFUSED.has(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 100 * attempt))
    }
  }
}

export async function stageInstall(zip, { base, version, check = checkRuntime }) {
  const top = packageFolder(version)
  const partial = path.join(base, `.${top}.partial-${randomBytes(4).toString('hex')}`)
  try {
    await extractZip(zip, partial, { top })
    if (!isInstall(partial)) throw new Error('更新包里缺文件，或者不是 Windows 发布版')
    const packed = installVersion(partial)
    if (packed !== version) throw new Error(`更新包里的版本是 ${packed}，不是 ${version}`)
    await check(path.join(partial, 'runtime', 'node.exe'))
    const final = freeFolder(base, top)
    await renameRetrying(partial, final)
    return final
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** A Mac version's folder in Application Support: the programs from CicaTavern.app/Contents/Resources/app. */
export const macFolder = version => `CicaTavern-${version}-mac`

const tool = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 300_000 }, error => (error ? reject(error) : resolve())))

/** ditto, which keeps the programs' executable bits and is on every Mac. */
const ditto = (zip, out) => tool('/usr/bin/ditto', ['-x', '-k', zip, out])

/**
 * A disk image's CicaTavern.app copied into out: attached read-only where Finder does not show it, copied
 * with ditto, detached again. The app downloaded the image itself, so nothing is quarantined and nothing asks.
 */
async function fromImage(dmg, out) {
  const mount = await mkdtemp(path.join(tmpdir(), 'cicatavern-dmg-'))
  try {
    await tool('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount])
    try {
      await tool('/usr/bin/ditto', [path.join(mount, 'CicaTavern.app'), path.join(out, 'CicaTavern.app')])
    } finally {
      await tool('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => {})
    }
  } finally {
    // Empty once detached; rmdir never reaches into a volume still attached.
    await rmdir(mount).catch(() => {})
  }
}

const unpackPackage = (file, out) => (/\.dmg$/i.test(file) ? fromImage(file, out) : ditto(file, out))

/**
 * A verified Mac package (its disk image, or a zip in releases before 2.2.0; CicaTavern.app inside) → the
 * new version's folder in base: its programs (Contents/Resources/app) only, copied into a hidden .partial
 * folder first and checked (edition, version, files, Node runs), then moved. The app in /Applications is
 * not touched. Nothing is left behind on failure. Tests replace unpack (package file, folder).
 */
export async function stageMacInstall(packageFile, { base, version, check = checkRuntime, unpack = unpackPackage }) {
  const top = macFolder(version)
  const partial = path.join(base, `.${top}.partial-${randomBytes(4).toString('hex')}`)
  try {
    await mkdir(partial, { recursive: true })
    await unpack(packageFile, partial)
    const programs = path.join(partial, 'CicaTavern.app', 'Contents', 'Resources', 'app')
    if (!isInstall(programs) || !existsSync(path.join(programs, 'runtime', 'node'))) throw new Error('更新包里缺文件，或者不是 Mac 发布版')
    const packed = installVersion(programs)
    if (packed !== version) throw new Error(`更新包里的版本是 ${packed}，不是 ${version}`)
    await check(path.join(programs, 'runtime', 'node'))
    const final = freeFolder(base, top)
    await rename(programs, final)
    return final
  } finally {
    await rm(partial, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * The newer install this one was replaced by, when that folder is still a
 * package (bin/launch.mjs forwards there), else null.
 */
export function supersededBy(root) {
  const marker = readJsonSync(path.join(markDir(root), 'superseded.json'))
  if (!marker?.path || path.resolve(marker.path) === path.resolve(root) || !isInstall(marker.path)) return null
  return { path: marker.path, version: installVersion(marker.path) }
}

/** The install this one replaced, when it is still there. */
export async function previousInstall(root) {
  const marker = await readJson(path.join(markDir(root), 'previous.json'))
  if (!marker?.path || path.resolve(marker.path) === path.resolve(root) || !isInstall(marker.path)) return null
  return { path: marker.path, version: installVersion(marker.path) }
}

const inside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function folderSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    try {
      total += statSync(path.join(entry.parentPath, entry.name)).size
    } catch {
      // Gone meanwhile.
    }
  }
  return total
}

/** Other packages in the given folders (the old versions next to this one): [{ path, version, bytes, superseded }]. */
export function otherInstalls(root, bases) {
  const seen = new Set([path.resolve(root).toLowerCase()])
  const found = []
  for (const base of bases) {
    let names = []
    try {
      names = readdirSync(base)
    } catch {
      continue
    }
    for (const name of names) {
      const dir = path.join(base, name)
      const key = path.resolve(dir).toLowerCase()
      // The fixed folder is a link to one of them, not a version of its own (and deleting it would delete that one).
      if (seen.has(key) || name.startsWith('.') || isLink(dir) || !isInstall(dir)) continue
      seen.add(key)
      found.push({ path: dir, version: installVersion(dir), bytes: folderSize(dir), superseded: existsSync(path.join(dir, UPDATE_DIR, 'superseded.json')) })
    }
  }
  return found
}

/** Delete an old package folder; never the running one, never one that holds (or is inside) the data folder. */
export async function removeInstall(dir, { root, dataRoot }) {
  // One spelling for all three, or a short-form path could slip past the checks.
  dir = canonical(dir)
  root = canonical(root)
  if (dataRoot) dataRoot = canonical(dataRoot)
  if (!isInstall(dir)) throw Object.assign(new Error('这不是 CicaTavern 的安装文件夹'), { status: 400 })
  if (inAppBundle(dir)) throw Object.assign(new Error('这是 CicaTavern.app 自带的版本，要删就把 CicaTavern 从「应用程序」移到废纸篓'), { status: 400 })
  if (inside(dir, root) || inside(root, dir)) throw Object.assign(new Error('不能删除正在运行的版本'), { status: 400 })
  if (dataRoot && (inside(dataRoot, dir) || inside(dir, dataRoot))) throw Object.assign(new Error('数据目录在这个文件夹里，不能删除'), { status: 400 })
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    throw Object.assign(new Error(`删不掉（${error.code ?? error.message}）：可能还开着这个版本，或者有文件被占用`), { status: 409 })
  }
}

// ─── The fixed folder ───────────────────────────────────────────────────
// Each version unpacks into a folder named after it, and the old updater (2.8.0
// and before) expects that of the package, so the folders stay as they are.
// Beside them a junction named CicaTavern points at the version in use: the
// updater moves it at each switch, and a shortcut made through it never needs
// changing. A junction needs no administrator; a drive without them (FAT, a
// network share) simply has none, and a real folder by that name is left alone.

export const FIXED_NAME = 'CicaTavern'
/** Where the fixed folder for an install goes: beside it. */
export const fixedPath = dir => path.join(path.dirname(dir), FIXED_NAME)
// What a package folder is called as it comes out of the zip.
const PACKAGE_NAME = /^CicaTavern-\d+\.\d+\.\d+[\w.-]*-win-x64(?:-\d+)?$/i
// Release versions only (x.y.z): what the folders beside it hold. bin/update-apply.mjs runs this file from a
// package by itself, so it keeps to what it needs rather than import release.mjs.
const versionParts = text => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '')) ?? []).slice(1).map(Number)
function olderThan(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)]
  if (x.length !== 3 || y.length !== 3) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}

function isLink(file) {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/** Where a link points (its target, resolved), or null for none, a broken one or something else there. */
export function fixedTarget(link) {
  if (!isLink(link)) return null
  try {
    return realpathSync.native(link)
  } catch {
    return null
  }
}

/**
 * Point the fixed folder at `target`: made where nothing is, moved where it is
 * already a link; a real file or folder there stays. → the link, or null.
 */
export async function pointFixed(target, link = fixedPath(target)) {
  target = canonical(target)
  let there = true
  try {
    lstatSync(link)
  } catch (error) {
    if (error.code !== 'ENOENT') return null
    there = false
  }
  if (there && !isLink(link)) return null
  if (there && fixedTarget(link) && canonical(fixedTarget(link)) === target) return link
  try {
    // rmdir takes a Windows junction away and never what it points at; elsewhere the link is a symlink, unlinked.
    if (there) await (process.platform === 'win32' ? rmdir(link) : unlink(link))
    await symlink(target, link, 'junction')
    return link
  } catch {
    return null
  }
}

/**
 * On start: the fixed folder beside this install, made when it is missing and
 * moved here when it points at nothing, at a folder this one replaced, or at an
 * older version (a newer package unpacked by hand). A rollback leaves it where
 * the updater put it. Only beside a folder still named as the package names it,
 * so one the user renamed (CicaTavern itself, say) gets nothing beside it.
 * → the link when it points here, else null.
 */
export async function ensureFixed(root, version = installVersion(root)) {
  root = canonical(root)
  if (!PACKAGE_NAME.test(path.basename(root))) return null
  const link = fixedPath(root)
  const now = fixedTarget(link)
  if (now && canonical(now) === root) return link
  const stale = !now || !isInstall(now) || canonical(supersededBy(now)?.path ?? '') === root || olderThan(installVersion(now), version)
  if (now && !stale) return null
  if (!now && existsSync(link)) return null
  return pointFixed(root, link)
}

/** The fixed folder beside `dir` when it points there, else null. */
export function fixedFor(dir) {
  const link = fixedPath(dir)
  const now = fixedTarget(link)
  return now && canonical(now) === canonical(dir) ? link : null
}

/**
 * At a switch (bin/update-apply.mjs): the fixed folder beside `to` points there
 * (made when missing beside a package folder), and one beside `from` that
 * pointed at it follows too. → the one beside `to` when it points there, else null.
 */
export async function followFixed(from, to) {
  const beside = fixedPath(to)
  if (fixedPath(from) !== beside && canonical(fixedTarget(fixedPath(from)) ?? '') === canonical(from)) await pointFixed(to, fixedPath(from))
  if (isLink(beside) || (!existsSync(beside) && PACKAGE_NAME.test(path.basename(canonical(to))))) await pointFixed(to, beside)
  return fixedFor(to)
}

// ─── Shortcuts ──────────────────────────────────────────────────────────
// CicaTavern.exe edits them itself through the shell's IShellLink (launcher/):
// no script is written or run.

function runLauncher(exe, args) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim().slice(0, 400)))
      resolve(String(stdout).split(/\r?\n/).filter(Boolean))
    })
  })
}

const dirArgs = folders => (folders ?? []).flatMap(folder => ['--dir', folder])

/**
 * Point every shortcut that opens the old folder at the new one (desktop,
 * Start menu, pinned taskbar, or the given folders), using the old install's
 * CicaTavern.exe. → the shortcut files changed.
 */
export async function retargetShortcuts(from, to, { exe = path.join(from, 'CicaTavern.exe'), folders } = {}) {
  if (process.platform !== 'win32') return []
  if (!existsSync(exe)) throw new Error('旧版本里没有 CicaTavern.exe，快捷方式没改')
  return runLauncher(exe, ['--retarget-shortcuts', from, to, ...dirArgs(folders)])
}

/** The shortcuts there: [{ file, target, args, dir, icon }]. */
export async function listShortcuts({ exe, folders } = {}) {
  const lines = await runLauncher(exe, ['--list-shortcuts', ...dirArgs(folders)])
  return lines.map(line => {
    const [file, target, args, dir, icon] = line.split('\t')
    return { file, target, args, dir, icon }
  })
}

/** CicaTavern.lnk on the desktop (or in the Start menu) for this install's exe. → its path. */
export async function createShortcut(exe, { startMenu = false, folder } = {}) {
  const [file] = await runLauncher(exe, ['--create-shortcut', ...(startMenu ? ['--start-menu'] : []), ...(folder ? ['--dir', folder] : [])])
  return file
}
