// 从小说抽取世界书 (世界书窗口 → 从小说抽取): a long text, a whole novel, read a stretch at a time into worldbook
// entries: who and what is in it, a thing an entry. A file attached to 创作角色卡 is read only as far as 60 000
// characters; this reads all of it, in as many requests as it has stretches, so it says what that comes to before
// anything is sent, keeps what each stretch gave, and goes on from where it stopped.
//
// The code cuts the text, keeps the names apart and puts the book together; the model reads a stretch and writes what
// is in it, and at the end makes one entry of the notes a name gathered over many stretches.
import { readFile, rm, writeFile } from 'node:fs/promises'
import { estimateTokens } from '../context.mjs'
import { msg } from '../i18n.mjs'
import { estimateCost } from '../models.mjs'
import { isProviderRef, refLabel } from '../providers.mjs'
import { httpError } from '../store.mjs'
import { normalizeBook } from '../worldbook.mjs'
import { looseJson, section } from './prompts.mjs'

export const NOVEL_ID = 'edit-novel'
/** The most of a text that is read (about three million characters is a very long novel). */
export const MAX_NOVEL = 5_000_000
const MIN_NOVEL = 200
// A stretch: about this long, a chapter or a few together; one chapter longer than MAX_STRETCH is cut at a paragraph.
const STRETCH = 12_000
const MAX_STRETCH = 18_000
// Stretches but the last of a chapter are at least half of STRETCH long, so MAX_NOVEL comes to fewer than this; a
// text that cuts into more is not taken rather than read short.
const MAX_STRETCHES = 1000
// How many stretches are read at once (the player's pick, 1 to MAX_PARALLEL), and how many when they have not picked.
export const MAX_PARALLEL = 8
const PARALLEL = 3
// Several at once: batches half the size of one at a time, so that the putting together goes faster too.
const mergeSize = width => (width > 1 ? MERGE_CHARS / 2 : MERGE_CHARS)
const parallelOf = session => Math.max(1, Math.min(MAX_PARALLEL, Math.round(Number(session.parallel)) || PARALLEL))
const EXTRACT_TOKENS = 8000
const MERGE_TOKENS = 12000
// What an answer comes to with its thinking, for the estimate.
const EXTRACT_OUTPUT = 2500
// The notes of one name put together in one request, and the names of the notes sent along with a stretch.
const MERGE_CHARS = 10_000
const MAX_KNOWN = 300
const MAX_ENTRY = 2000
const MAX_NAME = 24
const MAX_ENTRIES = 1500
export const NOVEL_TYPES = ['人物', '地点', '势力', '物品', '设定', '事件']
// 梗概: the whole book in a few thousand characters, written from the entries (the text is not read again). It is what
// 创作角色卡 reads of a novel in place of the entries, which are far too many to send with every request.
export const MAX_DIGEST = 8000
const DIGEST_TOKENS = 8000
const DIGEST_CHARS = 40_000
// What 创作角色卡 reads of a novel: the 梗概 and the 名录 (every entry's name, the ones met most with a line each).
export const MAX_MATERIAL = 30_000
const DIGEST_MARK = '梗概'
const TYPE_OF = { character: '人物', person: '人物', place: '地点', location: '地点', faction: '势力', organization: '势力', item: '物品', object: '物品', setting: '设定', rule: '设定', lore: '设定', event: '事件' }

// A chapter's heading on a line of its own: 第十二章 …, 卷三, Chapter 4, 楔子.
const HEADING = /^[ \t　]*(?:第[0-9零〇一二三四五六七八九十百千两]+[章回节卷集部篇幕话][^\n]{0,40}|卷[零〇一二三四五六七八九十百千两0-9]+[^\n]{0,40}|(?:chapter|part|book)\s+[0-9ivxlc]+[^\n]{0,60}|序章|序幕|楔子|引子|尾声|终章|后记|番外[^\n]{0,30})[ \t　]*$/gim

const clip = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** A text cut into pieces no longer than `max`, at paragraph ends where there are any. */
function cutLong(text, from, max) {
  const out = []
  let at = 0
  while (text.length - at > max) {
    const upTo = text.lastIndexOf('\n', at + max)
    const end = upTo > at + max / 2 ? upTo + 1 : at + max
    out.push({ from: from + at, to: from + end })
    at = end
  }
  if (text.length > at) out.push({ from: from + at, to: from + text.length })
  return out
}

/**
 * A novel as stretches, each read in a request of its own: [{ from, to, title }] over the text's characters. By its chapters when
 * it has headings (short ones together, a long one cut), else by length.
 */
