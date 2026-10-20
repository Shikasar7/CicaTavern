// 视觉小说模式 (web/vn.js): a reply cut into the beats its text box shows one
// at a time, a guess at who says each, and the scene a place belongs to.
// Shared with the server (server/scenes.mjs matches places) and the tests, so
// it keeps to what the phone app's Node has: no \p{…}, Intl or normalize().
import { timeBoxOf } from './basic.js'

// Reasoning in its own tag (web/app.js folds it): not part of the story.
const FOLD_TAG = '[\\w~-]*(?:think|draft|reasoning)[\\w~-]*'
const FOLD_BLOCK = new RegExp(`<(${FOLD_TAG})>[\\s\\S]*?</\\1>`, 'gi')
const FOLD_OPEN = new RegExp(`<(${FOLD_TAG})>(?![\\s\\S]*</\\1>)[\\s\\S]*$`, 'i')

const TAG = /<(\/?)([A-Za-z][\w~:.-]*)([^<>]*)>/g
// Inline formatting web/app.js renderStory keeps; one open at a cut is closed and opened again.
const CARRIED = /^(b|strong|i|em|u|s|del|ins|sub|sup|mark|big|center|q|code|ruby|font|span)$/i
const QUOTE = /“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"/g
const SENTENCE_END = /[。！？!?…]+[”」』]?/g
const MASK = '\u0001'
// Before a quote: the speaker, then 说/道… (or a colon). Adverbs in between are not the name (缓缓说, 如实说, 追问).
// A doubled word is listed, not matched: 念念说 is a name.
const SAY_TAIL = /(?:轻声|低声|小声|大声|笑着|忍不住|如实|继续|重复|追|又|也|便|就|才|(?:缓缓|慢慢|轻轻|淡淡|冷冷|静静|悄悄|默默|喃喃|幽幽|懒懒|慢悠悠|懒洋洋|笑嘻嘻|笑眯眯)地?)?(?:说|道|问|答|喊|叫|笑道|问道|答道|喊道|叫道)(?:道)?[：:，,]?$/
const PRONOUN = /^(她|他|它|我|你|您|他们|她们|我们|你们|大家|对方)/
const SUBJECT = /^(你|她|他)(?![们])/
// Words a clause may open with before its subject (这时林青禾开口：).
const OPENER = /^(?:就在这时|这时候?|此时|忽然|突然|随即|然后|于是|接着)/
// What an unknown name is not made of: 笑得很短, 沉默片刻 or 缓缓 before a colon is narration.
const NOT_NAME = /.[了着得]|[地很太才却还便就把被像嘴话]|(.)\1|片刻|半晌|良久|一会|一下|一眼|一[行句声]|忽然|突然|随即|然后|于是|最后|最终|终于|随后|之后|起来|下来|过来|出来|回来|点头|摇头|抬头|低头|抬眼|转身|开口|沉默|眼睛|声音|心里|心中|内心|想法|默念|^第[一二三四五六七八九十\d]+[条根个件点步句]$/
// After a name: its voice or words (耳边白芷的声音还在响：, 回想白芷说过的话：) — the quote is theirs.
const VOICE = /^(?:的(?:声音|话|语气|嗓音|笑声)|说过的话|说的话)/
// Before a name: hearing them (他听见伊梦洁倒抽了一口气：) — the sound is theirs.
const HEARD = /(?:听见|听到)了?$/
// Unnamed people the story calls by their trade (掌柜的愣了一下): a name plate of their own.
const ROLE_WORDS = '掌柜 店小二 小二 伙计 老板娘:girl 老板 老头 老汉 大爷 大娘:girl 婆婆:girl 老妇人:girl 郎中 管家 侍卫 守卫 衙役 捕快 车夫 船夫 丫鬟:girl 侍女:girl 和尚' // i18n-ignore: words in the story
const ROLES = ROLE_WORDS.split(' ').map(word => {
  const [name, kind = 'boy'] = word.split(':')
  return { name, keys: [name], kind, role: true }
})
// After a quote: 王师兄笑道, 柏木绾追问, 林栖慢慢说 — but not 话没说完 or 这个问题.
const SAID_AFTER = /^([^\s，,。！？!?；;：:“”「」『』"]{2,4}?)(?:轻声|低声|小声|大声|笑着|如实|继续|重复|追|又|才|(?:缓缓|慢慢|轻轻|淡淡|冷冷|静静|悄悄|默默|喃喃|幽幽|懒懒|慢悠悠|懒洋洋|笑嘻嘻|笑眯眯)地?)?(?:说|道|问|答|喊|叫|笑道|问道|答道|喊道|叫道)(?!完|不出|出口|题)/
// An option the story offers (1️⃣ …), as the transcript draws them: the end buttons here.
const OPTION = /^\s*(?:<[^<>]+>\s*)*([1-9])️?⃣\s*(\S[\s\S]*)$/
const OPTION_LINE = /^\s*(?:<[^<>]+>\s*)*[1-9]️?⃣/m

export const withoutFolds = text => String(text ?? '').replace(FOLD_BLOCK, '').replace(FOLD_OPEN, '')

/** Text as read: no tags, no markdown stars. */
const plainOf = text => String(text ?? '').replace(TAG, '').replace(/\*/g, '').split(MASK).join('')

/** Tags hidden behind same-length marks, so quotes and sentence ends are found in the text only. */
const masked = text => text.replace(TAG, tag => MASK.repeat(tag.length))

/**
 * Lines that each render on their own: an inline tag still open at a line's end
 * is closed there and opened again at the start of the next.
 */
export function carryTags(lines) {
  let open = []
  return lines.map(line => {
    const prefix = open.map(o => o.tag).join('')
    const stack = [...open]
    for (const match of line.matchAll(TAG)) {
      const name = match[2].toLowerCase()
      if (!CARRIED.test(name)) continue
      if (match[1]) {
        const at = stack.map(o => o.name).lastIndexOf(name)
        if (at >= 0) stack.splice(at, 1)
      } else stack.push({ name, tag: match[0] })
    }
    open = stack
    return prefix + line + [...stack].reverse().map(o => `</${o.name}>`).join('')
  })
}

/**
 * The names a speaker can go by: the card's (a name like 林雪-异能抽奖系统-v1.1
 * is called 林雪; a three-character one also by its last two, 顾念念 → 念念,
 * unless the cast lists its aliases), the player's, the cast's with their
 * aliases. The cast's player entry is the player; a cast member with the
 * card's name is the card's character.
 * @returns {{ name: string, keys: string[], kind?: 'girl'|'boy'|'other', char?: true, player?: true, id?: string }[]}
 *   keys of two characters or more; the card's character first.
 */
export function speakerNames({ char = '', user = '', roster = [] } = {}) {
  const out = []
  const shortOf = full => full.split(/[-－·|｜_ ]/)[0].trim() || full
  const add = (name, aliases = [], extra = {}) => {
    const full = String(name ?? '').trim()
    if (!full) return
    const short = shortOf(full)
    const keys = [full, short, ...aliases.map(a => String(a ?? '').trim())].filter(key => key.length >= 2)
    const same = out.find(entry => entry.name === short || (extra.player && entry.player))
    if (same) {
      same.keys = [...new Set([...same.keys, ...keys])]
      for (const [key, value] of Object.entries(extra)) same[key] ??= value
    } else if (keys.length) out.push({ name: short, keys: [...new Set(keys)], ...extra })
  }
  const cast = Array.isArray(roster) ? roster.filter(entry => entry && (entry.name || entry.player)) : []
  const charName = shortOf(String(char ?? '').trim())
  const own = cast.find(entry => !entry.player && entry.name === charName)
  add(char, own || !/^[一-鿿]{3}$/.test(charName) ? [] : [charName.slice(1)], { char: true })
  add(user, [], { player: true })
  for (const entry of cast) {
    const aliases = String(entry.aliases ?? '').split(/[,，、/|]/)
    const extra = { ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.id ? { id: entry.id } : {}) }
    // The player entry answers to the chat's player name (its own name is often just 主角).
    if (entry.player) add(String(user ?? '').trim() || entry.name, [entry.name, ...aliases], { ...extra, player: true })
    else add(entry.name, aliases, extra)
  }
  return out
}

/** The known name whose key appears last (or first) in `text`. */
function knownIn(text, names, { last = true } = {}) {
  let best = null
  let at = last ? -1 : Infinity
  for (const entry of names) {
    for (const key of entry.keys) {
      const found = last ? text.lastIndexOf(key) : text.indexOf(key)
      if (found < 0) continue
      if (last ? found + key.length > at : found < at) {
        at = last ? found + key.length : found
        best = entry.name
      }
    }
  }
  return best
}

/** A name nobody listed (老板娘, 王师兄): short, and none of narration's words. */
const nameLike = text => text.length >= 2 && text.length <= 4 && /^[一-鿿·A-Za-z]+$/.test(text) && !PRONOUN.test(text) && !/[你我她他它们]/.test(text) && !NOT_NAME.test(text)

/**
 * Who a sentence's clauses are about, the nearest first: one opening with a
 * pronoun ({ pronoun }) or a known name ({ name }), or holding someone's voice
 * (the nearest one also someone heard); null when none does.
 * 她刷了一会儿，忽然抬眼看你，嘴角翘起来 is about 她; 她看向林青禾，林青禾笑着 about 林青禾.
 */
function clauseSubject(sentence, names) {
  const clauses = sentence.split(/[，,]/).filter(Boolean).reverse()
  for (const [i, clause] of clauses.entries()) {
    const body = clause.replace(OPENER, '')
    const heard = names.find(entry => entry.keys.some(key => {
      const at = body.indexOf(key)
      return at >= 0 && (VOICE.test(body.slice(at + key.length)) || (i === 0 && HEARD.test(body.slice(0, at))))
    }))
    if (heard) return { name: heard.name }
    const pronoun = PRONOUN.exec(body)?.[1]
    if (pronoun) return { pronoun }
    const named = names.find(entry => entry.keys.some(key => body.startsWith(key)))
    if (named) return { name: named.name }
  }
  return null
}

/**
 * Who says a quote, from the text right before it and right after it; null
 * when it cannot be told (no name plate rather than a wrong one).
 */
export function guessSpeaker(before, after, names) {
  const lead = plainOf(before).replace(/\s+/g, '')
  // The sentence the quote follows; its subject comes first.
  const sentence = text => text.split(/[。！？!?；;]/).filter(Boolean).pop() ?? ''
  const said = SAY_TAIL.exec(lead)
  if (said || /[：:]$/.test(lead)) {
    // 林青禾放下茶杯，轻声说：「…」 / 她抬眼看你，嘴角翘起来：「…」 — whoever the nearest clause is about; a pronoun is told later.
    const words = sentence(said ? lead.slice(0, said.index) : lead.slice(0, -1)).replace(/[，,]$/, '')
    const subject = clauseSubject(words, names)
    if (subject) return subject.name ?? null
    // 一旁的林青禾笑着说 / 师父说的话还在耳边响 — no name opens a clause, but one is there.
    const known = knownIn(words, names, { last: false })
    if (known) return known
    // An unknown name works when it is all there is before the verb or the colon (老板娘笑着说：/ 老板娘：).
    return nameLike(words) ? words : null
  }
  // 林青禾看了沈梨一眼。「…」 — the one the sentence before is about.
  const previous = sentence(lead)
  const subject = clauseSubject(previous, names)
  const near = subject ? subject.name : knownIn(previous, names, { last: false })
  if (near) return near
  // 「…」林青禾笑道。 An unknown name works when the verb follows it at once (「…」王师兄笑道。).
  const tail = plainOf(after).replace(/\s+/g, '').replace(/^[，,]/, '').split(/[。！？!?]/)[0].slice(0, 12)
  if (PRONOUN.test(tail)) return null
  const known = knownIn(tail, names, { last: false })
  if (known) return known
  const unknown = SAID_AFTER.exec(tail)
  return unknown && nameLike(unknown[1]) ? unknown[1] : null
}

/**
 * The pronoun a quote is said by (你, 她, 他): the subject of the nearest clause
 * leading into it that has one (过了片刻，她忽然笑了，笑得很短：), else of the sentence after.
 */
export function pronounNear(before, after) {
  const lead = plainOf(before).replace(/\s+/g, '').split(/[。！？!?；;]/).filter(Boolean).pop() ?? ''
  const tail = plainOf(after).replace(/\s+/g, '').replace(/^[，,]/, '').split(/[。！？!?]/)[0]
  const clauses = lead.split(/[，,]/).filter(Boolean).reverse()
  return clauses.map(clause => SUBJECT.exec(clause.replace(OPENER, ''))?.[1]).find(Boolean) ?? SUBJECT.exec(tail)?.[1] ?? null
}

/**
 * Who a pronoun means: 你 the player; 她/他 the cast member of that kind named
 * last, else the card's character when it could be (a one-character card
 * calls its heroine 她 for whole replies).
 */
function byPronoun(pronoun, names, recent) {
  if (pronoun === '你') return names.find(entry => entry.player)?.name ?? null // i18n-ignore: a pronoun in the story
  const kind = pronoun === '她' ? 'girl' : 'boy' // i18n-ignore: a pronoun in the story
  if (recent[kind]) return recent[kind]
  const char = names.find(entry => entry.char)
  return char && (!char.kind || char.kind === kind) ? char.name : null
}

/**
 * A quote alone on its line. The line before it is about the one who speaks
 * (她停在你面前。 / 师妹乖巧地点头。 / 殿里传来师父的声音。 / 掌柜的愣了一下。);
 * one about 你 is the player listening (你摇头。), unless it names someone
 * else (你还没回答，殿里传来师父的声音。). Else the line after it, when it
 * starts with 她/他 (她跑远了。); a 你 there is the player answering.
 */
function fromNeighbours(previous, next, names, recent) {
  const clean = row => plainOf(row ?? '').replace(/\s+/g, '')
  const before = clean(previous).split(/[。！？!?]/).filter(Boolean).pop() ?? ''
  if (before && !/[”」』"]$/.test(before)) {
    const subject = SUBJECT.exec(before)?.[1]
    if (subject && subject !== '你') return byPronoun(subject, names, recent) // i18n-ignore: a pronoun
    const lead = names.find(entry => !entry.player && entry.keys.some(key => before.startsWith(key)))
    if (lead) return lead.name
    const known = knownIn(before, names.filter(entry => !entry.player), { last: false })
    if (known) return known
    // 你和她一前一后走着，她走在前面 — the other one in the sentence.
    const other = /[，,](她|他)/.exec(before)?.[1]
    if (other) return byPronoun(other, names, recent)
  }
  const following = clean(next).split(/[。！？!?]/)[0] ?? ''
  if (following && !/^[“「『"]/.test(following)) {
    const pronoun = SUBJECT.exec(following)?.[1]
    if (pronoun && pronoun !== '你') return byPronoun(pronoun, names, recent) // i18n-ignore: a pronoun
  }
  return null
}

/** The cast named in narration (not inside quotes), in order: the last of each kind is who 她/他 means. */
function noteNamed(text, names, recent) {
  const prose = masked(String(text ?? '')).replace(QUOTE, '')
  const found = []
  for (const entry of names) {
    if (entry.player) continue
    for (const key of entry.keys) {
      const at = prose.lastIndexOf(key)
      if (at >= 0) found.push({ at: at + key.length, entry })
    }
  }
  for (const { entry } of found.sort((a, b) => a.at - b.at)) {
    if (entry.kind !== 'boy') recent.girl = entry.name
    if (entry.kind !== 'girl') recent.boy = entry.name
  }
}

/**
 * A line that names the speaker of the next one. Only a name (林青禾, **林青禾**,
 * 老板娘：) is dropped as a step; a line like 林青禾推开门： stays and still names it.
 */
function labelOf(row, names) {
  const plain = plainOf(row).trim().replace(/^\*+|\*+$/g, '')
  const colon = /[：:]$/.test(plain)
  const body = plain.replace(/[：:]$/, '')
  if (!body || body.length > 12 || /[“”「」『』"。！？!?]/.test(body)) return null
  const exact = names.find(entry => entry.keys.includes(body))
  if (exact) return { name: exact.name, drop: true }
  if (!colon) return null
  if (nameLike(body)) return { name: body, drop: true }
  const known = knownIn(body, names, { last: false })
  return known ? { name: known, drop: false } : null
}

/** Narration cut at sentence ends into pieces of about `max` characters; one longer sentence stays whole. */
function packNarration(text, max) {
  const hidden = masked(text)
  const cuts = [...hidden.matchAll(SENTENCE_END)].map(m => m.index + m[0].length)
  const pieces = []
  let start = 0
  let end = 0
  for (const cut of [...cuts, text.length]) {
    if (cut <= end) continue
    if (end > start && plainOf(text.slice(start, cut)).length > max) {
      pieces.push(text.slice(start, end))
      start = end
    }
    end = cut
  }
  if (end > start) pieces.push(text.slice(start, end))
  return pieces.filter(piece => plainOf(piece).trim())
}

/** A quote that cites a word or two (「惊喜」两个字) rather than says something: short, no punctuation. */
const cited = quote => {
  const inner = plainOf(quote.slice(1, -1)).trim()
  return inner.length <= 6 && !/[。！？!?…~～，,、；;：:—-]/.test(inner)
}

/** The beats of one source line: quotes with the narration that leads into them, narration on its own. */
function beatsOf(row, max) {
  const hidden = masked(row)
  const quotes = [...hidden.matchAll(QUOTE)].filter(quote => !cited(quote[0]))
  if (!quotes.length) return packNarration(row, max).map(text => ({ kind: 'narration', text }))
  const out = []
  let start = 0
  quotes.forEach((quote, i) => {
    let lead = start
    const before = hidden.slice(start, quote.index)
    // A long lead-in goes first as narration; its last clause stays with the quote.
    if (plainOf(before).length > 40) {
      const ends = [...before.matchAll(SENTENCE_END)].map(m => m.index + m[0].length).filter(n => n < before.length)
      const cut = ends.at(-1)
      if (cut) {
        for (const text of packNarration(row.slice(start, start + cut), max)) out.push({ kind: 'narration', text })
        lead = start + cut
      }
    }
    let end = quote.index + quote[0].length
    // What follows the last quote stays with it when short (「…」她笑了笑。).
    if (i === quotes.length - 1 && plainOf(hidden.slice(end)).length <= 30) end = row.length
    out.push({ kind: 'dialogue', text: row.slice(lead, end), before: row.slice(lead, quote.index), after: row.slice(quote.index + quote[0].length, i === quotes.length - 1 ? row.length : quotes[i + 1].index) })
    start = end
  })
  if (start < row.length) for (const text of packNarration(row.slice(start), max)) out.push({ kind: 'narration', text })
  return out
}

/**
 * A <small> block holding the story's options (1️⃣ …) keeps only them: its
 * prompt and tips are about the game, not the story.
 */
const onlyOptions = body => (OPTION_LINE.test(body) ? body.split('\n').filter(line => OPTION.test(line)).join('\n') : null)
const withOptionsOnly = text => text
  .replace(/<small>([\s\S]*?)<\/small>/gi, (block, body) => onlyOptions(body) ?? block)
  .replace(/<small>((?:(?!<\/?small>)[\s\S])*)$/i, (block, body) => onlyOptions(body) ?? block)

/**
 * A reply's story text → the beats the text box shows one at a time.
 * Kept markup in `text` (each beat renders on its own), `plain` for lengths
 * and the backlog, `speaker` when it can be told. The story's options (1️⃣ …)
 * come as kind 'option', `plain` their text. A header line (日期 · 时辰 · 地点),
 * at the top or where the story moves on halfway, comes as kind 'scene' with
 * `where` ({ time, place, weather }); a rule between scenes (---) goes.
 * @param names - speakerNames().
 * @param partial - the reply is still coming in (its last line may be cut short).
 * @returns {{ kind: 'narration'|'dialogue'|'option'|'scene', text: string, plain: string, speaker: string|null, where?: object }[]}
 */
export function splitLines(text, { names = [], max = 90, partial = false } = {}) {
  const source = withOptionsOnly(withoutFolds(text).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ''))
  const rows = []
  for (const paragraph of source.split(/\n{2,}/)) {
    // A line holding only formatting tags joins the next (as renderStory does).
    let carry = ''
    for (const raw of paragraph.split('\n')) {
      if (!plainOf(raw).trim()) carry += raw.trim()
      else {
        rows.push(carry + raw.trim())
        carry = ''
      }
    }
    if (carry && rows.length) rows[rows.length - 1] += carry
  }
  const beats = []
  const recent = {}
  let label = null
  let lastSpeaker = null
  const own = names
  names = [...own, ...ROLES.filter(role => !own.some(entry => entry.keys.includes(role.name)))]
  const player = own.find(entry => entry.player)
  rows.forEach((row, i) => {
    const unfinished = partial && i === rows.length - 1
    // A rule between scenes.
    if (/^[-—–*＊=_~·\s]{3,}$/.test(plainOf(row).trim())) return
    // A header line (日期 · 时辰 · 地点): the sign and the background, not a line to read.
    const where = unfinished ? null : headerPlace(row)
    if (where) {
      beats.push({ kind: 'scene', text: '', speaker: null, where })
      return
    }
    const option = OPTION.exec(row)
    if (option) {
      // One still being written is not an option yet.
      if (!(partial && i === rows.length - 1)) beats.push({ kind: 'option', text: option[2].trim(), speaker: null })
      return
    }
    // The last line of a reply still coming in may not be finished: never a name line yet.
    const named = partial && i === rows.length - 1 ? null : labelOf(row, names)
    if (named?.drop) {
      label = named.name
      return
    }
    let rowSpeaker = null
    for (const beat of beatsOf(row, max)) {
      let speaker = null
      if (beat.kind === 'dialogue') {
        noteNamed(beat.before, names, recent)
        const pronoun = pronounNear(beat.before, beat.after)
        speaker = guessSpeaker(beat.before, beat.after, names) ?? label ?? (pronoun ? byPronoun(pronoun, names, recent) : null) ?? rowSpeaker
        // Nothing around it on its line: the lines either side.
        const bare = !plainOf(beat.before).trim() && !plainOf(beat.after).replace(/[\s~～…。！？!?，,]/g, '')
        if (!speaker && bare) speaker = fromNeighbours(rows[i - 1], rows[i + 1], names, recent)
        // 「师兄，渴不渴？」 is said to the player, not by them.
        const quoted = plainOf(beat.text.slice(beat.before.length, beat.text.length - beat.after.length))
        if (player && speaker === player.name && player.keys.some(key => quoted.includes(key))) speaker = null
        // Nothing says who: whoever spoke last (not the player, whose lines are written as such), else the card's
        // own. A line led in by 说 that still cannot be told (等你说「是。」) keeps no name.
        if (!speaker && !pronoun && !SAY_TAIL.test(plainOf(beat.before).replace(/\s+/g, ''))) speaker = lastSpeaker ?? names.find(entry => entry.char)?.name ?? null
        rowSpeaker = speaker
        if (speaker && !names.find(entry => entry.name === speaker)?.player) lastSpeaker = speaker
        const who = names.find(entry => entry.name === speaker)
        if (who && !who.player) noteNamed(who.keys[0], [who], recent)
        noteNamed(beat.after, names, recent)
      } else noteNamed(beat.text, names, recent)
      beats.push({ kind: beat.kind, text: beat.text, speaker })
    }
    label = named?.name ?? null
  })
  const texts = carryTags(beats.map(beat => beat.text))
  return beats.map((beat, i) => ({ kind: beat.kind, text: texts[i], plain: plainOf(beat.text).trim(), speaker: beat.speaker, ...(beat.where ? { where: beat.where } : {}) }))
}

// ─── Scenes ──────────────────────────────────────────────────────────────

/** A place name as compared: full-width letters half-width, no spaces or punctuation, ASCII lower-case. */
export function normalizePlace(text) {
  return String(text ?? '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s·・•、，,。.:：;；!！?？'"“”‘’「」『』()（）[\]【】<>《》\-—–_~～|｜/]+/g, '')
}

export const placeKeys = scene => [scene?.name, ...(Array.isArray(scene?.aliases) ? scene.aliases : [])].map(normalizePlace).filter(Boolean)

/**
 * The scene a place belongs to: the same name or alias; else one containing
 * the other, the shorter at least two characters and half the longer
 * (茶馆二楼 ↔ 旧城茶馆二楼, but not 茶馆 ↔ 旧城茶馆二楼, nor 城东… ↔ 城西…).
 * The longest key wins, then the scene changed last.
 */
export function matchScene(place, scenes) {
  const want = normalizePlace(place)
  if (!want || !Array.isArray(scenes)) return null
  // Several the same (a place given to a scene by「用在这里」): the one changed last.
  const exact = scenes.filter(scene => placeKeys(scene).includes(want)).sort((a, b) => String(b.updatedAt ?? b.at ?? '').localeCompare(String(a.updatedAt ?? a.at ?? '')))[0]
  if (exact) return exact
  let best = null
  let bestKey = 0
  let bestAt = ''
  for (const scene of scenes) {
    for (const key of placeKeys(scene)) {
      const [short, long] = key.length <= want.length ? [key, want] : [want, key]
      if (short.length < 2 || !long.includes(short) || short.length * 2 < long.length) continue
      const at = String(scene.updatedAt ?? scene.at ?? '')
      if (key.length > bestKey || (key.length === bestKey && at > bestAt)) {
        best = scene
        bestKey = key.length
        bestAt = at
      }
    }
  }
  return best
}

/** A time box's parts → its time, place and weather (the weather may be missing). */
export function placeOf(parts) {
  const list = Array.isArray(parts) ? parts : []
  return { time: list[0] ?? '', place: list[1] ?? '', weather: list.slice(2).join(' ') }
}

const DATE_PART = /(?:\d+|[一二三四五六七八九十廿卅百千零〇两]+)\s*[年月日号]|周[一二三四五六日天]|星期|礼拜/
const TIME_PART = /\d{1,2}\s*[:：]\s*\d{2}|[子丑寅卯辰巳午未申酉戌亥]时|(?:\d{1,2}|[一二两三四五六七八九十]+)\s*[点時]|凌晨|清晨|早上|早晨|上午|中午|正午|午后|下午|傍晚|黄昏|晚上|夜里|深夜|午夜|半夜|拂晓|黎明|\b[ap]\.?m\b/i
const PART_SPLIT = /\s+[·•・|｜/／]\s+|\s*[｜|]\s*|\s{2,}/
const LABELLED = {
  place: /(?:当前)?(?:地点|位置|所在地|场景|地址)\s*[:：]\s*([^|｜\n，,。；;]{1,40})/,
  time: /(?:当前)?(?:时间|时刻)\s*[:：]\s*([^|｜\n，,。；;]{1,40})/,
  weather: /天气\s*[:：]\s*([^|｜\n，,。；;]{1,20})/,
}
const WRAP = /^[\s「『【[(（<《*_#>~-]+|[\s」』】\])）>》*_~-]+$/g

/**
 * A header line a card writes at the top of each reply instead of a time box:
 * 「永和十七年八月十五 · 亥时 21:40 · 武当山·后山剑池」, or labelled
 * (时间：… ｜ 地点：…). Only the first few lines are looked at, and a line
 * needs a date or time beside the place. → { time, place, weather } or null.
 */
export function headerPlace(text) {
  const lines = String(text ?? '').split('\n').map(line => plainOf(line).trim()).filter(Boolean).slice(0, 3)
  for (const line of lines) {
    if (line.length > 80) continue
    const label = key => LABELLED[key].exec(line)?.[1]?.replace(WRAP, '').trim() ?? ''
    if (label('place')) return { time: label('time'), place: label('place'), weather: label('weather') }
    const parts = line.replace(WRAP, '').split(PART_SPLIT).map(part => part.replace(WRAP, '').replace(/^[^\w一-鿿]+/, '').trim()).filter(Boolean)
    if (parts.length < 2) continue
    const when = parts.filter(part => DATE_PART.test(part) || TIME_PART.test(part))
    if (!when.length) continue
    const rest = parts.filter(part => !when.includes(part))
    const weather = rest.filter(part => part.length <= 4 && weatherOf(part))
    const place = rest.find(part => !weather.includes(part) && part.length <= 30) ?? (rest.length > 1 ? rest[0] : '')
    if (place) return { time: when.join(' '), place, weather: weather.filter(part => part !== place).join(' ') }
  }
  return null
}

const STATE_KEYS = {
  place: /^(?:当前)?(?:地点|位置|所在地|所在位置|场景|地址|location|place)$/i,
  time: /^(?:当前)?(?:时间|时刻)$/i,
  weather: /^(?:当前)?(?:天气|weather)$/i,
}

/** A string under a key like 当前地点 or 位置 in a chat's variables (系统.当前地点), nearest the top first. */
function stateValue(state, key) {
  const pattern = STATE_KEYS[key]
  let level = [state]
  for (let depth = 0; depth < 3 && level.length; depth++) {
    // 当前地点 before a plain 位置 (often a character's) at the same depth.
    for (const strict of [true, false]) {
      for (const object of level) {
        for (const [name, value] of Object.entries(object)) {
          if (typeof value === 'string' && value.trim() && value.length <= 40 && pattern.test(name) && (!strict || name.startsWith('当前'))) return value.trim() // i18n-ignore: a variable name
        }
      }
    }
    level = level.flatMap(object => Object.values(object).filter(value => value && typeof value === 'object' && !Array.isArray(value)))
  }
  return ''
}

/** Where a reply says the story is: its time box, else a header line. → { time, place, weather } or null. */
export function placeIn(text) {
  const box = placeOf(timeBoxOf(text))
  return box.place ? box : headerPlace(String(text ?? '').replace(/<[^<>]*\/>/g, ''))
}

/**
 * The newest reply on a chat path that says where the story is: { nodeId,
 * time, place, weather } or null. A reply's own text first (time box, header
 * line), then the variables it left (系统.当前地点).
 */
export function latestPlace(path, { rawOf = node => node.raw ?? node.text, stateOf = node => node.state } = {}) {
  for (let i = (path?.length ?? 0) - 1; i >= 0; i--) {
    const node = path[i]
    if (node.role !== 'assistant') continue
    const where = placeIn(rawOf(node))
    if (where?.place) return { nodeId: node.id, ...where }
    const state = stateOf(node)
    const place = state && typeof state === 'object' ? stateValue(state, 'place') : ''
    if (place) return { nodeId: node.id, time: stateValue(state, 'time'), place, weather: stateValue(state, 'weather') }
  }
  return null
}

const NUMERALS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 } // i18n-ignore: clock words

/** 'dawn' | 'day' | 'dusk' | 'night' from a time box's time, or null. Words first, then the clock. */
export function timeOfDay(text) {
  const s = String(text ?? '')
  if (/凌晨|深夜|半夜|午夜|子时|丑时|入夜|夜里|夜晚|晚上|夜/.test(s)) return 'night'
  if (/傍晚|黄昏|日落|薄暮|夕阳|日暮/.test(s)) return 'dusk'
  if (/黎明|拂晓|破晓|清晨|天亮/.test(s)) return 'dawn'
  if (/早上|早晨|上午|中午|正午|午后|下午|白天|白日|晌午/.test(s)) return 'day'
  const clock = /(\d{1,2})\s*[:：点时]/.exec(s) ?? /(十[一二]?|[一二两三四五六七八九])\s*[点时]/.exec(s)
  if (!clock) return null
  let hour = /\d/.test(clock[1]) ? Number(clock[1]) : NUMERALS[clock[1]]
  if (/pm|p\.m\./i.test(s) && hour < 12) hour += 12
  if (hour >= 5 && hour <= 6) return 'dawn'
  if (hour >= 7 && hour <= 16) return 'day'
  if (hour >= 17 && hour <= 19) return 'dusk'
  return 'night'
}

/** 'storm' | 'rain' | 'snow' | 'fog' | 'cloudy' | 'clear' from a time box's weather, or null. */
export function weatherOf(text) {
  const s = String(text ?? '')
  if (/雷|暴雨/.test(s)) return 'storm'
  if (/雨/.test(s)) return 'rain'
  if (/雪/.test(s)) return 'snow'
  if (/雾|霾/.test(s)) return 'fog'
  if (/阴|云/.test(s)) return 'cloudy'
  if (/晴/.test(s)) return 'clear'
  return null
}
