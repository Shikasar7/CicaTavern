#!/usr/bin/env node
// Desktop launcher: start the server in the background if it is not already
// running, then open it in an app window (Edge or Chrome --app: no tabs, no
// address bar). Exits as soon as the window is open. The server it starts quits
// about a minute after the last page (computer or phone) closes, or at
// 设置 → 停止后台服务; a server already running from a console is left alone.
//   node bin/launch.mjs [--port <edition's port>] [--data <dir>] [--idle-exit 60] [--edition personal|release] [--no-window]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { editionName, featuresOf, packagedEdition } from '../server/edition.mjs'
import { defaultDataRoot } from '../server/store.mjs'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const edition = featuresOf(option('edition') ?? packagedEdition())
const port = Number(option('port') ?? process.env.AGENT_TAVERN_PORT ?? edition.port)
const dataRoot = option('data') ?? defaultDataRoot(edition.dataDir)
const url = `http://127.0.0.1:${port}/`
const here = path.dirname(fileURLToPath(import.meta.url))
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

function browser() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
  for (const rel of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) {
    for (const root of roots) {
      const file = path.join(root, rel)
      if (existsSync(file)) return file
    }
  }
  return null
}

function openWindow() {
  const exe = browser()
  if (exe) {
    spawn(exe, [`--app=${url}`, '--window-size=1280,860'], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
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
if (!args.includes('--no-window')) openWindow()
