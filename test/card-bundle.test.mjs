// 导入角色卡 with someone else's zip (server/card-bundle.mjs) and 卡的 CG (server/card-cgs.mjs):
// a CharX goes in with its picture, 表情 and backgrounds; an 整合包 is only looked through, then imported as ticked
// (cards, worldbooks, regex, presets, a JSON's list of who each picture is, 表情 folders, folders of pictures);
// CG groups are kept per card, travel in a card pack, are offered in the visual novel's turn message and read back
// from the reply's 【CG|组名】.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeCardPng } from '../server/cards.mjs'
import { openZip, surveyBundle } from '../server/card-bundle.mjs'
import { cgList } from '../server/card-cgs.mjs'
import { createApp } from '../server/http.mjs'
import { buildTurnPrompt, cgFormat, dialogueFormat } from '../server/prompt.mjs'
import { crcOf, zipEntries as writeZip } from '../server/update/zip.mjs'
import { markSpeakers, splitLines } from '../web/shared/vn.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
// A WebP's header is all the app's picture check reads.
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 1), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 9)])
const url = buffer => `data:image/png;base64,${buffer.toString('base64')}`
const zipOf = files => writeZip(Object.entries(files).map(([name, data]) => {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))
  return { name, data: buffer, when: new Date(), crc: crcOf(buffer) }
}))

async function setup(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'card-bundle-'))
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
  const newCard = async name => (await call('/api/cards/import', { method: 'POST', body: { filename: `${name}.png`, data: writeCardPng(PNG, { spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '', first_mes: '。', extensions: {} } }).toString('base64') } })).body
  return { call, upload, download, newCard }
}

// A pack as one card's own script exports it: a JSON listing each picture's path with whose it is.
const LISTED = {
  'manifest.json': {
    type: 'some-script-pack',
    avatars: [{ name: '阿青', zipPath: 'avatars/0_阿青.webp' }, { name: '阿白', zipPath: 'avatars/1_阿白.webp' }],
    moodAvatars: [
      { name: '阿青', moodId: 'mood-joy', zipPath: 'mood/0_阿青_mood-joy.webp' },
      { name: '阿青', moodId: 'mood-anger', zipPath: 'mood/1_阿青_mood-anger.webp' },
      { name: '阿青', moodId: 'mood-disgust', zipPath: 'mood/2_阿青_mood-disgust.webp' },
      { name: '阿青', moodId: 'mood-calm', zipPath: 'mood/3_阿青_mood-calm.webp' },
      // Not in the zip: passed over.
      { name: '阿青', moodId: 'mood-sad', zipPath: 'mood/9_missing.webp' },
    ],
    cgGroups: [{ group: '阿青-雨夜', localImages: [{ index: 2, zipPath: 'cg/阿青-雨夜/2.webp' }, { index: 1, zipPath: 'cg/阿青-雨夜/1.webp' }] }],
  },
  'avatars/0_阿青.webp': WEBP,
  'avatars/1_阿白.webp': WEBP,
  'mood/0_阿青_mood-joy.webp': WEBP,
  'mood/1_阿青_mood-anger.webp': WEBP,
  'mood/2_阿青_mood-disgust.webp': WEBP,
  'mood/3_阿青_mood-calm.webp': WEBP,
  'cg/阿青-雨夜/1.webp': WEBP,
  'cg/阿青-雨夜/2.webp': WEBP,
}

