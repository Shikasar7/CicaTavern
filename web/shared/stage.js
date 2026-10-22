// The visual novel stage, line by line (web/vn.js): who stands there, with which
// expression, and what the picture does (shake, flash, a hop). Read from the
// story text only; the model is never asked for any of it. Pure functions, so
// Node can test them; no \p{} or Intl (the phone's Node has no ICU).

/** The expressions a 立绘 can have; neutral is the 立绘 itself. */
export const EXPRESSIONS = ['neutral', 'smile', 'happy', 'shy', 'angry', 'sad', 'surprised', 'thinking']

/**
 * How each expression is drawn (server/media.mjs drawExpression): tags for
 * tag-style prompts, words for sentence-style ones.
 */
export const EXPRESSION_LOOK = {
  smile: { tags: 'gentle smile, closed mouth smile', words: 'a gentle, warm closed-mouth smile' },
  happy: { tags: 'happy, open mouth smile, :d, sparkling eyes', words: 'a big, happy open-mouthed smile with bright eyes' },
  shy: { tags: 'blush, embarrassed, shy smile, looking away slightly', words: 'a shy, embarrassed look with blushing cheeks' },
  angry: { tags: 'angry, frown, furrowed brow, glaring', words: 'an angry frown with furrowed brows' },
  sad: { tags: 'sad, teary eyes, frown, downcast eyes', words: 'a sad look with teary, downcast eyes' },
  surprised: { tags: 'surprised, wide eyes, open mouth', words: 'a surprised look, eyes wide and mouth slightly open' },
  thinking: { tags: 'thinking, pensive, looking up, closed mouth', words: 'a thoughtful, pensive look, eyes glancing up' },
}

// What the narration around a line says about a face, strongest first.
const LOOKS = [
  ['angry', /怒|生气|恼火|恼怒|瞪了|瞪着|狠狠|皱眉|皱起眉|眉头紧锁|咬牙|冷哼|不悦|火大|气得|没好气|\bglare|\bscowl|\bfrown|\bangr/i],
  ['sad', /哭|泪|哽咽|难过|伤心|黯然|低落|委屈|眼眶.{0,3}红|鼻子一酸|叹了口气|\bcr(?:y|ies|ied)\b|\btears?\b|\bsob|\bsigh/i],
  ['shy', /脸红|红了脸|脸.{0,3}红了|脸颊.{0,4}红|耳根.{0,4}红|羞|害臊|不好意思|\bblush/i],
  ['surprised', /吃惊|惊讶|惊呼|一惊|大惊|愣住|愣了|吓了一跳|吓得|瞪大|睁大|怔住|怔了|诧异|错愕|目瞪口呆|\bgasp|\bstartled|\bsurprised|\bwide-eyed/i],
  ['happy', /大笑|哈哈|笑出声|开心|高兴|欢呼|兴奋|雀跃|眉开眼笑|笑得.{0,4}(?:灿烂|开心)|\blaugh|\bbeam(?:s|ed|ing)?\b|\bgrin/i],
  ['smile', /微笑|浅笑|轻笑|笑了|莞尔|抿嘴|笑着|笑意|笑道|一笑|弯了弯|\bsmil/i],
  ['thinking', /思索|沉思|想了想|若有所思|歪头|歪了歪头|托腮|沉吟|琢磨|犹豫|\bponder|\bthought?ful|\bhesitat/i],
]

// What the voice itself says, when the narration says nothing.
const VOICES = [
  ['happy', /哈哈|嘿嘿|\bhaha/i],
  ['sad', /呜呜|呜……/],
  ['surprised', /[？?][！!]|[！!][？?]|^[^\n]{0,4}[诶欸咦哎啊][？?！!]/],
]

// Speech in the line, so the narration around it can be read alone.
const QUOTED = /「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|"[^"\n]*"/g

/** The narration of a line (the quotes taken out) and its quotes. */
function partsOf(text) {
  const plain = String(text ?? '')
  return { narration: plain.replace(QUOTED, ' '), speech: (plain.match(QUOTED) ?? []).join(' ') }
}

