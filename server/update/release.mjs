// The latest release on GitHub, in the shape the updater uses. Pure functions:
// the network is in index.mjs.
import { msg } from '../i18n.mjs'
export const REPO = 'Shikasar7/CicaTavern'
export const FEED = `https://api.github.com/repos/${REPO}`

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i

/** "v1.4.0" / "1.4.0-beta.1" → [1, 4, 0, 'beta.1' | null], or null. */
export function parseVersion(text) {
  const m = VERSION.exec(String(text ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null
}

/** Semver order: -1, 0 or 1; a pre-release sorts before its release. Unparsable versions sort first. */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return x ? 1 : y ? -1 : 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  if (x[3] === y[3]) return 0
  if (!x[3]) return 1
  if (!y[3]) return -1
  return x[3] < y[3] ? -1 : 1
}

/**
 * Which package an asset is: 'zip' (Windows), 'apk' (Android), 'mac' (the
 * CicaTavern.app zip for this Mac's processor: -mac-arm64 or -mac-x64) or null.
 */
export function assetKind(name, arch = process.arch) {
  if (/-win-x64\.zip$/i.test(name)) return 'zip'
  if (/-android-arm64\.apk$/i.test(name)) return 'apk'
  const mac = /-mac-(arm64|x64)\.zip$/i.exec(name)
  if (mac) return mac[1].toLowerCase() === arch ? 'mac' : null
  return null
}

const HEX = /\b([a-f0-9]{64})\b/i

/** GitHub's own digest of an uploaded asset ("sha256:<hex>"), or null. */
export function digestHash(asset) {
  const m = /^sha256:([a-f0-9]{64})$/i.exec(String(asset?.digest ?? ''))
  return m ? m[1].toLowerCase() : null
}

/**
 * The SHA-256 the release notes give for a file: a line with the file name
 * and 64 hex digits (the 校验 block: "SHA-256  <hex>  <file>"), or null.
 */
export function notesHash(body, fileName) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (!line.includes(fileName)) continue
    const m = HEX.exec(line)
    if (m) return m[1].toLowerCase()
  }
  return null
}

/**
 * The hash a download must have: every value the release publishes (GitHub's
 * digest, the notes' 校验 block) must agree, and there must be at least one.
 * → { sha256, from: ['github', 'notes'] } or { error }.
 */
export function expectedHash(asset, body) {
  const github = digestHash(asset)
  const notes = notesHash(body, asset.name)
  if (github && notes && github !== notes) return { error: msg`发布页上写的 SHA-256 和 GitHub 算的对不上，不能自动更新。到发布页确认后手动下载。` }
  const sha256 = github ?? notes
  if (!sha256) return { error: msg`这个版本没有公布 SHA-256，不能自动更新。到发布页手动下载。` }
  return { sha256, from: [github && 'github', notes && 'notes'].filter(Boolean) }
}

function isLoopbackUrl(url) {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

/**
 * Only the repository's own release downloads (which GitHub then redirects to
 * its asset host); a local feed in tests may serve its own.
 */
export function trustedDownload(href, { repo = REPO, feed = FEED } = {}) {
  let url
  try {
    url = new URL(href)
  } catch {
    return false
  }
  if (isLoopbackUrl(new URL(feed))) return isLoopbackUrl(url)
  return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith(`/${repo}/releases/download/`)
}

/**
 * GET /releases/latest → { version, tag, name, notes, url, publishedAt, assets: { zip, apk, mac } }.
 * Each asset: { name, size, url, sha256, hashFrom } or { …, hashError }. Drafts
 * and pre-releases never come from /latest; a tag that is not a version is refused.
 * arch: which Mac zip is 'mac' (process.arch).
 */
export function releaseInfo(json, { repo = REPO, feed = FEED, arch = process.arch } = {}) {
  const version = parseVersion(json?.tag_name)
  if (!version) throw new Error(msg`最新发布的标签不是版本号：${String(json?.tag_name ?? msg`（没有）`).slice(0, 40)}`)
  const assets = {}
  for (const asset of Array.isArray(json.assets) ? json.assets : []) {
    const kind = assetKind(String(asset?.name ?? ''), arch)
    if (!kind || assets[kind] || !trustedDownload(asset.browser_download_url, { repo, feed })) continue
    const hash = expectedHash(asset, json.body)
    assets[kind] = {
      name: asset.name,
      size: Number(asset.size) || 0,
      url: asset.browser_download_url,
      ...(hash.error ? { hashError: hash.error } : { sha256: hash.sha256, hashFrom: hash.from }),
    }
  }
  return {
    version: String(json.tag_name).replace(/^v/i, ''),
    tag: String(json.tag_name),
    name: String(json.name ?? json.tag_name),
    notes: String(json.body ?? '').slice(0, 40_000),
    url: typeof json.html_url === 'string' && json.html_url.startsWith('https://github.com/') ? json.html_url : `https://github.com/${repo}/releases/latest`,
    publishedAt: json.published_at ?? null,
    assets,
  }
}
