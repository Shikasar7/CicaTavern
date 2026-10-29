// 视觉小说模式 (web/vn.js): a reply cut into the beats its text box shows one
// at a time, a guess at who says each, and the scene a place belongs to.
// Shared with the server (server/scenes.mjs matches places) and the tests, so
// it keeps to what the phone app's Node has: no \p{…}, Intl or normalize().
import { timeBoxOf } from './basic.js'
import { EFFECT_KINDS, faceOf, markEffects } from './stage.js'

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
// Before a name: hearing them (他听见伊梦洁倒抽了一口气：) — the sound is theirs; so with 她/他 (他听见她说：).
const HEARD = /(?:听见|听到)了?$/
const HEARD_PRONOUN = /(?:听见|听到)了?([她他])(?![们])/
// After a name, on the line after a quote: saying or answering it (白芷接得很快。, 顾念念在你身后喊了一声, 清虚子打断他。) — the quote is theirs.
const REPLIED = /^[^，,听让等]{0,6}?(?<![没不未])(?:说|问|喊|叫|打断|接(?:话|道|口|得|了一句)|答(?:道|话|得|了)|回(?:答|道|嘴|得|了一句)|应(?:道|声|了一声))(?!不出|出口|题|起)/
// The line after a quote saying who said it: 你说。, 他低声说，… — not 你说没有 or 你又说了一遍, which answer it.
const PRONOUN_SAID = /^(你|她|他)(?![们])(?:轻声|低声|小声|大声|笑着|如实|继续|才)?(?:说|道|问|答|喊|叫)(?:道)?(?=$|[，,：:])/
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
// A memory (回忆滤镜): a paragraph opening on long ago, or drifting back to it; it lasts a few paragraphs, until the story comes back.
const LONG_AGO = '(?:那年|那一年|那天|那时|那个(?:冬天|夏天|春天|秋天|夜晚|雨夜|下午)|小时候|年少时|少年时|当年|从前|过去|多年前|很多年前|许多年前|很久以前|[一二两三四五六七八九十几数\\d]+年前)' // i18n-ignore: words for long ago
const MEMORY_START = new RegExp(`^[\\s*_#>【\\[(（…—-]*(?:那年|那一年|多年前|很多年前|许多年前|很久以前|小时候|年少时|当年[，,]|[一二两三四五六七八九十几数\\d]+年前[，,的])|(?:回想起|回忆起|忆起|想起了?|思绪.{0,6}(?:飘回|飘远|飘向|回到)|记忆.{0,6}(?:回到|拉回到?|闪回|涌回)|仿佛又?回到了?).{0,10}${LONG_AGO}|^\\W*(?:years ago|back then|long ago),|\\bremembered (?:the (?:day|night|summer|winter)|when)\\b`, 'i') // i18n-ignore: words for a memory
const MEMORY_END = /回过神|缓过神|思绪.{0,6}(?:拉回|收回|回到现实|回到眼前|回到当下)|回到现实|回到当下|从(?:回忆|记忆)(?:里|中)|^[\s*_#>【[(（]*(?:如今|而今|此刻|现在)[，,]|\bback to the present\b|\bsnapped (?:out|back)\b/i // i18n-ignore: words leaving a memory
// How many paragraphs a memory may last after the one that opens it.
const MEMORY_ROWS = 3
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
 * card's name is the card's character. A name written family name first with a
 * space (宫凪 枫) is also called by its given name, and two cast members of one
 * family (宫凪, 宫凪 樱) stay two people.
 * @returns {{ name: string, keys: string[], marks?: string[], kind?: 'girl'|'boy'|'other', char?: true, player?: true, id?: string }[]}
 *   keys of two characters or more, which the story's text is searched for; the
 *   card's character first. `marks`: one-character names and aliases (枫), which
 *   count only where a name stands alone (【枫|微笑】, a line 枫：).
 */
export function speakerNames({ char = '', user = '', roster = [] } = {}) {
  const out = []
  const shortOf = full => full.split(/[-－·|｜_ ]/)[0].trim() || full
  const add = (name, aliases = [], extra = {}) => {
    const full = String(name ?? '').trim()
    if (!full) return
    let short = shortOf(full)
    const given = /^[一-鿿ぁ-ヿ]+ ([一-鿿ぁ-ヿ]+)$/.exec(full)?.[1]
    const all = [full, short, ...(given ? [full.replace(' ', ''), given] : []), ...aliases.map(a => String(a ?? '').trim())].filter(Boolean)
    const keys = all.filter(key => key.length >= 2)
    const marks = extra.player ? [] : all.filter(key => key.length === 1)
    let same = out.find(entry => entry.name === short || (extra.player && entry.player))
    // A cast member already there under that name is someone else of the same family.
    if (same && extra.id && same.id && same.id !== extra.id) {
      short = full
      same = out.find(entry => entry.name === full)
    }
    if (same) {
      same.keys = [...new Set([...same.keys, ...keys])]
      if (marks.length) same.marks = [...new Set([...(same.marks ?? []), ...marks])]
      for (const [key, value] of Object.entries(extra)) same[key] ??= value
    } else if (keys.length || marks.length) out.push({ name: short, keys: [...new Set(keys)], ...(marks.length ? { marks: [...new Set(marks)] } : {}), ...extra })
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
 * The pronoun a quote is said by (你, 她, 他): the one the nearest clause hears
 * (他听见她说：), else the subject of the nearest clause leading into it that
 * has one (过了片刻，她忽然笑了，笑得很短：), else of the sentence after.
 */
export function pronounNear(before, after) {
  const lead = plainOf(before).replace(/\s+/g, '').split(/[。！？!?；;]/).filter(Boolean).pop() ?? ''
  const tail = plainOf(after).replace(/\s+/g, '').replace(/^[，,]/, '').split(/[。！？!?]/)[0]
  const clauses = lead.split(/[，,]/).filter(Boolean).reverse()
  const heard = clauses.length ? HEARD_PRONOUN.exec(clauses[0])?.[1] : null
  return heard ?? clauses.map(clause => SUBJECT.exec(clause.replace(OPENER, ''))?.[1]).find(Boolean) ?? SUBJECT.exec(tail)?.[1] ?? null
}

/**
 * Who a pronoun means: 你 the player; 她/他 the cast member of that kind named
 * last (in a story told in the third person, the player until someone else
 * is), else the card's character when it could be (a one-character card
 * calls its heroine 她 for whole replies).
 */
function byPronoun(pronoun, names, recent) {
  if (pronoun === '你') return names.find(entry => entry.player)?.name ?? null // i18n-ignore: a pronoun in the story
  const kind = pronoun === '她' ? 'girl' : 'boy' // i18n-ignore: a pronoun in the story
  // A trade word (掌柜) named more than three lines ago is no longer who 他 means.
  if (recent[kind] && !(recent.row - recent.at?.[kind] > 3)) return recent[kind]
  const char = names.find(entry => entry.char)
  return char && (!char.kind || char.kind === kind) ? char.name : null
}

/**
 * A quote alone on its line → { speaker } when the lines either side tell
 * (null: the player with no name, or a 她/他 nobody fits), else null.
 * The line after may say who said or answered it (你说。 / 白芷接得很快。).
 * Right after another quote (`turn`: the cast entries of the one answering it
 * and the one who said it, the likelier first; see answers()) it is the first
 * of the two the line after allows (他说，…; 你点头。 is the player listening;
 * the player is no 他/她 unless the story is told in the `third` person).
 * Else the line before it is about the one who speaks
 * (她停在你面前。 / 师妹乖巧地点头。 / 殿里传来师父的声音。 / 掌柜的愣了一下。);
 * one about 你 is the player listening (你摇头。), unless it names someone
 * else (你还没回答，殿里传来师父的声音。). Else the line after it, when it
 * starts with 她/他 (她跑远了。); a 你 there is the player answering.
 */
function fromNeighbours(previous, next, names, recent, turn, third) {
  const clean = row => plainOf(row ?? '').replace(/\s+/g, '')
  const told = speaker => ({ speaker })
  const following = clean(next).split(/[。！？!?]/)[0] ?? ''
  // Not 白芷问：「…」, which says a quote of its own.
  const answered = !/[：:“「『"]/.test(following) && names.find(entry => entry.keys.some(key => following.startsWith(key) && REPLIED.test(following.slice(key.length))))
  if (answered) return told(answered.name)
  const said = PRONOUN_SAID.exec(following)?.[1]
  if (said === '你') return told(byPronoun(said, names, recent)) // i18n-ignore: a pronoun
  const pronoun = said ?? (/^[“「『"]/.test(following) ? null : SUBJECT.exec(following)?.[1])
  if (turn) {
    // Only 他说 counts here: 他没回答。 is as often the one listening.
    const kind = said === '她' ? 'girl' : 'boy' // i18n-ignore: a pronoun in the story
    const fits = entry => (said ? (third || !entry.player) && (!entry.kind || entry.kind === kind) : !(pronoun === '你' && entry.player)) // i18n-ignore: a pronoun
    const pick = turn.find(fits)
    return told(pick ? pick.name : byPronoun(said, names, recent))
  }
  if (said) return told(byPronoun(said, names, recent))
  const before = clean(previous).split(/[。！？!?]/).filter(Boolean).pop() ?? ''
  if (before && !/[”」』"]$/.test(before)) {
    const subject = SUBJECT.exec(before)?.[1]
    if (subject && subject !== '你') return told(byPronoun(subject, names, recent)) // i18n-ignore: a pronoun
    const lead = names.find(entry => !entry.player && entry.keys.some(key => before.startsWith(key)))
    if (lead) return told(lead.name)
    const known = knownIn(before, names.filter(entry => !entry.player), { last: false })
    if (known) return told(known)
    // 你和她一前一后走着，她走在前面 — the other one in the sentence (阿蝉的喉口一紧，他… is still the player).
    const other = /[，,](她|他)/.exec(before)?.[1]
    const meant = other ? byPronoun(other, names, recent) : null
    if (other && !(third && meant === names.find(entry => entry.player)?.name)) return told(meant)
  }
  // 她跑远了。 — when someone is 她; else it tells nothing (他仰起头 may be the one listening).
  const after = pronoun && pronoun !== '你' ? byPronoun(pronoun, names, recent) : null // i18n-ignore: a pronoun
  return after ? told(after) : null
}

/** A quote's words, without its marks. */
const innerOf = quote => plainOf(quote).trim().replace(/^[“「『"]|[”」』"]$/g, '')

/** Whether words call on someone by name: it opens them or a sentence or clause in them, and a pause or 你 follows (白芷，… / 哇，好凶！白芷你变了). */
const callsOn = (text, entry) => entry.keys.some(key => {
  const at = text.indexOf(key)
  return at >= 0 && (at === 0 || /[\s，,。！？!?…~～—、]/.test(text[at - 1])) && /^(?:$|[，,。！？!?…~～—、你])/.test(text.slice(at + key.length))
})

/**
 * Who would answer a quote said by `from`: the one it calls on (「念念。」);
 * in a story told to 你, the player answers everyone else (one with no name
 * when the player has none); else someone among the last few to speak, or null.
 */
function answererOf(from, previous, spoke, names, third) {
  const called = names.find(entry => entry !== from && callsOn(innerOf(previous), entry))
  if (called) return called
  const player = names.find(entry => entry.player)
  if (!third && !from.player) return player ?? { name: null, player: true, keys: [] }
  const name = [...spoke.slice(-5)].reverse().find(said => said && said !== from.name)
  return name ? (names.find(entry => entry.name === name) ?? { name, keys: [] }) : null
}

// A quote that says yes to the one before it (嗯。 / ……好。), or asks what, a short one even with no mark
// (什么？ / 为什么会高兴。 — not 谁都跑不掉。).
const REPLY = /^[…。.~～—]*(?:嗯|好[的吧啊呀]?[。！!，,…~～]|对[。！!，,啊呀]|行[。！!，,]|哦)/
const ASKS_WHAT = /^[…。.~～—]*(?:为什么|什么(?![都也])|怎么|谁(?![都也])|哪(?![儿里]?[都也]))/

/**
 * Whether a quote alone right after another (`previous`, said by `from`; `by`
 * the one who would answer it) answers it: true, false (the same one goes on)
 * or null when its words do not tell. The player's name in it is said to them
 * (师兄……); someone else's calls on them when it opens the quote or a sentence
 * or clause in it (白芷，… / 白芷你变了…), or else is how they speak of themselves
 * (朵朵想找一个人。). 嗯 / 什么？ or a short question (怕什么？) answers; so does
 * one after a quote calling on `by` (not the player in a story told to 你,
 * whom everyone calls on), or a statement after a question, unless the one
 * before spoke of themselves by name.
 */
function answers(quote, previous, by, from, third) {
  const now = innerOf(quote)
  const then = innerOf(previous)
  const named = (text, entry) => entry.keys.some(key => text.includes(key))
  const asks = text => /[？?][~～…！!]*$/.test(text)
  if (from.player && named(now, from)) return true
  if (by.player && named(now, by)) return false
  if (callsOn(now, from)) return true
  if (callsOn(now, by)) return false
  if (named(now, from)) return false
  if (named(now, by)) return true
  if (REPLY.test(now) || (ASKS_WHAT.test(now) && (asks(now) || now.length <= 8)) || (asks(now) && !asks(then) && now.length <= 5)) return true
  if ((third || !by.player) && callsOn(then, by)) return true
  if (named(then, from)) return false
  return asks(then) && !asks(now) ? true : null
}

/**
 * The kinds a reply shows for the cast that has none: the pronoun opening the
 * next clause that has a subject after one about them (汐汐原地站了两秒，像是
 * 没料到，她眨了两下眼 → girl), by a clear majority (two votes for the player,
 * who the story follows doing things to 她). Someone else named, or another
 * 她/他, on the way is no evidence; nor is a quote between.
 * @returns {Map<object, 'girl'|'boy'>}
 */
function kindsIn(text, names) {
  const votes = new Map()
  for (const stretch of plainOf(text).replace(QUOTE, MASK).split(MASK)) {
    let about = null
    for (const clause of stretch.split(/[，,。！？!?；;：:…—\n]+/)) {
      const body = clause.trim().replace(OPENER, '')
      if (!body) continue
      const lead = names.find(entry => entry.keys.some(key => body.startsWith(key)))
      const others = names.some(entry => entry !== lead && entry.keys.some(key => body.includes(key)))
      const pronoun = /^([她他])(?![们])/.exec(body)?.[1]
      if (pronoun && about && !/[她他]/.test(body.slice(1)) && !lead && !others) {
        const tally = votes.get(about) ?? { girl: 0, boy: 0 }
        tally[pronoun === '她' ? 'girl' : 'boy']++ // i18n-ignore: a pronoun in the story
        votes.set(about, tally)
      }
      if (lead) about = others || /[她他]/.test(body) ? null : lead
      else if (pronoun || others || /^[你我您]|[她他]/.test(body)) about = null
    }
  }
  const kinds = new Map()
  for (const [entry, { girl, boy }] of votes) {
    const margin = entry.player ? 2 : 1
    if (girl > 2 * boy && girl >= boy + margin) kinds.set(entry, 'girl')
    else if (boy > 2 * girl && boy >= girl + margin) kinds.set(entry, 'boy')
  }
  return kinds
}

/** The cast with the kinds the reply shows; the card's character and the player, when only one of them has a kind, the other one's opposite. */
function withKinds(text, names) {
  const shown = kindsIn(text, names)
  const out = names.map(entry => (entry.kind || !shown.has(entry) ? entry : { ...entry, kind: shown.get(entry) }))
  const char = out.find(entry => entry.char)
  const player = out.find(entry => entry.player)
  const opposite = { girl: 'boy', boy: 'girl' }[char?.kind ?? player?.kind]
  if (char && player && !char.kind !== !player.kind && opposite) {
    const lone = char.kind ? player : char
    out[out.indexOf(lone)] = { ...lone, kind: opposite }
  }
  return out
}

/**
 * The cast named in narration (not inside quotes or a 【system panel】), in order: the last of each kind is who 她/他 means.
 * A trade word only where it opens a clause (掌柜的愣了一下) or brings one in (门外站着个年轻捕快), not in passing
 * (几个老汉蹲在墙根); `recent.at` keeps the line it was named on (`recent.row`).
 */
function noteNamed(text, names, recent) {
  const prose = masked(String(text ?? '')).replace(QUOTE, '').replace(/【[^】]*(?:】|$)/g, '')
  const opens = at => /[\s\u0001，,。！？!?；;：:、”」』"]/.test(prose[at - 1]) || /(?:^|[^几两三四五六七八九十许些多])[个位名][^\s，,。！？!?]{0,3}$/.test(prose.slice(Math.max(0, at - 6), at))
  const found = []
  for (const entry of names) {
    for (const key of entry.keys) {
      let at = prose.lastIndexOf(key)
      while (entry.role && at > 0 && !opens(at)) at = prose.lastIndexOf(key, at - 1)
      if (at >= 0) found.push({ at: at + key.length, entry })
    }
  }
  recent.at ??= {}
  for (const { entry } of found.sort((a, b) => a.at - b.at)) {
    const note = kind => {
      recent[kind] = entry.name
      recent.at[kind] = entry.role ? recent.row : undefined
    }
    if (entry.kind !== 'boy') note('girl')
    if (entry.kind !== 'girl') note('boy')
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
  const exact = names.find(entry => entry.keys.includes(body) || entry.marks?.includes(body))
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

/**
 * The beats of one source line: quotes with the narration that leads into them, narration on its own.
 * A dialogue beat's `at` is where its quote starts; a quote starting at one of `said` is spoken, however short.
 */
function beatsOf(row, max, said = []) {
  const hidden = masked(row)
  const quotes = [...hidden.matchAll(QUOTE)].filter(quote => said.includes(quote.index) || !cited(quote[0]))
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
    out.push({ kind: 'dialogue', text: row.slice(lead, end), at: quote.index, before: row.slice(lead, quote.index), after: row.slice(quote.index + quote[0].length, i === quotes.length - 1 ? row.length : quotes[i + 1].index) })
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

// ─── 视觉小说格式: the marks a reply carries when it is on ────────────────
// server/prompt.mjs asks for them in the turn's message:
//   【林青禾|微笑】「你来了。」   who says the line and how they look
//   【效果|震屏】                 what the picture does (on its own line, before the line it is for)
// The reader takes them out of the text; the chat shows the name instead
// (markSpeakers). One way to read 【kind|value】 for the marks to come.

// 【名字|表情】 right before a quote (a colon, spaces or ** between). The bar is what tells
// it from a card's own 【系统】「…」; the expression may be left empty.
const SAY_MARK = /(?:\*\*)?【\s*([^【】|｜\n]{1,24}?)\s*[|｜]\s*([^【】|｜\n]{0,24}?)\s*】(?:\*\*)?\s*[：:]?\s*(?=[“「『"])/g
// The same mark alone on its line, the quote opening the next one.
const LONE_MARK = /^\s*(?:\*\*)?【\s*([^【】|｜\n]{1,24}?)\s*[|｜]\s*([^【】|｜\n]{0,24}?)\s*】(?:\*\*)?\s*[：:]?\s*$/
const OPENS_QUOTE = /^\s*(?:<[^<>]+>\s*)*[“「『"]/
// 【效果|震屏】 (or 【效果|闪白|发抖】), anywhere.
const EFFECT_MARK = /(?:\*\*)?【\s*([^【】|｜\n]{1,8}?)\s*[|｜]\s*([^【】\n]{1,40}?)\s*】(?:\*\*)?/g
// A mark still being written at the end of a reply coming in.
const OPEN_MARK = /(?:\*\*)?【[^【】\n]{0,40}$|(?:\*\*)?【[^【】\n]{1,40}[|｜][^【】\n]{0,40}】(?:\*\*)?\s*[：:]?\s*$/

const isEffectKind = kind => EFFECT_KINDS.includes(String(kind).trim().toLowerCase())

/** Two lots of effects as one (the later wins where both ask), or null when neither asks. */
const joinEffects = (a, b) => (a || b ? { screen: b?.screen ?? a?.screen ?? null, actor: b?.actor ?? a?.actor ?? null } : null)

/** The effect marks in a line taken out ({ screen, actor }, or null), and the line without them. */
function takeEffects(text) {
  let effects = null
  const rest = text.replace(EFFECT_MARK, (mark, kind, words) => {
    if (!isEffectKind(kind)) return mark
    // 【效果|攻击力+5】 in a card's own text is not ours.
    const asked = markEffects(words.split(/[|｜,，、\s]+/))
    if (!asked) return mark
    effects = { screen: asked.screen ?? effects?.screen ?? null, actor: asked.actor ?? effects?.actor ?? null }
    return ''
  })
  return { text: rest, effects }
}

/**
 * One line's marks taken out: the line as read, who says the quote starting
 * at each place in it ({ at, name, face }), and the effects asked for. A mark
 * alone on the line comes as `lone` ({ name, face }), the line kept as it is:
 * it names the next line's speaker when that line opens with a quote.
 */
export function takeMarks(row, { partial = false } = {}) {
  const { text: rest, effects } = takeEffects(String(row ?? ''))
  const lone = LONE_MARK.exec(rest)
  // (On the last row of a reply coming in, its quote is still to come.)
  if (lone && !isEffectKind(lone[1])) return { text: partial ? '' : rest, says: [], lone: { name: lone[1], face: faceOf(lone[2]) }, effects }
  const says = []
  let text = ''
  let last = 0
  for (const match of rest.matchAll(SAY_MARK)) {
    if (isEffectKind(match[1])) continue
    text += rest.slice(last, match.index)
    says.push({ at: text.length, name: match[1], face: faceOf(match[2]) })
    last = match.index + match[0].length
  }
  text += rest.slice(last)
  if (partial) text = text.replace(OPEN_MARK, '')
  return { text, says, lone: null, effects }
}

/**
 * Text with the marks for the chat: a speaker's mark becomes `wrap(name)`
 * (the page draws it as a name), effects go, a line left empty by them too.
 */
export function markSpeakers(text, wrap = name => `${name}：`, { partial = false } = {}) { // i18n-ignore: the story's own colon
  const lines = String(text ?? '').split('\n')
  const out = []
  let label = ''
  lines.forEach((line, i) => {
    const { text: rest, effects } = takeEffects(line)
    if (effects && !rest.replace(/\*/g, '').trim()) return
    const lone = LONE_MARK.exec(rest)
    if (lone && !isEffectKind(lone[1]) && OPENS_QUOTE.test(lines[i + 1] ?? '')) {
      label = wrap(lone[1].trim())
      return
    }
    out.push(label + rest.replace(SAY_MARK, (mark, name) => (isEffectKind(name) ? mark : wrap(name.trim()))))
    label = ''
  })
  // One still being written (or with its quote still to come) at the very end. In a finished reply only a speaker's
  // mark with no line after it goes: a card's own status line there (【好感度：85｜心情：开心】) is the story's.
  const joined = out.join('\n')
  const cut = partial ? joined.replace(OPEN_MARK, '') : joined.replace(UNCLOSED_MARK, '').replace(DANGLING_MARK, '')
  return cut === joined ? joined : cut.trimEnd()
}

// At the very end: a mark never closed (half of one), and a whole speaker's mark with nothing after it (a name
// and a face, no ：inside, as a status line has).
const UNCLOSED_MARK = /(?:\*\*)?【[^【】\n]{0,40}$/
const DANGLING_MARK = /(?:\*\*)?【[^【】\n：:]{1,40}[|｜][^【】\n：:]{0,40}】(?:\*\*)?\s*[：:]?\s*$/

/** Text without the marks at all. */
export const withoutMarks = text => markSpeakers(text, () => '')

/** Whether a reply carries a speaker's mark (it was written in the 视觉小说格式). */
export const hasMarks = text => /【[^【】|｜\n]{1,24}[|｜][^【】|｜\n]{0,24}】/.test(String(text ?? ''))

/** A mark's name → the cast name it means (an alias, or part of a longer name), else as written. */
function castName(name, names) {
  const n = String(name).replace(/\*/g, '').trim()
  const exact = names.find(entry => entry.name === n || entry.keys.includes(n) || entry.marks?.includes(n))
  if (exact) return exact.name
  const near = n.length >= 2 ? names.find(entry => !entry.role && entry.keys.some(key => key.length >= 2 && (key.includes(n) || n.includes(key)))) : null
  return near?.name ?? n
}

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
  // 视觉小说格式: each row's marks taken out. A row of effects only gives them to the next one;
  // a speaker's mark alone on its row, to the quote opening the next.
  const lines = []
  const marksOf = []
  let carried = null
  let lone = null
  rows.forEach((row, i) => {
    const mark = takeMarks(row, { partial: partial && i === rows.length - 1 })
    const effects = joinEffects(carried, mark.effects)
    if (!plainOf(mark.text).trim() || (mark.lone && OPENS_QUOTE.test(rows[i + 1] ?? ''))) {
      carried = effects
      if (plainOf(mark.text).trim()) lone = mark.lone
      return
    }
    lines.push(mark.text)
    marksOf.push({ says: mark.says, lone, effects })
    carried = null
    lone = null
  })
  const story = withoutMarks(source)
  const beats = []
  const recent = {}
  let label = null
  let lastSpeaker = null
  // The quote the line before ends with ({ speaker, quote, answered }: a quote alone after it may answer it), and everyone who spoke.
  let answering = null
  const spoke = []
  names = withKinds(story, [...names, ...ROLES.filter(role => !names.some(entry => entry.keys.includes(role.name)))])
  const player = names.find(entry => entry.player)
  // Told in the third person (阿蝉推门进去。, not 你): the player is one more 他/她, the one the story follows.
  const prose = plainOf(story).replace(QUOTE, '')
  const third = Boolean(player?.kind) && player.keys.reduce((n, key) => n + prose.split(key).length - 1, 0) > (prose.match(/你/g) ?? []).length
  const noted = third ? names : names.filter(entry => !entry.player)
  if (third) recent[player.kind] = player.name
  // Paragraphs of a memory still to come (0: none).
  let memoryLeft = 0
  // Effects asked for on a row that shows nothing (a rule, a header line), for the next line shown.
  let effectsDue = null
  lines.forEach((row, i) => {
    const unfinished = partial && i === lines.length - 1
    const marks = marksOf[i]
    effectsDue = joinEffects(effectsDue, marks.effects)
    recent.row = i
    const turnFrom = answering
    answering = null
    // A rule between scenes.
    if (/^[-—–*＊=_~·\s]{3,}$/.test(plainOf(row).trim())) {
      memoryLeft = 0
      return
    }
    // A header line (日期 · 时辰 · 地点): the sign and the background, not a line to read.
    const where = unfinished ? null : headerPlace(row)
    if (where) {
      memoryLeft = 0
      beats.push({ kind: 'scene', text: '', speaker: null, where })
      return
    }
    const told = plainOf(row).replace(QUOTE, ' ').trim()
    if (MEMORY_END.test(told)) memoryLeft = 0
    else if (MEMORY_START.test(told)) memoryLeft = MEMORY_ROWS + 1
    const memory = memoryLeft > 0
    if (memoryLeft) memoryLeft--
    const option = OPTION.exec(row)
    if (option) {
      // One still being written is not an option yet.
      if (!unfinished) beats.push({ kind: 'option', text: option[2].trim(), speaker: null })
      return
    }
    // The last line of a reply still coming in may not be finished: never a name line yet.
    const named = unfinished ? null : labelOf(row, names)
    if (named?.drop) {
      label = named.name
      return
    }
    let rowSpeaker = null
    // Marked quotes are spoken, however short: those a mark leads, and the first one after a mark on the row before.
    const said = marks.says.map(mark => mark.at)
    if (marks.lone) said.push(masked(row).search(QUOTE))
    beatsOf(row, max, said).forEach((beat, b) => {
      let speaker = null
      let face = null
      if (beat.kind === 'dialogue') {
        noteNamed(beat.before, noted, recent)
        const quoted = plainOf(beat.text.slice(beat.before.length, beat.text.length - beat.after.length))
        // 【名字|表情】 says who, and how they look (a mark alone on the row before: its first quote).
        const mark = marks.says.find(said => said.at === beat.at) ?? (marks.lone && !marks.lone.used ? marks.lone : null)
        let from = null
        let by = null
        if (mark) {
          mark.used = true
          speaker = castName(mark.name, names)
          face = mark.face
        } else {
          const pronoun = pronounNear(beat.before, beat.after)
          speaker = guessSpeaker(beat.before, beat.after, names) ?? label ?? (pronoun ? byPronoun(pronoun, names, recent) : null) ?? rowSpeaker
          // Nothing around it on its line: the lines either side. Right after another quote, it answers that one or
          // the same one goes on: its words say which, else as the line before went (else the player is answered).
          const bare = !plainOf(beat.before).trim() && !plainOf(beat.after).replace(/[\s~～…。！？!?，,]/g, '')
          from = !speaker && bare && b === 0 && turnFrom?.speaker ? (names.find(entry => entry.name === turnFrom.speaker) ?? { name: turnFrom.speaker, keys: [] }) : null
          by = from ? answererOf(from, turnFrom.quote, spoke, names, third) : null
          const answered = by && (answers(quoted, turnFrom.quote, by, from, third) ?? turnFrom.answered ?? Boolean(from.player))
          const turn = by ? (answered ? [by, from] : [from, by]) : null
          let near = !speaker && bare ? fromNeighbours(lines[i - 1], lines[i + 1], names, recent, turn, third) : null
          if (near) speaker = near.speaker
          // 「师兄，渴不渴？」 is said to the player, not by them (and lines either side that said so told nothing).
          if (player && speaker === player.name && player.keys.some(key => quoted.includes(key))) speaker = near = null
          // Nothing says who: whoever spoke last (not the player, whose lines are written as such), else the card's
          // own. A line led in by 说 that still cannot be told (等你说「是。」) keeps no name.
          if (!speaker && !near && !pronoun && !SAY_TAIL.test(plainOf(beat.before).replace(/\s+/g, ''))) speaker = lastSpeaker ?? names.find(entry => entry.char)?.name ?? null
        }
        rowSpeaker = speaker
        const who = names.find(entry => entry.name === speaker)
        spoke.push(speaker)
        if (speaker && !who?.player) lastSpeaker = speaker
        if (who && noted.includes(who)) noteNamed(who.keys[0], [who], recent)
        noteNamed(beat.after, noted, recent)
        answering = { speaker, quote: quoted, answered: by ? speaker !== from.name : undefined }
      } else {
        noteNamed(beat.text, noted, recent)
        answering = null
      }
      beats.push({ kind: beat.kind, text: beat.text, speaker, ...(memory ? { memory } : {}), ...(face ? { expression: face } : {}), ...(effectsDue ? { effects: effectsDue } : {}) })
      effectsDue = null
    })
    label = named?.name ?? null
  })
  const texts = carryTags(beats.map(beat => beat.text))
  return beats.map((beat, i) => ({
    kind: beat.kind,
    text: texts[i],
    plain: plainOf(beat.text).trim(),
    speaker: beat.speaker,
    ...(beat.where ? { where: beat.where } : {}),
    ...(beat.memory ? { memory: true } : {}),
    ...(beat.expression ? { expression: beat.expression } : {}),
    ...(beat.effects ? { effects: beat.effects } : {}),
  }))
}

/**
 * Where the line at `index` of `before` is in `after`, the same reply split again (more of it
 * streamed in, finished, or drawn with other regex): the same copy of its words, so a line said
 * twice (「嗯。」, 她说。) is not taken for the first. With fewer copies now, the one nearest;
 * -1 when the words are gone.
 */
export function sameLine(before, index, after) {
  const plain = before[index]?.plain
  if (plain === undefined) return -1
  const copies = []
  after.forEach((step, i) => {
    if (step.plain === plain) copies.push(i)
  })
  const copy = before.slice(0, index).filter(step => step.plain === plain).length
  if (copy < copies.length) return copies[copy]
  return copies.reduce((best, i) => (best < 0 || Math.abs(i - index) < Math.abs(best - index) ? i : best), -1)
}

// ─── Scenes ──────────────────────────────────────────────────────────────

/** A place name as compared: full-width letters half-width, no spaces or punctuation, ASCII lower-case. */
export function normalizePlace(text) {
  return String(text ?? '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s·・•、，,。.…⋯:：;；!！?？'"“”‘’「」『』()（）[\]【】<>《》\-—–_~～|｜/]+/g, '')
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
 * Whether a 地点： label at `index` sits where a header has it: the line's start (past brackets or bold marks)
 * or right after a separator (时间：… ｜ 地点：…), never in a quote or the middle of a sentence (她说约好的地点：…).
 */
function atHeader(line, index) {
  const before = line.slice(0, index)
  if (/[「『“"‘']/.test(before)) return false
  return /^[\s【[(（<《*_#>~-]*$/.test(before) || /[|｜·•・/／]\s*(?:当前)?$/.test(before)
}

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
    if (label('place') && atHeader(line, LABELLED.place.exec(line).index)) return { time: label('time'), place: label('place'), weather: label('weather') }
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

// ─── Days (换天的章节标题卡) ───────────────────────────────────────────────

const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 } // i18n-ignore: numerals
const MONTH_WORDS = { 正: 1, 冬: 11, 腊: 12 } // i18n-ignore: month names
const WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 } // i18n-ignore: weekdays
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** 17, 十七, 二十三, 廿三, 初七, 二〇二六 → a number; else NaN. */
function numberOf(text) {
  const s = String(text ?? '').trim().replace(/^初/, '').replace(/^廿/, '二十').replace(/^卅/, '三十') // i18n-ignore: numerals
  if (/^\d+$/.test(s)) return Number(s)
  if (s in MONTH_WORDS) return MONTH_WORDS[s]
  const tens = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s)
  if (tens) return (tens[1] ? DIGITS[tens[1]] : 1) * 10 + (tens[2] ? DIGITS[tens[2]] : 0)
  if (/^[零〇一二两三四五六七八九]{1,4}$/.test(s)) return Number([...s].map(ch => DIGITS[ch]).join(''))
  return NaN
}

/**
 * The date in a time box's time ("10月20日 周一 清晨7:50", "永和十七年八月十五 亥时",
 * "第3天 上午", "Oct 20"): { year, month, day, count, weekday, key }, its key ''
 * when it names no date (a time of day alone).
 */
export function dateOf(time) {
  const s = String(time ?? '')
  const date = { key: '' }
  const pieces = []
  const take = (pattern, use) => {
    const match = pattern.exec(s)
    if (match && use(match) !== false) pieces.push(match[0].replace(/\s+/g, ''))
  }
  const fits = (n, max) => Number.isInteger(n) && n >= 1 && n <= max
  take(/第\s*([\d零〇一二两三四五六七八九十百]+)\s*[天日]|\bday\s*(\d+)\b/i, m => fits((date.count = numberOf(m[1] ?? m[2])), 9999))
  take(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/, m => {
    Object.assign(date, { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) })
  })
  if (date.month == null) {
    take(/([\d零〇一二两三四五六七八九十百千廿卅]+)\s*年/, m => fits((date.year = numberOf(m[1])), 99999))
    take(/([\d正一二三四五六七八九十冬腊]+)\s*月\s*(?:(初[一二三四五六七八九十]|[一二三四五六七八九十廿卅]+|\d{1,2})\s*[日号]?)?/, m => {
      date.month = numberOf(m[1])
      if (m[2]) date.day = numberOf(m[2])
      // 八月十五, 正月初七: a lunar month, thirty days or so.
      if (!/\d/.test(m[0])) date.lunar = true
      return fits(date.month, 12)
    })
    const en = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(s)
    if (date.month == null && en) {
      Object.assign(date, { month: MONTHS_EN.indexOf(en[1].toLowerCase()) + 1, day: Number(en[2]) })
      pieces.push(en[0].replace(/\s+/g, ''))
    }
  }
  if (date.month == null && date.count == null) take(/(?:^|[^\d第])(\d{1,2}|[一二三四五六七八九十廿卅]+)\s*[日号]/, m => fits((date.day = numberOf(m[1])), 31))
  take(/(?:周|星期|礼拜)([一二三四五六日天])|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i, m => {
    date.weekday = WEEKDAYS[(m[1] ?? m[2]).toLowerCase()]
  })
  if (!fits(date.count, 9999)) delete date.count
  if (!fits(date.year, 99999)) delete date.year
  if (!fits(date.month, 12)) delete date.month
  if (!fits(date.day, 31)) delete date.day
  date.key = pieces.join(' ')
  return date
}

/** Days from one date to another, when they say: by the day count, the calendar, the day of the month, the weekday. Else null. */
export function daysBetween(from, to) {
  if (from?.count != null && to?.count != null) return to.count - from.count
  if (from?.month && from.day && to?.month && to.day) {
    // A lunar date and a calendar one cannot be counted between.
    if (Boolean(from.lunar) !== Boolean(to.lunar)) return null
    const fromYear = from.year ?? to.year ?? 2001
    // No year written: a month far back is the next year's (腊月 → 正月), one a little back is earlier.
    const toYear = to.year ?? (from.month - to.month >= 6 ? fromYear + 1 : fromYear)
    if (from.lunar || to.lunar) return ((toYear - fromYear) * 12 + to.month - from.month) * 30 + to.day - from.day
    return Math.round((Date.UTC(toYear, to.month - 1, to.day) - Date.UTC(fromYear, from.month - 1, from.day)) / 86_400_000)
  }
  if (from?.day && to?.day && from.month == null && to.month == null && to.day >= from.day) return to.day - from.day
  if (from?.weekday != null && to?.weekday != null) return (to.weekday - from.weekday + 7) % 7
  return null
}

/**
 * The story at `at` ({ day, date }: the furthest date it reached) moving to a
 * time box's time: the day it is now, and whether that is a later day. An
 * earlier date (a memory) leaves the day where it was; one that changed in a
 * way that cannot be counted is taken as the next day.
 */
export function advanceDay(at, time) {
  const date = dateOf(time)
  const day = at?.day ?? 1
  if (!date.key) return { day, date: at?.date ?? null, changed: false }
  if (!at?.date?.key) return { day: date.count ?? day, date, changed: false }
  const diff = daysBetween(at.date, date)
  if (diff === null && date.key !== at.date.key) return { day: date.count ?? day + 1, date, changed: true }
  if (!(diff > 0)) return { day, date: at.date, changed: false }
  return { day: date.count ?? day + diff, date, changed: true }
}

// A paragraph opening on the next day (次日清晨，…), in a story that writes no dates.
const NEXT_DAY = /^[\s*_#>【[(（]*(?:次日|翌日|第二天(?![就要还得再便也都才])|第二日|隔天|隔日|次晨|翌晨|转天|一夜无话|the next (?:day|morning)\b)/i // i18n-ignore: words for the next day

/** Whether a line opens on the next day. */
export const opensNextDay = text => NEXT_DAY.test(plainOf(text).trim())

/** The times a reply gives: its time box, then every header line in it. */
export function timesIn(text) {
  const raw = String(text ?? '')
  const box = placeOf(timeBoxOf(raw)).time
  const headers = raw.split('\n').map(line => headerPlace(line)?.time).filter(Boolean)
  return [box, ...headers].filter(Boolean)
}

/** The time a chat's variables give (系统.当前时间), or ''. */
export const stateTime = state => (state && typeof state === 'object' ? stateValue(state, 'time') : '')

/**
 * Which day of the story the replies so far reach (oldest first; each its text,
 * or { text, time } with the time its variables gave): the first date seen is
 * day 1 (or the day it counts, 第3天), each later date counts on from it, and a
 * reply with no date that opens a paragraph on 次日 is one day more. → { day, date }.
 */
export function storyDay(replies) {
  let at = { day: 1, date: null }
  for (const reply of replies) {
    const text = typeof reply === 'string' ? reply : reply?.text
    const times = timesIn(text)
    if (!times.length && reply?.time) times.push(reply.time)
    if (times.length) for (const time of times) at = advanceDay(at, time)
    else if (String(text ?? '').split('\n').some(opensNextDay)) at = { day: at.day + 1, date: null }
  }
  return { day: at.day, date: at.date }
}
