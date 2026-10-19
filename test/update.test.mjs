// 设置 → 更多 → 更新 (server/update/), bin/update-apply.mjs, the launcher's
// forwarding and CicaTavern.exe. GitHub is a local fake; nothing leaves the machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, linkSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { featuresOf } from '../server/edition.mjs'
import { createApp } from '../server/http.mjs'
import { createUpdater } from '../server/update/index.mjs'
import { checkRuntime, createShortcut, freeFolder, isInstall, listShortcuts, otherInstalls, packageFolder, removeInstall, retargetShortcuts, stageInstall, supersededBy } from '../server/update/install.mjs'
import { compareVersions, digestHash, expectedHash, notesHash, releaseInfo, trustedDownload } from '../server/update/release.mjs'
import { extractZip, listZip, safeEntryPath, zipFolder } from '../server/update/zip.mjs'
import { buildLauncher, findVcvars } from '../scripts/build-launcher.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const windows = process.platform === 'win32'
const canBuild = windows && Boolean(findVcvars())
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

// CicaTavern.exe built once for the tests that need the real launcher (MSVC on Windows).
let builtLauncher = null
function launcherExe() {
  builtLauncher ??= mkdtemp(path.join(tmpdir(), 'tavern-exe-')).then(dir => buildLauncher(REPO_ROOT, path.join(dir, 'CicaTavern.exe'), { version: '1.4.0' }))
  return builtLauncher
}
process.on('exit', () => {
  builtLauncher?.then(exe => rmSync(path.dirname(exe), { recursive: true, force: true }), () => {})
})

/**
 * A temporary folder in its long spelling: the temp folder can be an 8.3 path
 * (GitHub's runners: C:\Users\RUNNER~1), and the shell stores shortcut targets long.
 */
async function scratch(t, prefix = 'tavern-update-') {
  const dir = realpathSync.native(await mkdtemp(path.join(tmpdir(), prefix)))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

/** The 8.3 short form of a folder (the same path where the volume keeps none). */
function shortForm(dir) {
  const out = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true })
  return out.trim() || dir
}

/** A package folder as stage-release writes it (the parts the updater checks). */
async function makeInstall(dir, version, files = {}) {
  const put = async (rel, text) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), text)
  }
  await put('edition.json', JSON.stringify({ edition: 'release' }))
  await put('package.json', JSON.stringify({ name: 'cicatavern', version, private: true, type: 'module' }))
  await put('bin/launch.mjs', '')
  await put('bin/start.mjs', '')
  await put('server/http.mjs', '')
  await put('runtime/node.exe', 'not really node')
  await put('CicaTavern.exe', 'not really an exe')
  for (const [rel, text] of Object.entries(files)) await put(rel, text)
  return dir
}

/** The real node.exe at runtime/node.exe (hard link when it can), for installs that must run. */
function realNode(dir) {
  const target = path.join(dir, 'runtime', 'node.exe')
  rmSync(target, { force: true })
  try {
    linkSync(process.execPath, target)
  } catch {
    copyFileSync(process.execPath, target)
  }
}

async function packageZip(t, version, files) {
  const dir = await scratch(t, 'tavern-pkg-')
  const folder = await makeInstall(path.join(dir, packageFolder(version)), version, files)
  return zipFolder(folder)
}

/** A zip with whatever names (stored), for hostile ones. */
function rawZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(text)
    const crc = zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    central.push(entry, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** Every file under a folder with its hash: the data folder before and after. */
function snapshot(dir) {
  const out = {}
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    out[path.relative(dir, file)] = sha256(readFileSync(file))
  }
  return out
}

/**
 * GitHub's API and download host, locally: /releases/latest, the repository's
 * download URL that redirects to the asset, and the asset itself.
 */
async function fakeGitHub(t, release) {
  const hits = { latest: 0, download: 0 }
  let current = release
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`
    if (req.url === '/repos/Shikasar7/CicaTavern/releases/latest') {
      hits.latest++
      const { version, zip, apk, digest, notes } = current
      const zipName = `CicaTavern-${version}-win-x64.zip`
      const assets = []
      if (zip) assets.push({ name: zipName, size: zip.length, digest: digest === undefined ? `sha256:${sha256(zip)}` : digest, browser_download_url: `${base}/Shikasar7/CicaTavern/releases/download/v${version}/${zipName}` })
      if (apk) assets.push({ name: `CicaTavern-${version}-android-arm64.apk`, size: apk.length, digest: `sha256:${sha256(apk)}`, browser_download_url: `${base}/Shikasar7/CicaTavern/releases/download/v${version}/CicaTavern-${version}-android-arm64.apk` })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ tag_name: `v${version}`, name: `CicaTavern ${version}`, body: notes ?? `## 新内容\n\n- 一项改进\n\n## 校验\n\n\`\`\`\nSHA-256  ${zip ? sha256(zip) : ''}  ${zipName}\n\`\`\``, html_url: `${base}/release`, published_at: '2026-10-20T00:00:00Z', assets }))
    }
    if (req.url.startsWith('/Shikasar7/CicaTavern/releases/download/')) {
      res.writeHead(302, { location: `/assets/${path.basename(req.url)}` })
      return res.end()
    }
    if (req.url.startsWith('/assets/')) {
      hits.download++
      const body = req.url.endsWith('.apk') ? current.apk : (current.serve ?? current.zip)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length })
      return res.end(body)
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  return { feed: `http://127.0.0.1:${server.address().port}/repos/Shikasar7/CicaTavern`, hits, set: next => { current = { ...current, ...next } } }
}