export function splitNovel(text) {
  const heads = [...text.matchAll(HEADING)].map(found => ({ at: found.index, title: found[0].trim().slice(0, 40) }))
  const parts = []
  if (heads.length >= 3) {
    if (heads[0].at > 0 && text.slice(0, heads[0].at).trim()) parts.push({ from: 0, to: heads[0].at, title: '' })
    heads.forEach((head, i) => parts.push({ from: head.at, to: heads[i + 1]?.at ?? text.length, title: head.title }))
  } else parts.push({ from: 0, to: text.length, title: '' })
  const stretches = []
  let open = null
  const close = () => {
    if (open) stretches.push(open)
    open = null
  }
  for (const part of parts) {
    const size = part.to - part.from
    if (size > MAX_STRETCH) {
      close()
      for (const piece of cutLong(text.slice(part.from, part.to), part.from, STRETCH)) stretches.push({ ...piece, title: part.title })
    } else if (open && open.to - open.from + size > STRETCH) {
      close()
      open = { ...part }
    } else if (open) open = { ...open, to: part.to, last: part.title }
    else open = { ...part }
  }
  close()
  // Each with what it comes to (tokens), so the estimate is worked out without the text again.
  return stretches.map((stretch, i) => ({ from: stretch.from, to: stretch.to, tokens: estimateTokens(text.slice(stretch.from, stretch.to)), title: stretch.title ? (stretch.last && stretch.last !== stretch.title ? `${stretch.title} … ${stretch.last}` : stretch.title) : msg`第 ${i + 1} 段` }))
}

const EXTRACT_SYSTEM = `你在把一部小说整理成角色扮演用的世界书。<text> 是其中的一段。把这一段里以后扮演用得上的东西抽出来，一条写一样：
- 人物：身份、外貌、性格、说话的样子、和别人的关系、到这一段为止做过的要紧事。
- 地点、势力、物品：是什么样的，和谁有关，有什么要紧的。
- 设定：这个世界的规矩、体系、专有的说法。
- 事件：已经发生的大事，谁、在哪、结果怎样。

要求：
- 只写这一段原文里有的，不猜，不补，不评价。一笔带过、以后用不上的不记。
- <known> 是前面几段已经记过的名字。同一样东西用同一个名字；这一段对它有新的内容才再写一条，只写新的部分，不重复已经知道的。
- content 用原文的语言写，几句到一小段，写事实，不写「这一段里」这类话。
- aliases 只写专指这一样东西的叫法（外号、字号、全名、简称）。「先生」「师父」「老头」「姑娘」这类谁都能叫的称呼不写，别人的名字也不写。

只输出一个 JSON 数组，数组外不写别的：
[{"type": "人物、地点、势力、物品、设定、事件之一", "name": "最常用的那个名字", "aliases": ["别的叫法，没有就空着"], "content": "……"}]
这一段没有值得记的，输出 []。`

const MERGE_SYSTEM = `你在整理世界书条目。下面每个 <entry> 是同一样东西在一部小说不同地方记下的几段笔记，按先后排着。把每个 <entry> 的笔记合成一条：
- 按先后理顺，去掉重复的；前后不一样的地方以后面的为准，要紧的变化留下经过。
- 不丢要紧的内容，不添笔记里没有的。
- 人物分几行写：身份、外貌、性格、说话的样子、关系、经历。别的写成一小段。
- 每条不超过 800 字，贯穿全书的主要人物可以到 1500 字。用笔记的语言写。

只输出一个 JSON 数组，数组外不写别的，名字照给的写：
[{"name": "……", "content": "……"}]`

/** The request for one stretch. @param known - the names noted so far */
export function extractRequest(text, title, known = []) {
  const names = known.slice(0, MAX_KNOWN).join('、')
  const content = [names ? `<known>\n${names}\n</known>` : '', `<text title="${clip(title, 60).replace(/"/g, "'")}">\n${text}\n</text>`].filter(Boolean).join('\n\n')
  return { system: EXTRACT_SYSTEM, messages: [{ role: 'user', content }], maxTokens: EXTRACT_TOKENS, softCap: true }
}

/** An answer as notes: [{ type, name, aliases, content }]; null when it is no list at all. */
export function readExtract(text) {
  const raw = looseJson(section(text, 'json') || text)
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : null
  if (!list) return null
  return list.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const name = clip(item.name, MAX_NAME)
    const content = String(item.content ?? '').trim().slice(0, MAX_ENTRY)
    if (!name || !content) return []
    const said = clip(item.type, 12)
    const type = NOVEL_TYPES.includes(said) ? said : TYPE_OF[said.toLowerCase()] ?? '设定'
    const aliases = [...new Set((Array.isArray(item.aliases) ? item.aliases : []).map(alias => clip(alias, MAX_NAME)).filter(alias => alias && alias !== name))].slice(0, 6)
    return [{ type, name, aliases, content }]
  })
}

const keyOf = name => name.replace(/\s+/g, '').toLowerCase()

/**
 * A stretch's notes into what was gathered so far (`notes`: [{ type, name, aliases, parts: [text] }], changed in
 * place): a name, or another way of calling it, that is there already takes the new part.
 */
