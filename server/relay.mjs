// 卡片界面直连接口的转发 (web/app.js frameHandlers.fetch): a card frame's own
// fetch to an API that failed in the browser (an API that does not let pages
// call it, the browser's own proxy, an address on this computer that a
// sandboxed frame may not reach) is made from here instead, once the player
// allowed that card and address. It goes through the app's proxy, carries no
// cookies and nothing of this app's own, and never reaches a CicaTavern on this
// machine. An address on this computer or the local network is reached only
// when the player allowed it as one, directly and at the address checked.
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { lanAddresses } from './access.mjs'
import { featuresOf } from './edition.mjs'
import { msg } from './i18n.mjs'
import { agentFor } from './providers.mjs'
import { httpError } from './store.mjs'

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
// Set by the browser or by this app, never by the card; x-agent-tavern also keeps any CicaTavern from taking orders.
const DROPPED = /^(host|connection|keep-alive|content-length|transfer-encoding|te|trailer|upgrade|expect|cookie2?|origin|referer|accept-encoding|x-agent-tavern|proxy-.*|sec-.*)$/i
// Not passed back to the card: the hop's own, cookies, and what no longer holds once the browser has undone the encoding.
const DROPPED_BACK = /^(connection|keep-alive|proxy-connection|transfer-encoding|trailer|upgrade|content-length|content-encoding|set-cookie2?)$/i
const BODY_MAX = 10 * 1024 * 1024
const TIMEOUT_MS = 10 * 60 * 1000
// The ports CicaTavern listens on by default.
const APP_PORTS = ['personal', 'release'].map(name => featuresOf(name).port)

// This computer, the local network, and addresses no public API answers on (IPv4-mapped IPv6 included:
// BlockList checks ::ffff:a.b.c.d against the IPv4 ranges). 198.18.0.0/15 is left out: proxies' fake-IP DNS uses it.
const LOCAL = new BlockList()
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]]) LOCAL.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) LOCAL.addSubnet(net, prefix, 'ipv6')
// What fake-IP DNS (Clash / Mihomo TUN) answers for every name, the real lookup done later by the proxy: where such
// a name leads cannot be checked here.
const FAKE = new BlockList()
FAKE.addSubnet('198.18.0.0', 15, 'ipv4')

const family = ip => (isIP(ip) === 6 ? 'ipv6' : 'ipv4')
const inList = (list, ip) => {
  try {
    return list.check(ip, family(ip))
  } catch {
    // Not an address BlockList reads (a scoped IPv6 one): kept to this computer's side.
    return true
  }
}

/** This machine's own addresses: loopback, unspecified and each interface's. */
function thisMachine() {
  const list = new BlockList()
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addAddress('0.0.0.0', 'ipv4')
  list.addAddress('::1', 'ipv6')
  list.addAddress('::', 'ipv6')
  for (const name of lanAddresses().names) if (isIP(name)) list.addAddress(name, family(name))
  return list
}

/** Connections to the addresses that were checked, never a second lookup that could answer otherwise. */
const pinnedLookup = addresses => (_hostname, options, callback) => {
  if (typeof options === 'function') callback = options
  if (options?.all) return callback(null, addresses)
  callback(null, addresses[0].address, addresses[0].family)
}

/**
 * The address asked for: http(s), not a CicaTavern on this machine (its own port, or one an edition uses),
 * and on this computer or the local network, or somewhere that cannot be checked (a fake-IP answer, a name
 * only the proxy knows), only when the player allowed it as possibly such (`local`).
 * @param proxy - the app's proxy: a name not known here is then left to it, once allowed.
 * @param resolve - the name lookup (tests replace it).
 * @returns { url, addresses (null: left to the proxy), local: on this computer or the local network }
 */