/** A release-edition app running from a fake package at <base>/CicaTavern-<version>-win-x64. */
/**
 * @param noticeSeen - the 隐私与网络 notice already confirmed (the daily check
 *   waits for it in the public builds); false for a first start.
 */
async function tavern(t, { version = '1.0.0', feed, edition = 'release', update = {}, root: givenRoot, noticeSeen = true } = {}) {
  const base = await scratch(t)
  const root = givenRoot ?? (await makeInstall(path.join(base, packageFolder(version)), version))
  const dataRoot = path.join(base, 'data')
  const switches = []
  let shutdowns = 0
  const app = createApp({
    dataRoot,
    proxy: 'off',
    edition,
    onShutdown: () => { shutdowns++ },
    update: { root, feed, platform: 'win32', check: async () => 'v24.22.0', spawnSwitch: async args => { switches.push(args) }, ...update },
  })
  const server = await app.listen({ port: 0 })
  if (noticeSeen) await app.store.saveSettings({ privacyNotice: 1 })
  t.after(() => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
  })
  const url = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${url}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const { body } = await call('/api/update')
      if (!['downloading', 'verifying', 'unpacking'].includes(body.job?.step)) return body
      await wait(50)
    }
    throw new Error('the download did not finish')
  }
  return { app, base, root, dataRoot, call, settle, switches, shutdowns: () => shutdowns }
}

// ─── Release parsing ───────────────────────────────────────────────────

test('versions compare as semver; a pre-release comes before its release', () => {
  assert.equal(compareVersions('1.3.1', 'v1.4.0'), -1)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('v2.0.0', '2.0.0'), 0)
  assert.equal(compareVersions('1.4.0-beta.1', '1.4.0'), -1)
  assert.equal(compareVersions('nonsense', '0.0.1'), -1)
  assert.deepEqual(['personal', 'release', 'android'].map(e => featuresOf(e).updates), [null, 'zip', 'apk'])
})

test('the expected SHA-256: GitHub digest and the notes must agree, and one must exist', () => {
  const hex = 'ab'.repeat(32)
  const other = 'cd'.repeat(32)
  const asset = { name: 'CicaTavern-1.4.0-win-x64.zip', digest: `sha256:${hex}` }
  const notes = `## 校验\n\n\`\`\`\nSHA-256  ${hex}  CicaTavern-1.4.0-win-x64.zip\nSHA-256  ${other}  CicaTavern-1.4.0-android-arm64.apk\n\`\`\``
  assert.equal(digestHash(asset), hex)
  assert.equal(notesHash(notes, 'CicaTavern-1.4.0-android-arm64.apk'), other)
  assert.deepEqual(expectedHash(asset, notes), { sha256: hex, from: ['github', 'notes'] })
  assert.deepEqual(expectedHash({ name: asset.name }, notes), { sha256: hex, from: ['notes'] })
  assert.deepEqual(expectedHash(asset, ''), { sha256: hex, from: ['github'] })
  assert.match(expectedHash({ ...asset, digest: `sha256:${other}` }, notes).error, /对不上/)
  assert.match(expectedHash({ name: asset.name }, '').error, /没有公布/)
})

test('release info: only the repository\'s own downloads, one asset of each kind, a version tag', () => {
  const info = releaseInfo({
    tag_name: 'v1.4.0',
    body: '',
    assets: [
      { name: 'CicaTavern-1.4.0-win-x64.zip', size: 5, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: 'https://evil.example/CicaTavern-1.4.0-win-x64.zip' },
      { name: 'CicaTavern-1.4.0-win-x64.zip', size: 7, digest: `sha256:${'b'.repeat(64)}`, browser_download_url: 'https://github.com/Shikasar7/CicaTavern/releases/download/v1.4.0/CicaTavern-1.4.0-win-x64.zip' },
      { name: 'CicaTavern-1.4.0-android-arm64.apk', size: 9, browser_download_url: 'https://github.com/Shikasar7/CicaTavern/releases/download/v1.4.0/CicaTavern-1.4.0-android-arm64.apk' },
      { name: 'notes.txt', size: 1, browser_download_url: 'https://github.com/Shikasar7/CicaTavern/releases/download/v1.4.0/notes.txt' },
    ],
  })
  assert.equal(info.version, '1.4.0')
  assert.equal(info.assets.zip.size, 7, 'the asset on another host is ignored')
  assert.equal(info.assets.zip.sha256, 'b'.repeat(64))
  assert.match(info.assets.apk.hashError, /没有公布/)
  assert.equal(trustedDownload('https://github.com/Other/Repo/releases/download/v1/x.zip'), false)
  assert.equal(trustedDownload('http://github.com/Shikasar7/CicaTavern/releases/download/v1/x.zip'), false)
  assert.throws(() => releaseInfo({ tag_name: 'latest' }), /不是版本号/)
})

