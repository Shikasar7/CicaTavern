#!/usr/bin/env node
// Build the release folder (and, for Windows, the zip) for other people:
//   node scripts/stage-release.mjs [--out <dir>] [--node <node.exe>] [--exe <CicaTavern.exe>] [--zip] [--no-node] [--no-exe]
//   node scripts/stage-release.mjs --platform mac --arch arm64|x64 --node <node-v24…-darwin-<arch>>/bin/node [--node-version v24.22.0] [--out <dir>] [--no-node]
//
// dist/CicaTavern-<version>-win-x64/
//   CicaTavern.exe             start in the background and open the app window (launcher/, built
//                              here with MSVC, or --exe: the one CI had signed)
//   排查问题（带控制台）.cmd    the same with a console window showing the server's output
//   runtime/node.exe           bundled Node (the official, OpenJS-signed build), so nothing needs installing
//   bin/ server/ web/ examples/ node_modules/ (runtime modules only)
//   package.json edition.json README.md README.en.md CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md
//
// The release edition (server/edition.mjs): API providers only. Only what
// scripts/public-files.mjs lets out is copied, and no @anthropic-ai module.
// No script-host launchers (.vbs, .ps1): antivirus heuristics distrust them.
// The zip is what 设置 → 更多 → 更新 downloads (server/update/): its one top
// folder must stay CicaTavern-<version>-win-x64.
//
// dist/CicaTavern-<version>-mac-<arch>/   the same tree, which becomes CicaTavern.app/Contents/Resources/app
//   runtime/node               the official darwin build for that architecture, with its own signature;
//                              its version comes from the tarball's include/node/node_version.h (or
//                              --node-version): it is never run here, it may be another OS or CPU
//   no CicaTavern.exe and no .cmd: the Swift launcher (launcher/mac/) is the app's executable.
// No zip for the Mac: server/update/zip.mjs keeps no Unix permission bits, so
// .github/workflows/mac-release.yml builds the .app and packs it with ditto.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLauncher } from './build-launcher.mjs'
import { publicFile } from './public-files.mjs'
import { RUNTIME_MODULES } from './runtime-modules.mjs'
import { featuresOf } from '../server/edition.mjs'
import { packageFolder } from '../server/update/install.mjs'
import { zipFolder } from '../server/update/zip.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const release = featuresOf('release')
const platform = option('platform') ?? 'win'
if (!['win', 'mac'].includes(platform)) throw new Error(`--platform 只能是 win 或 mac，不是 ${platform}`)
const mac = platform === 'mac'
const arch = option('arch')
if (mac) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Mac 包要写 --arch arm64 或 --arch x64')
  if (args.includes('--zip')) throw new Error('Mac 包不在这里打 zip：zip.mjs 不保留可执行权限，CI 用 ditto 打包 .app')
  if (option('exe')) throw new Error('Mac 包没有 CicaTavern.exe')
  if (!option('node') && !args.includes('--no-node')) throw new Error('Mac 包要用 --node 指定 darwin 版 Node（官方 tarball 里的 bin/node）')
}
const name = mac ? `${release.appName}-${pkg.version}-mac-${arch}` : packageFolder(pkg.version)
const out = path.resolve(option('out') ?? path.join(root, 'dist', name))
const nodeExe = path.resolve(option('node') ?? process.execPath)
const runtimeName = mac ? 'node' : 'node.exe'
const MIN_NODE = 24 // http.Agent proxyEnv (server/providers.mjs)

// Only what the release runs.
const BIN = ['start.mjs', 'launch.mjs', 'update-apply.mjs']

const crlf = text => text.replace(/\r?\n/g, '\r\n')

function nodeMajor(exe) {
  const version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim()
  return { version, major: Number(/^v(\d+)/.exec(version)?.[1] ?? 0) }
}

