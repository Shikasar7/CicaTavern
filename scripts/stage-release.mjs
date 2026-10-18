#!/usr/bin/env node
// Build the Windows release folder (and zip) for other people:
//   node scripts/stage-release.mjs [--out <dir>] [--node <node.exe>] [--exe <CicaTavern.exe>] [--zip] [--no-node] [--no-exe]
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
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
const name = packageFolder(pkg.version)
const out = path.resolve(option('out') ?? path.join(root, 'dist', name))
const nodeExe = path.resolve(option('node') ?? process.execPath)
const MIN_NODE = 24 // http.Agent proxyEnv (server/providers.mjs)

// Only what the release runs.
const BIN = ['start.mjs', 'launch.mjs', 'update-apply.mjs']

const crlf = text => text.replace(/\r?\n/g, '\r\n')

function nodeMajor(exe) {
  const version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim()
  return { version, major: Number(/^v(\d+)/.exec(version)?.[1] ?? 0) }
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
    parts.push(`## Node.js ${nodeVersion} (runtime/node.exe)`, '', 'License: MIT, with the licenses of the components it bundles; see runtime/LICENSE.', '')
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
  const { version, major } = nodeMajor(nodeExe)
  if (major < MIN_NODE) throw new Error(`${nodeExe} 是 ${version}，发布版要 Node ${MIN_NODE} 以上（代理靠 http.Agent 的 proxyEnv）`)
  nodeVersion = version
  await mkdir(path.join(out, 'runtime'), { recursive: true })
  await cp(nodeExe, path.join(out, 'runtime', 'node.exe'))
  const nodeLicense = path.join(path.dirname(nodeExe), 'LICENSE')
  if (existsSync(nodeLicense)) await cp(nodeLicense, path.join(out, 'runtime', 'LICENSE'))
  else {
    // The MSI install has no LICENSE next to node.exe; the official zip does.
    await writeFile(path.join(out, 'runtime', 'LICENSE'), `Node.js ${version}: https://github.com/nodejs/node/blob/${version}/LICENSE\n`)
    console.warn(`[stage-release] ${path.dirname(nodeExe)} 里没有 Node 的 LICENSE，只写了链接。用官方 zip 里的 node.exe（--node）可以带上全文。`)
  }
}
await writeFile(path.join(out, 'THIRD_PARTY_NOTICES.md'), await notices(nodeVersion))

// Launchers. The .cmd stays ASCII inside (cmd reads it in the console code page).
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

// Nothing personal slipped in, and no script-host launcher.
const shipped = readdirSync(out, { recursive: true }).map(String)
const leaked = shipped.filter(file => !publicFile(path.join(out, file)) || /node_modules[\\/]@anthropic-ai/.test(file) || (/\.(vbs|vbe|js|ps1|wsf|hta)$/i.test(file) && !/^(node_modules|web)[\\/]/.test(file)))
if (leaked.length) throw new Error(`发布目录里不该有：${leaked.slice(0, 5).join('、')}`)
console.log(`[stage-release] ${out}（${shipped.length} 个文件）`)

if (args.includes('--zip')) {
  const zip = `${out}.zip`
  await rm(zip, { force: true })
  await writeFile(zip, await zipFolder(out))
  console.log(`[stage-release] ${zip}`)
}
