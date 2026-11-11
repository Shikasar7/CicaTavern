// The latest release on GitHub, in the shape the updater uses. Pure functions:
// the network is in index.mjs.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { msg } from '../i18n.mjs'
export const REPO = 'Shikasar7/CicaTavern'
export const FEED = `https://api.github.com/repos/${REPO}`

/**
 * The mirror for networks that cannot reach GitHub (mainland China, often): a
 * public repository on cnb.cool (Tencent) whose releases carry the same files
 * under the same tags (scripts/release-mirror.mjs). Its links look like GitHub's.
 */
export const MIRROR_REPO = 'cicatavern/CicaTavern'
export const MIRROR = `https://cnb.cool/${MIRROR_REPO}`

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
 * CicaTavern.app disk image or zip for this Mac's processor: -mac-arm64 or
 * -mac-x64) or null.
 */
export function assetKind(name, arch = process.arch) {
  if (/-win-x64\.zip$/i.test(name)) return 'zip'
  if (/-android-arm64\.apk$/i.test(name)) return 'apk'
  const mac = /-mac-(arm64|x64)\.(dmg|zip)$/i.exec(name)
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
 * its asset host) and the mirror's; a local feed in tests may serve its own.
 */
export function trustedDownload(href, { repo = REPO, feed = FEED, mirror = MIRROR } = {}) {
  let url
  try {
    url = new URL(href)
  } catch {
    return false
  }
  if (isLoopbackUrl(new URL(feed))) return isLoopbackUrl(url)
  if (url.protocol !== 'https:') return false
  if (url.hostname === 'github.com' && url.pathname.startsWith(`/${repo}/releases/download/`)) return true
  if (!mirror) return false
  const own = new URL(mirror)
  return url.hostname === own.hostname && url.pathname.startsWith(`${own.pathname}/-/releases/download/`)
}

/** The same release file on the mirror: its name under the same tag. */
export function mirrorDownload(tag, name, mirror = MIRROR) {
  return `${mirror}/-/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
}

/** The small file each release carries (scripts/release-latest.mjs): /releases/latest cut down to what releaseInfo reads. */
export const LATEST_FILE = 'latest.json'

/**
 * latest.json's Ed25519 signature, base64, beside it in each release. The
 * mirror's copy counts only when it holds: nothing else there vouches for the
 * hashes. The private key stays on the machine that publishes releases.
 */
export const SIGNATURE_FILE = `${LATEST_FILE}.sig`
export const LATEST_KEY = 'MCowBQYDK2VwAyEAHr3lw9wQxPdV+zaWjMTqUjIqH3t5BsE6NnMQXb8srBs='

/** latest.json's bytes signed with a PKCS#8 PEM key → the .sig file's text. */
export function signLatest(bytes, privateKeyPem) {
  return sign(null, Buffer.from(bytes), createPrivateKey(privateKeyPem)).toString('base64')
}

/** true when signature (base64) is publicKey's (SPKI DER, base64) signature of exactly these bytes. */
export function verifyLatest(bytes, signature, publicKey = LATEST_KEY) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(bytes), key, Buffer.from(String(signature).trim(), 'base64'))
  } catch {
    return false
  }
}

/** Where the mirror's latest release keeps latest.json (or its signature). */
export function mirrorLatestUrl(mirror = MIRROR, file = LATEST_FILE) {
  return `${mirror}/-/releases/latest/download/${file}`
}

/**
 * Where latest.json is when the API says no: GitHub's latest-release download
 * link, which is not counted against the API's per-address limit. A local test
 * feed serves it itself.
 */
export function latestFileUrl(feed = FEED, repo = REPO) {
  const url = new URL(feed)
  const host = url.hostname === 'api.github.com' ? 'https://github.com' : url.origin
  return `${host}/${repo}/releases/latest/download/${LATEST_FILE}`
}

/** A release from the API (/releases/latest or /releases/tags/…) → latest.json's contents. */
export function latestFile(json) {
  return {
    tag_name: json.tag_name,
    name: json.name,
    body: json.body,
    html_url: json.html_url,
    published_at: json.published_at,
    // Both Mac zips, whichever processor writes the file: each Mac reads its own.
    assets: (Array.isArray(json.assets) ? json.assets : [])
      .filter(asset => ['arm64', 'x64'].some(arch => assetKind(String(asset?.name ?? ''), arch)))
      .map(asset => ({ name: asset.name, size: asset.size, digest: asset.digest ?? null, browser_download_url: asset.browser_download_url })),
  }
}

/**
 * GET /releases/latest (or latest.json) → { version, tag, name, notes, url, publishedAt, source, assets: { zip, apk, mac } }.
 * Each asset: { name, size, url, mirrorUrl, sha256, hashFrom } or { …, hashError };
 * url is GitHub's, mirrorUrl the same file on the mirror (null without one, and for the Mac zip,
 * which the mirror does not carry), made here from the tag and name rather than read from the
 * release. source says where the release was read: 'github', or 'mirror' (its signed latest.json).
 * Drafts and pre-releases never come from /latest; a tag that is not a version is refused.
 * arch: which Mac zip is 'mac' (process.arch).
 */
export function releaseInfo(json, { repo = REPO, feed = FEED, mirror = MIRROR, source = 'github', arch = process.arch } = {}) {
  const version = parseVersion(json?.tag_name)
  if (!version) throw new Error(msg`最新发布的标签不是版本号：${String(json?.tag_name ?? msg`（没有）`).slice(0, 40)}`)
  const tag = String(json.tag_name)
  const assets = {}
  for (const asset of Array.isArray(json.assets) ? json.assets : []) {
    const kind = assetKind(String(asset?.name ?? ''), arch)
    // What the Mac's in-app update unpacks (macPackage): its disk image, or a zip in releases before 2.2.0.
    if (kind === 'mac' && /\.(zip|dmg)$/i.test(String(asset.name)) && !assets.macPackage && trustedDownload(asset.browser_download_url, { repo, feed, mirror: null })) {
      const hash = expectedHash(asset, json.body)
      assets.macPackage = { name: asset.name, size: Number(asset.size) || 0, url: asset.browser_download_url, mirrorUrl: null, ...(hash.error ? { hashError: hash.error } : { sha256: hash.sha256, hashFrom: hash.from }) }
    }
    // A release has the Mac's disk image (what to download) and its zip: the image wins.
    const taken = assets[kind]
    const image = name => /\.dmg$/i.test(String(name))
    if (!kind || (taken && !(kind === 'mac' && image(asset.name) && !image(taken.name)))) continue
    if (!trustedDownload(asset.browser_download_url, { repo, feed, mirror: null })) continue
    const hash = expectedHash(asset, json.body)
    assets[kind] = {
      name: asset.name,
      size: Number(asset.size) || 0,
      url: asset.browser_download_url,
      mirrorUrl: mirror && kind !== 'mac' ? mirrorDownload(tag, asset.name, mirror) : null,
      ...(hash.error ? { hashError: hash.error } : { sha256: hash.sha256, hashFrom: hash.from }),
    }
  }
  return {
    version: tag.replace(/^v/i, ''),
    tag,
    name: String(json.name ?? json.tag_name),
    notes: String(json.body ?? '').slice(0, 40_000),
    url: typeof json.html_url === 'string' && json.html_url.startsWith('https://github.com/') ? json.html_url : `https://github.com/${repo}/releases/latest`,
    mirrorPage: mirror ? `${mirror}/-/releases/tag/${encodeURIComponent(tag)}` : null,
    publishedAt: json.published_at ?? null,
    source,
    assets,
  }
}
