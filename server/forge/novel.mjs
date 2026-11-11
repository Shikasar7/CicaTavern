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
export const MAX_NOVEL = 3_000_000
const MIN_NOVEL = 200
// A stretch: about this long, a chapter or a few together; one chapter longer than MAX_STRETCH is cut at a paragraph.
const STRETCH = 12_000
const MAX_STRETCH = 18_000
const MAX_STRETCHES = 400
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
 * A novel as stretches to read one at a time: [{ from, to, title }] over the text's characters. By its chapters when
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
  return stretches.slice(0, MAX_STRETCHES).map((stretch, i) => ({ from: stretch.from, to: stretch.to, title: stretch.title ? (stretch.last && stretch.last !== stretch.title ? `${stretch.title} … ${stretch.last}` : stretch.title) : msg`第 ${i + 1} 段` }))
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
export function gather(notes, found) {
  for (const item of found) {
    const names = [item.name, ...item.aliases].map(keyOf)
    const same = notes.find(note => [note.name, ...note.aliases].map(keyOf).some(key => names.includes(key)))
    if (same) {
      same.parts.push(item.content)
      same.aliases = [...new Set([...same.aliases, ...item.aliases, ...(keyOf(item.name) === keyOf(same.name) ? [] : [item.name])])].filter(alias => keyOf(alias) !== keyOf(same.name)).slice(0, 8)
    } else if (notes.length < MAX_ENTRIES) notes.push({ type: item.type, name: item.name, aliases: item.aliases, parts: [item.content] })
  }
  return notes
}