// ─── Zip ────────────────────────────────────────────────────────────────

test('zip: what stage-release writes unpacks the same, Chinese names included', async t => {
  const dir = await scratch(t)
  const folder = path.join(dir, 'CicaTavern-1.4.0-win-x64')
  await mkdir(path.join(folder, 'bin'), { recursive: true })
  await writeFile(path.join(folder, '读我 CicaTavern.txt'), 'vbs')
  await writeFile(path.join(folder, 'bin', 'big.txt'), 'x'.repeat(100_000))
  const zip = await zipFolder(folder)
  assert.deepEqual(listZip(zip).map(e => e.name).sort(), ['CicaTavern-1.4.0-win-x64/bin/big.txt', 'CicaTavern-1.4.0-win-x64/读我 CicaTavern.txt'])
  const out = path.join(dir, 'out')
  const { top, files } = await extractZip(zip, out, { top: 'CicaTavern-1.4.0-win-x64' })
  assert.equal(top, 'CicaTavern-1.4.0-win-x64')
  assert.equal(files, 2)
  assert.equal(await readFile(path.join(out, '读我 CicaTavern.txt'), 'utf8'), 'vbs')
  assert.equal((await readFile(path.join(out, 'bin', 'big.txt'), 'utf8')).length, 100_000)
  await assert.rejects(extractZip(zip, path.join(dir, 'other'), { top: 'CicaTavern-9.9.9-win-x64' }), /顶层文件夹/)
  // A flipped byte in the first file's compressed data.
  const [first] = listZip(zip)
  const bad = Buffer.from(zip)
  bad[first.offset + 30 + Buffer.byteLength(first.name) + 4] ^= 0xff
  await assert.rejects(extractZip(bad, path.join(dir, 'bad')), /更新包损坏/)
})

test('zip: names that would write outside the folder are refused before anything is written', async t => {
  const dir = await scratch(t)
  for (const name of ['../evil.txt', 'top/../../evil.txt', '/abs/evil.txt', 'C:/evil.txt', 'top/C:evil', 'top\\..\\..\\evil.txt']) {
    assert.throws(() => safeEntryPath(name), /不安全/, name)
    const out = path.join(dir, 'out')
    await assert.rejects(extractZip(rawZip([['top/ok.txt', 'ok'], [name, 'evil']]), out), /不安全|顶层/, name)
    assert.equal(existsSync(path.join(dir, 'evil.txt')), false)
  }
  await assert.rejects(extractZip(rawZip([['a/x', '1'], ['b/y', '2']]), path.join(dir, 'two')), /只有一个文件夹/)
})

// ─── Install folders ───────────────────────────────────────────────────

test('stageInstall: unpacks beside, checks edition, version and the bundled Node, leaves nothing on failure', async t => {
  const base = await scratch(t)
  const zip = await packageZip(t, '1.4.0')
  let checked = null
  const folder = await stageInstall(zip, { base, version: '1.4.0', check: async exe => { checked = exe } })
  assert.equal(folder, path.join(base, 'CicaTavern-1.4.0-win-x64'))
  assert.ok(isInstall(folder))
  assert.equal(checked, path.join(path.dirname(checked), 'node.exe'))
  // Taken: the next one gets a suffix instead of mixing into it.
  assert.equal(freeFolder(base, 'CicaTavern-1.4.0-win-x64'), path.join(base, 'CicaTavern-1.4.0-win-x64-2'))
  await assert.rejects(stageInstall(zip, { base, version: '1.5.0', check: async () => {} }), /顶层文件夹/)
  await assert.rejects(stageInstall(zip, { base, version: '1.4.0', check: async () => { throw new Error('杀毒软件') } }), /杀毒软件/)
  const wrong = await packageZip(t, '1.4.0', { 'package.json': JSON.stringify({ version: '1.3.9' }) })
  await assert.rejects(stageInstall(wrong, { base, version: '1.4.0', check: async () => {} }), /不是 1.4.0/)
  const notRelease = await packageZip(t, '1.4.0', { 'edition.json': JSON.stringify({ edition: 'personal' }) })
  await assert.rejects(stageInstall(notRelease, { base, version: '1.4.0', check: async () => {} }), /不是 Windows 发布版/)
  assert.deepEqual(readdirSync(base).sort(), ['CicaTavern-1.4.0-win-x64'], 'no .partial folders left behind')
})

