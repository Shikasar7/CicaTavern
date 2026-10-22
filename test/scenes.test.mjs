// 场景图库 (视觉小说模式): a card's backgrounds, one per place, drawn once and
// reused; added, renamed, replaced and removed by hand; carried to a newer
// version of the card.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { cleanMedia } from '../server/media.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { placeLore } from '../server/scenes.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`

const card = (name, version = '') => ({
  spec: 'chara_card_v2',
  data: {
    name: `${name}${version}`,
    description: '茶馆的女儿',
    scenario: '民国江南的小城',
    first_mes: '欢迎光临。',
    character_book: { entries: [{ keys: ['旧城茶馆二楼', '雅座'], content: '<place name="旧城茶馆二楼">临窗的雅座，挂着竹帘。</place>', enabled: true }] },
  },
})

async function fakeModel(t) {
  const seen = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const json = raw ? JSON.parse(raw) : null
    seen.push({ url: req.url, json })
    res.writeHead(200, { 'content-type': 'application/json' })
    // A passage (画这一轮的场景) is answered with the place's name first.
    const passage = JSON.stringify(json?.messages ?? '').includes('<passage>')
    const content = `${passage ? 'PLACE: 临窗雅座\n' : ''}An empty teahouse room with bamboo blinds.`
    if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ model: 'helper', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    // Slow enough for a second draw to arrive while the first is still going.
    await new Promise(resolve => setTimeout(resolve, 150))
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { seen, base: `http://127.0.0.1:${server.address().port}` }
}

async function tavern(t) {
  const fake = await fakeModel(t)
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-scenes-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `${fake.base}/v1`, apiKey: 'sk-scenes', models: ['helper'] })
  await app.store.saveProviders([provider])
  await app.store.saveSettings({ media: cleanMedia({ helperModel: `${provider.id}/helper`, imageProvider: provider.id, imageModel: 'img' }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const importCard = async json => (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(json)).toString('base64') } })).body
  const files = async id => (await readdir(path.join(dataRoot, 'cards', id, 'scenes')).catch(() => [])).sort()
  return { fake, base, call, importCard, files }
}

test('a place\'s worldbook text: its own entry, found by key or name', () => {
  const books = [{ entries: [{ keys: ['码头'], comment: '', content: '渡船停在这里', enabled: true }, { keys: ['旧城茶馆二楼'], comment: '', content: '<place name="旧城茶馆二楼">雅座</place>', enabled: true }] }]
  assert.equal(placeLore(books, '旧城茶馆·二楼'), '雅座')
  assert.equal(placeLore(books, '码头'), '渡船停在这里')
  assert.equal(placeLore(books, '书店'), '')
})

