// 门面: a card creator card's 开场页 (web/shared/cover.js, drawn by web/cover.js), and 立绘, 场景图 and 动效 on its
// status bar. What a card keeps of them, how the wizard's plan carries them (the draft's `front`), and that they go
// into the saved card and come back from an exported one.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createForge } from '../server/forge/index.mjs'
import { normalizePlan, withCardOptions } from '../server/forge/prompts.mjs'
import { readSkin, skinRequest } from '../server/forge/skin.mjs'
import { statusLines } from '../server/forge/status.mjs'
import { newCard } from '../server/forge/write.mjs'
import { normalizeCard, sillyTavernCard } from '../server/cards.mjs'
import { forSillyTavern } from '../server/forge/st-export.mjs'
import { editCard } from '../web/shared/card-edit.js'
import { createStore } from '../server/store.mjs'
import { cleanCover, coverWords, moodPath, openingStart, pickedOpening } from '../web/shared/cover.js'
import { EFFECTS, cleanStatusSpec, phoneApps, statusGroups } from '../web/shared/status.js'

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。她每次来都买同一种热饮。你是唯一记得她的人！',
  user_role: { identity: '夜班店员' },
  world: { kind: '真实', overview: '多雨的港城', places: [{ name: '晴空便利店', description: '24 小时便利店' }] },
  characters: [{ name: '林小雨', kind: 'core', aliases: ['小雨'], gender: '女', identity: '雨女', relationship: '下雨就来避雨', personality: { base: '孤独', main: ['温柔'] } }],
  style: { perspective: '第三人称' },
  tracking: { enabled: true, variables: [
    { path: '林小雨.好感度', label: '好感', type: 'number', initial: '10', range: '0~100', check: '真心相待时 +2' },
    { path: '林小雨.心情', label: '心情', type: 'string', initial: '平静', show: 'badge', check: '随剧情变' },
    { path: '主角.随身', label: '随身', type: 'list', initial: '伞', show: 'tags', check: '得到和用掉时改' },
  ] },
  greetings: [
    { title: '第一场雨', start: '初遇', scene: '凌晨两点，店里', situation: '她推门进来', state: {} },
    { title: '第七场雨', start: '熟了以后', scene: '傍晚，店门口', situation: '她在等你', state: { '林小雨.好感度': '40', '主角.随身': '["伞", "她落下的发圈"]' } },
  ],
  avatar: { character: '林小雨' },
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-front-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const store = createStore(root)
  await store.init()
  const forge = createForge(store, { ledger: { recordTurn: async () => {} } })
  const plan = withCardOptions(normalizePlan(PLAN), { format: 'mvu-ui' })
  const card = { ...newCard(plan), writtenAt: new Date().toISOString() }
  card.greetings.forEach((greeting, i) => { greeting.text = i ? '雨下了七回。' : '雨下起来了。' })
  const now = new Date().toISOString()
  const file = path.join(root, 'forge', 'frontdraft.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ id: 'frontdraft', createdAt: now, updatedAt: now, stage: 'polish', model: '', rounds: [{ user: { text: '雨夜', picks: [] }, assistant: null }], brief: { title: '雨宿', readiness: 1, items: [], open: [] }, options: { format: 'mvu-ui' }, front: {}, plan, card }))
  return { forge, store, plan, root }
}

test('a cover as a card keeps it: words clipped, openings and an effect only where there are some', () => {
  assert.equal(cleanCover(null), null)
  assert.equal(cleanCover('开场页'), null)
  assert.deepEqual(cleanCover({}), { tagline: '', lines: [] })
  const cover = cleanCover({ tagline: '  零点以后\n才开门  ', lines: ['一', '', 2, '二', '三', '四', '五'], openings: [{ title: '第一夜', brief: '雨夜' }, {}], effect: 'rain', css: 'body{}' })
  assert.deepEqual(cover, { tagline: '零点以后 才开门', lines: ['一', '二', '三', '四'], openings: [{ title: '第一夜', brief: '雨夜' }, { title: '', brief: '' }], effect: 'rain' })
  assert.equal(cleanCover({ effect: 'lasers' }).effect, undefined)
  assert.equal(cleanCover({ openings: [{}, {}] }).openings, undefined)
  assert.equal(cleanCover({ tagline: '字'.repeat(90) }).tagline.length, 60)
  assert.equal(cleanCover({ figure: false }).figure, false, 'no one at its side')
  assert.equal(cleanCover({ figure: true }).figure, undefined)
})

