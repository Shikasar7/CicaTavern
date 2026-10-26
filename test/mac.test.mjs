// The macOS build: the staged tree inside CicaTavern.app (scripts/stage-release.mjs
// --platform mac), the check-only updater, and the system proxy from scutil.
// Nothing here needs a Mac: the darwin Node is a dummy and scutil's output is canned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { featuresOf } from '../server/edition.mjs'
import { parseMacProxy, createProxy } from '../server/proxy.mjs'
import { createUpdater } from '../server/update/index.mjs'
import { inAppBundle, installBase, stateDir, userAppData } from '../server/update/install.mjs'
import { assetKind, latestFile, releaseInfo } from '../server/update/release.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version

async function scratch(t, prefix = 'tavern-mac-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

/** What the official darwin tarball unpacks to, with a stand-in for bin/node: a Mach-O header for `arch`. */
async function fakeDarwinNode(dir, arch, version = '24.22.0') {
  const top = path.join(dir, `node-v${version}-darwin-${arch}`)
  const [major, minor, patch] = version.split('.')
  await mkdir(path.join(top, 'bin'), { recursive: true })
  await mkdir(path.join(top, 'include', 'node'), { recursive: true })
  const head = Buffer.alloc(64)
  head.writeUInt32LE(0xfeedfacf, 0)
  head.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  await writeFile(path.join(top, 'bin', 'node'), head)
  await writeFile(path.join(top, 'LICENSE'), 'Node.js is licensed for use as follows: (the tarball\'s LICENSE)\n')
  await writeFile(path.join(top, 'include', 'node', 'node_version.h'), `#ifndef SRC_NODE_VERSION_H_\n#define SRC_NODE_VERSION_H_\n\n#define NODE_MAJOR_VERSION ${major}\n#define NODE_MINOR_VERSION ${minor}\n#define NODE_PATCH_VERSION ${patch}\n\n#define NODE_VERSION_IS_LTS 1\n`)
  return path.join(top, 'bin', 'node')
}

function stage(args) {
  return execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'stage-release.mjs'), ...args], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// ─── Staging ────────────────────────────────────────────────────────────

test('stage-release --platform mac: runtime/node, no exe or .cmd, no zip; the notices name runtime/node', async t => {
  const dir = await scratch(t)
  const node = await fakeDarwinNode(dir, 'arm64')
  const out = path.join(dir, 'dist', `CicaTavern-${VERSION}-mac-arm64`)
  stage(['--platform', 'mac', '--arch', 'arm64', '--node', node, '--out', out])

  assert.deepEqual(readFileSync(path.join(out, 'runtime', 'node')), readFileSync(node), 'the darwin Node as it came')
  if (process.platform !== 'win32') assert.equal(statSync(path.join(out, 'runtime', 'node')).mode & 0o111, 0o111, 'runtime/node is executable')
  assert.match(readFileSync(path.join(out, 'runtime', 'LICENSE'), 'utf8'), /the tarball's LICENSE/, 'LICENSE from one folder up from bin/node')
  const notices = readFileSync(path.join(out, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  assert.match(notices, /^## Node\.js v24\.22\.0 \(runtime\/node\)$/m)
  assert.doesNotMatch(notices, /node\.exe/)
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'edition.json'), 'utf8')), { edition: 'release' })
  assert.equal(JSON.parse(readFileSync(path.join(out, 'package.json'), 'utf8')).version, VERSION)
  for (const file of ['bin/launch.mjs', 'bin/start.mjs', 'server/http.mjs', 'web/index.html', 'node_modules/yaml/package.json']) assert.ok(existsSync(path.join(out, file)), file)

  const top = readdirSync(out)
  assert.deepEqual(top.filter(name => /\.(exe|cmd|bat)$/i.test(name)), [], 'nothing for Windows')
  assert.equal(existsSync(path.join(out, 'runtime', 'node.exe')), false)
  assert.ok(!top.includes('launcher'), 'the Swift launcher is built by the workflow, not shipped as source')
  assert.equal(existsSync(`${out}.zip`), false, 'the workflow packs the .app with ditto')
  assert.deepEqual(readdirSync(path.join(dir, 'dist')), [path.basename(out)])
})

