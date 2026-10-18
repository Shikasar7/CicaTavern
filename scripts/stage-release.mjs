#!/usr/bin/env node
// Build the Windows release folder (and zip) for other people:
//   node scripts/stage-release.mjs [--out <dir>] [--node <node.exe>] [--zip] [--no-node]
//
// dist/CicaTavern-<version>-win-x64/
//   启动 CicaTavern.vbs          start in the background and open the app window
//   创建桌面快捷方式.cmd        a desktop shortcut to the above
//   Start-CicaTavern.cmd       start with a console (for troubleshooting)
//   runtime/node.exe           bundled Node, so nothing needs installing
//   bin/ server/ web/ examples/ node_modules/ (runtime modules only)
//   package.json edition.json README.md CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md
//
// The release edition (server/edition.mjs): API providers only. Only what
// scripts/public-files.mjs lets out is copied, and no @anthropic-ai module.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { publicFile, releaseLaunchVbs, vbs } from './public-files.mjs'
import { RUNTIME_MODULES } from './runtime-modules.mjs'
import { featuresOf } from '../server/edition.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const release = featuresOf('release')
const name = `${release.appName}-${pkg.version}-win-x64`
const out = path.resolve(option('out') ?? path.join(root, 'dist', name))
const nodeExe = path.resolve(option('node') ?? process.execPath)
const MIN_NODE = 24 // http.Agent proxyEnv (server/providers.mjs)

// Only what the release runs.
const BIN = ['start.mjs', 'launch.mjs', 'install-shortcut.mjs']

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
await writeFile(path.join(out, 'bin', 'launch.vbs'), await releaseLaunchVbs(root))
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

// Launchers. .cmd files stay ASCII inside (cmd reads them in the console code page).
await writeFile(
  path.join(out, `启动 ${release.appName}.vbs`),
  vbs(`' Starts ${release.appName} with the bundled Node: no console window; the app window opens.
Set shell = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "wscript.exe """ & dir & "\\bin\\launch.vbs"" """ & dir & "\\runtime\\node.exe""", 0, False
`),
)
await writeFile(
  path.join(out, '创建桌面快捷方式.cmd'),
  crlf(`@echo off
cd /d "%~dp0"
"runtime\\node.exe" bin\\install-shortcut.mjs %*
pause
`),
)
await writeFile(
  path.join(out, `Start-${release.appName}.cmd`),
  crlf(`@echo off
cd /d "%~dp0"
"runtime\\node.exe" bin\\start.mjs --open %*
if errorlevel 1 pause
`),
)

// Nothing personal slipped in.
const shipped = readdirSync(out, { recursive: true }).map(String)
const leaked = shipped.filter(file => !publicFile(path.join(out, file)) || /node_modules[\\/]@anthropic-ai/.test(file))
if (leaked.length) throw new Error(`发布目录里不该有：${leaked.slice(0, 5).join('、')}`)
console.log(`[stage-release] ${out}（${shipped.length} 个文件）`)

if (args.includes('--zip')) {
  const zip = `${out}.zip`
  await rm(zip, { force: true })
  await writeFile(zip, await zipFolder(out))
  console.log(`[stage-release] ${zip}`)
}

/**
 * A zip of the folder (its name as the top directory), written here rather
 * than by a tool: Windows' tar.exe stores names in the console code page and
 * .NET Framework's writer uses backslashes, which garble the Chinese launcher
 * names or the folders elsewhere. Names are UTF-8 with the flag set (bit 11).
 */
async function zipFolder(dir) {
  const top = path.basename(dir)
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort()
  const locals = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(`${top}/${path.relative(dir, file).split(path.sep).join('/')}`, 'utf8')
    const data = await readFile(file)
    const deflated = deflateRawSync(data, { level: 9 })
    const stored = deflated.length >= data.length
    const body = stored ? data : deflated
    const crc = crc32(data)
    const { time, date } = dosTime((await stat(file)).mtime)
    const fields = (header, extra) => {
      header.writeUInt16LE(0x0800, extra + 2) // UTF-8 names
      header.writeUInt16LE(stored ? 0 : 8, extra + 4)
      header.writeUInt16LE(time, extra + 6)
      header.writeUInt16LE(date, extra + 8)
      header.writeUInt32LE(crc, extra + 10)
      header.writeUInt32LE(body.length, extra + 14)
      header.writeUInt32LE(data.length, extra + 18)
      header.writeUInt16LE(name.length, extra + 22)
    }
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    fields(local, 4)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4) // made by: MS-DOS, zip 2.0
    entry.writeUInt16LE(20, 6)
    fields(entry, 6)
    entry.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    central.push(entry, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function dosTime(when) {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((Math.max(when.getFullYear(), 1980) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  }
}
