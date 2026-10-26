// 对话修改 for regex scripts and the look (server/forge/regex-edit.mjs, theme-edit.mjs):
// a proposed pattern tried on the latest reply (one that never ends is stopped),
// palettes read and checked for what is hard to read, and the sessions over HTTP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { cleanAppearance, cleanColor, cleanCustom, contrast, paletteCss, paletteIssues } from '../web/shared/appearance.js'
import { applyRegexChanges, readRegexEdit, regexEditRequest, scriptOf, tryChanges } from '../server/forge/regex-edit.mjs'
import { tryScript } from '../server/forge/regex-trial.mjs'
import { readThemeEdit, themeApplier, themeEditRequest } from '../server/forge/theme-edit.mjs'
import { cleanScripts } from '../server/regex.mjs'

const LIGHT = { bg: '#eceeea', pane: '#e3e7e2', surface: '#f7f8f5', raised: '#fbfcfa', line: '#d3d9d4', 'line-soft': '#dfe4df', ink: '#1c2427', muted: '#5d6a6d', faint: '#8b9698', accent: '#2b5869', 'accent-ink': '#f7f8f5', lamp: '#8e5512' }
const DARK = { bg: '#0f1417', pane: '#12181c', surface: '#182025', raised: '#1e272d', line: '#273238', 'line-soft': '#1f292e', ink: '#dde3e0', muted: '#919da0', faint: '#67747a', accent: '#8dbfcb', 'accent-ink': '#0f1417', lamp: '#e6c089' }
const SAMPLE = '雨还在下。\n<state>{"好感": 12}</state>\n她说：【今晚别走了】'

