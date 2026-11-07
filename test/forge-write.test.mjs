import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import YAML from 'yaml'
import { normalizeCard, parseCardFile, readPngText, writeCardPng } from '../server/cards.mjs'
import { createForge } from '../server/forge/index.mjs'
import { cleanVariables, editTracking, normalizePlan } from '../server/forge/prompts.mjs'
import { applyIssues, cardJson, chineseText, lintText, matchWritten, newCard, planFacts, readTagged, retrack, reviewRequest, stateContent } from '../server/forge/write.mjs'
import { statusSpecOf } from '../server/forge/status.mjs'
import { rangeOf } from '../web/shared/status.js'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636060f80f0000010100005a4d6b8a0000000049454e44ae426082', 'hex')
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`

const PLAN = {
  name: '雨宿',
  summary: '深夜便利店里，只在雨夜出现的女孩。',
  user_role: { identity: '晴空便利店的夜班店员' },
  world: { kind: '真实', overview: '现代都市，多雨的港城', rules: ['她只在下雨时能被看见'], places: [], factions: [], history: [] },
  characters: [
    { name: '林小雨', kind: 'core', aliases: ['小雨'], gender: '女', identity: '雨女', relationship: '每逢下雨就来店里', personality: { base: '孤独', main: ['温柔'] }, looks_tags: 'black hair, wet hair', outfit_tags: 'white raincoat' },
    { name: '王店长', kind: 'npc', role: '偶尔来查岗' },
  ],
  style: { perspective: '第三人称', tone: '克制', mood: '安静' },
  play_rules: ['不替<user>说话'],
  tracking: { enabled: true, variables: [{ path: '林小雨.好感度', type: 'number', initial: '10', range: '0~100', check: '真心相待 +2~4' }, { path: '世界.雨势', type: 'string', initial: '中雨' }] },
  greetings: [{ title: '第三个雨夜', scene: '凌晨两点', situation: '她推门进来', length: '500~700' }, { title: '雨要停了', scene: '清晨', situation: '她在变淡', length: '300~500' }],
  avatar: { character: '林小雨', description: '湿发的女孩', tags: '1girl, rain, night' },
  assumptions: [],
  verbatim: ['氛围安静一点'],
}

/**
 * A pretend model for the writing steps; `fail` makes the next entries call answer without tags,
 * `broken` (a model id) makes every entries call to that model answer without them.
 */
async function fakeWriter() {
  const seen = []
  const state = { fail: 0, review: null, broken: '' }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const system = json.messages[0].content
    const asked = json.messages.at(-1).content
    seen.push({ system, asked, model: json.model })
    let text = ''
    if (system.includes('审稿人') && state.review) {
      text = state.review(asked)
    } else if (system.includes('审稿人')) {
      text = `<issues>[{"target": "世界设定", "type": "模糊词", "original": "仿佛", "suggestion": "像"}, {"target": "林小雨_基础信息", "type": "贴标签", "original": "找不到的句子", "suggestion": "改"}]</issues>`
    } else if (asked.includes('按要求改写')) {
      const names = [...asked.matchAll(/<entry name="([^"]+)">/g)].map(m => m[1])
      const greetings = [...asked.matchAll(/<greeting index="(\d+)">/g)].map(m => m[1])
      text = [...names.map(n => `<entry name="${n}">\n改写后的${n}\n</entry>`), ...greetings.map(i => `<greeting index="${i}">\n改写后的开场${i}\n</greeting>`)].join('\n')
    } else if (system.includes('开场白作者')) {
      const indexes = [...asked.matchAll(/^- 开场 (\d+)「/gm)].map(m => m[1])
      text = indexes.map(i => `<greeting index="${i}">\n凌晨两点十七分，门铃响了。开场 ${i} 的正文。<user> 抬起头。\n</greeting>`).join('\n')
    } else if (system.includes('角色卡写手')) {
      if (state.fail > 0 || json.model === state.broken) {
        if (json.model !== state.broken) state.fail--
        text = '我写好了，不过没用标签。'
      } else {
        const wanted = asked.split('这次要写下面这些条目：')[1] ?? ''
        const names = [...wanted.matchAll(/^- (.+?)：/gm)].map(m => m[1])
        text = names.map(n => `<entry name="${n}">\n${n === '世界设定' ? '时代: 现代\n与常识不同:\n  - 雨夜仿佛很长' : `${n}的内容`}\n</entry>`).join('\n')
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: json.model, choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, seen, state, close: () => server.close() }
}

async function setup(t, { draw = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-write-'))
  const fake = await fakeWriter()
  t.after(async () => {
    fake.close()
    await rm(root, { recursive: true, force: true })
  })
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `${fake.base}/v1`, apiKey: 'sk-forge-test', models: ['writer'] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/writer` })
  const forge = createForge(store, { draw })
  // A draft that already has its plan, as the talk would leave it.
  const plan = normalizePlan(PLAN)
  const now = new Date().toISOString()
  const draft = { id: 'draftone', createdAt: now, updatedAt: now, stage: 'plan', model: '', rounds: [{ user: { text: '雨夜', picks: [] }, assistant: { raw: '', reply: '好', questions: [] } }], brief: { title: '雨宿', readiness: 80, items: [], open: [] }, plan, card: null, job: null, error: null }
  await (await import('node:fs/promises')).mkdir(path.join(root, 'forge'), { recursive: true })
  await (await import('node:fs/promises')).writeFile(path.join(root, 'forge', 'draftone.json'), JSON.stringify(draft))
  return { root, store, forge, fake, plan }
}

