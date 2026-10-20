// 视觉小说模式: a reply cut into beats, who says each, which scene a place is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carryTags, guessSpeaker, headerPlace, latestPlace, matchScene, normalizePlace, placeIn, placeOf, pronounNear, speakerNames, splitLines, timeOfDay, weatherOf, withoutFolds } from '../web/shared/vn.js'

const names = speakerNames({ char: '林青禾', user: '沈梨', roster: [{ name: '周管事', aliases: '老周，管事' }] })
const beats = (text, opts = {}) => splitLines(text, { names, ...opts }).map(b => [b.kind, b.plain, b.speaker])

test('names: a card name before its subtitle, the player, the cast and their aliases; one-character keys never match', () => {
  assert.deepEqual(speakerNames({ char: '林雪-异能抽奖系统-v1.1', user: '你' }), [{ name: '林雪', keys: ['林雪-异能抽奖系统-v1.1', '林雪'], char: true }])
  assert.deepEqual(names.at(-1), { name: '周管事', keys: ['周管事', '老周', '管事'] })
  // A three-character name is also called by its last two, unless the cast says otherwise.
  assert.deepEqual(names[0].keys, ['林青禾', '青禾'])
  // The cast's entry for the card's character and its player entry join the card's and the player's names.
  const cast = speakerNames({
    char: '顾念念-武当抽奖系统-v1.6',
    user: '小蝉',
    roster: [
      { id: 'p', name: '主角', aliases: '师兄, 小道长', player: true, kind: 'boy' },
      { id: 'n', name: '顾念念', aliases: '念念, 小师妹', kind: 'girl' },
    ],
  })
  assert.deepEqual(cast, [
    { name: '顾念念', keys: ['顾念念-武当抽奖系统-v1.6', '顾念念', '念念', '小师妹'], char: true, kind: 'girl', id: 'n' },
    { name: '小蝉', keys: ['小蝉', '主角', '师兄', '小道长'], player: true, kind: 'boy', id: 'p' },
  ])
})

test('beats: narration alone, a quote with its lead-in, short narration after the last quote stays with it', () => {
  assert.deepEqual(beats('雨下了一整夜。\n\n林青禾推开门：「你来了。」她笑了笑。'), [
    ['narration', '雨下了一整夜。', null],
    ['dialogue', '林青禾推开门：「你来了。」她笑了笑。', '林青禾'],
  ])
  // Two quotes on one line: the second follows the first one's speaker.
  assert.deepEqual(beats('林青禾说：“走吧。”她顿了顿，“天要黑了。”'), [
    ['dialogue', '林青禾说：“走吧。”', '林青禾'],
    ['dialogue', '她顿了顿，“天要黑了。”', '林青禾'],
  ])
  // A long lead-in goes first; its last clause stays with the quote.
  const long = '窗外的雨越下越大，屋檐下挂起了一道水帘，街上的行人早已散尽，只剩一盏路灯在风里摇晃。周管事放下账本。「关门吧。」'
  assert.deepEqual(beats(long).map(b => [b[0], b[2]]), [['narration', null], ['dialogue', '周管事']])
  assert.equal(beats(long)[1][1], '周管事放下账本。「关门吧。」')
})

test('beats: long narration is cut at sentence ends; one long sentence stays whole', () => {
  const sentence = '她'.repeat(50) + '。'
  const cut = beats(sentence.repeat(3), { max: 90 })
  assert.equal(cut.length, 3)
  assert.ok(cut.every(b => b[1] === sentence))
  assert.equal(beats('她'.repeat(150) + '。', { max: 90 }).length, 1)
})

test('beats: thinking is dropped, tag-only lines join, a name on its own line names the next speaker, colours carry over', () => {
  assert.deepEqual(beats('<think>先想想</think>她来了。\n<reasoning>还在想'), [['narration', '她来了。', null]])
  assert.deepEqual(beats('周管事：\n「这边请。」'), [['dialogue', '「这边请。」', '周管事']])
  // A line that says more than the name stays, and still names the next speaker.
  assert.deepEqual(beats('林青禾推开门：\n「你来了。」'), [['narration', '林青禾推开门：', null], ['dialogue', '「你来了。」', '林青禾']])
  const coloured = splitLines('<font color="red">「快走！」\n「别回头！」</font>', { names })
  assert.deepEqual(coloured.map(b => b.text), ['<font color="red">「快走！」</font>', '<font color="red">「别回头！」</font>'])
  assert.deepEqual(carryTags(['<b>a', 'b</b>c']), ['<b>a</b>', '<b>b</b>c'])
  assert.equal(withoutFolds('a<draft_x>b</draft_x>c'), 'ac')
})