test('the unpacked programs are checked by reading them, never by running them', async t => {
  const base = await scratch(t)
  const dir = await makeInstall(path.join(base, 'pkg'), '1.4.0', { 'runtime/node.exe': 'MZ fake', 'CicaTavern.exe': 'MZ fake' })
  await checkRuntime(path.join(dir, 'runtime', 'node.exe'))
  await writeFile(path.join(dir, 'CicaTavern.exe'), 'broken')
  await assert.rejects(checkRuntime(path.join(dir, 'runtime', 'node.exe')), /CicaTavern\.exe 不完整/)
  await rm(path.join(dir, 'runtime', 'node.exe'))
  await assert.rejects(checkRuntime(path.join(dir, 'runtime', 'node.exe')), /node\.exe 读不了.*杀毒软件/)
})

test('shortcuts through CicaTavern.exe: made, listed, and moved only where the old folder is a whole path', { skip: !canBuild }, async t => {
  const base = await scratch(t)
  const exe = await launcherExe()
  const from = path.join(base, 'CicaTavern-1.3.1-win-x64')
  const backup = path.join(base, 'CicaTavern-1.3.1-win-x64-backup')
  const to = path.join(base, 'CicaTavern-1.4.0-win-x64')
  const ours = path.join(base, 'links-ours')
  const other = path.join(base, 'links-other')
  for (const dir of [from, backup, ours, other]) await mkdir(dir)
  await cp(exe, path.join(from, 'CicaTavern.exe'))
  await cp(exe, path.join(backup, 'CicaTavern.exe'))
  assert.equal(await createShortcut(path.join(from, 'CicaTavern.exe'), { folder: ours }), path.join(ours, 'CicaTavern.lnk'))
  await createShortcut(path.join(backup, 'CicaTavern.exe'), { folder: other })
  const [made] = await listShortcuts({ exe, folders: [ours] })
  assert.deepEqual([made.target, made.dir, made.icon], [path.join(from, 'CicaTavern.exe'), from, `${path.join(from, 'CicaTavern.exe')},0`])
  // Any case, as Windows paths are.
  const changed = await retargetShortcuts(from.toUpperCase(), to, { exe: path.join(from, 'CicaTavern.exe'), folders: [ours, other] })
  assert.deepEqual(changed, [path.join(ours, 'CicaTavern.lnk')])
  const [moved] = await listShortcuts({ exe, folders: [ours] })
  assert.deepEqual([moved.target, moved.dir, moved.icon], [path.join(to, 'CicaTavern.exe'), to, `${path.join(to, 'CicaTavern.exe')},0`])
  const [untouched] = await listShortcuts({ exe, folders: [other] })
  assert.equal(untouched.target, path.join(backup, 'CicaTavern.exe'), 'the -backup folder is another folder')
})

test('shortcuts move when the old folder is named in its 8.3 short form', { skip: !canBuild }, async t => {
  const base = await scratch(t)
  const exe = await launcherExe()
  const from = path.join(base, 'CicaTavern-1.3.1-win-x64')
  const to = path.join(base, 'CicaTavern-1.4.0-win-x64')
  const links = path.join(base, 'links')
  for (const dir of [from, to, links]) await mkdir(dir)
  await cp(exe, path.join(from, 'CicaTavern.exe'))
  // Made through the short form: the shell stores the target long, the start folder and icon as given.
  const short = shortForm(from)
  await createShortcut(path.join(short, 'CicaTavern.exe'), { folder: links })
  assert.deepEqual(await retargetShortcuts(short, to, { exe: path.join(from, 'CicaTavern.exe'), folders: [links] }), [path.join(links, 'CicaTavern.lnk')])
  const [moved] = await listShortcuts({ exe, folders: [links] })
  assert.deepEqual([moved.target, moved.dir, moved.icon], [path.join(to, 'CicaTavern.exe'), to, `${path.join(to, 'CicaTavern.exe')},0`])
})

test('the updater compares install folders in their long spelling', async t => {
  const base = await scratch(t)
  const root = await makeInstall(path.join(base, 'CicaTavern-1.4.0-win-x64'), '1.4.0')
  const updater = createUpdater({ features: featuresOf('release'), root: windows ? shortForm(root) : root, platform: 'win32' })
  assert.equal((await updater.status()).root, root)
  assert.deepEqual((await updater.installs()).installs, [], 'the running install is never listed as an old one')
})

test('old folders: listed beside the running one; never the running one or one holding the data', async t => {
  const base = await scratch(t)
  const current = await makeInstall(path.join(base, 'CicaTavern-1.4.0-win-x64'), '1.4.0')
  const old = await makeInstall(path.join(base, 'CicaTavern-1.3.1-win-x64'), '1.3.1')
  const holdsData = await makeInstall(path.join(base, 'CicaTavern-1.2.0-win-x64'), '1.2.0')
  await mkdir(path.join(base, 'unrelated'))
  const list = otherInstalls(current, [base])
  assert.deepEqual(list.map(i => i.version).sort(), ['1.2.0', '1.3.1'])
  assert.ok(list.every(i => i.bytes > 0))
  await assert.rejects(removeInstall(current, { root: current }), /正在运行/)
  await assert.rejects(removeInstall(holdsData, { root: current, dataRoot: path.join(holdsData, 'data') }), /数据目录/)
  await assert.rejects(removeInstall(path.join(base, 'unrelated'), { root: current }), /不是 CicaTavern/)
  await removeInstall(old, { root: current, dataRoot: path.join(base, 'data') })
  assert.equal(existsSync(old), false)
  assert.ok(existsSync(holdsData))
})