test('stage-release --platform mac: refuses a Node for the other processor, a zip, and a missing --arch', async t => {
  const dir = await scratch(t)
  const x64 = await fakeDarwinNode(dir, 'x64')
  const out = path.join(dir, `CicaTavern-${VERSION}-mac-arm64`)
  assert.throws(() => stage(['--platform', 'mac', '--arch', 'arm64', '--node', x64, '--out', out]), error => /不是 arm64 的 Node/.test(error.stderr))
  assert.throws(() => stage(['--platform', 'mac', '--arch', 'arm64', '--node', x64, '--out', out, '--zip']), error => /ditto/.test(error.stderr))
  assert.throws(() => stage(['--platform', 'mac', '--node', x64, '--out', out]), error => /--arch/.test(error.stderr))
  assert.throws(() => stage(['--platform', 'linux', '--out', out]), error => /--platform/.test(error.stderr))
  // The x64 one where it belongs; --node-version stands in for the header.
  await rm(path.join(path.dirname(path.dirname(x64)), 'include'), { recursive: true })
  const ok = path.join(dir, `CicaTavern-${VERSION}-mac-x64`)
  assert.throws(() => stage(['--platform', 'mac', '--arch', 'x64', '--node', x64, '--out', ok]), error => /--node-version/.test(error.stderr))
  stage(['--platform', 'mac', '--arch', 'x64', '--node', x64, '--node-version', '24.22.0', '--out', ok])
  assert.match(readFileSync(path.join(ok, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /## Node\.js v24\.22\.0 \(runtime\/node\)/)
})

// ─── Updates: check only ────────────────────────────────────────────────

test('the release on macOS checks for updates but does not install them', () => {
  assert.equal(featuresOf('release', 'darwin').updates, 'mac')
  assert.equal(featuresOf('release', 'win32').updates, 'zip')
  assert.equal(featuresOf('personal', 'darwin').updates, null, 'a git checkout on a Mac has no updater')
  assert.equal(featuresOf('android', 'darwin').updates, 'apk')
})

test('the Mac zip for this processor is the "mac" asset; the other one is ignored', () => {
  assert.equal(assetKind('CicaTavern-1.8.0-mac-arm64.zip', 'arm64'), 'mac')
  assert.equal(assetKind('CicaTavern-1.8.0-mac-x64.zip', 'arm64'), null)
  assert.equal(assetKind('CicaTavern-1.8.0-mac-x64.zip', 'x64'), 'mac')
  assert.equal(assetKind('CicaTavern-1.8.0-win-x64.zip', 'arm64'), 'zip')
  const hex = arch => (arch === 'arm64' ? 'a' : 'b').repeat(64)
  const json = {
    tag_name: 'v1.8.0',
    body: `## 校验\n\n\`\`\`\nSHA-256  ${hex('arm64')}  CicaTavern-1.8.0-mac-arm64.zip\nSHA-256  ${hex('x64')}  CicaTavern-1.8.0-mac-x64.zip\n\`\`\``,
    assets: ['x64', 'arm64'].map(arch => ({ name: `CicaTavern-1.8.0-mac-${arch}.zip`, size: 3, browser_download_url: `https://github.com/Shikasar7/CicaTavern/releases/download/v1.8.0/CicaTavern-1.8.0-mac-${arch}.zip` })),
  }
  for (const arch of ['arm64', 'x64']) {
    const { assets } = releaseInfo(json, { arch })
    assert.equal(assets.mac.name, `CicaTavern-1.8.0-mac-${arch}.zip`)
    assert.equal(assets.mac.sha256, hex(arch), 'its line in the notes')
    assert.equal(assets.zip, undefined)
  }
})

test('the Mac updater: installable means "has a download page"; downloading is refused; state stays out of the .app', async t => {
  const dir = await scratch(t)
  const root = path.join(dir, 'Applications', 'CicaTavern.app', 'Contents', 'Resources', 'app')
  await mkdir(path.join(root, 'runtime'), { recursive: true })
  await writeFile(path.join(root, 'runtime', 'node'), 'node')
  const home = path.join(dir, 'home')
  const updater = createUpdater({ features: featuresOf('release', 'darwin'), root, version: '1.7.0', platform: 'darwin', env: { HOME: home } })
  const status = await updater.status()
  assert.deepEqual([status.enabled, status.kind, status.installable, status.reason, status.root], [true, 'mac', true, null, null])
  await assert.rejects(updater.download(), error => error.status === 400)
  await assert.rejects(updater.apply(), error => error.status === 400)
  assert.deepEqual((await updater.installs()).installs, [])
  await updater.setAutoCheck(false)
  const state = path.join(home, 'Library', 'Application Support', 'CicaTavern', 'update', 'state.json')
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).autoCheck, false, 'kept in Application Support')
  assert.equal(existsSync(path.join(root, 'update')), false, 'nothing written into the bundle')
})

test('the Mac updater: when GitHub limits the API, latest.json gives the zip for this Mac\'s processor', async t => {
  const dir = await scratch(t)
  const root = path.join(dir, 'Applications', 'CicaTavern.app', 'Contents', 'Resources', 'app')
  await mkdir(path.join(root, 'runtime'), { recursive: true })
  await writeFile(path.join(root, 'runtime', 'node'), 'node')
  // Not the processor running the test, so a check that forgot it would take the other zip.
  const arch = process.arch === 'arm64' ? 'x64' : 'arm64'
  const hex = { arm64: 'a'.repeat(64), x64: 'b'.repeat(64) }
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`
    if (req.url === '/repos/Shikasar7/CicaTavern/releases/latest') {
      res.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) })
      return res.end('{}')
    }
    if (req.url === '/Shikasar7/CicaTavern/releases/latest/download/latest.json') {
      const assets = ['arm64', 'x64'].map(a => ({ name: `CicaTavern-1.9.1-mac-${a}.zip`, size: 3, digest: `sha256:${hex[a]}`, browser_download_url: `${base}/Shikasar7/CicaTavern/releases/download/v1.9.1/CicaTavern-1.9.1-mac-${a}.zip` }))
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(latestFile({ tag_name: 'v1.9.1', name: 'CicaTavern 1.9.1', body: '', html_url: `${base}/release`, published_at: '2026-10-24T00:00:00Z', assets })))
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const feed = `http://127.0.0.1:${server.address().port}/repos/Shikasar7/CicaTavern`
  const updater = createUpdater({ features: featuresOf('release', 'darwin'), root, version: '1.9.0', feed, platform: 'darwin', arch, env: { HOME: path.join(dir, 'home') } })
  const status = await updater.check({ force: true })
  assert.equal(status.newer, true)
  assert.equal(status.latest.assets.mac.name, `CicaTavern-1.9.1-mac-${arch}.zip`)
  assert.equal(status.latest.assets.mac.sha256, hex[arch])
})

test('the per-user fallback folder: LOCALAPPDATA on Windows, Application Support on macOS; never inside a .app', async t => {
  const dir = await scratch(t)
  assert.equal(userAppData({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32'), 'C:\\Users\\a\\AppData\\Local')
  assert.equal(userAppData({ USERPROFILE: path.join(dir, 'a') }, 'win32'), path.join(dir, 'a', 'AppData', 'Local'))
  assert.equal(userAppData({ HOME: path.join(dir, 'h') }, 'darwin'), path.join(dir, 'h', 'Library', 'Application Support'))
  assert.ok(path.isAbsolute(userAppData({}, 'darwin')), 'no HOME: the OS home folder, not a relative path')

  const bundled = path.join(dir, 'CicaTavern.app', 'Contents', 'Resources', 'app')
  await mkdir(bundled, { recursive: true })
  assert.equal(inAppBundle(bundled), true)
  assert.equal(inAppBundle(path.join(dir, 'CicaTavern-1.7.0-mac-arm64')), false)
  const env = { HOME: path.join(dir, 'h') }
  assert.equal(await stateDir(bundled, env, 'darwin'), path.join(dir, 'h', 'Library', 'Application Support', 'CicaTavern', 'update'))
  assert.equal(await installBase(bundled, env, 'darwin'), path.join(dir, 'h', 'Library', 'Application Support', 'CicaTavern'))
  assert.deepEqual(readdirSync(path.join(dir, 'CicaTavern.app', 'Contents', 'Resources')), ['app'], 'not even a probe file in the bundle')
  // A plain folder (the staged tree run by hand) keeps its state beside it, as on Windows.
  const plain = path.join(dir, 'CicaTavern-1.7.0-mac-arm64')
  await mkdir(plain)
  assert.equal(await stateDir(plain, env, 'darwin'), path.join(plain, 'update'))
})

// ─── 网络代理 → 跟随系统代理 on macOS ─────────────────────────────────────

const SCUTIL_ON = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : *.local
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7892
  SOCKSProxy : 127.0.0.1
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      ExceptionsList : <array> {
        0 : *.local
      }
      FTPPassive : 1
      HTTPEnable : 1
      HTTPPort : 8888
      HTTPProxy : 10.0.0.9
      HTTPSEnable : 1
      HTTPSPort : 8888
      HTTPSProxy : 10.0.0.9
    }
  }
}
`

const SCUTIL_OFF = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPSEnable : 1
      HTTPSPort : 8888
      HTTPSProxy : 10.0.0.9
    }
  }
}
`

test('scutil --proxy: the HTTPS proxy, else the HTTP one; SOCKS, PAC and per-interface copies are not used', () => {
  assert.equal(parseMacProxy(SCUTIL_ON), 'http://127.0.0.1:7891')
  assert.equal(parseMacProxy(SCUTIL_ON.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')), 'http://127.0.0.1:7890')
  assert.equal(parseMacProxy(SCUTIL_ON.replace(/\n/g, '\r\n')), 'http://127.0.0.1:7891', 'CRLF too')
  assert.equal(parseMacProxy(SCUTIL_OFF), null, 'off at the top: the scoped en0 copy does not count')
  assert.equal(parseMacProxy('<dictionary> {\n  SOCKSEnable : 1\n  SOCKSPort : 1080\n  SOCKSProxy : 127.0.0.1\n}\n'), null)
  assert.equal(parseMacProxy('<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://wpad/wpad.dat\n}\n'), null)
  assert.equal(parseMacProxy('<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : ::1\n  HTTPPort : 7890\n}\n'), 'http://[::1]:7890')
  assert.equal(parseMacProxy('<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : proxy.lan\n}\n'), 'http://proxy.lan')
  assert.equal(parseMacProxy(''), null)
  assert.equal(parseMacProxy('scutil: command not found'), null)
})

test('跟随系统代理 on macOS: scutil\'s proxy first, called "macos"', async () => {
  const network = createProxy({ defaultMode: 'none', env: { HTTPS_PROXY: 'http://127.0.0.1:1' }, readSystem: async () => parseMacProxy(SCUTIL_ON), systemName: 'macos' })
  assert.deepEqual(await network.apply('system'), { mode: 'system', effective: 'http://127.0.0.1:7891', source: 'macos', locked: false })
  network.stop()
  const off = createProxy({ defaultMode: 'none', env: { HTTPS_PROXY: 'http://127.0.0.1:1' }, readSystem: async () => parseMacProxy(SCUTIL_OFF), systemName: 'macos' })
  assert.deepEqual(await off.apply('system'), { mode: 'system', effective: 'http://127.0.0.1:1', source: 'env', locked: false })
  off.stop()
})
