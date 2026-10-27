// Entry for the Android app's embedded Node (nodejs-mobile, see android/).
//   node bin/android.mjs --data <dir> --port <port> --token <hex> --log <file> --error-file <file>
// Provider models only, loopback only; every request needs the token, which
// the app hands to its WebView as a cookie.
//
// Node must never exit here: nodejs-mobile aborts the whole app while tearing
// down ("pthread_mutex_lock called on a destroyed mutex"), before stdout
// reaches the log. So a failed start is written with appendFileSync, reported
// through --error-file (the app polls for it), and the process is kept alive.
import { setDefaultResultOrder } from 'node:dns'
import { appendFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const logFile = option('log')
const errorFile = option('error-file')

function log(line) {
  const text = `[CicaTavern] ${new Date().toISOString()} ${line}\n`
  try {
    if (logFile) appendFileSync(logFile, text)
    else process.stderr.write(text)
  } catch {
    // Nowhere else to write.
  }
}

const describe = error => (error instanceof Error ? error.stack || error.message : String(error))

function fail(stage, error) {
  log(`${stage} failed: ${describe(error)}`)
  try {
    if (errorFile) writeFileSync(errorFile, `${stage}失败：\n${describe(error)}`)
  } catch {
    // The log has it.
  }
  // Keep the event loop alive: exiting would crash the app (see above).
  setInterval(() => {}, 1 << 30)
}

// A failed request must not take the whole app down with it.
process.on('uncaughtException', error => log(`uncaught: ${describe(error)}`))
process.on('unhandledRejection', error => log(`unhandled: ${describe(error)}`))

log(`node ${process.version} ${process.platform}/${process.arch}, entered JS`)

// IPv4 addresses first. Node takes them in the order Android gives, IPv6 first on a phone that has it, and
// never falls back as a browser does: a VPN app that routes only IPv4 would see none of those connections.
setDefaultResultOrder('ipv4first')
let createApp
try {
  ;({ createApp } = await import('../server/http.mjs'))
  log('modules loaded')
} catch (error) {
  fail('加载服务端模块', error)
}
if (createApp) {
  try {
    const app = createApp({
      dataRoot: option('data'),
      // No proxy unless 设置 → 网络代理 names one: phones usually route through a VPN-style proxy app.
      edition: 'android',
      accessToken: option('token'),
    })
    // Errors caught above (the app carries on) also go to 设置 → 更多 → 错误日志.
    app.diagnostics.watchProcess()
    await app.listen({ port: Number(option('port') ?? 0), listen: 'local' })
    log(`listening on 127.0.0.1:${app.bound().port}`)
  } catch (error) {
    fail('启动服务', error)
  }
}
