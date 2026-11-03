// 长期记忆（Beta）: a 记忆簿 of entries (people, events, things and places, promises and
// foreshadowing) written down when the story is compacted and, optionally, every few turns
// (边玩边整理), so that details a compaction summarised away come back when they are talked
// about again. Each snapshot is the whole book, kept on the node it was written at (a compaction
// point's `compaction.memory`, a reply's `memory`): the one in force is the latest on the path,
// so branches, rollbacks and regenerations take it along. Recall rides in the turn's own message
// (<往事>, prompt.mjs), never in the frozen prefix, and only brings back what the model no longer
// has: entries from turns before the latest compaction.
import { replaceMacros } from './prompt.mjs'
import { newId } from './store.mjs'
import { withoutHidden } from './recap.mjs'
import { MEMORY_DEFAULTS } from './context.mjs'

// settings.memory is cleaned where the settings are (context.mjs cleanMemory, which the launcher's store loads).
export { cleanMemory, MEMORY_DEFAULTS } from './context.mjs'

export const KINDS = ['person', 'event', 'thing', 'promise']
/** The four kinds as the model writes and the page shows them. */
export const KIND_LABELS = Object.freeze({ person: '人物', event: '事件', thing: '物品与地点', promise: '约定与伏笔' })
const KIND_WORDS = [
  [/^(人物|角色|人)$/, 'person'],
  [/^(事件|经历|经过|事)$/, 'event'],
  [/^(物品与地点|物品和地点|物品|地点|场所|道具|物|地)$/, 'thing'],
  [/^(约定与伏笔|约定和伏笔|约定|伏笔|承诺|悬念|线索)$/, 'promise'],
]
const REMOVE_WORD = /^(删除|删去|移除|作废)$/

