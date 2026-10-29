// 设置 → 更多 → 更新: checks GitHub Releases for a newer version (at most once
// a day by itself, or when asked) and, on Windows, installs it:
//   1. download the win-x64 zip through 设置 → 网络代理 (http.Agent proxyEnv);
//   2. check its SHA-256 against what the release publishes (release.mjs);
//   3. unpack it next to this install (install.mjs);
//   4. on 重启, bin/update-apply.mjs (this install's own code) stops this
//      server, starts the new one and only then points the shortcuts and this
//      folder's launcher at it; when the new one does not come up, it starts
//      this one again.
// The phone app only checks here: the app itself downloads the APK, checks it
// and opens the system installer (android ApkUpdate.java), and Android keeps the
// data when the same signature installs over it. The Mac's CicaTavern.app only
// checks too: its button opens the release page, and the new .app replaces the
// old one in 应用程序.
// GitHub's API answers 60 unauthenticated queries an hour per network address,
// shared by everyone behind it (phone networks, offices); when it says no, the
// check reads the latest.json the release carries instead.
// Where GitHub fails or is slow to answer (mainland China, often), the check
// also reads the mirror's latest.json (cnb.cool, release.mjs MIRROR), which
// counts only with its Ed25519 signature; downloads try the mirror's copy of
// the same file when GitHub's does not come, and the SHA-256 is checked as ever.
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
import { compareVersions, FEED, LATEST_FILE, LATEST_KEY, latestFileUrl, MIRROR, mirrorLatestUrl, releaseInfo, REPO, SIGNATURE_FILE, trustedDownload, verifyLatest } from './release.mjs'
import { canonical, checkRuntime, inAppBundle, installBase, isInstall, otherInstalls, previousInstall, readJson, removeInstall, stageInstall, stageMacInstall, stateDir, writeJsonFile } from './install.mjs'
import { localize, msg } from '../i18n.mjs'

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DAY_MS = 24 * 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 20_000
const IDLE_TIMEOUT_MS = 60_000
// How long GitHub has to answer the check before the mirror is asked as well.
const MIRROR_AFTER_MS = 5_000
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/
const delay = ms => new Promise(resolve => setTimeout(resolve, ms).unref?.())

// The steps while an update is being fetched, set up or switched to: nothing else may start meanwhile.
const UPDATING = ['downloading', 'verifying', 'unpacking', 'restarting']
// 更新完自动清理旧版本 waits this long after the switch: bin/update-apply.mjs runs from the old folder and exits
// right after writing result.json, and Windows will not delete a node.exe that is still running.
const CLEAN_AFTER_MS = 15_000

function failure(status, message) {
  return Object.assign(new Error(message), { status })
}

/** One GET that follows redirects (GitHub sends downloads to its asset host); https only, except a local test feed. */
function get(href, { proxy, signal, headers, allowHttp }, hops = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(href)
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return reject(new Error(msg`不安全的下载地址：${url.origin}`))
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.get(url, { agent: agentFor(url, proxy), headers, signal, timeout: IDLE_TIMEOUT_MS }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        if (hops >= 5) return reject(new Error(msg`重定向太多次`))
        return resolve(get(new URL(res.headers.location, url).href, { proxy, signal, headers: { 'user-agent': headers['user-agent'] }, allowHttp }, hops + 1))
      }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error(msg`网络超时`)))
    req.on('error', reject)
  })
}

/** The body's bytes, whole (a signature covers exactly these), up to 2 MB. */
async function readBytes(res) {
  const chunks = []
  let length = 0
  for await (const chunk of res) {
    chunks.push(chunk)
    length += chunk.length
    if (length > 2_000_000) throw new Error(msg`回复太长`)
  }
  return Buffer.concat(chunks)
}

const readText = async res => (await readBytes(res)).toString('utf8')

/** A network error's code, or the start of its message. */
function errorCode(error) {
  const code = error?.code ?? error?.cause?.code
  return code ? `${code}` : String(error?.message ?? error).slice(0, 120)
}

