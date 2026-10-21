#!/usr/bin/env node
// Put the app's shortcut ("CicaTavern 个人版" here, "CicaTavern" for a checkout without the subscription code) on the desktop (Windows), for a source
// checkout such as this machine's own install: it opens CicaTavern.exe at the
// checkout's root (launcher/; built here first if missing, which needs the
// MSVC Build Tools). The exe runs bin/launch.mjs with the node.exe on PATH and
// no console window; it makes the shortcut itself through IShellLink.
// A release package's shortcut comes from 设置 → 更多 →「桌面快捷方式」.
//   node bin/install-shortcut.mjs [--start-menu] [--rebuild]
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLauncher } from '../scripts/build-launcher.mjs'
import { createShortcut } from '../server/update/install.mjs'

if (process.platform !== 'win32') {
  console.error('桌面快捷方式只支持 Windows。其他系统直接运行 node bin/launch.mjs。')
  process.exit(1)
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = path.join(root, 'CicaTavern.exe')
if (!existsSync(exe) || process.argv.includes('--rebuild')) {
  console.log('编译 CicaTavern.exe…')
  await buildLauncher(root, exe)
}
const file = await createShortcut(exe, { startMenu: process.argv.includes('--start-menu') })
console.log(`已创建：${file}`)
