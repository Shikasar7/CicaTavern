// 导出角色卡 → 带上图片和设置 (server/card-pack.mjs): the zip of a card with the parts ticked, and that zip
// imported: the pictures, the cast, the 正则集 and the settings are on the new card; what was not ticked is not;
// the card file inside is the one SillyTavern reads; a zip that is no pack, or names files it should not, is refused
// or passed over.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { PACK_MANIFEST, cleanParts } from '../server/card-pack.mjs'
import { readPngText, writeCardPng } from '../server/cards.mjs'
import { createApp } from '../server/http.mjs'
import { crcOf, zipEntries as writeZip } from '../server/update/zip.mjs'
import { zipData, zipEntries } from '../web/shared/zip.js'

// A one-pixel PNG, a tiny JPEG's first bytes with filler, a WebP header: enough for the app's picture checks.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])])
const url = (buffer, type) => `data:image/${type};base64,${buffer.toString('base64')}`
const CARD = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '雨宿', description: '雨夜便利店', first_mes: '雨下起来了。', extensions: {} } }

async function setup(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'card-pack-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const upload = async zip => {
    const res = await fetch(`${base}/api/card-packs`, { method: 'POST', headers: { 'content-type': 'application/zip', 'x-agent-tavern': '1' }, body: zip })
    return { status: res.status, body: await res.json() }
  }
  const download = async pathname => Buffer.from(await (await fetch(`${base}${pathname}`)).arrayBuffer())
  return { app, call, upload, download }
}

/** A card with everything a pack can take: cast with a reference picture, sprite, expression, scene, cover, foe picture, a 正则集, settings. */
async function dressedCard({ call }) {
  const png = writeCardPng(PNG, CARD)
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: '雨宿.png', data: png.toString('base64') } })).body
  const id = card.id
  const media = (await call(`/api/cards/${id}/media`, { method: 'PUT', body: { style: 'watercolor', voice: 'edge:zh-CN-XiaoyiNeural', roster: [{ name: '林小雨', kind: 'girl', looks: 'black hair', lora: 'xiaoyu.safetensors', voice: 'edge:zh-CN-XiaoxiaoNeural' }, { name: '老周', kind: 'boy' }] } })).body
  const [girl, boss] = media.roster
  assert.equal((await call(`/api/cards/${id}/roster/${girl.id}/ref`, { method: 'PUT', body: { image: url(PNG, 'png') } })).status, 200)
  assert.equal((await call(`/api/cards/${id}/sprites/${girl.id}`, { method: 'PUT', body: { image: url(PNG, 'png') } })).status, 200)
  assert.equal((await call(`/api/cards/${id}/sprites/${girl.id}/expressions/smile`, { method: 'PUT', body: { image: url(PNG, 'png') } })).status, 200)
  assert.equal((await call(`/api/cards/${id}/scenes`, { method: 'POST', body: { name: '晴空便利店', aliases: ['便利店'], image: url(JPEG, 'jpeg') } })).status, 200)
  assert.equal((await call(`/api/cards/${id}/cover-art`, { method: 'PUT', body: { image: url(JPEG, 'jpeg') } })).status, 200)
  assert.equal((await call(`/api/cards/${id}/foes/image`, { method: 'PUT', body: { name: '雨妖', image: url(PNG, 'png') } })).status, 200)
  const set = (await call('/api/regex/sets', { method: 'POST', body: { name: '雨夜美化', scripts: [{ scriptName: '去掉括号', findRegex: '/（.*?）/g', replaceString: '' }] } })).body
  assert.equal((await call(`/api/regex/sets/${set.id}/cards`, { method: 'PUT', body: { ids: [id] } })).status, 200)
  return { id, girl, boss, set }
}

const namesIn = zip => zipEntries(zip).map(entry => entry.name).sort()
const fileIn = async (zip, name) => Buffer.from(await zipData(zip, zipEntries(zip).find(entry => entry.name === name), bytes => zlib.inflateRawSync(bytes)))

