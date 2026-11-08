// The visual novel stage (web/shared/stage.js): expressions from the narration,
// effects, and who stands on the stage line by line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectsOf, EXPRESSION_LOOK, EXPRESSIONS, FACE_WORDS, faceOf, guessExpression, markEffects, heroOf, packFaces, stageAt } from '../web/shared/stage.js'
import { speakerNames } from '../web/shared/vn.js'

test('an expression from the narration around a line, else from the voice', () => {
  assert.equal(guessExpression('林青禾笑了笑：「来了？」'), 'smile')
  assert.equal(guessExpression('她红了脸，小声说：「别看我。」'), 'shy')
  assert.equal(guessExpression('他皱起眉：「你又迟到了。」'), 'angry')
  assert.equal(guessExpression('她眼眶一红：「我没事。」'), 'sad')
  assert.equal(guessExpression('她愣住了：「你说什么？」'), 'surprised')
  assert.equal(guessExpression('她托腮想了想：「也许吧。」'), 'thinking')
  assert.equal(guessExpression('她大笑起来：「太好了！」'), 'happy')
  // The words inside the quote are not the narration: 「笑什么」 is not a smile.
  assert.equal(guessExpression('她看着你：「你笑什么？」'), null)
  assert.equal(guessExpression('「诶？！」'), 'surprised')
  assert.equal(guessExpression('「哈哈，你输了。」'), 'happy')
  assert.equal(guessExpression('She smiled. "Welcome back."'), 'smile')
  assert.equal(guessExpression('窗外下着雨。'), null)
  // Every expression but the 立绘 itself has its look for drawing.
  assert.deepEqual(Object.keys(EXPRESSION_LOOK).sort(), EXPRESSIONS.filter(name => name !== 'neutral').sort())
})

test('effects only on plain words, from the narration', () => {
  assert.deepEqual(effectsOf('一道闪电劈下来，屋里亮了一瞬。'), { screen: 'flash', actor: null })
  assert.deepEqual(effectsOf('他一拳砸在桌上：「够了！」'), { screen: 'shake', actor: null })
  assert.deepEqual(effectsOf('她吓了一跳：「谁？」'), { screen: null, actor: 'jump' })
  assert.deepEqual(effectsOf('她浑身发抖。'), { screen: null, actor: 'tremble' })
  assert.deepEqual(effectsOf('「外面打雷了吗？」她问。'), { screen: null, actor: null })
  assert.deepEqual(effectsOf('她慢慢地喝了一口茶。'), { screen: null, actor: null })
})

const names = [
  { name: '林青禾', keys: ['林青禾', '青禾'], char: true },
  { name: '你', keys: ['你'], player: true },
  { name: '周管事', keys: ['周管事'] },
  { name: '沈砚', keys: ['沈砚', '阿砚'] },
  { name: '小满', keys: ['小满'] },
]
const line = (kind, speaker, plain, extra = {}) => ({ type: 'line', kind, speaker, plain, ...extra })

test('the stage: speakers step on, keep their expressions, the quiet one makes room', () => {
  const steps = [
    line('narration', null, '雨下了一下午。', { where: { place: '茶馆' } }),
    line('dialogue', '林青禾', '林青禾笑了笑：「来了？」'),
    line('dialogue', '你', '「嗯。」'),
    line('dialogue', '周管事', '周管事皱起眉：「账不对。」'),
    line('narration', null, '林青禾低头翻账本。'),
    line('dialogue', '林青禾', '「哪里不对？」'),
    line('dialogue', '沈砚', '沈砚推门进来：「我来对账。」'),
  ]
  const isActor = name => name !== '你'
  assert.deepEqual(stageAt(steps, 0, { names, isActor }), { members: [], speaker: null, effects: { screen: null, actor: null } })
  assert.deepEqual(stageAt(steps, 1, { names, isActor }).members, [{ name: '林青禾', expression: 'smile' }])
  // The player has no picture: nobody new, nobody speaking.
  assert.equal(stageAt(steps, 2, { names, isActor }).speaker, null)
  const narration = stageAt(steps, 4, { names, isActor })
  assert.deepEqual(narration.members, [{ name: '林青禾', expression: 'smile' }, { name: '周管事', expression: 'angry' }])
  assert.equal(narration.speaker, null)
  // A line with nothing to say about the face keeps the last expression.
  assert.equal(stageAt(steps, 5, { names, isActor }).members[0].expression, 'smile')
  assert.equal(stageAt(steps, 5, { names, isActor }).speaker, '林青禾')
  // Two at most: 周管事 was quiet longest and steps off for 沈砚.
  const full = stageAt(steps, 6, { names, isActor, max: 2 })
  assert.deepEqual(full.members.map(m => m.name), ['林青禾', '沈砚'])
  assert.equal(full.speaker, '沈砚')
})

