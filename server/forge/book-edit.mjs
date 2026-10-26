// 对话修改 for a worldbook as a whole (世界书 → 对话修改): an imported book or
// a card's own one. The user says what to change, or for an empty book what it
// should hold, and the model writes each changed entry out in full (blocks.mjs);
// the page shows them as before and after, and the ones the user keeps go into
// the book (worldbook.mjs editBook). A book too long to send whole is first
// shown as a table of contents: the model names the entries it needs to read
// (pickRequest), and those go in full.
import { editBook, editBookInfo } from '../worldbook.mjs'
import { LONG_TOKENS, WRITING_RULES } from './prompts.mjs'
import { attr, bodyFor, historyLines, readBlocks, splitKeys } from './blocks.mjs'
import { ENTRY_BUDGET, bookBlock, modeOf, shownEntries } from './edit.mjs'

// Entries the first look at a long book may ask to read.
const PICK_MAX = 60
// New entries one answer may add (an empty book written from a sentence).
const NEW_MAX = 60

/** Whether a book is too long to send whole: its edit starts with a look at the contents. */
export const bookTooLong = book => book.entries.reduce((sum, e) => sum + e.content.length, 0) > ENTRY_BUDGET

const bookHead = book => `<worldbook name="${attr(book.name)}"${book.description ? ` description="${attr(book.description)}"` : ''}>`

function contents(entries) {
  return entries
    .map(e => `- uid=${e.uid}「${e.comment || '未命名'}」${modeOf(e)}${e.enabled ? '' : '，停用'}，关键词：${e.keys.join('、') || '无'}（${e.content.length} 字）`)
    .join('\n')
}

/** The first look at a long book: its contents and the request; the answer names the entries to read. */
export function pickRequest(book, { text, target = '', turns = [] } = {}) {
  const history = historyLines(turns)
  const content = [
    `${bookHead(book)}\n目录（${book.entries.length} 条）：\n${contents(book.entries)}\n</worldbook>`,
    history.length ? `之前的几次修改：\n${history.join('\n')}` : '',
    `这次的要求：\n${text}`,
    target.startsWith('entry:') ? `这次只改 uid=${target.slice(6)} 这一条。` : '',
    `先挑出完成这次要求要读全文的条目，最多 ${PICK_MAX} 条。只回答 <read>uid, uid, …</read>；只是新增条目、不用读旧条目时回答 <read></read>。`,
  ].filter(Boolean).join('\n\n')
  return {
    system: '你在帮用户修改一本 SillyTavern 世界书。书太长，不能一次全部附上，先看目录挑出要读的条目。只回答 <read> 标签，不写别的。',
    messages: [{ role: 'user', content }],
    maxTokens: 800,
  }
}

/** The uids a first look asked for, as the book has them. */
export function readPicked(text, book) {
  const match = /<read>([\s\S]*?)(?:<\/read>|$)/i.exec(String(text ?? ''))
  const asked = (match ? match[1] : String(text ?? '')).match(/[\w-]+/g) ?? []
  const known = new Set(book.entries.map(e => e.uid))
  return [...new Set(asked.filter(uid => known.has(uid)))].slice(0, PICK_MAX)
}

const bookSystem = (reply, { own }) => `你是世界书编辑。用户在 SillyTavern 一类的角色扮演应用里有一本世界书${own ? '（一张角色卡自带的）' : ''}，想按自己的意思改它，或者从头写一本。世界书是写给扮演角色的模型看的设定：每个条目在最近的对话提到它的关键词时发送（keyword），或者每一轮都发送（constant）。

做法：
- 只动需要动的条目；用户没提到、也不冲突的条目一字不动。
- 照原书的写法改：原文是 YAML、列表还是段落，就还用那种格式；原文用 {{char}}、{{user}} 或 <user> 称呼，就照用；沿用原文的语言。空书照用户说的语言写。
- 条目写给模型看：简洁、具体，只写模型不知道的东西。一个条目讲一件事（一个人物、一个地点、一个组织、一条规则）；讲了好几件事的长条目可以拆开。
- 关键词用故事里真会出现的叫法（名字、外号、简称），至少两个字，不用「他」「那里」这种词。人物、地点、物品、事件用 keyword；只有每轮都要遵守的规则和世界的基本设定用 constant。constant 条目每轮都占上下文，不要多。
- mode 为 initvar 的条目是初始变量（不发给模型），enabled="false" 的条目没在用：用户没要求就不要动。正文里的 <% %> 是模板脚本，{{setvar}} 一类是宏，原样保留。
- 要改的条目这次没有附上全文，就不能改：在 <reply> 里说还有哪些，用户可以让你接着改下一批。新写的条目一次最多 ${NEW_MAX} 条，写不完也在 <reply> 里说。
- 用户只是问问题、要你解释或检查，就在 <reply> 里回答，不输出改动。要求含糊时，按最可能的意思做，在 <reply> 里说你是怎么理解的。
${WRITING_RULES.filter(rule => !rule.includes('<user>')).map(rule => `- ${rule}`).join('\n')}

回答先写一段 <reply>，再写每一处改动；标签外不写别的：
<reply>
对用户说的话，用${reply}，两到四句：改了哪里、为什么这样改。
</reply>
<entry uid="3">改好之后的完整条目正文</entry>
<entry uid="4" mode="keyword" keys="关键词一, 关键词二"></entry>
<new_entry name="条目名" keys="关键词一, 关键词二" mode="keyword">新条目的正文</new_entry>
<remove_entry uid="5"></remove_entry>
${own ? '' : '<book name="书名">给玩家看的简介</book>\n'}
- entry 改已有条目：标签里写 uid；要改条目名、关键词、触发方式或开关，再加 name="…"、keys="…"、mode="keyword" 或 "constant"、enabled="true" 或 "false"。只改这些、不改正文时，标签中间空着。
- 每个正文都写改好之后的完整内容，不是片段，不写省略号，不写「其余不变」。没改的不要输出。${own ? '' : '\n- 要改书名或简介（新写一本时给它起个名字）才写 <book>；简介是给玩家看的，一两句话。'}`