// Not too often: on Windows a job cannot replace the draft while it is being read
// (forge save tries again for about 2.5 seconds), and reading every 10 ms in a busy
// full run kept it out that long (the page reads every 900 ms).
async function settled(forge, id) {
  for (let i = 0; i < 300; i++) {
    const draft = await forge.get(id)
    if (!draft.job) return draft
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('the job never finished')
}

test('state entries are built in code: initial values, rules, the update format', () => {
  const plan = normalizePlan(PLAN)
  const byPart = part => stateContent(plan.entries.find(e => e.part === part), plan)
  assert.deepEqual(YAML.parse(byPart('initvar')), { 林小雨: { 好感度: 10 }, 世界: { 雨势: '中雨' } })
  assert.deepEqual(YAML.parse(byPart('rules')).变量更新规则.林小雨.好感度, { type: 'number', range: '0~100', check: ['真心相待 +2~4'] })
  assert.match(byPart('variables'), /\{\{format_message_variable::stat_data\}\}/)
  assert.match(byPart('format'), /"path": "\/林小雨\/好感度", "value": 12/)
})

test('the local check finds stock phrasing but leaves the user\'s own words alone', () => {
  assert.deepEqual(lintText('她仿佛在等人——又像不是。').map(h => h.label), ['破折号', '模糊词'])
  assert.deepEqual(lintText('氛围安静一点，仿佛', { verbatim: ['氛围安静一点，仿佛'] }), [])
  assert.deepEqual(lintText('她其实很怕黑', { facets: true }).map(h => h.label), ['解释原因'])
  assert.deepEqual(lintText('她其实很怕黑'), [])
  // Review issues: found text is replaced in place; the rest wait for a rewrite.
  const card = { entries: [{ name: '世界设定', content: '雨夜仿佛很长' }], greetings: [{ text: '门开了' }] }
  const left = applyIssues(card, [{ target: '世界设定', original: '仿佛', suggestion: '' }, { target: '开场白1', original: '没有这句', suggestion: 'x' }])
  assert.equal(card.entries[0].content, '雨夜很长')
  // A cut leaves no stray comma before the full stop.
  const seam = { entries: [], greetings: [{ text: '她的声音很轻，像要散掉。' }] }
  applyIssues(seam, [{ target: '开场白1', original: '像要散掉', suggestion: '' }])
  assert.equal(seam.greetings[0].text, '她的声音很轻。')
  // A suggestion that repeats the words next to it leaves them once, in that sentence only; a repeat meant elsewhere stays.
  const echo = { entries: [{ name: '甲', content: '他走一步，停一步，走一步，停一步。她盯着你，像要看穿什么，眨眼变少。' }], greetings: [] }
  applyIssues(echo, [{ target: '甲', original: '像要看穿什么', suggestion: '盯着你' }])
  assert.equal(echo.entries[0].content, '他走一步，停一步，走一步，停一步。她盯着你，眨眼变少。')

  assert.deepEqual([...left.keys()], ['开场白1'])
  // A suggestion goes in as written: $' and $$ are just characters.
  const literal = { entries: [{ name: '甲', content: '她笑了——然后走开。' }], greetings: [] }
  applyIssues(literal, [{ target: '甲', original: '——', suggestion: "$'$$" }])
  assert.equal(literal.entries[0].content, "她笑了$'$$然后走开。")
  // Text found more than once is left for the rewrite: changing the first would leave the others,
  // or change the wrong one (小雨 inside 林小雨). With words around it to tell them apart, it goes in.
  const twice = { entries: [{ name: '甲', content: '林小语推门。林小语坐下。林小语笑了。' }, { name: '乙', content: '林小雨每晚来店里。熟客都叫王店长小雨。' }], greetings: [] }
  const unclear = applyIssues(twice, [{ target: '甲', original: '林小语', suggestion: '林小雨' }, { target: '乙', original: '小雨', suggestion: '老王' }])
  assert.deepEqual(twice.entries.map(e => e.content), ['林小语推门。林小语坐下。林小语笑了。', '林小雨每晚来店里。熟客都叫王店长小雨。'])
  assert.deepEqual([...unclear.keys()], ['甲', '乙'])
  const placed = applyIssues(twice, [{ target: '乙', original: '王店长小雨', suggestion: '王店长老王' }, ...['推门', '坐下', '笑了'].map(w => ({ target: '甲', original: `林小语${w}`, suggestion: `林小雨${w}` }))])
  assert.deepEqual(twice.entries.map(e => e.content), ['林小雨推门。林小雨坐下。林小雨笑了。', '林小雨每晚来店里。熟客都叫王店长老王。'])
  assert.equal(placed.size, 0)
  assert.deepEqual(Object.fromEntries(readTagged('<entry name="A 「甲」">一\n</entry><entry name="B">二', 'entry')), { A甲: '一', B: '二' })
  // A name with what the entry is for after it still finds its entry; another entry's name with a number does not.
  const blocks = readTagged('<entry name="角色速览：谁是谁">甲</entry><entry name="樱井商事 2">乙</entry>', 'entry')
  assert.deepEqual([...matchWritten(blocks, ['角色速览', '樱井商事', '樱井商事 2'])], [['角色速览', '甲'], ['樱井商事 2', '乙']])
})

test('Chinese text keeps Chinese punctuation; other text, and lines with no Chinese, stay as written', () => {
  assert.equal(chineseText('她抬起头。\n\n"你怎么进来了。"\n\n手链松了,珠子掉在床上...她问:你是谁?'), '她抬起头。\n\n“你怎么进来了。”\n\n手链松了，珠子掉在床上……她问：你是谁？')
  assert.equal(chineseText('林晚星.信任值: 10, "range": "0~100"'), '林晚星.信任值: 10, "range": "0~100"')
  assert.equal(chineseText('"Hello," she said.'), '"Hello," she said.')
  // No space beside the player's name in Chinese: 「你 推开门」 once the name is 你.
  assert.equal(chineseText('灯亮了， <user> 站在门前。她看着 <user>，没说话。\n<user> 推开门。\nI saw <user> there.'), '灯亮了，<user>站在门前。她看着<user>，没说话。\n<user>推开门。\nI saw <user> there.')
  assert.equal(chineseText('他说"好",然后走了', 'English'), '他说"好",然后走了')
})

test('the card as SillyTavern reads it: V3 with its book in order, wrapped entries, update-hiding regex', () => {
  const plan = normalizePlan(PLAN)
  const card = newCard(plan)
  for (const e of card.entries) if (!e.content) e.content = `${e.name}正文`
  card.greetings = [{ text: '开场一' }, { text: '开场二' }]
  const json = cardJson(plan, card)
  assert.equal(json.spec, 'chara_card_v3')
  assert.equal(json.data.first_mes, '开场一')
  assert.deepEqual(json.data.alternate_greetings, ['开场二'])
  const book = json.data.character_book.entries
  assert.deepEqual(book.map(e => e.insertion_order), [...book.map(e => e.insertion_order)].sort((a, b) => a - b))
  const basic = book.find(e => e.comment === '林小雨_基础信息')
  assert.equal(basic.content, '<character_basic character="林小雨">\n林小雨_基础信息正文\n</character_basic>')
  assert.equal(basic.extensions.position, 1)
  assert.equal(book.find(e => e.comment === '[InitVar]请勿打开').enabled, false)
  assert.equal(book.find(e => e.comment === '王店长').constant, false)
  const scripts = json.data.extensions.regex_scripts
  assert.deepEqual(scripts.map(s => [s.promptOnly, s.markdownOnly]), [[true, false], [false, true], [true, false], [false, true]])
  // The status bar: its layout for this app, an HTML copy and MVU for SillyTavern.
  const layout = {
    title: '',
    fields: [
      { path: '林小雨.好感度', label: '', show: 'meter', min: 0, max: 100 },
      { path: '世界.雨势', label: '', show: 'text' },
    ],
  }
  assert.deepEqual(json.data.extensions.cicatavern.status_bar, layout)
  const bar = scripts.find(s => s.id === 'cicatavern-status-bar')
  assert.equal(bar.findRegex, '<StatusPlaceHolderImpl/>')
  assert.match(bar.replaceString, /^```html\n<!DOCTYPE html>[\s\S]*<body>[\s\S]*\.getMvuData[\s\S]*<\/body><\/html>\n```$/)
  assert.ok(bar.replaceString.includes('"path":"林小雨.好感度"'))
  assert.equal(json.data.extensions.tavern_helper.scripts[0].name, 'MVU')
  // The app reads it back the same way, MVU entries and all.
  const read = normalizeCard(json)
  assert.equal(read.book.entries.length, book.length)
  assert.ok(read.book.entries.find(e => e.comment === '[InitVar]请勿打开').initvar)
  assert.equal(read.regexScripts.length, 4)
  assert.deepEqual(read.statusBar, layout)
  assert.match(read.description, /林小雨：雨女/)
  // Without tracking: no bar, no MVU.
  const plain = cardJson({ ...plan, tracking: { enabled: false, title: '', variables: [] } }, card)
  assert.equal(plain.data.extensions.cicatavern, undefined)
  assert.equal(plain.data.extensions.tavern_helper, undefined)
})

test('the plan\'s status bar: how each variable shows, edits by hand, a written card follows', () => {
  const plan = normalizePlan(PLAN)
  assert.deepEqual(plan.tracking.variables.map(v => v.show), ['meter', 'text'])
  assert.deepEqual(cleanVariables([
    { path: '/stat_data/主角/体力', type: 'number', range: '0-200' },
    { path: '主角.随身', type: 'list', show: 'nope' },
    { path: '主角.体力', type: 'string' },
    { path: '  ', type: 'number' },
  ]).map(v => [v.path, v.show]), [['主角.体力', 'meter'], ['主角.随身', 'tags']])
  const edited = editTracking(plan, { title: '雨夜', variables: [...plan.tracking.variables, { path: '主角.体力', label: '体力', type: 'number', initial: '80', range: '0~100', show: 'meter' }] })
  assert.equal(edited.tracking.title, '雨夜')
  assert.equal(statusSpecOf(edited).fields.length, 3)
  assert.deepEqual(rangeOf('0~100'), { min: 0, max: 100 })
  assert.deepEqual(rangeOf('一到十'), {})
  // A written card gets its state entries from the edited variables; turning it off removes them.
  const card = newCard(plan)
  const after = retrack(card, edited)
  assert.match(after.entries.find(e => e.part === 'initvar').content, /体力: 80/)
  const off = editTracking(plan, { enabled: false })
  assert.equal(off.entries.filter(e => e.type === '状态').length, 0)
  assert.equal(retrack(card, off).entries.filter(e => e.type === '状态').length, 0)
  assert.equal(statusSpecOf(off), null)
  // Every variable hidden: nothing to show.
  assert.equal(statusSpecOf(editTracking(plan, { variables: plan.tracking.variables.map(v => ({ ...v, show: 'hidden' })) })), null)
})

test('a PNG carries the card in chara and ccv3 chunks with valid CRCs', { skip: !zlib.crc32 && 'no zlib.crc32 to compare with' }, () => {
  const out = writeCardPng(PNG, { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '林小雨' } })
  let offset = 8
  let checked = 0
  while (offset < out.length) {
    const length = out.readUInt32BE(offset)
    const body = out.subarray(offset + 4, offset + 8 + length)
    // The chunks the writer makes (the test picture's own are hand-made).
    if (['tEXt', 'IEND'].includes(body.toString('latin1', 0, 4))) {
      assert.equal(out.readUInt32BE(offset + 8 + length), zlib.crc32(body))
      checked++
    }
    offset += 12 + length
  }
  assert.equal(checked, 3)
  assert.equal(normalizeCard(parseCardFile('x.png', out).raw).name, '林小雨')
  assert.deepEqual(Object.keys(readPngText(out)), ['chara', 'ccv3'])
})