// A book of this many entries at most (a few hundred is tens of KB on each snapshot).
export const MAX_ENTRIES = 300
const TITLE_MAX = 40
const TEXT_MAX = 600
const KEYS_MAX = 12
// Entries one turn recalls at most, besides the characters of settings.memory.budget.
export const RECALL_MAX = 8
// The first tidy of a long story reads this many of its latest turns at most.
export const TIDY_FIRST_MAX = 30

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const titleKey = title => String(title ?? '').replace(/\s+/g, '').toLowerCase()
const splitKeys = text =>
  String(text ?? '')
    .split(/[,，、;；/]/)
    .map(key => key.replace(/[「」『』"“”]/g, '').trim())
    .filter(key => key && key.length <= 30)

/** An entry as the book keeps it, or null when it has no title or text. */
export function cleanEntry(raw, { keepId = true } = {}) {
  if (!isObject(raw)) return null
  const title = String(raw.title ?? '').trim().slice(0, TITLE_MAX)
  const text = String(raw.text ?? '').trim().slice(0, TEXT_MAX)
  if (!title || !text) return null
  const keys = [...new Set((Array.isArray(raw.keys) ? raw.keys.map(String) : splitKeys(raw.keys)).map(key => key.trim()).filter(key => key && titleKey(key) !== titleKey(title)))].slice(0, KEYS_MAX)
  const entry = { id: keepId && typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : newId(), kind: KINDS.includes(raw.kind) ? raw.kind : 'event', title, keys, text }
  const turn = value => (Number.isInteger(value) && value >= 0 ? value : undefined)
  if (turn(raw.from) !== undefined) entry.from = raw.from
  if (turn(raw.to) !== undefined) entry.to = Math.max(raw.to, entry.from ?? 0)
  if (raw.pinned === true) entry.pinned = true
  // Written or changed by the player: the model's later notes leave it as it is.
  if (raw.edited === true) entry.edited = true
  return entry
}

// One entry's first line: [类别] 标题 | 关键词, tolerant of the brackets, list marks and bold a model adds.
const HEADER = /^(?:[-*>•]\s*)?\**\s*[[【［]\s*([^\]】］]{1,8}?)\s*[\]】］]\s*\**\s*(.*)$/

/**
 * The entries a reply wrote in its <记忆条目> block (the last one), one per [类别] line with its
 * text on the lines below: { entries: [{ kind, title, keys, text }], removed: [title] }, or null
 * when the reply has no such block. Lines it cannot read are skipped.
 */
export function parseEntries(reply) {
  let text = String(reply ?? '')
  const open = text.lastIndexOf('<记忆条目>')
  if (open < 0) return null
  text = text.slice(open + '<记忆条目>'.length)
  const close = text.indexOf('</记忆条目>')
  if (close >= 0) text = text.slice(0, close)
  const entries = []
  const removed = []
  let current = null
  const finish = () => {
    if (current?.title && current.lines.length) entries.push({ kind: current.kind, title: current.title, keys: current.keys, text: current.lines.join('\n') })
    current = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^[.…。、\s]+$/.test(line)) continue
    const header = HEADER.exec(line)
    // A bracket that is not one of the kinds ([第12轮], 【注】) is part of the text.
    const word = header?.[1].replace(/\s+/g, '')
    const kind = header && KIND_WORDS.find(([pattern]) => pattern.test(word))?.[1]
    if (kind || (header && REMOVE_WORD.test(word))) {
      finish()
      const [title = '', keys = ''] = header[2].replace(/\*+$/, '').split(/\s*[|｜]\s*/)
      const cleanTitle = title.replace(/^\**|\**$/g, '').trim()
      if (kind) current = { kind, title: cleanTitle.slice(0, TITLE_MAX), keys: splitKeys(keys), lines: [] }
      else if (cleanTitle) removed.push(cleanTitle)
      continue
    }
    if (current) current.lines.push(line.replace(/^[-*•]\s+/, ''))
  }
  finish()
  return { entries, removed }
}

/**
 * The book after a model's notes: an entry under a title already there takes its place (same id,
 * pinned kept), a new title is added, a removed one goes. Entries the player wrote or changed
 * (`edited`) stay as they are. `locate` gives each changed entry its source turns.
 */
export function mergeEntries(entries, notes, { locate = () => ({}) } = {}) {
  if (!notes) return entries
  const gone = new Set((notes.removed ?? []).map(titleKey))
  const book = entries.filter(entry => entry.edited || !gone.has(titleKey(entry.title)))
  for (const note of notes.entries ?? []) {
    const fresh = cleanEntry({ ...note, from: undefined, to: undefined }, { keepId: false })
    if (!fresh) continue
    const at = book.findIndex(entry => titleKey(entry.title) === titleKey(fresh.title))
    if (at >= 0 && book[at].edited) continue
    const merged = at >= 0 ? { ...book[at], kind: fresh.kind, keys: fresh.keys, text: fresh.text } : fresh
    const found = locate(merged)
    if (found.from !== undefined) Object.assign(merged, { from: found.from, to: found.to })
    if (at >= 0) book[at] = merged
    else book.push(merged)
  }
  // Too many: the oldest notes the player has not pinned or written go first.
  while (book.length > MAX_ENTRIES) {
    const drop = book.findIndex(entry => !entry.pinned && !entry.edited)
    book.splice(drop < 0 ? 0 : drop, 1)
  }
  return book
}

/**
 * The turns on `path` as numbers and texts: [{ turn, id, text }], `id` the player's message.
 * Numbered as storyTurns counts them (an imported story's turns before its root first); hidden
 * rounds keep their number but are left out.
 */
export function turnTexts(path) {
  let turn = path[0]?.compaction?.imported ? Number(path[0].compaction.turns) || 0 : 0
  const turns = []
  path.forEach((node, index) => {
    if (node.role !== 'user') return
    turn++
    const reply = path[index + 1]
    if (node.hidden || reply?.hidden) return
    turns.push({ turn, id: node.id, user: node.text ?? '', reply: reply?.text ?? '' })
  })
  return turns
}

/** The keys an entry is found by: its title and its keys, two characters or more. */
const keysOf = entry => [entry.title, ...(entry.keys ?? [])].map(key => key.toLowerCase()).filter(key => key.length >= 2)

/**
 * Where an entry comes from: the first and last of `turns` (turnTexts) that name it, within
 * `range` ({ from, to }) when given; none named, the range itself.
 */
export function locateEntry(entry, turns, range = null) {
  const keys = keysOf(entry)
  const inRange = range ? turns.filter(item => item.turn >= range.from && item.turn <= range.to) : turns
  const hits = inRange.filter(item => {
    const text = `${item.user}\n${item.reply}`.toLowerCase()
    return keys.some(key => text.includes(key))
  })
  if (hits.length) return { from: hits[0].turn, to: hits.at(-1).turn }
  return range ? { from: range.from, to: range.to } : {}
}

/**
 * `locate` for mergeEntries: a new entry is placed where it is named among the turns this write
 * read (`range`), else on all of them; one already in the book keeps its first turn and now
 * reaches to the last.
 */
export function placeEntries(turns, range) {
  return entry => {
    const found = locateEntry(entry, turns, range)
    if (entry.from === undefined) return found
    return { from: Math.min(entry.from, found.from ?? entry.from), to: Math.max(entry.to ?? entry.from, found.to ?? entry.from) }
  }
}

/**
 * The snapshot in force on `path`: the latest written on it (a compaction point's or a reply's),
 * with `nodeId` where it is kept, or null.
 */
export function memoryOf(path) {
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i]
    const own = node.memory
    const compacted = node.compaction?.memory
    const snapshot = own && compacted ? (String(own.at) > String(compacted.at) ? own : compacted) : own ?? compacted
    if (snapshot) return { ...snapshot, nodeId: node.id, onCompaction: snapshot === compacted }
  }
  return null
}