test('an 整合包 is told apart by what its files are, never their names', async () => {
  const zip = openZip(zipOf({
    ...LISTED,
    'x/卡.json': { spec: 'chara_card_v2', data: { name: '林芷', first_mes: '嗨' } },
    'x/卡.png': writeCardPng(PNG, { spec: 'chara_card_v2', data: { name: '苏晚', first_mes: '你好' } }),
    'x/book.json': { name: '设定', entries: { 0: { key: ['a'], content: 'b' } } },
    'x/rx.json': [{ scriptName: '去括号', findRegex: '/（.*?）/g', replaceString: '' }],
    'x/preset.json': { prompts: [{ identifier: 'main', content: 'x' }], prompt_order: [] },
    'x/broken.json': '{ not json',
    '表情/林芷/joy.png': PNG,
    '表情/林芷/anger.png': PNG,
    '表情/林芷/sadness.png': PNG,
    '背景/茶馆.png': PNG,
    '杂图/a.png': PNG,
    '杂图/封面.png': PNG,
    'readme.txt': 'hi',
    '__MACOSX/._x': 'junk',
  }))
  const survey = await surveyBundle(zip)
  assert.deepEqual(survey.cards.map(card => card.name).sort(), ['林芷', '苏晚'])
  assert.deepEqual(survey.books.map(book => [book.name, book.entries]), [['设定', 1]])
  assert.deepEqual(survey.regex.map(item => item.count), [1])
  assert.equal(survey.presets.length, 1)
  const qing = survey.people.find(person => person.name === '阿青')
  // anger before disgust (SillyTavern's order); a calm face is no 立绘; the missing picture is passed over.
  assert.deepEqual(qing.faces, { happy: 'mood/0_阿青_mood-joy.webp', angry: 'mood/1_阿青_mood-anger.webp' })
  assert.equal(qing.portrait, 'avatars/0_阿青.webp')
  assert.deepEqual(qing.left.sort(), ['calm', 'disgust'])
  assert.equal(survey.people.find(person => person.name === '阿白').portrait, 'avatars/1_阿白.webp')
  assert.deepEqual(survey.people.find(person => person.key === 'folder:表情/林芷').faces, { happy: '表情/林芷/joy.png', angry: '表情/林芷/anger.png', sad: '表情/林芷/sadness.png' })
  // A group's pictures in their index order.
  assert.deepEqual(survey.groups, [{ name: '阿青-雨夜', pictures: ['cg/阿青-雨夜/1.webp', 'cg/阿青-雨夜/2.webp'] }])
  assert.deepEqual(survey.folders.map(folder => [folder.folder, folder.pictures.length, folder.suggest]).sort(), [['杂图', 2, 'skip'], ['背景', 1, 'scenes']])
  assert.deepEqual(survey.others.sort(), ['readme.txt', 'x/broken.json'])
})

test('a CharX goes in with its picture, its 表情 on the card\'s own cast entry and its backgrounds as scenes', async t => {
  const { call, upload } = await setup(t)
  const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '苏晚', first_mes: '你好', extensions: {}, assets: [
    { type: 'icon', uri: 'embeded://assets/icon.png', name: 'main', ext: 'png' },
    { type: 'emotion', uri: 'embedded://assets/joy.png', name: 'joy', ext: 'png' },
    { type: 'emotion', uri: '__asset:assets/neutral.png', name: 'neutral', ext: 'png' },
    { type: 'emotion', uri: 'embeded://assets/odd.png', name: 'odd', ext: 'png' },
    { type: 'background', uri: 'embeded://assets/bg.png', name: '酒馆', ext: 'png' },
    { type: 'other', uri: 'embeded://assets/x.png', name: 'x', ext: 'png' },
    { type: 'icon', uri: 'ccdefault:', name: 'default', ext: 'png' },
  ] } }
  const sent = await upload(zipOf({ 'card.json': card, 'assets/icon.png': PNG, 'assets/joy.png': PNG, 'assets/neutral.png': PNG, 'assets/odd.png': PNG, 'assets/bg.png': PNG, 'assets/x.png': PNG }))
  assert.equal(sent.status, 200)
  assert.equal(sent.body.kind, 'charx')
  assert.deepEqual(sent.body.brings, { faces: 2, scenes: 1, left: ['odd', '别的图 1 张'] })
  const fresh = (await call('/api/cards/import', { method: 'POST', body: { pack: sent.body.pack } })).body
  assert.equal(fresh.name, '苏晚')
  assert.equal(fresh.hasAvatar, true)
  assert.deepEqual({ sprites: fresh.arrived.sprites, scenes: fresh.arrived.scenes }, { sprites: 2, scenes: 1 })
  const roster = (await call(`/api/cards/${fresh.id}/media`)).body.roster
  assert.deepEqual(roster.map(entry => entry.name), ['苏晚'])
  const sprites = (await call(`/api/cards/${fresh.id}/sprites`)).body
  assert.ok(sprites.sprites[roster[0].id])
  assert.deepEqual(Object.keys(sprites.expressions[roster[0].id]), ['happy'])
  assert.equal((await call(`/api/cards/${fresh.id}/scenes`)).body.scenes[0].name, '酒馆')
})

