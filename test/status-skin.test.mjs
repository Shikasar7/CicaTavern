// 状态栏 → 定制外观: a look a model writes for one card's bar as CSS. What may stay of it and how it is kept to the
// bar (web/shared/status.js), what the model is asked and how its answer is read (server/forge/skin.mjs), and the
// draft asked for, saved with the bar, taken back and exported over HTTP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard, sillyTavernCard } from '../server/cards.mjs'
import { STATUS_TUNE } from '../server/forge/check.mjs'
import { editRequest, readEdit } from '../server/forge/edit.mjs'
import { barOutline, readSkin, skinRequest } from '../server/forge/skin.mjs'
import { statusBarHtml, statusLines } from '../server/forge/status.mjs'
import { MAX_SKIN, cleanSkinCss, cleanStatusSpec, paletteColors, scopedSkinCss, skinClass, triedExtreme, withTried } from '../web/shared/status.js'

const BOOK = { entries: [{ id: 0, comment: '[InitVar]初始变量', content: '林小雨:\n  好感: 10\n  心情: 平静\n体力: 50', keys: [], constant: true, enabled: false }] }
const FIELDS = [{ path: '林小雨.好感', label: '好感', show: 'meter', min: 0, max: 100 }, { path: '林小雨.心情', label: '心情', show: 'badge' }, { path: '体力', label: '体力', show: 'number' }]
const BAR = { title: '雨宿', theme: 'paper', fields: FIELDS }
const CSS = `.status-bar { border-radius: 4px; border: 1px solid var(--accent); background: linear-gradient(180deg, var(--surface), #0b1218) }
.status-title::before { content: "◆ " }
.status-row[data-label="好感"] .status-meter > i { background: #c8553d }
@keyframes breathe { from { opacity: .8 } to { opacity: 1 } }
.status-badge { animation: breathe 3s ease-in-out infinite alternate }
@media (max-width: 480px) { .status-rows.wide { grid-template-columns: 1fr } }`
const PALETTE = { bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' }
const ANSWER = `<reply>雨夜的橱窗：深色的底，琥珀色的灯。</reply>\n<name>雨夜橱窗</name>\n<palette>${JSON.stringify(PALETTE)}</palette>\n<css>\n${CSS}\n</css>`
const cardWith = (extra = {}) => normalizeCard({ spec: 'chara_card_v2', data: { name: '林小雨', description: '只在雨夜出现的女孩。', first_mes: '雨又下起来了。', tags: ['都市', '安静'], character_book: BOOK, ...extra } })
const withBar = (bar = BAR) => Object.assign(cardWith(), { statusBar: cleanStatusSpec(bar) })

test('only what may dress the bar stays, a rule a line, the same when cleaned again', () => {
  const clean = cleanSkinCss(`/* 说明 */
@import url("https://example.com/x.css");
@font-face { font-family: x; src: url(x.woff) }
.status-bar { border-radius: 4px; background: linear-gradient(180deg, var(--surface), color-mix(in srgb, var(--surface) 80%, #000)) !important; position: fixed; z-index: 9 }
.status-title::after { content: "\\2726 { } url(x)"; margin-left: calc((1em + 2px) * 2) }
.status-row[data-label="生命"] .status-meter > i { background: #c33; background-image: url(http://x/y.png); width: 50% }
.status-meter { height: 8px; b\\65havior: x; background: image-set("a.png" 1x); cursor: URL( x ) }
.status-tag { transform: rotate(-2deg) scale(1.02); filter: drop-shadow(0 1px 1px rgba(0,0,0,.3)) }
.nested { color: red; .inner { color: blue } }
.status-page[aria-selected="true"] { background: var(--accent) }`)
  assert.deepEqual(clean.split('\n'), [
    '.status-bar { border-radius: 4px; background: linear-gradient(180deg, var(--surface), color-mix(in srgb, var(--surface) 80%, #000)); z-index: 9 }',
    '.status-title::after { content: "\\2726 { } url(x)"; margin-left: calc((1em + 2px) * 2) }',
    '.status-row[data-label="生命"] .status-meter > i { background: #c33; width: 50% }',
    '.status-meter { height: 8px }',
    '.status-tag { transform: rotate(-2deg) scale(1.02); filter: drop-shadow(0 1px 1px rgba(0,0,0,.3)) }',
    '.status-page[aria-selected="true"] { background: var(--accent) }',
  ])
  assert.equal(cleanSkinCss(clean), clean)
  assert.equal(cleanSkinCss(CSS), CSS, 'the look the tests use is all allowed')
  // Nothing left is no look at all.
  assert.equal(cleanSkinCss('body { display: none } @import "x"; .a { background: url(x) }'), '')
  assert.equal(cleanSkinCss('.status-bar { color: red'), '', 'a rule that never closes')
  assert.equal(cleanSkinCss(null), '')
})

test('a selector reaches the bar and what is in it, never the page or what stands beside the bar', () => {
  const kept = text => cleanSkinCss(`${text} { color: red }`)
  for (const selector of ['html', 'body .status-row', ':root', '.status-bar + div', '.status-bar ~ p', '.status-bar:not(.a .b) ~ p', '.status-bar[data-x="a b"] + p', '+ .status-row', '~ p', 'iframe', '.a::backdrop', '&.x']) {
    assert.equal(kept(selector), '', selector)
  }
  for (const selector of ['.status-bar', '.status-bar.collapsed .status-head', '.status-bar:hover > .status-head', '.status-row + .status-row', '.status-row:not(.block) ~ .status-row', '.status-body', '> .status-head', '.status-row[data-label="a + b"]']) {
    assert.equal(kept(selector), `${selector} { color: red }`, selector)
  }
  assert.equal(kept('html, .status-title, body'), '.status-title { color: red }', 'the rest of a list stays')
  // Loaded, every rule begins at the bar that wears the look; its movements have names of their own.
  const scope = skinClass(CSS)
  assert.match(scope, /^skin-[0-9a-f]{8}$/)
  const lines = scopedSkinCss(CSS).split('\n')
  assert.equal(lines[0], `.${scope}.status-bar { border-radius: 4px; border: 1px solid var(--accent); background: linear-gradient(180deg, var(--surface), #0b1218) }`)
  assert.equal(lines[1], `.${scope} .status-title::before { content: "◆ " }`)
  assert.equal(lines[3], `@keyframes ${scope}-breathe { from { opacity: .8 } to { opacity: 1 } }`)
  assert.equal(lines[4], `.${scope} .status-badge { animation: ${scope}-breathe 3s ease-in-out infinite alternate }`)
  assert.equal(lines[5], `@media (max-width: 480px) { .${scope} .status-rows.wide { grid-template-columns: 1fr } }`)
  assert.equal(scopedSkinCss('.status-row, .status-bar .status-tag { color: red }', 'skin-x'), '.skin-x .status-row, .skin-x.status-bar .status-tag { color: red }')
  // A movement named like a word of the line it is used in could not be told from it.
  assert.equal(cleanSkinCss('@keyframes linear { from { opacity: 0 } to { opacity: 1 } }'), '')
  assert.notEqual(skinClass(CSS), skinClass(`${CSS} `))
})

test('a look is long only so far, and quick to clean', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `.status-row:nth-child(${i}) { color: #${String(i).padStart(6, '0')} }`).join('\n')
  const kept = cleanSkinCss(big)
  assert.ok(kept.length <= MAX_SKIN)
  assert.ok(kept.split('\n').length <= 300)
  assert.equal(cleanSkinCss(kept), kept)
})