/** A snapshot as nodes keep it. */
export function snapshotOf(entries, { turns, model = null, by }) {
  return { entries, turns, at: new Date().toISOString(), model, by }
}

// Pairs of characters too common to say what a text is about.
const COMMON = new Set(
  '的是 一个 我们 你们 他们 她们 自己 什么 没有 这个 那个 这样 那样 已经 还是 就是 不是 可以 知道 时候 现在 然后 因为 所以 但是 如果 一下 一样 一起 起来 出来 过来 回来 下来 这里 那里 怎么 为什么 不会 不要 一点 有点 觉得 看着 说道 轻轻 微微 似乎 仿佛 只是 还有 一边 声音 目光 眼睛 东西 事情'.split(/\s+/),
)
const HAN = /[㐀-鿿]/

/** The distinct pairs of Chinese characters in `text`, the common ones left out. */
export function bigrams(text) {
  const pairs = new Set()
  const chars = [...String(text ?? '')]
  for (let i = 0; i < chars.length - 1; i++) {
    if (!HAN.test(chars[i]) || !HAN.test(chars[i + 1])) continue
    const pair = chars[i] + chars[i + 1]
    if (!COMMON.has(pair)) pairs.add(pair)
  }
  return pairs
}

/**
 * What this turn recalls from `snapshot`: entries from turns up to `compactedTurns` (the ones
 * before that are out of the model's context), not recalled since that compaction (`recalled`,
 * ids). Pinned entries first; then those whose title or keys `scanText` names (the more the
 * earlier, then the newer); then, among the rest, those sharing at least three uncommon pairs of
 * characters with `focusText` (the input and the reply before it). Within `budget` characters and
 * RECALL_MAX entries, one kind at most half the budget while others are waiting.
 */