test('writing a card: steps in order, a failed step carries on, check and fix, then edits, rewrites, avatar and saving', async t => {
  const drawn = []
  const { forge, fake, store, root } = await setup(t, { draw: async (input, signal, choice) => (drawn.push({ ...input, choice }), assert.ok(signal), { buffer: PNG, backend: 'NovelAI' }) })

  // The first entries call answers without tags: that step fails, the rest waits.
  fake.state.fail = 1
  await forge.write('draftone')
  let draft = await settled(forge, 'draftone')
  assert.equal(draft.stage, 'write')
  assert.equal(draft.error.kind, 'write')
  assert.match(draft.error.message, /没有按格式写出/)
  assert.equal(draft.writing[0].state, 'failed')
  // State entries are written already, by code.
  assert.match(draft.card.entries.find(e => e.part === 'initvar').content, /好感度: 10/)

  // Retrying carries on to the end: world, character, cast, openings, review, fix.
  await forge.retry('draftone')
  draft = await settled(forge, 'draftone')
  assert.equal(draft.error, null)
  assert.equal(draft.stage, 'polish')
  assert.ok(draft.writing.every(s => s.state === 'done'))
  assert.ok(draft.card.entries.every(e => e.content))
  assert.match(draft.card.greetings[1].text, /开场 2 的正文/)
  // The review's findable issue was applied in place; the other went to a rewrite.
  assert.match(draft.card.entries.find(e => e.name === '世界设定').content, /雨夜像很长/)
  assert.equal(draft.card.entries.find(e => e.name === '林小雨_基础信息').content, '改写后的林小雨_基础信息')
  assert.equal(draft.card.issuesFound, 2)
  const calls = fake.seen.map(s => (s.system.includes('审稿人') ? 'review' : s.asked.includes('按要求改写') ? 'fix' : s.system.includes('开场白作者') ? 'greetings' : 'entries'))
  assert.deepEqual(calls, ['entries', 'entries', 'entries', 'entries', 'greetings', 'review', 'fix'])
  // Later calls see what was written before; the character call saw the world.
  assert.match(fake.seen[2].asked, /<written>[\s\S]*世界设定/)

  // Edits by hand, a rewrite by a note.
  draft = await forge.editCard('draftone', { greetings: ['我自己写的开场——', draft.card.greetings[1].text], description: '短描述' })
  assert.equal(draft.card.greetings[0].text, '我自己写的开场——')
  assert.ok(draft.card.checks.some(c => c.target === '开场白1' && c.label === '破折号'))
  await assert.rejects(forge.rewrite('draftone', { target: '王店长' }), /先写下/)
  await forge.rewrite('draftone', { target: '王店长', note: '让他更凶一点' })
  draft = await settled(forge, 'draftone')
  assert.equal(draft.card.entries.find(e => e.name === '王店长').content, '改写后的王店长')
  assert.match(fake.seen.at(-1).asked, /让他更凶一点/)

  // The avatar: drawn by the backend from the character's looks, or uploaded.
  await forge.drawAvatar('draftone', { description: '1girl, raincoat, night' })
  draft = await settled(forge, 'draftone')
  assert.equal(draft.card.avatar.backend, 'NovelAI')
  assert.deepEqual([drawn[0].name, drawn[0].kind, drawn[0].looks, drawn[0].scene], ['林小雨', 'girl', 'black hair, wet hair', '1girl, raincoat, night'])
  assert.deepEqual(drawn[0].choice, { backend: '', model: '' }, 'as the picture settings say')
  // Another 画图方式 and model for this one (web/draw-choice.js).
  await forge.drawAvatar('draftone', { description: '1girl, raincoat, night', backend: 'gemini', model: 'gemini-3-pro-image-preview' })
  await settled(forge, 'draftone')
  assert.deepEqual(drawn[1].choice, { backend: 'gemini', model: 'gemini-3-pro-image-preview' })
  assert.deepEqual((await forge.readAvatar('draftone')).buffer, PNG)
  await assert.rejects(forge.uploadAvatar('draftone', { image: 'data:text/plain;base64,aGk=' }), /PNG、JPEG/)
  draft = await forge.uploadAvatar('draftone', { image: PNG_URL })
  assert.equal(draft.card.avatar.source, 'upload')

  // Saving: a card with the PNG carrying it, the cast set up for pictures.
  await assert.rejects(forge.saveCard('draftone', { avatar: 'data:image/jpeg;base64,AAAA' }), /PNG/)
  const saved = await forge.saveCard('draftone', { avatar: PNG_URL })
  assert.equal(saved.updated, false)
  // 试玩体检 from the wizard plays the saved card: the page is told when the draft has moved on from it.
  assert.equal(saved.draft.card.changedSinceSave, false)
  assert.equal((await forge.update('draftone', { stage: 'plan' })).card.changedSinceSave, false, 'moving between steps is no change')
  assert.equal((await forge.editCard('draftone', { description: '改过的描述' })).card.changedSinceSave, true)
  assert.equal((await forge.editCard('draftone', { description: '短描述' })).card.changedSinceSave, false, 'back as saved')
  const card = await store.getCard(saved.card.id)
  assert.equal(card.name, '雨宿')
  assert.equal(card.firstMes, '我自己写的开场——')
  assert.equal(card.description, '短描述')
  assert.deepEqual(card.media.roster.map(r => [r.name, r.looks]), [['林小雨', 'black hair, wet hair']])
  const png = await readFile(store.avatarPath(card.id))
  assert.equal(normalizeCard(parseCardFile('card.png', png).raw).book.entries.length, card.book.entries.length)

  // Saving again updates the same card; its chats stay with it.
  await forge.editCard('draftone', { greetings: ['新开场', '第二个'] })
  const again = await forge.saveCard('draftone', { avatar: PNG_URL })
  assert.equal(again.updated, true)
  assert.equal(again.draft.card.changedSinceSave, false)
  assert.equal(again.card.id, saved.card.id)
  assert.equal((await store.getCard(saved.card.id)).firstMes, '新开场')
  assert.equal((await store.listCards()).length, 1)

  // Writing again from the plan keeps the avatar and the saved card it belongs to.
  await forge.write('draftone', { restart: true })
  draft = await settled(forge, 'draftone')
  assert.equal(draft.card.savedCardId, saved.card.id)
  assert.equal(draft.card.savedAt, again.draft.card.savedAt)
  assert.equal(draft.card.changedSinceSave, true, 'the rewrite is not in the saved card yet')
  assert.equal(draft.card.avatar.source, 'upload')
  assert.equal(draft.stage, 'polish')

  await forge.remove('draftone')
  await assert.rejects(forge.get('draftone'), /不存在/)
  assert.ok(root)
})