/** The darwin Node's version without running it: --node-version, else the tarball's include/node/node_version.h. */
async function macNodeVersion(exe) {
  let version = option('node-version')
  if (!version) {
    const header = path.join(path.dirname(path.dirname(exe)), 'include', 'node', 'node_version.h')
    if (!existsSync(header)) throw new Error(`${header} 不在：用官方 tarball 解压出的 bin/node，或者加 --node-version`)
    const text = await readFile(header, 'utf8')
    const part = key => new RegExp(`^#define NODE_${key}_VERSION (\\d+)`, 'm').exec(text)?.[1]
    version = `v${part('MAJOR')}.${part('MINOR')}.${part('PATCH')}`
  }
  version = `v${String(version).replace(/^v/, '')}`
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`读不出 Node 的版本：${version}`)
  return { version, major: Number(/^v(\d+)/.exec(version)[1]) }
}

// Mach-O CPU types: a 64-bit thin binary starts with cf fa ed fe, then its CPU type.
const MACH_CPU = { arm64: 0x0100000c, x64: 0x01000007 }

/** The darwin Node is a Mach-O for --arch, so an arm64 app never ships an x64 runtime or the reverse. */
async function checkMachO(exe) {
  const head = (await readFile(exe)).subarray(0, 8)
  if (head.length < 8 || head.readUInt32LE(0) !== 0xfeedfacf) throw new Error(`${exe} 不是 64 位 Mac 程序（Mach-O）`)
  const cpu = head.readUInt32LE(4)
  if (cpu !== MACH_CPU[arch]) throw new Error(`${exe} 不是 ${arch} 的 Node（Mach-O CPU 类型 0x${cpu.toString(16)}）`)
}

async function licenseText(dir) {
  const file = readdirSync(dir).find(f => /^licen[cs]e(\.(md|txt))?$/i.test(f))
  return file ? (await readFile(path.join(dir, file), 'utf8')).trim() : null
}

async function notices(nodeVersion) {
  const parts = ['# Third-party notices', '', `${release.appName} ships with the following components.`, '']
  for (const name of RUNTIME_MODULES) {
    const dir = path.join(root, 'node_modules', name)
    const meta = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
    parts.push(`## ${name} ${meta.version}`, '', `License: ${meta.license ?? 'see package'}`, '')
    const text = await licenseText(dir)
    if (text) parts.push('```', text, '```', '')
  }
  if (nodeVersion) {
    parts.push(`## Node.js ${nodeVersion} (runtime/${runtimeName})`, '', 'License: MIT, with the licenses of the components it bundles; see runtime/LICENSE.', '')
  }
  return parts.join('\n')
}