export function recallEntries(snapshot, { compactedTurns, recalled = new Set(), scanText = '', focusText = '', budget = MEMORY_DEFAULTS.budget }) {
  if (!snapshot?.entries?.length || !(compactedTurns > 0)) return []
  const pool = snapshot.entries.filter(entry => (entry.from ?? 0) <= compactedTurns && !recalled.has(entry.id))
  if (!pool.length) return []
  const scan = String(scanText).toLowerCase()
  // How many entries hold a pair: a pair most of the book shares says nothing about one of them.
  const pairsOf = new Map(pool.map(entry => [entry, bigrams(`${entry.title} ${(entry.keys ?? []).join(' ')} ${entry.text}`)]))
  const spread = new Map()
  for (const pairs of pairsOf.values()) for (const pair of pairs) spread.set(pair, (spread.get(pair) ?? 0) + 1)
  const rare = Math.max(1, Math.floor(pool.length * 0.2))
  const focus = bigrams(focusText)
  const scored = pool.map(entry => {
    const hits = keysOf(entry).filter(key => scan.includes(key)).length
    const shared = hits ? 0 : [...pairsOf.get(entry)].filter(pair => focus.has(pair) && spread.get(pair) <= rare).length
    return { entry, hits, shared }
  })
  const ordered = [
    ...scored.filter(item => item.entry.pinned),
    ...scored.filter(item => !item.entry.pinned && item.hits > 0).sort((a, b) => b.hits - a.hits || (b.entry.to ?? 0) - (a.entry.to ?? 0)),
    ...scored.filter(item => !item.entry.pinned && !item.hits && item.shared >= 3).sort((a, b) => b.shared - a.shared),
  ]
  const kinds = new Set(ordered.map(item => item.entry.kind))
  const half = Math.floor(budget / 2)
  const picked = []
  const perKind = {}
  let used = 0
  for (const { entry } of ordered) {
    const size = entry.title.length + entry.text.length + 8
    if (picked.length >= RECALL_MAX || used + size > budget) continue
    if (!entry.pinned && kinds.size > 1 && (perKind[entry.kind] ?? 0) + size > half) continue
    picked.push(entry)
    used += size
    perKind[entry.kind] = (perKind[entry.kind] ?? 0) + size
  }
  return picked
}

/** The <往事> block body: the recalled entries as the turn's message carries them. */
export function memoryText(entries) {
  if (!entries.length) return ''
  return [
    '以下是更早剧情里和这一轮有关的记忆（那部分对话已经收起，模型看不到原文）。用来保持前后一致，不要复述，也不要提到这份记录。',
    ...entries.map(entry => `【${KIND_LABELS[entry.kind]}｜${entry.title}】${entry.text}`),
  ].join('\n')
}

/** Entries the player messages since the last compaction on `path` recalled (their ids). */
export function recalledSince(path) {
  const ids = new Set()
  const start = path.findLastIndex(node => node.compaction) + 1
  for (const node of withoutHidden(path.slice(start))) for (const id of node.recalled ?? []) ids.add(id)
  return ids
}

const FORMAT = `格式：每条第一行是「[类别] 标题 | 关键词」，下面一行起是正文。例如：
[人物] 林雪 | 林雪, 雪儿, 班长
学生会长，表面冷淡；在天台承认讨厌被叫"会长"。答应过文化祭后陪{{user}}去看海。
[约定] 看海之约 | 看海, 海边, 文化祭
文化祭结束后的周末，{{user}}和林雪约好一起去看海，还没有去。

- 类别只用这四种：人物、事件、物品与地点、约定与伏笔。
- 标题简短，一件事一个标题。关键词写这件事以后在对话里会怎么被提到：人名、别名、称呼、地名、物品名，用逗号隔开。
- 正文写具体的事实：发生了什么、说过的原话、约定、物品的来历和去向、地点的样子，一两句到一小段，不超过 150 字。
- 不要记变量和数值（好感度、金钱、物品数量这些另有记录），不要记文风，不要评论。`

