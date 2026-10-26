#!/usr/bin/env node
// Switch the Windows package from one install folder to another (设置 → 更多 → 更新):
//   node bin/update-apply.mjs --from <dir> --to <dir> --version <to's> --from-version <from's>
//        --mode update|rollback --pid <server pid> --state <dir>
//        [--relaunch-port <n>] [--relaunch-data <dir>] [--relaunch-edition release]
//        [--relaunch-idleExit <s>] [--relaunch-proxy <url>] [--relaunch-listen local|lan]
//        [--timeout <s>]
// The running server starts this from its own install (server/update/index.mjs), so
// it is code known to work. It waits for that server to exit, starts the one in
// --to, and once that answers /api/health with the new version it points the
// shortcuts and the old folder's launcher at it: the commit point. If the new
// one does not answer in time, it is stopped and --from starts again with
// everything as it was. How it went is written to result.json in the updater
// folder of whichever install runs at the end; the page shows it.
// The data folder is only passed on to the server (--data); nothing here writes in it.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { canonical, readJson, retargetShortcuts, stateDir, UPDATE_DIR, writeJsonFile } from '../server/update/install.mjs'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const from = canonical(option('from'))
const to = canonical(option('to'))
const toVersion = option('version')
const fromVersion = option('from-version')
const mode = option('mode') === 'rollback' ? 'rollback' : 'update'
const pid = Number(option('pid'))
const state = option('state') ?? path.join(from, UPDATE_DIR)
const timeoutMs = Number(option('timeout') ?? 90) * 1000
const relaunch = Object.fromEntries(args.flatMap((arg, i) => (arg.startsWith('--relaunch-') ? [[arg.slice(11), args[i + 1]]] : [])))
const port = Number(relaunch.port ?? 8790)
const dataRoot = relaunch.data
const logFile = dataRoot ? path.join(dataRoot, 'logs', 'server.log') : path.join(state, 'server.log')
// Tests point the shortcut search at their own folder.
const shortcutFolders = process.env.CICATAVERN_SHORTCUT_DIRS ? process.env.CICATAVERN_SHORTCUT_DIRS.split(';').filter(Boolean) : undefined