await rm(out, { recursive: true, force: true })
await mkdir(path.join(out, 'bin'), { recursive: true })
await cp(path.join(root, 'server'), path.join(out, 'server'), { recursive: true, filter: publicFile })
await cp(path.join(root, 'web'), path.join(out, 'web'), { recursive: true, filter: publicFile })
// The README's banner.
await cp(path.join(root, 'docs', 'brand', 'banner.jpg'), path.join(out, 'docs', 'brand', 'banner.jpg'))
// The README's pictures.
if (existsSync(path.join(root, 'docs', 'screenshots'))) await cp(path.join(root, 'docs', 'screenshots'), path.join(out, 'docs', 'screenshots'), { recursive: true })
await cp(path.join(root, 'examples'), path.join(out, 'examples'), { recursive: true })
for (const file of BIN) await cp(path.join(root, 'bin', file), path.join(out, 'bin', file))
for (const name of RUNTIME_MODULES) {
  await cp(path.join(root, 'node_modules', name), path.join(out, 'node_modules', name), { recursive: true })
}
await writeFile(
  path.join(out, 'package.json'),
  JSON.stringify({ name: release.appName.toLowerCase(), version: pkg.version, private: true, type: 'module', description: '用自己的模型 API 游玩 SillyTavern 角色卡' }, null, 2) + '\n',
)
await writeFile(path.join(out, 'edition.json'), JSON.stringify({ edition: 'release' }) + '\n')
// The private repository keeps the release README apart from its own; the public tree has it as README.md.
const releaseReadme = path.join(root, 'docs', 'README-release.md')
await cp(existsSync(releaseReadme) ? releaseReadme : path.join(root, 'README.md'), path.join(out, 'README.md'))
// The English README (README-release.en.md here, README.en.md in the public tree).
for (const english of [path.join(root, 'docs', 'README-release.en.md'), path.join(root, 'README.en.md')]) {
  if (existsSync(english)) {
    await cp(english, path.join(out, 'README.en.md'))
    break
  }
}
await cp(path.join(root, 'CHANGELOG.md'), path.join(out, 'CHANGELOG.md'))
if (existsSync(path.join(root, 'LICENSE'))) await cp(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'))
else console.warn('[stage-release] 仓库根目录还没有 LICENSE：发布前选一个许可证')

let nodeVersion = null
if (!args.includes('--no-node')) {
  const { version, major } = mac ? await macNodeVersion(nodeExe) : nodeMajor(nodeExe)
  if (major < MIN_NODE) throw new Error(`${nodeExe} 是 ${version}，发布版要 Node ${MIN_NODE} 以上（代理靠 http.Agent 的 proxyEnv）`)
  if (mac) await checkMachO(nodeExe)
  nodeVersion = version
  await mkdir(path.join(out, 'runtime'), { recursive: true })
  await cp(nodeExe, path.join(out, 'runtime', runtimeName))
  // The tarball's bin/node may have lost its x bit on the way (a zip, a Windows disk).
  if (mac) await chmod(path.join(out, 'runtime', runtimeName), 0o755)
  // The official zip has LICENSE next to node.exe; the darwin tarball one folder up from bin/node.
  const licenseDirs = mac ? [path.dirname(nodeExe), path.dirname(path.dirname(nodeExe))] : [path.dirname(nodeExe)]
  const nodeLicense = licenseDirs.map(dir => path.join(dir, 'LICENSE')).find(file => existsSync(file))
  if (nodeLicense) await cp(nodeLicense, path.join(out, 'runtime', 'LICENSE'))
  else {
    // The MSI install has no LICENSE next to node.exe; the official zip does.
    await writeFile(path.join(out, 'runtime', 'LICENSE'), `Node.js ${version}: https://github.com/nodejs/node/blob/${version}/LICENSE\n`)
    console.warn(`[stage-release] ${path.dirname(nodeExe)} 里没有 Node 的 LICENSE，只写了链接。${mac ? '用官方 tarball 里的 bin/node（--node）' : '用官方 zip 里的 node.exe（--node）'}可以带上全文。`)
  }
}
await writeFile(path.join(out, 'THIRD_PARTY_NOTICES.md'), await notices(nodeVersion))

// Launchers. The .cmd stays ASCII inside (cmd reads it in the console code page).
// The Mac's is the .app's own executable (launcher/mac/), built by the workflow.
if (!mac) {
  const exe = path.join(out, `${release.appName}.exe`)
  if (option('exe')) await cp(path.resolve(option('exe')), exe)
  else if (!args.includes('--no-exe')) await buildLauncher(root, exe, { version: pkg.version })
  await writeFile(
    path.join(out, '排查问题（带控制台）.cmd'),
    crlf(`@echo off
rem Starts the server with its output in this window, then opens the app window.
cd /d "%~dp0"
"runtime\\node.exe" bin\\start.mjs --open %*
if errorlevel 1 pause
`),
  )
}

// Nothing personal slipped in, and no script-host launcher (nor, on the Mac, anything for Windows).
const shipped = readdirSync(out, { recursive: true }).map(String)
const leaked = shipped.filter(file => !publicFile(path.join(out, file)) || /node_modules[\\/]@anthropic-ai/.test(file) || (/\.(vbs|vbe|js|ps1|wsf|hta)$/i.test(file) && !/^(node_modules|web)[\\/]/.test(file)) || (mac && /\.(exe|cmd|bat)$/i.test(file) && !/^node_modules[\\/]/.test(file)))
if (leaked.length) throw new Error(`发布目录里不该有：${leaked.slice(0, 5).join('、')}`)
console.log(`[stage-release] ${out}（${shipped.length} 个文件）`)

if (args.includes('--zip')) {
  const zip = `${out}.zip`
  await rm(zip, { force: true })
  await writeFile(zip, await zipFolder(out))
  console.log(`[stage-release] ${zip}`)
}