// ─── The updater through the app ────────────────────────────────────────

test('update: checks once a day by itself, downloads, verifies, unpacks beside; the data folder is untouched', async t => {
  const zip = await packageZip(t, '1.1.0')
  const github = await fakeGitHub(t, { version: '1.1.0', zip })
  let clock = Date.parse('2026-10-20T08:00:00Z')
  const { call, settle, base, root, dataRoot, switches, shutdowns } = await tavern(t, { feed: github.feed, update: { now: () => clock } })
  await writeFile(path.join(dataRoot, 'settings.json'), JSON.stringify({ model: 'x/y', privacyNotice: 1 }))
  const before = snapshot(dataRoot)

  let status = (await call('/api/update?auto=1')).body
  assert.equal(status.enabled, true)
  assert.equal(status.kind, 'zip')
  assert.equal(status.version, '1.0.0')
  assert.equal(status.installable, true)
  assert.equal(status.local, true)
  assert.equal(status.newer, true)
  assert.equal(status.latest.version, '1.1.0')
  assert.equal(status.latest.assets.zip.sha256, sha256(zip))
  assert.match(status.latest.notes, /一项改进/)
  await call('/api/update?auto=1')
  assert.equal(github.hits.latest, 1, 'not again the same day')
  clock += 25 * 60 * 60 * 1000
  await call('/api/update?auto=1')
  assert.equal(github.hits.latest, 2, 'again the next day')
  await call('/api/update/settings', { method: 'PUT', body: { autoCheck: false } })
  clock += 25 * 60 * 60 * 1000
  status = (await call('/api/update?auto=1')).body
  assert.equal(status.autoCheck, false)
  assert.equal(github.hits.latest, 2, 'no check by itself when switched off')
  await call('/api/update/check', { method: 'POST', body: {} })
  assert.equal(github.hits.latest, 3, '检查更新 always asks')

  await call('/api/update/download', { method: 'POST', body: {} })
  status = await settle()
  assert.equal(status.job.step, 'ready', status.job.error)
  assert.equal(github.hits.download, 1)
  const staged = path.join(base, 'CicaTavern-1.1.0-win-x64')
  assert.equal(status.ready.path, staged)
  assert.ok(isInstall(staged))
  assert.deepEqual(readdirSync(path.join(root, 'update')).sort(), ['state.json'], 'the zip is gone once unpacked')

  const applied = await call('/api/update/apply', { method: 'POST', body: {} })
  assert.equal(applied.status, 200)
  assert.deepEqual(applied.body.to, '1.1.0')
  assert.equal(switches.length, 1)
  assert.equal(switches[0].to.path, staged)
  assert.equal(switches[0].from.path, root)
  assert.equal(switches[0].mode, 'update')
  assert.equal(switches[0].relaunch.data, dataRoot)
  assert.equal(switches[0].relaunch.edition, 'release')
  assert.equal(switches[0].relaunch.idleExit, 60)
  await wait(400)
  assert.equal(shutdowns(), 1, 'the old server stops once the switch has started')
  assert.deepEqual(snapshot(dataRoot), before, 'nothing in the data folder changed')
})

test('update: a download whose SHA-256 is off is thrown away, and nothing is unpacked', async t => {
  const zip = await packageZip(t, '1.1.0')
  const github = await fakeGitHub(t, { version: '1.1.0', zip })
  const { call, settle, base, root } = await tavern(t, { feed: github.feed })
  await call('/api/update/check', { method: 'POST', body: {} })
  const tampered = Buffer.from(zip)
  tampered[tampered.length - 30] ^= 1
  github.set({ serve: tampered })
  await call('/api/update/download', { method: 'POST', body: {} })
  const status = await settle()
  assert.equal(status.job.step, 'error')
  assert.match(status.job.error, /SHA-256 对不上/)
  assert.deepEqual(readdirSync(base).filter(n => n !== 'data').sort(), [path.basename(root)], 'nothing new beside the install')
  assert.deepEqual(readdirSync(path.join(root, 'update')), ['state.json'], 'the download is deleted')
  assert.equal((await call('/api/update/apply', { method: 'POST', body: {} })).status, 400)
})

