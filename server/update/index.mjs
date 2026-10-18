// 设置 → 更多 → 更新: checks GitHub Releases for a newer version (at most once
// a day by itself, or when asked) and, on Windows, installs it:
//   1. download the win-x64 zip through 设置 → 网络代理 (http.Agent proxyEnv);
//   2. check its SHA-256 against what the release publishes (release.mjs);
//   3. unpack it next to this install (install.mjs);
//   4. on 重启, bin/update-apply.mjs (this install's own code) stops this
//      server, starts the new one and only then points the shortcuts and this
//      folder's launcher at it; when the new one does not come up, it starts
//      this one again.
// The phone app only checks: its button opens the APK in the browser, and
// Android keeps the data when the same signature installs over it.
// The data folder is never read or written here: the updater's state lives
// with the install (install.mjs).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appVersion } from '../edition.mjs'
import { agentFor } from '../providers.mjs'
import { compareVersions, FEED, releaseInfo, REPO } from './release.mjs'
import { checkRuntime, installBase, isInstall, otherInstalls, previousInstall, readJson, removeInstall, stateDir, stageInstall, writeJsonFile } from './install.mjs'

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DAY_MS = 24 * 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 20_000
const IDLE_TIMEOUT_MS = 60_000

function failure(status, message) {
  return Object.assign(new Error(message), { status })
}

/** One GET that follows redirects (GitHub sends downloads to its asset host); https only, except a local test feed. */
function get(href, { proxy, signal, headers, allowHttp }, hops = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(href)
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return reject(new Error(`不安全的下载地址：${url.origin}`))
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.get(url, { agent: agentFor(url, proxy), headers, signal, timeout: IDLE_TIMEOUT_MS }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        if (hops >= 5) return reject(new Error('重定向太多次'))
        return resolve(get(new URL(res.headers.location, url).href, { proxy, signal, headers: { 'user-agent': headers['user-agent'] }, allowHttp }, hops + 1))
      }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error('网络超时')))
    req.on('error', reject)
  })
}

async function readText(res) {
  let text = ''
  for await (const chunk of res) {
    text += chunk
    if (text.length > 2_000_000) throw new Error('回复太长')
  }
  return text
}

/** A network error in words: what to try. */
function networkTrouble(error) {
  if (error?.name === 'AbortError') return '已取消'
  const code = error?.code ?? error?.cause?.code
  const what = code ? `${code}` : String(error?.message ?? error).slice(0, 120)
  return `连不上 GitHub（${what}）。在国内通常要在 设置 → 网络代理 里设代理。`
}

/**
 * @param features - the edition's; features.updates is 'zip' (Windows package), 'apk' (phone) or null.
 * @param proxy - the app's proxy URL right now, or null.
 * @param relaunch - the arguments the restarted server gets: { port, data, edition, idleExit, proxy?, listen? }.
 * @param busy - true while a turn or the card creator is writing (no restart then).
 * @param onShutdown - stops this server once the switch-over has started.
 * Tests replace: root, version, feed, now, env, platform, check (the bundled
 * Node's self-test), spawnSwitch (runs bin/update-apply.mjs).
 */