/**
 * The request for one edit of a book. `own`: a card's own book (no name of its
 * own); `picked`: the uids a first look asked to read (pickRequest). Returns
 * { request, shown }, shown being the uids sent in full: only those can change.
 */
export function bookEditRequest(book, { text, target = '', turns = [], reply = '简体中文', own = false, picked = [] } = {}) {
  const shown = shownEntries(book.entries, `${text}\n${target}`, target, { picked })
  const history = historyLines(turns)
  const content = [
    `${bookHead(book)}\n${bookBlock(book.entries, shown, '（这本世界书还是空的）')}\n</worldbook>`,
    history.length ? `之前的几次修改（上面的书已经是处理之后的样子）：\n${history.join('\n')}` : '',
    `这次的要求：\n${text}`,
    target.startsWith('entry:') ? `只改 <entry uid="${target.slice(6)}"> 这一条，别的不动。` : '',
  ].filter(Boolean).join('\n\n')
  return { request: { system: bookSystem(reply, { own }), messages: [{ role: 'user', content }], maxTokens: LONG_TOKENS, softCap: true }, shown: [...shown] }
}

const MODES = { constant: true, keyword: false }
const flag = value => (value === 'true' ? true : value === 'false' ? false : null)

/**
 * An answer → { reply, changes }. A change is
 *   { id, kind: 'entry', uid, title, constant, before, after, name?, keys?, mode?, enabled? }
 *   { id, kind: 'newEntry', name, keys, constant, after }
 *   { id, kind: 'removeEntry', uid, title, constant, before }
 *   { id: 'book', kind: 'bookInfo', beforeName, name?, before, after }   (an imported book's name and description)
 * `mode` is 'constant' or 'keyword' when it changes, `enabled` a boolean when it
 * changes. Entries not sent in full (`shown`), and with a `target` anything else,
 * are left out.
 */
export function readBookEdit(text, book, { shown = null, target = '', own = false } = {}) {
  const { reply, blocks } = readBlocks(text, ['entry', 'new_entry', 'remove_entry', 'book'])
  const changes = new Map()
  let fresh = 0
  for (const block of blocks) {
    const { tag, attrs } = block
    let { body } = block
    if (tag === 'book') {
      if (own) continue
      const name = String(attrs.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
      const description = body.slice(0, 4000)
      const change = { id: 'book', kind: 'bookInfo', beforeName: book.name, before: book.description ?? '', after: description || (book.description ?? '') }
      if (name && name !== book.name) change.name = name
      if (change.name || change.after !== change.before) changes.set('book', change)
    } else if (tag === 'new_entry') {
      if (!body || fresh >= NEW_MAX) continue
      const name = String(attrs.name ?? '').trim().slice(0, 200) || body.replace(/\s+/g, ' ').slice(0, 24)
      const id = `new:${fresh++}`
      changes.set(id, { id, kind: 'newEntry', name, keys: splitKeys(attrs.keys), constant: /constant|常驻/i.test(String(attrs.mode ?? '')), after: body })
    } else {
      const entry = book.entries.find(e => e.uid === String(attrs.uid ?? '').trim())
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
      const mode = String(attrs.mode ?? '').trim().toLowerCase()
      if (mode in MODES && !entry.initvar && MODES[mode] !== entry.constant) change.mode = mode
      const enabled = flag(String(attrs.enabled ?? '').trim().toLowerCase())
      if (enabled !== null && enabled !== entry.enabled) change.enabled = enabled
      if (change.after !== entry.content || change.name || change.keys || change.mode || change.enabled !== undefined) changes.set(change.id, change)
    }
  }
  const list = [...changes.values()]
  return { reply, changes: target ? list.filter(change => change.id === target) : list }
}

/**
 * The chosen changes (by id) into the book, in place; an entry deleted since is
 * skipped. Returns how many went in and whether a chat's frozen prefix would
 * now come out different (worldbook.mjs editBook).
 */
export function applyBookChanges(book, changes, ids) {
  const chosen = changes.filter(change => ids.includes(change.id))
  const exists = uid => book.entries.some(e => e.uid === uid)
  let prefix = false
  let applied = 0
  const info = chosen.find(c => c.kind === 'bookInfo')
  if (info) {
    editBookInfo(book, { ...(info.name ? { name: info.name } : {}), description: info.after })
    applied++
  }
  const edits = chosen
    .filter(c => c.kind === 'entry' && exists(c.uid))
    .map(c => ({
      uid: c.uid,
      // Only what the proposal changes: an edit made to the entry since stays.
      ...(c.after !== c.before ? { content: c.after } : {}),
      ...(c.name ? { comment: c.name } : {}),
      ...(c.keys ? { keys: c.keys } : {}),
      ...(c.mode ? { constant: c.mode === 'constant' } : {}),
      ...(c.enabled !== undefined ? { enabled: c.enabled } : {}),
    }))
  if (edits.length) prefix = editBook(book, { entries: edits }).prefix || prefix
  const added = chosen.filter(c => c.kind === 'newEntry')
  for (const change of added) prefix = editBook(book, { add: { comment: change.name, keys: change.keys, content: change.after, constant: change.constant } }).prefix || prefix
  const removed = chosen.filter(c => c.kind === 'removeEntry' && exists(c.uid)).map(c => c.uid)
  if (removed.length) prefix = editBook(book, { remove: removed }).prefix || prefix
  return { applied: applied + edits.length + added.length + removed.length, prefix }
}
