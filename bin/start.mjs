#!/usr/bin/env node
// Start Agent Tavern:
//   node bin/start.mjs [--port 8791] [--listen local|lan] [--idle-exit <seconds>] [--data <dir>]
//                      [--proxy <url> | off] [--edition personal|release] [--open]
// A packaged build names its edition in edition.json (server/edition.mjs).
// --proxy or AGENT_TAVERN_PROXY fixes the proxy; otherwise 设置 → 网络代理 decides.
import { spawn } from 'node:child_process'
import { lanAddresses } from '../server/access.mjs'
import { featuresOf, packagedEdition } from '../server/edition.mjs'
import { createApp } from '../server/http.mjs'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const edition = featuresOf(option('edition') ?? packagedEdition())
const port = Number(option('port') ?? process.env.AGENT_TAVERN_PORT ?? edition.port)
const listen = option('listen')
// Seconds with no page open before exiting; the desktop launcher passes 60.
const idleExitSeconds = Number(option('idle-exit') ?? 0)
const app = createApp({
  dataRoot: option('data'),
  proxy: option('proxy') ?? process.env.AGENT_TAVERN_PROXY,
  edition: edition.edition,
  onShutdown: () => process.exit(0),
  idleExitMs: idleExitSeconds > 0 ? idleExitSeconds * 1000 : 0,
})

try {
  await app.listen({ port, listen })
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`[agent-tavern] 端口 ${port} 已被占用：可能已经在运行，直接打开 http://127.0.0.1:${port}/`)
    process.exit(1)
  }
  throw error
}
const bound = app.bound()
const url = `http://127.0.0.1:${bound.port}/`
console.log(`[agent-tavern] 已启动：${url}`)
if (idleExitSeconds > 0) console.log(`[agent-tavern] 所有页面关闭 ${idleExitSeconds} 秒后自动退出`)
if (bound.mode === 'lan') {
  const token = await app.store.ensureAccessToken()
  console.log('[agent-tavern] 手机访问（同一 WiFi 或 Tailscale，不要映射到公网）：')
  for (const { host, adapter } of lanAddresses().addresses) console.log(`  ${adapter}：http://${host}:${bound.port}/#k=${token}`)
  console.log('[agent-tavern] 如果手机打不开，在 Windows 防火墙里允许 Node.js 的入站连接。')
}
console.log(`[agent-tavern] 数据目录：${app.store.dirs.root}`)
const network = app.network.describe()
const via = network.mode === 'system' ? `（跟随系统${network.source === 'env' ? '环境变量' : ''}）` : ''
console.log(`[agent-tavern] 代理：${network.effective ?? '不使用'}${via}${network.locked ? '（启动参数指定）' : ''}`)
if (app.subscription) console.log(`[agent-tavern] Claude 配置（独立）：${app.subscription.configDir}`)
if (args.includes('--open')) {
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref()
}