test('sprites take their roster along; unknown parts are dropped', () => {
  assert.deepEqual(cleanParts(['sprites', 'nonsense', 'cover']), ['roster', 'sprites', 'cover'])
  assert.deepEqual(cleanParts(['foes']), ['rules', 'foes'])
  assert.deepEqual(cleanParts(null), [])
})

test('a card says what it has to take along, and a pack with everything puts it all on the imported card', async t => {
  const ctx = await setup(t)
  const { id, girl, set } = await dressedCard(ctx)
  const { call, upload, download } = ctx

  const survey = (await call(`/api/cards/${id}/pack`)).body
  assert.deepEqual(survey.parts.map(part => part.key), ['roster', 'sprites', 'scenes', 'cover', 'rules', 'foes', 'regex', 'settings'])
  assert.equal(survey.parts.find(part => part.key === 'sprites').count, 2)
  assert.equal(survey.parts.find(part => part.key === 'roster').count, 2)
  assert.ok(survey.parts.find(part => part.key === 'scenes').bytes > 0)
  assert.equal(survey.max, 500 * 1024 * 1024)

  const made = (await call(`/api/cards/${id}/pack`, { method: 'POST', body: { include: survey.parts.map(part => part.key) } })).body
  assert.equal(made.name, '雨宿.zip')
  const zip = await download(made.path)
  assert.equal(zip.length, made.size)
  const names = namesIn(zip)
  assert.ok(names.includes('card.png') && names.includes(PACK_MANIFEST) && names.includes('cover.jpg') && names.includes(`roster/${girl.id}.png`))
  assert.equal(names.filter(name => name.startsWith('sprites/')).length, 2)
  assert.equal(names.filter(name => name.startsWith('scenes/')).length, 1)
  assert.equal(names.filter(name => name.startsWith('foes/')).length, 1)
  // The card file is the SillyTavern PNG: the card in its text, the attached 正则集 not flattened into it.
  const inside = JSON.parse(Buffer.from(readPngText(await fileIn(zip, 'card.png')).chara ?? readPngText(await fileIn(zip, 'card.png')).ccv3, 'base64').toString('utf8'))
  assert.equal(inside.data.name, '雨宿')
  assert.equal((inside.data.extensions.regex_scripts ?? []).length, 0)

  const sent = await upload(zip)
  assert.equal(sent.status, 200)
  assert.equal(sent.body.name, '雨宿')
  assert.equal(sent.body.previous.id, id)
  const fresh = (await call('/api/cards/import', { method: 'POST', body: { pack: sent.body.pack } })).body
  assert.notEqual(fresh.id, id)
  assert.deepEqual(fresh.arrived, { roster: 2, sprites: 2, scenes: 1, cover: true, rules: true, foes: 1, regexSets: 1, settings: true })
  // The token is spent.
  assert.equal((await call('/api/cards/import', { method: 'POST', body: { pack: sent.body.pack } })).status, 410)

  const media = (await call(`/api/cards/${fresh.id}/media`)).body
  assert.equal(media.style, 'watercolor')
  assert.equal(media.voice, 'edge:zh-CN-XiaoyiNeural')
  const cast = media.roster.find(entry => entry.name === '林小雨')
  assert.equal(cast.id, girl.id)
  assert.equal(cast.ref, true)
  assert.equal(cast.lora, 'xiaoyu.safetensors')
  const sprites = (await call(`/api/cards/${fresh.id}/sprites`)).body
  assert.ok(JSON.stringify(sprites).includes(girl.id))
  assert.ok(JSON.stringify(sprites).includes('smile'))
  const scenes = (await call(`/api/cards/${fresh.id}/scenes`)).body.scenes
  assert.equal(scenes.length, 1)
  assert.equal(scenes[0].name, '晴空便利店')
  assert.ok((await download(`/api/scenes/${fresh.id}/${scenes[0].file}`)).equals(JPEG))
  assert.ok(fresh.coverArt > 0)
  assert.ok((await download(`/api/cards/${fresh.id}/cover-art`)).equals(JPEG))
  const book = (await call(`/api/cards/${fresh.id}/game`)).body
  assert.match(book.foes['雨妖'].file, /^foe-[0-9a-f]{12}\.png$/)
  // The same set, attached to both cards: not a second copy.
  const { sets } = (await call('/api/regex')).body
  assert.equal(sets.length, 1)
  assert.deepEqual([...sets[0].cardIds].sort(), [id, fresh.id].sort())
  assert.equal(sets[0].id, set.id)
})