test('custom colours: cleaned, written as CSS for light and dark, checked for what is hard to read', () => {
  assert.equal(cleanColor('#ABC'), '#aabbcc')
  assert.equal(cleanColor('red'), '')
  assert.deepEqual(cleanCustom({ light: LIGHT, dark: { ...DARK, ink: 'nope' } }), null, 'one colour missing: no palette')
  const css = paletteCss({ light: LIGHT, dark: DARK })
  assert.match(css, /^:root\[data-style="custom"\] \{ --bg: #eceeea;/)
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{ :root\[data-style="custom"\]:not\(\[data-theme="light"\]\) \{ --bg: #0f1417;/)
  assert.match(css, /:root\[data-style="custom"\]\[data-theme="dark"\] \{ --bg: #0f1417;/)
  assert.equal(contrast('#000000', '#ffffff'), 21)
  assert.deepEqual(paletteIssues(LIGHT), [], 'the built-in colours read well')
  assert.deepEqual(paletteIssues({ ...LIGHT, ink: '#c0c4c0' }).map(i => [i.key, i.on]), [['ink', 'surface'], ['ink', 'bg']])
  assert.equal(cleanAppearance({ style: 'custom' }).style, 'lamp', 'no custom colours: the default style')
  assert.equal(cleanAppearance({ style: 'custom', custom: { light: LIGHT, dark: DARK } }).style, 'custom')
})

test('regex: the scripts and the latest reply shown, the answer read script by script', () => {
  const subject = { scripts: cleanScripts([{ id: 'hide', scriptName: '藏起状态', findRegex: '/<state>[\\s\\S]*?<\\/state>/g', replaceString: '', placement: [2], markdownOnly: true }]) }
  const { request } = regexEditRequest(subject, { text: '把【】变成彩色框', name: '全局', context: { sample: SAMPLE } })
  const content = request.messages[0].content
  assert.match(content, /<regex id="hide" name="藏起状态" on="ai" effect="display">\n<find>\/<state>/)
  assert.match(content, /<latest_reply>\n雨还在下。/)

  const answer = [
    '<reply>加了一条把【】变成小框的，状态块那条改成停用。</reply>',
    '<new_regex name="对白框" on="ai" effect="display">\n<find>/【([^】]+)】/g</find>\n<replace><span style="border:1px solid">$1</span></replace>\n</new_regex>',
    '<new_regex name="坏的"><find>/([/g</find></new_regex>',
    '<regex id="hide" enabled="false"></regex>',
    '<regex id="gone"><find>/x/</find></regex>',
  ].join('\n')
  const read = readRegexEdit(answer, subject, { shown: ['hide'] })
  assert.deepEqual(read.changes.map(c => c.id), ['new:0', 'new:1', 'regex:hide'])
  const [box, bad, off] = read.changes
  assert.deepEqual([box.find, box.replace, box.on, box.effect], ['/【([^】]+)】/g', '<span style="border:1px solid">$1</span>', 'ai', 'display'])
  assert.equal(bad.invalid, true, "a pattern that doesn't compile can't be taken")
  assert.deepEqual([off.enabled, off.findAfter, off.replaceAfter], [false, off.findBefore, ''])
  assert.deepEqual(scriptOf(box).placement, [2])

  const { applied, prefix } = applyRegexChanges(subject, read.changes, ['new:0', 'new:1', 'regex:hide'])
  assert.deepEqual([applied, prefix], [2, false], 'the broken one is skipped; display-only changes leave what is sent alone')
  assert.deepEqual(subject.scripts.map(s => [s.scriptName, s.disabled]), [['藏起状态', true], ['对白框', false]])
  const sent = applyRegexChanges({ scripts: [] }, readRegexEdit('<new_regex name="省" on="ai" effect="prompt"><find>/x/g</find></new_regex>', { scripts: [] }).changes, ['new:0'])
  assert.equal(sent.prefix, true, 'a script that changes what is sent says so')
})

test('a proposed pattern is tried on the latest reply; one that backtracks for ever is stopped', async () => {
  const tried = await tryScript({ ...scriptOf({ kind: 'newRegex', on: 'ai', effect: 'display', find: '/【([^】]+)】/g', replace: '[$1]' }), disabled: false }, SAMPLE)
  assert.deepEqual(tried, { matches: 1, samples: [{ match: '【今晚别走了】', shown: '[今晚别走了]', sent: '【今晚别走了】' }] })
  // Case-insensitive, so not one V8's linear engine runs (server/regex-guard.mjs turns that engine on).
  const stuck = await tryScript({ ...scriptOf({ kind: 'newRegex', on: 'ai', effect: 'display', find: '/^(a+)+$/i', replace: '' }), disabled: false }, `${'a'.repeat(40)}b`, { timeout: 300 })
  assert.deepEqual(stuck, { error: 'timeout' })
  assert.deepEqual(await tryScript({ ...scriptOf({ kind: 'newRegex', on: 'ai', effect: 'display', find: '/([/', replace: '' }) }, SAMPLE), { error: 'invalid' })
  const changes = await tryChanges([{ id: 'new:0', kind: 'newRegex', on: 'ai', effect: 'display', find: '/雨/g', replace: '雪' }, { id: 'remove:x', kind: 'removeRegex' }], { sample: SAMPLE })
  assert.equal(changes[0].trial.matches, 1)
  assert.equal(changes[1].trial, undefined)
})

test('the look: palettes read over the colours on screen, a picture drawn only when chosen', async () => {
  const context = { palette: { light: LIGHT, dark: DARK } }
  const { request } = themeEditRequest({ style: 'lamp', custom: null, backdrop: '' }, { text: '水墨风', context })
  assert.match(request.messages[0].content, /现在的配色：\n<palette mode="light">\nbg: #eceeea/)
  const answer = '<reply>淡墨。</reply>\n<palette mode="light">\nbg: #f2f1ec\nink: #222222\naccent: #3a3a3a\n</palette>\n<palette mode="dark">\nbg: #111111\nink: #333333\n</palette>\n<backdrop>ink wash mountains, empty, quiet</backdrop>'
  const read = readThemeEdit(answer, {}, { context })
  assert.deepEqual(read.changes.map(c => c.id), ['palette:light', 'palette:dark', 'backdrop'])
  const [light, dark, picture] = read.changes
  assert.deepEqual([light.after.bg, light.after.surface, light.after.accent], ['#f2f1ec', LIGHT.surface, '#3a3a3a'], 'what is left out stays')
  assert.ok(dark.issues.some(issue => issue.key === 'ink'), 'dark ink on dark paper is flagged')
  assert.equal(picture.prompt, 'ink wash mountains, empty, quiet')

  const drawn = []
  const apply = themeApplier({ drawBackdrop: async prompt => (drawn.push(prompt), { buffer: Buffer.from('x') }), storeBackdrop: async () => 'backdrop-abcd1234.png' })
  const subject = { style: 'lamp', custom: null, backdrop: '' }
  assert.deepEqual(await apply(subject, read.changes, ['palette:light']), { applied: 1, prefix: false })
  assert.deepEqual([subject.style, subject.custom.light.bg, subject.custom.dark], ['custom', '#f2f1ec', DARK], 'the mode not taken keeps what is on screen')
  assert.equal(drawn.length, 0)
  await apply(subject, read.changes, ['backdrop'])
  assert.deepEqual([drawn, subject.backdrop], [['ink wash mountains, empty, quiet'], 'backdrop-abcd1234.png'])
})

// ─── Over HTTP, with a model that answers by what it is asked ─────────────

const REGEX_ANSWER = '<reply>加了对白框。</reply>\n<new_regex name="对白框" on="ai" effect="display">\n<find>/【([^】]+)】/g</find>\n<replace>[$1]</replace>\n</new_regex>'
const THEME_ANSWER = '<reply>淡墨。</reply>\n<palette mode="light">\nbg: #f2f1ec\naccent: #3a3a3a\n</palette>'

async function fakeModel() {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(body)
    const system = body.messages[0]?.content ?? ''
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: /界面配色师/.test(system) ? THEME_ANSWER : REGEX_ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-talk2-'))
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
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '本机', api: 'openai-completions', baseURL: `${model.base}/v1`, apiKey: 'sk-test', models: ['writer'] } })).body
  await call('/api/settings', { method: 'PUT', body: { model: `${provider.id}/writer` } })
  const ask = async (url, body) => {
    let session = (await call(url, { method: 'POST', body })).body
    for (let i = 0; i < 300 && session.job; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      session = (await call(url)).body
    }
    return session
  }
  return { app, call, ask, model }
}

test('regex by talking: tried on the reply sent along, saved, undone; a card keeps its own', async t => {
  const { app, call, ask, model } = await tavern(t)
  const session = await ask('/api/talk/regex/global', { text: '把【】变成框', context: { sample: SAMPLE } })
  assert.equal(session.error, null)
  const [change] = session.turns[0].assistant.changes
  assert.deepEqual([change.id, change.trial.matches, change.trial.samples[0].shown], ['new:0', 1, '[今晚别走了]'])
  assert.equal(session.turns[0].user.context, undefined, 'the reply sent along is not sent back')
  assert.match(model.seen[0].messages.at(-1).content, /<latest_reply>\n雨还在下。/)

  const done = (await call('/api/talk/regex/global/apply', { method: 'POST', body: { ids: ['new:0'] } })).body
  assert.deepEqual([done.applied, done.prefix, done.regex.scripts[0].scriptName], [1, false, '对白框'])
  assert.equal((await app.store.getRegex()).length, 1)
  assert.equal((await call('/api/talk/regex/global/undo', { method: 'POST' })).body.regex.scripts.length, 0)
  assert.equal((await app.store.getRegex()).length, 0)

  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'c.json', data: Buffer.from(JSON.stringify({ name: '青禾', first_mes: '你好。' })).toString('base64') } })).body
  await ask(`/api/talk/regex/card-${card.id}`, { text: '加个框' })
  await call(`/api/talk/regex/card-${card.id}/apply`, { method: 'POST', body: { ids: ['new:0'] } })
  assert.equal((await app.store.getCard(card.id)).regexScripts[0].scriptName, '对白框')
  assert.equal((await call('/api/talk/regex/preset-basic')).status, 404, "the built-in preset's script is not changed here")
  await call(`/api/cards/${card.id}`, { method: 'DELETE' })
  assert.equal((await call(`/api/talk/regex/card-${card.id}`)).status, 404)
})

test('the look by talking: the colours on screen sent along, the custom style saved and undone', async t => {
  const { call, ask } = await tavern(t)
  const session = await ask('/api/talk/theme/appearance', { text: '水墨风', context: { palette: { light: LIGHT, dark: DARK } } })
  const [change] = session.turns[0].assistant.changes
  assert.deepEqual([change.id, change.after.bg, change.after.ink], ['palette:light', '#f2f1ec', LIGHT.ink])
  const done = (await call('/api/talk/theme/appearance/apply', { method: 'POST', body: { ids: ['palette:light'] } })).body
  assert.deepEqual([done.settings.appearance.style, done.settings.appearance.custom.light.bg, done.settings.appearance.custom.dark.bg], ['custom', '#f2f1ec', DARK.bg])
  const undone = (await call('/api/talk/theme/appearance/undo', { method: 'POST' })).body
  assert.deepEqual([undone.settings.appearance.style, undone.settings.appearance.custom], ['lamp', null])
  assert.equal((await call('/api/talk/theme/other')).status, 404)
})