function log(line) {
  try {
    mkdirSync(state, { recursive: true })
    appendFileSync(path.join(state, 'apply.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Nowhere to write.
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function alive(id) {
  if (!id) return false
  try {
    process.kill(id, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** /api/health's version, or null while nothing (or another app) answers. */
async function healthVersion() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    const health = await res.json()
    return health.app === 'agent-tavern' ? String(health.version) : null
  } catch {
    return null
  }
}

/** Start the server in an install folder, as bin/launch.mjs would. */
function startServer(dir) {
  mkdirSync(path.dirname(logFile), { recursive: true })
  const out = openSync(logFile, 'w')
  const pass = ['--port', String(port), '--edition', relaunch.edition ?? 'release', '--idle-exit', String(relaunch.idleExit ?? 60)]
  if (dataRoot) pass.push('--data', dataRoot)
  if (relaunch.proxy) pass.push('--proxy', relaunch.proxy)
  if (relaunch.listen) pass.push('--listen', relaunch.listen)
  const node = path.join(dir, 'runtime', 'node.exe')
  const child = spawn(existsSync(node) ? node : process.execPath, [path.join(dir, 'bin', 'start.mjs'), ...pass], {
    cwd: dir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  })
  child.exited = false
  child.on('exit', () => { child.exited = true })
  child.on('error', () => { child.exited = true })
  child.unref()
  return child
}

/** Wait for the server to answer with this version; false when it exits or the time runs out. */
async function healthy(child, version) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await healthVersion()) === version) return true
    if (child.exited) return false
    await sleep(400)
  }
  return false
}

/** The server is a single process (start.mjs starts no children in the release). */
function stop(child) {
  if (child.exited || !child.pid) return
  try {
    process.kill(child.pid)
  } catch {
    // Already gone.
  }
}

/** The new server's log: the start of an error says what it is, the end where; a long one keeps both. */
function logTail() {
  try {
    const lines = readFileSync(logFile, 'utf8').trim().split(/\r?\n/)
    const kept = lines.length > 40 ? [...lines.slice(0, 15), '…', ...lines.slice(-20)] : lines
    return kept.join('\n').slice(0, 4000)
  } catch {
    return ''
  }
}

async function result(dir, value) {
  await writeJsonFile(path.join(await stateDir(dir), 'result.json'), { ...value, mode, from: fromVersion, to: toVersion, at: new Date().toISOString() }).catch(error => log(`result.json: ${error.message}`))
}

/**
 * Before the new server starts (it reads its state once): it keeps
 * 自动检查更新 and the last check; back on an older version, the daily check
 * does not offer the newer one again by itself. Harmless when the start fails.
 */
async function prepare() {
  const fromState = await readJson(path.join(state, 'state.json'), {})
  const toStateDir = await stateDir(to)
  const toState = await readJson(path.join(toStateDir, 'state.json'), {})
  const next = mode === 'update'
    ? { ...toState, autoCheck: fromState.autoCheck !== false, checkedAt: fromState.checkedAt ?? 0, latest: fromState.latest ?? null, error: null, staged: null }
    : { ...toState, skipped: fromVersion, staged: null }
  await writeJsonFile(path.join(toStateDir, 'state.json'), next).catch(error => log(`state.json: ${error.message}`))
}

/** The installs before `start`, following each previous.json back while they are there (a loop ends it). */
async function olderInstalls(start) {
  const found = []
  const seen = new Set([path.resolve(start), path.resolve(to)])
  let marker = await readJson(path.join(start, UPDATE_DIR, 'previous.json'), null)
  while (marker?.path && !seen.has(path.resolve(marker.path)) && found.length < 20) {
    seen.add(path.resolve(marker.path))
    if (!existsSync(marker.path)) break
    found.push(marker.path)
    marker = await readJson(path.join(marker.path, UPDATE_DIR, 'previous.json'), null)
  }
  return found
}

/** The new install runs: point everything at it. */
async function commit() {
  let shortcuts = []
  let shortcutError = null
  try {
    shortcuts = await retargetShortcuts(from, to, { folders: shortcutFolders })
  } catch (error) {
    shortcutError = error.message
    log(`shortcuts: ${error.message}`)
  }
  // Double-clicking the old folder's CicaTavern.exe now opens the new one (bin/launch.mjs).
  const mark = { path: to, version: toVersion, at: new Date().toISOString() }
  await writeJsonFile(path.join(from, UPDATE_DIR, 'superseded.json'), mark).catch(error => log(`superseded.json: ${error.message}`))
  if (mode === 'update') {
    await writeJsonFile(path.join(to, UPDATE_DIR, 'previous.json'), { path: from, version: fromVersion }).catch(error => log(`previous.json: ${error.message}`))
    // The folders before that one too (each previous.json back): an older version's launcher, which follows one
    // mark only, opens this one, and so does any folder whose next one has been deleted since.
    for (const older of await olderInstalls(from)) await writeJsonFile(path.join(older, UPDATE_DIR, 'superseded.json'), mark).catch(error => log(`superseded.json (${older}): ${error.message}`))
  }
  else await rm(path.join(to, UPDATE_DIR, 'superseded.json'), { force: true }).catch(() => {})
  await result(to, { ok: true, shortcuts: shortcuts.length, shortcutError })
  log(`switched to ${to} (${toVersion}); ${shortcuts.length} shortcut(s)`)
}

log(`${mode}: ${from} (${fromVersion}) → ${to} (${toVersion}), server pid ${pid}, port ${port}`)

// 1. The running server stops itself right after starting this.
for (let waited = 0; alive(pid); waited += 200) {
  if (waited > 20_000) {
    log('the old server did not exit')
    await result(from, { ok: false, error: '旧版本的服务没有退出，没有切换。' })
    process.exit(1)
  }
  await sleep(200)
}
for (let waited = 0; (await healthVersion()) !== null && waited < 10_000; waited += 300) await sleep(300)

// 2. Start the new one and wait for it.
await prepare()
const next = startServer(to)
if (await healthy(next, toVersion)) {
  await commit()
  process.exit(0)
}

// 3. It did not come up: back to the one that was running.
const tail = logTail()
log(`${toVersion} did not start; going back to ${fromVersion}\n${tail}`)
stop(next)
for (let waited = 0; (await healthVersion()) !== null && waited < 10_000; waited += 300) await sleep(300)
// The failed folder stays (旧版本文件夹 lists it) but is not offered for 重启 again.
const fromState = await readJson(path.join(state, 'state.json'), null)
if (fromState) await writeJsonFile(path.join(state, 'state.json'), { ...fromState, staged: null }).catch(error => log(`state.json: ${error.message}`))
const back = startServer(from)
const restored = await healthy(back, fromVersion)
await result(from, {
  ok: false,
  error: restored ? `${toVersion} 没能启动，已回到 ${fromVersion}。` : `${toVersion} 没能启动，${fromVersion} 也没能重新启动：从桌面图标再打开一次。`,
  log: tail,
})
process.exit(1)
