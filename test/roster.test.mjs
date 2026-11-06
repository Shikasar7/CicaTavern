import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatMaterial, cleanFrame, cleanRoster, countTags, draftMaterial, flattenFrame, isFramePrompt, leadOf, naiCharacters, parseFrame, parseRosterChat, parseRosterDraft, rosterBrief, rosterChatRequest, withSomeone } from '../server/roster.mjs'
import { imagePromptRequest, naiRequest, referenceModel, withStyle } from '../server/media.mjs'

const ROSTER = cleanRoster([
  { id: 'nian0001', name: '顾念念', aliases: '念念, 小师妹', kind: 'girl', looks: 'black hair, hair bun, white ribbon, dark eyes, dimples', outfit: 'white and pale blue wudang robe' },
  { id: 'mu000001', name: '慕寒漪', kind: 'girl', looks: 'long silver hair, ice blue eyes, tall', outfit: 'white hanfu, sword' },
  { id: 'hero0001', name: '主角', kind: 'boy', player: true, looks: 'black hair, half updo, wooden hairpin, calm eyes, lean', outfit: 'white taoist robe, grey inner clothes' },
])

test('roster: entries cleaned, one player, names and aliases matched', () => {
  const cleaned = cleanRoster([
    { name: '  甲  ', kind: 'nope', player: true },
    { name: '乙', player: true },
    { name: '' },
    { name: '丙' },
    null,
  ])
  assert.equal(cleaned.length, 3)
  assert.equal(cleaned[0].name, '甲')
  assert.equal(cleaned[0].kind, 'girl')
  assert.equal(cleaned[0].player, true)
  assert.equal(cleaned[1].player, false, 'only one player entry')
  assert.match(cleaned[0].id, /^[a-z0-9]{10}$/)
  assert.throws(() => cleanRoster([{ name: '丁', lora: '../../secret.safetensors' }]), /LoRA/)

  const brief = rosterBrief(ROSTER, '大师兄')
  assert.match(brief, /\[顾念念\] girl; usual outfit: white and pale blue wudang robe/)
  assert.match(brief, /\[大师兄\] the player character, boy/, 'the player is named as the chat names them')
})

test('frame: cast lines parsed, looks filled in per character, nobody else named', () => {
  const text = [
    '场景: misty stone steps, dawn, low angle',
    '[念念] crouching, tying his leg wrap, sweet smile | left',
    '[大师兄] standing, looking down at her | 右',
    '[路人甲] a monk sweeping in the distance',
    '[顾念念] duplicate line ignored',
  ].join('\n')
  assert.ok(isFramePrompt(text))
  assert.ok(!isFramePrompt('1girl, smile'))
  const frame = parseFrame(text, ROSTER, '大师兄')
  assert.deepEqual(frame.characters.map(c => [c.entry.name, c.position]), [['顾念念', 'left'], ['主角', 'right']])
  assert.equal(frame.scene, 'misty stone steps, dawn, low angle, a monk sweeping in the distance, duplicate line ignored')
  assert.equal(countTags(frame.characters), '1girl, 1boy')

  const chars = naiCharacters(frame)
  assert.equal(chars[0].prompt, 'girl, black hair, hair bun, white ribbon, dark eyes, dimples, crouching, tying his leg wrap, sweet smile')
  assert.deepEqual([chars[0].x, chars[1].x, chars[0].positioned], [0.3, 0.7, true])

  assert.equal(
    flattenFrame(frame, 'tags'),
    '1girl, 1boy, misty stone steps, dawn, low angle, a monk sweeping in the distance, duplicate line ignored, black hair, hair bun, white ribbon, dark eyes, dimples, crouching, tying his leg wrap, sweet smile, black hair, half updo, wooden hairpin, calm eyes, lean, standing, looking down at her',
  )
  assert.match(flattenFrame(frame, 'natural'), /^misty stone steps.*\. A girl \(on the left\) with black hair.*: crouching/)

  const body = naiRequest({ model: 'nai-diffusion-5-full', prompt: 'base', negative: 'neg', width: 832, height: 1216, seed: 1, characters: chars })
  assert.equal(body.parameters.v4_prompt.use_coords, true)
  assert.deepEqual(body.parameters.v4_prompt.caption.char_captions[1], { char_caption: chars[1].prompt, centers: [{ x: 0.7, y: 0.5 }] })
  assert.equal(body.parameters.v4_negative_prompt.caption.char_captions.length, 2)
  assert.equal(body.parameters.characterPrompts.length, 2)
  assert.equal(body.parameters.director_reference_images, undefined)

  const withRef = naiRequest({ model: referenceModel('nai-diffusion-5-full'), prompt: 'p', negative: 'n', width: 832, height: 1216, seed: 1, reference: { image: 'QUJD', fidelity: 0.8, style: false } })
  assert.equal(withRef.model, 'nai-diffusion-4-5-full')
  assert.equal(referenceModel('nai-diffusion-5-curated'), 'nai-diffusion-4-5-curated')
  assert.deepEqual(withRef.parameters.director_reference_images, ['QUJD'])
  assert.equal(withRef.parameters.director_reference_descriptions[0].caption.base_caption, 'character')
  assert.deepEqual(withRef.parameters.director_reference_secondary_strength_values, [0.2])
})