test('a step written wrong can be written again by another model: only that step, only when asked, priced first', async t => {
  const { forge, fake, store, root } = await setup(t)
  const [own] = await store.getProviders()
  // A second model on the same provider, one with a known price.
  await store.saveProviders([{ ...own, models: [...own.models, { id: 'claude-sonnet-5-5' }] }])
  const writer = `${own.id}/writer`
  const other = `${own.id}/claude-sonnet-5-5`

  // The draft's model keeps leaving the format: the first step fails, and the error says which model and what it cost.
  fake.state.broken = 'writer'
  await forge.write('draftone')
  let draft = await settled(forge, 'draftone')
  assert.equal(draft.error.kind, 'write')
  assert.match(draft.error.message, /没有按格式写出/)
  assert.equal(draft.error.model, writer)
  assert.deepEqual(draft.error.size, { input: 10, output: 10, measured: true })
  assert.equal(draft.writing[0].state, 'failed')

  // The estimate sends nothing and prices the step's last calls for the model picked.
  const sent = fake.seen.length
  const estimate = await forge.retryEstimate('draftone', { model: other })
  assert.equal(estimate.model, `${own.name} · claude-sonnet-5-5`)
  assert.equal(estimate.input + estimate.output, 20)
  assert.equal(estimate.measured, true)
  assert.ok(Math.abs(estimate.cost - (10 * 2 + 10 * 10) / 1e6) < 1e-12)
  assert.equal((await forge.retryEstimate('draftone', { model: writer })).cost, null)
  await assert.rejects(forge.retryEstimate('draftone', {}), /先选一个模型/)
  assert.equal(fake.seen.length, sent)

  // Retried with the other model: it writes the failed step only; the next goes back to the draft's model (which fails again).
  await forge.retry('draftone', { model: other })
  draft = await settled(forge, 'draftone')
  assert.deepEqual(fake.seen.slice(sent).map(s => s.model), ['claude-sonnet-5-5', 'writer'])
  assert.equal(draft.writing[0].state, 'done')
  assert.equal(draft.writing[0].by, estimate.model)
  assert.equal(draft.writing[1].state, 'failed')
  assert.equal(draft.writing[1].by, null)
  assert.equal(draft.error.model, writer)
  // The draft's model and the default model stay as they were.
  assert.equal(draft.model, '')
  assert.equal((await store.getSettings()).model, writer)
  const saved = JSON.parse(await readFile(path.join(root, 'forge', 'draftone.json'), 'utf8'))
  assert.equal(saved.model, '')
  assert.deepEqual(saved.card.stepModels, { [draft.writing[0].id]: estimate.model })

  // A draft whose error was saved before the model and the usage were kept (the same card, as it stands now).
  const { stepModels, ...card } = saved.card
  await writeFile(path.join(root, 'forge', 'draftold.json'), JSON.stringify({ ...saved, id: 'draftold', card, error: { kind: 'write', message: '旧的报错' } }))
  assert.deepEqual(await forge.retryEstimate('draftold', { model: other }), { model: estimate.model, input: null, output: null, measured: false, cost: null })

  // A plain retry uses the draft's model again and carries on to the end; the step written by the other keeps its mark.
  fake.state.broken = ''
  const before = fake.seen.length
  await forge.retry('draftone')
  draft = await settled(forge, 'draftone')
  assert.equal(draft.error, null)
  assert.equal(draft.stage, 'polish')
  assert.ok(fake.seen.slice(before).every(s => s.model === 'writer'))
  assert.deepEqual(draft.writing.filter(s => s.by).map(s => s.id), [draft.writing[0].id])

  // The old draft takes another model too: it writes the step that failed, the draft's model the rest.
  await forge.retry('draftold', { model: other })
  draft = await settled(forge, 'draftold')
  assert.equal(draft.error, null)
  assert.equal(draft.stage, 'polish')
  assert.deepEqual(draft.writing.filter(s => s.by).map(s => s.id), [draft.writing[1].id])
  assert.equal(draft.model, '')
})

