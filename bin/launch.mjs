#!/usr/bin/env node
// Desktop launcher: start the server in the background if it is not already
// running, then open it in an app window (Edge or Chrome --app: no tabs, no
// address bar). Exits as soon as the window is open. The server it starts quits
// about a minute after the last page (computer or phone) closes, or at
// 设置 → 停止后台服务; a server already running from a console is left alone.
// A package folder replaced by an in-app update hands over to the newer folder
// (server/update/install.mjs), so its CicaTavern.exe keeps working.
// CicaTavern.exe (launcher/) runs this with no console window.
//   node bin/launch.mjs [--port <edition's port>] [--data <dir>] [--idle-exit 60] [--edition personal|release] [--no-window] [--no-forward]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openAppWindow } from '../server/app-window.mjs'
import { editionName, featuresOf, packagedEdition } from '../server/edition.mjs'
import { defaultDataRoot } from '../server/store.mjs'
import { runtimeNode, supersededBy } from '../server/update/install.mjs'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * The newest of the folders this one was replaced by, one after another (A → B → C after two updates: each mark
 * names the next only). A loop or a folder gone ends the walk at the last one there.
 */
function newestInstall(root) {
  const seen = new Set([path.resolve(root)])
  let found = null
  for (let next = supersededBy(root); next && !seen.has(path.resolve(next.path)) && seen.size <= 20; next = supersededBy(next.path)) {
    seen.add(path.resolve(next.path))
    found = next
  }
  return found
}

const newer = args.includes('--no-forward') ? null : newestInstall(path.join(here, '..'))
if (newer) {
  const node = runtimeNode(newer.path)
  const run = spawnSync(existsSync(node) ? node : process.execPath, [path.join(newer.path, 'bin', 'launch.mjs'), ...args, '--no-forward'], { stdio: 'inherit', windowsHide: true })
  process.exit(run.status ?? 1)
}

const edition = featuresOf(option('edition') ?? packagedEdition())
const port = Number(option('port') ?? process.env.AGENT_TAVERN_PORT ?? edition.port)
const dataRoot = option('data') ?? defaultDataRoot(edition.dataDir)
const url = `http://127.0.0.1:${port}/`
const logFile = path.join(dataRoot, 'logs', 'server.log')

/** 'ours' when this edition already runs on the port, 'other' for another edition, else null. */
async function running() {
  try {
    const res = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(1500) })
    const health = await res.json()
    if (health.app !== 'agent-tavern') return null
    return editionName(health.edition) === edition.edition ? 'ours' : 'other'
  } catch {
    return null
  }
}

function startServer() {
  mkdirSync(path.dirname(logFile), { recursive: true })
  const log = openSync(logFile, 'w')
  const pass = ['port', 'data', 'proxy', 'listen', 'edition'].flatMap(name => (option(name) ? [`--${name}`, option(name)] : []))
  pass.push('--idle-exit', option('idle-exit') ?? '60')
  const child = spawn(process.execPath, [path.join(here, 'start.mjs'), ...pass], {
    cwd: path.join(here, '..'),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  })
  let exited = null
  child.on('exit', code => { exited = code ?? 1 })
  child.unref()
  return () => exited
}

function tail() {
  try {
    return readFileSync(logFile, 'utf8').trim().split('\n').slice(-6).join('\n')
  } catch {
    return ''
  }
}

const found = await running()
if (found === 'other') {
  console.error(`端口 ${port} 上开着另一个版本的酒馆。关掉它，或者用 --port 换一个端口。`)
  process.exit(1)
}
if (!found) {
  const exitCode = startServer()
  // First start copies the Claude Code binary (personal install), which can take a while.
  const deadline = Date.now() + 90_000
  for (;;) {
    if ((await running()) === 'ours') break
    if (exitCode() !== null || Date.now() > deadline) {
      console.error(`${edition.appName}没能启动。日志：${logFile}\n\n${tail()}`)
      process.exit(1)
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}
if (!args.includes('--no-window')) openAppWindow(url)