test('beats: while a reply streams in, only the last beat changes', () => {
  const full = '雨下了一整夜。\n\n林青禾推开门：「你来了。」\n\n周管事放下账本。「关门吧。」他说。'
  let shown = []
  for (let n = 1; n <= full.length; n++) {
    const now = splitLines(full.slice(0, n), { names, partial: true }).map(b => b.text)
    const settled = now.slice(0, -1)
    assert.deepEqual(settled.slice(0, shown.length), shown, `at ${n}`)
    shown = settled
  }
})

test('speakers: colon and verb forms, a name in the sentence before, attribution after, pronouns and unknown names', () => {
  assert.equal(guessSpeaker('林青禾放下茶杯，轻声说：', '', names), '林青禾')
  assert.equal(guessSpeaker('', '林青禾笑道。', names), '林青禾')
  assert.equal(guessSpeaker('老周看了沈梨一眼。', '', names), '周管事')
  assert.equal(guessSpeaker('老板娘：', '', names), '老板娘')
  assert.equal(guessSpeaker('老板娘笑着说：', '', names), '老板娘')
  assert.equal(guessSpeaker('店里的老板娘放下算盘，笑着说：', '', names), null, 'too long to be a name')
  assert.equal(guessSpeaker('她低声说：', '', names), null)
  assert.equal(guessSpeaker('', '', names), null)
})

test('scenes: names compared without punctuation or width; containment needs half the longer; the longest key wins', () => {
  assert.equal(normalizePlace(' 旧城茶馆·二楼（雅间） '), '旧城茶馆二楼雅间')
  assert.equal(normalizePlace('ＡＢＣ 书店'), 'abc书店')
  const scenes = [
    { id: 'a', name: '旧城茶馆二楼', aliases: [] },
    { id: 'b', name: '城西茶馆二楼', aliases: ['西城茶楼'] },
    { id: 'c', name: '书店', aliases: ['旧书店'] },
  ]
  assert.equal(matchScene('旧城茶馆·二楼', scenes)?.id, 'a')
  assert.equal(matchScene('茶馆二楼', scenes)?.id, 'a', '4 of 6: close enough')
  assert.equal(matchScene('茶馆', scenes), null, '2 of 6: too little')
  assert.equal(matchScene('城东茶馆二楼', scenes), null, 'no fuzzy match across east and west')
  assert.equal(matchScene('旧书店', scenes)?.id, 'c', 'an alias, exactly')
  assert.equal(matchScene('', scenes), null)
  // A place given to another scene (用在这里) goes to the one changed last.
  const both = [{ id: 'old', name: '码头', aliases: [], updatedAt: '2026-10-01' }, { id: 'new', name: '渡口', aliases: ['码头'], updatedAt: '2026-10-02' }]
  assert.equal(matchScene('码头', both)?.id, 'new')
})

test('time and weather from the time box; the newest reply that says where', () => {
  assert.deepEqual(['10月19日 周一 傍晚6:20', '18:20', '凌晨2点', '下午三点', '6:20 AM', '中午', ''].map(timeOfDay), ['dusk', 'dusk', 'night', 'day', 'dawn', 'day', null])
  assert.deepEqual(['小雨', '雷阵雨', '大雪', '薄雾', '多云', '晴', ''].map(weatherOf), ['rain', 'storm', 'snow', 'fog', 'cloudy', 'clear', null])
  assert.deepEqual(placeOf(['傍晚', '书店']), { time: '傍晚', place: '书店', weather: '' })
  const path = [
    { id: 'root', role: 'assistant', raw: '<time_box>清晨｜旧城茶馆二楼｜小雨</time_box>开场。' },
    { id: 'u1', role: 'user', text: '走' },
    { id: 'a1', role: 'assistant', raw: '没有时间框的回复。' },
  ]
  assert.deepEqual(latestPlace(path), { nodeId: 'root', time: '清晨', place: '旧城茶馆二楼', weather: '小雨' })
  assert.equal(latestPlace([]), null)
})