test('another model retrying a failed step writes from the version picked since, like 接着写', async t => {
  const { forge, fake, store, root } = await setup(t)
  const [own] = await store.getProviders()
  await store.saveProviders([{ ...own, models: [...own.models, { id: 'claude-sonnet-5-5' }] }])
  const other = `${own.id}/claude-sonnet-5-5`
  // Two versions to pick from; writing starts from the first and fails.
  const first = normalizePlan(PLAN)
  const second = normalizePlan({ ...PLAN, name: '另一版', characters: [{ ...PLAN.characters[0], name: '苏晴', aliases: ['阿晴'] }, PLAN.characters[1]], avatar: { ...PLAN.avatar, character: '苏晴' } })
  const file = path.join(root, 'forge', 'draftone.json')
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), planOptions: [{ angle: 'a', plan: first }, { angle: 'b', plan: second }], planPick: 0 }))
  fake.state.broken = 'writer'
  await forge.write('draftone')
  let draft = await settled(forge, 'draftone')
  assert.equal(draft.error.kind, 'write')

  // The other version is picked, then the failed step is written again by another model.
  await forge.update('draftone', { planPick: 1 })
  await forge.retry('draftone', { model: other })
  draft = await settled(forge, 'draftone')
  const names = draft.card.entries.map(e => e.name)
  assert.ok(names.some(n => n.includes('苏晴')))
  assert.ok(!names.some(n => n.includes('林小雨')))
  assert.equal(draft.writing[0].state, 'done')
  assert.ok(draft.writing.some(s => s.id === 'character:苏晴'))
})