export function gather(notes, found, at = 0) {
  // `at`: which stretch these were read in (1 on; 0 when not known). Kept beside each part (note.at), so that what
  // is made of the book can stop at a point in it: 创作角色卡's 「书里的内容带到哪一段为止」.
  const placed = note => (note.at ??= note.parts.map(() => 0))
  for (const item of found) {
    const names = [item.name, ...item.aliases].map(keyOf)
    // The one of this very name first, then the one a name of this is, then the one this is another name of. Two of
    // different names that only share a way of calling stay two: a model that once gave 清河 the alias 老梁 does not
    // thereby get all of 梁更夫's notes.
    const same = notes.find(note => keyOf(note.name) === names[0])
      ?? notes.find(note => names.includes(keyOf(note.name)))
      ?? notes.find(note => note.aliases.map(keyOf).includes(names[0]))
    if (same) {
      placed(same).push(at)
      same.parts.push(item.content)
      same.aliases = [...new Set([...same.aliases, ...item.aliases, ...(keyOf(item.name) === keyOf(same.name) ? [] : [item.name])])].filter(alias => keyOf(alias) !== keyOf(same.name)).slice(0, 8)
    } else if (notes.length < MAX_ENTRIES) notes.push({ type: item.type, name: item.name, aliases: item.aliases, parts: [item.content], at: [at] })
  }
  return notes
}

/**
 * The notes that take a model to put together, in batches a request holds: [[{ name, parts }]]. One noted once needs
 * none. @param max - how much a batch holds: less when several go at once, so that more of them can
 */
export function mergeBatches(notes, max = MERGE_CHARS) {
  const batches = []
  let open = []
  let size = 0
  for (const note of notes) {
    if (note.parts.length < 2) continue
    // A name with more notes than a request holds is put together a part at a time (mergeWork).
    const chars = Math.min(note.parts.join('').length, max)
    if (open.length && size + chars > max) {
      batches.push(open)
      open = []
      size = 0
    }
    open.push(note)
    size += chars
  }
  if (open.length) batches.push(open)
  return batches
}

/** The request that makes one entry of each name's notes. @param items - [{ name, parts }] */
export function mergeRequest(items) {
  const content = items.map(item => `<entry name="${item.name.replace(/"/g, "'")}">\n${item.parts.map((part, i) => `【${i + 1}】${part}`).join('\n')}\n</entry>`).join('\n\n')
  return { system: MERGE_SYSTEM, messages: [{ role: 'user', content }], maxTokens: MERGE_TOKENS, softCap: true }
}

/** An answer as { name → content }. */
export function readMerge(text) {
  const raw = looseJson(section(text, 'json') || text)
  const out = new Map()
  for (const item of Array.isArray(raw) ? raw : []) {
    const content = String(item?.content ?? '').trim()
    if (item && typeof item.name === 'string' && content) out.set(keyOf(item.name), content.slice(0, MAX_ENTRY * 2))
  }
  return out
}

const DIGEST_SYSTEM = `你在给一部小说写梗概，给以后照这部小说做角色扮演卡的人看。下面是从全书里抽出来的条目：人物、势力、设定、地点按出场多少排，事件按书里的先后排。只照这些条目写，不添条目里没有的，不评价。

分四节写，每节一个小标题：
## 世界和基调
这是个什么样的世界，有什么规矩和体系，读起来是什么味道。
## 主线
按先后分成几段，每段几句：发生了什么，结果怎样。
## 主要人物
最要紧的人，一人一两句：是谁，想要什么，和别人什么关系。
## 主要势力
各自是什么，彼此什么关系。没有就不写这一节。

一共不超过 3000 字，用条目的语言写。名字照条目写，不改不译。直接输出梗概，不要前言。`

/** How much an entry matters in its book: how many stretches noted it. */
const weightOf = entry => Number(entry.parts) || 1

const byWeight = entries => [...entries].sort((a, b) => weightOf(b) - weightOf(a))

/** What the 梗概 is written from: the entries met most, shortened, a kind after another; the events in the book's order. */
export function digestMaterial(entries) {
  const take = (type, most, chars, sorted = true) => {
    const list = entries.filter(entry => entry.type === type)
    return (sorted ? byWeight(list) : list).slice(0, most).map(entry => `- ${entry.name}${entry.aliases?.length ? `（${entry.aliases.slice(0, 3).join('、')}）` : ''}：${clip(entry.content, chars)}`)
  }
  const blocks = [['人物', take('人物', 30, 500)], ['势力', take('势力', 12, 300)], ['设定', take('设定', 20, 300)], ['地点', take('地点', 12, 150)], ['事件', take('事件', 150, 160, false)]]
  let left = DIGEST_CHARS
  return blocks.flatMap(([type, lines]) => {
    const kept = []
    for (const line of lines) {
      if (line.length > left) break
      kept.push(line)
      left -= line.length
    }
    return kept.length ? [`<${type}>\n${kept.join('\n')}\n</${type}>`] : []
  }).join('\n\n')
}

