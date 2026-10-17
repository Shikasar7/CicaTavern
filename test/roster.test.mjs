import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFrame, cleanRoster, countTags, draftMaterial, flattenFrame, isFramePrompt, leadOf, naiCharacters, parseFrame, parseRosterDraft, rosterBrief } from '../server/roster.mjs'
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