// A card that writes its own header line, as in a real chat (an imported preset, no time box).
const nian = speakerNames({
  char: '顾念念-武当抽奖系统-v1.6',
  user: '小蝉',
  roster: [{ name: '主角', player: true, kind: 'boy' }, { name: '顾念念', aliases: '念念，小师妹', kind: 'girl' }, { name: '慕寒漪', aliases: '寒漪', kind: 'girl' }],
})

test('places: a header line with a date or time, a labelled line, the variables; the reply first', () => {
  assert.deepEqual(headerPlace('永和十七年八月十五 · 亥时 21:45 · 武当山·后山剑池\n\n你的话哽在喉咙里。'), { time: '永和十七年八月十五 亥时 21:45', place: '武当山·后山剑池', weather: '' })
  assert.deepEqual(headerPlace('「永和十七年八月十五 · 亥时 21:40 · 武当山·后山剑池」\n\n中秋的月亮'), { time: '永和十七年八月十五 亥时 21:40', place: '武当山·后山剑池', weather: '' })
  assert.deepEqual(headerPlace('【10月19日 周一 ｜ 傍晚 ｜ 旧城茶馆 ｜ 小雨】'), { time: '10月19日 周一 傍晚', place: '旧城茶馆', weather: '小雨' })
  assert.deepEqual(headerPlace('**时间：清晨 ｜ 地点：雪山脚下 ｜ 天气：大雪**'), { time: '清晨', place: '雪山脚下', weather: '大雪' })
  assert.equal(headerPlace('她站起来 · 走到窗边。'), null, 'no date or time: not a header')
  assert.equal(headerPlace('第一行\n第二行\n第三行\n下午三点 · 书店'), null, 'only the first lines')
  assert.deepEqual(placeIn('<StatusPlaceHolderImpl/>\n永和十七年八月十五 · 亥时 21:52 · 武当山·后山剑池\n\n正文'), { time: '永和十七年八月十五 亥时 21:52', place: '武当山·后山剑池', weather: '' })
  assert.equal(placeIn('<time_box>清晨｜码头｜雾</time_box>\n永和十七年 · 亥时 · 武当山').place, '码头', 'the time box wins')
  const state = { 系统: { 当前时间: '永和十七年八月十五 亥时 21:40', 当前地点: '武当山·后山剑池' }, 顾念念: { 位置: '紫霄宫' } }
  const path = [
    { id: 'root', role: 'assistant', raw: '开场，没有地点。', state },
    { id: 'u1', role: 'user', text: '走' },
    { id: 'a1', role: 'assistant', raw: '下山的路。', state: { 系统: { 当前地点: '山门' } } },
  ]
  assert.deepEqual(latestPlace(path), { nodeId: 'a1', time: '', place: '山门', weather: '' })
  assert.deepEqual(latestPlace(path.slice(0, 1)), { nodeId: 'root', time: '永和十七年八月十五 亥时 21:40', place: '武当山·后山剑池', weather: '' })
  assert.equal(latestPlace([{ id: 'r', role: 'assistant', raw: '', state: { 顾念念: { 位置: '紫霄宫' }, 系统: { 当前地点: '剑池' } } }]).place, '剑池', 'the story\'s place before a character\'s')
})

test('speakers: 她 is the heroine named last or the card\'s own, 你 the player, an unknown name before 笑道', () => {
  const said = text => splitLines(text, { names: nian }).filter(b => b.kind === 'dialogue').map(b => b.speaker)
  assert.deepEqual(said('「师兄说什么?」她凑近了一点,呼吸快要贴到你脸上,「念念没听清楚,再说一遍嘛~」'), ['顾念念', '顾念念'])
  assert.deepEqual(said('「是……」你喉咙发紧,每个字都像被什么东西卡着,「念念……师兄喜欢……」'), ['小蝉', '小蝉'])
  assert.deepEqual(said('慕寒漪推门进来。\n\n「夜深了。」她说。'), ['慕寒漪'])
  assert.deepEqual(said('「两位，打烊了。」店小二笑道。'), ['店小二'])
  assert.equal(pronounNear('她回头看你,笑意还挂在脸上,', ''), '她')
  assert.equal(pronounNear('', '他们都笑了。'), null)
  // 他 on a card whose heroine is a girl, with no man named: nobody rather than the wrong one.
  assert.deepEqual(said('「走吧。」他说。'), [null])
  // Nothing says who: the one who spoke last, else the card's own.
  assert.deepEqual(said('「师兄？」\n\n声音从你背后传来。'), ['顾念念'])
  assert.deepEqual(said('慕寒漪说：「走。」\n\n「快些。」'), ['慕寒漪', '慕寒漪'])
  // A quoted word is narration; 等你 is no name.
  assert.deepEqual(splitLines('「惊喜」两个字亮得刺眼。', { names: nian }).map(b => b.kind), ['narration'])
  assert.deepEqual(said('等你说「是。」'), [null])
  // Header lines go to the sign, at the top or where the story moves on; a rule between scenes goes.
  const moved = splitLines('「永和十七年八月十五 · 亥时 21:40 · 武当山·后山剑池」\n\n中秋的月亮。\n\n---\n\n永和十七年八月十六 · 酉时 18:10 · 均州城·平安客栈\n\n天黑之前到了。', { names: nian })
  assert.deepEqual(moved.map(b => [b.kind, b.plain || b.where.place]), [['scene', '武当山·后山剑池'], ['narration', '中秋的月亮。'], ['scene', '均州城·平安客栈'], ['narration', '天黑之前到了。']])
})