test('an 整合包 goes in as ticked: a card, its book on it, its regex, the people and the CG; a pack without a card onto one here', async t => {
  const { call, upload, newCard } = await setup(t)
  const sent = await upload(zipOf({
    'c/林芷.json': { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '林芷', description: '', first_mes: '嗨', extensions: {} } },
    'c/book.json': { name: '林芷设定', entries: { 0: { uid: 0, key: ['林芷'], content: '测试', comment: '' } } },
    'c/rx.json': [{ scriptName: '喵', findRegex: '/喵/g', replaceString: '喵～' }],
    'c/preset.json': { prompts: [{ identifier: 'main', content: 'x' }], prompt_order: [], temperature: 1 },
    '表情/林芷/joy.png': PNG, '表情/林芷/anger.png': PNG, '表情/林芷/neutral.png': PNG,
    '背景/雨夜街头.png': PNG,
    'CG/林芷-初遇/1.png': PNG, 'CG/林芷-初遇/2.png': PNG,
  }))
  assert.equal(sent.body.kind, 'bundle')
  const { survey } = sent.body
  const got = (await call('/api/card-bundles/import', { method: 'POST', body: { pack: sent.body.pack, choices: {
    cards: [{ path: 'c/林芷.json', replace: '' }],
    books: ['c/book.json'], regex: ['c/rx.json'], presets: [],
    people: { [survey.people[0].key]: 'new' },
    folders: { 背景: 'scenes', 'CG/林芷-初遇': 'cgs' },
  } } })).body
  assert.equal(got.cards[0].name, '林芷')
  assert.deepEqual({ books: got.books, regex: got.regex, presets: got.presets, people: got.people, pictures: got.pictures, cgs: got.cgs, scenes: got.scenes }, { books: 1, regex: 1, presets: 0, people: 1, pictures: 3, cgs: { groups: 1, pictures: 2 }, scenes: 1 })
  const id = got.target
  const card = (await call(`/api/cards/${id}`)).body
  assert.equal(card.worldbookIds.length, 1)
  assert.equal((await call(`/api/cards/${id}/cgs`)).body.groups[0].name, '林芷-初遇')
  // The pack is used once.
  assert.equal((await call('/api/card-bundles/import', { method: 'POST', body: { pack: sent.body.pack, choices: {} } })).status, 410)

  // A picture pack with no card: onto a card already here, its people by name, a group of the same name replaced.
  const here = await newCard('阿青的卡')
  const pack = await upload(zipOf(LISTED))
  const people = Object.fromEntries(pack.body.survey.people.map(person => [person.key, 'new']))
  const twice = async () => (await call('/api/card-bundles/import', { method: 'POST', body: { pack: (await upload(zipOf(LISTED))).body.pack, choices: { target: here.id, people, cgs: true } } })).body
  const first = (await call('/api/card-bundles/import', { method: 'POST', body: { pack: pack.body.pack, choices: { target: here.id, people, cgs: true } } })).body
  assert.deepEqual({ people: first.people, pictures: first.pictures, cgs: first.cgs }, { people: 2, pictures: 4, cgs: { groups: 1, pictures: 2 } })
  await twice()
  const roster = (await call(`/api/cards/${here.id}/media`)).body.roster
  assert.deepEqual(roster.map(entry => [entry.name, entry.ref]).sort(), [['阿白', true], ['阿青', true]])
  const groups = (await call(`/api/cards/${here.id}/cgs`)).body.groups
  assert.deepEqual(groups.map(group => [group.name, group.pictures.length]), [['阿青-雨夜', 2]])
})