test('scenes: drawn once per place and reused, one at a time per card; edited by hand; carried to a newer version', async t => {
  const { fake, base, call, importCard, files } = await tavern(t)
  const { id } = await importCard(card('雨宿', ' v1'))
  assert.deepEqual((await call(`/api/cards/${id}/scenes`)).body, { scenes: [], drawing: null })

  const first = (await call(`/api/cards/${id}/scenes/draw`, { method: 'POST', body: { place: '旧城茶馆二楼' } })).body
  assert.equal(first.drawn, true)
  assert.equal(first.scene.name, '旧城茶馆二楼')
  assert.match(first.scene.file, /^[\w-]+-[0-9a-f]{6}\.png$/)
  assert.match(first.scene.prompt, /No people\.$/)
  // The helper heard the place and what the worldbook says about it, and the card's setting.
  const asked = fake.seen.find(r => r.url === '/v1/chat/completions').json.messages.at(-1).content
  assert.match(asked, /<place name="旧城茶馆二楼">\n临窗的雅座/)
  assert.match(asked, /民国江南/)
  const picture = await fetch(`${base}/api/scenes/${id}/${first.scene.file}`)
  assert.equal(picture.headers.get('content-type'), 'image/png')
  assert.match(picture.headers.get('cache-control'), /immutable/)

  // The same place again: no second picture.
  const drawsBefore = fake.seen.filter(r => r.url === '/v1/images/generations').length
  const again = (await call(`/api/cards/${id}/scenes/draw`, { method: 'POST', body: { place: '旧城茶馆二楼' } })).body
  assert.equal(again.drawn, false)
  assert.equal(fake.seen.filter(r => r.url === '/v1/images/generations').length, drawsBefore)

  // Two places at once: the second waits its turn.
  const [a, b] = await Promise.all([
    call(`/api/cards/${id}/scenes/draw`, { method: 'POST', body: { place: '码头' } }),
    new Promise(resolve => setTimeout(resolve, 30)).then(() => call(`/api/cards/${id}/scenes/draw`, { method: 'POST', body: { place: '书店' } })),
  ])
  assert.equal(a.status, 200)
  assert.equal(b.status, 409)

  // By hand: added with a picture, aliases cleaned, picture replaced, removed with its file.
  const added = (await call(`/api/cards/${id}/scenes`, { method: 'POST', body: { name: '城西书店', image: dataUrl } })).body.scene
  const renamed = (await call(`/api/cards/${id}/scenes/${added.id}`, { method: 'PUT', body: { aliases: ['书店', '城西书店', ' 书店 ', '旧书铺'] } })).body.scene
  assert.deepEqual(renamed.aliases, ['书店', '旧书铺'])
  const replaced = (await call(`/api/cards/${id}/scenes/${added.id}/image`, { method: 'PUT', body: { image: dataUrl } })).body.scene
  assert.notEqual(replaced.file, added.file)
  assert.equal((await files(id)).includes(added.file), false)
  assert.equal((await call(`/api/cards/${id}/scenes/${added.id}/image`, { method: 'PUT', body: { image: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}` } })).status, 400)
  assert.equal((await fetch(`${base}/api/scenes/${id}/..%2Fcard.json`)).status, 404)
  await call(`/api/cards/${id}/scenes/${added.id}`, { method: 'DELETE' })
  assert.equal((await files(id)).includes(replaced.file), false)

  // A newer version of the card starts with the same scenes.
  const kept = (await call(`/api/cards/${id}/scenes`)).body.scenes
  const newer = await importCard(card('雨宿', ' v2'))
  assert.equal(newer.inherited, '雨宿 v1')
  assert.deepEqual((await call(`/api/cards/${newer.id}/scenes`)).body.scenes, kept)
  assert.deepEqual(await files(newer.id), await files(id))
})

test('画这一轮的场景 and 立绘: a new scene named by the helper, the place its alias; one sprite per cast member', async t => {
  const { fake, base, call, importCard } = await tavern(t)
  const { id } = await importCard(card('雨宿'))
  await call(`/api/cards/${id}/scenes/draw`, { method: 'POST', body: { place: '旧城茶馆二楼' } })

  // The turn's scene: drawn though the place has one, read from the passage, named by the helper.
  const turn = (await call(`/api/cards/${id}/scenes/draw`, { method: 'POST', body: { place: '旧城茶馆二楼', passage: '雨下大了，她把竹帘放下来。' } })).body
  assert.equal(turn.drawn, true)
  assert.equal(turn.scene.name, '临窗雅座')
  assert.deepEqual(turn.scene.aliases, ['旧城茶馆二楼'])
  assert.equal(turn.scene.prompt.includes('PLACE'), false)
  const asked = fake.seen.filter(r => r.url === '/v1/chat/completions').at(-1).json.messages.at(-1).content
  assert.match(asked, /<passage>\n雨下大了/)
  // Again: a second picture of the same place gets a number.
  const second = (await call(`/api/cards/${id}/scenes/draw`, { method: 'POST', body: { place: '旧城茶馆二楼', passage: '天亮了。' } })).body
  assert.equal(second.scene.name, '临窗雅座（2）')

  // 立绘: only for someone on the cast list, with looks.
  await call(`/api/cards/${id}/media`, { method: 'PUT', body: { roster: [{ id: 'qinghe', name: '林青禾', looks: 'long black hair' }, { id: 'nolooks', name: '周管事' }] } })
  assert.deepEqual((await call(`/api/cards/${id}/sprites`)).body, { sprites: {}, expressions: {}, drawing: null })
  assert.equal((await call(`/api/cards/${id}/sprites/nobody/draw`, { method: 'POST', body: {} })).status, 404)
  assert.equal((await call(`/api/cards/${id}/sprites/nolooks/draw`, { method: 'POST', body: {} })).status, 400)
  const drawn = (await call(`/api/cards/${id}/sprites/qinghe/draw`, { method: 'POST', body: {} })).body
  assert.match(drawn.sprites.qinghe.file, /^qinghe-[0-9a-f]{6}\.png$/)
  assert.equal(drawn.sprites.qinghe.source, 'drawn')
  const prompt = fake.seen.filter(r => r.url === '/v1/images/generations').at(-1).json.prompt
  assert.match(prompt, /white background/)
  assert.match(prompt, /long black hair/)
  const picture = await fetch(`${base}/api/sprites/${id}/${drawn.sprites.qinghe.file}`)
  assert.equal(picture.headers.get('content-type'), 'image/png')
  // Uploaded over it: the old file goes. Off the cast list: no longer listed.
  const uploaded = (await call(`/api/cards/${id}/sprites/qinghe`, { method: 'PUT', body: { image: dataUrl } })).body
  assert.equal(uploaded.sprites.qinghe.source, 'upload')
  assert.equal((await fetch(`${base}/api/sprites/${id}/${drawn.sprites.qinghe.file}`)).status, 404)
  await call(`/api/cards/${id}/media`, { method: 'PUT', body: { roster: [{ id: 'nolooks', name: '周管事' }] } })
  assert.deepEqual((await call(`/api/cards/${id}/sprites`)).body.sprites, {})
})

test('表情差分: the 立绘 with only the face changed, drawn from it or uploaded, kept apart from it', async t => {
  const { fake, base, call, importCard } = await tavern(t)
  const { id } = await importCard(card('雨宿'))
  await call(`/api/cards/${id}/media`, { method: 'PUT', body: { roster: [{ id: 'qinghe', name: '林青禾', looks: 'long black hair', outfit: 'qipao' }] } })
  // Nothing to keep the face from yet: no 立绘, no reference picture.
  assert.equal((await call(`/api/cards/${id}/sprites/qinghe/expressions/smile/draw`, { method: 'POST', body: {} })).status, 400)
  assert.equal((await call(`/api/cards/${id}/sprites/qinghe/expressions/neutral/draw`, { method: 'POST', body: {} })).status, 404)
  assert.equal((await call(`/api/cards/${id}/sprites/qinghe/expressions/weird`, { method: 'PUT', body: { image: dataUrl } })).status, 404)
  await call(`/api/cards/${id}/sprites/qinghe`, { method: 'PUT', body: { image: dataUrl } })

  const drawn = (await call(`/api/cards/${id}/sprites/qinghe/expressions/smile/draw`, { method: 'POST', body: {} })).body
  assert.match(drawn.expressions.qinghe.smile.file, /^qinghe-smile-[0-9a-f]{6}\.png$/)
  assert.equal(drawn.expressions.qinghe.smile.source, 'drawn')
  // The 立绘 went along as the picture to edit, with only the face to change.
  const edit = fake.seen.at(-1)
  assert.equal(edit.url, '/v1/images/edits')
  assert.match(edit.json.prompt, /change only the facial expression, to a gentle, warm closed-mouth smile/)
  assert.match(edit.json.prompt, /long black hair/)
  assert.equal(edit.json.image.url, dataUrl)
  const picture = await fetch(`${base}/api/sprites/${id}/${drawn.expressions.qinghe.smile.file}`)
  assert.equal(picture.headers.get('content-type'), 'image/png')

  const shy = (await call(`/api/cards/${id}/sprites/qinghe/expressions/shy`, { method: 'PUT', body: { image: dataUrl } })).body
  assert.deepEqual(Object.keys(shy.expressions.qinghe).sort(), ['shy', 'smile'])
  assert.equal(shy.expressions.qinghe.shy.source, 'upload')
  // The 立绘 can go and come back; its expressions stay.
  const bare = (await call(`/api/cards/${id}/sprites/qinghe`, { method: 'DELETE' })).body
  assert.deepEqual(bare.sprites, {})
  assert.deepEqual(Object.keys(bare.expressions.qinghe).sort(), ['shy', 'smile'])
  const left = (await call(`/api/cards/${id}/sprites/qinghe/expressions/smile`, { method: 'DELETE' })).body
  assert.deepEqual(Object.keys(left.expressions.qinghe), ['shy'])
  assert.equal((await fetch(`${base}/api/sprites/${id}/${drawn.expressions.qinghe.smile.file}`)).status, 404)
})
