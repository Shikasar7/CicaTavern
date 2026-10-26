// Who may open the app. Loopback is always allowed. LAN mode also allows the
// machine's own addresses (Wi-Fi, Tailscale) but still rejects any other Host,
// which is what stops a DNS-rebinding page from driving the API. A non-loopback
// client must present the access token, in the cookie set by the login page.
import { createHash, timingSafeEqual } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { currentLanguage, msg } from './i18n.mjs'

export function isLoopback(address) {
  const ip = String(address ?? '').replace(/^::ffff:/, '')
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
}

export function hostOf(header) {
  return String(header ?? '').trim().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
}

const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|default switch|virtualbox|vmware|docker|loopback/i
// macOS names its links en0, en1… (Wi-Fi or wired); bridge, vmenet, utun, awdl and llw are virtual.
const MAC_LINK = /^en\d+$/
const MAC_VIRTUAL = /^(bridge|vmenet|utun|awdl|llw|anpi|ap)\d+$/

/**
 * What kind of network an address is on. Wi-Fi, wired and Tailscale are the
 * ones a phone can reach; other VPNs (Radmin…) and the WSL / Hyper-V switches
 * are still listed, but folded away.
 */
export function addressKind(adapter, ip) {
  const name = String(adapter ?? '')
  if (/tailscale/i.test(name) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /^fd7a:115c:a1e0:/i.test(ip)) return 'tailscale'
  if (VIRTUAL_ADAPTER.test(name) || MAC_VIRTUAL.test(name)) return 'virtual'
  if (MAC_LINK.test(name)) return 'wifi'
  if (/wi-?fi|wlan|wireless|无线/i.test(name)) return 'wifi'
  if (/ethernet|以太网/i.test(name)) return 'wired'
  return 'other'
}

const KIND_ORDER = ['wifi', 'wired', 'tailscale', 'other', 'virtual']

/**
 * Addresses that belong to this machine. `addresses` is sorted for the phone
 * links: `primary` marks the IPv4 Wi-Fi / wired / Tailscale ones.
 */
/** Android (API 30+) refuses apps the interface list: then there are no LAN addresses, not an error. */
function readInterfaces() {
  try {
    return networkInterfaces()
  } catch {
    return {}
  }
}

export function lanAddresses(interfaces = readInterfaces()) {
  const names = new Set(['localhost', '127.0.0.1', '::1'])
  let own = ''
  try {
    own = hostname()
  } catch {
    // No hostname to accept.
  }
  if (own) names.add(own.toLowerCase())
  const addresses = []
  for (const [adapter, list] of Object.entries(interfaces)) {
    for (const info of list ?? []) {
      if (info.internal) continue
      const ip = info.address
      if (!ip || ip.startsWith('fe80')) continue
      names.add(ip.toLowerCase())
      const v6 = info.family === 'IPv6' || info.family === 6
      const kind = addressKind(adapter, ip)
      addresses.push({ host: v6 ? `[${ip}]` : ip, adapter, kind, primary: !v6 && ['wifi', 'wired', 'tailscale'].includes(kind) })
    }
  }
  addresses.sort((a, b) => Number(b.primary) - Number(a.primary) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || Number(a.host.startsWith('[')) - Number(b.host.startsWith('[')))
  return { names, addresses }
}

export function hostAllowed(header, { lan, names }) {
  const name = hostOf(header)
  if (name === '127.0.0.1' || name === 'localhost' || name === '::1') return true
  return Boolean(lan) && names.has(name)
}

export function readCookie(header, key) {
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === key) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return ''
}

export function tokensEqual(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * The access cookie's name, one per server (by its token): a browser keeps cookies by host, not port, so two
 * servers on one machine (personal and release) would otherwise sign each other's phones out.
 */
export function cookieName(token) {
  return `tavern_key_${createHash('sha256').update(String(token)).digest('hex').slice(0, 8)}`
}

export function accessCookie(token) {
  return `${cookieName(token)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`
}

/** Whether a request's cookies hold this server's token: under its own name, or the plain one set before (and by the phone app). */
export function signedIn(header, token) {
  return tokensEqual(readCookie(header, cookieName(token)), token) || tokensEqual(readCookie(header, 'tavern_key'), token)
}

/** Gate page for a phone that does not have the cookie yet. No external requests. */
/** @param appName - the edition's name (edition.mjs). */
export function loginPage(appName = 'CicaTavern') {
  const token = msg`口令`
  return `<!doctype html>
<html lang="${currentLanguage() === 'en' ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="${appName}">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <title>${appName}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #eceeea; color: #1c2427; font: 16px/1.6 "Songti SC", "Noto Serif SC", serif; }
    @media (prefers-color-scheme: dark) { body { background: #0f1417; color: #e6ecee; } }
    main { width: min(420px, calc(100% - 40px)); }
    h1 { font-weight: 500; font-size: 22px; margin: 0 0 8px; }
    p { margin: 0 0 16px; color: #5d6a6d; }
    input { width: 100%; box-sizing: border-box; font: inherit; padding: 10px 12px; border: 1px solid #d3d9d4; border-radius: 10px; background: transparent; color: inherit; }
    button { margin-top: 12px; font: inherit; padding: 8px 16px; border-radius: 999px; border: 0; background: #2b5869; color: #f7f8f5; }
    @media (prefers-color-scheme: dark) { input { border-color: #273238; } p { color: #93a1a4; } }
    .err { color: #b0413a; min-height: 1.6em; }
  </style>
</head>
<body>
  <main>
    <h1>${appName}</h1>
    <p>${msg`用电脑上设置里给出的链接打开，或把链接末尾的口令粘贴到这里。`}</p>
    <form id="gate">
      <input name="token" autocomplete="off" placeholder="${token}" aria-label="${token}">
      <button type="submit">${msg`进入`}</button>
      <p class="err" id="err"></p>
    </form>
  </main>
  <script>
    const form = document.getElementById('gate')
    const err = document.getElementById('err')
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('k')
    if (fromHash) form.token.value = fromHash
    form.addEventListener('submit', async event => {
      event.preventDefault()
      err.textContent = ''
      const res = await fetch('/api/access/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' },
        body: JSON.stringify({ token: form.token.value.trim() }),
      })
      if (!res.ok) { err.textContent = ${JSON.stringify(msg`口令不对`)}; return }
      // In iPhone Safari the link keeps its key, so「添加到主屏幕」saves one that opens without asking again.
      const keepKey = /iP(hone|od|ad)/.test(navigator.userAgent) && !navigator.standalone
      location.replace(keepKey ? location.pathname + location.hash : location.pathname)
    })
    if (fromHash) (form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })))
  </script>
</body>
</html>`
}
