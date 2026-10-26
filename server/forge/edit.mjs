// 修改角色卡 by talking it through: the user says what to change about a card
// already saved, the model answers with each changed piece written out in full
// (tagged blocks like the polish stage's rewrites, write.mjs), the page shows
// them as before and after, and the ones the user keeps go into the stored
// card. The session runs like a draft (index.mjs): in the background, polled.
import { editBook } from '../worldbook.mjs'
import { newId } from '../store.mjs'
import { CARD_FIELDS, cleanTags, editCard, greetingList } from '../../web/shared/card-edit.js'
import { LONG_TOKENS, WRITING_RULES } from './prompts.mjs'
import { attr, bodyFor, historyLines, readBlocks, splitKeys } from './blocks.mjs'

// The card's fields as the model knows them: SillyTavern's names.
export const FIELD_TAGS = Object.freeze({
  name: 'name',
  description: 'description',
  personality: 'personality',
  scenario: 'scenario',
  mesExample: 'mes_example',
  systemPrompt: 'system_prompt',
  postHistoryInstructions: 'post_history_instructions',
  depthPrompt: 'depth_prompt',
  creatorNotes: 'creator_notes',
  creator: 'creator',
  tags: 'tags',
})
const FIELD_OF = Object.fromEntries(Object.entries(FIELD_TAGS).flatMap(([key, tag]) => [[tag, key], [key.toLowerCase(), key]]))

// Entry text sent in full, at most; past it, entries go by name and can't be changed this time.
export const ENTRY_BUDGET = 60000
export const modeOf = entry => (entry.initvar ? 'initvar' : entry.constant ? 'constant' : 'keyword')

/** A card without a worldbook of its own gets an empty one, named as the importer names it. */
export function ensureBook(card) {
  card.book ??= { id: newId(), name: `${card.name} 内嵌世界书`, entries: [], importedAt: new Date().toISOString() }
  return card.book
}

/**
 * The uids of the entries sent in full: the one asked about, those `picked`
 * (a worldbook's first look, book-edit.mjs) and those the request names first,
 * then by order, as far as `budget` characters go.
 */
export function shownEntries(entries, words, target = '', { picked = [], budget = ENTRY_BUDGET } = {}) {
  const first = target.startsWith('entry:') ? target.slice(6) : null
  const named = e => [e.comment, ...e.keys].some(name => name && name.length >= 2 && words.includes(name))
  const rank = e => (e.uid === first ? 3 : picked.includes(e.uid) ? 2 : named(e) ? 1 : 0)
  const ranked = [...entries].sort((a, b) => rank(b) - rank(a) || a.order - b.order)
  const shown = new Set()
  let used = 0
  for (const entry of ranked) {
    if (shown.size && used + entry.content.length > budget) continue
    used += entry.content.length
    shown.add(entry.uid)
  }
  return shown
}

function cardBlock(card) {
  const filled = []
  const empty = []
  for (const { key } of CARD_FIELDS) {
    const value = String(card[key] ?? '')
    if (value.trim()) filled.push(`<field name="${FIELD_TAGS[key]}">\n${value}\n</field>`)
    else empty.push(FIELD_TAGS[key])
  }
  if (card.tags?.length) filled.push(`<field name="tags">${card.tags.join(', ')}</field>`)
  else empty.push('tags')
  const greetings = greetingList(card).map((text, i) => `<greeting index="${i + 1}">\n${text}\n</greeting>`)
  return [...filled, empty.length ? `空着的字段：${empty.join('、')}` : '', ...greetings].filter(Boolean).join('\n\n')
}

/** Entries as the model reads them: in full when `shown`, else by name only. */
export function bookBlock(entries, shown, empty = '（这张卡还没有世界书条目）') {
  if (!entries.length) return empty
  return entries
    .map(e => {
      const head = `<entry uid="${attr(e.uid)}" name="${attr(e.comment)}" mode="${modeOf(e)}" keys="${attr(e.keys.join(', '))}"${e.enabled ? '' : ' enabled="false"'}>`
      return shown.has(e.uid) ? `${head}\n${e.content}\n</entry>` : `${head}（正文 ${e.content.length} 字，这次没有附上，不能改）</entry>`
    })
    .join('\n\n')
}

/** Where a change is, as its block opens: field:description → <field name="description">. */
function targetTag(target) {
  const [kind, id] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)]
  if (kind === 'field') return `<field name="${FIELD_TAGS[id] ?? id}">`
  if (kind === 'greeting') return `<greeting index="${Number(id) + 1}">`
  if (kind === 'entry') return `<entry uid="${id}">`
  return ''
}