test('update: no published hash, or two that disagree: no download at all', async t => {
  const zip = await packageZip(t, '1.1.0')
  const github = await fakeGitHub(t, { version: '1.1.0', zip, digest: null, notes: '没有校验段' })
  const { call } = await tavern(t, { feed: github.feed })
  let status = (await call('/api/update/check', { method: 'POST', body: {} })).body
  assert.match(status.latest.assets.zip.hashError, /没有公布/)
  let res = await call('/api/update/download', { method: 'POST', body: {} })
  assert.equal(res.status, 400)
  assert.equal(github.hits.download, 0)
  github.set({ digest: `sha256:${'0'.repeat(64)}`, notes: undefined })
  status = (await call('/api/update/check', { method: 'POST', body: {} })).body
  assert.match(status.latest.assets.zip.hashError, /对不上/)
  res = await call('/api/update/download', { method: 'POST', body: {} })
  assert.equal(res.status, 400)
  assert.equal(github.hits.download, 0)
})

test('update: the same version or an older one is not offered', async t => {
  const github = await fakeGitHub(t, { version: '1.0.0', zip: await packageZip(t, '1.0.0') })
  const { call } = await tavern(t, { feed: github.feed })
  const status = (await call('/api/update/check', { method: 'POST', body: {} })).body
  assert.equal(status.newer, false)
  assert.equal((await call('/api/update/download', { method: 'POST', body: {} })).status, 400)
})

test('update: from a source checkout it checks but does not install; the personal install has none', async t => {
  const github = await fakeGitHub(t, { version: '1.1.0', zip: await packageZip(t, '1.1.0') })
  const base = await scratch(t)
  const checkout = path.join(base, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({ version: '1.0.0' }))
  const { call } = await tavern(t, { feed: github.feed, root: checkout })
  const status = (await call('/api/update/check', { method: 'POST', body: {} })).body
  assert.equal(status.newer, true)
  assert.equal(status.installable, false)
  assert.match(status.reason, /源码/)
  assert.equal((await call('/api/update/download', { method: 'POST', body: {} })).status, 400)
  assert.equal(existsSync(path.join(checkout, 'update')), false, 'nothing written into the checkout')

  const personal = await tavern(t, { feed: github.feed, edition: 'personal' })
  assert.deepEqual((await personal.call('/api/update')).body, { enabled: false, local: true })
})

test('update: the phone app gets the APK link; it does not download anything itself', async t => {
  const apk = Buffer.from('apk bytes')
  const github = await fakeGitHub(t, { version: '1.1.0', zip: await packageZip(t, '1.1.0'), apk })
  const { call } = await tavern(t, { feed: github.feed, edition: 'android', update: { platform: 'android' } })
  const status = (await call('/api/update/check', { method: 'POST', body: {} })).body
  assert.equal(status.kind, 'apk')
  assert.equal(status.newer, true)
  assert.match(status.latest.assets.apk.url, /\/releases\/download\/v1\.1\.0\/CicaTavern-1\.1\.0-android-arm64\.apk$/)
  assert.equal((await call('/api/update/download', { method: 'POST', body: {} })).status, 400)
  assert.equal(github.hits.download, 0)
})

