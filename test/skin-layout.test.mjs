// 定制外观 in a real browser: looks that try to move the bar's blocks (the icons lifted to a corner, the phone laid
// over the rest, the bar turned into a grid: what cards made in 创作角色卡 came out with) are drawn with the page's own
// style sheet and scripts, at a phone's width and a desk's, in a dark set of colors and a light one, and measured.
// Needs Chrome or Edge on this machine (CHROME_PATH says where, else the usual places); skipped where there is none.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }

function browserPath() {
  const env = process.env
  const places = [
    env.CHROME_PATH,
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  return places.find(place => place && existsSync(place)) ?? ''
}

// A bar with 小手机 on: three things on its face, three apps (two pages and a list).
const SPEC = {
  title: '御兽日志',
  phone: true,
  fields: [
    { path: '主角.体力', label: '体力', show: 'meter', min: 0, max: 100, page: '主页' },
    { path: '主角.等级', label: '等级', show: 'number', page: '主页' },
    { path: '主角.称号', label: '称号', show: 'badge', page: '主页' },
    { path: '宠兽.小焰.亲密', label: '亲密', show: 'meter', min: 0, max: 100, page: '宠兽' },
    { path: '宠兽.小焰.属性', label: '属性', show: 'tags', page: '宠兽' },
    { path: '宠兽.小焰.状态', label: '状态', show: 'text', page: '宠兽' },
    { path: '关系.林晚.好感', label: '好感', show: 'meter', min: 0, max: 100, page: '关系' },
    { path: '关系.林晚.态度', label: '态度', show: 'badge', page: '关系' },
    { path: '背包', label: '背包', show: 'list', page: '主页' },
  ],
}
const STATE = { 主角: { 体力: 72, 等级: 5, 称号: '见习御兽师' }, 宠兽: { 小焰: { 亲密: 40, 属性: ['火', '幼年'], 状态: '精神很好，围着你转' } }, 关系: { 林晚: { 好感: 35, 态度: '友善' } }, 背包: ['精灵球 ×3', '伤药', '旧地图'] }
const PALETTES = { dark: { bg: '#0d1220', ink: '#e8eefc', accent: '#4f9dff' }, light: { bg: '#f7f5f2', ink: '#2a2422', accent: '#e8483a' } }
// What a look is like when it dresses and leaves things where they are.
const DRESS = `.status-bar { border-radius: 18px; border: 1px solid var(--line-soft) }
.status-app-icon { background: var(--accent); color: var(--surface); border-radius: 12px }
.status-phone-frame { border: 2px solid var(--accent) }
.status-phone-head { background: var(--accent) }
.status-phone-name { color: var(--surface); font-size: 18px }`
// Each of these moved something before the page held it in place.
const MOVES = {
  plain: '',
  'icons lifted to the corner': '.status-dock { position: absolute; top: 10px; right: 12px; margin: 0; padding: 0; border: 0 }',
  'phone lifted over the bar': '.status-phone { position: absolute; top: 60px; left: 16px; right: 120px } .status-dock { justify-content: flex-end }',
  'bar as a grid': '.status-bar { display: grid; grid-template-columns: 1fr auto; gap: 12px } .status-head { grid-column: 1 / -1 } .status-dock { grid-column: 2; grid-row: 2; flex-direction: column; border: 0 } .status-phone { grid-column: 1; grid-row: 2 } .status-body { grid-column: 1 }',
  'bar as a row': '.status-bar { display: flex; flex-wrap: wrap } .status-dock { order: -1; float: right } .status-phone { transform: translate(40px, -80px) }',
  'phone shown as a block': '.status-phone { display: block; width: 240px; float: right } .status-phone-frame { position: absolute; right: 0; top: 0 }',
  'foot bar restyled': '.status-phone-home { position: relative; left: 30%; width: 40%; height: 8px; transform: scale(1.1); border: 2px solid var(--accent) } .status-phone-frame { padding: 14px 12px 30px; width: 100% }',
  'the head let out to both edges': '.status-bar { padding: 16px } .status-head { margin: -16px -16px 12px; padding: 12px 16px; border-bottom: 1px solid var(--line-soft) }',
  'title strip let out':'.status-phone-head { margin: 6px -10px 12px; padding: 14px 22px }',
  'bar wider than its place': '.status-bar { width: 100%; margin: 12px 8px; min-width: 420px }',
}
// What still can go wrong, and must be said by the check a new look goes through (web/card-check.js skinProblems).
const CAUGHT = {
  'icons pulled up over the rows': ['.status-dock { margin-top: -70px }', /叠在了一起/],
  'a box round a group, pushed aside': ['.status-phone-screen .status-group { border: 1px solid var(--line-soft); margin-right: 22px }', /status-group 左右没有对齐/],
  'the head let out on one side only': ['.status-head { margin-left: -16px; margin-right: 12px; border-bottom: 1px solid var(--line-soft) }', /status-head 左右没有对齐/],
  'two columns kept at any width': ['.status-body { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 16px }', /进度条被挤得只剩/],
  'title strip off to one side':['.status-phone-head { margin-left: -24px; margin-right: 18px; background: var(--accent) }', /左右没有对齐/],
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><script type="module">
import { statusBar } from '/status.js'
import { cleanStatusSpec } from '/shared/status.js'
import { skinProblems } from '/card-check.js'
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'html') node.innerHTML = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of [].concat(children)) if (child) node.append(child)
  return node
}
const box = (node, origin) => { const r = node.getBoundingClientRect(); return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top } }
window.run = ({ spec, state, looks, palettes, widths }) => {
  const out = []
  for (const [name, css] of Object.entries(looks)) for (const [tone, palette] of Object.entries(palettes)) for (const width of widths) {
    const worn = cleanStatusSpec({ ...spec, palette, skin: { name, css } })
    const host = el('div', { class: 'skin-probe', style: 'width:' + width + 'px' })
    document.body.append(host)
    const bar = statusBar(el, worn, state, { collapsible: true, remembers: false })
    host.append(bar)
    const closed = getComputedStyle(bar.querySelector('.status-phone')).display
    const shots = []
    for (const app of bar.querySelectorAll('.status-app')) {
      app.click()
      const origin = bar.getBoundingClientRect()
      const part = cls => { const node = bar.querySelector(cls); return node ? box(node, origin) : null }
      shots.push({
        app: app.textContent, width: origin.width, hostWidth: host.getBoundingClientRect().width,
        blocks: [...bar.children].filter(node => !node.hidden && !node.classList.contains('drift')).map(node => ({ name: node.classList[0], ...box(node, origin) })),
        frame: part('.status-phone-frame'), home: part('.status-phone-home'), head: part('.status-phone-head'), toggle: part('.status-toggle'),
        apps: [...bar.querySelectorAll('.status-app')].map(node => box(node, origin)),
      })
    }
    host.remove()
    out.push({ name, tone, width, closed, shots, problems: skinProblems(el, worn, state) })
  }
  return out
}
// 版式: the bar laid out the three other ways, each at the widths asked, every tab opened.
window.layouts = ({ spec, state, widths, skin }) => {
  const out = []
  for (const layout of ['card', 'rail', 'scroll']) for (const width of widths) {
    const worn = cleanStatusSpec({ ...spec, phone: false, layout, ...(skin ? { palette: { bg: '#f7f5f2', ink: '#2a2422', accent: '#e8483a' }, skin: { name: 'x', css: skin } } : {}) })
    const host = el('div', { class: 'skin-probe', style: 'width:' + width + 'px' })
    document.body.append(host)
    const bar = statusBar(el, worn, state, { collapsible: true, remembers: false })
    host.append(bar)
    const shots = []
    for (const tab of bar.querySelectorAll('.status-page')) {
      tab.click()
      const origin = bar.getBoundingClientRect()
      const part = cls => { const node = bar.querySelector(cls); return node && !node.hidden ? box(node, origin) : null }
      shots.push({ tab: tab.textContent, width: origin.width, hostWidth: host.getBoundingClientRect().width, scroll: bar.scrollWidth - bar.clientWidth, rail: part('.status-rail'), main: part('.status-main'), body: part('.status-body'), gauges: [...bar.querySelectorAll('.status-gauge .status-meter')].map(node => node.getBoundingClientRect().width) })
    }
    host.remove()
    out.push({ layout, width, shots, classes: bar.className, problems: skinProblems(el, worn, state) })
  }
  return out
}
window.ready = true
</script></body></html>`

/** A page of the browser to ask things of: { evaluate(expression), close() }. */
async function openPage(url) {
  const profile = await mkdtemp(path.join(tmpdir(), 'skin-layout-'))
  const child = spawn(browserPath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--window-size=1200,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const close = async () => {
    child.kill()
    await new Promise(resolve => (child.exitCode === null ? child.once('exit', resolve) : resolve()))
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let text = ''
      const timer = setTimeout(() => reject(new Error('the browser did not say where to reach it')), 30000)
      child.stderr.on('data', chunk => {
        text += chunk
        const found = /DevTools listening on (ws:\/\/\S+)/.exec(text)
        if (found) {
          clearTimeout(timer)
          resolve(found[1])
        }
      })
      child.once('exit', () => reject(new Error('the browser closed before it could be reached')))
    })
    const socket = new WebSocket(endpoint)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('no connection to the browser')), { once: true })
    })
    let last = 0
    const waiting = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      const asked = waiting.get(message.id)
      if (!asked) return
      waiting.delete(message.id)
      if (message.error) asked.reject(new Error(message.error.message))
      else asked.resolve(message.result)
    })
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      last += 1
      waiting.set(last, { resolve, reject })
      socket.send(JSON.stringify({ id: last, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
    const { targetId } = await send('Target.createTarget', { url })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const evaluate = async expression => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
      return result.value
    }
    return { evaluate, close: async () => { socket.close(); await close() } }
  } catch (error) {
    await close()
    throw error
  }
}

const lapped = (a, b) => Math.min(Math.min(a.right, b.right) - Math.max(a.left, b.left), Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

test('a look cannot move the bar\'s blocks, the phone or its parts (drawn in a browser)', { skip: browserPath() ? false : 'no Chrome or Edge on this machine', timeout: 120000 }, async () => {
  const server = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://x').pathname
    if (name === '/layout.html') return response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
    const file = path.join(WEB, path.normalize(name))
    if (!file.startsWith(WEB)) return response.writeHead(403).end()
    const body = await readFile(file).catch(() => null)
    if (!body) return response.writeHead(404).end()
    response.writeHead(200, { 'content-type': `${TYPES[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8` }).end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const page = await openPage(`http://127.0.0.1:${server.address().port}/layout.html`)
  try {
    // Asked again till the page is there: while it is still loading, what is asked of the blank one before it is lost.
    const till = Date.now() + 30000
    for (;;) {
      if (await page.evaluate('window.ready === true').catch(() => false)) break
      assert.ok(Date.now() < till, 'the page did not load')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const ask = looks => page.evaluate(`window.run(${JSON.stringify({ spec: SPEC, state: STATE, looks, palettes: PALETTES, widths: [340, 720] })})`)
    const held = await ask(Object.fromEntries(Object.entries(MOVES).map(([name, css]) => [name, `${DRESS}\n${css}`])))
    assert.equal(held.length, Object.keys(MOVES).length * 4)
    for (const drawn of held) {
      const where = `${drawn.name} / ${drawn.tone} / ${drawn.width}px`
      assert.equal(drawn.closed, 'none', `${where}: the phone shows before any app is opened`)
      assert.equal(drawn.shots.length, 3, `${where}: three apps to open`)
      for (const shot of drawn.shots) {
        const at = `${where} / ${shot.app}`
        assert.ok(shot.width <= shot.hostWidth + 1, `${at}: the bar is ${shot.width}px wide in a place of ${shot.hostWidth}px`)
        assert.deepEqual(shot.blocks.map(block => block.name), ['status-head', 'status-body', 'status-dock', 'status-phone'], `${at}: the blocks`)
        shot.blocks.forEach((block, i) => {
          assert.ok(block.left >= -1 && block.right <= shot.width + 1, `${at}: .${block.name} sticks out sideways (${block.left} to ${block.right} of ${shot.width})`)
          const next = shot.blocks[i + 1]
          if (next) assert.ok(next.top >= block.bottom - 1, `${at}: .${next.name} starts at ${next.top}, before .${block.name} ends at ${block.bottom}`)
        })
        const [dock, phone] = [shot.blocks[2], shot.blocks[3]]
        assert.ok(shot.frame.top >= dock.bottom - 1, `${at}: the phone is over the icons`)
        assert.ok(shot.apps.every(app => lapped(app, shot.toggle) <= 1), `${at}: an icon is over 收起`)
        // The phone from the left of its row (where the icons start) and inside it, its foot bar in the middle of the phone.
        assert.ok(Math.abs(shot.frame.left - phone.left) <= 1 && shot.frame.right <= phone.right + 1, `${at}: the phone does not start at the left of its row (${shot.frame.left - phone.left} in, ${phone.right - shot.frame.right} to spare)`)
        assert.ok(Math.abs(shot.frame.left - dock.left) <= 1, `${at}: the phone and the icons start ${shot.frame.left - dock.left}px apart`)
        assert.ok(Math.abs((shot.home.left - shot.frame.left) - (shot.frame.right - shot.home.right)) <= 2, `${at}: the foot bar is not in the middle (${shot.home.left - shot.frame.left} / ${shot.frame.right - shot.home.right})`)
        assert.ok(shot.home.top >= shot.head.bottom - 1 && shot.home.bottom <= shot.frame.bottom + 1, `${at}: the foot bar is not at the foot of the phone`)
      }
      assert.deepEqual(drawn.problems.filter(line => /叠在了一起|顺序反了|左右没有对齐|伸到了边框外面|伸出了状态栏|伸出去了|撑开了/.test(line)), [], `${where}: the check`)
    }
    // 版式: three more ways the bar is laid out. Each fits its place at both widths with every tab opened, and the check
    // has nothing to say of them, bare or under a look that only dresses.
    for (const skin of ['', '.status-bar { border: 1px solid var(--line-soft) } .status-gauge { letter-spacing: .02em }']) {
      const laid = await page.evaluate(`window.layouts(${JSON.stringify({ spec: SPEC, state: STATE, widths: [340, 720], skin })})`)
      assert.equal(laid.length, 6)
      for (const drawn of laid) {
        const where = `${drawn.layout} / ${drawn.width}px${skin ? ' / dressed' : ''}`
        assert.ok(drawn.classes.includes(`layout-${drawn.layout}`), `${where}: not laid out (${drawn.classes})`)
        assert.equal(drawn.shots.length, 3, `${where}: three tabs`)
        for (const shot of drawn.shots) {
          const at = `${where} / ${shot.tab}`
          assert.ok(shot.width <= shot.hostWidth + 1 && shot.scroll <= 1, `${at}: the bar is ${shot.width}px wide in a place of ${shot.hostWidth}px (${shot.scroll}px to scroll)`)
          for (const name of ['rail', 'main']) assert.ok(shot[name] && shot[name].left >= -1 && shot[name].right <= shot.width + 1, `${at}: the ${name} sticks out`)
          // Beside each other where there is room (侧栏式 at a desk's width), else one under the other.
          const beside = shot.main.left >= shot.rail.right - 1
          assert.equal(beside, drawn.layout === 'rail' && drawn.width === 720, `${at}: the rail and the tabs are ${beside ? 'beside' : 'under'} each other`)
          if (!beside) assert.ok(shot.main.top >= shot.rail.bottom - 1, `${at}: the tabs lie over the rail`)
          assert.ok(shot.gauges.every(wide => wide >= 80), `${at}: a gauge of ${Math.min(...shot.gauges)}px`)
        }
        assert.deepEqual(drawn.problems, [], `${where}: the check`)
      }
    }
    const told = await ask(Object.fromEntries(Object.entries(CAUGHT).map(([name, [css]]) => [name, `${DRESS}\n${css}`])))
    for (const drawn of told) assert.ok(drawn.problems.some(line => CAUGHT[drawn.name][1].test(line)), `${drawn.name} / ${drawn.tone} / ${drawn.width}px: not said (${drawn.problems.join(' | ') || 'nothing'})`)
  } finally {
    await page.close()
    await new Promise(resolve => server.close(resolve))
  }
})