test('a CharX whose picture is no PNG says where it is, for the page to make it one', async t => {
  const { call, upload } = await setup(t)
  const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '白芷', first_mes: '你好', extensions: {}, assets: [{ type: 'icon', uri: 'embeded://assets/icon.webp', name: 'main', ext: 'webp' }] } }
  const sent = await upload(zipOf({ 'card.json': card, 'assets/icon.webp': WEBP }))
  assert.deepEqual(sent.body.brings.left, [])
  const fresh = (await call('/api/cards/import', { method: 'POST', body: { pack: sent.body.pack } })).body
  assert.equal(fresh.hasAvatar, false)
  assert.equal(fresh.arrived.iconPath, 'assets/icon.webp')
})

test('导出 → .charx: the card, its picture, its character\'s 立绘 and expressions, scenes and CG; read back here as they were', async t => {
  const from = await setup(t)
  const card = await from.newCard('雨宿')
  const roster = (await from.call(`/api/cards/${card.id}/media`, { method: 'PUT', body: { roster: [{ name: '雨宿', kind: 'girl' }, { name: '老周', kind: 'boy' }] } })).body.roster
  const own = roster.find(entry => entry.name === '雨宿')
  await from.call(`/api/cards/${card.id}/sprites/${own.id}`, { method: 'PUT', body: { image: url(PNG) } })
  for (const face of ['happy', 'shy']) await from.call(`/api/cards/${card.id}/sprites/${own.id}/expressions/${face}`, { method: 'PUT', body: { image: url(PNG) } })
  await from.call(`/api/cards/${card.id}/scenes`, { method: 'POST', body: { name: '便利店', image: url(PNG) } })
  const group = (await from.call(`/api/cards/${card.id}/cgs`, { method: 'POST', body: { name: '雨宿-雨夜', note: '告白' } })).body.group
  for (let i = 0; i < 2; i++) await from.call(`/api/cards/${card.id}/cgs/${group.id}/pictures`, { method: 'POST', body: { image: url(PNG) } })

  const made = (await from.call(`/api/cards/${card.id}/charx`, { method: 'POST' })).body
  assert.equal(made.name, '雨宿.charx')
  assert.deepEqual(made.counts, { faces: 3, backgrounds: 1, cgs: 2 })
  const zip = await from.download(made.path)
  const opened = openZip(zip)
  const json = JSON.parse((await opened.file('card.json', 1e7)).toString('utf8'))
  assert.equal(json.spec, 'chara_card_v3')
  assert.deepEqual(json.data.assets.map(asset => [asset.type, asset.name]), [['icon', 'main'], ['emotion', 'neutral'], ['emotion', 'joy'], ['emotion', 'embarrassment'], ['background', '便利店'], ['other', '雨宿-雨夜 1'], ['other', '雨宿-雨夜 2']])
  assert.ok(json.data.assets.every(asset => asset.uri.startsWith('embeded://') && opened.has(asset.uri.slice('embeded://'.length))))

  // Into another install: the same pictures in the same places.
  const to = await setup(t)
  const sent = await to.upload(zip)
  assert.equal(sent.body.kind, 'charx')
  const fresh = (await to.call('/api/cards/import', { method: 'POST', body: { pack: sent.body.pack } })).body
  assert.equal(fresh.hasAvatar, true)
  assert.deepEqual({ sprites: fresh.arrived.sprites, scenes: fresh.arrived.scenes, cgs: fresh.arrived.cgs, left: fresh.arrived.left }, { sprites: 3, scenes: 1, cgs: 2, left: [] })
  const entry = (await to.call(`/api/cards/${fresh.id}/media`)).body.roster.find(item => item.name === '雨宿')
  const sprites = (await to.call(`/api/cards/${fresh.id}/sprites`)).body
  assert.ok(sprites.sprites[entry.id])
  assert.deepEqual(Object.keys(sprites.expressions[entry.id]).sort(), ['happy', 'shy'])
  assert.deepEqual((await to.call(`/api/cards/${fresh.id}/cgs`)).body.groups.map(item => [item.name, item.pictures.length]), [['雨宿-雨夜', 2]])
})