test('update: checking GitHub goes through 设置 → 网络代理', async t => {
  const seen = []
  const proxy = net.createServer(socket => {
    socket.once('data', chunk => {
      seen.push(chunk.toString('latin1').split('\r\n')[0])
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    })
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => proxy.close())
  const updater = createUpdater({ features: featuresOf('release'), root: await scratch(t), proxy: () => `http://127.0.0.1:${proxy.address().port}` })
  await assert.rejects(updater.check({ force: true }), /GitHub|代理/)
  assert.deepEqual(seen, ['CONNECT api.github.com:443 HTTP/1.1'])
})

test('update: no restart while a turn is being written', async t => {
  const zip = await packageZip(t, '1.1.0')
  const github = await fakeGitHub(t, { version: '1.1.0', zip })
  const base = await scratch(t)
  const root = await makeInstall(path.join(base, packageFolder('1.0.0')), '1.0.0')
  let busy = true
  const switches = []
  const updater = createUpdater({ features: featuresOf('release'), root, feed: github.feed, platform: 'win32', check: async () => {}, busy: () => busy, onShutdown: () => {}, spawnSwitch: async args => { switches.push(args) } })
  await updater.check({ force: true })
  await updater.download()
  for (let i = 0; i < 100 && (await updater.status()).job.step !== 'ready'; i++) await wait(50)
  await assert.rejects(updater.apply(), /正在生成/)
  busy = false
  await updater.apply()
  assert.equal(switches.length, 1)
})

// ─── The switch-over (bin/update-apply.mjs) ─────────────────────────────

/** A package that really starts: bin/start.mjs answers /api/health with its version (or exits at once). */
async function runnableInstall(dir, version, { broken = false } = {}) {
  const start = broken
    ? 'process.exit(1)\n'
    : `import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
writeFileSync(new URL('../server.pid', import.meta.url), String(process.pid))
writeFileSync(new URL('../server.args', import.meta.url), JSON.stringify(args))
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, app: 'agent-tavern', version, edition: 'release' }))
}).listen(port, '127.0.0.1')
`
  await makeInstall(dir, version, { 'bin/start.mjs': start })
  realNode(dir)
  return dir
}

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function killPidFile(dir) {
  try {
    process.kill(Number(readFileSync(path.join(dir, 'server.pid'), 'utf8')))
  } catch {
    // Not running.
  }
}

/**
 * Start A's server, run the switch to B the way the app does, stop A as
 * onShutdown would. A has the real CicaTavern.exe, which moves the shortcut.
 */
async function runSwitch(t, { broken = false, mode = 'update' } = {}) {
  const base = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'tavern-switch-')))
  const a = await runnableInstall(path.join(base, packageFolder('1.0.0')), '1.0.0')
  const b = await runnableInstall(path.join(base, packageFolder('1.1.0')), '1.1.0', { broken })
  const data = path.join(base, 'data')
  const links = path.join(base, 'links')
  await mkdir(links)
  await cp(await launcherExe(), path.join(a, 'CicaTavern.exe'))
  await createShortcut(path.join(a, 'CicaTavern.exe'), { folder: links })
  await mkdir(path.join(a, 'update'))
  await writeFile(path.join(a, 'update', 'state.json'), JSON.stringify({ autoCheck: false, checkedAt: 123, latest: { version: '1.1.0' }, staged: { version: '1.1.0', path: b } }))
  if (mode === 'rollback') {
    // B (the target) was replaced by A earlier.
    await mkdir(path.join(b, 'update'))
    await writeFile(path.join(b, 'update', 'superseded.json'), JSON.stringify({ path: a, version: '1.0.0' }))
  }
  const port = await freePort()
  const server = spawn(path.join(a, 'runtime', 'node.exe'), [path.join(a, 'bin', 'start.mjs'), '--port', String(port)], { stdio: 'ignore' })
  // The servers run from these folders: stop them before deleting.
  t.after(async () => {
    server.kill()
    killPidFile(a)
    killPidFile(b)
    await wait(500)
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  for (let i = 0; i < 50 && !existsSync(path.join(a, 'server.pid')); i++) await wait(100)
  const watchdog = spawn(process.execPath, [
    path.join(REPO_ROOT, 'bin', 'update-apply.mjs'),
    '--from', a, '--to', b, '--version', '1.1.0', '--from-version', '1.0.0', '--mode', mode,
    '--pid', String(server.pid), '--state', path.join(a, 'update'), '--timeout', '10',
    '--relaunch-port', String(port), '--relaunch-data', data, '--relaunch-edition', 'release', '--relaunch-idleExit', '60',
  ], { stdio: 'ignore', env: { ...process.env, CICATAVERN_SHORTCUT_DIRS: links } })
  const exited = new Promise(resolve => watchdog.on('exit', code => resolve(code)))
  await wait(300)
  server.kill() // what onShutdown does
  let timer
  const code = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 40_000) })])
  clearTimeout(timer)
  return { a, b, port, links, code }
}