export function createUpdater({
  features,
  proxy = () => null,
  relaunch = () => ({}),
  busy = () => false,
  onShutdown = null,
  dataRoot = null,
  root = APP_ROOT,
  version = appVersion(root),
  feed = process.env.CICATAVERN_UPDATE_FEED || FEED,
  repo = REPO,
  now = () => Date.now(),
  env = process.env,
  platform = process.platform,
  check = checkRuntime,
  spawnSwitch = spawnApply,
} = {}) {
  const kind = features?.updates ?? null
  const allowHttp = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(feed)
  const userAgent = `CicaTavern/${version} (+https://github.com/${repo})`
  // Why this copy cannot install by itself, or null.
  const notInstallable = () => {
    if (kind !== 'zip') return kind === 'apk' ? null : '这个版本不用应用内更新'
    if (platform !== 'win32') return '应用内更新只支持 Windows 发布包'
    if (!isInstall(root)) return '这份 CicaTavern 不是从发布包运行的（比如从源码运行），用 git pull 或到发布页下载更新'
    return null
  }
  let dir = null // the state folder, found on first use
  let saved = null // state.json
  let job = { step: 'idle' } // downloading | verifying | unpacking | ready | restarting | error
  let controller = null
  let checking = null

  async function stateFolder() {
    dir ??= await stateDir(root, env)
    return dir
  }
  // A package (or the phone app's own copy, which android/scripts/stage-node.mjs
  // stamps) keeps its state on disk; a source checkout keeps it in memory rather
  // than write into the tree.
  const persist = kind === 'apk' ? existsSync(path.join(root, 'stamp.txt')) : kind === 'zip' && isInstall(root)
  async function load() {
    if (saved) return saved
    saved = { autoCheck: true, checkedAt: 0, latest: null, error: null, skipped: null, staged: null, ...(persist ? await readJson(path.join(await stateFolder(), 'state.json'), {}) : {}) }
    return saved
  }
  async function save(patch) {
    saved = { ...(await load()), ...patch }
    // Read-only installs keep the state in memory.
    if (persist) await writeJsonFile(path.join(await stateFolder(), 'state.json'), saved).catch(() => {})
    return saved
  }

  /** The staged folder from state.json while it is still the package it was. */
  function staged(state) {
    const s = state.staged
    if (!s?.path || !isInstall(s.path)) return null
    return compareVersions(s.version, version) > 0 ? s : null
  }

  async function status() {
    if (!kind) return { enabled: false }
    const state = await load()
    const latest = state.latest
    const newer = Boolean(latest && compareVersions(latest.version, version) > 0)
    const ready = kind === 'zip' ? staged(state) : null
    const result = persist && kind === 'zip' ? await readJson(path.join(await stateFolder(), 'result.json')) : null
    return {
      enabled: true,
      kind,
      version,
      root: kind === 'zip' ? root : null,
      installable: !notInstallable(),
      reason: notInstallable(),
      autoCheck: state.autoCheck !== false,
      checkedAt: state.checkedAt || null,
      checkError: state.error,
      latest,
      newer,
      skipped: state.skipped,
      job: ready && job.step === 'idle' ? { step: 'ready' } : job,
      ready,
      previous: persist && kind === 'zip' ? await previousInstall(root) : null,
      result,
    }
  }

  async function fetchLatest() {
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS)
    let res
    try {
      res = await get(`${feed}/releases/latest`, {
        proxy: proxy(),
        signal,
        allowHttp,
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': userAgent },
      })
    } catch (error) {
      throw failure(502, signal.aborted ? '连 GitHub 超时。在国内通常要在 设置 → 网络代理 里设代理。' : networkTrouble(error))
    }
    const text = await readText(res)
    if (res.statusCode === 404) throw failure(502, '还没有发布任何版本')
    if (res.statusCode === 403 || res.statusCode === 429) throw failure(502, 'GitHub 暂时限制了查询次数，过一会儿再试')
    if (res.statusCode !== 200) throw failure(502, `GitHub 回复 ${res.statusCode}`)
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw failure(502, 'GitHub 的回复读不懂')
    }
    return releaseInfo(json, { repo, feed })
  }

  /** Ask GitHub now (force), or when the daily check is due. */
  async function checkNow({ force = false } = {}) {
    if (!kind) return status()
    const state = await load()
    const due = state.autoCheck !== false && now() - (state.checkedAt || 0) >= DAY_MS
    if (!force && !due) return status()
    checking ??= (async () => {
      try {
        const latest = await fetchLatest()
        await save({ latest, checkedAt: now(), error: null })
      } catch (error) {
        // A failed daily check also waits a day; 检查更新 says why.
        await save({ checkedAt: now(), error: error.message })
        if (force) throw error
      } finally {
        checking = null
      }
    })()
    await checking
    return status()
  }

  async function setAutoCheck(on) {
    if (!kind) throw failure(404, '这个版本不用应用内更新')
    await save({ autoCheck: Boolean(on) })
    return status()
  }

  /** Download, verify and unpack the latest Windows package; runs on after the request returns. */
  async function download() {
    const reason = notInstallable()
    if (kind !== 'zip' || reason) throw failure(400, reason ?? '这个版本不能在应用里安装更新')
    if (['downloading', 'verifying', 'unpacking', 'restarting'].includes(job.step)) return status()
    const state = await load()
    const latest = state.latest
    if (!latest || compareVersions(latest.version, version) <= 0) throw failure(400, '没有更新的版本')
    if (staged(state)?.version === latest.version) return status()
    const asset = latest.assets?.zip
    if (!asset) throw failure(400, '这个版本没有 Windows 安装包')
    if (!asset.sha256) throw failure(400, asset.hashError)
    controller = new AbortController()
    job = { step: 'downloading', version: latest.version, received: 0, total: asset.size }
    run(latest, asset, controller.signal).catch(() => {})
    return status()
  }

  async function run(latest, asset, signal) {
    const folder = await stateFolder()
    const part = path.join(folder, `${asset.name}.part`)
    const zipFile = path.join(folder, asset.name)
    try {
      const res = await get(asset.url, { proxy: proxy(), signal, allowHttp, headers: { accept: 'application/octet-stream', 'user-agent': userAgent } }).catch(error => {
        throw signal.aborted ? Object.assign(new Error('已取消'), { name: 'AbortError' }) : new Error(networkTrouble(error))
      })
      if (res.statusCode !== 200) {
        res.resume()
        throw new Error(`下载失败：GitHub 回复 ${res.statusCode}`)
      }
      job.total = Number(res.headers['content-length']) || asset.size
      const hash = createHash('sha256')
      const out = createWriteStream(part)
      await new Promise((resolve, reject) => {
        res.on('data', chunk => {
          hash.update(chunk)
          job.received += chunk.length
        })
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('下载中断了')))
        out.on('error', reject)
        out.on('finish', resolve)
        res.pipe(out)
        signal.addEventListener('abort', () => reject(Object.assign(new Error('已取消'), { name: 'AbortError' })), { once: true })
      }).catch(error => {
        res.destroy()
        out.destroy()
        throw error
      })
      job.step = 'verifying'
      const sha256 = hash.digest('hex')
      if (asset.size && job.received !== asset.size) throw new Error(`下载不完整（${job.received} / ${asset.size} 字节），再试一次`)
      if (sha256 !== asset.sha256) throw new Error(`SHA-256 对不上，已丢弃下载的文件。应为 ${asset.sha256}，实际 ${sha256}`)
      await rename(part, zipFile)
      job.step = 'unpacking'
      const base = await installBase(root, env)
      const folderPath = await stageInstall(await readFile(zipFile), { base, version: latest.version, check })
      await save({ staged: { version: latest.version, path: folderPath, sha256 } })
      job = { step: 'ready', version: latest.version }
    } catch (error) {
      job = { step: 'error', version: latest.version, error: error.name === 'AbortError' ? '已取消下载' : error.message }
    } finally {
      controller = null
      await rm(part, { force: true }).catch(() => {})
      await rm(zipFile, { force: true }).catch(() => {})
    }
  }

  function cancel() {
    controller?.abort()
    return status()
  }

  /** Hand over to bin/update-apply.mjs: it stops this server and starts `target`, or this one again on failure. */
  async function switchTo(target, mode) {
    if (busy()) throw failure(409, '正在生成，等它写完再重启')
    if (!onShutdown) throw failure(400, '这个服务不能从页面重启：关掉控制台窗口，再从桌面图标打开')
    const from = { path: root, version }
    const folder = await stateFolder()
    await rm(path.join(folder, 'result.json'), { force: true })
    job = { step: 'restarting', version: target.version, mode }
    try {
      await spawnSwitch({ root, from, to: target, mode, relaunch: relaunch(), stateDir: folder, pid: process.pid })
    } catch (error) {
      job = { step: 'error', error: `重启没能开始：${error.message}` }
      throw failure(500, job.error)
    }
    setTimeout(onShutdown, 300).unref?.()
    return { ok: true, restarting: true, to: target.version }
  }

  async function apply() {
    const reason = notInstallable()
    if (kind !== 'zip' || reason) throw failure(400, reason ?? '这个版本不能在应用里安装更新')
    const ready = staged(await load())
    if (!ready) throw failure(400, '还没下载好新版本')
    return switchTo(ready, 'update')
  }

  async function rollback() {
    if (kind !== 'zip' || notInstallable()) throw failure(400, '这个版本不能在应用里切换版本')
    const previous = await previousInstall(root)
    if (!previous) throw failure(400, '上一版的文件夹已经不在了')
    return switchTo(previous, 'rollback')
  }

  /** The other package folders next to this one (and the LOCALAPPDATA fallback). */
  async function installs() {
    if (kind !== 'zip' || notInstallable()) return { installs: [] }
    const bases = [...new Set([path.dirname(root), await installBase(root, env)])]
    const list = otherInstalls(root, bases)
    const state = await load()
    const keep = staged(state)?.path
    return { installs: list.map(item => ({ ...item, staged: Boolean(keep && path.resolve(keep) === path.resolve(item.path)) })) }
  }

  async function remove(target) {
    const { installs: list } = await installs()
    const item = list.find(i => path.resolve(i.path) === path.resolve(String(target ?? '')))
    if (!item) throw failure(404, '没有这个旧版本文件夹')
    if (['downloading', 'verifying', 'unpacking', 'restarting'].includes(job.step)) throw failure(409, '正在更新，等一会儿再删')
    await removeInstall(item.path, { root, dataRoot })
    if (item.staged) {
      await save({ staged: null })
      job = { step: 'idle' }
    }
    return installs()
  }

  async function acknowledge() {
    if (persist && kind === 'zip') await rm(path.join(await stateFolder(), 'result.json'), { force: true })
    if (job.step === 'error') job = { step: 'idle' }
    return status()
  }

  async function skip(versionToSkip) {
    await save({ skipped: versionToSkip ? String(versionToSkip) : null })
    return status()
  }

  return { kind, status, check: checkNow, setAutoCheck, download, cancel, apply, rollback, installs, remove, acknowledge, skip }
}

/** Start bin/update-apply.mjs from this install, detached, so it outlives this server. */
export function spawnApply({ root, from, to, mode, relaunch, stateDir: folder, pid }) {
  const script = path.join(root, 'bin', 'update-apply.mjs')
  if (!existsSync(script)) return Promise.reject(new Error('缺少 bin/update-apply.mjs'))
  const args = [script, '--from', from.path, '--to', to.path, '--version', to.version, '--from-version', from.version, '--mode', mode, '--pid', String(pid), '--state', folder]
  for (const [key, value] of Object.entries(relaunch)) {
    if (value !== undefined && value !== null && value !== '') args.push(`--relaunch-${key}`, String(value))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore', cwd: root })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