test('only what was ticked goes; without the settings the cast leaves its LoRAs and voices behind', async t => {
  const ctx = await setup(t)
  const { id, girl } = await dressedCard(ctx)
  const { call, upload, download } = ctx
  const made = (await call(`/api/cards/${id}/pack`, { method: 'POST', body: { include: ['sprites'] } })).body
  assert.deepEqual(made.included, ['roster', 'sprites'])
  const zip = await download(made.path)
  const names = namesIn(zip)
  assert.ok(!names.some(name => name.startsWith('scenes/') || name.startsWith('foes/') || name === 'cover.jpg'))
  const manifest = JSON.parse((await fileIn(zip, PACK_MANIFEST)).toString('utf8'))
  assert.equal(manifest.roster.find(entry => entry.id === girl.id).lora, '')
  assert.equal(manifest.settings, undefined)
  assert.equal(manifest.regexSets, undefined)

  const sent = await upload(zip)
  const fresh = (await call('/api/cards/import', { method: 'POST', body: { pack: sent.body.pack } })).body
  // A new version of a card here inherits the older one's media; the pack's own parts are what `arrived` counts.
  assert.deepEqual(fresh.arrived, { roster: 2, sprites: 2, scenes: 0, cover: false, rules: false, foes: 0, regexSets: 0, settings: false })
})

test('a pack with nothing ticked is the card alone, and still imports', async t => {
  const ctx = await setup(t)
  const { id } = await dressedCard(ctx)
  const { call, upload, download } = ctx
  const zip = await download((await call(`/api/cards/${id}/pack`, { method: 'POST', body: { include: [] } })).body.path)
  assert.deepEqual(namesIn(zip), ['card.png', PACK_MANIFEST].sort())
  const sent = await upload(zip)
  const fresh = (await call('/api/cards/import', { method: 'POST', body: { pack: sent.body.pack, replace: id } })).body
  assert.equal(fresh.id, id)
  assert.equal(fresh.updated, '雨宿')
})

