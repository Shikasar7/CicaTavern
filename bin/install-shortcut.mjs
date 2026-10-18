#!/usr/bin/env node
// Put the app's shortcut ("CicaTavern") on the desktop (Windows). It runs bin\launch.vbs,
// which starts the server without a console window and opens the app window.
//   node bin/install-shortcut.mjs [--start-menu]
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { featuresOf, packagedEdition } from '../server/edition.mjs'

if (process.platform !== 'win32') {
  console.error('桌面快捷方式只支持 Windows。其他系统直接运行 node bin/launch.mjs。')
  process.exit(1)
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const edition = featuresOf(packagedEdition())
const ps = s => `'${String(s).replace(/'/g, "''")}'`
const folder = process.argv.includes('--start-menu') ? 'Programs' : 'Desktop'
const script = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dir = [Environment]::GetFolderPath(${ps(folder)})
$lnk = Join-Path $dir ${ps(`${edition.appName}.lnk`)}
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = [IO.Path]::Combine($env:SystemRoot, 'System32', 'wscript.exe')
$s.Arguments = '"' + ${ps(path.join(root, 'bin', 'launch.vbs'))} + '" "' + ${ps(process.execPath)} + '"'
$s.WorkingDirectory = ${ps(root)}
$s.IconLocation = ${ps(path.join(root, 'web', 'icon.ico'))} + ',0'
$s.Description = ${ps(edition.subscription ? 'CicaTavern 个人版：可用 Claude 订阅游玩角色卡' : '用自己的模型 API 游玩角色卡')}
$s.Save()
Write-Output $lnk
`
// -EncodedCommand keeps the Chinese file name intact whatever the console code page is.
const encoded = Buffer.from(script, 'utf16le').toString('base64')
const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' })
console.log(`已创建：${out.trim()}`)
