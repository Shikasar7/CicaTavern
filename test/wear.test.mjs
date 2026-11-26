// 衣柜 (server/wear.mjs): what a cast member can wear, what the story's marks and the player's changes put them in, along the
// story's own path; what the turn says of it and the pictures are drawn with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanRoster, flattenFrame, frameFormat, parseFrame, parseWardrobeDraft, rosterBrief, withSomeone } from '../server/roster.mjs'
import { WEAR_BLOCK, changeWear, dress, hasWardrobe, keepClothes, outfitsOf, pathToNode, takeClothes, wearBlock, wearOn, wearView } from '../server/wear.mjs'
import { hasMarks, markSpeakers, outfitSaid, wearValue, splitLines, takeMarks, wearMarks, withoutMarks, wornOn } from '../web/shared/vn.js'
import { buildTurnPrompt } from '../server/prompt.mjs'
import { cardSummary, normalizeCard } from '../server/cards.mjs'
import { createStore } from '../server/store.mjs'
import { createApp } from '../server/http.mjs'
import { createScenes } from '../server/scenes.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const ROSTER = cleanRoster([
  { id: 'aaaaaa', name: '沈岚', aliases: '岚姐', looks: 'black hair', outfit: 'grey cardigan', wardrobe: [{ id: 'bbbbbb', name: '睡衣', tags: 'blue pajamas', when: '在家、睡前' }, { name: '礼服', tags: 'red gown' }] },
  { id: 'cccccc', name: '老周', kind: 'boy', looks: 'grey beard', outfit: 'work clothes' },
  { id: 'dddddd', name: '主角', player: true, kind: 'boy', looks: 'short hair', outfit: 'hoodie', wardrobe: [{ name: '西装', tags: 'black suit' }] },
])
const chatOf = (...texts) => {
  const nodes = { root: { id: 'root', role: 'assistant', parent: null, text: '开场' } }
  let parent = 'root'
  texts.forEach((item, i) => {
    const node = { id: `n${i}`, role: i % 2 ? 'assistant' : 'user', parent, text: '', ...(typeof item === 'string' ? { text: item } : item) }
    nodes[node.id] = node
    parent = node.id
  })
  return { id: 'c', names: { char: '沈岚', user: '阿青' }, nodes }
}
const pathOf = chat => pathToNode(chat, Object.keys(chat.nodes).at(-1))
const worn = (chat, options) => Object.fromEntries([...wearOn(chat, pathOf(chat), ROSTER, options)].map(([id, outfit]) => [id, outfit.name]))

test('an entry keeps its other outfits, each with a name of its own; old ones have none', () => {
  const [entry] = cleanRoster([{ name: '沈岚', outfit: 'grey cardigan', wardrobe: [{ name: '睡衣', tags: 'blue pajamas' }, { name: '睡衣' }, { name: '平时' }, { name: '' }, null, { name: '礼【服】|', when: '宴会（晚上）' }, ...Array.from({ length: 12 }, (_, i) => ({ name: `第${i}套` }))] }])
  assert.equal(entry.wardrobe.length, 7)
  assert.deepEqual(entry.wardrobe.slice(0, 2).map(item => [item.name, item.tags, item.when]), [['睡衣', 'blue pajamas', ''], ['礼服', '', '宴会 晚上']])
  assert.ok(entry.wardrobe.every(item => /^[a-z0-9]{6,16}$/.test(item.id)))
  assert.deepEqual(cleanRoster([entry])[0].wardrobe, entry.wardrobe, 'kept as it is, ids and all')
  const [old] = cleanRoster([{ name: '老周', outfit: 'work clothes' }])
  assert.equal('wardrobe' in old, false, 'an entry with none is as it was')
  assert.deepEqual(outfitsOf(ROSTER[0]).map(item => item.name), ['平时', '睡衣', '礼服'])
  assert.deepEqual([hasWardrobe(ROSTER[0]), hasWardrobe(ROSTER[1])], [true, false])
})