test('a summary as a cover\'s words, an opening\'s first words, and which opening a chat started with', () => {
  assert.deepEqual(coverWords(PLAN.summary), { tagline: '深夜便利店里，只在雨夜出现的女孩', lines: ['她每次来都买同一种热饮。', '你是唯一记得她的人！'] })
  assert.deepEqual(coverWords(''), { tagline: '', lines: [] })
  assert.equal(openingStart('<StatusPlaceHolderImpl/>\n门外台阶上有一串湿脚印。不是你的。'), '门外台阶上有一串湿脚印。')
  assert.equal(openingStart('{{user}}推开门的时候雨正大，柜台后面那个人头也没抬，只把一盏灯往外推了推'), '…推开门的时候雨正大，柜台后面那个人头也没抬…')
  const greetings = ['{{user}}推门进来的时候，雨正下得很大。\n\n她抬起头。', '第十一夜。{{user}}照旧在零点推门，修表簿摊开在柜台上。', '短']
  assert.equal(pickedOpening(greetings, '阿澈推门进来的时候，雨正下得很大。\n\n她抬起头。'), 0)
  assert.equal(pickedOpening(greetings, '第十一夜。阿澈照旧在零点推门，修表簿摊开在柜台上。'), 1)
  assert.equal(pickedOpening(greetings, '一段从别处带来的故事。'), -1)
  assert.equal(pickedOpening(greetings, ''), -1)
})

test('the bar keeps 立绘, 场景图 and 动效, a gauge knows where it stood, and a mood variable is found', () => {
  const spec = cleanStatusSpec({ portrait: true, scene: 1, effect: 'snow', fields: [{ path: '林小雨.好感度', label: '好感', show: 'meter' }, { path: '林小雨.心情', label: '心情', show: 'badge' }, { path: '店长.脸色', label: '神情', show: 'text' }] })
  assert.equal(spec.portrait, true)
  assert.equal(spec.scene, undefined, 'only true turns it on')
  assert.equal(spec.effect, 'snow')
  assert.equal(cleanStatusSpec({ effect: 'lasers', fields: [{ path: 'a', show: 'text' }] }).effect, undefined)
  assert.ok(EFFECTS.includes('rain') && EFFECTS.length === 7)
  assert.match(statusLines(spec), /图片: 立绘\n动效: snow/)
  // A gauge this reply moved fills from where it stood; one that did not move has nowhere to come from.
  const rows = (now, before) => statusGroups(spec, { 林小雨: { 好感度: now, 心情: '平静' }, 店长: { 脸色: '阴' } }, before && { 林小雨: { 好感度: before, 心情: '平静' }, 店长: { 脸色: '阴' } })[0].rows
  assert.deepEqual([rows(46, 22)[0].percent, rows(46, 22)[0].from, rows(46, 22)[0].delta], [46, 22, 24])
  assert.equal(rows(46, 46)[0].from, undefined)
  assert.equal(rows(46)[0].from, undefined)
  // Whose mood: the group asked for first, else the first there is.
  assert.equal(moodPath(spec, '店长'), '店长.脸色')
  assert.equal(moodPath(spec, '林小雨'), '林小雨.心情')
  assert.equal(moodPath(spec, '谁'), '林小雨.心情')
  assert.equal(moodPath(cleanStatusSpec({ fields: [{ path: 'a.b', show: 'text' }] })), '')
  // A variable kept for the face itself comes before a mood in the card's own words, shown or not.
  const faced = cleanStatusSpec({ fields: [...spec.fields, { path: '林小雨.表情', label: '表情', show: 'hidden' }] })
  assert.equal(moodPath(faced, '林小雨'), '林小雨.表情')
  assert.equal(moodPath(faced, '店长'), '林小雨.表情')
})