/** The notes that take a model to put together, in batches a request holds: [[{ name, parts }]]. One noted once needs none. */
export function mergeBatches(notes) {
  const batches = []
  let open = []
  let size = 0
  for (const note of notes) {
    if (note.parts.length < 2) continue
    // A name with more notes than a request holds is put together a part at a time (mergeWork).
    const chars = Math.min(note.parts.join('').length, MERGE_CHARS)
    if (open.length && size + chars > MERGE_CHARS) {
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

/** A note as the entry the page lists: what was put together, or its parts one after another. */
const entryOf = note => ({ type: note.type, name: note.name, aliases: note.aliases, content: note.merged ?? note.parts.join('\n'), parts: note.parts.length })

/** The entries picked, as a worldbook: found when the chat names them, by name and by what else they are called. */
export function novelBook(name, entries) {
  const typed = NOVEL_TYPES.flatMap(type => entries.filter(entry => entry.type === type))
  return normalizeBook({
    entries: Object.fromEntries(typed.map((entry, i) => [String(i), {
      uid: i,
      // A keyword of one character fires everywhere: such a name is found by its longer names, when it has any.
      key: ((keys => (keys.some(key => key.length >= 2) ? keys.filter(key => key.length >= 2) : keys))([...new Set([entry.name, ...entry.aliases])])).slice(0, 8),
      comment: `${entry.type}：${entry.name}`,
      content: entry.content,
      constant: false,
      order: 100,
      position: 1,
    }])),
  }, name, { standalone: true })
}

/** What reading comes to before it starts: { stretches, input, output } for the stretches still to read. */
export function novelEstimate(text, stretches, from = 0) {
  const left = stretches.slice(from)
  const system = estimateTokens(EXTRACT_SYSTEM)
  // A real run (2026-11-11, 62 000 characters in six stretches) took 1.35 times what the text alone is estimated at:
  // the names noted so far go with every stretch, and prose counts for more than the estimate allows.
  const input = left.reduce((sum, stretch) => sum + Math.round(estimateTokens(text.slice(stretch.from, stretch.to)) * 1.35) + system + 300, 0)
  return { stretches: left.length, input, output: left.length * EXTRACT_OUTPUT }
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
    const text = await readText()
    const limit = Math.min(session.limit || session.stretches.length, session.stretches.length)
    const ref = session.model || (await store.getSettings()).model || ''
    const ready = isProviderRef(ref)
    const estimate = novelEstimate(text, session.stretches.slice(0, limit), Math.min(session.done, limit))
    // What is past the part asked for: said when that part is read, for going on to the end.
    const rest = novelEstimate(text, session.stretches, Math.max(session.done, limit))
    const costOf = ({ input, output }) => (ready ? estimateCost(ref.slice(ref.indexOf('/') + 1), { input, output }) : null)
    const entries = session.notes.map(entryOf)
    return {
      novel: {
        name: session.name,
        chars: session.chars,
        stretches: session.stretches.map(stretch => ({ title: stretch.title, chars: stretch.to - stretch.from })),
        limit,
        done: session.done,
        // 'reading' till every stretch asked for is read, 'merging' till the names noted more than once are put together, then 'ready'.
        stage: session.done < limit ? 'reading' : session.merged ? 'ready' : 'merging',
        toMerge: mergeBatches(session.notes.filter(note => !note.merged)).length,
        failed: session.failed ?? [],
        entries,
        counts: Object.fromEntries(NOVEL_TYPES.map(type => [type, entries.filter(entry => entry.type === type).length])),
        model: session.model ?? '',
        estimate: { ready, model: ready ? (refLabel(ref, await store.getProviders()) ?? ref) : '', ...estimate, cost: costOf(estimate) },
        rest: { ...rest, cost: costOf(rest) },
        job: job ? { step: job.step, startedAt: job.startedAt } : null,
        error: session.error?.message ?? '',
      },
    }
  }

  /** Read the stretches still to read, then put together what was noted more than once. Each stretch's notes are kept as they come. */
  async function work(ctx) {
    const text = await readText()
    let session = await load(NOVEL_ID)
    const limit = Math.min(session.limit || session.stretches.length, session.stretches.length)
    for (let i = session.done; i < limit; i++) {
      if (ctx.signal.aborted) return
      ctx.step(`read:${i + 1}:${limit}`)
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
        if (found) gather(draft.notes, found)
        else draft.failed = [...(draft.failed ?? []), i + 1]
        draft.done = i + 1
        draft.merged = false
      })
    }
    const batches = mergeBatches(session.notes.filter(note => !note.merged))
    for (const [i, batch] of batches.entries()) {
      if (ctx.signal.aborted) return
      ctx.step(`merge:${i + 1}:${batches.length}`)
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
      session = await ctx.update(draft => {
        for (const item of items) {
          const note = draft.notes.find(found => found.name === item.name)
          // What the model left out stays as its notes one after another: nothing is lost for it.
          if (note) note.merged = merged.get(keyOf(item.name)) ?? note.parts.join('\n')
        }
      })
    }
    await ctx.update(draft => {
      draft.merged = true
    })
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
      const now = new Date().toISOString()
      const session = { id: NOVEL_ID, kind: 'novel', name: clip(String(name ?? '').replace(/\.(txt|md|text)$/i, ''), 80) || msg`小说`, chars: whole.length, createdAt: now, updatedAt: now, model: '', job: null, error: null, stretches, limit: 0, done: 0, notes: [], failed: [], merged: false }
      // The session first: saving it makes the folder the text goes in beside it.
      await serial(NOVEL_ID, () => save(session))
      await writeFile(textFile(), whole, 'utf8')
      return view(session)
    },

    /** How many stretches to read (0 = all of them), and the model to read with. */
    async novelUpdate({ limit, model } = {}) {
      refuseWhileBusy()
      return serial(NOVEL_ID, async () => {
        const session = await loadNovel()
        if (!session) throw httpError(404, msg`还没有选小说`)
        if (limit !== undefined) session.limit = Math.max(0, Math.min(session.stretches.length, Math.round(Number(limit)) || 0))
        if (typeof model === 'string') session.model = model.trim().slice(0, 200)
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

    novelStop() {
      const job = jobs.get(NOVEL_ID)
      job?.controller.abort()
      return { stopped: Boolean(job) }
    },

    /** The entries picked (by name; all of them when none are named) as a new worldbook. */
    async novelSave({ name, picked } = {}) {
      refuseWhileBusy()
      const session = await loadNovel()
      if (!session) throw httpError(404, msg`还没有选小说`)
      const wanted = Array.isArray(picked) ? new Set(picked.map(String)) : null
      const entries = session.notes.map(entryOf).filter(entry => !wanted || wanted.has(entry.name))
      if (!entries.length) throw httpError(400, msg`一条都没选`)
      const book = novelBook(clip(name, 100) || session.name, entries)
      await store.saveBook(book)
      return { id: book.id, name: book.name, entries: book.entries.length }
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
