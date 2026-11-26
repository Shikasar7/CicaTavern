// 创作角色卡 → 备齐门面图 draws more than the cast and the places: each 形态 the rules give a look (as one of the cast),
// the world's map (a scene called 地图), and the 建角页's options (pictures kept in the form itself).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { cleanMedia } from '../server/media.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { rosterOf } from '../server/forge/index.mjs'
import { cleanCreation, creationHtml, creationOf, keepOptionPictures, withOptionPicture } from '../server/forge/creation.mjs'
import { cleanForms } from '../web/shared/game/growth.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const url = buffer => `data:image/png;base64,${buffer.toString('base64')}`

test('a form keeps how it looks, and the cast gets each form that has a look, once', () => {
  const forms = cleanForms({ 山猫: [{ name: '山猫幼崽', looks: ' a small black panther cub ' }, { name: '裂影山猫', looks: 'a sleek shadow panther', at: { level: 5 } }, { name: '噬影豹王' }] })
  assert.equal(forms.山猫[0].looks, 'a small black panther cub')
  assert.equal(forms.山猫[2].looks, undefined)
  const plan = {
    characters: [{ name: '莉瑟', aliases: ['大小姐'], gender: '女', looks_tags: 'blonde', outfit_tags: 'uniform' }, { name: '路人', aliases: [], gender: '男', looks_tags: '' }],
    game: { forms: { ...forms, 莉瑟: [{ name: '莉瑟', looks: 'x' }, { name: '雷光形态', looks: 'lightning armor' }] } },
  }
  const cast = rosterOf(plan)
  assert.deepEqual(cast.map(entry => entry.name), ['莉瑟', '山猫幼崽', '裂影山猫', '雷光形态'])
  assert.deepEqual(cast.slice(1).map(entry => entry.kind), ['other', 'other', 'other'])
  assert.deepEqual(cast.map(entry => entry.whole === true), [false, true, true, true])
  assert.equal(cast[1].looks, 'a small black panther cub')
  assert.deepEqual(rosterOf({ characters: [], game: null }), [])
  // 衣柜: the outfits the story changes into.
  const wardrobe = [{ name: '睡衣', tags: 'pajamas', when: '睡前' }]
  assert.deepEqual(rosterOf({ characters: [{ name: '莉瑟', aliases: [], gender: '女', looks_tags: 'blonde', outfit_tags: 'uniform', wardrobe }] })[0].wardrobe, wardrobe)
  assert.equal('wardrobe' in cast[0], false)
})

const CREATION = cleanCreation({
  intro: '入笼之前',
  fields: [
    { label: '初始魔宠', kind: 'pick', options: ['影纹山猫', '赤刺藤', '铃音狐'], looks: { 影纹山猫: 'a black panther cub', 不存在: 'x' } },
    { label: '信条', kind: 'pick', options: ['擒贼擒王', '诛心攻势'], looks: { 擒贼擒王: 'x' } },
    { label: '天赋', kind: 'points', options: ['力量', '速度'], total: 4, looks: { 力量: 'x' } },
  ],
})

test('a 建角页 option may have a look; the page itself carries only the pictures', () => {
  assert.deepEqual(CREATION.fields[0].looks, { 影纹山猫: 'a black panther cub' })
  assert.equal(CREATION.fields[2].looks, undefined)
  const page = creationHtml(CREATION)
  assert.doesNotMatch(page, /a black panther cub/)
  assert.match(page, /cr-opts\.pics/)
  const scripts = [{ id: 'cicatavern-creation-page', replaceString: page }]
  const dressed = withOptionPicture(scripts, '初始魔宠', '影纹山猫', url(PNG))
  assert.equal(creationOf(dressed).pics.初始魔宠.影纹山猫, url(PNG))
  // The page still reads as a form, and its options as they were.
  assert.deepEqual(creationOf(dressed).fields.map(field => field.label), ['初始魔宠', '信条', '天赋'])
  assert.throws(() => withOptionPicture(scripts, '初始魔宠', '不存在', url(PNG)), /no option/)
  assert.throws(() => withOptionPicture(scripts, '天赋', '力量', url(PNG)), /no option/)
  assert.throws(() => withOptionPicture(scripts, '初始魔宠', '影纹山猫', 'data:text/html;base64,PGI+'), /bad picture/)
  assert.throws(() => withOptionPicture(scripts, '初始魔宠', '影纹山猫', `data:image/png;base64,${'A'.repeat(70000)}`), /bad picture/)
  assert.throws(() => withOptionPicture([], '初始魔宠', '影纹山猫', url(PNG)), /no form/)
  assert.equal(creationOf(withOptionPicture(dressed, '初始魔宠', '影纹山猫', null)).pics, undefined)
  // Written anew (创作角色卡 saved again): the options still there keep their pictures.
  const again = cleanCreation({ fields: [{ label: '初始魔宠', kind: 'pick', options: ['影纹山猫', '新的一只'] }, { label: '信条', kind: 'pick', options: ['擒贼擒王', '诛心攻势'] }] })
  const kept = keepOptionPictures([{ id: 'cicatavern-creation-page', replaceString: creationHtml(again) }], dressed)
  assert.deepEqual(creationOf(kept).pics, { 初始魔宠: { 影纹山猫: url(PNG) } })
  const plain = [{ id: 'cicatavern-creation-page', replaceString: creationHtml(again) }]
  assert.equal(keepOptionPictures(plain, scripts), plain)
})