/** The request that writes a book's 梗概 from its entries. */
export function digestRequest(name, entries) {
  return { system: DIGEST_SYSTEM, messages: [{ role: 'user', content: `<book name="${clip(name, 80).replace(/"/g, "'")}">\n${digestMaterial(entries)}\n</book>` }], maxTokens: DIGEST_TOKENS, softCap: true }
}

/** An answer as a 梗概: the text as it is, without a fence round it. */
export const readDigest = text => String(text ?? '').replace(/^```\w*\n|\n```\s*$/g, '').trim().slice(0, MAX_DIGEST)

const firstLine = (text, max) => {
  const flat = clip(text, max * 2)
  const end = flat.search(/[。！？；\n.!?;]/)
  return (end > 0 && end < max ? flat.slice(0, end) : flat.slice(0, max)).trim()
}

/**
 * 名录: every entry's name, a kind after another, the ones met most first. As many as fit get a line of what they
 * are; the rest are names only. No name is left out for room: the lines are, from the least met up.
 */
export function rosterText(entries, max = 20_000) {
  const groups = NOVEL_TYPES.map(type => [type, byWeight(entries.filter(entry => entry.type === type))]).filter(([, list]) => list.length)
  const write = lines => groups.map(([type, list]) => {
    const told = list.slice(0, lines).map(entry => `- ${entry.name}${entry.aliases?.length ? `（${entry.aliases.slice(0, 2).join('、')}）` : ''}：${firstLine(entry.content, 50)}`)
    const named = list.slice(lines).map(entry => entry.name)
    return [`【${type}】${list.length} 个`, ...told, named.length ? `其余：${named.join('、')}` : ''].filter(Boolean).join('\n')
  }).join('\n\n')
  for (const lines of [60, 40, 25, 15, 8, 3, 0]) {
    const text = write(lines)
    if (text.length <= max) return text
  }
  return write(0).slice(0, max)
}

/** What 创作角色卡 reads of a book: { name, digest, entries } → its 梗概 and 名录, with a word on what they are. */
export function novelMaterial({ name, digest, entries }) {
  const head = `这是小说《${name}》整理出来的资料，不是原文。书里一共记了 ${entries.length} 个条目，这里只有梗概和名录；写到某个人物或地方时，它的完整条目会另外给。名录里的名字是书里的原名，用到时照这个名字写。`
  const told = String(digest ?? '').trim().slice(0, MAX_DIGEST)
  const roster = rosterText(entries, MAX_MATERIAL - head.length - told.length - 40)
  return [head, told ? `# 梗概\n${told}` : '', `# 名录\n${roster}`].filter(Boolean).join('\n\n')
}

/** A stored worldbook as the entries of a book: one made by 从小说抽取 gets its kinds and its 梗概 back from its comments. */
export function bookSource(book) {
  let digest = ''
  const entries = []
  for (const entry of book.entries ?? []) {
    const content = String(entry.content ?? '').trim()
    if (!content || entry.enabled === false) continue
    const comment = String(entry.comment ?? '').trim()
    const [, kind, rest] = /^([^：:]{1,6})[：:]\s*(.+)$/.exec(comment) ?? []
    if (kind === DIGEST_MARK) {
      digest = content.slice(0, MAX_DIGEST)
      continue
    }
    const keys = (entry.keys ?? []).map(key => clip(key, MAX_NAME)).filter(Boolean)
    const name = clip(NOVEL_TYPES.includes(kind) ? rest : comment || keys[0], MAX_NAME)
    if (!name) continue
    entries.push({ type: NOVEL_TYPES.includes(kind) ? kind : '设定', name, aliases: keys.filter(key => key !== name).slice(0, 8), content, parts: entry.constant ? 3 : 1 })
  }
  return { name: book.name, digest, entries: entries.slice(0, MAX_ENTRIES) }
}

/** A note as the entry the page lists: what was put together, or its parts one after another. */
const entryOf = note => ({ type: note.type, name: note.name, aliases: note.aliases, content: note.merged ?? note.parts.join('\n'), parts: note.parts.length })

/**
 * The notes as a book a card is made from: the entries, each with where in the text it was first and last read
 * (`first`, `last`: stretches, 0 when not known), and one read in several places with its notes apart (`pieces`:
 * [[stretch, text]]), so that the card can take the book only as far as a point in it.
 */
export function sourceEntries(notes) {
  return entriesOf(notes).map((entry, i) => {
    const at = notes[i].at ?? []
    const known = at.length === notes[i].parts.length && at.every(n => n > 0)
    if (!known) return { ...entry, first: 0, last: 0 }
    return { ...entry, first: Math.min(...at), last: Math.max(...at), ...(at.length > 1 ? { pieces: notes[i].parts.map((text, part) => [at[part], text]) } : {}) }
  })
}

