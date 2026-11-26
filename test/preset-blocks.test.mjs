// A preset's own blocks (think_mist and the like): its thinking, its story wrapper, its own choices, its notes. A mark
// in its choices is a choice to take, not a stop; one in its thinking or notes is nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choiceChecks, choiceFights, choiceKey, cutAtGate, gateOf, replyMarks, withoutGameMarks } from '../web/shared/game/marks.js'
import { asideBlocks, optionWords, otherChoices, replyBlocks } from '../web/shared/basic.js'

// A reply on a preset with blocks of its own (shortened).
const THINKING = '<think_mist~>\n<self_check>\n2. 本轮小舟要动手，以【战斗|刺叶花妖:精英】收尾。没问题。\n</self_check>\n【部分一】\n*先把结果报了。*\n</think_mist~>'
const STORY = '<content>\n\n藤蔓散开的时候发出一股草被揉烂的味道。\n\n“我问你一句，你听得清吗？”\n\n</content>'
const OPTIONS = [
  '<opt_sel>',
  'o(*￣▽￣*)o<font color="#1E90FF">声音稳住，先报一句"听得清"。</font>',
  '(≧∇≦)ﾉ<font color="#FF8C00">不答她，先挪到幼崽那边去。</font>',
  '(´•ω•̥`)<font color="#9933FF">不作声，等她治完再说话【检定|精神|DC12】</font>',
  '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧<font color="#FFA500">正面迎上去，硬碰这只白羽隼</font>【战斗|白羽隼:普通】',
  '</opt_sel>',
].join('\n')
const TIP = '<side_tip>\n唔～册子比伤口还重要吗【获得|金币×9】\n</side_tip>'
const UPDATE = '<UpdateVariable>\n<JSONPatch>\n[{ "op": "replace", "path": "/位置", "value": "圣殿" }]\n</JSONPatch>\n</UpdateVariable>'
const FOX = [THINKING, STORY, OPTIONS, TIP, UPDATE].join('\n')

test('a preset\'s own choices are choices: a roll or a fight on one stops nothing, and nothing after it is cut', () => {
  assert.equal(gateOf(FOX), null)
  assert.deepEqual(cutAtGate(FOX), { text: FOX, gate: null }, 'the options, the note and the update stay')
  assert.deepEqual(replyMarks(FOX), [], 'nor do the thinking or the note change anything')
})

test('a preset\'s choices ask for their roll and their fight, however the choice comes back', () => {
  const checks = choiceChecks(FOX)
  assert.deepEqual([...checks.keys()], ['不作声，等她治完再说话'])
  const roll = { kind: 'check', stat: '精神', dc: 12 }
  assert.deepEqual(checks.get('不作声，等她治完再说话'), roll, 'the words in its <font>, as its own page sends them')
  assert.deepEqual(checks.get('不作声，等她治完再说话【检定|精神|DC12】'), roll, 'with the mark, when the page sends that too')
  assert.deepEqual(checks.get('C. 不作声，等她治完再说话。'), roll, 'a label or a stop of its own')
  assert.equal(checks.has('不答她，先挪到幼崽那边去。'), false)
  const fights = choiceFights(FOX)
  assert.deepEqual(fights.get('正面迎上去，硬碰这只白羽隼'), { kind: 'battle', foes: [{ name: '白羽隼', count: 1, tier: 'normal' }] })
  assert.equal(choiceKey('o(*￣▽￣*)o<font color="#1E90FF">先报一句【检定|精神】</font>'), choiceKey('先报一句'))
})

test('a choice its page sent with the mark goes as its words, as the built-in preset\'s buttons send it, and still rolls', () => {
  const sent = '不作声，等她治完再说话【检定|精神|DC12】'
  const said = withoutGameMarks(sent).trim()
  assert.equal(said, '不作声，等她治完再说话')
  assert.deepEqual(choiceChecks(FOX).get(said), { kind: 'check', stat: '精神', dc: 12 })
  assert.deepEqual(choiceFights(FOX).get(withoutGameMarks('正面迎上去，硬碰这只白羽隼【战斗|白羽隼:普通】').trim()).foes, [{ name: '白羽隼', count: 1, tier: 'normal' }])
})

test('a preset\'s block of choices becomes the buttons, when its own regex does not draw it', () => {
  const { choices, text } = otherChoices(FOX)
  assert.deepEqual(choices, ['声音稳住，先报一句"听得清"。', '不答她，先挪到幼崽那边去。', '不作声，等她治完再说话【检定|精神|DC12】', '正面迎上去，硬碰这只白羽隼【战斗|白羽隼:普通】'])
  assert.doesNotMatch(text, /opt_sel|声音稳住/)
  assert.match(text, /<side_tip>[\s\S]*<UpdateVariable>/, 'the rest is left as it was')
  assert.deepEqual(otherChoices(`${STORY}\n${TIP}`).choices, [], 'a note is no choices')
  assert.deepEqual(otherChoices('正文。\n<summary_note>\n第一件事\n第二件事\n</summary_note>').choices, [], 'nor is a block not named for them')
  assert.deepEqual(otherChoices('正文。\n<行动选项>\n- 推门\n- 绕路\n</行动选项>').choices, ['推门', '绕路'])
})