async function tavern(t) {
  const seen = []
  const fake = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    seen.push({ url: req.url, json: raw ? JSON.parse(raw) : null })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
  t.after(() => fake.close())
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'forge-pictures-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${fake.address().port}/v1`, apiKey: 'sk-forge', models: ['helper'] })
  await app.store.saveProviders([provider])
  await app.store.saveSettings({ media: cleanMedia({ imageProvider: provider.id, imageModel: 'img' }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { seen, call }
}

test('an option\'s picture is drawn in the card\'s 画风 and put on its form; the card keeps it on the way out', async t => {
  const { seen, call } = await tavern(t)
  const page = creationHtml(CREATION)
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '星纹', first_mes: '入笼之前\n\n<CreationPage/>', extensions: { regex_scripts: [{ id: 'cicatavern-creation-page', scriptName: '建角页', findRegex: '<CreationPage/>', replaceString: page, placement: [2], markdownOnly: true }] } } }
  const id = (await call('/api/cards/import', { method: 'POST', body: { filename: 'card.json', data: Buffer.from(JSON.stringify(card)).toString('base64') } })).body.id
  await call(`/api/cards/${id}/media`, { method: 'PUT', body: { style: 'dark fantasy watercolor' } })

  const drawn = (await call(`/api/cards/${id}/creation/draw`, { method: 'POST', body: { prompt: 'a black panther cub' } })).body
  assert.match(drawn.image, /^data:image\/png;base64,/)
  assert.match(seen.at(-1).json.prompt, /a black panther cub.*no text.*dark fantasy watercolor/)
  assert.equal((await call(`/api/cards/${id}/creation/draw`, { method: 'POST', body: { prompt: '' } })).status, 400)

  assert.equal((await call(`/api/cards/${id}/creation/picture`, { method: 'PUT', body: { label: '初始魔宠', option: '影纹山猫', image: url(PNG) } })).status, 200)
  assert.equal((await call(`/api/cards/${id}/creation/picture`, { method: 'PUT', body: { label: '初始魔宠', option: '没有', image: url(PNG) } })).status, 400)
  assert.deepEqual((await call(`/api/cards/${id}/creation/pictures`)).body.pictures, { 初始魔宠: ['影纹山猫'] })
  // Several at once (备齐门面图 sends them as they are drawn): none is lost.
  await Promise.all(['赤刺藤', '铃音狐'].map(option => call(`/api/cards/${id}/creation/picture`, { method: 'PUT', body: { label: '初始魔宠', option, image: url(PNG) } })))
  assert.deepEqual((await call(`/api/cards/${id}/creation/pictures`)).body.pictures.初始魔宠.sort(), ['赤刺藤', '铃音狐', '影纹山猫'].sort())
  const st = (await call(`/api/cards/${id}/sillytavern`)).body
  const form = st.data.extensions.regex_scripts.find(script => script.id === 'cicatavern-creation-page')
  assert.equal(creationOf([form]).pics.初始魔宠.影纹山猫, url(PNG))
})

test('a form in the cast is drawn whole, and stays marked so through the cast\'s cleaning', async () => {
  const { cleanRoster } = await import('../server/roster.mjs')
  const [beast, girl] = cleanRoster([{ name: '测灵狐幼崽', kind: 'other', looks: 'a fox cub', whole: true }, { name: '莉瑟', kind: 'girl', looks: 'blonde', whole: 'yes' }])
  assert.equal(beast.whole, true)
  assert.equal(girl.whole, undefined)
})