test('a look comes with the 动效 the model picked, and the request asks for one', () => {
  const answer = effect => `<reply>雨夜。</reply>\n<name>雨夜</name>\n<palette>{"bg":"#101820","ink":"#f2f2f2","accent":"#e0a030"}</palette>\n${effect}<css>\n.status-bar { border-radius: 4px }\n</css>`
  assert.equal(readSkin(answer('<effect> Rain </effect>\n')).effect, 'rain')
  assert.equal(readSkin(answer('<effect>none</effect>\n')).effect, '')
  assert.equal(readSkin(answer('')).effect, '')
  assert.equal(readSkin(answer('<effect>lasers</effect>\n')).css, '.status-bar { border-radius: 4px }')
  const spec = cleanStatusSpec({ fields: [{ path: '林小雨.好感度', label: '好感', show: 'meter' }] })
  const request = skinRequest({ name: '雨宿', description: '雨女' }, spec, { 林小雨: { 好感度: 10 } })
  assert.match(request.system, /<effect>rain<\/effect>/)
  for (const effect of EFFECTS) assert.ok(request.system.includes(effect), effect)
})

test('the plan carries the front: all on at first, the words the summary\'s till others are written, each turned off by hand', async t => {
  const { forge } = await setup(t)
  const first = await forge.update('frontdraft', { model: '' })
  assert.deepEqual(first.plan.cover, {
    tagline: '深夜便利店里，只在雨夜出现的女孩',
    lines: ['她每次来都买同一种热饮。', '你是唯一记得她的人！'],
    openings: [{ title: '第一场雨', brief: '凌晨两点，店里' }, { title: '第七场雨', brief: '傍晚，店门口' }],
  })
  assert.deepEqual([first.plan.status.portrait, first.plan.status.scene, first.plan.status.effect], [true, true, ''])
  // An opening's own list, written as text, is its items (not the text cut at its commas).
  assert.equal(first.plan.greetings[1].state['主角.随身'], '伞、她落下的发圈')
  // What the pictures go by is given to the plan once, off the bar: a face from the words the faces are known by,
  // and where the story is, with the plan's places.
  const given = path => first.plan.tracking.variables.find(v => v.path === path)
  assert.deepEqual([given('林小雨.表情').show, given('林小雨.表情').initial], ['hidden', '平静'])
  assert.match(given('林小雨.表情').check, /平静、微笑、开心、害羞、生气、难过、惊讶、思考/)
  assert.deepEqual([given('世界.当前地点').show, given('世界.当前地点').initial], ['hidden', ''])
  assert.match(given('世界.当前地点').check, /晴空便利店/)
  // Taken out by hand, they stay out.
  const without = first.plan.tracking.variables.filter(v => v.path !== '林小雨.表情')
  const taken = await forge.update('frontdraft', { tracking: { enabled: true, title: '', variables: without } })
  assert.equal(taken.plan.tracking.variables.some(v => v.path === '林小雨.表情'), false)
  assert.equal(taken.plan.tracking.variables.some(v => v.path === '世界.当前地点'), true)

  const set = await forge.update('frontdraft', { front: { effect: 'rain', portrait: false, tagline: '雨停之前', lines: ['只有你记得她。', '', '  '] } })
  assert.equal(set.plan.cover.tagline, '雨停之前')
  assert.deepEqual(set.plan.cover.lines, ['只有你记得她。'])
  assert.equal(set.plan.cover.effect, 'rain')
  assert.deepEqual([set.plan.status.portrait, set.plan.status.scene, set.plan.status.effect], [false, true, 'rain'])
  // An effect there is none of is none; words taken out again are the summary's.
  const back = await forge.update('frontdraft', { front: { effect: 'lasers', tagline: null, lines: null } })
  assert.equal(back.plan.cover.effect, undefined)
  assert.equal(back.plan.cover.tagline, '深夜便利店里，只在雨夜出现的女孩')
  assert.equal(back.plan.cover.lines.length, 2)
  assert.equal(back.plan.status.portrait, false, 'what was not sent stays')

  const off = await forge.update('frontdraft', { front: { cover: false } })
  assert.equal(off.plan.cover, null)
  assert.equal((await forge.update('frontdraft', { front: { cover: true } })).plan.cover.openings.length, 2)
})