/** The existing book for the model: titles, with the people's entries in full (they are rewritten as they change). */
function existingNote(entries) {
  if (!entries.length) return '记忆簿现在是空的。'
  const people = entries.filter(entry => entry.kind === 'person')
  const others = entries.filter(entry => entry.kind !== 'person')
  return [
    '记忆簿里已经有这些条目（同一件事沿用原标题，写出来就整条替换；没有变化的不用再写；已经不成立的写一行「[删除] 标题」）：',
    ...people.map(entry => `[人物] ${entry.title} | ${(entry.keys ?? []).join(', ')}\n${entry.text}`),
    others.length ? `其他条目的标题：${others.map(entry => `[${KIND_LABELS[entry.kind]}] ${entry.title}`).join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** What the compaction's request adds after asking for the archive (recap.mjs summaryInstruction). */
export function memoryRequest(names, entries) {
  return replaceMacros(
    `另外，在 </剧情存档> 之后，再写一段 <记忆条目>，放在 <记忆条目> 和 </记忆条目> 之间：把这段剧情里以后可能用得上的具体事实记成一条条。压缩之后这些细节会从上下文里消失，以后提到时靠它们找回来。人物条目按最新情况重写。

${FORMAT}

${existingNote(entries)}`,
    names,
  )
}

/**
 * The request for an archive's entries alone, when the archive came without them: the same
 * history, then this.
 */
export function memoryOnlyInstruction(names, entries) {
  return replaceMacros(
    `【暂停扮演：整理记忆】
这一条不是剧情，是系统请求，请不要续写故事。
请把上面这段剧情里以后可能用得上的具体事实记成一条条记忆，放在 <记忆条目> 和 </记忆条目> 之间，只输出这一段。

${FORMAT}

${existingNote(entries)}`,
    names,
  )
}

/** 边玩边整理 by the chat's model: its history, then this, about the last `turns` turns. */
export function tidyInContext(names, entries, turns, firstInput) {
  return replaceMacros(
    `【暂停扮演：整理记忆】
这一条不是剧情，是系统请求，请不要续写故事。
请只整理最近 ${turns} 轮（从{{user}}说「${String(firstInput).slice(0, 40)}」那一轮开始）里以后可能用得上的具体事实，记成一条条记忆，放在 <记忆条目> 和 </记忆条目> 之间，只输出这一段。人物条目按最新情况重写。

${FORMAT}

${existingNote(entries)}`,
    names,
  )
}

/** 边玩边整理 by the helper model, which reads only these turns: { system, user }. */
export function tidyRequest(names, entries, turns) {
  const story = turns.map(item => `〔第 ${item.turn} 轮〕\n【{{user}}】${item.user.trim()}\n【{{char}}】${item.reply.trim()}`).join('\n\n')
  return {
    system: replaceMacros('你在帮一部长篇互动小说整理「记忆簿」：从剧情原文里把以后可能用得上的具体事实记成一条条，供以后的章节查阅。只整理，不续写，不评论。', names),
    user: replaceMacros(
      `${existingNote(entries)}

下面是最近 ${turns.length} 轮的原文（{{user}}是玩家，{{char}}一方是角色和叙述）：

<原文>
${story}
</原文>

把这几轮里以后可能用得上的具体事实记成一条条记忆，放在 <记忆条目> 和 </记忆条目> 之间，只输出这一段。人物条目按最新情况重写。

${FORMAT}`,
      names,
    ),
  }
}

/** The book as a SillyTavern world file: each entry by its title and keys, the pinned ones always on. */
export function memoryWorldFile(entries, name) {
  return {
    name,
    entries: Object.fromEntries(
      entries.map((entry, index) => [
        index,
        {
          uid: index,
          key: [entry.title, ...(entry.keys ?? [])],
          keysecondary: [],
          comment: `${KIND_LABELS[entry.kind]}｜${entry.title}`,
          content: entry.text,
          constant: entry.pinned === true,
          selective: true,
          disable: false,
          order: 100,
          position: 0,
        },
      ]),
    ),
  }
}