// What anyone may be called: as another name of one person it would bring their entry whenever the word is said.
// A reader is told not to write these as aliases; one written all the same is dropped. (A name is never dropped.)
const GENERIC = new Set(['先生', '老师', '师父', '师傅', '师爷', '大人', '老爷', '少爷', '公子', '小姐', '姑娘', '夫人', '太太', '掌柜', '掌柜的', '老板', '老板娘', '东家', '大哥', '大姐', '大嫂', '大叔', '大伯', '大娘', '大爷', '老头', '老头子', '老人', '老人家', '老伯', '老汉', '老太太', '婆婆', '阿婆', '孩子', '小孩', '娃娃', '丫头', '小子', '少年', '少女', '男人', '女人', '那人', '此人', '哥哥', '姐姐', '弟弟', '妹妹', '哥', '姐', '爹', '娘', '爸', '妈', '父亲', '母亲', '爷爷', '奶奶', '叔叔', '阿姨', '师兄', '师姐', '师弟', '师妹', '徒弟', '陛下', '殿下', '皇上', '将军', '大夫', '郎中', '道长', '大师', '和尚', '客官', '恩人', '主人', '他', '她', '它', '你', '我'])

/**
 * The notes as entries, their other names put right: a way of calling that is another entry's own name is that
 * entry's, and one that several claim stays with the least met of them (the one everything happens round gathers
 * other people's names). Otherwise a mention of one would bring the other's entry.
 */
export function entriesOf(notes) {
  const entries = notes.map(entryOf)
  const named = new Set(entries.map(entry => keyOf(entry.name)))
  const claims = new Map()
  for (const entry of entries) for (const alias of entry.aliases) claims.set(keyOf(alias), [...(claims.get(keyOf(alias)) ?? []), entry])
  const keeps = (entry, alias) => {
    const key = keyOf(alias)
    if (named.has(key) || GENERIC.has(alias.trim())) return false
    const all = claims.get(key)
    return all.length < 2 || all.reduce((least, other) => (other.parts < least.parts ? other : least)) === entry
  }
  return entries.map(entry => ({ ...entry, aliases: entry.aliases.filter(alias => keeps(entry, alias)) }))
}

/** The entries picked, as a worldbook: found when the chat names them, by name and by what else they are called. */
/** Whether an entry has a name long enough to be found by: one character is in every other sentence. */
export const findable = entry => [entry.name, ...(entry.aliases ?? [])].some(key => String(key).trim().length >= 2)

export function novelBook(name, entries, digest = '') {
  const typed = NOVEL_TYPES.flatMap(type => entries.filter(entry => entry.type === type))
  const told = String(digest ?? '').trim().slice(0, MAX_DIGEST)
  // 梗概: always there, before the rest, so the model knows the whole of the book whatever the chat names.
  // It is the first of the list too. (Keys that are numbers are kept in their order, so it takes 0 and the rest follow.)
  const first = told ? [['0', { uid: 0, key: [], comment: `${DIGEST_MARK}：${name}`, content: told, constant: true, order: 50, position: 0 }]] : []
  return normalizeBook({
    entries: Object.fromEntries([...first, ...typed.map((entry, i) => [String(i + first.length), {
      uid: i + first.length,
      // A keyword of one character fires everywhere: such a name is found by its longer names, when it has any.
      key: ((keys => (keys.some(key => key.length >= 2) ? keys.filter(key => key.length >= 2) : keys))([...new Set([entry.name, ...entry.aliases])])).slice(0, 8),
      comment: `${entry.type}：${entry.name}`,
      content: entry.content,
      // One with no longer name (劫, 觉) is kept but off: on, it would be sent nearly every turn. It is the player's to
      // give a longer keyword and turn on.
      enabled: findable(entry),
      constant: false,
      order: 100,
      position: 1,
      // Notes on the book name each other in nearly every entry: with 递归 on, one would bring the rest. Found
      // through others they may be; finding others is the player's to turn on (不触发别的条目).
      preventRecursion: true,
    }])]),
  }, name, { standalone: true })
}

/**
 * What reading comes to before it starts: { stretches, input, output, outputMost } for the stretches still to read.
 * A stretch cut here carries its tokens; one kept from before that did not is worked out from `text`.
 */
export function novelEstimate(text, stretches, from = 0) {
  const left = stretches.slice(from)
  const system = estimateTokens(EXTRACT_SYSTEM)
  const tokensOf = stretch => stretch.tokens ?? estimateTokens(text.slice(stretch.from, stretch.to))
  // A real run (2026-11-11, 62 000 characters in six stretches) took 1.35 times what the text alone is estimated at:
  // the names noted so far go with every stretch, and prose counts for more than the estimate allows.
  const input = left.reduce((sum, stretch) => sum + Math.round(tokensOf(stretch) * 1.35) + system + 300, 0)
  // What is written back: a dense novel gives forty notes a stretch. A real run (2026-11-13, 298 000 characters in 34
  // stretches, deepseek-flash) wrote 413 000 tokens against 313 000 read, putting together and thinking included:
  // about 1.2 times the text. A sparse text writes less; the least a stretch is counted at is EXTRACT_OUTPUT.
  const output = left.reduce((sum, stretch) => sum + Math.max(EXTRACT_OUTPUT, Math.round(tokensOf(stretch) * 1.2)), 0)
  // A model that thinks a lot writes about twice that: deepseek-v4.1-flash, 2026-11-16, 8 stretches of 73 000
  // characters, 133 000 to 171 000 against 75 000 estimated.
  return { stretches: left.length, input, output, outputMost: output * 2 + Math.round(input * 0.1) }
}