test('speakers: a quote alone on its line, from the lines either side; people called by their trade; long clauses before a colon', () => {
  const cast = speakerNames({
    char: '顾念念-武当抽奖系统-v1.6',
    user: '小蝉',
    roster: [{ name: '主角', aliases: '师兄', player: true, kind: 'boy' }, { name: '顾念念', aliases: '念念，师妹', kind: 'girl' }, { name: '清虚子', aliases: '师父', kind: 'boy' }],
  })
  const said = text => splitLines(text, { names: cast }).filter(b => b.kind === 'dialogue').map(b => b.speaker)
  // The line before says who; 你 reacting after is the player listening.
  assert.deepEqual(said('她停在你面前，仰着脸看你。\n\n「师兄收拾好啦？」\n\n你点头。'), ['顾念念'])
  assert.deepEqual(said('你还没来得及回答，殿里就传来师父的声音。\n\n「站在门口干什么，进来。」'), ['清虚子'])
  assert.deepEqual(said('师妹乖巧地点头。\n\n「念念一定看好师兄的~」\n\n她说这话的时候，梨涡又出来了。'), ['顾念念'])
  // Nothing before it: the line after it, when it starts with 她/他.
  assert.deepEqual(said('又回头喊了一声。\n\n「师兄快点收拾呀~」\n\n她跑远了。'), ['顾念念'])
  // 他 after a quote is the subject; the 师妹 he looks at is not the speaker.
  assert.deepEqual(said('清虚子放下酒杯。\n\n「念念，」他看着师妹，「看好你师兄。」'), ['清虚子', '清虚子'])
  // An innkeeper is 掌柜, and 他 means him while he is the one named last.
  assert.deepEqual(said('掌柜的是个瘦老头，见你们进来，眼睛一亮。\n\n「哟，武当的道长~」\n\n他从柜台后面探出身子。\n\n「住店还是打尖？」\n\n师妹走到柜台前。\n\n「掌柜的，要两间上房~」'), ['掌柜', '掌柜', '顾念念'])
  // Said to the player, not by them.
  assert.deepEqual(said('你摇头。\n\n「师兄，累不累？」'), ['顾念念'])
  // A long clause before a colon is no name, but may hold one.
  assert.deepEqual(said('师父说的话还在耳边响：「杀是好杀。」'), ['清虚子'])
})

test('options: 1️⃣ lines come apart from the story; the rest of their <small> block goes', () => {
  const reply = '她还在等。\n\n<small>\n请选择小蝉的下一步行动:\n1️⃣ 😖 低头承认,小声说「是……」\n\n2️⃣ 😰 试图转移话题\n\ntips: "假装昏倒！"\n</small>'
  assert.deepEqual(splitLines(reply, { names: nian }).map(b => [b.kind, b.plain]), [
    ['narration', '她还在等。'],
    ['option', '😖 低头承认,小声说「是……」'],
    ['option', '😰 试图转移话题'],
  ])
  // Still coming in: the open block's prompt is hidden, the option being written waits.
  assert.deepEqual(splitLines('她还在等。\n\n<small>\n请选择:\n1️⃣ 低头\n2️⃣ 试', { names: nian, partial: true }).map(b => b.kind), ['narration', 'option'])
})