test('选图: a reply\'s picture from 图库 or the player\'s own file, added or in a picture\'s place', async t => {
  const { call, newCard } = await setup(t)
  const card = await newCard('雨宿')
  const chat = (await call('/api/chats', { method: 'POST', body: { cardId: card.id } })).body
  const node = chat.path.find(item => item.role === 'assistant')
  const put = body => call(`/api/chats/${chat.id}/nodes/${node.id}/image/put`, { method: 'POST', body })
  const first = await put({ image: url(PNG) })
  assert.equal(first.status, 200)
  assert.equal(first.body.image.source, 'upload')
  const images = () => first.body.chat.path.find(item => item.id === node.id).media.images
  assert.equal(images().length, 1)
  // From 图库: one of the card's CG, in the uploaded one's place (which becomes an old one).
  const group = (await call(`/api/cards/${card.id}/cgs`, { method: 'POST', body: { name: '雨夜' } })).body.group
  await call(`/api/cards/${card.id}/cgs/${group.id}/pictures`, { method: 'POST', body: { image: url(PNG) } })
  const item = (await call('/api/gallery')).body.items.find(entry => entry.kind === 'cg')
  const second = await put({ gallery: item.id, replace: images()[0].file })
  assert.equal(second.status, 200)
  const now = second.body.chat.path.find(entry => entry.id === node.id).media.images
  assert.equal(now.length, 1)
  assert.equal(now[0].source, 'gallery')
  assert.equal(now[0].history.length, 1)
  assert.equal((await put({ gallery: 'cg:nope:x.png' })).status, 404)
  assert.equal((await put({ image: 'data:text/plain;base64,aGk=' })).status, 400)
})

test('存为 CG: a reply\'s picture copied into a new group or one the card has; its size is on record', async t => {
  const { call, newCard } = await setup(t)
  const card = await newCard('雨宿')
  const chat = (await call('/api/chats', { method: 'POST', body: { cardId: card.id } })).body
  const node = chat.path.find(item => item.role === 'assistant')
  const { image } = (await call(`/api/chats/${chat.id}/nodes/${node.id}/image/put`, { method: 'POST', body: { image: url(PNG) } })).body
  assert.deepEqual([image.width, image.height], [PNG.readUInt32BE(16), PNG.readUInt32BE(20)])
  const keep = body => call(`/api/chats/${chat.id}/nodes/${node.id}/image/cg`, { method: 'POST', body })
  const made = await keep({ file: image.file, name: '雨宿-雨夜', note: '告白' })
  assert.deepEqual([made.status, made.body.group.name, made.body.group.note, made.body.group.pictures.length, made.body.groups.length], [200, '雨宿-雨夜', '告白', 1, 1])
  const more = await keep({ file: image.file, groupId: made.body.group.id })
  assert.equal(more.body.group.pictures.length, 2)
  // The CG is a copy: the picture of the reply can go.
  await call(`/api/chats/${chat.id}/nodes/${node.id}/image?file=${image.file}`, { method: 'DELETE' })
  assert.equal((await keep({ file: image.file, groupId: made.body.group.id })).status, 404)
  assert.equal((await call(`/api/cards/${card.id}/cgs`)).body.groups[0].pictures.length, 2)
  // No name, a group that is gone, a file of elsewhere: nothing is made.
  const other = (await call(`/api/chats/${chat.id}/nodes/${node.id}/image/put`, { method: 'POST', body: { image: url(PNG) } })).body.image
  assert.equal((await keep({ file: other.file, name: ' ' })).status, 400)
  assert.equal((await keep({ file: other.file, groupId: 'nope' })).status, 404)
  assert.equal((await keep({ file: '../../settings.json', name: 'x' })).status, 404)
  assert.equal((await call(`/api/cards/${card.id}/cgs`)).body.groups.length, 1)
})