test('carrying on after the plan was revised: the card follows the plan, what was written stays', async t => {
  const { forge, root, fake } = await setup(t)
  // Started from a plan with one opening and no 王店长, then the plan got both.
  const older = normalizePlan({ ...PLAN, characters: PLAN.characters.slice(0, 1), greetings: PLAN.greetings.slice(0, 1) })
  const card = newCard(older)
  for (const entry of card.entries) if (!entry.content) entry.content = `旧的${entry.name}`
  card.greetings[0].text = '旧的开场'
  Object.assign(card, { reviewed: true, fixed: true })
  const file = path.join(root, 'forge', 'draftone.json')
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), card }))

  await forge.write('draftone')
  const draft = await settled(forge, 'draftone')
  assert.equal(draft.error, null)
  assert.equal(draft.stage, 'polish')
  assert.deepEqual(draft.card.greetings.map(g => g.text.slice(0, 4)), ['旧的开场', '凌晨两点'])
  assert.equal(draft.card.entries.find(e => e.name === '王店长').content, '王店长的内容')
  assert.ok(draft.card.entries.some(e => e.content.startsWith('旧的')), 'what was written stays')
  // Something was added, so the check ran again.
  assert.ok(fake.seen.some(s => s.system.includes('审稿人')))
})

test('no image backend: the avatar is upload-only', async t => {
  const { forge } = await setup(t)
  await forge.write('draftone')
  await settled(forge, 'draftone')
  await assert.rejects(forge.drawAvatar('draftone'), /上传/)
})