test('a zip that is no pack is refused; files the manifest should not name are passed over', async t => {
  const ctx = await setup(t)
  const { call, upload } = ctx
  const entry = (name, data) => ({ name, data: Buffer.from(data), when: new Date(), crc: crcOf(Buffer.from(data)) })
  const plain = await upload(writeZip([entry('readme.txt', 'hello')]))
  assert.equal(plain.status, 400)
  assert.equal((await upload(Buffer.from('not a zip at all'))).status, 400)

  const card = writeCardPng(PNG, CARD)
  const manifest = {
    format: 'cicatavern-card-pack', version: 1, name: '雨宿', card: 'card.png', parts: ['roster', 'sprites', 'scenes', 'cover', 'regex'],
    roster: [{ id: 'abcdef12', name: '林小雨', kind: 'girl' }],
    refs: ['abcdef12', '../../evil'],
    // A path out of the folder, a file that is no picture, a member not on the roster.
    sprites: { abcdef12: { file: '../../../evil.png' }, zzzzzz99: { file: 'ghost-aaaaaa.png' } },
    expressions: { abcdef12: { smile: { file: 'text-aaaaaa.png' }, sneer: { file: 'ok-aaaaaa.png' } } },
    scenes: [{ id: '../x', name: '坏', file: 'a-aaaaaa.png' }, { id: 'good1', name: '后巷', file: 'good1-aaaaaa.png' }],
    cover: true,
    regexSets: [{ name: '空的', scripts: [] }],
  }
  const zip = writeZip([
    { name: 'card.png', data: card, when: new Date(), crc: crcOf(card) },
    entry(PACK_MANIFEST, JSON.stringify(manifest)),
    { name: 'roster/abcdef12.png', data: PNG, when: new Date(), crc: crcOf(PNG) },
    entry('sprites/text-aaaaaa.png', 'this is text, not a picture'),
    { name: 'sprites/ghost-aaaaaa.png', data: PNG, when: new Date(), crc: crcOf(PNG) },
    { name: 'scenes/good1-aaaaaa.png', data: PNG, when: new Date(), crc: crcOf(PNG) },
    // Named cover.jpg, but a PNG inside.
    { name: 'cover.jpg', data: PNG, when: new Date(), crc: crcOf(PNG) },
  ])
  const sent = await upload(zip)
  assert.equal(sent.status, 200)
  const fresh = (await call('/api/cards/import', { method: 'POST', body: { pack: sent.body.pack } })).body
  assert.deepEqual(fresh.arrived, { roster: 1, sprites: 0, scenes: 1, cover: false, rules: false, foes: 0, regexSets: 0, settings: false })
  const media = (await call(`/api/cards/${fresh.id}/media`)).body
  assert.equal(media.roster.length, 1)
  assert.equal(media.roster[0].ref, true)
  assert.equal((await call(`/api/cards/${fresh.id}/scenes`)).body.scenes[0].name, '后巷')
})

const cardIn = async zip => {
  const text = readPngText(await fileIn(zip, 'card.png'))
  return JSON.parse(Buffer.from(text.chara ?? text.ccv3, 'base64').toString('utf8'))
}

test('游戏规则设置 goes when ticked and stays behind when not; over a card with rules of its own, the pack wins', async t => {
  const ctx = await setup(t)
  const { id } = await dressedCard(ctx)
  const { call, upload, download } = ctx
  assert.equal((await call(`/api/cards/${id}/game`, { method: 'PUT', body: { level: 'full' } })).status, 200)

  // Not ticked: the card file has no rule book, and a new card made from it plays without rules.
  const bare = await download((await call(`/api/cards/${id}/pack`, { method: 'POST', body: { include: ['scenes'] } })).body.path)
  assert.equal((await cardIn(bare)).data.extensions.cicatavern?.game, undefined)
  assert.equal(JSON.parse((await fileIn(bare, PACK_MANIFEST)).toString('utf8')).rules, undefined)

  // Ticked: in the card file and in the manifest; the foes' pictures stay unless ticked too.
  const made = (await call(`/api/cards/${id}/pack`, { method: 'POST', body: { include: ['rules'] } })).body
  assert.deepEqual(made.included, ['rules'])
  const zip = await download(made.path)
  assert.equal((await cardIn(zip)).data.extensions.cicatavern.game.level, 'full')
  const manifest = JSON.parse((await fileIn(zip, PACK_MANIFEST)).toString('utf8'))
  assert.equal(manifest.rules.level, 'full')
  assert.equal(manifest.rules.foes['雨妖'].file, undefined)
  assert.ok(!namesIn(zip).some(name => name.startsWith('foes/')))

  // The card's own rules changed since; updating it in place from the pack puts the pack's back, its foe picture kept.
  await call(`/api/cards/${id}/game`, { method: 'PUT', body: { level: 'off' } })
  const picture = (await call(`/api/cards/${id}/game`)).body.foes['雨妖'].file
  const sent = await upload(zip)
  const updated = (await call('/api/cards/import', { method: 'POST', body: { pack: sent.body.pack, replace: id } })).body
  assert.equal(updated.arrived.rules, true)
  const book = (await call(`/api/cards/${id}/game`)).body
  assert.equal(book.level, 'full')
  assert.equal(book.foes['雨妖'].file, picture)
})