export async function relayTarget(raw, { ownPort = 0, local = false, proxy = null, resolve = host => lookup(host, { all: true }) } = {}) {
  let url
  try {
    url = new URL(String(raw ?? ''))
  } catch {
    throw httpError(400, msg`地址不对`)
  }
  if (!/^https?:$/.test(url.protocol)) throw httpError(400, msg`只能转发 http 和 https 的地址`)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const appPort = [...APP_PORTS, Number(ownPort)].includes(port)
  const own = () => httpError(403, msg`不能转发到 CicaTavern 自己`)
  // The page asks the player about such an address, then tries again with `local`.
  const unchecked = () => Object.assign(httpError(403, msg`查不到 ${url.host} 实际指向哪里（网络代理或 TUN 模式接管了域名解析），要先允许这张卡连接它`), { local: true, unverified: true })
  if (appPort && lanAddresses().names.has(host)) throw own()
  let addresses
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }]
  } else {
    try {
      addresses = (await resolve(host)).map(entry => ({ address: String(entry.address).toLowerCase(), family: entry.family }))
      if (!addresses.length) throw new Error(`getaddrinfo ENOTFOUND ${host}`)
    } catch (error) {
      if (!proxy) throw httpError(502, msg`替卡片界面连接 ${url.host} 没有连上：${error.message}`)
      if (!local) throw unchecked()
      return { url, addresses: null, local: false }
    }
  }
  // This computer's own addresses count wherever they are (a VPN adapter's may be outside the private ranges).
  const mine = thisMachine()
  if (appPort && addresses.some(entry => inList(mine, entry.address))) throw own()
  const isLocal = addresses.some(entry => inList(LOCAL, entry.address) || inList(mine, entry.address))
  if (isLocal && !local) throw Object.assign(httpError(403, msg`${url.host} 是这台电脑或局域网里的地址，要先允许这张卡连接它`), { local: true })
  // Checked after this computer's own addresses: a TUN adapter's own one (198.18.0.1) is in the fake-IP range.
  if (!local && addresses.some(entry => inList(FAKE, entry.address))) throw unchecked()
  return { url, addresses, local: isLocal }
}

/**
 * Makes one request for a card frame and answers with what came back. Nothing of the
 * API's acts on this app's own answer: its status (x-relay-status, x-relay-status-text
 * its status line; the answer itself is a 200, as a browser resends a 408 and fails a
 * 407) and its headers (x-relay-headers, JSON pairs, URI-encoded) come as data, x-relay: 1
 * saying they are the API's, then its body as it arrives.
 * @param input - { url, method, headers: [[name, value]], body: base64 or null, local: the player allowed it as an address on this computer or the local network }
 * @param proxy - the app's proxy (not for this computer's or the local network's addresses).
 * @param ownPort - the port this server listens on.
 * @param resolve - the name lookup (tests replace it).
 */
export async function relayRequest(input, res, { proxy = null, ownPort = 0, signal, resolve } = {}) {
  const target = await relayTarget(input?.url, { ownPort, local: input?.local === true, proxy, ...(resolve ? { resolve } : {}) })
  const { url } = target
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
  // The checked addresses, connected to directly: always for this computer and the local network (a proxy
  // cannot reach them), and without a proxy. Through a proxy, the proxy looks the name up itself (a censored
  // name's local answer may be false), so a name that changes its answer between the two lookups is the proxy's.
  const pinned = target.addresses && (target.local || !proxy) ? { agent: false, lookup: pinnedLookup(target.addresses) } : { agent: agentFor(url, proxy) }

  const upstream = await new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, { method, headers, ...pinned, timeout: TIMEOUT_MS })
    signal?.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    req.on('response', resolve)
    req.on('timeout', () => req.destroy(new Error(msg`请求超时`)))
    req.on('error', reject)
    req.end(payload ?? undefined)
  }).catch(error => {
    if (error.name === 'AbortError') throw httpError(499, msg`已取消`)
    throw httpError(502, msg`替卡片界面连接 ${url.host} 没有连上：${error.message}`)
  })

  const passed = []
  for (let i = 0; i < upstream.rawHeaders.length; i += 2) {
    if (!DROPPED_BACK.test(upstream.rawHeaders[i])) passed.push([upstream.rawHeaders[i].toLowerCase(), upstream.rawHeaders[i + 1]])
  }
  const encoding = upstream.headers['content-encoding']
  res.writeHead(200, {
    'x-relay': '1',
    'x-relay-status': String(upstream.statusCode ?? 502),
    'x-relay-status-text': encodeURIComponent(upstream.statusMessage ?? ''),
    'x-relay-headers': encodeURIComponent(JSON.stringify(passed)),
    'cache-control': 'no-store',
    // A body compressed although identity was asked for: the browser undoes it.
    ...(encoding ? { 'content-encoding': encoding } : {}),
  })
  res.on('close', () => upstream.destroy())
  upstream.on('error', () => res.destroy())
  upstream.pipe(res)
}