/** A network error in words: what to try. */
function networkTrouble(error) {
  if (error?.name === 'AbortError') return msg`已取消`
  return msg`连不上 GitHub（${errorCode(error)}）。在国内通常要在 设置 → 网络代理 里设代理。`
}

/** Where a download comes from, in words. */
const sourceName = from => (from === 'mirror' ? msg`国内镜像` : 'GitHub')

/** Resolves with the first { info } of these, or null once all have failed. */
function firstAnswer(attempts) {
  return new Promise(resolve => {
    let left = attempts.length
    for (const attempt of attempts) {
      attempt.then(result => {
        if (result.info) resolve(result)
        else if (--left === 0) resolve(null)
      })
    }
  })
}

const settle = promise => promise.then(info => ({ info }), error => ({ error }))

/**
 * @param features - the edition's; features.updates is 'zip' (Windows package), 'apk' (phone), 'mac' (CicaTavern.app) or null.
 * @param proxy - the app's proxy URL right now, or null.
 * @param relaunch - the arguments the restarted server gets: { port, data, edition, idleExit, proxy?, listen? }.
 * @param busy - true while a turn or the card creator is writing (no restart then).
 * @param onShutdown - stops this server once the switch-over has started.
 * Tests replace: root, version, feed, mirror (null: none), publicKey (latest.json's),
 * mirrorAfterMs, now, env, platform, arch, check (the bundled Node's self-test),
 * spawnSwitch (runs bin/update-apply.mjs), unpackMac (ditto: the Mac zip into a folder).
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
  mirror = process.env.CICATAVERN_UPDATE_MIRROR || MIRROR,
  publicKey = LATEST_KEY,
  mirrorAfterMs = MIRROR_AFTER_MS,
  repo = REPO,
  now = () => Date.now(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  check = checkRuntime,
  spawnSwitch = spawnApply,
  unpackMac,
} = {}) {
  root = canonical(root)
  const kind = features?.updates ?? null
  const allowHttp = LOCAL.test(feed)
  // A local test feed goes with a local mirror or none, never the real one.
  if (allowHttp && mirror && !LOCAL.test(mirror)) mirror = null
  const trusted = href => trustedDownload(href, { repo, feed, mirror })
  const userAgent = `CicaTavern/${version} (+https://github.com/${repo})`
  // Why this copy cannot install by itself, or null.
  // Installs itself: the Windows package, and the Mac app (its new versions go to Application Support).
  const installs_ = kind === 'zip' || kind === 'mac'
  const notInstallable = () => {
    // The phone checks; the page hands its APK to the app.
    if (kind === 'apk') return null
    if (kind === 'mac') {
      if (platform !== 'darwin') return msg`应用内更新只支持 Mac 上的 CicaTavern`
      if (!inAppBundle(root) && !isInstall(root)) return msg`这份 CicaTavern 不是从 CicaTavern.app 运行的（比如从源码运行），用 git pull 或到发布页下载更新`
      return null
    }
    if (kind !== 'zip') return msg`这个版本不用应用内更新`
    if (platform !== 'win32') return msg`应用内更新只支持 Windows 发布包`
    if (!isInstall(root)) return msg`这份 CicaTavern 不是从发布包运行的（比如从源码运行），用 git pull 或到发布页下载更新`
    return null
  }
  let dir = null // the state folder, found on first use
  let saved = null // state.json
  let job = { step: 'idle' } // downloading | verifying | unpacking | ready | restarting | error
  let controller = null
  let checking = null
  let cleanTimer = null

  async function stateFolder() {
    dir ??= await stateDir(root, env, platform)
    return dir
  }
  // A package (or the phone app's own copy, which android/scripts/stage-node.mjs
  // stamps, or the Mac package with its runtime/node) keeps its state on disk; a
  // source checkout keeps it in memory rather than write into the tree.
  const persist = kind === 'apk' ? existsSync(path.join(root, 'stamp.txt')) : kind === 'mac' ? existsSync(path.join(root, 'runtime', 'node')) : kind === 'zip' && isInstall(root)
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
    const ready = installs_ ? staged(state) : null
    const result = persist && installs_ ? await readJson(path.join(await stateFolder(), 'result.json')) : null
    if (result?.ok && result.mode === 'update') await cleanAfterUpdate(state, result)
    return {
      enabled: true,
      kind,
      version,
      root: kind === 'zip' ? root : null,
      installable: !notInstallable(),
      reason: notInstallable(),
      autoCheck: state.autoCheck !== false,
      cleanOld: state.cleanOld === true,
      lastClean: saved.lastClean ?? null,
      checkedAt: state.checkedAt || null,
      checkError: state.error,
      latest,
      newer,
      skipped: state.skipped,
      job: ready && job.step === 'idle' ? { step: 'ready' } : job,
      ready,
      previous: persist && installs_ ? await previousInstall(root) : null,
      result,
    }
  }

  /**
   * GitHub first. When it fails, or has not answered within a few seconds, the
   * mirror is asked as well and the first release either gives is used: a
   * network that reaches GitHub quickly never asks the mirror.
   */
  async function fetchLatest() {
    const github = settle(fromGitHub())
    if (!mirror) {
      const { info, error } = await github
      if (error) throw error
      return info
    }
    const early = await Promise.race([github, delay(mirrorAfterMs)])
    if (early?.info) return early.info
    const fromMirrorResult = settle(fromMirror())
    const first = await firstAnswer([github, fromMirrorResult])
    if (first) return first.info
    const [{ error }, { error: mirrorError }] = await Promise.all([github, fromMirrorResult])
    throw failure(502, msg`${error.message.replace(/[。.]$/, '')}；国内镜像也没读到（${mirrorError.message}）`)
  }

  /** The repository's latest release, from GitHub's API, or its latest.json when the API says no. */
  async function fromGitHub() {
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
      throw failure(502, signal.aborted ? msg`连 GitHub 超时。在国内通常要在 设置 → 网络代理 里设代理。` : networkTrouble(error))
    }
    const text = await readText(res)
    if (res.statusCode === 404) throw failure(502, msg`还没有发布任何版本`)
    if (res.statusCode === 403 || res.statusCode === 429) return fromLatestFile(limitReason(res), signal)
    if (res.statusCode !== 200) throw failure(502, msg`GitHub 回复 ${res.statusCode}`)
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw failure(502, msg`GitHub 的回复读不懂`)
    }
    return releaseInfo(json, { repo, feed, mirror, arch })
  }

  /** Why the API said no, from its headers. */
  function limitReason(res) {
    const reset = Number(res.headers['x-ratelimit-reset'])
    if (res.headers['x-ratelimit-remaining'] === '0' && reset) {
      const minutes = Math.max(1, Math.ceil((reset * 1000 - now()) / 60_000))
      return msg`GitHub 的查询次数用完了：没登录时每个网络地址每小时只能查 60 次，手机网络、公司或学校的网络常常很多人共用一个地址。大约 ${minutes} 分钟后恢复`
    }
    const retry = Number(res.headers['retry-after'])
    if (retry > 0) return msg`GitHub 说查得太频繁，大约 ${Math.max(1, Math.ceil(retry / 60))} 分钟后再试`
    return msg`GitHub 拒绝了这次查询（${res.statusCode}）`
  }

  /** The API said no: the release's latest.json instead, which the same limit does not count. */
  async function fromLatestFile(reason, signal) {
    let json
    try {
      const res = await get(latestFileUrl(feed, repo), { proxy: proxy(), signal, allowHttp, headers: { accept: 'application/json', 'user-agent': userAgent } })
      const text = await readText(res)
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`)
      json = JSON.parse(text)
    } catch (error) {
      const why = signal.aborted ? msg`超时` : String(error?.code ?? error?.message ?? error).slice(0, 80)
      throw failure(502, msg`${reason}。备用的 latest.json 也没读到（${why}），过一会儿再试，或者打开发布页看看`)
    }
    return releaseInfo(json, { repo, feed, mirror, arch })
  }

  /** The mirror's latest release: its latest.json, when the signature beside it holds. */
  async function fromMirror() {
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS)
    const read = async file => {
      const res = await get(mirrorLatestUrl(mirror, file), { proxy: proxy(), signal, allowHttp, headers: { accept: 'application/json', 'user-agent': userAgent } })
      const bytes = await readBytes(res)
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`)
      return bytes
    }
    let bytes
    let signature
    try {
      ;[bytes, signature] = await Promise.all([read(LATEST_FILE), read(SIGNATURE_FILE)])
    } catch (error) {
      throw failure(502, signal.aborted ? msg`超时` : errorCode(error))
    }
    if (!verifyLatest(bytes, signature.toString('utf8'), publicKey)) throw failure(502, msg`签名对不上，没有采用`)
    let json
    try {
      json = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw failure(502, msg`latest.json 读不懂`)
    }
    return releaseInfo(json, { repo, feed, mirror, source: 'mirror', arch })
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
        await save({ checkedAt: now(), error: localize(error.message) })
        if (force) throw error
      } finally {
        checking = null
      }
    })()
    await checking
    // 检查更新 that joined the daily check already running still says it failed, not that this is the latest.
    if (force) {
      const saved = await load()
      if (saved.error) throw failure(502, saved.error)
    }
    return status()
  }

  /** 自动检查更新 and 更新完自动清理旧版本; a setting left out stays as it is. */
  async function settings({ autoCheck, cleanOld } = {}) {
    if (!kind) throw failure(404, msg`这个版本不用应用内更新`)
    const patch = {}
    if (autoCheck !== undefined) patch.autoCheck = autoCheck !== false
    if (cleanOld !== undefined) patch.cleanOld = cleanOld === true
    // Turned on, it starts with the next update: the folders the last one left stay (先留着 with 以后自动清理).
    if (patch.cleanOld && persist && installs_) patch.cleaned = (await readJson(path.join(await stateFolder(), 'result.json')))?.at ?? null
    await save(patch)
    return status()
  }

  /** Download, verify and unpack the latest Windows package; runs on after the request returns. */
  /** Where to fetch a package, in order: the source asked for (else the one the check read), then the other. */
  function sources(latest, asset, wanted) {
    const first = wanted ?? latest.source ?? 'github'
    return [
      { from: 'github', url: asset.url },
      { from: 'mirror', url: asset.mirrorUrl },
    ]
      .filter(item => item.url && trusted(item.url))
      .sort((a, b) => (b.from === first) - (a.from === first))
  }

  /** @param source - 'github' or 'mirror' to try that one first. */
  async function download({ source } = {}) {
    const reason = notInstallable()
    if (!installs_ || reason) throw failure(400, reason ?? msg`这个版本不能在应用里安装更新`)
    if (UPDATING.includes(job.step)) return status()
    const state = await load()
    const latest = state.latest
    if (!latest || compareVersions(latest.version, version) <= 0) throw failure(400, msg`没有更新的版本`)
    if (staged(state)?.version === latest.version) return status()
    const asset = kind === 'mac' ? latest.assets?.macZip : latest.assets?.zip
    if (!asset) throw failure(400, kind === 'mac' ? msg`这个版本没有这台 Mac 能在应用里安装的更新包，到发布页下载 dmg` : msg`这个版本没有 Windows 安装包`)
    if (!asset.sha256) throw failure(400, asset.hashError)
    const order = sources(latest, asset, ['github', 'mirror'].includes(source) ? source : null)
    if (!order.length) throw failure(400, msg`这个版本没有可信的下载地址`)
    controller = new AbortController()
    job = { step: 'downloading', version: latest.version, from: order[0].from, received: 0, total: asset.size }
    run(latest, asset, order, controller.signal).catch(() => {})
    return status()
  }

  /** One source's copy of the package into `part` → its SHA-256, once it is the published one. */
  async function fetchTo(url, from, part, asset, signal) {
    const cancelled = () => Object.assign(new Error(msg`已取消`), { name: 'AbortError' })
    const res = await get(url, { proxy: proxy(), signal, allowHttp, headers: { accept: 'application/octet-stream', 'user-agent': userAgent } }).catch(error => {
      if (signal.aborted) throw cancelled()
      throw new Error(from === 'mirror' ? msg`连不上国内镜像（${errorCode(error)}）` : networkTrouble(error))
    })
    if (res.statusCode !== 200) {
      res.resume()
      throw new Error(msg`下载失败：${sourceName(from)} 回复 ${res.statusCode}`)
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
      res.on('aborted', () => reject(new Error(msg`下载中断了`)))
      out.on('error', reject)
      out.on('finish', resolve)
      res.pipe(out)
      signal.addEventListener('abort', () => reject(cancelled()), { once: true })
    }).catch(error => {
      res.destroy()
      out.destroy()
      throw error
    })
    job.step = 'verifying'
    const sha256 = hash.digest('hex')
    if (asset.size && job.received !== asset.size) throw new Error(msg`下载不完整（${job.received} / ${asset.size} 字节），再试一次`)
    if (sha256 !== asset.sha256) throw new Error(msg`SHA-256 对不上，已丢弃下载的文件。应为 ${asset.sha256}，实际 ${sha256}`)
    return sha256
  }

  /** Each source in turn until one gives the published file; then unpack it. */
  async function run(latest, asset, order, signal) {
    const folder = await stateFolder()
    const part = path.join(folder, `${asset.name}.part`)
    const zipFile = path.join(folder, asset.name)
    let done
    try {
      const failures = []
      let sha256 = null
      for (const { from, url } of order) {
        job = { ...job, step: 'downloading', from, received: 0 }
        try {
          sha256 = await fetchTo(url, from, part, asset, signal)
          break
        } catch (error) {
          if (error.name === 'AbortError') throw error
          failures.push(order.length > 1 ? msg`${sourceName(from)}：${error.message}` : error.message)
        }
      }
      if (!sha256) throw new Error(failures.join(' / '))
      await rename(part, zipFile)
      job.step = 'unpacking'
      const base = await installBase(root, env, platform)
      const folderPath = kind === 'mac'
        ? await stageMacInstall(zipFile, { base, version: latest.version, check, ...(unpackMac ? { unpack: unpackMac } : {}) })
        : await stageInstall(await readFile(zipFile), { base, version: latest.version, check })
      await save({ staged: { version: latest.version, path: folderPath, sha256 } })
      done = { step: 'ready', version: latest.version }
    } catch (error) {
      done = { step: 'error', version: latest.version, error: error.name === 'AbortError' ? msg`已取消下载` : localize(error.message) }
    } finally {
      controller = null
      await rm(part, { force: true }).catch(() => {})
      await rm(zipFile, { force: true }).catch(() => {})
      // Ready (or failed) once the download is gone, so nothing asking then still finds the zip.
      job = done
    }
  }

  function cancel() {
    controller?.abort()
    return status()
  }

  /** Hand over to bin/update-apply.mjs: it stops this server and starts `target`, or this one again on failure. */
  async function switchTo(target, mode) {
    // A restart now would stop the download or unpacking halfway and leave its files behind (a second one too).
    if (UPDATING.includes(job.step)) throw failure(409, msg`正在下载或安装更新，等这一步做完再切换`)
    if (busy()) throw failure(409, msg`正在生成，等它写完再重启`)
    if (!onShutdown) throw failure(400, msg`这个服务不能从页面重启：关掉控制台窗口，再从桌面图标打开`)
    const from = { path: root, version }
    const folder = await stateFolder()
    await rm(path.join(folder, 'result.json'), { force: true })
    job = { step: 'restarting', version: target.version, mode }
    try {
      await spawnSwitch({ root, from, to: target, mode, relaunch: relaunch(), stateDir: folder, pid: process.pid })
    } catch (error) {
      job = { step: 'error', error: msg`重启没能开始：${error.message}` }
      throw failure(500, job.error)
    }
    setTimeout(onShutdown, 300).unref?.()
    return { ok: true, restarting: true, to: target.version }
  }

  async function apply() {
    const reason = notInstallable()
    if (!installs_ || reason) throw failure(400, reason ?? msg`这个版本不能在应用里安装更新`)
    const ready = staged(await load())
    if (!ready) throw failure(400, msg`还没下载好新版本`)
    return switchTo(ready, 'update')
  }

  async function rollback() {
    if (!installs_ || notInstallable()) throw failure(400, msg`这个版本不能在应用里切换版本`)
    const previous = await previousInstall(root)
    if (!previous) throw failure(400, msg`上一版的文件夹已经不在了`)
    return switchTo(previous, 'rollback')
  }

  /** The other package folders next to this one (and the LOCALAPPDATA fallback). */
  async function installs() {
    if (!installs_ || notInstallable()) return { installs: [] }
    // The Mac app's versions are all in Application Support (beside the app's own folder there is nothing).
    const beside = inAppBundle(root) ? [] : [path.dirname(root)]
    const bases = [...new Set([...beside, await installBase(root, env, platform)])]
    const list = otherInstalls(root, bases)
    const state = await load()
    const keep = staged(state)?.path
    return { installs: list.map(item => ({ ...item, staged: Boolean(keep && path.resolve(keep) === path.resolve(item.path)) })) }
  }

  async function remove(target) {
    const { installs: list } = await installs()
    const item = list.find(i => path.resolve(i.path) === path.resolve(String(target ?? '')))
    if (!item) throw failure(404, msg`没有这个旧版本文件夹`)
    if (UPDATING.includes(job.step)) throw failure(409, msg`正在更新，等一会儿再删`)
    await removeInstall(item.path, { root, dataRoot })
    if (item.staged) {
      await save({ staged: null })
      job = { step: 'idle' }
    }
    return installs()
  }

  /** 清理旧版本: every package folder older than this one, except one downloaded and not used yet. */
  async function clean() {
    if (!installs_ || notInstallable()) throw failure(400, msg`这个版本不能在应用里清理旧版本`)
    if (UPDATING.includes(job.step)) throw failure(409, msg`正在更新，等一会儿再删`)
    const removed = []
    const failed = []
    for (const item of (await installs()).installs) {
      if (item.staged || compareVersions(item.version, version) >= 0) continue
      try {
        await removeInstall(item.path, { root, dataRoot })
        removed.push({ version: item.version, bytes: item.bytes })
      } catch (error) {
        failed.push({ version: item.version, path: item.path, error: error.message })
      }
    }
    return { removed, failed, ...(await installs()) }
  }

  /** 更新完自动清理旧版本: once per update, a little after the switch (CLEAN_AFTER_MS). */
  async function cleanAfterUpdate(state, result) {
    if (state.cleanOld !== true || state.cleaned === result.at || notInstallable()) return
    const wait = CLEAN_AFTER_MS - (now() - Date.parse(result.at))
    if (wait > 0) {
      cleanTimer ??= setTimeout(() => {
        cleanTimer = null
        status().catch(() => {})
      }, wait + 200)
      cleanTimer.unref?.()
      return
    }
    await save({ cleaned: result.at })
    const { removed, failed } = await clean().catch(error => ({ removed: [], failed: [{ error: error.message }] }))
    await save({ lastClean: { at: result.at, removed, failed } })
  }

  async function acknowledge() {
    if (persist && installs_) await rm(path.join(await stateFolder(), 'result.json'), { force: true })
    if (job.step === 'error') job = { step: 'idle' }
    return status()
  }

  async function skip(versionToSkip) {
    await save({ skipped: versionToSkip ? String(versionToSkip) : null })
    return status()
  }

  /** Whether an update is downloading, being set up or switched to (the idle exit waits for it). */
  const working = () => UPDATING.includes(job.step)

  return { kind, status, check: checkNow, settings, download, cancel, apply, rollback, installs, remove, clean, acknowledge, skip, working }
}

/** Start bin/update-apply.mjs from this install, detached, so it outlives this server. */
export function spawnApply({ root, from, to, mode, relaunch, stateDir: folder, pid }) {
  const script = path.join(root, 'bin', 'update-apply.mjs')
  if (!existsSync(script)) return Promise.reject(new Error(msg`缺少 bin/update-apply.mjs`))
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
