// The proxy for the app's outgoing requests: providers set to follow it,
// NovelAI, and the Claude Code subprocess. Chosen in 设置 → 网络代理:
//   'none'    no proxy
//   'system'  Windows' Internet settings (what Clash or v2rayN write in
//             system-proxy mode; Node does not read them by itself), on macOS
//             the network settings (`scutil --proxy`, what ClashX and the like
//             set), else HTTPS_PROXY / HTTP_PROXY. Re-read every minute, so
//             switching the proxy app on or off needs no restart.
//   a URL     that proxy (HTTP proxies only: Node cannot speak SOCKS)
// The setting's absence means the edition's default (edition.mjs). A --proxy
// or AGENT_TAVERN_PROXY given at start wins over the setting.
import { execFile } from 'node:child_process'

const URL_FORM = /^https?:\/\/[^\s/]+\/?$/i
const SYSTEM_REFRESH_MS = 60_000

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}

/** A saved setting: null (edition default), 'none', 'system' or a URL; anything else is refused. */
export function cleanProxySetting(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  if (/^(none|off|direct)$/i.test(text)) return 'none'
  if (/^system$/i.test(text)) return 'system'
  if (URL_FORM.test(text)) return text.replace(/\/+$/, '')
  throw badRequest('代理地址要写成 http://127.0.0.1:7890 这样（只支持 HTTP 代理）')
}

/** --proxy / AGENT_TAVERN_PROXY: undefined when not given; 'off' and the like mean none. */
export function proxyOverride(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (/^(off|none|false|0)?$/i.test(text)) return 'none'
  return cleanProxySetting(text)
}

/**
 * Windows' ProxyServer value as an http:// URL: "127.0.0.1:7890", or per
 * protocol "http=h:p;https=h:p;socks=h:p" (https, then http). Null for SOCKS only.
 */
export function parseWindowsProxy(server) {
  const text = String(server ?? '').trim()
  if (!text) return null
  let hostPort = text
  if (text.includes('=')) {
    const parts = {}
    for (const part of text.split(';')) {
      const [key, value] = part.split('=').map(s => s?.trim())
      if (key && value) parts[key.toLowerCase()] = value
    }
    hostPort = parts.https ?? parts.http ?? null
  }
  if (!hostPort) return null
  const url = /^https?:\/\//i.test(hostPort) ? hostPort : `http://${hostPort}`
  return URL_FORM.test(url) ? url.replace(/\/+$/, '') : null
}

/** The proxy in HKCU's Internet settings when it is switched on, else null. */
function readWindowsProxy() {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise(resolve => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null)
      const value = name => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi').exec(stdout)?.[1]?.trim() ?? ''
      resolve(/^0x0*1$/i.test(value('ProxyEnable')) ? parseWindowsProxy(value('ProxyServer')) : null)
    })
  })
}

/**
 * `scutil --proxy` (macOS) as an http:// URL: the top-level HTTPS proxy when
 * HTTPSEnable is 1, else the HTTP one; null when neither is on (SOCKS only,
 * or a PAC file). The per-interface copies under __SCOPED__ are not read.
 */
export function parseMacProxy(text) {
  const top = {}
  let depth = 0
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '}') {
      depth--
      continue
    }
    const entry = /^(\S+)\s*:\s*(.*)$/.exec(line)
    if (entry && depth === 1) top[entry[1]] = entry[2].trim()
    if (line.endsWith('{')) depth++
  }
  for (const kind of ['HTTPS', 'HTTP']) {
    const host = top[`${kind}Proxy`]
    if (top[`${kind}Enable`] !== '1' || !host || host.startsWith('<')) continue
    const port = /^\d+$/.test(top[`${kind}Port`] ?? '') ? `:${top[`${kind}Port`]}` : ''
    const url = `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${port}`
    if (URL_FORM.test(url)) return url
  }
  return null
}

/** The proxy in macOS' network settings when it is switched on, else null. */
function readMacProxy() {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise(resolve => {
    execFile('/usr/sbin/scutil', ['--proxy'], { timeout: 5000 }, (error, stdout) => resolve(error ? null : parseMacProxy(stdout)))
  })
}

/** This system's proxy setting: Windows' or macOS', else null. */
function readSystemProxy() {
  return process.platform === 'darwin' ? readMacProxy() : readWindowsProxy()
}

function envProxy(env) {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = String(env[key] ?? '').trim()
    if (URL_FORM.test(value)) return value.replace(/\/+$/, '')
  }
  return null
}

/**
 * @param override - from proxyOverride(); fixes the proxy whatever the setting says.
 * @param defaultMode - the edition's default when nothing is saved.
 * @param readSystem - tests replace the Windows (macOS) lookup.
 * @param systemName - what describe() calls that lookup's source: 'windows' or 'macos'.
 */
export function createProxy({ override, defaultMode = 'none', env = process.env, readSystem = readSystemProxy, systemName = process.platform === 'darwin' ? 'macos' : 'windows' } = {}) {
  let mode = override ?? defaultMode
  // Usable before the first apply() when the mode is a plain URL.
  let current = mode === 'none' || mode === 'system' ? null : mode
  let source = null // 'windows' | 'macos' | 'env' for the system mode
  let timer = null

  async function resolveSystem() {
    const system = await readSystem()
    if (system) return { url: system, from: systemName }
    const fromEnv = envProxy(env)
    return fromEnv ? { url: fromEnv, from: 'env' } : { url: null, from: null }
  }

  /** Apply a saved setting (ignored while an override is in force). */
  async function apply(setting) {
    mode = override ?? cleanProxySetting(setting) ?? defaultMode
    clearInterval(timer)
    timer = null
    if (mode === 'system') {
      ;({ url: current, from: source } = await resolveSystem())
      timer = setInterval(async () => {
        if (mode !== 'system') return
        ;({ url: current, from: source } = await resolveSystem())
      }, SYSTEM_REFRESH_MS)
      timer.unref?.()
    } else {
      current = mode === 'none' ? null : mode
      source = null
    }
    return describe()
  }

  function describe() {
    return { mode, effective: current, source, locked: override !== undefined }
  }

  return {
    apply,
    describe,
    /** The proxy URL for the next request, or null. */
    current: () => current,
    stop: () => clearInterval(timer),
  }
}