/** The expression a line's narration (else its voice) points to, or null. */
export function guessExpression(text) {
  const { narration, speech } = partsOf(text)
  for (const [name, pattern] of LOOKS) if (pattern.test(narration)) return name
  for (const [name, pattern] of VOICES) if (pattern.test(speech.replace(/[「」『』“”"]/g, '').trim())) return name
  return null
}

// What the picture does: only plain, unmistakable words (better to miss one than to shake at the wrong time).
const SCREEN = [
  ['flash', /闪电|雷鸣|惊雷|电光|白光一闪|刺眼的光|一道光|\blightning\b|\bflash of light/i],
  ['shake', /轰隆|轰然|巨响|爆炸|炸开|一拳|拍桌|猛地.{0,4}(?:拍|砸|撞)|砸在|撞在|地面.{0,4}(?:震|晃)|震动|剧烈.{0,2}摇晃|\bexplo|\bcrash|\bslam|\bboom\b/i],
]
const ACTOR = [
  ['tremble', /发抖|颤抖|哆嗦|瑟瑟|打颤|\btrembl|\bshiver|\bshak(?:e|es|ing) with/i],
  ['jump', /吓了一跳|跳了起来|蹦了起来|一蹦|猛地站起|\bjump(?:s|ed)? up|\bstartled/i],
]

/** { screen: 'flash'|'shake'|null, actor: 'tremble'|'jump'|null } for a line, from its narration. */
export function effectsOf(text) {
  const { narration } = partsOf(text)
  const find = list => list.find(([, pattern]) => pattern.test(narration))?.[0] ?? null
  return { screen: find(SCREEN), actor: find(ACTOR) }
}

const LEAVES = '(?:离开|走了出去|走出|离去|退下|告辞|转身走了|消失在|\\bleaves?\\b|\\bleft\\b|\\bwalks? out)' // i18n-ignore: words that move people off stage
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// After this many lines without a word, someone steps off.
const QUIET = 12

/**
 * Who stands on the stage at line `index` of a reply, from its start: each
 * speaker steps on when they first speak (the stage holds `max`: the one quiet
 * longest makes room), keeps the expression their lines last showed, and steps
 * off when the narration has them leave, after a long silence, or when the
 * place changes.
 * @param steps - the reply's steps (web/vn.js stepsOf): { type, kind, speaker, plain, where }.
 * @param options.names - speakerNames(): name, keys (aliases), player.
 * @param options.max - how many may stand at once.
 * @param options.isActor - (name) → whether this one can stand there (not the player, has a picture).
 * @param options.labels - an expression per step from the helper model (用辅助模型判断表情), used before the narration's.
 * @returns {{ members: { name: string, expression: string }[], speaker: string|null, effects: object }}
 */
export function stageAt(steps, index, { names = [], max = 3, isActor = () => true, labels = null } = {}) {
  let members = []
  let place = null
  const keysOf = name => names.find(entry => entry.name === name)?.keys ?? [name]
  const last = Math.min(index, (steps?.length ?? 0) - 1)
  for (let i = 0; i <= last; i++) {
    const step = steps[i]
    if (step?.type !== 'line') continue
    if (step.where?.place && place && step.where.place !== place) members = []
    if (step.where?.place) place = step.where.place
    const plain = step.plain ?? ''
    members = members.filter(member => {
      if (i - member.last > QUIET) return false
      if (step.kind === 'dialogue' && step.speaker === member.name) return true
      return !keysOf(member.name).some(key => new RegExp(`${escape(key)}[^。！？.!?\\n]{0,10}${LEAVES}`, 'i').test(plain)) // i18n-ignore: a pattern
    })
    const speaker = step.kind === 'dialogue' && step.speaker && isActor(step.speaker) ? step.speaker : null
    if (!speaker) continue
    let member = members.find(item => item.name === speaker)
    if (!member) {
      if (members.length >= max) {
        const quietest = members.reduce((a, b) => (b.last < a.last ? b : a))
        members = members.filter(item => item !== quietest)
      }
      member = { name: speaker, expression: 'neutral', last: i }
      members.push(member)
    }
    member.last = i
    const labelled = labels?.[i]
    const expression = EXPRESSIONS.includes(labelled) ? labelled : guessExpression(plain)
    if (expression) member.expression = expression
  }
  const step = steps?.[last]
  const speaker = step?.type === 'line' && step.kind === 'dialogue' && members.some(member => member.name === step.speaker) ? step.speaker : null
  return {
    members: members.map(({ name, expression }) => ({ name, expression })),
    speaker,
    effects: step?.type === 'line' ? effectsOf(step.plain) : { screen: null, actor: null },
  }
}

// ─── 用辅助模型判断表情 (server/media.mjs labelExpressions) ─────────────────

/**
 * The helper's request: the reply's spoken lines, numbered by step, each to be
 * given the speaker's expression. `lines` has a { speaker, text } or null per step.
 */
export function expressionRequest(lines) {
  const numbered = lines
    .map((line, i) => (line ? `${i}. ${String(line.speaker).slice(0, 20)}: ${String(line.text).replace(/\s+/g, ' ').slice(0, 240)}` : null))
    .filter(Boolean)
    .slice(0, 120)
  return {
    system: 'You read a story passage and label the facial expression of the speaker of each line. You reply with the labels only.',
    messages: [{
      role: 'user',
      content: [
        numbered.join('\n'),
        '',
        `For each numbered line, the speaker's facial expression while saying it, one of: ${EXPRESSIONS.join(', ')}.`,
        'Reply with one line per numbered line, exactly like "3: smile", nothing else.',
      ].join('\n'),
    }],
    maxTokens: 1200,
  }
}

/** The helper's answer → an expression (or null) per step, `count` long. */
export function parseExpressionLabels(text, count) {
  const labels = new Array(count).fill(null)
  for (const match of String(text ?? '').matchAll(/^\s*(\d+)\s*[:.：)-]\s*([a-z]+)/gim)) {
    const index = Number(match[1])
    const name = match[2].toLowerCase()
    if (index < count && EXPRESSIONS.includes(name)) labels[index] = name
  }
  return labels
}
