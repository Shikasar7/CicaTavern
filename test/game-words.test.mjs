// 叫法: a card's own names for what the rules call 体魄, 生命, 首领 and the rest. Only words: the rolls, the numbers and
// what is kept go by the rules' ids, so a card that calls 灵巧 速度 rolls the same.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, attributeOf, cleanKit, cleanRulebook, keptSheet, kitBook, modifierFor, rollCheck, settleReply, sheetOf, startSheet, wordFor } from '../web/shared/game/sheet.js'
import { replyMarks } from '../web/shared/game/marks.js'
import { gamePrompt, parseSuggestion, suggestRequest } from '../server/game.mjs'

const MONSTER = { body: '力量', grace: '速度', mind: '智力', charm: '羁绊', life: 'HP', minion: '野生', boss: 'BOSS', skill: '必杀技', party: '伙伴' }
const BOOK = cleanRulebook({ level: 'full', attributes: { body: 10, grace: 16, mind: 10, charm: 10 }, words: MONSTER })

test('a card\'s words are kept as given: what is the default, empty or unknown goes, long ones are cut', () => {
  assert.deepEqual(BOOK.words, MONSTER)
  const odd = cleanRulebook({ words: { body: '体魄', grace: '  ', life: '生命值是很长的叫法啊啊', dance: '舞', skill: 7 } })
  assert.deepEqual(odd.words, { life: '生命值是很长的叫' })
  assert.deepEqual(cleanRulebook({}).words, {})
  assert.equal(wordFor(BOOK, 'life'), 'HP')
  assert.equal(wordFor(BOOK, 'bag'), '行囊')
})

test('a roll by the card\'s name for an attribute is a roll of that attribute', () => {
  const sheet = sheetOf(BOOK, startSheet(BOOK), {})
  assert.deepEqual(sheet.named, { body: '力量', grace: '速度', mind: '智力', charm: '羁绊' })
  assert.equal(attributeOf('速度', sheet.named), 'grace')
  assert.equal(attributeOf('灵巧', sheet.named), 'grace', 'the rules\' own name still works')
  assert.equal(attributeOf('速度'), null, 'without the card, 速度 is nothing')
  assert.equal(modifierFor(sheet, '速度'), modifierFor(sheet, '灵巧'))
  assert.equal(modifierFor(sheet, '速度'), 3)
  const byName = rollCheck(sheet, BOOK, { stat: '速度', dc: 12 }, 'chat', 'node')
  assert.equal(byName.stat, '速度')
  assert.equal(byName.modifier, 3)
  assert.equal(keptSheet(sheet).named, undefined, 'what a reply keeps has no names in it')
})

test('a condition on the card\'s name for an attribute holds that attribute back', () => {
  const sheet = sheetOf(BOOK, startSheet(BOOK), {})
  const after = settleReply(sheet, replyMarks('脚扭了。【异常|扭伤|速度|中】'), { book: BOOK })
  assert.equal(after.conditions[0].stat, 'grace')
  assert.equal(modifierFor({ ...after, named: sheet.named }, '速度'), 1)
})

test('the model is told the rules in the card\'s words', () => {
  const sheet = sheetOf(BOOK, startSheet(BOOK), {})
  const told = gamePrompt({ sheet, pausing: true, fights: true, check: null, words: BOOK.words }, []).text
  assert.match(told, /属性：力量、速度、智力、羁绊/)
  assert.match(told, /【检定\|速度\|DC12】/)
  assert.match(told, /【检定\|智力\|DC12\|需要:铜钥匙】/)
  assert.match(told, /<游戏状态>HP 100\/100（状态好）；力量 10、速度 16、智力 10、羁绊 10/)
  // Renamed in a story under way: the rules are told again, in the new words.
  const before = { role: 'user', prompt: gamePrompt({ sheet: startSheet({}), pausing: true, fights: true, check: null }, []).text }
  assert.match(gamePrompt({ sheet, pausing: true, fights: true, check: null, words: BOOK.words }, [before]).text, /<游戏规则>/)
  assert.doesNotMatch(gamePrompt({ sheet: startSheet({}), pausing: true, fights: true, check: null }, [before]).text, /<游戏规则>/, 'no names of its own, the rules are not told twice')
  const battle = { over: 'won', foes: '野狗兽', downed: '野狗兽', rounds: 3, life: 70, maxLife: 100, used: {}, skills: [] }
  assert.match(gamePrompt({ sheet, pausing: true, fights: true, check: null, battle, words: BOOK.words }, []).text, /玩家：HP 70\/100/)
})