test('the saved card has its cover and the bar\'s pictures and motion, and an exported card brings them back', async t => {
  const { forge, store } = await setup(t)
  await forge.update('frontdraft', { front: { effect: 'petals' } })
  const saved = await store.getCard((await forge.saveCard('frontdraft', { avatar: PNG })).card.id)
  assert.equal(saved.cover.tagline, '深夜便利店里，只在雨夜出现的女孩')
  assert.deepEqual(saved.cover.openings.map(opening => opening.title), ['第一场雨', '第七场雨'])
  assert.equal(saved.cover.effect, 'petals')
  assert.deepEqual([saved.statusBar.portrait, saved.statusBar.scene, saved.statusBar.effect], [true, true, 'petals'])
  // SillyTavern's JSON keeps them with the card's own data; read again, they are the same.
  const exported = sillyTavernCard(saved)
  assert.deepEqual(exported.data.extensions.cicatavern.cover, saved.cover)
  const again = normalizeCard(exported)
  assert.deepEqual(again.cover, saved.cover)
  assert.equal(again.statusBar.effect, 'petals')
  // Turned off, the card saved again has none.
  await forge.update('frontdraft', { front: { cover: false, scene: false, effect: '' } })
  const plain = await store.getCard((await forge.saveCard('frontdraft', { avatar: PNG })).card.id)
  assert.equal(plain.cover, null)
  assert.deepEqual([plain.statusBar.portrait, plain.statusBar.scene, plain.statusBar.effect], [true, undefined, undefined])
  // A card from elsewhere has no cover.
  assert.equal(normalizeCard({ spec: 'chara_card_v2', data: { name: '别处的卡', first_mes: '你好。' } }).cover, null)
})

test('小手机: lists, tables and the pages after the first are kept off the bar, each an app of its own', async t => {
  const field = (path, label, show, more = {}) => ({ path, label, show, ...more })
  const flat = cleanStatusSpec({ phone: true, fields: [
    field('林小雨.好感度', '好感', 'meter'), field('主角.背包', '背包', 'table'), field('主角.任务', '任务', 'list'),
    field('主角.随身', '随身', 'tags'), field('主角.日记', '', 'long'), field('世界.地点', '地点', 'hidden'),
  ] })
  assert.equal(flat.phone, true)
  assert.equal(cleanStatusSpec({ phone: 'yes', fields: flat.fields }).phone, undefined)
  const cut = phoneApps(flat)
  assert.deepEqual(cut.bar.fields.map(one => one.path), ['林小雨.好感度', '主角.随身', '世界.地点'], 'gauges, tags and what is not shown stay')
  assert.deepEqual(cut.apps.map(app => [app.name, app.spec.fields.map(one => one.path)]), [['背包', ['主角.背包']], ['任务', ['主角.任务']], ['日记', ['主角.日记']]])
  // In pages: the first page is the bar, each other page an app with all that is on it; a list on the first page is an app too.
  const paged = cleanStatusSpec({ phone: true, fields: [
    field('林小雨.好感度', '好感', 'meter', { page: '她' }), field('林小雨.约定', '约定', 'list', { page: '她' }),
    field('主角.体力', '体力', 'meter', { page: '行囊' }), field('主角.背包', '背包', 'table', { page: '行囊' }), field('世界.传闻', '传闻', 'list', { page: '情报' }),
  ] })
  const pages = phoneApps(paged)
  assert.deepEqual(pages.bar.fields.map(one => [one.path, one.page]), [['林小雨.好感度', undefined]])
  assert.deepEqual(pages.apps.map(app => [app.name, app.spec.fields.map(one => one.path)]), [['约定', ['林小雨.约定']], ['行囊', ['主角.体力', '主角.背包']], ['情报', ['世界.传闻']]])
  // A list knows the lines this reply added: the app they are in is marked.
  const rows = statusGroups(pages.apps[2].spec, { 世界: { 传闻: ['码头夜里有灯', '店长换了人'] } }, { 世界: { 传闻: ['码头夜里有灯'] } })
  assert.deepEqual(rows[0].rows[0].added, ['店长换了人'])
  assert.equal(rows[0].changed, true)
  // The wizard turns it on with the rest of the front, and off by hand.
  const { forge, store } = await setup(t)
  assert.equal((await forge.update('frontdraft', { model: '' })).plan.status.phone, true)
  assert.equal((await store.getCard((await forge.saveCard('frontdraft', { avatar: PNG })).card.id)).statusBar.phone, true)
  assert.equal((await forge.update('frontdraft', { front: { phone: false } })).plan.status.phone, false)
  assert.equal((await store.getCard((await forge.saveCard('frontdraft', { avatar: PNG })).card.id)).statusBar.phone, undefined)
})

