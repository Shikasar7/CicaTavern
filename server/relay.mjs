// 卡片界面直连接口的转发 (web/app.js frameHandlers.fetch): a card frame's own
// fetch to an API that failed in the browser (an API that does not let pages
// call it, the browser's own proxy, an address on this computer that a
// sandboxed frame may not reach) is made from here instead, once the player
// allowed that card and address. It goes through the app's proxy, carries no
// cookies and nothing of this app's own, and never reaches a CicaTavern on this
// machine.
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { lanAddresses } from './access.mjs'
import { featuresOf } from './edition.mjs'
import { msg } from './i18n.mjs'
import { agentFor } from './providers.mjs'
import { httpError } from './store.mjs'

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
// Set by the browser or by this app, never by the card; x-agent-tavern also keeps any CicaTavern from taking orders.
const DROPPED = /^(host|connection|keep-alive|content-length|transfer-encoding|te|trailer|upgrade|expect|cookie2?|origin|referer|accept-encoding|x-agent-tavern|proxy-.*|sec-.*)$/i
// Not passed back: the hop's own, and cookies.
const DROPPED_BACK = /^(connection|keep-alive|transfer-encoding|content-length|set-cookie2?|alt-svc|strict-transport-security)$/i
const BODY_MAX = 10 * 1024 * 1024
const TIMEOUT_MS = 10 * 60 * 1000
// The ports CicaTavern listens on by default.
const APP_PORTS = ['personal', 'release'].map(name => featuresOf(name).port)

const isLoopbackIp = ip => /^127\./.test(ip) || ip === '::1' || ip === '0.0.0.0' || ip === '::' || /^::ffff:127\./i.test(ip)

/** The address asked for: http(s), and not a CicaTavern on this machine (its own port, or one an edition uses). */
export async function relayTarget(raw, ownPort = 0) {
  let url
  try {
    url = new URL(String(raw ?? ''))
  } catch {
    throw httpError(400, msg`地址不对`)
  }
  if (!/^https?:$/.test(url.protocol)) throw httpError(400, msg`只能转发 http 和 https 的地址`)
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if ([...APP_PORTS, Number(ownPort)].includes(port)) {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const own = lanAddresses().names
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map(entry => entry.address.toLowerCase())
    if (own.has(host) || addresses.some(ip => own.has(ip) || isLoopbackIp(ip))) throw httpError(403, msg`不能转发到 CicaTavern 自己`)
  }
  return url
}

/**
 * Makes one request for a card frame and answers with what came back: the API's
 * status and headers (x-relay: 1 says they are the API's, x-relay-status-text its
 * status line), then its body as it arrives.
 * @param input - { url, method, headers: [[name, value]], body: base64 or null }
 * @param proxy - the app's proxy (none for this computer's own addresses, see agentFor).
 * @param ownPort - the port this server listens on.
 */
export async function relayRequest(input, res, { proxy = null, ownPort = 0, signal } = {}) {
  const url = await relayTarget(input?.url, ownPort)
  const method = String(input?.method ?? 'GET').toUpperCase()
  if (!METHODS.has(method)) throw httpError(400, msg`不支持的请求方法：${method}`)
  const headers = {}
  for (const pair of Array.isArray(input?.headers) ? input.headers : []) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || DROPPED.test(pair[0].trim())) continue
    headers[pair[0].trim().toLowerCase()] = String(pair[1] ?? '')
  }
  // Passed on as it comes: a compressed body would have to be undone twice.
  headers['accept-encoding'] = 'identity'
  const payload = typeof input?.body === 'string' && input.body ? Buffer.from(input.body, 'base64') : null
  if (payload && payload.length > BODY_MAX) throw httpError(413, msg`要转发的内容太大`)
  if (payload) headers['content-length'] = String(payload.length)

  const upstream = await new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, { method, headers, agent: agentFor(url, proxy), timeout: TIMEOUT_MS })
    signal?.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    req.on('response', resolve)
    req.on('timeout', () => req.destroy(new Error(msg`请求超时`)))
    req.on('error', reject)
    req.end(payload ?? undefined)
  }).catch(error => {
    if (error.name === 'AbortError') throw httpError(499, msg`已取消`)
    throw httpError(502, msg`替卡片界面连接 ${url.host} 没有连上：${error.message}`)
  })

  const back = { 'x-relay': '1', 'x-relay-status-text': encodeURIComponent(upstream.statusMessage ?? ''), 'cache-control': 'no-store' }
  for (const [name, value] of Object.entries(upstream.headers)) if (!DROPPED_BACK.test(name)) back[name] = value
  res.writeHead(upstream.statusCode ?? 502, back)
  res.on('close', () => upstream.destroy())
  upstream.on('error', () => res.destroy())
  upstream.pipe(res)
}