test('cast-format answers cleaned; style goes first in the scene line', () => {
  const answer = '<think>hmm</think>\nHere you go:\n```\n场景: forest, night\n- [顾念念] running, laughing | center\n[主角] chasing her\n```\nHope it helps!'
  assert.equal(cleanFrame(answer), '场景: forest, night\n[顾念念] running, laughing | center\n[主角] chasing her')
  assert.equal(cleanFrame('1girl, forest'), null)
  assert.equal(withStyle('场景: forest\n[顾念念] running', 'anime coloring', 'tags'), '场景: anime coloring, forest\n[顾念念] running')
  assert.equal(withStyle('[顾念念] running', 'anime coloring', 'tags'), '场景: anime coloring\n[顾念念] running')
  assert.equal(withStyle('1girl', 'anime coloring', 'tags'), 'anime coloring, 1girl')
  assert.equal(withStyle('1girl', 'anime coloring', 'natural'), '1girl')

  const request = imagePromptRequest({ card: { description: 'x' }, names: { char: '顾念念', user: '大师兄' }, reply: '……', input: '', state: {}, style: '', promptStyle: 'tags', roster: ROSTER })
  assert.match(request.messages[0].content, /<cast>\n- \[顾念念\]/)
  assert.match(request.messages[0].content, /Never describe their hair, eyes, face or body/)
  assert.doesNotMatch(request.messages[0].content, /Keep the character's looks consistent/)
  assert.match(request.messages[0].content, /Somebody is always in the picture: the people <latest_passage> shows at that moment/)
})

test('an illustration always has somebody in it: the card\'s own character joins an empty scene', () => {
  // The helper wrote only the setting (or an empty room as plain tags): 顾念念, the card's character, stands in it.
  assert.equal(withSomeone('场景: dark bedroom, messy bed, night', ROSTER, '大师兄', '顾念念 - 武当', 'tags'), '场景: dark bedroom, messy bed, night\n[顾念念] white and pale blue wudang robe, standing, looking at viewer | center')
  assert.equal(withSomeone('scenery, no humans, bedroom', ROSTER, '大师兄', '武当', 'tags'), '场景: scenery, bedroom\n[顾念念] white and pale blue wudang robe, standing, looking at viewer | center', 'no card name match: the first one who is not the player')
  assert.match(withSomeone('A quiet bedroom at night. No people.', ROSTER, '大师兄', '顾念念', 'natural'), /^场景: A quiet bedroom at night\.?\n\[顾念念\] white and pale blue wudang robe, standing in the scene, looking at the viewer \| center$/)
  // Somebody is already there: a [Name] line (the player counts), a head count, a person in the words.
  for (const prompt of ['场景: forest\n[主角] walking', '1girl, forest', 'A girl waits under the tree.', '场景: market\n[掌柜] counting coins']) {
    assert.equal(withSomeone(prompt, ROSTER, '大师兄', '顾念念', 'tags'), prompt)
  }
  assert.equal(withSomeone('', ROSTER, '大师兄', '顾念念'), '', 'no prompt stays no prompt')
  assert.equal(withSomeone('bedroom', [], '大师兄', '顾念念'), 'bedroom', 'no cast: left to the instructions')
  // A [Name] line in bold is still a [Name] line.
  assert.equal(cleanFrame('**场景:** forest\n**[顾念念]** running'), '场景: forest\n[顾念念] running')
})

test('roster draft: material ranks looks-heavy entries first, JSON pulled out of chatter', () => {
  const card = {
    description: '武当山上的故事。',
    book: {
      entries: [
        { comment: '战斗', content: '境界与劲力相克。'.repeat(50), enabled: true },
        { comment: '慕寒漪', content: '蓬莱剑仙，银发冰眸，白衣佩剑，身材高挑。', enabled: true },
        { comment: '关掉的', content: '银发', enabled: false },
      ],
    },
  }
  const material = draftMaterial(card, [], 400)
  assert.ok(material.indexOf('慕寒漪') < material.indexOf('战斗') || !material.includes('战斗'))
  assert.ok(!material.includes('关掉的'))

  const roster = parseRosterDraft('好的：\n```json\n[{"name":"慕寒漪","kind":"girl","looks":"silver hair","outfit":"white hanfu"},{"name":"主角","kind":"boy","player":true,"id":"evil/../x"}]\n```')
  assert.deepEqual(roster.map(e => [e.name, e.player]), [['慕寒漪', false], ['主角', true]])
  assert.match(roster[1].id, /^[a-z0-9]{10}$/)
  assert.deepEqual(parseRosterDraft('no json here'), [])
})

test('leadOf: the one person, or the one besides the player', () => {
  const her = { id: 'a', player: false }
  const him = { id: 'b', player: true }
  const other = { id: 'c', player: false }
  assert.equal(leadOf([{ entry: her }]), her)
  assert.equal(leadOf([{ entry: him }]), him)
  assert.equal(leadOf([{ entry: her }, { entry: him }]), her)
  assert.equal(leadOf([{ entry: her }, { entry: other }]), null)
  assert.equal(leadOf([{ entry: her }, { entry: other }, { entry: him }]), null)
})

test('从对话里补充: the last turns as shown, newest kept when long; the request names who the list has', () => {
  const path = [
    { role: 'assistant', display: '开场。' },
    { role: 'user', text: '你好' },
    { role: 'assistant', display: '老周撑着船过来。', text: '老周撑着船过来。<state>{}</state>' },
    { role: 'user', text: '' },
  ]
  assert.equal(chatMaterial(path), '<reply>\n开场。\n</reply>\n\n<player>\n你好\n</player>\n\n<reply>\n老周撑着船过来。\n</reply>')
  assert.equal(chatMaterial(path, { turns: 1 }), '<reply>\n老周撑着船过来。\n</reply>', 'the newest turns')
  assert.equal(chatMaterial(path, { budget: 30 }), '<reply>\n老周撑着船过来。\n</reply>', 'over the budget: the newest kept')
  const request = rosterChatRequest('<reply>…</reply>', { cast: [{ name: '林雪', aliases: '雪儿, 林警官', player: false }, { name: '主角', aliases: '', player: true }], userName: '阿明', setting: '民国，上海' })
  const asked = request.messages[0].content
  assert.ok(asked.startsWith('<setting>\n民国，上海\n</setting>'))
  assert.ok(asked.includes('- 林雪 (also: 雪儿, 林警官)\n- 主角 = the player character (also: 阿明)\n'), 'the list with every name it goes by')
  assert.match(asked, /"fix": \[\{"name"/)
  assert.match(rosterChatRequest('x').messages[0].content, /\(nobody yet\)/)
})

test('从对话里补充: newcomers, and for the list\'s people the names the story calls them now; nobody gets a name that is taken', () => {
  const cast = [
    { id: 'aaaaaa01', name: '林清禾', aliases: '清禾', player: false },
    { id: 'aaaaaa02', name: '顾念念', aliases: '', player: false },
    { id: 'aaaaaa03', name: '主角', aliases: '', player: true },
  ]
  const found = {
    new: [
      { name: '老周', aliases: '船夫', kind: 'boy', looks: 'old man', outfit: 'straw hat' },
      { name: '小师妹', aliases: '顾念念', kind: 'girl', looks: 'pink hair' },
      { name: '阿明', kind: 'boy' },
      { name: '周伯', aliases: '老周', kind: 'boy' },
    ],
    fix: [
      { name: '林清禾', rename: '林青禾', aliases: '青禾, 林姑娘, 清禾' },
      { name: '主角', rename: '少爷', aliases: '少爷' },
      { name: '没这个人', aliases: '某人' },
      { name: '顾念念', aliases: '念念, 林姑娘' },
    ],
  }
  const { roster, fixes } = parseRosterChat(`<think>…</think>\n\`\`\`json\n${JSON.stringify(found)}\n\`\`\``, cast, '阿明')
  assert.deepEqual(roster.map(e => [e.name, e.player, e.lora]), [['老周', false, '']], 'one under a name the list has is that person; the player is nobody new; two under one name, the first')
  assert.deepEqual(fixes, [
    { id: 'aaaaaa01', name: '林清禾', rename: '林青禾', aliases: ['林清禾', '青禾', '林姑娘'] },
    { id: 'aaaaaa03', name: '主角', rename: '', aliases: ['少爷'] },
    { id: 'aaaaaa02', name: '顾念念', rename: '', aliases: ['念念', '小师妹'] },
  ], 'the old name kept when renamed; the player keeps its name; a name another already took goes to nobody')

  assert.deepEqual(parseRosterChat('[{"name":"老周","kind":"boy"}]', cast).roster.map(e => e.name), ['老周'], 'an array is the newcomers alone')
  assert.deepEqual(parseRosterChat('没有新人。', cast), { roster: [], fixes: [] })
  const many = Array.from({ length: 30 }, (_, i) => `外号${i}`).join(',')
  const full = parseRosterChat(JSON.stringify({ fix: [{ name: '顾念念', aliases: many }] }), [{ ...cast[1], aliases: '念念' }])
  assert.ok(full.fixes[0].aliases.length < 30 && `念念, ${full.fixes[0].aliases.join(', ')}`.length <= 120, 'as many as the field keeps')
})

const PASSAGE = '慕寒漪把剑放下，小师妹没有接话，念念只是低着头。'
const framed = (answer, passage = PASSAGE) => cleanFrame(answer, 'standard', { roster: ROSTER, userName: '大师兄', passage })

test('a cast line written a little differently is still that person: a list item, no brackets, a colon, a word for the player', () => {
  assert.equal(framed('场景: hall\n1. [顾念念] crying | left'), '场景: hall\n[顾念念] crying | left')
  assert.equal(framed('场景: hall\n- 慕寒漪: holding a sword'), '场景: hall\n[慕寒漪] holding a sword')
  assert.equal(framed('[场景] hall, night\n[顾念念]: crying'), '场景: hall, night\n[顾念念] crying')
  assert.equal(framed('[小师妹] crying'), '[顾念念] crying', 'an alias')
  assert.equal(framed('[慕寒漪姑娘] standing'), '[慕寒漪] standing', 'with more around the name')
  assert.equal(framed('[你] watching'), '[大师兄] watching')
  assert.equal(framed('hall: wide and dark\n[顾念念] crying'), '[顾念念] crying', 'a label that is nobody is no line of the format')
  assert.equal(framed('场景: hall\n顾念念 提着灯, crouching'), '场景: hall\n[顾念念] 提着灯, crouching', 'the name, then a space')
  assert.equal(cleanFrame('You stand in a hall', 'standard', { roster: ROSTER, userName: '大师兄', passage: PASSAGE }), null, 'a word for the player only counts in brackets')
  assert.equal(parseFrame('[顾念念]: crying | left', ROSTER, '大师兄').characters[0].action, 'crying')
})

test('a name nobody uses is the person the passage talks about, and one the story does use stays somebody off the list', () => {
  assert.equal(framed('[Gu Niannian] crying'), '[顾念念] crying', 'the most named in the passage')
  assert.equal(framed('[慕寒漪] standing\n[Name] crying'), '[慕寒漪] standing\n[顾念念] crying', 'someone in the frame already is not taken twice')
  assert.equal(framed('[Su Wan] crying', '窗外下着雨。'), '[Su Wan] crying', 'nobody to go by')
  assert.equal(framed('[老周] old man, limping', '老周走进雨里，慕寒漪看着他。'), '[老周] old man, limping')
  assert.deepEqual(parseFrame(framed('[Name] crying'), ROSTER, '大师兄').characters.map(c => c.entry.name), ['顾念念'])
})

test('nobody in the prompt: the person the passage is about, before the card\'s own character', () => {
  assert.match(withSomeone('场景: hall, night', ROSTER, '大师兄', '顾念念', 'tags', '慕寒漪收了剑，慕寒漪转过身。'), /^场景: hall, night\n\[慕寒漪\] /)
  assert.match(withSomeone('场景: hall, night', ROSTER, '大师兄', '顾念念', 'tags', '窗外下着雨。'), /\n\[顾念念\] /, 'nobody named: the card\'s own')
})

test('a prompt that left the format keeps its words and gets the looks of those the passage is about', () => {
  const tags = withSomeone('1girl, solo, crying, hall', ROSTER, '大师兄', '武当', 'tags', PASSAGE)
  assert.equal(tags, '场景: 1girl, solo, crying, hall\n[顾念念]')
  const frame = parseFrame(tags, ROSTER, '大师兄')
  assert.match(flattenFrame(frame, 'tags'), /^1girl, 1girl, solo, crying, hall, black hair, hair bun/)
  const words = withSomeone('Two women stand in a dark hall, one holding a sword.', ROSTER, '大师兄', '武当', 'natural', PASSAGE)
  assert.equal(words, '场景: Two women stand in a dark hall, one holding a sword.\n[顾念念]\n[慕寒漪]')
  assert.match(flattenFrame(parseFrame(words, ROSTER, '大师兄'), 'natural'), /^Two women stand in a dark hall, one holding a sword\. The girl has black hair.* The girl has long silver hair/)
  assert.equal(withSomeone('1girl, crying', ROSTER, '大师兄', '武当', 'tags', '窗外下着雨。'), '1girl, crying', 'nobody on the list in the passage')
})

test('the cast\'s names may stay Chinese in an English prompt; without a cast nothing Chinese is asked for', () => {
  const asked = (roster = []) => { const request = imagePromptRequest({ card: { name: '林雪', description: '掌柜' }, names: { char: '林雪', user: '你' }, reply: '下雨了', roster, promptStyle: 'tags' }); return request.messages[0].content }
  assert.ok(!asked(ROSTER).includes('no Chinese'))
  assert.match(asked(ROSTER), /in English except the names in \[ \]/)
  assert.match(asked(ROSTER), /never romanized or translated/)
  assert.match(asked(), /no Chinese/)
  assert.match(asked(ROSTER), /A cast member who is not there stays out, even 林雪/)
  assert.ok(!/at least one/.test(asked(ROSTER)), 'nobody is added to fill the frame')
})