test('a stop in the story still stops it, and the story\'s wrapper is closed again', () => {
  const story = '<content>\n白羽隼扑下来了。\n\n【战斗|白羽隼:普通|开局:强化、破绽】\n多写的一段。\n</content>'
  const { text, gate } = cutAtGate([THINKING, story, OPTIONS, TIP, UPDATE].join('\n'))
  assert.equal(gate.kind, 'battle')
  assert.ok(text.endsWith('【战斗|白羽隼:普通|开局:强化、破绽】\n</content>'), text.slice(-60))
  assert.doesNotMatch(text, /多写的一段|opt_sel|UpdateVariable/)
  assert.equal(gateOf(`${STORY.replace('</content>', '【检定|灵巧|DC12】\n</content>')}\n${OPTIONS}`).stat, '灵巧')
  assert.equal(gateOf(`${STORY}\n【检定|灵巧|DC12】\n${OPTIONS}`).stat, '灵巧', 'loose after the wrapper is still the story')
})

test('the thinking of a preset, by its own name, is no story', () => {
  assert.equal(gateOf(`${THINKING}\n${STORY}`), null)
  assert.equal(gateOf('<think_mist~>\n还没想完【检定|灵巧|DC12】'), null, 'still being written')
  assert.equal(choiceChecks('<think_mist~>\nA. 翻过断崖【检定|灵巧|DC12】\n</think_mist~>\n正文。').size, 0, 'nor is a choice it plans')
})

test('写前自查 and 裁判表: a mark they name is not the story\'s', () => {
  const check = '<self_check>\n1. 没问题。\n2. 玩家在动手，给出【战斗|白羽隼:普通|开局:先手】，金币另写【获得|金币×9】。\n</self_check>'
  const story = '她扑了上来。\n【战斗|白羽隼:精英】'
  const { text, gate } = cutAtGate(`${check}\n<time_box>夜｜斗场</time_box>\n${story}\n多写的话。`)
  assert.equal(gate.foes[0].tier, 'elite', 'the stop is the story\'s own')
  assert.equal(text, `${check}\n<time_box>夜｜斗场</time_box>\n${story}`)
  assert.equal(gateOf(`${check}\n她退开了。`), null)
  assert.deepEqual(replyMarks(`${check}\n你捡起它。【获得|绳】`), [{ kind: 'gain', name: '绳', count: 1 }])
  assert.equal(gateOf('<self_check>\n1. 以【战斗|白羽隼】收尾'), null, 'still being written')
  assert.equal(gateOf(`<self_check>\n1. 以【战斗|白羽隼】收尾\n\n${story}`).foes[0].tier, 'elite', 'one left open ends with its paragraph')
  assert.equal(gateOf('<judge>\n比力量【检定|力量|DC12】\n</judge>\n她退开了。'), null)
  assert.equal(choiceFights(`${check}\n她退开了。\n<choices>\nA. 追上去【战斗|白羽隼】\n</choices>`).size, 1)
})

test('without a wrapper: the blocks after the story are not story; with nothing outside them, the longest is', () => {
  assert.equal(gateOf(`她看着你。\n${OPTIONS}\n${TIP}`), null)
  assert.equal(gateOf(`她看着你。\n【检定|灵巧|DC12】\n${OPTIONS}`).stat, '灵巧')
  assert.equal(gateOf('她看着你。\n<opt_sel>\no(*￣▽￣*)o<font>翻过去【检定|灵巧|DC12】'), null, 'a block still being written')
  const scene = '<scene>\n她伸手去够那根绳子，指尖差半寸。\n【检定|灵巧|DC12】\n后面的话。\n</scene>\n<tips>\n小心\n</tips>'
  const cut = cutAtGate(scene)
  assert.equal(cut.gate.stat, '灵巧')
  assert.equal(cut.text, '<scene>\n她伸手去够那根绳子，指尖差半寸。\n【检定|灵巧|DC12】\n</scene>')
  assert.equal(gateOf('<div class="story">\n她伸手。\n【检定|灵巧|DC12】\n</div>').stat, '灵巧', 'HTML is no block')
  assert.deepEqual(replyMarks(`<content>\n你捡起它。【获得|绳】\n</content>\n${TIP}`), [{ kind: 'gain', name: '绳', count: 1 }])
})

test('a reply\'s blocks: tags of their own at the start of a line, outside the thinking', () => {
  const names = replyBlocks(FOX).map(block => block.name)
  assert.deepEqual(names, ['content', 'opt_sel', 'side_tip', 'UpdateVariable'])
  assert.deepEqual(asideBlocks(FOX).map(block => block.name), ['opt_sel', 'side_tip', 'UpdateVariable'])
  assert.deepEqual(replyBlocks('<StatusPlaceHolderImpl/>\n<br>\n文字<b>粗</b>'), [])
  assert.equal(optionWords('o(*￣▽￣*)o<font color="#1E90FF">先报一句</font>'), '先报一句')
  assert.equal(optionWords('你<font color="red">小心</font>脚下'), '你小心脚下', 'words before it are kept')
  assert.equal(optionWords('A. 推门'), '推门')
})
