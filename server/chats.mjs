// A chat is a tree of turns. Each assistant node remembers the Agent SDK
// session + message uuid it ended on, so any node can be continued (resume) or
// branched from (fork at that uuid) without replaying anything.
import { greetingsOf } from './cards.mjs'
import { buildChatPrompt, replaceMacros } from './prompt.mjs'
import YAML from 'yaml'
import { initialState } from './worldbook.mjs'
import { applyStateUpdates, displayText } from './state.mjs'
import { httpError, newId } from './store.mjs'
import { MIN_TURNS, RECENT_TURNS, STORY_FORMAT, storyPath, storyTurns, turnsSinceCompaction } from './recap.mjs'
import { msg } from './i18n.mjs'

export async function booksForCard(store, card) {
  const books = card.book ? [{ ...card.book, id: `card-${card.id}` }] : []
  for (const id of card.worldbookIds ?? []) {
    try {
      books.push(await store.getBook(id))
    } catch {
      // A deleted worldbook is simply skipped.
    }
  }
  return books
}

/** The preset a chat uses, or null when it has none or it was deleted. */
export async function presetFor(store, presetId) {
  if (!presetId) return null
  return store.getPreset(presetId).catch(() => null)
}

/** Regex scripts that apply to a chat: the preset's before the card's, as in SillyTavern. */
export function scriptsOf(card, preset) {
  return [...(preset?.regexScripts ?? []), ...(Array.isArray(card?.regexScripts) ? card.regexScripts : [])]
}

/** scriptsOf() for a chat's card and preset as they are now. */
export async function chatScripts(store, chat) {
  const [card, preset] = await Promise.all([store.getCard(chat.cardId).catch(() => null), presetFor(store, chat.presetId)])
  return scriptsOf(card, preset)
}

/**
 * Re-render a chat's frozen system prompt from the card, persona, settings and
 * preset as they are now. The next turn writes the cache once more.
 */
export async function rebuildPrompt(store, chat, presetId = chat.presetId ?? '') {
  const card = await store.getCard(chat.cardId)
  const [persona, settings, preset] = await Promise.all([store.getPersona(), store.getSettings(), presetFor(store, presetId)])
  const books = await booksForCard(store, card)
  const hasState = Object.keys(chat.nodes.root.state ?? {}).length > 0
  const built = buildChatPrompt({ card, persona: { ...persona, name: chat.names.user }, settings, books, hasState, preset })
  chat.systemPrompt = built.systemPrompt
  chat.presetVars = built.presetVars
  chat.presetId = preset?.id ?? null
  chat.presetName = preset?.name ?? null
  chat.bookIds = books.map(b => b.id)
  return chat
}

export async function createChat(store, cardId, greetingIndex = 0) {
  return startChat(store, cardId, ({ card, names, state }) => {
    const greetings = greetingsOf(card)
    // Macros (incl. {{random}}) resolve once, so the shown and the prompted opening match.
    const greeting = replaceMacros(greetings[Math.min(Math.max(0, greetingIndex), greetings.length - 1)] ?? '', names)
    return { text: greeting, state: greetingState(state, greeting) }
  })
}

/**
 * MVU per-greeting variables: an <initvar> YAML/JSON block in the chosen
 * opening replaces the card's [InitVar] values (as MVU does), then any update
 * block in the opening applies on top.
 */
export function greetingState(state, greeting) {
  let next = state
  const init = /<initvar>([\s\S]*?)<\/initvar>/i.exec(greeting)
  if (init) {
    try {
      const parsed = YAML.parse(init[1])
      if (isPlainObject(parsed)) next = parsed
    } catch {
      // A malformed block keeps the card's initial values.
    }
  }
  return applyStateUpdates(next, greeting.replace(/<initvar>[\s\S]*?<\/initvar>/gi, '')).state
}

/**
 * A new chat for `cardId` whose root is what `makeRoot({ card, names, state })`
 * returns: { text, state, compaction?, title? }. `state` is the card's initial one.
 */