test('a card goes to SillyTavern with its cover as the first opening, and comes back with its own openings', () => {
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '雨宿', creator: '阿澈', tags: ['都市', '治愈'], first_mes: '雨下起来了。', alternate_greetings: ['雨下了七回。'], extensions: { cicatavern: { cover: { tagline: '雨停之前', lines: ['只有你记得她。'], openings: [{ title: '第一场雨' }, { title: '第七场雨' }], effect: 'rain' } } } } })
  assert.equal(card.firstMes, '雨下起来了。')
  const out = sillyTavernCard(forSillyTavern(card))
  // The cover stands first; the card's openings are the message's other versions, in their order.
  assert.match(out.data.first_mes, /^<CoverPage\/>\n（开场页：/)
  assert.deepEqual(out.data.alternate_greetings, ['雨下起来了。', '雨下了七回。'])
  const scripts = out.data.extensions.regex_scripts
  const hide = scripts.find(script => script.id === 'cicatavern-cover-hide')
  const show = scripts.find(script => script.id === 'cicatavern-cover')
  assert.deepEqual([hide.promptOnly, hide.replaceString, show.markdownOnly], [true, '', true])
  assert.equal(new RegExp(show.findRegex.slice(1, -1)).exec(out.data.first_mes)[0], out.data.first_mes, 'the whole of the first opening is the page')
  // The page: this app's own drawing code, the card's words as data, nothing SillyTavern would read as its own.
  const page = show.replaceString
  assert.match(page, /^```html\n<!DOCTYPE html>/)
  assert.ok(page.includes('"tagline":"雨停之前"') && page.includes('CP.coverPage(') && page.includes('setChatMessages([{message_id:0,swipe_id:index+1}])'))
  assert.ok(page.includes('.cover-title') && page.includes('@keyframes drift-fall') && page.includes('.drift-rain'))
  assert.equal(/\{\{|\$[\d<]/.test(page), false)
  assert.equal(page.slice(8, -4).includes('```'), false)
  // Gone out twice, it is not covered twice.
  assert.equal(forSillyTavern(forSillyTavern(card)).alternateGreetings.length, 2)
  // Brought back in: its own openings, its cover, and no regex of the cover's.
  const back = normalizeCard(out)
  assert.deepEqual([back.firstMes, back.alternateGreetings], ['雨下起来了。', ['雨下了七回。']])
  assert.equal(back.cover.tagline, '雨停之前')
  assert.equal(back.regexScripts.some(script => script.id.startsWith('cicatavern-cover')), false)
  // A card with no cover goes out as it is; an English card's note is in English.
  const plain = normalizeCard({ spec: 'chara_card_v2', data: { name: '别处的卡', first_mes: '你好。' } })
  assert.equal(sillyTavernCard(forSillyTavern(plain)).data.first_mes, '你好。')
  const english = normalizeCard({ spec: 'chara_card_v2', data: { name: 'Rain Shelter', first_mes: 'It began to rain.', extensions: { cicatavern: { cover: { tagline: 'Before the rain stops' } } } } })
  const abroad = sillyTavernCard(forSillyTavern(english))
  assert.match(abroad.data.first_mes, /^<CoverPage\/>\n\(Cover page:/)
  assert.deepEqual(abroad.data.alternate_greetings, ['It began to rain.'], 'the only opening of a card is still a door to go through')
  assert.ok(abroad.data.extensions.regex_scripts.find(script => script.id === 'cicatavern-cover').replaceString.includes('Pick an opening'))
})

test('修改角色卡 puts a cover on a card, changes its words and takes it off', () => {
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '别处的卡', first_mes: '你好。' } })
  assert.deepEqual(editCard(card, { cover: { tagline: '一句话', lines: ['一', ''], effect: 'snow' } }), { changed: ['cover'], prefix: false })
  assert.deepEqual(card.cover, { tagline: '一句话', lines: ['一'], effect: 'snow' })
  assert.deepEqual(editCard(card, { cover: { tagline: '一句话', lines: ['一'], effect: 'snow' } }).changed, [])
  assert.deepEqual(editCard(card, { cover: null }).changed, ['cover'])
  assert.equal(card.cover, null)
  assert.deepEqual(editCard(card, { description: '新的描述' }).changed, ['description'], 'a patch without a cover leaves it alone')
})