test('the marks: read, taken out of what is shown, left alone when they are not ours', () => {
  const text = '她进了里屋。\n【换装|沈岚|睡衣】\n她走出来。**【换装｜老周｜雨衣】**'
  assert.deepEqual(wearMarks(text).map(({ name, outfit }) => [name, outfit]), [['沈岚', '睡衣'], ['老周', '雨衣']])
  assert.equal(markSpeakers(text), '她进了里屋。\n她走出来。')
  assert.equal(withoutMarks(text), '她进了里屋。\n她走出来。')
  assert.equal(hasMarks('【换装|沈岚|睡衣】'), false, 'not a line of 视觉小说格式')
  assert.deepEqual(takeMarks('【换装|沈岚|睡衣】她走出来。').effects.wear, [{ name: '沈岚', outfit: '睡衣' }])
  assert.deepEqual(takeMarks('【效果|震屏】【换装|沈岚|睡衣】').effects.wear, [{ name: '沈岚', outfit: '睡衣' }])
  for (const other of ['【换装|睡衣】', '【换装|a|b|c】', '【衣服|沈岚|睡衣】', '【好感度：85｜心情：开心】']) assert.equal(wearMarks(other).length, 0, other)
  assert.equal(markSpeakers('【换装|沈岚', undefined, { partial: true }), '', 'one still being written is not shown')
})

test('who wears what: the usual at first, then the marks and the player\'s changes in order, along the path', () => {
  assert.deepEqual(worn(chatOf('你好')), { aaaaaa: '平时', dddddd: '平时' }, 'only those with a wardrobe')
  assert.deepEqual(worn(chatOf('去睡吧', '好。\n【换装|岚姐|睡衣】\n她出来了。')), { aaaaaa: '睡衣', dddddd: '平时' }, 'an alias counts')
  assert.deepEqual(worn(chatOf('去睡吧', '【换装|沈岚|睡衣】', '早', '【换装|沈岚|平时】\n【换装|阿青|西装】')), { aaaaaa: '平时', dddddd: '西装' }, 'the player by the chat\'s name')
  // A cast that came from elsewhere, with fields missing, does not stop the turn.
  const rough = [{ id: 'aaaaaa', name: '沈岚', wardrobe: [{ id: 'bbbbbb', name: '睡衣' }] }, { id: 'x' }]
  const said = chatOf('走', '【换装|沈岚|睡衣】')
  assert.equal(wearOn(said, pathOf(said), rough).get('aaaaaa').name, '睡衣')
  assert.match(wearBlock(said, pathOf(said), rough), /现在：沈岚 — 睡衣/)
  // Not in the list: her 泳装 all the same, with nothing said of it yet. Nobody on the list, or without a wardrobe: no change.
  const swim = chatOf('走', '【换装|沈岚|泳装】\n【换装|老周|雨衣】\n【换装|路人|斗篷】')
  assert.deepEqual(worn(swim), { aaaaaa: '泳装', dddddd: '平时' })
  assert.equal(wearOn(swim, pathOf(swim), ROSTER).get('aaaaaa').tags, '')
  // The player's own change, and the story's after it.
  const mine = chatOf('走', { text: '嗯。', wear: { aaaaaa: { id: 'bbbbbb', name: '睡衣' } } })
  assert.deepEqual(worn(mine).aaaaaa, '睡衣')
  mine.nodes.n2 = { id: 'n2', role: 'user', parent: 'n1', text: '再走' }
  mine.nodes.n3 = { id: 'n3', role: 'assistant', parent: 'n2', text: '【换装|沈岚|礼服】' }
  assert.equal(worn(mine).aaaaaa, '礼服')
  assert.equal(Object.fromEntries([...wearOn(mine, pathToNode(mine, 'n1'), ROSTER)].map(([id, item]) => [id, item.name])).aaaaaa, '睡衣', 'an earlier reply, or a branch from it, has its own')
  mine.nodes.n3.text = '她没换。'
  assert.equal(worn(mine).aaaaaa, '睡衣', 'edited, it follows')
  mine.nodes.n3 = { ...mine.nodes.n3, text: '【换装|沈岚|礼服】', deleted: true }
  assert.equal(worn(mine).aaaaaa, '睡衣')
  // A picture of words before the mark is in what came before.
  const turn = chatOf('走', '沈岚收起伞，进里屋去了。\n\n【换装|沈岚|睡衣】\n沈岚换好衣服走出来，头发还湿着。')
  assert.equal(worn(turn, { anchor: '沈岚收起伞，进里屋' }).aaaaaa, '平时')
  assert.equal(worn(turn, { anchor: '换好衣服走出来' }).aaaaaa, '睡衣')
  assert.equal(worn(turn, { anchor: '不在这里的一句话' }).aaaaaa, '睡衣')
})