const editSystem = reply => `你是角色卡编辑。用户在 SillyTavern 一类的角色扮演应用里有一张写好的角色卡，想按自己的意思改它。你读懂整张卡，照这次的要求改，只动需要动的地方。

做法：
- 先想清楚要的效果落在哪里：说话方式和性格多半在 description、personality、mes_example 和相关的世界书条目里；新的人物、地点、设定写成新的世界书条目；开场的样子在开场白里。
- 照原卡的写法改：原文是 YAML、列表还是段落，就还用那种格式；原文用 {{char}}、{{user}} 或 <user> 称呼，就照用；沿用原文的语言。不借机把整段改成另一种风格。
- 改一处，前后要对得上：人设改了，对话示例、开场白和条目里明显冲突的句子一起改。用户没提到、也不冲突的内容一字不动。
- 新条目是写给模型看的设定：简洁、具体，只写模型不知道的东西。关键词用故事里真会出现的叫法（名字、外号），至少两个字。人物、地点、物品用 keyword（提到时才发送）；只有每轮都要遵守的规则才用 constant。
- mode 为 initvar 的条目是初始变量，enabled="false" 的条目没在用：用户没要求就不要动。
- 要求含糊时，按最可能的意思改，在 <reply> 里说你是怎么理解的。不需要改或者做不到的，在 <reply> 里说明，不输出改动。
${WRITING_RULES.filter(rule => !rule.includes('<user>')).map(rule => `- ${rule}`).join('\n')}

回答先写一段 <reply>，再写每一处改动；标签外不写别的：
<reply>
对用户说的话，用${reply}，两到四句：改了哪里、为什么这样改。
</reply>
<field name="description">改好之后的完整正文</field>
<greeting index="2">改好之后的完整开场白</greeting>
<entry uid="3">改好之后的完整条目正文</entry>
<new_entry name="条目名" keys="关键词一, 关键词二" mode="keyword">新条目的正文</new_entry>
<remove_entry uid="5"></remove_entry>

- field 的 name 用这些：${Object.values(FIELD_TAGS).join('、')}。tags 写成逗号分开的一行。
- greeting 的 index 和卡里一致；写一个比现有开场白多一的序号，就是新加一条。
- entry 改已有条目：标签里写 uid；要改条目名或关键词，再加 name="…" 或 keys="…"。
- 每一块都写改好之后的完整内容，不是片段，不写省略号，不写「其余不变」。没改的不要输出。`

/**
 * The request for one edit. `turns`: the session's earlier ones, for what was
 * asked before; `target`: a piece the change is kept to (field:description,
 * greeting:0, entry:3). Returns { request, shown }, shown being the uids of the
 * entries sent in full: only those can be changed by the answer.
 */
export function editRequest(card, { text, target = '', turns = [], reply = '简体中文' } = {}) {
  const entries = card.book?.entries ?? []
  const shown = shownEntries(entries, `${text}\n${target}`, target)
  const history = historyLines(turns)
  const content = [
    `<card>\n${cardBlock(card)}\n</card>`,
    `<worldbook>\n${bookBlock(entries, shown)}\n</worldbook>`,
    history.length ? `之前的几次修改（上面的卡已经是处理之后的样子）：\n${history.join('\n')}` : '',
    `这次的要求：\n${text}`,
    target ? `只改 ${targetTag(target)} 这一处，别的不动。` : '',
  ].filter(Boolean).join('\n\n')
  return { request: { system: editSystem(reply), messages: [{ role: 'user', content }], maxTokens: LONG_TOKENS, softCap: true }, shown: [...shown] }
}

// ─── Reading the answer ───────────────────────────────────────────────────

const TAGS = ['field', 'greeting', 'entry', 'new_entry', 'remove_entry']

/**
 * An answer → { reply, changes }. A change is
 *   { id, kind: 'field', key, before, after }            (tags as "a, b")
 *   { id, kind: 'greeting', index, before, after }        (index past the last one: a new opening)
 *   { id, kind: 'entry', uid, title, constant, before, after, name?, keys? }
 *   { id, kind: 'newEntry', name, keys, constant, after }
 *   { id, kind: 'removeEntry', uid, title, constant, before }
 * Pieces the same as before, entries not sent in full (`shown`), and with a
 * `target` anything else, are left out.
 */