/**
 * `task(item)` for each of `items`, `width` at a time, in their order. The first failure starts no more and is thrown
 * once those under way are done (what they gave is kept); stopping starts no more either.
 */
async function pooled(items, width, signal, task) {
  let next = 0
  let failure = null
  const worker = async () => {
    while (!failure && !signal.aborted && next < items.length) {
      const item = items[next++]
      try {
        await task(item)
      } catch (error) {
        failure ??= error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  if (failure) throw failure
}

/**
 * @param deps - from createForge: { store, load, save, serial, run, jobs, cutNote, fileOf(id): the session's file }
 */
export function createNovel({ store, load, save, serial, run, jobs, cutNote, fileOf }) {
  const textFile = () => fileOf(NOVEL_ID).replace(/\.json$/, '.txt')
  const readText = () => readFile(textFile(), 'utf8').catch(() => '')

  async function loadNovel() {
    return load(NOVEL_ID).catch(error => {
      if (error.status !== 404) throw error
      return null
    })
  }

  async function view(session) {
    if (!session) return { novel: null }
    const job = jobs.get(NOVEL_ID)
    // The text (up to 15 MB) only for stretches cut before they carried their tokens: the page asks every few seconds.
    const text = session.stretches.every(stretch => stretch.tokens != null) ? '' : await readText()
    const limit = Math.min(session.limit || session.stretches.length, session.stretches.length)
    const ref = session.model || (await store.getSettings()).model || ''
    const ready = isProviderRef(ref)
    const estimate = novelEstimate(text, session.stretches.slice(0, limit), Math.min(session.done, limit))
    // What is past the part asked for: said when that part is read, for going on to the end.
    const rest = novelEstimate(text, session.stretches, Math.max(session.done, limit))
    const priced = (input, output) => (ready ? estimateCost(ref.slice(ref.indexOf('/') + 1), { input, output }) : null)
    const costOf = ({ input, output, outputMost }) => ({ cost: priced(input, output), costMost: priced(input, outputMost) })
    const entries = entriesOf(session.notes)
    return {
      novel: {
        name: session.name,
        chars: session.chars,
        stretches: session.stretches.map(stretch => ({ title: stretch.title, chars: stretch.to - stretch.from })),
        limit,
        done: session.done,
        // 'reading' till every stretch asked for is read, 'merging' till the names noted more than once are put together, then 'ready'.
        stage: session.done < limit ? 'reading' : session.merged ? 'ready' : 'merging',
        toMerge: mergeBatches(session.notes.filter(note => !note.merged), mergeSize(parallelOf(session))).length,
        failed: session.failed ?? [],
        entries,
        // 梗概: '' till it is asked for; `digestStale` when more was read since it was written.
        digest: session.digest ?? '',
        digestStale: Boolean(session.digest) && session.digestAt !== session.done,
        counts: Object.fromEntries(NOVEL_TYPES.map(type => [type, entries.filter(entry => entry.type === type).length])),
        model: session.model ?? '',
        parallel: parallelOf(session),
        estimate: { ready, model: ready ? (refLabel(ref, await store.getProviders()) ?? ref) : '', ...estimate, ...costOf(estimate) },
        rest: { ...rest, ...costOf(rest) },
        job: job ? { kind: job.kind, step: job.step, startedAt: job.startedAt } : null,
        error: session.error?.message ?? '',
      },
    }
  }

  /**
   * Read the stretches still to read, `parallel` at a time, then put together what was noted more than once, as many
   * batches at a time. Each stretch's notes are kept as they come.
   */
  async function work(ctx) {
    const text = await readText()
    let session = await load(NOVEL_ID)
    const limit = Math.min(session.limit || session.stretches.length, session.stretches.length)
    const width = parallelOf(session)
    try {
      await readStretches(ctx, text, session, limit, width)
      session = await load(NOVEL_ID)
      if (ctx.signal.aborted || session.done < limit) return
      await mergeNotes(ctx, session, width)
    } catch (error) {
      // Several requests at once can be more than a provider lets through.
      if (width > 1 && !ctx.signal.aborted && (error.status === 429 || /\b429\b|rate.?limit|too many requests|concurren|限流|并发|频率/i.test(error.message))) {
        throw httpError(error.status || 502, msg`${error.message}（同时读的段多了，供应商可能限流：把「同时读」调小，再点「接着抽」）`)
      }
      throw error
    }
    if (ctx.signal.aborted) return
    await ctx.update(draft => {
      draft.merged = true
    })
  }

  /**
   * The stretches from `done` to `limit`, `width` at a time. A stretch read before the ones ahead of it waits in
   * `ahead` (its notes, or null for one that would not read) till they are in, so the notes go in in the book's order
   * as when they are read one at a time; a stretch already waiting there from a stopped run is not read again. A
   * stretch is sent with the names gathered by then: read at once, a few miss the names of the ones beside them, which
   * gathering by name and alias makes up for. With nothing gathered yet the first is read alone: the ones after it
   * then have its names (a real run, 2026-11-16, four at once from the start: 167 entries for 126 one at a time, many
   * of them the same person or thing under another name).
   */
  async function readStretches(ctx, text, session, limit, width) {
    const waiting = session.ahead ?? {}
    const todo = []
    for (let i = session.done; i < limit; i++) if (!(i in waiting)) todo.push(i)
    let finished = limit - todo.length
    // How many are being read this moment: the page says so when it is more than one (同时读).
    let reading = 0
    const tell = () => ctx.step(`read:${Math.min(finished + 1, limit)}:${limit}:${reading}`, { same: true })
    ctx.step(`read:${Math.min(finished + 1, limit)}:${limit}:0`)
    const readOne = async i => {
      reading += 1
      tell()
      try {
        await readStretch(i)
      } finally {
        reading -= 1
      }
      finished += 1
      tell()
    }
    const readStretch = async i => {
      const stretch = session.stretches[i]
      // The names met most often first: with more of them than a request lists, those are the ones to keep to.
      const known = [...session.notes].sort((a, b) => b.parts.length - a.parts.length).map(note => note.name)
      const request = extractRequest(text.slice(stretch.from, stretch.to), stretch.title, known)
      let found = null
      // An answer that is no list is asked for once more; a stretch that will not read is left out and named.
      for (let attempt = 0; attempt < 2 && !found; attempt++) {
        const result = await ctx.call(request)
        found = readExtract(result.text)
        if (!found && attempt === 1 && result.truncated) found = []
      }
      session = await ctx.update(draft => {
        draft.ahead = { ...draft.ahead, [i]: found }
        while (draft.done < limit && draft.done in draft.ahead) {
          const notes = draft.ahead[draft.done]
          delete draft.ahead[draft.done]
          if (notes) gather(draft.notes, notes, draft.done + 1)
          else draft.failed = [...(draft.failed ?? []), draft.done + 1]
          draft.done += 1
        }
        draft.merged = false
      })
    }
    if (width > 1 && !session.notes.length && todo.length > 1) await pooled([todo.shift()], 1, ctx.signal, readOne)
    await pooled(todo, width, ctx.signal, readOne)
  }

  /** The names noted more than once, each made one entry: the batches `width` at a time. */
  async function mergeNotes(ctx, session, width) {
    const batches = mergeBatches(session.notes.filter(note => !note.merged), mergeSize(width))
    let finished = 0
    if (batches.length) ctx.step(`merge:1:${batches.length}`)
    await pooled(batches, width, ctx.signal, async batch => {
      // A name with more notes than a request holds: the notes a part at a time, then the parts.
      const items = []
      for (const note of batch) {
        let parts = note.parts
        while (parts.join('').length > MERGE_CHARS * 2 && parts.length > 2) {
          const groups = []
          for (const part of parts) {
            const last = groups.at(-1)
            if (last && last.join('').length + part.length <= MERGE_CHARS) last.push(part)
            else groups.push([part])
          }
          if (groups.length >= parts.length) break
          const shorter = []
          for (const group of groups) {
            if (group.length === 1) shorter.push(group[0])
            else shorter.push(readMerge((await ctx.call(mergeRequest([{ name: note.name, parts: group }]))).text).get(keyOf(note.name)) ?? group.join('\n'))
          }
          parts = shorter
        }
        items.push({ name: note.name, parts })
      }
      const result = await ctx.call(mergeRequest(items))
      const merged = readMerge(result.text)
      await ctx.update(draft => {
        for (const item of items) {
          const note = draft.notes.find(found => found.name === item.name)
          // What the model left out stays as its notes one after another: nothing is lost for it.
          if (note) note.merged = merged.get(keyOf(item.name)) ?? note.parts.join('\n')
        }
      })
      finished += 1
      ctx.step(`merge:${Math.min(finished + 1, batches.length)}:${batches.length}`, { same: true })
    })
  }

  /** The 梗概 of what was read, from its entries: one request. */
  async function digestWork(ctx) {
    const session = await load(NOVEL_ID)
    ctx.step('digest:1:1')
    const result = await ctx.call(digestRequest(session.name, entriesOf(session.notes)))
    const digest = readDigest(result.text)
    if (!digest) throw httpError(502, msg`模型没有写出梗概，再试一次或换个模型`)
    await ctx.update(draft => {
      draft.digest = digest
      draft.digestAt = draft.done
    })
  }

  /** The book as it stands, for what is made of it elsewhere: { name, digest, entries }. Only one read and put together. */
  async function readyNovel() {
    refuseWhileBusy()
    const session = await loadNovel()
    if (!session) throw httpError(404, msg`还没有选小说`)
    if (!session.merged || !session.notes.length) throw httpError(409, msg`这部小说还没读完，读完再用它做卡`)
    return { name: session.name, digest: session.digest ?? '', entries: sourceEntries(session.notes), stretches: session.stretches.slice(0, session.done).map(stretch => stretch.title || '') }
  }

  const refuseWhileBusy = () => {
    if (jobs.has(NOVEL_ID)) throw httpError(409, msg`正在读这部小说，等它读完或先停下`)
  }

  return {
    async novelGet() {
      return view(await loadNovel())
    },

    /** A text to read: cut into stretches and kept, nothing sent. One at a time: it takes the place of the one before. */
    async novelStart({ name, text } = {}) {
      refuseWhileBusy()
      const whole = String(text ?? '').replace(/\r\n?/g, '\n').replace(/^﻿/, '').trim()
      if (whole.length < MIN_NOVEL) throw httpError(400, msg`这个文件太短了，不用分段抽取：直接在世界书里「用对话来写」，把内容贴给向导`)
      if (whole.length > MAX_NOVEL) throw httpError(400, msg`这个文件有 ${whole.length.toLocaleString()} 字，最多读 ${MAX_NOVEL.toLocaleString()} 字。先拆成几个文件，一个一个来`)
      const stretches = splitNovel(whole)
      if (stretches.length > MAX_STRETCHES) throw httpError(400, msg`这个文件切出来有 ${stretches.length} 段，最多读 ${MAX_STRETCHES} 段。先拆成几个文件，一个一个来`)
      const now = new Date().toISOString()
      const session = { id: NOVEL_ID, kind: 'novel', name: clip(String(name ?? '').replace(/\.(txt|md|text)$/i, ''), 80) || msg`小说`, chars: whole.length, createdAt: now, updatedAt: now, model: '', job: null, error: null, stretches, limit: 0, done: 0, notes: [], failed: [], merged: false }
      // The session first: saving it makes the folder the text goes in beside it.
      await serial(NOVEL_ID, () => save(session))
      await writeFile(textFile(), whole, 'utf8')
      return view(session)
    },

    /** How many stretches to read (0 = all of them), how many at once, and the model to read with. */
    async novelUpdate({ limit, model, parallel, digest } = {}) {
      refuseWhileBusy()
      return serial(NOVEL_ID, async () => {
        const session = await loadNovel()
        if (!session) throw httpError(404, msg`还没有选小说`)
        if (limit !== undefined) session.limit = Math.max(0, Math.min(session.stretches.length, Math.round(Number(limit)) || 0))
        if (typeof model === 'string') session.model = model.trim().slice(0, 200)
        if (parallel !== undefined) session.parallel = Math.max(1, Math.min(MAX_PARALLEL, Math.round(Number(parallel)) || PARALLEL))
        // The 梗概 as the player changed it: theirs from here on, for this much of the book.
        if (typeof digest === 'string') {
          session.digest = digest.trim().slice(0, MAX_DIGEST)
          session.digestAt = session.done
        }
        await save(session)
        return view(session)
      })
    },

    /** Read on from where it stopped: sent only by this. */
    async novelRun() {
      const session = await loadNovel()
      if (!session) throw httpError(404, msg`还没有选小说`)
      await run(session, 'novel', work)
      return view(await loadNovel())
    },

    /** Write the 梗概 of what was read: sent only by this. */
    async novelDigest() {
      const session = await loadNovel()
      if (!session) throw httpError(404, msg`还没有选小说`)
      if (!session.merged || !session.notes.length) throw httpError(409, msg`这部小说还没读完，读完再写梗概`)
      await run(session, 'novel', digestWork)
      return view(await loadNovel())
    },

    readyNovel,

    novelStop() {
      const job = jobs.get(NOVEL_ID)
      job?.controller.abort()
      return { stopped: Boolean(job) }
    },

    /** The entries picked (by name; all of them when none are named) as a new worldbook. */
    async novelSave({ name, picked, digest = true } = {}) {
      refuseWhileBusy()
      const session = await loadNovel()
      if (!session) throw httpError(404, msg`还没有选小说`)
      const wanted = Array.isArray(picked) ? new Set(picked.map(String)) : null
      const entries = entriesOf(session.notes).filter(entry => !wanted || wanted.has(entry.name))
      if (!entries.length) throw httpError(400, msg`一条都没选`)
      const book = novelBook(clip(name, 100) || session.name, entries, digest === false ? '' : session.digest)
      await store.saveBook(book)
      return { id: book.id, name: book.name, entries: book.entries.length, off: entries.filter(entry => !findable(entry)).length }
    },

    /** Done with it: the text and what was noted go. */
    async novelDrop() {
      jobs.get(NOVEL_ID)?.controller.abort()
      await rm(fileOf(NOVEL_ID), { force: true })
      await rm(textFile(), { force: true })
      return { novel: null }
    },
  }
}