test('the review holds the card to the plan: a wrong name is put right as the plan has it', async t => {
  const { forge, root, fake, plan } = await setup(t)
  // Written to the end but not checked, with the heroine's name wrong in her profile.
  const card = newCard(plan)
  for (const entry of card.entries) if (!entry.content) entry.content = `${entry.name}的内容`
  card.entries.find(e => e.name === '林小雨_基础信息').content = '姓名: 林小语\n身份: 雨女\n林小语只在雨夜出现。'
  // And her nickname given to the shop manager, next to her right name.
  card.entries.find(e => e.name === '王店长').content = '林小雨每晚来店里。熟客都叫王店长小雨。'
  card.greetings.forEach((g, i) => (g.text = `开场 ${i + 1}，她推门进来。`))
  const file = path.join(root, 'forge', 'draftone.json')
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), stage: 'write', card }))
  // The pretend reviewer can only tell the name is wrong from the plan's facts. The wrong
  // name is reported once per place, with words around it; the nickname only by itself.
  fake.state.review = asked => {
    const facts = /<plan_facts>([\s\S]*?)<\/plan_facts>/.exec(asked)?.[1] ?? ''
    if (!facts.includes('林小雨（又名 小雨）') || !asked.includes('林小语')) return '<issues>[]</issues>'
    return `<issues>[
      {"target": "林小雨_基础信息", "type": "和方案不符", "original": "姓名: 林小语", "suggestion": "姓名: 林小雨"},
      {"target": "林小雨_基础信息", "type": "和方案不符", "original": "林小语只在", "suggestion": "林小雨只在"},
      {"target": "王店长", "type": "和方案不符", "original": "小雨", "suggestion": "老王"}
    ]</issues>`
  }

  await forge.write('draftone')
  const draft = await settled(forge, 'draftone')
  assert.equal(draft.error, null)
  const review = fake.seen.find(s => s.system.includes('审稿人'))
  assert.match(review.system, /和方案不符/)
  assert.match(review.system, /每处各报一条/)
  assert.match(review.asked, /^<plan_facts>\n[\s\S]*林小雨.好感度=10（0~100）[\s\S]*<\/plan_facts>/)
  assert.ok(!review.asked.includes('<plan>'), 'facts, not the whole plan')
  assert.equal(draft.card.issuesFound, 3)
  assert.equal(draft.card.entries.find(e => e.name === '林小雨_基础信息').content, '姓名：林小雨\n身份：雨女\n林小雨只在雨夜出现。')
  // 小雨 is in 林小雨 too: not changed in place (that would make it 林老王), the rewrite gets it with the note.
  const rewrite = fake.seen.find(s => s.asked.includes('按要求改写'))
  assert.ok(rewrite, 'the unclear one goes to a rewrite')
  const asked = rewrite.asked.split('按要求改写')[1]
  assert.match(asked, /<entry name="王店长">\n林小雨每晚来店里。熟客都叫王店长小雨。\n<\/entry>\n要改的地方：\n {2}- 和方案不符：「小雨」 → 老王/)
  assert.ok(!asked.includes('<entry name="林小雨_基础信息">'), 'what was put right in place is not rewritten')
  assert.equal(draft.card.entries.find(e => e.name === '王店长').content, '改写后的王店长')
})