test('the turn says it, and the older messages do not', () => {
  assert.equal(wearBlock(chatOf('走'), [], [ROSTER[1]]), '')
  const chat = chatOf('走', '【换装|沈岚|睡衣】')
  const block = wearBlock(chat, pathOf(chat), ROSTER)
  assert.match(block, /^<穿着>\n现在：沈岚 — 睡衣（blue pajamas）；阿青 — 平时（hoodie）\n各人的衣服：沈岚：平时、睡衣（在家、睡前）、礼服；阿青：平时、西装\n[\s\S]*【换装\|名字\|套名】[\s\S]*\n<\/穿着>$/)
  assert.doesNotMatch(block, /老周/)
  const prompt = buildTurnPrompt({ names: chat.names, input: '走', wear: block, reminder: '提醒' })
  assert.match(prompt, /<\/穿着>\n\n<本轮提醒>/)
  assert.equal(prompt.replace(WEAR_BLOCK, ''), buildTurnPrompt({ names: chat.names, input: '走', reminder: '提醒' }))
})

test('a picture: the outfit joins the looks word for word; without a wardrobe nothing changes', () => {
  const chat = chatOf('走', '【换装|沈岚|睡衣】')
  const now = wearOn(chat, pathOf(chat), ROSTER)
  const brief = rosterBrief(ROSTER, '阿青', now)
  assert.match(brief, /\[沈岚\] girl; wears now: 睡衣 \(clothes filled in automatically/)
  assert.match(brief, /\[老周\] boy; usual outfit: work clothes/)
  const frame = parseFrame('场景: kitchen\n[沈岚] sitting, drinking tea | left\n[老周] work clothes, standing | right', ROSTER, '阿青')
  assert.match(flattenFrame(dress(frame, now), 'tags'), /black hair, blue pajamas, sitting, drinking tea/)
  assert.match(flattenFrame(dress(frame, now), 'tags'), /grey beard, work clothes, standing/)
  assert.equal(frame.characters[0].entry.looks, 'black hair', 'the roster itself is untouched')
  // Plain casts: the same request as before, word for word.
  const plain = ROSTER.map(({ wardrobe, ...entry }) => entry)
  assert.equal(rosterBrief(plain, '阿青', wearOn(chat, pathOf(chat), plain)), rosterBrief(plain, '阿青'))
  assert.equal(frameFormat('tags', 'standard', { dressed: false }), frameFormat('tags'))
  assert.match(frameFormat('tags', 'standard', { dressed: true }), /write no clothes either/)
  assert.equal(dress(frame, new Map()), frame)
  assert.equal(withSomeone('场景: kitchen', ROSTER, '阿青', '沈岚'), '场景: kitchen\n[沈岚] | center', 'her clothes are added, not written')
})

test('an outfit nobody described: asked for once, the chat\'s from there on', () => {
  const chat = chatOf('走', '【换装|沈岚|泳装】')
  const now = wearOn(chat, pathOf(chat), ROSTER)
  assert.match(rosterBrief(ROSTER, '阿青', now), /wears now: 泳装 \(.*also write one line of its own: 衣服\[沈岚\]/)
  assert.deepEqual(takeClothes('场景: beach\n[沈岚] running\n衣服[沈岚]: black one-piece swimsuit, sarong'), { text: '场景: beach\n[沈岚] running', clothes: [{ name: '沈岚', tags: 'black one-piece swimsuit, sarong' }] })
  for (const line of ['**衣服【沈岚】：** swimsuit', '- 衣服 沈岚: swimsuit', 'Clothes[沈岚]: swimsuit']) assert.deepEqual(takeClothes(line).clothes, [{ name: '沈岚', tags: 'swimsuit' }], line)
  assert.equal(keepClothes(chat, ROSTER, now, [{ name: '老周', tags: 'x' }, { name: '谁', tags: 'x' }]), false)
  assert.equal(keepClothes(chat, ROSTER, now, [{ name: '沈岚', tags: 'black one-piece swimsuit' }]), true)
  const after = wearOn(chat, pathOf(chat), ROSTER)
  assert.equal(after.get('aaaaaa').tags, 'black one-piece swimsuit')
  assert.match(rosterBrief(ROSTER, '阿青', after), /wears now: 泳装 \(clothes filled in automatically, do not write them\)/)
  assert.match(wearBlock(chat, pathOf(chat), ROSTER), /沈岚：平时、睡衣（在家、睡前）、礼服、泳装/)
  assert.equal(keepClothes(chat, ROSTER, after, [{ name: '沈岚', tags: 'another' }]), false, 'once it is described it stays so')
})

test('换衣服: the choices, and the player\'s change on the newest message', () => {
  const chat = chatOf('走', '【换装|沈岚|泳装】')
  const view = wearView(chat, pathOf(chat), ROSTER)
  assert.deepEqual(view.map(person => [person.name, person.now.name, person.outfits.map(item => item.name)]), [['沈岚', '泳装', ['平时', '睡衣', '礼服', '泳装']], ['阿青', '平时', ['平时', '西装']]])
  const tip = chat.nodes.n1
  assert.equal(changeWear(chat, tip, ROSTER, { aaaaaa: { id: 'nope' }, cccccc: { id: 'usual' }, zzz: { id: 'usual' } }), null)
  assert.ok(changeWear(chat, tip, ROSTER, { aaaaaa: { id: 'usual' } }))
  assert.equal(worn(chat).aaaaaa, '平时')
})

test('the stage: the same clothes as the pictures, line by line in the reply on screen', () => {
  const idOf = name => ({ 沈岚: 'aaaaaa', 岚姐: 'aaaaaa', 阿青: 'dddddd' })[name]
  const chat = chatOf('走', '她进去了。\n【换装|岚姐|睡衣】\n她出来了。')
  assert.deepEqual([...wornOn(pathOf(chat), ROSTER, idOf)], [['aaaaaa', 'bbbbbb']])
  assert.deepEqual([...wornOn(pathOf(chat), ROSTER, idOf, [])], [], 'not read that far yet')
  assert.deepEqual([...wornOn(pathOf(chat), ROSTER, idOf, [{ name: '沈岚', outfit: '睡衣' }])], [['aaaaaa', 'bbbbbb']])
  const steps = splitLines(chat.nodes.n1.text)
  assert.deepEqual(steps.map(step => step.effects?.wear ?? null), [null, [{ name: '岚姐', outfit: '睡衣' }]], 'on the line after the mark')
  // Back to the usual, or into something the 衣柜 does not have: no 立绘 of its own.
  for (const name of ['平时', '泳装']) assert.deepEqual([...wornOn(pathOf(chatOf('走', `【换装|沈岚|睡衣】\n她。\n【换装|沈岚|${name}】`)), ROSTER, idOf)], [])
  const mine = chatOf('走', { text: '嗯。', wear: { dddddd: { id: ROSTER[2].wardrobe[0].id, name: '西装' } } })
  assert.deepEqual([...wornOn(pathOf(mine), ROSTER, idOf, [])], [['dddddd', ROSTER[2].wardrobe[0].id]])
  assert.deepEqual([...wornOn(pathOf(mine), ROSTER.map(({ wardrobe, ...entry }) => entry), idOf)], [])
})

test('衣服跟着变量走: a change of the card\'s own variable changes the clothes; the player\'s own change stays until the next', () => {
  assert.equal(wearValue({ 沈岚: { 衣着: ' 睡衣 ' } }, '沈岚.衣着'), '睡衣')
  assert.equal(wearValue({ 沈岚: { 衣着: ['睡衣', '现在穿的'] } }, 'stat_data.沈岚.衣着'), '睡衣')
  assert.equal(wearValue({ 沈岚: { 衣着: { 上衣: '白衬衫', 下装: '短裙', 件数: 2 } } }, '/沈岚/衣着'), '白衬衫，短裙')
  for (const nothing of [{}, { 沈岚: 3 }, { 沈岚: { 衣着: '无' } }, { 沈岚: { 衣着: 5 } }, null]) assert.equal(wearValue(nothing, '沈岚.衣着'), '')
  const outfits = [{ name: '睡衣' }, { name: '礼服' }, { name: '晚礼服' }]
  assert.equal(outfitSaid(outfits, '晚礼服').name, '晚礼服')
  assert.equal(outfitSaid(outfits, '脱下礼服，换上蓝色睡衣').name, '睡衣')
  assert.equal(outfitSaid(outfits, '泳装'), null)
  const roster = ROSTER.map(entry => (entry.id === 'aaaaaa' ? { ...entry, wearPath: '沈岚.衣着' } : entry))
  assert.equal(cleanRoster(roster)[0].wearPath, '沈岚.衣着')
  assert.equal('wearPath' in cleanRoster(ROSTER)[0], false)
  const at = value => ({ state: { 沈岚: { 衣着: value } }, text: '……' })
  const on = (chat, options) => wearOn(chat, pathOf(chat), roster, options).get('aaaaaa').name
  const idOf = () => null
  const page = chat => wornOn(pathOf(chat), roster, idOf).get('aaaaaa') ?? 'usual'
  const sleep = chatOf('走', at('平时'), '走', at('淡蓝睡衣'))
  assert.equal(on(sleep), '睡衣')
  assert.equal(page(sleep), 'bbbbbb')
  assert.equal(wornOn(pathOf(sleep), roster, idOf, [], false).size, 0, 'not yet read to the change')
  // Chosen by the player while the variable stays as it is, then the variable moves on.
  const mine = chatOf('走', at('睡衣'), { wear: { aaaaaa: { id: '', name: '礼服' } } }, at('睡衣'))
  assert.equal(on(mine), '礼服')
  const moved = chatOf('走', at('睡衣'), { wear: { aaaaaa: { id: '', name: '礼服' } } }, at('红色泳装'))
  assert.equal(on(moved), '红色泳装')
  assert.equal(page(moved), 'usual')
  const block = wearBlock(moved, pathOf(moved), roster)
  assert.match(block, /沈岚的衣服看变量「沈岚\.衣着」/)
  assert.match(block, /【换装\|名字\|套名】/, '主角 still changes by a mark')
  assert.doesNotMatch(wearBlock(moved, pathOf(moved), roster.filter(entry => !entry.player)), /【换装/)
  // A variable alone, with no 衣柜.
  const bare = [{ ...roster[0], wardrobe: undefined }]
  assert.equal(wearOn(moved, pathOf(moved), bare).get('aaaaaa').name, '红色泳装')
  assert.equal(wornOn(pathOf(moved), bare, idOf).size, 0)
})

test('a 立绘 for each outfit: uploaded, kept with the card\'s cast, gone with the outfit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-outfits-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard({ name: '沈岚' })
  card.media = { roster: ROSTER }
  await store.saveCard(card)
  const drawn = []
  const scenes = createScenes(store, { media: { drawOutfit: async (cardId, entryId, outfit, base) => (drawn.push([entryId, outfit.name, outfit.tags, Boolean(base)]), { buffer: PNG, backend: 'x' }) } })
  const url = `data:image/png;base64,${PNG.toString('base64')}`
  const set = await scenes.setOutfit(card.id, 'aaaaaa', 'bbbbbb', url)
  assert.equal(set.outfits.aaaaaa.bbbbbb.source, 'upload')
  assert.ok(await scenes.readSprite(card.id, set.outfits.aaaaaa.bbbbbb.file))
  await scenes.setSprite(card.id, 'aaaaaa', url)
  const again = await scenes.drawOutfit(card.id, 'aaaaaa', 'bbbbbb')
  assert.deepEqual(drawn, [['aaaaaa', '睡衣', 'blue pajamas', true]])
  assert.equal(again.outfits.aaaaaa.bbbbbb.source, 'drawn')
  assert.ok(again.sprites.aaaaaa, 'the usual 立绘 is untouched')
  await assert.rejects(scenes.setOutfit(card.id, 'aaaaaa', 'nope', url), /没有这套衣服/)
  await assert.rejects(scenes.setOutfit(card.id, 'cccccc', 'bbbbbb', url), /没有这套衣服/)
  assert.deepEqual((await scenes.removeOutfit(card.id, 'aaaaaa', 'bbbbbb')).outfits, {})
  // Taken out of the 衣柜: its 立绘 is not offered any more.
  await scenes.setOutfit(card.id, 'aaaaaa', 'bbbbbb', url)
  card.media = { roster: ROSTER.map(entry => (entry.id === 'aaaaaa' ? { ...entry, wardrobe: entry.wardrobe.slice(1) } : entry)) }
  await store.saveCard(card)
  assert.deepEqual((await scenes.sprites(card.id)).outfits, {})
  // Once the cast is saved its file goes too; the others stay.
  const kept = await scenes.setOutfit(card.id, 'aaaaaa', card.media.roster[0].wardrobe[0].id, url)
  const gone = again.outfits.aaaaaa.bbbbbb.file
  assert.equal(await scenes.readSprite(card.id, gone), null)
  const left = kept.outfits.aaaaaa[card.media.roster[0].wardrobe[0].id].file
  await scenes.dropGoneOutfits(card.id)
  assert.ok(await scenes.readSprite(card.id, left))
  card.media = { roster: card.media.roster.map(({ wardrobe, ...entry }) => entry) }
  await store.saveCard(card)
  await scenes.dropGoneOutfits(card.id)
  assert.equal(await scenes.readSprite(card.id, left), null)
})

test('从卡里找衣服: those on the list, without what they have', () => {
  const answer = '```json\n[{"name":"岚姐","wardrobe":[{"name":"睡衣","tags":"x"},{"name":"旗袍","tags":"china dress","when":"过节"},{"name":"没写"}]},{"name":"路人","wardrobe":[{"name":"雨衣","tags":"raincoat"}]},{"name":"老周","wardrobe":[]}]\n```'
  const found = parseWardrobeDraft(answer, ROSTER)
  assert.deepEqual(found.map(item => [item.id, item.wardrobe.map(outfit => [outfit.name, outfit.tags, outfit.when])]), [['aaaaaa', [['旗袍', 'china dress', '过节']]]])
  assert.deepEqual(parseWardrobeDraft('没有', ROSTER), [])
})

test('over the app: the card says it has a wardrobe, the change is saved, an outfit of the chat goes into the card', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-wear-'))
  const app = createApp({ dataRoot: root, edition: 'release', proxy: 'off' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${server.address().port}`
  const call = async (at, { method = 'GET', body } = {}) => {
    const res = await fetch(url + at, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const card = normalizeCard({ name: '沈岚', first_mes: '【换装|沈岚|泳装】她走出来。' })
  card.media = { roster: ROSTER }
  await app.store.saveCard(card)
  assert.equal(cardSummary(card).wardrobe, true)
  assert.equal(cardSummary(normalizeCard({ name: 'x' })).wardrobe, false)
  const chat = (await call('/api/chats', { method: 'POST', body: { cardId: card.id } })).body
  const before = (await call(`/api/chats/${chat.id}/wear`)).body.people
  assert.deepEqual(before.map(person => person.now.name), ['泳装', '平时'])
  const changed = await call(`/api/chats/${chat.id}/wear`, { method: 'PUT', body: { wear: { aaaaaa: { id: 'bbbbbb' } } } })
  assert.deepEqual([changed.status, changed.body.people[0].now.name], [200, '睡衣'])
  assert.equal((await call(`/api/chats/${chat.id}/wear`, { method: 'PUT', body: { wear: {} } })).status, 400)
  // Described once, kept in the card.
  const saved = await app.store.getChat(chat.id)
  saved.wardrobe = { aaaaaa: [{ name: '泳装', tags: 'black swimsuit' }] }
  await app.store.saveChat(saved)
  const kept = await call(`/api/chats/${chat.id}/wear/keep`, { method: 'POST', body: { id: 'aaaaaa', name: '泳装' } })
  assert.equal(kept.status, 200)
  assert.deepEqual((await app.store.getCard(card.id)).media.roster[0].wardrobe.map(item => item.name), ['睡衣', '礼服', '泳装'])
  assert.equal((await call(`/api/chats/${chat.id}/wear/keep`, { method: 'POST', body: { id: 'aaaaaa', name: '没有' } })).status, 404)
})