test('the bar keeps its look in place of a theme; a look with nothing in it is none', () => {
  const spec = cleanStatusSpec({ ...BAR, palette: PALETTE, skin: { name: '雨夜橱窗', css: `${CSS}\nbody { display: none }`, more: 1 } })
  assert.deepEqual(spec.skin, { name: '雨夜橱窗', css: CSS })
  assert.equal(spec.theme, undefined)
  assert.deepEqual(spec.palette, PALETTE)
  assert.equal(cleanStatusSpec({ ...BAR, skin: { css: 'html { color: red }' } }).theme, 'paper')
  assert.equal(cleanStatusSpec({ ...BAR, skin: { css: 'html { color: red }' } }).skin, undefined)
  assert.equal(cleanStatusSpec({ ...BAR, skin: 'x' }).skin, undefined)
  // Cleaned again, the same.
  assert.deepEqual(cleanStatusSpec(spec), spec)
  // The bar's green and red are those that read on its own background, not the page's.
  assert.deepEqual([paletteColors(PALETTE).ok, paletteColors(PALETTE).bad], ['#6fbf93', '#e57b70'])
  assert.deepEqual([paletteColors({ bg: '#f3e9cf', ink: '#3a2a16', accent: '#a8322a' }).ok, paletteColors({ bg: '#f3e9cf', ink: '#3a2a16', accent: '#a8322a' }).bad], ['#2f7a55', '#b0413a'])
})

