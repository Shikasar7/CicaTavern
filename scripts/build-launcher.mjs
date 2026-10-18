#!/usr/bin/env node
// Build CicaTavern.exe (launcher/) with MSVC: a plain native program with the
// static C runtime (nothing to install), the app icon, an asInvoker manifest
// and version information from package.json. No packer, no obfuscation.
//   node scripts/build-launcher.mjs [--out <file>]     (default: CicaTavern.exe at the repository root)
// Needs Visual Studio or its Build Tools with the C++ workload (GitHub's
// Windows runners have it). The repository-root copy is what a source
// checkout's desktop shortcut runs (bin/install-shortcut.mjs); it uses the
// node.exe on PATH, a package uses its runtime\node.exe.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const installerDir = (env = process.env) => path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer')

/** vcvars64.bat of the newest Visual Studio with the C++ x64 tools, or null. */
export function findVcvars(env = process.env) {
  const vswhere = path.join(installerDir(env), 'vswhere.exe')
  if (!existsSync(vswhere)) return null
  try {
    const install = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
    const vcvars = install && path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
    return vcvars && existsSync(vcvars) ? vcvars : null
  } catch {
    return null
  }
}

/** → outFile. Throws when MSVC is missing or the build fails. */
export async function buildLauncher(root = ROOT, outFile = path.join(root, 'CicaTavern.exe'), { version, vcvars = findVcvars() } = {}) {
  if (process.platform !== 'win32') throw new Error('CicaTavern.exe 只能在 Windows 上编译')
  if (!vcvars) throw new Error('没找到 Visual Studio 的 C++ 编译工具（vcvars64.bat）：装 Visual Studio Build Tools 的「使用 C++ 的桌面开发」')
  version ??= JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
  const [major, minor, patch] = String(version).split(/[.-]/).map(n => Number(n) || 0)
  const work = await mkdtemp(path.join(tmpdir(), 'cicatavern-launcher-'))
  try {
    for (const file of ['CicaTavern.cpp', 'CicaTavern.rc', 'app.manifest']) await copyFile(path.join(root, 'launcher', file), path.join(work, file))
    await copyFile(path.join(root, 'web', 'icon.ico'), path.join(work, 'icon.ico'))
    await writeFile(path.join(work, 'version.h'), [`#define VER_MAJOR ${major}`, `#define VER_MINOR ${minor}`, `#define VER_PATCH ${patch}`, `#define VER_STRING "${major}.${minor}.${patch}"`, ''].join('\r\n'))
    const steps = [
      'rc /nologo /fo CicaTavern.res CicaTavern.rc',
      // /MT: the C runtime linked in. /Brepro: no timestamps, so the same source gives the same file.
      'cl /nologo /std:c++17 /utf-8 /W4 /O1 /MT /GS /guard:cf /EHsc /DUNICODE /D_UNICODE /Brepro CicaTavern.cpp CicaTavern.res /Fe:CicaTavern.exe /link /SUBSYSTEM:WINDOWS /MANIFEST:NO /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /guard:cf /Brepro ole32.lib shell32.lib user32.lib',
    ]
    // vcvars64.bat sets up the compiler's environment; this runs only when building, never in the app.
    const script = `call "${vcvars}" >nul && ${steps.join(' && ')}`
    try {
      // vcvars looks for vswhere.exe on PATH.
      const env = { ...process.env, PATH: `${installerDir()};${process.env.PATH ?? ''}` }
      execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${script}"`], { cwd: work, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      throw new Error(`编译 CicaTavern.exe 失败：\n${String(error.stdout ?? '')}${String(error.stderr ?? '')}`.trim())
    }
    await copyFile(path.join(work, 'CicaTavern.exe'), outFile)
    return outFile
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const index = args.indexOf('--out')
  const out = await buildLauncher(ROOT, index >= 0 ? path.resolve(args[index + 1]) : undefined)
  console.log(`[build-launcher] ${out}`)
}