export function readEdit(text, card, { shown = null, target = '' } = {}) {
  const { reply, blocks } = readBlocks(text, TAGS)
  const greetings = greetingList(card)
  const entries = card.book?.entries ?? []
  const changes = new Map()
  let fresh = 0
  for (const block of blocks) {
    const { tag, attrs } = block
    let { body } = block
    if (tag === 'field') {
      const key = FIELD_OF[String(attrs.name ?? '').trim().toLowerCase()]
      if (!key) continue
      if (key === 'tags') {
        const before = (card.tags ?? []).join(', ')
        const after = cleanTags(body).join(', ')
        if (after !== before) changes.set('field:tags', { id: 'field:tags', kind: 'field', key, before, after })
        continue
      }
      const before = String(card[key] ?? '')
      body = bodyFor(block, before)
      if ((key === 'name' && !body) || body === before.trim()) continue
      changes.set(`field:${key}`, { id: `field:${key}`, kind: 'field', key, before, after: body })
    } else if (tag === 'greeting') {
      const index = Number.parseInt(attrs.index, 10) - 1
      const before = greetings[index] ?? ''
      body = bodyFor(block, before)
      if (!(index >= 0) || index > greetings.length + 4 || !body || body === before.trim()) continue
      changes.set(`greeting:${index}`, { id: `greeting:${index}`, kind: 'greeting', index, before, after: body })
    } else if (tag === 'entry' || tag === 'remove_entry') {
      const entry = entries.find(e => e.uid === String(attrs.uid ?? '').trim())
      if (!entry || (shown && !shown.includes(entry.uid))) continue
      if (tag === 'remove_entry') {
        changes.set(`remove:${entry.uid}`, { id: `remove:${entry.uid}`, kind: 'removeEntry', uid: entry.uid, title: entry.comment, constant: entry.constant, before: entry.content })
        continue
      }
      body = bodyFor(block, entry.content)
      const change = { id: `entry:${entry.uid}`, kind: 'entry', uid: entry.uid, title: entry.comment, constant: entry.constant, before: entry.content, after: body && body !== entry.content.trim() ? body : entry.content }
      const name = String(attrs.name ?? '').trim().slice(0, 200)
      if (name && name !== entry.comment) change.name = name
      const keys = attrs.keys === undefined ? null : splitKeys(attrs.keys)
      if (keys && JSON.stringify(keys) !== JSON.stringify(entry.keys)) change.keys = keys
      if (change.after !== entry.content || change.name || change.keys) changes.set(change.id, change)
    } else if (tag === 'new_entry') {
      if (!body) continue
      const name = String(attrs.name ?? '').trim().slice(0, 200) || body.replace(/\s+/g, ' ').slice(0, 24)
      const id = `new:${fresh++}`
      changes.set(id, { id, kind: 'newEntry', name, keys: splitKeys(attrs.keys), constant: /constant|常驻/i.test(String(attrs.mode ?? '')), after: body })
    }
  }
  const list = [...changes.values()]
  return { reply, changes: target ? list.filter(change => change.id === target) : list }
}

// ─── Applying ─────────────────────────────────────────────────────────────

/**
 * The chosen changes (by id) of a proposal into the stored card, in place. An
 * entry deleted since is skipped. Returns how many went in and whether a
 * chat's prefix would now come out different (web/shared/card-edit.js, worldbook.mjs).
 */
export function applyChanges(card, changes, ids) {
  const chosen = changes.filter(change => ids.includes(change.id))
  let prefix = false
  let applied = 0
  const patch = {}
  for (const change of chosen.filter(c => c.kind === 'field')) {
    patch[change.key] = change.key === 'tags' ? cleanTags(change.after) : change.after
    applied++
  }
  const openings = chosen.filter(c => c.kind === 'greeting').sort((a, b) => a.index - b.index)
  if (openings.length) {
    const greetings = greetingList(card)
    for (const change of openings) {
      if (change.index < greetings.length) greetings[change.index] = change.after
      else greetings.push(change.after)
      applied++
    }
    patch.greetings = greetings
  }
  if (Object.keys(patch).length) prefix = editCard(card, patch).prefix
  const added = chosen.filter(c => c.kind === 'newEntry')
  const book = added.length ? ensureBook(card) : card.book
  if (!book) return { applied, prefix }
  const exists = uid => book.entries.some(e => e.uid === uid)
  // Only what the proposal changes: an edit made to the entry since stays.
  const edits = chosen.filter(c => c.kind === 'entry' && exists(c.uid)).map(c => ({ uid: c.uid, ...(c.after !== c.before ? { content: c.after } : {}), ...(c.name ? { comment: c.name } : {}), ...(c.keys ? { keys: c.keys } : {}) }))
  const removed = chosen.filter(c => c.kind === 'removeEntry' && exists(c.uid)).map(c => c.uid)
  if (edits.length) prefix = editBook(book, { entries: edits }).prefix || prefix
  for (const change of added) prefix = editBook(book, { add: { comment: change.name, keys: change.keys, content: change.after, constant: change.constant } }).prefix || prefix
  if (removed.length) prefix = editBook(book, { remove: removed }).prefix || prefix
  return { applied: applied + edits.length + added.length + removed.length, prefix }
}