test('the model is told the card, the bar as it starts, and what is wanted', () => {
  const card = withBar()
  const state = { 林小雨: { 好感: 10, 心情: '平静' }, 体力: 50 }
  assert.equal(barOutline(card.statusBar, state), '标题：雨宿\n林小雨\n  好感 · meter · 10\n  心情 · badge · 平静\n（不分组）\n  体力 · number · 50')
  const plain = skinRequest(card, card.statusBar, state)
  assert.match(plain.system, /你只写 CSS/)
  assert.match(plain.system, /\.status-row\[data-show="显示方式"\]\[data-label="短名"\]/)
  assert.match(plain.system, /<palette>\{"bg"/)
  const content = plain.messages[0].content
  assert.match(content, /<card name="林小雨">\n标签：都市、安静\n只在雨夜出现的女孩。/)
  assert.match(content, /开场白的开头：雨又下起来了。/)
  assert.match(content, /用户没有说想要什么样子，按这张卡的气氛定。$/)
  assert.match(skinRequest(card, card.statusBar, state, { wish: '像一张借书卡' }).messages[0].content, /用户想要的样子：像一张借书卡$/)
  // From a look: changed as asked, another unlike it, or put right.
  const previous = { name: '雨夜橱窗', palette: PALETTE, css: CSS }
  const changed = skinRequest(card, card.statusBar, state, { wish: '边框细一点', previous }).messages[0].content
  assert.match(changed, /<current name="雨夜橱窗">\n<palette>\{"bg":"#101820"/)
  assert.ok(changed.includes(CSS))
  assert.match(changed, /用户想在它的基础上改：边框细一点$/)
  assert.match(skinRequest(card, card.statusBar, state, { previous }).messages[0].content, /再设计一版，和它明显不同。$/)
  const mended = skinRequest(card, card.statusBar, state, { previous, problems: ['宽 340 像素时，.status-tag 横向伸出了状态栏'] }).messages[0].content
  assert.match(mended, /把它们改掉，其余的保持原样，再把四段完整写一遍：\n- 宽 340 像素时，\.status-tag 横向伸出了状态栏$/)
  // Pages are said, a page at a time.
  const paged = cleanStatusSpec({ fields: [{ ...FIELDS[0], page: '人物' }, { ...FIELDS[2], page: '自己' }] })
  assert.equal(barOutline(paged, state), '分页：人物、自己\n[人物]\n  林小雨\n    好感 · meter · 10\n[自己]\n  （不分组）\n    体力 · number · 50')
})

test('an answer is read as a look; what it may not have is taken out and said', () => {
  const read = readSkin(ANSWER)
  assert.deepEqual(read, { reply: '雨夜的橱窗：深色的底，琥珀色的灯。', name: '雨夜橱窗', palette: PALETTE, effect: '', css: CSS, cut: [] })
  // In a fence, with things it was told not to write.
  const fenced = readSkin('<name>「旧报纸」</name>\n<css>\n```css\n@import url(x);\n.status-bar { position: fixed; background: url(x.png) #eee; color: #222 }\n.status-title { color: #111 }\n```\n</css>', { palette: PALETTE })
  assert.equal(fenced.name, '旧报纸')
  assert.equal(fenced.css, '.status-bar { color: #222 }\n.status-title { color: #111 }')
  assert.deepEqual(fenced.cut, ['url', 'import', 'fixed'])
  assert.deepEqual(fenced.palette, PALETTE, 'no colors written: those it had')
  assert.deepEqual(readSkin('<css>.status-bar { color: red }</css>').palette, { bg: '#f7f8f5', ink: '#1c2427', accent: '#2b5869' })
  // Colors that cannot be read on each other are put right as any palette is.
  assert.equal(readSkin('<palette>{"bg": "#101010", "ink": "#151515", "accent": "#e0a030"}</palette><css>.status-bar { color: red }</css>').palette.ink, '#f5f5f5')
  // Cut off before the end, what was whole stays.
  assert.equal(readSkin('<css>\n.status-bar { color: red }\n.status-title { color: bl').css, '.status-bar { color: red }')
  assert.equal(readSkin('<reply>我做不了。</reply>'), null)
  assert.equal(readSkin('<css>body { color: red }</css>'), null)
})

test('a look is told from another in the lines, goes into SillyTavern\'s copy and stays out of what 对话修改 reads', () => {
  const skinned = cleanStatusSpec({ ...BAR, palette: PALETTE, skin: { name: '雨夜橱窗', css: CSS } })
  const lines = statusLines(skinned)
  assert.match(lines, new RegExp(`^标题: 雨宿\\n定制外观: 雨夜橱窗 \\(${skinClass(CSS).slice(5)}\\)\\n配色: `))
  assert.notEqual(lines, statusLines({ ...skinned, skin: { name: '雨夜橱窗', css: `${CSS}\n.status-tag { color: red }` } }))
  // SillyTavern's copy wears it too (test/status-frame.test.mjs); without a look it is the small bar with the colors.
  const html = statusBarHtml(skinned)
  assert.ok(html.includes(`.${skinClass(CSS)}.status-bar { border-radius: 4px;`))
  assert.match(html, /@keyframes \S*breathe/)
  const { skin: _, ...plain } = skinned
  assert.doesNotMatch(statusBarHtml(plain), /breathe|skin/)
  assert.match(statusBarHtml(plain), /--bg:#101820/)
  const card = Object.assign(cardWith(), { statusBar: skinned })
  const content = editRequest(card, { text: '体力也显示出来', state: {} }).request.messages[0].content
  assert.doesNotMatch(content, /breathe/)
  assert.match(content, /（这张卡的状态栏有一套定制外观「雨夜橱窗」，改布局时程序会原样留着，不用写；写了 theme 就会换掉它。）/)
  // A layout written again keeps the look; a theme written takes its place.
  const kept = readEdit('<status_bar>{"fields": [{"path": "体力", "label": "体力", "show": "number"}]}</status_bar>', card).changes[0].spec
  assert.deepEqual(kept.skin, skinned.skin)
  assert.deepEqual(kept.palette, PALETTE)
  const themed = readEdit('<status_bar>{"theme": "ink", "fields": [{"path": "体力", "show": "number"}]}</status_bar>', card).changes[0].spec
  assert.equal(cleanStatusSpec(themed).skin, undefined)
  assert.equal(cleanStatusSpec(themed).theme, 'ink')
})

test('试数值: the preview\'s variables with some of them another way, the state itself left alone', () => {
  const state = { 林小雨: { 好感: 10, 心情: '平静', 随身: ['伞'] }, 体力: 50, 淋过雨: false, 进度: 2, 背包: { 伞: { 数量: 1 } } }
  const spec = cleanStatusSpec({ fields: [
    { path: '林小雨.好感', show: 'meter', min: 0, max: 100 },
    { path: '林小雨.心情', show: 'badge' },
    { path: '林小雨.随身', show: 'tags' },
    { path: '体力', show: 'meter', min: 10, max: 80 },
    { path: '淋过雨', show: 'flag' },
    { path: '进度', show: 'rating', max: 5 },
    { path: '背包', show: 'table' },
    { path: '没有的', show: 'meter', min: 0, max: 9 },
    { path: '林小雨.藏着', show: 'hidden' },
  ] })
  assert.deepEqual(triedExtreme(spec, state, 'full'), { '林小雨.好感': 100, 体力: 80, 淋过雨: true, 进度: 5 })
  assert.deepEqual(triedExtreme(spec, state, 'low'), { '林小雨.好感': 0, '林小雨.随身': [], 体力: 10, 淋过雨: false, 进度: 0 })
  const tried = withTried(state, { '林小雨.好感': 100, '林小雨.心情': '开心', '新来的.好感': 5, '__proto__.x': 1 })
  assert.deepEqual(tried.林小雨, { 好感: 100, 心情: '开心', 随身: ['伞'] })
  assert.deepEqual(tried.新来的, { 好感: 5 })
  assert.equal({}.x, undefined)
  assert.equal(state.林小雨.好感, 10, 'the state given is not changed')
  assert.deepEqual(withTried(null, null), {})
})

async function fakeModel() {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(json)
    const user = json.messages.at(-1).content
    const text = user.includes('把它们改掉') ? ANSWER.replace('雨夜橱窗', '雨夜橱窗·改') : user.includes('做不出来') ? '<reply>我做不了。</reply>' : ANSWER
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

async function tavern(t, card) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-status-skin-'))
  const model = await fakeModel()
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    model.close()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await app.store.saveCard(card)
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const url = `/api/cards/${card.id}/check/skin`
  const ask = async body => {
    let view = (await call(url, { method: 'POST', body })).body
    for (let i = 0; i < 200 && view.job; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      view = (await call(url)).body
    }
    return view
  }
  const withModel = async () => {
    const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `${model.base}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
    await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  }
  return { call, ask, url, model, withModel, card: () => app.store.getCard(card.id) }
}

test('a look is asked for, kept as a draft, saved with the bar, taken back and dropped', async t => {
  const card = withBar()
  const { call, ask, url, model, withModel, card: saved } = await tavern(t, card)

  // Nothing is sent to read the page; without a model it says so.
  const before = (await call(url)).body
  assert.equal(before.skin, null)
  assert.equal(before.estimate.ready, false)
  assert.equal(model.seen.length, 0)
  await withModel()
  const ready = (await call(url)).body
  assert.equal(ready.estimate.ready, true)
  assert.ok(ready.estimate.input > 500 && ready.estimate.output > 0)
  assert.equal(model.seen.length, 0)

  // Asked: a draft, nothing in the card.
  const spec = { ...BAR, fields: FIELDS.slice(0, 2) }
  const drafted = await ask({ spec, wish: '雨夜的橱窗' })
  assert.equal(drafted.error, '')
  assert.deepEqual({ name: drafted.skin.name, palette: drafted.skin.palette, css: drafted.skin.css, fixed: drafted.skin.fixed, wish: drafted.skin.wish }, { name: '雨夜橱窗', palette: PALETTE, css: CSS, fixed: false, wish: '雨夜的橱窗' })
  assert.equal(model.seen.length, 1)
  const sent = model.seen[0].messages.at(-1).content
  assert.match(sent, /用户想要的样子：雨夜的橱窗/)
  assert.doesNotMatch(sent, /体力 · number/, 'designed for the bar as the editor has it')
  assert.equal((await saved()).statusBar.skin, undefined)
  // What 检查这张卡 shows is not disturbed by it.
  const check = (await call(`/api/cards/${card.id}/check`)).body
  assert.equal(check.job, null)
  assert.equal(check.error, null)

  // What drawing it showed goes back with the look itself.
  const mended = await ask({ spec, previous: drafted.skin, problems: ['宽 340 像素时，.status-tag 横向伸出了状态栏', 7, ''] })
  assert.equal(mended.skin.fixed, true)
  assert.equal(mended.skin.name, '雨夜橱窗·改')
  assert.match(model.seen[1].messages.at(-1).content, /<current name="雨夜橱窗">[\s\S]*- 宽 340 像素时，\.status-tag 横向伸出了状态栏$/)

  // Saved with the bar through 检查这张卡's taking in, so it can be taken back.
  const worn = { ...spec, palette: mended.skin.palette, skin: { name: mended.skin.name, css: mended.skin.css } }
  const applied = (await call(`/api/cards/${card.id}/check/apply`, { method: 'POST', body: { items: [{ id: STATUS_TUNE, edits: { statusBar: { spec: worn } } }] } })).body
  assert.equal(applied.taken, 1)
  const kept = (await saved()).statusBar
  assert.deepEqual(kept.skin, { name: '雨夜橱窗·改', css: CSS })
  assert.equal(kept.theme, undefined)
  assert.deepEqual(kept.palette, PALETTE)
  // In the card's file it goes with the layout.
  const exported = sillyTavernCard(await saved())
  assert.deepEqual(exported.data.extensions.cicatavern.status_bar.skin, kept.skin)
  // Read back from a file, it is cleaned as any card's is.
  exported.data.extensions.cicatavern.status_bar.skin.css += '\nbody { display: none }\n.status-bar { background: url(https://example.com/a.png) }'
  assert.equal(normalizeCard(exported).statusBar.skin.css, CSS)

  const [record] = applied.check.records
  const undone = (await call(`/api/cards/${card.id}/check/undo`, { method: 'POST', body: { record: record.id } })).body
  assert.equal(undone.card.statusBar?.skin, undefined)
  assert.equal((await saved()).statusBar.theme, 'paper')

  // Not wanted: gone, and the card as it was.
  const dropped = (await call(url, { method: 'DELETE' })).body
  assert.equal(dropped.skin, null)
  assert.equal((await call(url)).body.skin, null)
})

test('an answer with no look in it is said, and the draft before it stays', async t => {
  const card = withBar()
  const { ask, withModel } = await tavern(t, card)
  await withModel()
  const first = await ask({ wish: '雨夜的橱窗' })
  assert.equal(first.skin.name, '雨夜橱窗')
  const failed = await ask({ wish: '做不出来' })
  assert.match(failed.error, /没有写出能用的样式/)
  assert.equal(failed.skin.name, '雨夜橱窗')
  // Asked again, the error is gone.
  assert.equal((await ask({ wish: '再来' })).error, '')
})

test('what may lie behind words: a line along an edge and the ticks of a ruler are left out of the backdrop', async () => {
  const { backdropColors } = await import('../web/shared/status.js')
  const gold = 'rgba(201, 162, 74, 0.7)'
  const clear = 'rgba(0, 0, 0, 0)'
  const box = { width: 320, height: 120 }
  assert.deepEqual(backdropColors('none'), [])
  // A fill from edge to edge: every stop may be behind the words.
  assert.deepEqual(backdropColors(`linear-gradient(rgba(1, 2, 3, 0.5), ${gold})`, { box }), ['rgba(1, 2, 3, 0.5)', gold])
  // A rule one pixel high along the top of a group.
  assert.deepEqual(backdropColors(`linear-gradient(90deg, ${clear}, ${gold} 20%, ${gold} 80%, ${clear})`, { size: '100% 1px', repeat: 'no-repeat', box }), [])
  // Ticks: one pixel in eight is gold; the rest shows what is under it.
  assert.deepEqual(backdropColors(`repeating-linear-gradient(90deg, ${gold} 0px, ${gold} 1px, ${clear} 1px, ${clear} 8px)`, { box }), [clear])
  assert.deepEqual(backdropColors(`repeating-linear-gradient(90deg, ${clear} 0% 9.6%, ${gold} 9.6% 10%)`, { box }), [clear])
  // Stripes half and half are both behind the words.
  assert.deepEqual(backdropColors(`repeating-linear-gradient(45deg, ${gold} 0px, ${gold} 6px, ${clear} 6px, ${clear} 12px)`, { box }), [gold, clear])
  // Layers one over another, each with its own size: the ruler at the bottom is left out, the wash is kept.
  assert.deepEqual(backdropColors(`repeating-linear-gradient(90deg, ${gold} 0px, ${gold} 1px, ${clear} 1px, ${clear} 40px), radial-gradient(circle, rgba(40, 90, 92, 0.35), ${clear} 65%)`, { size: '100% 6px, auto', repeat: 'no-repeat, repeat', box }), ['rgba(40, 90, 92, 0.35)', clear])
  // Repeated along the bar, a strip six pixels high still leaves the box bare.
  assert.deepEqual(backdropColors(`linear-gradient(${gold}, ${gold})`, { size: '100% 6px', repeat: 'repeat-x', box }), [])
  // `background: gradient, #123` computes to two layers, the second with no picture.
  assert.deepEqual(backdropColors(`linear-gradient(${gold}, ${gold}), none`, { size: '100% 6px, auto', repeat: 'no-repeat, repeat', box }), [])
  // Colors mixed in the rules compute to color(srgb …): they are stops like any other; a gradient whose colors cannot be read at all is not known.
  assert.deepEqual(backdropColors('linear-gradient(178deg, color(srgb 0.95 0.93 0.89) 0%, rgb(242, 238, 227) 100%)', { box }), ['color(srgb 0.95 0.93 0.89)', 'rgb(242, 238, 227)'])
  assert.equal(backdropColors('linear-gradient(oklch(0.9 0.02 90), oklch(0.8 0.02 90))', { box }), null)
  // Layer by layer, the topmost first: a faint wash over a fill is told from the fill under it.
  const { backdropLayers } = await import('../web/shared/status.js')
  assert.deepEqual(backdropLayers(`radial-gradient(rgba(43, 42, 39, 0.05), ${clear} 55%), linear-gradient(rgb(245, 242, 233) 0%, rgb(242, 238, 227) 100%)`, { box }), [['rgba(43, 42, 39, 0.05)', clear], ['rgb(245, 242, 233)', 'rgb(242, 238, 227)']])
  // A picture: what it shows cannot be told.
  assert.equal(backdropColors('url("x.png")'), null)
})

test('a look longer than it may be is cut at the limit, and its answer says so', async () => {
  const { MAX_SKIN, cleanSkinCss, skinCut } = await import('../web/shared/status.js')
  const { readSkin } = await import('../server/forge/skin.mjs')
  const rule = i => `.status-row[data-label="第${i}项"] .status-label { color: #123456; letter-spacing: .1em }`
  const long = Array.from({ length: 500 }, (_, i) => rule(i)).join('\n')
  assert.equal(skinCut(long), true)
  assert.ok(cleanSkinCss(long).length <= MAX_SKIN)
  assert.equal(skinCut(rule(1)), false)
  const answer = css => `<reply>好</reply>\n<name>长</name>\n<palette>{"bg":"#101820","ink":"#f2f2f2","accent":"#e0a030"}</palette>\n<css>\n${css}\n</css>`
  assert.deepEqual(readSkin(answer(long.slice(0, 40000))).cut, ['long'])
  assert.deepEqual(readSkin(answer(rule(1))).cut, [])
  assert.ok(MAX_SKIN >= 24000)
})