test('the stage: someone leaves when the narration says so, everyone when the place changes', () => {
  const steps = [
    line('dialogue', '林青禾', '「坐吧。」', { where: { place: '茶馆' } }),
    line('dialogue', '周管事', '「我先走了。」'),
    line('narration', null, '周管事拱了拱手，转身走了。'),
    line('dialogue', '林青禾', '「慢走。」'),
    line('narration', null, '你们来到码头。', { where: { place: '码头' } }),
  ]
  assert.deepEqual(stageAt(steps, 1, { names }).members.map(m => m.name), ['林青禾', '周管事'])
  assert.deepEqual(stageAt(steps, 3, { names }).members.map(m => m.name), ['林青禾'])
  assert.deepEqual(stageAt(steps, 4, { names }).members, [])
})

test('the stage: labels from the helper model come before the narration', () => {
  const steps = [line('dialogue', '林青禾', '林青禾笑了笑：「来了？」'), line('dialogue', '林青禾', '「你迟到了。」')]
  assert.equal(stageAt(steps, 1, { names }).members[0].expression, 'smile')
  assert.equal(stageAt(steps, 1, { names, labels: [null, 'angry'] }).members[0].expression, 'angry')
  // Something that is not an expression is ignored.
  assert.equal(stageAt(steps, 0, { names, labels: ['furious'] }).members[0].expression, 'smile')
})

test('an expression pack: SillyTavern\'s names (and plain ones) to the expressions here, folder by folder', () => {
  const packs = packFaces([
    'Seraphina/joy.png', 'Seraphina/joy-1.png', 'Seraphina/anger.png', 'Seraphina/neutral.png', 'Seraphina/curiosity.webp',
    'Seraphina/love.png', 'Seraphina/admiration.png', 'Seraphina/grief.png', '__MACOSX/Seraphina/._joy.png', 'Other/微笑.png', 'readme.txt',
  ])
  assert.deepEqual(packs.map(pack => pack.folder), ['Seraphina', 'Other'], 'the fullest first; no mac leftovers')
  assert.deepEqual(packs[0].faces, {
    neutral: 'Seraphina/neutral.png',
    smile: 'Seraphina/admiration.png',
    happy: 'Seraphina/joy.png',
    shy: 'Seraphina/love.png',
    angry: 'Seraphina/anger.png',
    sad: 'Seraphina/grief.png',
    thinking: 'Seraphina/curiosity.webp',
  })
  assert.deepEqual(packs[0].unused, ['Seraphina/joy-1.png'], 'of several, the plainest name')
  assert.deepEqual(packs[1].faces, { smile: 'Other/微笑.png' })
  assert.deepEqual(packFaces(['a.png', 'notes.txt']), [], 'nothing named after a feeling')
})

test('视觉小说格式: a mark\'s words to an expression and effects; the stage takes them before anything else', () => {
  assert.equal(faceOf('微笑'), 'smile')
  assert.equal(faceOf('Smile'), 'smile')
  assert.equal(faceOf('joy'), 'happy')
  assert.equal(faceOf('苦笑'), 'smile')
  assert.equal(faceOf('脸红了'), 'shy')
  assert.equal(faceOf('惊恐'), 'surprised')
  assert.equal(faceOf('若有所思'), 'thinking')
  assert.equal(faceOf('冷淡'), 'neutral')
  assert.equal(faceOf(''), null)
  assert.equal(faceOf('xyz'), null)
  assert.deepEqual(markEffects(['震屏']), { screen: 'shake', actor: null })
  assert.deepEqual(markEffects(['闪白', '发抖']), { screen: 'flash', actor: 'tremble' })
  assert.equal(markEffects(['攻击力+5']), null)
  assert.ok(Object.keys(FACE_WORDS).every(name => EXPRESSIONS.includes(name)) && Object.keys(FACE_WORDS).length === EXPRESSIONS.length)
  // The mark wins over the narration (皱起眉 → angry) and over the helper's label.
  const steps = [line('dialogue', '林青禾', '她皱起眉：「来了？」', { expression: 'happy' })]
  assert.equal(stageAt(steps, 0, { names }).members[0].expression, 'happy')
  assert.equal(stageAt(steps, 0, { names, labels: ['sad'] }).members[0].expression, 'happy')
  const loud = [line('narration', null, '轰隆一声，门被撞开。', { effects: { screen: 'flash', actor: null } })]
  assert.deepEqual(stageAt(loud, 0, { names }).effects, { screen: 'flash', actor: null })
  assert.deepEqual(stageAt([line('narration', null, '轰隆一声，门被撞开。')], 0, { names }).effects, { screen: 'shake', actor: null })
})