test('a look dresses the cover too: the request describes it for a card that has one, and the exported page carries the rules', () => {
  const spec = cleanStatusSpec({ palette: { bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' }, skin: { name: '像素', css: '.status-bar { border-radius: 0 }\n.cover-title { letter-spacing: .3em }\n.cover-door.picked { background: var(--accent) }' }, fields: [{ path: '林小雨.好感度', label: '好感', show: 'meter' }] })
  const said = card => skinRequest(card, spec, { 林小雨: { 好感度: 10 } }).messages[0].content
  assert.match(said({ name: '雨宿', description: '雨女', cover: { tagline: '雨停之前', lines: [] } }), /<cover_page>[\s\S]*\.cover-doors > \.cover-door[\s\S]*<\/cover_page>/)
  assert.equal(said({ name: '雨宿', description: '雨女' }).includes('<cover_page>'), false)
  // What the model writes for the cover is kept like the rest, and reaches only what wears the look.
  assert.match(spec.skin.css, /\.cover-title \{ letter-spacing: \.3em \}/)
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '雨宿', first_mes: '雨下起来了。', extensions: { cicatavern: { cover: { tagline: '雨停之前' }, status_bar: spec } } } })
  const page = sillyTavernCard(forSillyTavern(card)).data.extensions.regex_scripts.find(script => script.id === 'cicatavern-cover').replaceString
  assert.match(page, /\.skin-[0-9a-f]{8} \.cover-title \{ letter-spacing: \.3em \}/)
  assert.match(page, /SCOPE="skin-[0-9a-f]{8}"/)
  assert.ok(page.includes('"surface":"#101820"'), 'the cover is in the bar\'s colors')
})

test('a look is asked with the phone\'s apps named, so the icons and the phone are dressed too', () => {
  const fields = [{ path: '林小雨.好感度', label: '好感', show: 'meter' }, { path: '主角.背包', label: '背包', show: 'table' }, { path: '主角.情报', label: '情报', show: 'list' }]
  const state = { 林小雨: { 好感度: 10 }, 主角: { 背包: { 伞: { 数量: 1 } }, 情报: ['一条'] } }
  const said = spec => skinRequest({ name: '雨宿', description: '雨女' }, cleanStatusSpec(spec), state).messages[0].content
  assert.match(said({ phone: true, fields }), /开了「小手机」：背包、情报 不直接摆在状态栏上[\s\S]*\.status-phone-frame/)
  assert.equal(said({ fields }).includes('小手机'), false)
  assert.equal(said({ phone: true, fields: fields.slice(0, 1) }).includes('小手机'), false, 'a phone with nothing in it is not there')
})

test('a card written before the face and the place were given has them in its starting values and its rules', async t => {
  // The draft here is written (its state entries made) before the front first puts the two variables on the plan.
  const { forge, store } = await setup(t)
  await forge.update('frontdraft', { model: '' })
  const saved = await store.getCard((await forge.saveCard('frontdraft', { avatar: PNG })).card.id)
  const book = saved.book.entries.map(entry => entry.content).join('\n')
  assert.match(book, /表情: 平静/, 'the starting values have the face')
  assert.match(book, /当前地点/)
  assert.match(book, /平静、微笑、开心、害羞、生气、难过、惊讶、思考/, 'the rules say which words the face goes by')
  assert.match(book, /晴空便利店/)
})

