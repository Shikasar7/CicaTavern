import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCard } from '../server/cards.mjs'
import { editRequest } from '../server/forge/edit.mjs'
import { cleanHelperList, helperBlock, helperSummary } from '../server/helper-scripts.mjs'

const CDN = 'https://testingcf.jsdelivr.net/gh'
const load = url => `import '${url}'`
const SCRIPTS = [
  { name: 'MVU', content: load(`${CDN}/MagicalAstrogy/MagVarUpdate/artifact/bundle.js`), button: { buttons: [{ name: '重新处理变量', visible: true }] } },
  { name: 'MVU', content: load('https://example.com/my-mvu/bundle.js'), button: { buttons: [{ name: '重新处理变量' }, { name: '重试额外模型解析' }] }, info: '# MVU\n很长的说明' },
  { name: 'Zod', content: `import { registerMvuSchema } from '${CDN}/StageDog/tavern_resource/dist/util/mvu_zod.js'\n$(() => registerMvuSchema(z.object({})))` },
  { name: 'Zod 变量结构', content: load('https://cdn.jsdelivr.net/gh/someone/game/dist/变量结构/index.js') },
  { name: '世界书强制自定义排序', content: load(`${CDN}/StageDog/tavern_resource/dist/酒馆助手/世界书强制自定义排序/index.js`) },
  { name: '自动更新世界书', content: load(`${CDN}/StageDog/tavern_resource/dist/%E9%85%92%E9%A6%86%E5%8A%A9%E6%89%8B/%E8%87%AA%E5%8A%A8%E6%9B%B4%E6%96%B0%E8%A7%92%E8%89%B2%E5%8D%A1/index.js`) },
  { name: '小手机', content: load('https://cdn.example.com/phone.min.js'), info: '聊天用的小手机' },
  { name: '夏日事件', content: `eventOn(tavern_events.MESSAGE_RECEIVED, async () => { const book = await getWorldbook('x'); await replaceWorldbook('x', book) })\n${'// 说明\n'.repeat(300)}`, buttons: [{ name: '抽事件' }, { name: '藏起来', visible: false }] },
  { name: '测试用', enabled: false, content: load('http://localhost:5500/dist/index.js') },
  { name: '楼层折叠', content: "$(() => { $('#chat .mes').hide(); loadPreset('简洁'); getTavernHelperVersion() })" },
]

test('helper scripts: each says what its absence comes to', () => {
  const list = helperSummary(SCRIPTS)
  assert.deepEqual(list.map(item => [item.name, item.kind, item.effect]), [
    ['MVU', 'mvu', 'none'],
    ['MVU', 'mvu', 'none'],
    ['Zod', 'schema', 'none'],
    ['Zod 变量结构', 'schema-remote', 'some'],
    ['世界书强制自定义排序', 'upkeep', 'none'],
    ['自动更新世界书', 'updater', 'some'],
    ['小手机', 'custom', 'some'],
    ['夏日事件', 'custom', 'none'],
    ['测试用', 'custom', 'none'],
    ['楼层折叠', 'custom', 'some'],
  ])
  assert.equal(list[1].about, '', 'a known tool needs no readme')
  const phone = list[6]
  assert.equal(phone.remote, true)
  assert.deepEqual(phone.hosts, ['cdn.example.com'])
  assert.equal(phone.about, '聊天用的小手机')
  const events = list[7]
  assert.equal(events.remote, false)
  assert.deepEqual(events.uses, ['events', 'book'])
  assert.deepEqual(events.buttons, ['抽事件'], 'a hidden button is nobody\'s loss')
  assert.deepEqual(list[0].buttons, [], 'MVU\'s own buttons are not missed: it is built in')
  assert.equal(list[8].on, false)
  // What runs on the page but is not there: Tavern Helper functions the stand-in lacks, SillyTavern's own page.
  assert.deepEqual([events.missing, events.stPage], [[], false])
  assert.deepEqual([list[9].missing, list[9].stPage], [['loadPreset', 'getTavernHelperVersion'], true])
})

test('helper scripts: the list stays on the card, however it was imported, and only its shape is taken on trust', () => {
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', extensions: { tavern_helper: { scripts: SCRIPTS } } } })
  assert.equal(card.helperScripts, SCRIPTS.length)
  assert.equal(card.helperList.length, SCRIPTS.length)
  assert.equal(JSON.stringify(card.helperList).includes('replaceWorldbook'), false, 'what they are, not their text')
  assert.deepEqual(cleanHelperList([{ name: 'x', kind: 'nonsense' }, { name: 'y', kind: 'custom', uses: ['book', 'rm -rf'], effect: 'bad' }]), [
    { name: 'y', on: true, kind: 'custom', remote: false, hosts: [], buttons: [], uses: ['book'], missing: [], stPage: false, about: '', effect: 'lost' },
  ])
  assert.equal(cleanHelperList('nope'), null)
})

test('对话修改 hears of the scripts only when the request is about them', () => {
  const helpers = { list: helperSummary(SCRIPTS), scripts: SCRIPTS }
  assert.equal(helperBlock(helpers, '让她说话冷淡一点'), '')
  assert.equal(helperBlock({ list: [], scripts: [] }, '脚本'), '')
  assert.equal(helperBlock(null, '脚本'), '')

  const named = helperBlock(helpers, '「夏日事件」这个脚本做的事，用世界书做一个')
  assert.match(named, /「夏日事件」：打开对话时在页面上运行，在它自己的隔离框架里，会跟着对话事件自动运行、读写世界书；按钮：抽事件/)
  assert.match(named, /<helper_code name="夏日事件">\neventOn/)
  assert.match(named, /「小手机」：从网址加载（cdn\.example\.com），内容不在卡里；联网时在页面上运行；作者说明：聊天用的小手机/)
  assert.match(named, /「测试用」：作者关着/)
  assert.match(helperBlock(helpers, '「楼层折叠」'), /「楼层折叠」：打开对话时在页面上运行，在它自己的隔离框架里，会在页面上加界面；改 SillyTavern 自己页面（消息列表、菜单）的部分不起作用；这些函数这里没有：loadPreset、getTavernHelperVersion/)
  assert.match(named, /「MVU」：MVU 框架/)
  assert.doesNotMatch(named, /<helper_code name="小手机">/, 'nothing fetched, nothing to show')
  assert.doesNotMatch(named, /<helper_code name="MVU">/)

  // A list kept from a JSON import: what they are, without their text.
  const kept = helperBlock({ list: helpers.list, scripts: null }, '脚本能换成什么')
  assert.match(kept, /「夏日事件」/)
  assert.doesNotMatch(kept, /<helper_code/)

  // The text has a limit.
  const long = [{ name: '长脚本', content: 'eventOn(a)\n'.repeat(5000) }]
  assert.ok(helperBlock({ list: helperSummary(long), scripts: long }, '长脚本').length < 8000)

  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', description: 'x', first_mes: 'y' } })
  const asked = editRequest(card, { text: '「夏日事件」用世界书做', helpers }).request.messages[0].content
  assert.match(asked, /<helper_scripts>/)
  assert.doesNotMatch(editRequest(card, { text: '短一点', helpers }).request.messages[0].content, /helper_scripts/)
})