test('stageAt: 常驻 stay on stage, and with detection off nobody else steps on', () => {
  const names = [{ name: '林青禾', keys: ['林青禾'] }, { name: '周管事', keys: ['周管事'] }, { name: '沈砚', keys: ['沈砚'] }, { name: '你', keys: ['你'], player: true }]
  const say = (kind, speaker, plain, extra = {}) => ({ type: 'line', kind, speaker, plain, ...extra })
  const steps = [
    say('narration', null, '雨下了一下午。', { where: { place: '茶馆' } }),
    say('dialogue', '周管事', '周管事皱起眉：「账不对。」'),
    say('narration', null, '林青禾离开了茶馆。'),
    say('dialogue', '林青禾', '林青禾笑了笑：「来了？」'),
    say('narration', null, '他们到了后院。', { where: { place: '后院' } }),
    ...Array.from({ length: 14 }, () => say('narration', null, '雨还在下。')),
  ]
  const isActor = name => name !== '你'
  const who = (index, options) => stageAt(steps, index, { names, isActor, ...options }).members.map(member => member.name)

  // Here from the first line, whoever speaks joining them.
  assert.deepEqual(who(0, { fixed: ['林青禾'] }), ['林青禾'])
  assert.deepEqual(who(1, { fixed: ['林青禾'] }), ['林青禾', '周管事'])
  // Leaving, a new place and a long silence take the others, not them.
  assert.deepEqual(who(2, { fixed: ['林青禾'] }), ['林青禾', '周管事'])
  assert.deepEqual(who(4, { fixed: ['林青禾'] }), ['林青禾'])
  assert.deepEqual(who(steps.length - 1, { fixed: ['林青禾'] }), ['林青禾'])
  // They still get their expressions and the light when they speak.
  const speaking = stageAt(steps, 3, { names, isActor, fixed: ['林青禾'] })
  assert.equal(speaking.speaker, '林青禾')
  assert.equal(speaking.members[0].expression, 'smile')

  // Detection off: speaking brings nobody on.
  assert.deepEqual(who(1, { auto: false }), [])
  assert.deepEqual(who(3, { auto: false, fixed: ['林青禾'] }), ['林青禾'])
  assert.equal(stageAt(steps, 1, { names, isActor, auto: false, fixed: ['林青禾'] }).speaker, null)

  // The player, or someone with no picture, cannot be kept there.
  assert.deepEqual(who(0, { fixed: ['你'] }), [])

  // More than there is room for: the first ones stand, one left over takes a place when they speak, and nobody else does.
  assert.deepEqual(who(0, { fixed: ['沈砚', '林青禾'], max: 1 }), ['沈砚'])
  assert.deepEqual(who(3, { fixed: ['沈砚', '林青禾'], max: 1 }), ['林青禾'])
  assert.deepEqual(who(1, { fixed: ['沈砚'], max: 1 }), ['沈砚'])
})

test("heroOf: 酷炫's figure is the player's side, never this round's foe", () => {
  const names = speakerNames({ char: '楚怀瑾', user: '你', roster: [{ id: 'p1', name: '主角', player: true }, { id: 'f1', name: '黑鹞子' }, { id: 'a1', name: '沈青' }] })
  const line = (speaker, plain = '「……」') => ({ type: 'line', kind: 'dialogue', speaker, plain })
  const steps = [line('楚怀瑾'), { type: 'line', kind: 'narration', plain: '夜风吹过城头。' }, line('沈青'), line('黑鹞子', '「拿命来！」')]
  const all = () => true
  const player = names.find(entry => entry.player).name
  // The player's own entry, when there is a picture of it, before anyone.
  assert.equal(heroOf(steps, 3, { names, foes: ['黑鹞子'], pictured: all }), player)
  const notPlayer = name => name !== player
  // The foe spoke last: the one of the player's side who spoke before.
  assert.equal(heroOf(steps, 3, { names, foes: ['黑鹞子'], pictured: notPlayer }), '沈青')
  // A foe by its full name in the bestiary is still that foe.
  assert.equal(heroOf(steps, 3, { names, foes: ['黑鹞子·左使'], pictured: notPlayer }), '沈青')
  // Not a foe this round: whoever spoke last.
  assert.equal(heroOf(steps, 3, { names, foes: [], pictured: notPlayer }), '黑鹞子')
  // Only who has a picture, up to the line on screen.
  assert.equal(heroOf(steps, 3, { names, foes: ['黑鹞子'], pictured: name => name === '楚怀瑾' }), '楚怀瑾')
  assert.equal(heroOf(steps, 1, { names, foes: ['黑鹞子'], pictured: notPlayer }), '楚怀瑾')
  // Nobody of their side in this reply: the one from before, unless a foe now; else nobody.
  const foeOnly = [line('黑鹞子')]
  assert.equal(heroOf(foeOnly, 0, { names, foes: ['黑鹞子'], pictured: notPlayer, before: '沈青' }), '沈青')
  assert.equal(heroOf(foeOnly, 0, { names, foes: ['黑鹞子'], pictured: notPlayer, before: '黑鹞子' }), null)
  assert.equal(heroOf(foeOnly, 0, { names, foes: ['黑鹞子'], pictured: notPlayer }), null)
  assert.equal(heroOf([], 0, { names: [], pictured: all }), null)
})