test('the helper is not shown a 武侠 example, and has kinds of story beyond it to pick from', () => {
  const { content } = suggestRequest({ description: '数码世界的冒险', book: { entries: [] } }, []).messages[0]
  assert.doesNotMatch(content, /"theme":"wuxia"|内力|招式|剑客/)
  assert.match(content, /怪兽养成/)
  assert.match(content, /网游/)
  assert.match(content, /"words"/)
  const found = parseSuggestion('{"theme":"monster","energy":"能量","words":{"body":"力量","grace":"速度","life":"HP","bad":"x"},"attributes":{"grace":14},"skills":[{"name":"小型火焰弹","kind":"strike"}],"things":[],"foes":[],"companions":[{"name":"亚古兽","skills":[{"name":"小型火焰弹","kind":"strike"}]}],"ranks":["成长期","成熟期","完全体","究极体"]}', [])
  assert.equal(found.theme, 'monster')
  assert.deepEqual(found.words, { body: '力量', grace: '速度', life: 'HP' })
  assert.deepEqual(Object.keys(found.companions), ['亚古兽'])
  assert.deepEqual(found.ranks, ['成长期', '成熟期', '完全体', '究极体'])
})

test('a kit\'s words become the card\'s', () => {
  assert.deepEqual(kitBook(cleanKit({ words: { life: 'HP', skill: '必杀技' } })).words, { life: 'HP', skill: '必杀技' })
  assert.equal(kitBook(cleanKit({})).words, undefined)
})

test('an operation by the card\'s name for nothing changes nothing: the words are only words', () => {
  const sheet = sheetOf(BOOK, startSheet(BOOK), {})
  const { sheet: after } = applyOps(sheet, BOOK, [{ op: 'life', value: 40 }])
  assert.equal(after.life, 40)
  assert.deepEqual(after.attributes, sheet.attributes)
})

test('what holds the player back, and a lost fight, are told to the model in the card\'s words', () => {
  const sheet = sheetOf(BOOK, startSheet(BOOK), {})
  const hurt = { ...sheet, conditions: [{ name: '扭伤', stat: 'grace', size: 'medium', days: 2, turns: 8 }, { name: '重伤', stat: '', size: 'medium', days: 3, turns: 14 }] }
  const told = gamePrompt({ sheet: hurt, pausing: true, fights: true, check: null, words: BOOK.words }, []).text
  assert.match(told, /异常：扭伤（速度，还有 2 天）、重伤（所有行动，还有 3 天）/)
  assert.match(told, /【异常\|扭伤左脚\|速度\|中】/, 'the example of a mark is in the card\'s words too')
  assert.doesNotMatch(told, /灵巧/)
  const lost = { over: 'lost', foes: '乱码狼', downed: '', rounds: 9, life: 0, maxLife: 100, used: {}, skills: [] }
  const after = gamePrompt({ sheet, pausing: true, fights: true, check: null, battle: lost, words: BOOK.words }, []).text
  assert.match(after, /战败，玩家没有死，HP只剩一点/)
  assert.doesNotMatch(after, /生命/)
  // A card with none of its own: the rules' words, as before.
  const plain = gamePrompt({ sheet: { ...hurt, named: {} }, pausing: true, fights: true, check: null, battle: lost }, []).text
  assert.match(plain, /异常：扭伤（灵巧，还有 2 天）/)
  assert.match(plain, /战败，玩家没有死，生命只剩一点/)
})

test('the bag, the fight and the transcript take the card\'s words for life, skills, experience and the party', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = async name => readFile(new URL(`../web/${name}`, import.meta.url), 'utf8')
  // Only the defaults are written out; the card's word comes first wherever one of these is shown.
  for (const name of ['game-bag.js', 'game-battle.js', 'game-play.js']) {
    const text = await source(name)
    assert.doesNotMatch(text, /t`生命 \$\{|t`经验 [+$]|t` · 经验|t`技能：|拼命再战：生命|他加入时|让他能上场|跟着队伍走|队伍暂时用不上/, name)
  }
})