test('卡的 CG: groups by hand, a picture at a time, kept in a card pack and read back from it', async t => {
  const { call, upload, download, newCard } = await setup(t)
  const card = await newCard('雨宿')
  const made = (await call(`/api/cards/${card.id}/cgs`, { method: 'POST', body: { name: '林小雨-雨夜【告白】', note: '告白的那一幕' } })).body
  // The brackets that would break the mark go.
  assert.equal(made.group.name, '林小雨-雨夜告白')
  assert.equal((await call(`/api/cards/${card.id}/cgs`, { method: 'POST', body: { name: '林小雨 雨夜告白' } })).status, 400)
  const id = made.group.id
  for (let i = 0; i < 2; i++) assert.equal((await call(`/api/cards/${card.id}/cgs/${id}/pictures`, { method: 'POST', body: { image: url(PNG) } })).status, 200)
  assert.equal((await call(`/api/cards/${card.id}/cgs/${id}/pictures`, { method: 'POST', body: { image: 'data:text/plain;base64,aGk=' } })).status, 400)
  let group = (await call(`/api/cards/${card.id}/cgs`)).body.groups[0]
  const [a, b] = group.pictures.map(picture => picture.file)
  group = (await call(`/api/cards/${card.id}/cgs/${id}`, { method: 'PUT', body: { files: [b, a], aliases: ['告白'] } })).body.group
  assert.deepEqual(group.pictures.map(picture => picture.file), [b, a])
  assert.deepEqual(group.aliases, ['告白'])
  assert.deepEqual(cgList([group, { name: '空的', pictures: [] }]), ['林小雨-雨夜告白（告白的那一幕）'])

  // Exported with its CG, imported as a new card: the groups come along, in their order.
  const offer = (await call(`/api/cards/${card.id}/pack`)).body.parts.find(part => part.key === 'cgs')
  assert.equal(offer.count, 2)
  const made2 = (await call(`/api/cards/${card.id}/pack`, { method: 'POST', body: { include: ['cgs'] } })).body
  assert.deepEqual(made2.included, ['cgs'])
  const sent = await upload(await download(made2.path))
  assert.equal(sent.body.kind, 'cica')
  const fresh = (await call('/api/cards/import', { method: 'POST', body: { pack: sent.body.pack } })).body
  assert.equal(fresh.arrived.cgs, 2)
  const copied = (await call(`/api/cards/${fresh.id}/cgs`)).body.groups
  assert.deepEqual(copied.map(item => [item.name, item.note, item.aliases, item.pictures.length]), [['林小雨-雨夜告白', '告白的那一幕', ['告白'], 2]])

  assert.equal((await call(`/api/cards/${card.id}/cgs/${id}/pictures/${a}`, { method: 'DELETE' })).body.group.pictures.length, 1)
  assert.deepEqual((await call(`/api/cards/${card.id}/cgs/${id}`, { method: 'DELETE' })).body.groups, [])
})

test('the turn offers the card\'s CG, and the reply\'s 【CG|组名】 goes to the line after it, never into the chat', () => {
  const names = { user: '你', char: '林芷' }
  // A block of its own, a group a line (read as one more line of the format, the moments went by unmarked).
  assert.doesNotMatch(dialogueFormat(), /CG/)
  assert.match(cgFormat(['林芷-初遇（第一次见面）', 'b']), /^<CG>\n[\s\S]*【CG\|组名】[\s\S]*CG：\n- 林芷-初遇（第一次见面）\n- b\n<\/CG>$/)
  const turn = marks => buildTurnPrompt({ names, input: '嗨', marks, cgs: ['林芷-初遇'] })
  assert.match(turn(true), /<\/对白格式>\n\n<CG>[\s\S]*林芷-初遇/)
  assert.match(turn('cg'), /<CG>[\s\S]*林芷-初遇/)
  assert.doesNotMatch(turn('cg'), /<对白格式>/)
  assert.doesNotMatch(turn(false), /林芷-初遇/)

  const reply = '她推开门。\n【CG|林芷-初遇】\n【林芷|害羞】「你来了。」\n【效果|震屏】\n雷声炸响。'
  const lines = splitLines(reply, { names: [] })
  assert.deepEqual(lines.map(line => line.effects ?? null), [null, { screen: null, actor: null, cg: '林芷-初遇' }, { screen: 'shake', actor: null }])
  assert.equal(markSpeakers(reply), '她推开门。\n林芷：「你来了。」\n雷声炸响。')
  // A card's own 【系统|…】 is no mark of ours.
  assert.equal(splitLines('【系统|提示】你获得了物品。', { names: [] })[0].effects, undefined)
})