async function startChat(store, cardId, makeRoot) {
  const card = await store.getCard(cardId)
  const [persona, settings] = await Promise.all([store.getPersona(), store.getSettings()])
  const preset = await presetFor(store, settings.presetId)
  const books = await booksForCard(store, card)
  const names = { char: card.name, user: persona.name || '你' }
  const root = makeRoot({ card, names, state: initialState(books) })
  const now = new Date().toISOString()
  const built = buildChatPrompt({ card, persona, settings, books, hasState: Object.keys(root.state).length > 0, preset })
  const chat = {
    id: newId(),
    cardId,
    title: root.title ?? `${card.name} · ${localStamp(new Date())}`,
    createdAt: now,
    updatedAt: now,
    names,
    // Frozen at creation: editing the card later does not invalidate this chat's cache.
    systemPrompt: built.systemPrompt,
    presetId: preset?.id ?? null,
    presetName: preset?.name ?? null,
    presetVars: built.presetVars,
    bookIds: books.map(b => b.id),
    tips: {},
    stateDirty: false,
    nodes: {
      root: {
        id: 'root',
        parent: null,
        role: 'assistant',
        text: root.text,
        display: displayText(root.text),
        state: root.state,
        ...(root.compaction ? { compaction: root.compaction } : {}),
        sel: null,
        sdk: null,
        createdAt: now,
      },
    },
  }
  return store.saveChat(chat)
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Saved variables over the card's initial ones, so variables a newer card version added still appear. */
export function mergeState(base, saved) {
  if (!isPlainObject(base) || !isPlainObject(saved)) return saved === undefined ? base : saved
  const merged = { ...base }
  for (const [key, value] of Object.entries(saved)) merged[key] = key in base ? mergeState(base[key], value) : value
  return merged
}

/**
 * A story archive of the active path up to assistant `nodeId` (default: the
 * last reply): the newest summary on it, the turns after that summary verbatim
 * (at least the last RECENT_TURNS), and the variables. Importing it starts a
 * new chat that continues the story the way a compaction does.
 */
export function exportStory(chat, nodeId) {
  const lastAssistant = [...activePath(chat)].reverse().find(node => node.role === 'assistant')
  const path = pathTo(chat, nodeId || lastAssistant.id)
  const tip = path.at(-1)
  if (tip.role !== 'assistant') throw httpError(400, msg`只能从一条叙述导出`)
  const at = path.findLastIndex(node => node.compaction)
  if (at < 0) throw httpError(400, msg`还没有剧情存档：先压缩一次再导出`)
  const since = path.slice(at + 1).filter(node => node.role === 'user').length
  const tail = storyPath(path).slice(1).slice(-Math.max(RECENT_TURNS, since) * 2)
  if (tail[0]?.role === 'assistant') tail.shift()
  const compaction = path[at].compaction
  return {
    format: STORY_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    card: chat.names.char,
    user: chat.names.user,
    title: chat.title,
    turns: storyTurns(path),
    model: compaction.model ?? null,
    summary: compaction.summary,
    // Oldest first; the last one is the reply the story continues from.
    recent: tail.map(node => ({ role: node.role, text: node.text })),
    state: tip.state ?? {},
  }
}

/** Validate an uploaded archive; throws a readable error. */
export function readStory(archive) {
  if (!isPlainObject(archive) || archive.format !== STORY_FORMAT) throw httpError(400, msg`这不是酒馆的剧情存档`)
  const summary = typeof archive.summary === 'string' ? archive.summary.trim() : ''
  if (!summary) throw httpError(400, msg`存档里没有剧情摘要`)
  const recent = (Array.isArray(archive.recent) ? archive.recent : [])
    .filter(item => isPlainObject(item) && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
    .map(({ role, text }) => ({ role, text }))
  if (recent.at(-1)?.role !== 'assistant') throw httpError(400, msg`存档里缺少最后一轮叙述`)
  return {
    summary,
    recent,
    state: isPlainObject(archive.state) ? archive.state : {},
    turns: Math.max(0, Number(archive.turns) || 0),
    model: typeof archive.model === 'string' ? archive.model : null,
    title: typeof archive.title === 'string' ? archive.title.replace(/(（导入）| \(imported\))$/, '').slice(0, 60) : '',
    card: typeof archive.card === 'string' ? archive.card : '',
    exportedAt: typeof archive.exportedAt === 'string' ? archive.exportedAt : null,
  }
}

/**
 * A new chat for `cardId` continuing an archived story. Its root is the
 * archive's last reply carrying the summary as a compaction, so the first turn
 * opens a new session with the recap (and the turns before that reply) as usual.
 */
export async function importStory(store, cardId, archive) {
  const story = readStory(archive)
  return startChat(store, cardId, ({ card, state }) => ({
    text: story.recent.at(-1).text,
    state: mergeState(state, story.state),
    title: msg`${story.title || card.name}（导入）`,
    compaction: {
      summary: story.summary,
      turns: story.turns,
      model: story.model,
      usage: null,
      at: new Date().toISOString(),
      imported: { card: story.card, title: story.title, exportedAt: story.exportedAt },
      recent: story.recent.slice(0, -1),
    },
  }))
}

/**
 * A new chat holding only the path from the opening to assistant `nodeId`:
 * later turns and other swipes stay behind. It keeps the frozen system prompt,
 * so the cached prefix still hits. No SDK tips are carried over, so its first
 * turn forks the Claude session at that reply instead of writing into the
 * original chat's session.
 */
export function forkChat(chat, nodeId) {
  const tip = chat.nodes[nodeId]
  if (!tip || tip.role !== 'assistant') throw httpError(400, msg`只能从一条叙述分出新对话`)
  const now = new Date().toISOString()
  const nodes = {}
  const path = pathTo(chat, nodeId)
  path.forEach((node, i) => {
    const copy = structuredClone(node)
    delete copy.cut
    copy.sel = path[i + 1]?.id ?? null
    nodes[copy.id] = copy
  })
  const turns = path.filter(node => node.role === 'user').length
  return {
    ...structuredClone(chat),
    id: newId(),
    title: msg`${chat.title.replace(/(（分支[^）]*）| \(branch[^)]*\))$/, '')}（分支·第 ${turns} 轮）`,
    createdAt: now,
    updatedAt: now,
    tips: {},
    forkedFrom: { chatId: chat.id, nodeId, at: now },
    nodes,
  }
}

function localStamp(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function childrenOf(chat, id) {
  return Object.values(chat.nodes)
    .filter(node => node.parent === id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** The child a node continues into: its `sel`, else the newest. */
function nextOf(chat, node) {
  const kids = childrenOf(chat, node.id)
  return kids.find(kid => kid.id === node.sel) ?? kids.at(-1) ?? null
}

/**
 * Follow `sel` pointers from the root; falls back to the newest child. A node
 * marked `cut` (rolled back to) ends the path; what follows it is kept, folded.
 */
export function activePath(chat) {
  const path = []
  let node = chat.nodes.root
  while (node) {
    path.push(node)
    if (node.cut) break
    node = nextOf(chat, node)
  }
  return path
}

/** Turns hidden behind a rollback at the end of the active path. */
export function foldedTurns(chat) {
  const last = activePath(chat).at(-1)
  if (!last?.cut) return 0
  let turns = 0
  for (let node = nextOf(chat, last); node; node = node.cut ? null : nextOf(chat, node)) if (node.role === 'user') turns++
  return turns
}

/** Roll the visible chat back to assistant `id`; later turns stay as a folded branch. */
export function rollbackTo(chat, id) {
  const node = chat.nodes[id]
  if (!node || node.role !== 'assistant') throw httpError(400, msg`只能回滚到一条叙述`)
  selectNode(chat, id)
  if (!childrenOf(chat, id).length) throw httpError(400, msg`这已经是最后一轮`)
  node.cut = true
}

/** Undo a rollback: show the folded turns again. */
export function restoreFolded(chat) {
  const last = activePath(chat).at(-1)
  if (last?.cut) delete last.cut
}

export function pathTo(chat, id) {
  const path = []
  let node = chat.nodes[id]
  if (!node) throw httpError(404, msg`节点不存在`)
  while (node) {
    path.unshift(node)
    node = node.parent ? chat.nodes[node.parent] : null
  }
  return path
}

/** Make `id` visible: point every ancestor's `sel` along its path and lift any rollback above it. */
export function selectNode(chat, id) {
  const path = pathTo(chat, id)
  for (let i = 0; i < path.length - 1; i++) {
    path[i].sel = path[i + 1].id
    delete path[i].cut
  }
}

function compactionView(chat, node) {
  const { summary, turns, model, usage, at, imported } = node.compaction
  // Once a turn has been written from it, the summary is baked into that turn's prompt.
  return { summary, chars: summary.length, turns, model, usage, at, imported, editable: childrenOf(chat, node.id).length === 0 }
}

function editableCompaction(chat, id) {
  const node = chat.nodes[id]
  if (!node?.compaction) throw httpError(404, msg`这里没有压缩记录`)
  if (childrenOf(chat, id).length) throw httpError(409, msg`压缩之后已经接着写了，摘要不能再改；可以回滚到更早的地方重新压缩`)
  return node
}

export function editCompaction(chat, id, summary) {
  const text = String(summary ?? '').trim()
  if (!text) throw httpError(400, msg`摘要不能为空`)
  editableCompaction(chat, id).compaction.summary = text
}

export function dropCompaction(chat, id) {
  const node = editableCompaction(chat, id)
  if (node.compaction.imported) throw httpError(400, msg`这是导入的存档，没有原来的上下文可接，不能撤销`)
  delete node.compaction
}

/**
 * Rewrite a message on the active path, e.g. to take something out of the
 * context. Shown and sent from now on; the turn's state and variables stay as
 * they were. A user message's recorded prompt (what was sent: the input plus
 * injected lore and preset text) has the old input swapped for the new one.
 * @returns what changed: { node, before, beforePrompt, behindCompaction }
 */
export function editMessage(chat, id, text) {
  const next = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!next) throw httpError(400, msg`内容不能为空；整轮不要了可以用「回滚到这里」`)
  const path = activePath(chat)
  const index = path.findIndex(n => n.id === id)
  if (index < 0) throw httpError(404, msg`这条消息不在当前对话里`)
  const node = path[index]
  if (node.id === 'root' || node.compaction) throw httpError(400, msg`开场和剧情存档不能在这里改；存档用「查看 / 修改」`)
  const before = node.text
  const beforePrompt = node.prompt
  if (next === before) return { node, before, beforePrompt, unchanged: true }
  node.text = next
  if (node.role === 'assistant') {
    node.display = displayText(next)
    delete node.historyTrim
  } else if (typeof node.prompt === 'string') {
    const at = node.prompt.indexOf(before)
    if (at >= 0) node.prompt = node.prompt.slice(0, at) + next + node.prompt.slice(at + before.length)
  }
  node.edited = { at: new Date().toISOString(), count: (node.edited?.count ?? 0) + 1 }
  // Context before the latest compaction is the recap, not these messages.
  const behindCompaction = path.slice(index + 1).some(n => n.compaction)
  return { node, before, beforePrompt, behindCompaction }
}

/** Client view: the active path plus sibling counts for swipe controls. */
export function chatView(chat) {
  const path = activePath(chat).map(node => {
    const siblings = node.parent ? childrenOf(chat, node.parent) : [node]
    return {
      id: node.id,
      parent: node.parent,
      role: node.role,
      // `text` is ready to show; `raw` + `state` let the UI run the card's display regex and variable macros.
      text: node.role === 'user' ? node.text : node.display,
      raw: node.text,
      state: node.role === 'assistant' ? node.state ?? {} : chat.nodes[node.parent]?.state ?? {},
      templateErrors: node.templateErrors?.length ? node.templateErrors : undefined,
      historyTrim: node.historyTrim ?? undefined,
      edited: node.edited ?? undefined,
      siblingIndex: siblings.findIndex(s => s.id === node.id),
      siblingCount: siblings.length,
      siblingIds: siblings.map(s => s.id),
      injected: node.injectedTitles ?? undefined,
      usage: node.usage ?? undefined,
      timing: node.timing ?? undefined,
      model: node.model ?? undefined,
      // The model name a provider answered with: relays that switch upstream show it here.
      served: node.api?.model ?? undefined,
      truncated: node.api?.truncated || undefined,
      stateChanges: node.stateChanges ?? undefined,
      compaction: node.compaction ? compactionView(chat, node) : undefined,
      media: node.media?.images?.length ? node.media : undefined,
      createdAt: node.createdAt,
    }
  })
  const active = activePath(chat)
  const lastAssistant = [...active].reverse().find(n => n.role === 'assistant')
  const tip = active.at(-1)
  const sinceCompaction = turnsSinceCompaction(active)
  return {
    id: chat.id,
    cardId: chat.cardId,
    title: chat.title,
    names: chat.names,
    model: chat.model ?? null,
    presetId: chat.presetId ?? null,
    presetName: chat.presetName ?? null,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    path,
    folded: foldedTurns(chat),
    // Turns a manual compaction would fold into a summary; 0 when there is nothing worth it.
    compactable: tip.role === 'assistant' && (tip.sdk || tip.api) && sinceCompaction >= MIN_TURNS ? sinceCompaction : 0,
    state: lastAssistant?.state ?? {},
    systemPromptChars: chat.systemPrompt.length,
  }
}

export function chatSummary(chat) {
  const turns = Object.values(chat.nodes).filter(n => n.role === 'user').length
  const last = activePath(chat).at(-1)
  return {
    id: chat.id,
    cardId: chat.cardId,
    title: chat.title,
    updatedAt: chat.updatedAt,
    turns,
    preview: (last?.role === 'user' ? last.text : last?.display ?? '').slice(0, 80),
  }
}