test('switch-over: the new version starts, then the shortcuts and the old folder point at it', { skip: !canBuild }, async t => {
  const { a, b, port, links, code } = await runSwitch(t)
  assert.equal(code, 0)
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()
  assert.equal(health.version, '1.1.0')
  assert.deepEqual(JSON.parse(readFileSync(path.join(b, 'server.args'), 'utf8')).slice(0, 6), ['--port', String(port), '--edition', 'release', '--idle-exit', '60'])
  assert.equal(supersededBy(a)?.path, b, 'double-clicking the old folder now opens the new one')
  assert.equal(JSON.parse(readFileSync(path.join(b, 'update', 'previous.json'), 'utf8')).path, a)
  const result = JSON.parse(readFileSync(path.join(b, 'update', 'result.json'), 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.shortcuts, 1)
  const carried = JSON.parse(readFileSync(path.join(b, 'update', 'state.json'), 'utf8'))
  assert.equal(carried.autoCheck, false, '自动检查更新 carries over')
  const [link] = await listShortcuts({ exe: await launcherExe(), folders: [links] })
  assert.equal(link.target.toLowerCase(), path.join(b, 'CicaTavern.exe').toLowerCase())
})

test('switch-over: when the new version does not start, the old one runs again and nothing moved', { skip: !canBuild }, async t => {
  const { a, b, port, links, code } = await runSwitch(t, { broken: true })
  assert.equal(code, 1)
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()
  assert.equal(health.version, '1.0.0')
  assert.equal(supersededBy(a), null)
  assert.equal(existsSync(path.join(b, 'update', 'previous.json')), false)
  const result = JSON.parse(readFileSync(path.join(a, 'update', 'result.json'), 'utf8'))
  assert.equal(result.ok, false)
  assert.match(result.error, /1\.1\.0 没能启动，已回到 1\.0\.0/)
  assert.equal(JSON.parse(readFileSync(path.join(a, 'update', 'state.json'), 'utf8')).staged, null, 'the failed version is no longer offered')
  const [link] = await listShortcuts({ exe: await launcherExe(), folders: [links] })
  assert.equal(link.target.toLowerCase(), path.join(a, 'CicaTavern.exe').toLowerCase())
})

test('switch-over back to an older folder: it stops forwarding, and its daily check skips the newer one', { skip: !canBuild }, async t => {
  const { a, b, code } = await runSwitch(t, { mode: 'rollback' })
  assert.equal(code, 0)
  assert.equal(supersededBy(b), null, 'the folder switched to no longer forwards')
  assert.equal(supersededBy(a)?.path, b)
  assert.equal(JSON.parse(readFileSync(path.join(b, 'update', 'state.json'), 'utf8')).skipped, '1.0.0')
  assert.equal(JSON.parse(readFileSync(path.join(b, 'update', 'result.json'), 'utf8')).mode, 'rollback')
})

// ─── Launchers ──────────────────────────────────────────────────────────

test('launch.mjs in a replaced folder hands over to the newer one, arguments and all', async t => {
  const base = await scratch(t)
  const a = path.join(base, 'old')
  for (const rel of ['bin/launch.mjs', 'server/app-window.mjs', 'server/edition.mjs', 'server/store.mjs', 'server/proxy.mjs', 'web/shared/basic.js', 'server/update/install.mjs', 'server/update/zip.mjs']) {
    await cp(path.join(REPO_ROOT, rel), path.join(a, rel))
  }
  const b = await makeInstall(path.join(base, 'new'), '1.1.0', {
    'bin/launch.mjs': "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('../forwarded.json', import.meta.url), JSON.stringify(process.argv.slice(2)))\n",
  })
  realNode(b)
  await mkdir(path.join(a, 'update'))
  await writeFile(path.join(a, 'update', 'superseded.json'), JSON.stringify({ path: b, version: '1.1.0' }))
  execFileSync(process.execPath, [path.join(a, 'bin', 'launch.mjs'), '--port', '9', '--data', 'D:\\x y', '--no-window'])
  assert.deepEqual(JSON.parse(readFileSync(path.join(b, 'forwarded.json'), 'utf8')), ['--port', '9', '--data', 'D:\\x y', '--no-window', '--no-forward'])
})

const FAKE_LAUNCH = "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('../args.json', import.meta.url), JSON.stringify({ args: process.argv.slice(2), node: process.execPath }))\nif (process.argv.includes('--fail')) { console.error('CicaTavern没能启动。日志：x'); process.exit(3) }\n"

test('CicaTavern.exe runs runtime\\node.exe bin\\launch.mjs with its arguments and reports a failure', { skip: !canBuild }, async t => {
  const dir = await scratch(t)
  await makeInstall(dir, '1.4.0', { 'bin/launch.mjs': FAKE_LAUNCH })
  const exe = path.join(dir, 'CicaTavern.exe')
  await cp(await launcherExe(), exe)
  realNode(dir)
  const env = { ...process.env, CICATAVERN_LAUNCHER_QUIET: '1' }
  execFileSync(exe, ['--port', '8800', '--data', 'D:\\有 空格\\', 'a"b'], { env })
  const ran = JSON.parse(readFileSync(path.join(dir, 'args.json'), 'utf8'))
  assert.deepEqual(ran.args, ['--port', '8800', '--data', 'D:\\有 空格\\', 'a"b'])
  assert.equal(ran.node.toLowerCase(), path.join(dir, 'runtime', 'node.exe').toLowerCase(), 'the package\'s own Node')
  let failure = null
  try {
    execFileSync(exe, ['--fail'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    failure = error
  }
  assert.equal(failure?.status, 1)
  assert.match(failure.stderr.toString('utf8'), /CicaTavern没能启动/)
  await rm(path.join(dir, 'runtime', 'node.exe'))
  assert.throws(() => execFileSync(exe, [], { env, stdio: ['ignore', 'ignore', 'pipe'] }), error => /runtime\\node\.exe/.test(error.stderr.toString('utf8')), 'a package never falls back to another Node')
})

test('CicaTavern.exe in a source checkout uses the node.exe on PATH', { skip: !canBuild }, async t => {
  const dir = await scratch(t)
  await mkdir(path.join(dir, 'bin'))
  await writeFile(path.join(dir, 'bin', 'launch.mjs'), FAKE_LAUNCH)
  await cp(await launcherExe(), path.join(dir, 'CicaTavern.exe'))
  const env = { ...process.env, CICATAVERN_LAUNCHER_QUIET: '1', PATH: `${path.dirname(process.execPath)};${process.env.PATH}` }
  execFileSync(path.join(dir, 'CicaTavern.exe'), ['--no-window'], { env })
  const ran = JSON.parse(readFileSync(path.join(dir, 'args.json'), 'utf8'))
  assert.deepEqual(ran.args, ['--no-window'])
  assert.equal(path.basename(ran.node).toLowerCase(), 'node.exe')
})