test('the plan facts for the review: whole and small for a small plan, the most mentioned parts of a large one', () => {
  const plan = normalizePlan(PLAN)
  const facts = planFacts(plan)
  for (const fact of ['林小雨（又名 小雨）｜女｜雨女｜和 <user>：每逢下雨就来店里', '她只在下雨时能被看见', '开场白1「第三个雨夜」：凌晨两点', '林小雨.好感度=10（0~100）', '王店长｜配角'])
    assert.ok(facts.includes(fact), fact)
  assert.doesNotMatch(facts, /省了/)
  // A small card with every field of its plan written to the limit: 2 core characters, 3 side
  // ones, 3 places, a faction, 2 past events, 3 rules, 2 openings, 3 values. It all fits, and
  // the review grows by about a tenth.
  const fill = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n)
  const full = normalizePlan({
    ...PLAN,
    user_role: { identity: fill('新来的夜班店员，', 300), constraints: ['不能离开书店太久', '看不见幽灵'] },
    world: {
      kind: '架空', overview: fill('常年下雨的海港城，', 800), rules: [1, 2, 3].map(() => fill('雨夜死去的人会留在书里，', 120)),
      places: [1, 2, 3].map(i => ({ name: `地点${i}`, aliases: [`别称${i}`], description: fill('潮湿的旧街区，', 400), scenes: ['书架间', '阁楼'] })),
      factions: [{ name: '守书会', description: fill('看管禁书的老人们，', 400), members: ['林小雨', '沈默'] }],
      history: [1, 2].map(() => ({ event: fill('十年前的大火，', 200), impact: fill('地下室被封了，', 200) })),
    },
    characters: [
      ...['林小雨', '沈默'].map(name => ({ name, kind: 'core', aliases: ['小名'], gender: '女', age: '19', identity: fill('住在书架里的幽灵，', 120), relationship: fill('每逢雨夜来借书，', 300), appearance: ['湿漉漉的长发', '褪色的校服', '左手腕一道疤', '总光着脚'], personality: { base: '安静', main: ['好奇'] }, role: fill('引出往事', 200) })),
      ...[1, 2, 3].map(i => ({ name: `配角${i}`, kind: 'npc', gender: '男', age: '40', identity: fill('街口卖伞的，', 120), relationship: fill('认识你，', 300), role: fill('跑龙套', 200) })),
    ],
    tracking: { enabled: true, variables: [{ path: '林小雨.好感度', type: 'number', initial: '10', range: '0~100' }, { path: '林小雨.信任', type: 'number', initial: '5', range: '0~100' }, { path: '世界.天数', type: 'number', initial: '1' }] },
    greetings: [{ title: '第三个雨夜', scene: fill('书店柜台，', 200), start: fill('凌晨两点，', 200), situation: 'x' }, { title: '火灾那天', scene: fill('烧着的街，', 200), start: fill('十年前，', 200), situation: 'x', state: { '林小雨.好感度': '40' } }],
  })
  const fullFacts = planFacts(full)
  assert.doesNotMatch(fullFacts, /省了/)
  for (const fact of ['林小雨（又名 小名）｜女｜19', '地点3（又名 别称3）', '守书会：成员 林小雨、沈默', '开局数值不同：林小雨.好感度=40', '世界.天数=1', '配角3｜配角｜男｜40'])
    assert.ok(fullFacts.includes(fact), fact)
  const card = newCard(full)
  for (const entry of card.entries) if (!entry.content) entry.content = fill(`${entry.name}写了一些内容。`, 600)
  card.greetings.forEach(g => (g.text = fill('开场正文。', 700)))
  const size = r => r.system.length + r.messages[0].content.length
  const without = size(reviewRequest(card, []))
  const added = size(reviewRequest(card, [], '简体中文', full)) - without
  assert.ok(fullFacts.length < 1100 && added < 1300 && added / without < 0.11, `${fullFacts.length} / ${added} / ${without}`)

  // A large plan: kept to the budget, what the card names most first, and a line on what was left out.
  const large = normalizePlan({
    ...PLAN,
    characters: [PLAN.characters[0], ...Array.from({ length: 40 }, (_, i) => ({ name: `配角${i}号`, kind: 'npc', identity: '身份'.repeat(20), relationship: '关系'.repeat(30) }))],
    world: { ...PLAN.world, places: Array.from({ length: 20 }, (_, i) => ({ name: `第${i}号街`, description: '描述'.repeat(30) })) },
  }, { scale: 'epic' })
  const cut = planFacts(large, ['配角39号 在 第19号街', '配角39号'])
  assert.ok(cut.length < 3200, String(cut.length))
  assert.ok(cut.includes('林小雨（又名 小雨）') && cut.includes('开场白2') && cut.includes('配角39号'))
  assert.match(cut, /（方案较大，只列了卡里提得多的部分，省了：配角 \d+ 条、地点 \d+ 条。/)
  assert.equal(planFacts({ characters: [] }), '')
})