test('the pages SillyTavern gets never empty the body they are in (Tavern Helper keeps their styles there)', async t => {
  const { forge, store } = await setup(t)
  await forge.update('frontdraft', { look: { palette: { bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' }, skin: { name: '雨夜', css: '.status-bar { border-radius: 4px }' } } })
  const saved = await store.getCard((await forge.saveCard('frontdraft', { avatar: PNG })).card.id)
  const scripts = card => Object.fromEntries(sillyTavernCard(forSillyTavern(card)).data.extensions.regex_scripts.map(script => [script.id, script.replaceString]))
  const now = scripts(saved)
  for (const id of ['cicatavern-status-bar', 'cicatavern-cover']) assert.equal(now[id].includes('document.body.replaceChildren'), false, id)
  assert.ok(now['cicatavern-status-bar'].includes('ROOT.replaceChildren(') && now['cicatavern-cover'].includes('document.body.append(page.node)'))
  // A card saved before this was put right goes out put right.
  const old = structuredClone(saved)
  const bar = old.regexScripts.find(script => script.id === 'cicatavern-status-bar')
  bar.replaceString = bar.replaceString.replace('const ROOT=document.createElement("div");document.body.append(ROOT);\n', '').replace('ROOT.replaceChildren(', 'document.body.replaceChildren(')
  assert.ok(bar.replaceString.includes('document.body.replaceChildren('))
  assert.equal(scripts(old)['cicatavern-status-bar'], now['cicatavern-status-bar'])
  // A whole-page bar is drawn for the latest replies only (最大深度 2: three messages); the small one for all of them.
  const depth = card => sillyTavernCard(forSillyTavern(card)).data.extensions.regex_scripts.find(script => script.id === 'cicatavern-status-bar').maxDepth
  assert.equal(saved.regexScripts.find(script => script.id === 'cicatavern-status-bar').maxDepth, 2)
  bar.maxDepth = null
  assert.equal(depth(old), 2, 'one saved before goes out kept to them too')
  await forge.update('frontdraft', { look: null, front: { phone: false, effect: '' } })
  const small = await store.getCard((await forge.saveCard('frontdraft', { avatar: PNG })).card.id)
  assert.equal(small.regexScripts.find(script => script.id === 'cicatavern-status-bar').maxDepth, null)
  assert.equal(depth(small), null)
})

test('a draft from before there was a front keeps its card as it was, till something is turned on', async t => {
  const { forge, root } = await setup(t)
  // As drafts were kept before: no front with it.
  const draftFile = path.join(root, 'forge', 'frontdraft.json')
  const raw = JSON.parse(await readFile(draftFile, 'utf8'))
  delete raw.front
  await writeFile(draftFile, JSON.stringify(raw))
  const old = await forge.update('frontdraft', { model: '' })
  assert.equal(old.plan.cover, null)
  assert.deepEqual([old.plan.status.portrait, old.plan.status.scene, old.plan.status.phone], [false, false, false])
  assert.equal(old.plan.tracking.variables.some(v => /表情|当前地点/.test(v.path)), false)
  // One thing turned on is that one thing.
  const on = await forge.update('frontdraft', { front: { cover: true } })
  assert.equal(on.plan.cover.tagline, '深夜便利店里，只在雨夜出现的女孩')
  assert.deepEqual([on.plan.status.portrait, on.plan.status.scene, on.plan.status.phone], [false, false, false])
})

test('a cover kept out of SillyTavern: the card goes out with its own openings', async t => {
  assert.deepEqual(cleanCover({ tagline: '雨停之前', st: false }), { tagline: '雨停之前', lines: [], st: false })
  assert.equal(cleanCover({ tagline: '雨停之前', st: true }).st, undefined)
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '雨宿', first_mes: '雨下起来了。', alternate_greetings: ['雨下了七回。'], extensions: { cicatavern: { cover: { tagline: '雨停之前', st: false } } } } })
  const out = sillyTavernCard(forSillyTavern(card))
  assert.equal(out.data.first_mes, '雨下起来了。')
  assert.equal(out.data.extensions.regex_scripts.some(script => script.id.startsWith('cicatavern-cover')), false)
  assert.equal(out.data.extensions.cicatavern.cover.st, false, 'the cover itself still goes with the card, for this app')
  // The wizard's 门面 and 修改角色卡 both set it.
  const { forge } = await setup(t)
  assert.equal((await forge.update('frontdraft', { front: { coverSt: false } })).plan.cover.st, false)
  assert.equal((await forge.update('frontdraft', { front: { coverSt: true } })).plan.cover.st, undefined)
  assert.deepEqual(editCard(card, { cover: { ...card.cover, st: undefined } }).changed, ['cover'])
  assert.match(sillyTavernCard(forSillyTavern(card)).data.first_mes, /^<CoverPage\/>/)
})
