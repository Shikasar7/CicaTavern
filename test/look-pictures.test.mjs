// 定制外观的图: a look names the card's own pictures by variable (web/shared/status.js), the server keeps the files
// (server/look-pictures.mjs), the model is told what there is (server/forge/skin.mjs), and a card leaving the app takes
// them along (st-export.mjs as data, card-pack.mjs as files).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { cleanMedia, decorPrompt } from '../server/media.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { picturesBlock, readSkin, skinRequest } from '../server/forge/skin.mjs'
import { withLookPictures } from '../server/forge/st-export.mjs'
import { EMBED_CAP } from '../server/look-pictures.mjs'
import { cleanSkin, cleanStatusSpec, lookTokensUsed, lookVars } from '../web/shared/status.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const url = (buffer, type = 'png') => `data:image/${type};base64,${buffer.toString('base64')}`

test('a look names pictures by variable: only the card\'s own kinds, each to a file of its look or as data', () => {
  const css = '.status-bar { background-image: linear-gradient(#000c, #000c), var(--pic-scene-15d494, none) }\n.status-title::before { background: var(--pic-decor-corner, none) var(--pic-decor-corner) }'
  assert.deepEqual(lookTokensUsed(css), ['--pic-scene-15d494', '--pic-decor-corner'])
  // url() is still cut: a look cannot fill a variable of its own with an address.
  const spec = cleanStatusSpec({ fields: [{ path: 'a', label: 'A', show: 'number' }], skin: { css: `${css}\n.status-bar { --pic-avatar: url("https://example.com/x.png") }` } })
  assert.match(spec.skin.css, /var\(--pic-scene-15d494, none\)/)
  assert.doesNotMatch(spec.skin.css, /example\.com|url\(/)
  assert.deepEqual(lookVars({
    '--pic-decor-corner': '/api/look/abc/decor-corner-1.webp?v=x1',
    '--pic-scene-15d494': url(PNG),
    '--pic-scene-zzzzzz': '/api/look/abc/a.png',
    '--pic-avatar': 'https://example.com/x.png',
    '--pic-cover': '/api/scenes/abc/a.png',
  }).map(([token]) => token), ['--pic-decor-corner', '--pic-scene-15d494'])
})

test('a look keeps the decorations it asked for, a prompt each, for the slots there are', () => {
  const skin = cleanSkin({ name: '黑曜', css: '.status-bar { color: red }', decor: { corner: ' gold filigree ', moon: 'x', divider: '' } })
  assert.deepEqual(skin.decor, { corner: 'gold filigree' })
  assert.equal(cleanSkin({ css: '.status-bar { color: red }', decor: { moon: 'x' } }).decor, undefined)
})

test('the model is told the card\'s pictures and how to use them, and may ask for decorations', () => {
  const pictures = [
    { token: '--pic-scene-15d494', kind: 'scene', label: '锈铁笼斗技场' },
    { token: '--pic-sprite-abc', kind: 'sprite', label: '莉瑟' },
    { token: '--pic-decor-corner', kind: 'decor', label: 'corner' },
    { token: '--pic-decor-texture', kind: 'decor', label: 'texture' },
  ]
  const block = picturesBlock(pictures, ['--pic-decor-corner'])
  assert.match(block, /--pic-scene-15d494：场景「锈铁笼斗技场」，横图/)
  assert.match(block, /--pic-sprite-abc：「莉瑟」的立绘/)
  assert.match(block, /--pic-decor-corner：装饰图「角花[^」]*」，已经画好/)
  assert.match(block, /--pic-decor-texture：装饰图「底纹[^」]*」，还没画/)
  assert.match(block, /0\.75/)
  assert.equal(picturesBlock([]), '')
  const card = { name: '卡', description: '', firstMes: '' }
  const spec = { fields: [{ path: 'a', label: 'A', show: 'number' }] }
  const asked = skinRequest(card, spec, { a: 1 }, { pictures })
  assert.match(asked.messages[0].content, /<pictures>/)
  assert.match(asked.system, /<decor>/)
  assert.doesNotMatch(skinRequest(card, spec, { a: 1 }).messages[0].content, /<pictures>/)
  const read = readSkin('<name>黑曜</name><palette>{"bg":"#111111","ink":"#eeeeee","accent":"#c9a24a"}</palette><css>.status-bar { background-image: var(--pic-decor-texture, none) }</css><decor>{"texture": "black obsidian with faint gold veins", "corner": "gold filigree", "sun": "no"}</decor>')
  assert.deepEqual(read.decor, { texture: 'black obsidian with faint gold veins', corner: 'gold filigree' })
  assert.match(decorPrompt('corner', 'gold filigree'), /pure white background.*gold filigree/)
  assert.match(decorPrompt('texture', ''), /tileable/)
})

test('in SillyTavern the look\'s pictures are set in the bar\'s and the cover\'s own styles', () => {
  const page = '```html\n<!DOCTYPE html>\n<html><head><meta charset="utf-8">\n<style>.status-bar{}</style>\n</head><body></body></html>\n```'
  const card = {
    regexScripts: [{ id: 'cicatavern-status-bar', replaceString: page }, { id: 'cicatavern-cover', replaceString: page }, { id: 'other', replaceString: page }],
    lookPictures: { '--pic-decor-corner': url(PNG), '--pic-evil': url(PNG) },
  }
  const out = withLookPictures(card).regexScripts
  assert.match(out[0].replaceString, /<style>\.skinned\{--pic-decor-corner:url\("data:image\/png;base64,/)
  assert.match(out[1].replaceString, /\.skinned\{--pic-decor-corner/)
  assert.equal(out[2].replaceString, page)
  assert.doesNotMatch(out[0].replaceString, /--pic-evil/)
  assert.equal(withLookPictures({ regexScripts: card.regexScripts }).regexScripts[0].replaceString, page)
})

async function fakeImages(t) {
  const seen = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    seen.push({ url: req.url, json: raw ? JSON.parse(raw) : null })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { seen, base: `http://127.0.0.1:${server.address().port}` }
}

async function tavern(t) {
  const fake = await fakeImages(t)
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'look-pictures-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `${fake.base}/v1`, apiKey: 'sk-look', models: ['helper'] })
  await app.store.saveProviders([provider])
  await app.store.saveSettings({ media: cleanMedia({ imageProvider: provider.id, imageModel: 'img' }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { fake, base, call }
}

// A card that wears a look naming a decoration and one of its scenes, with a bar page to put the pictures in.
const PAGE = '```html\n<!DOCTYPE html>\n<html><head><meta charset="utf-8">\n<style>.status-bar{}</style>\n</head><body></body></html>\n```'
const CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '雨宿',
    description: '雨夜便利店',
    first_mes: '雨下起来了。',
    extensions: {
      regex_scripts: [{ id: 'cicatavern-status-bar', scriptName: '状态栏', findRegex: '<StatusPlaceHolderImpl/>', replaceString: PAGE, placement: [2], markdownOnly: true }],
      cicatavern: { status_bar: { fields: [{ path: '金钱', label: '金钱', show: 'number' }], skin: { css: '.status-bar { background-image: linear-gradient(#000c, #000c), var(--pic-decor-texture, none), var(--pic-decor-corner, none) }' } } },
    },
  },
}

test('a card keeps its look\'s pictures: offered, drawn, replaced into the drawing history, taken back, and out to SillyTavern', async t => {
  const { fake, base, call } = await tavern(t)
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(CARD)).toString('base64') } })).body
  const id = card.id
  assert.equal((await call(`/api/cards/${id}/scenes`, { method: 'POST', body: { name: '晴空便利店', image: url(PNG) } })).status, 200)

  const first = (await call(`/api/cards/${id}/look-pictures`)).body
  assert.deepEqual(first.pictures, [])
  const scene = first.offered.find(item => item.kind === 'scene')
  assert.match(scene.token, /^--pic-scene-[0-9a-f]{6}$/)
  assert.equal(scene.label, '晴空便利店')
  assert.match(scene.source, new RegExp(`^/api/scenes/${id}/`))
  assert.deepEqual(first.offered.filter(item => item.kind === 'decor').map(item => item.token), ['--pic-decor-texture', '--pic-decor-corner', '--pic-decor-divider', '--pic-decor-emblem'])

  // 画装饰图: drawn with the player's image setup and handed back, not kept till the page sends it.
  const drawn = (await call(`/api/cards/${id}/look-pictures/draw`, { method: 'POST', body: { slot: 'corner', prompt: 'gold filigree' } })).body
  assert.match(drawn.image, /^data:image\/png;base64,/)
  assert.match(fake.seen.at(-1).json.prompt, /pure white background.*gold filigree/)
  assert.equal((await call(`/api/cards/${id}/look-pictures/draw`, { method: 'POST', body: { slot: 'moon' } })).status, 400)
  assert.deepEqual((await call(`/api/cards/${id}/look-pictures`)).body.pictures, [])

  const kept = (await call(`/api/cards/${id}/look-pictures`, { method: 'PUT', body: { token: '--pic-decor-corner', image: drawn.image, prompt: drawn.prompt } })).body
  const corner = kept.pictures.find(item => item.token === '--pic-decor-corner')
  assert.match(corner.url, new RegExp(`^/api/look/${id}/decor-corner-[\\w-]+\\.png\\?v=`))
  const served = await fetch(`${base}${corner.url}`)
  assert.equal(served.headers.get('content-type'), 'image/png')
  // Nothing but a picture, at a place a look has.
  assert.equal((await call(`/api/cards/${id}/look-pictures`, { method: 'PUT', body: { token: '--pic-moon', image: url(PNG) } })).status, 400)
  assert.equal((await call(`/api/cards/${id}/look-pictures`, { method: 'PUT', body: { token: '--pic-decor-corner', image: 'data:text/html;base64,PGI+' } })).status, 400)

  // Drawn again: the one before goes to 抽图历史, and comes back from there.
  await call(`/api/cards/${id}/look-pictures`, { method: 'PUT', body: { token: '--pic-decor-corner', image: url(PNG) } })
  const history = (await call(`/api/cards/${id}/history`)).body.slots['look:decor-corner']
  assert.equal(history.length, 1)
  assert.match(history[0].prompt, /gold filigree/)
  const back = (await call(`/api/cards/${id}/history/${history[0].file}/use`, { method: 'POST' })).body
  assert.match(back.look.pictures.find(item => item.token === '--pic-decor-corner').prompt, /gold filigree/)

  // A copy of the card's own picture remembers what it was made from.
  await call(`/api/cards/${id}/look-pictures`, { method: 'PUT', body: { token: scene.token, image: url(PNG), from: scene.from } })
  assert.equal((await call(`/api/cards/${id}/look-pictures`)).body.pictures.find(item => item.token === scene.token).from, scene.from)

  // Out to SillyTavern: what the look names and has a picture for, as data in the bar's page; the texture has none.
  const st = (await call(`/api/cards/${id}/sillytavern`)).body
  const bar = (st.data.extensions.regex_scripts ?? []).find(script => script.id === 'cicatavern-status-bar')
  assert.match(bar.replaceString, /\.skinned\{--pic-decor-corner:url\("data:image\/png;base64,/)
  assert.doesNotMatch(bar.replaceString, /--pic-decor-texture:|--pic-scene-/)

  // Deleted: gone from the look, kept in the history.
  const gone = (await call(`/api/cards/${id}/look-pictures/decor-corner`, { method: 'DELETE' })).body
  assert.equal(gone.pictures.some(item => item.token === '--pic-decor-corner'), false)
  assert.ok((await call(`/api/cards/${id}/history`)).body.slots['look:decor-corner'].length >= 1)
  assert.ok(EMBED_CAP >= 1024 * 1024)
})

test('a card pack takes the look\'s pictures along and puts them on the imported card', async t => {
  const { base, call } = await tavern(t)
  const id = (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(CARD)).toString('base64') } })).body.id
  await call(`/api/cards/${id}/look-pictures`, { method: 'PUT', body: { token: '--pic-decor-texture', image: url(PNG), prompt: 'obsidian' } })
  const survey = (await call(`/api/cards/${id}/pack`)).body
  assert.equal(survey.parts.find(part => part.key === 'look').count, 1)
  const made = (await call(`/api/cards/${id}/pack`, { method: 'POST', body: { include: ['look'] } })).body
  const zip = Buffer.from(await (await fetch(`${base}${made.path}`)).arrayBuffer())
  const uploaded = await fetch(`${base}/api/card-packs`, { method: 'POST', headers: { 'content-type': 'application/zip', 'x-agent-tavern': '1' }, body: zip })
  const { pack } = await uploaded.json()
  const imported = (await call('/api/cards/import', { method: 'POST', body: { pack } })).body
  assert.equal(imported.arrived.look, 1)
  const pictures = (await call(`/api/cards/${imported.id}/look-pictures`)).body.pictures
  assert.equal(pictures.length, 1)
  assert.equal(pictures[0].token, '--pic-decor-texture')
  assert.equal(pictures[0].prompt, 'obsidian')
})
