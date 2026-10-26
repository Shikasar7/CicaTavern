// A chat is a tree of turns. Each assistant node remembers the Agent SDK
// session + message uuid it ended on, so any node can be continued (resume) or
// branched from (fork at that uuid) without replaying anything.
import { greetingsOf } from './cards.mjs'
import { buildChatPrompt, chatTemplates, replaceMacros, templateText } from './prompt.mjs'
import YAML from 'yaml'
import { constantEntries, entryText, initialState, lateEntries } from './worldbook.mjs'
import { applyStateUpdates, applyWrites, displayText } from './state.mjs'
import { hasEjs, renderTemplate } from './template.mjs'
import { httpError, newId } from './store.mjs'
import { MIN_TURNS, RECENT_TURNS, STORY_FORMAT, storyPath, storyTurns, turnsSinceCompaction } from './recap.mjs'
import { msg } from './i18n.mjs'
import { BASIC_ID, basicPreset } from './basic.mjs'
import { readSillyTavernChat } from './st-chat.mjs'
import { markSpeakers } from '../web/shared/vn.js'
import { chatScriptList } from '../web/shared/regex.js'
import { cardPick, DEFAULT_ITEM, defaultOf, itemOf, pickFor } from '../web/shared/personas.js'
import { withChatChanges } from './frames.mjs'

/**
 * A chat's books: the card's own, the imported ones it has mounted, then the
 * global ones (全局世界书) it has not, each once.
 * @param settings - when the caller has them already.
 * @param chat - a chat whose card wrote to its books (frames.mjs): what that chat reads.
 */
export async function booksForCard(store, card, settings = null, chat = null) {
  const books = card.book ? [{ ...card.book, id: `card-${card.id}` }] : []
  const { globalBookIds = [] } = settings ?? await store.getSettings()
  for (const id of new Set([...(card.worldbookIds ?? []), ...globalBookIds])) {
    try {
      books.push(await store.getBook(id))
    } catch {
      // A deleted worldbook is simply skipped.
    }
  }
  return chat ? withChatChanges(books, chat) : books
}

/**
 * What mounting or taking off books means for a chat's frozen prefix: the
 * books mounted or taken off since its prefix was built that hold constant
 * entries ({ id, name, entries }). null when the prefix would come out the
 * same (keyword entries follow the mounts on the next turn by themselves),
 * or for a chat from before chats recorded their books.
 */
export async function mountChange(store, chat, card) {
  if (!Array.isArray(chat.bookIds)) return null
  const books = await booksForCard(store, card)
  const now = new Set(books.map(book => book.id))
  const before = new Set(chat.bookIds)
  const frozen = book => constantEntries([book]).length + lateEntries([book]).length
  const added = books.filter(book => !before.has(book.id) && frozen(book) > 0).map(book => ({ id: book.id, name: book.name, entries: frozen(book) }))
  const removed = []
  for (const id of before) {
    if (now.has(id) || id.startsWith('card-')) continue
    const book = await store.getBook(id).catch(() => null)
    if (book && frozen(book) > 0) removed.push({ id, name: book.name, entries: frozen(book) })
  }
  return added.length || removed.length ? { added, removed } : null
}

/**
 * The preset a chat uses. '' (the setting's default) and BASIC_ID are the
 * built-in preset; null when the chat predates it (plain built-in rules) or
 * its preset was deleted.
 */
export async function presetFor(store, presetId) {
  if (presetId === '' || presetId === BASIC_ID) return basicPreset(await store.getSettings())
  if (!presetId) return null
  return store.getPreset(presetId).catch(() => null)
}

/**
 * Regex scripts that apply to a chat: the global ones, then the preset's, then the card's, as in SillyTavern,
 * then the 正则集 (regex.mjs) attached to the card.
 */
export function scriptsOf(card, preset, global = [], sets = []) {
  return chatScriptList({ global, preset: preset?.regexScripts ?? [], card: Array.isArray(card?.regexScripts) ? card.regexScripts : [], cardId: card?.id ?? '', sets })
}

/** scriptsOf() for a chat's card and preset as they are now. */
export async function chatScripts(store, chat) {
  const [card, preset, global, sets] = await Promise.all([store.getCard(chat.cardId).catch(() => null), presetFor(store, chat.presetId), store.getRegex(), store.getRegexSets()])
  return scriptsOf(card, preset, global, sets)
}

/**
 * The player in a chat on `card`: `name` (the chat's, or for a new chat the
 * card's own name for the player, else the persona's) and the persona's
 * description. A card with a name of its own says who that person is itself,
 * so a persona's description, written for someone else, is left out while the
 * player goes by the card's name (unless the persona has that name too).
 */
export function playerOf(card, persona, name = card.userName || persona.name || '你') {
  const cardsOwn = Boolean(card.userName) && name === card.userName && persona.name !== card.userName
  return { ...persona, name, description: cardsOwn ? '' : persona.description }
}

/**
 * What a new chat on `card` uses from 你的角色 and 文风 (web/shared/personas.js):
 * the card's pick, else the default; and the player's name there: a persona
 * the card picked brings its own, else the card's name for the player, else
 * the default persona's.
 */
export function newChatPicks(card, personas, styles) {
  const picked = cardPick(personas, card.id)
  const persona = picked ?? defaultOf(personas)
  return { persona, style: pickFor(styles, card.id), name: (picked ? persona.name : card.userName || persona.name) || '你' }
}

/**
 * The persona and the style a chat uses: the ones it started with or was
 * switched to (a chat from before the lists: their first item, the one
 * setting there was), else (deleted since) what a new chat on its card
 * would use. `name` is the player's name then, null while the chat's persona
 * is there.
 */
export async function chatPicks(store, chat, card) {
  const [personas, styles] = await Promise.all([store.getPersonas(), store.getStyles()])
  const own = itemOf(personas, chat.personaId ?? DEFAULT_ITEM)
  const fresh = newChatPicks(card, personas, styles)
  return { persona: own ?? fresh.persona, style: itemOf(styles, chat.styleId ?? DEFAULT_ITEM) ?? fresh.style, name: own ? null : fresh.name }
}

/**
 * Another persona or style for a chat: `personaId` / `styleId` an item's id,
 * or '' for what a new chat on its card would use now; left out, it stays. A
 * persona brings its name as the player's from here on. The prefix is built
 * again, so the next turn writes the cache once more.
 */
export async function switchPicks(store, chat, { personaId, styleId } = {}) {
  const card = await store.getCard(chat.cardId)
  const [personas, styles] = await Promise.all([store.getPersonas(), store.getStyles()])
  const fresh = newChatPicks(card, personas, styles)
  if (typeof personaId === 'string') {
    const persona = personaId ? itemOf(personas, personaId) : fresh.persona
    if (!persona) throw httpError(404, msg`没有这个角色`)
    chat.personaId = persona.id
    chat.names = { ...chat.names, user: personaId ? persona.name : fresh.name }
  }
  if (typeof styleId === 'string') {
    const style = styleId ? itemOf(styles, styleId) : fresh.style
    if (!style) throw httpError(404, msg`没有这个文风`)
    chat.styleId = style.id
  }
  return rebuildPrompt(store, chat)
}

/**
 * Re-render a chat's frozen system prompt from the card, persona, settings and
 * preset as they are now. The next turn writes the cache once more. Templates
 * there render with the opening's state again; what they write is not kept.
 */
export async function rebuildPrompt(store, chat, presetId = chat.presetId ?? '') {
  const card = await store.getCard(chat.cardId)
  const [picks, settings, chosen, globalScripts, regexSets] = await Promise.all([chatPicks(store, chat, card), store.getSettings(), presetFor(store, presetId ?? ''), store.getRegex(), store.getRegexSets()])
  // A deleted preset, or a chat from before the built-in one: rebuilt with the built-in preset.
  const preset = chosen ?? basicPreset(settings)
  const books = await booksForCard(store, card, settings, chat)
  const hasState = Object.keys(chat.nodes.root.state ?? {}).length > 0
  // A card renamed in 修改角色卡: {{char}} in later turns follows the prefix. So does
  // the player's name when the chat's persona was deleted and another took its place.
  chat.names = { ...chat.names, char: card.name, ...(picks.name ? { user: picks.name } : {}) }
  chat.personaId = picks.persona.id
  chat.styleId = picks.style.id
  const prefix = prefixTemplates({
    names: chat.names, card, preset, books, scripts: scriptsOf(card, preset, globalScripts, regexSets),
    state: chat.nodes.root.state ?? {}, local: chat.frameVars ?? {}, global: settings.globalVars ?? {},
    messages: [{ role: 'assistant', text: chat.nodes.root.text ?? '' }],
  })
  let built
  try {
    built = buildChatPrompt({ card, persona: playerOf(card, picks.persona, chat.names.user), style: picks.style.text, settings, books, hasState, preset, render: prefix.render })
    built.systemPrompt = prefix.resolve(built.systemPrompt)
  } finally {
    prefix.dispose()
  }
  chat.systemPrompt = built.systemPrompt
  chat.presetVars = built.presetVars
  chat.presetId = preset?.id ?? null
  chat.presetName = preset?.name ?? null
  chat.bookIds = books.map(b => b.id)
  return chat
}

export async function createChat(store, cardId, greetingIndex = 0) {
  return startChat(store, cardId, ({ card, state, open }) => {
    const greetings = greetingsOf(card)
    return open(state, greetings[Math.min(Math.max(0, greetingIndex), greetings.length - 1)] ?? '')
  })
}

/** [InitVar]-style entries with their EJS run once, as ST-Prompt-Template renders @@initial_variables before reading it. */
const initvarText = names => entry => renderTemplate(entry.content, { names }).text ?? entryText(entry)

/**
 * An opening as a chat keeps it. Its templates run once with the opening's
 * state (ST-Prompt-Template evaluates a new message's raw text once and keeps
 * the result), then macros (incl. {{random}}) resolve once, so the shown and the
 * prompted opening match. What its templates write lands after its own update blocks.
 * @param ctx - chatTemplates options: { names, card, preset, books, scripts, local, global }.
 * @returns { text, state, local, global, errors }: `local` and `global` are writes (state.mjs applyWrites).
 */
function openWith(ctx, state, greeting) {
  let rendered = greeting
  let writes = null
  const errors = []
  if (hasEjs(greeting)) {
    const session = chatTemplates({ ...ctx, state: openingInit(state, greeting), messages: [{ role: 'assistant', text: greeting }], runType: 'render_permanent' })
    try {
      rendered = session.resolveInjected(templateText(session, greeting, errors))
      writes = session.writes()
    } finally {
      session.dispose()
    }
  }
  const text = replaceMacros(rendered, ctx.names)
  return { text, state: applyWrites(greetingState(state, text), writes?.message), local: writes?.local ?? [], global: writes?.global ?? [], errors }
}

/**
 * The frozen prefix's templates (card fields, persona, preset prompts) through
 * one sandbox: `render` for buildChatPrompt, then `resolve` on the whole prompt
 * for getPromptsInjected. Rendered once; see buildChatPrompt.
 */
function prefixTemplates(ctx) {
  const session = chatTemplates({ ...ctx, runType: 'preparation' })
  const errors = []
  return {
    render: text => (hasEjs(text) ? templateText(session, text, errors) : text),
    resolve: text => session.resolveInjected(text),
    writes: () => session.writes(),
    errors,
    dispose: () => session.dispose(),
  }
}

/** Whether a chat's prefix material holds templates (an opening switched before the first turn renders it again). */
function prefixHasTemplates(card, preset, persona) {
  const texts = [card.description, card.personality, card.scenario, card.mesExample, card.systemPrompt, card.postHistoryInstructions, persona?.description, ...(preset?.prompts ?? []).map(p => p.content)]
  return texts.some(hasEjs)
}

/** Template writes to the app-wide variables (the plugin's `global` scope), saved in settings. */
async function saveGlobalWrites(store, writes) {
  if (!writes?.length) return
  // Too big to keep (store.mjs GLOBAL_VARS_MAX): left unwritten, as a turn's are; the chat opens all the same.
  await store.updateSettings(settings => ({ globalVars: applyWrites(settings.globalVars ?? {}, writes) })).catch(error => {
    if (error.status !== 400) throw error
  })
}

/**
 * Another of the card's openings for a chat nobody has played yet (a card's
 * welcome page that switches the first message, as SillyTavern's swipes do),
 * with that opening's variables.
 */
export async function switchOpening(store, chat, index) {
  if (Object.values(chat.nodes).some(node => node.parent === 'root')) throw httpError(409, msg`对话已经开始，不能再换开场白`)
  const card = await store.getCard(chat.cardId)
  const greetings = greetingsOf(card)
  if (!Number.isInteger(index) || index < 0 || index >= greetings.length) throw httpError(400, msg`没有这个开场白`)
  const [settings, { persona }, globalScripts, regexSets] = await Promise.all([store.getSettings(), chatPicks(store, chat, card), store.getRegex(), store.getRegexSets()])
  const preset = await presetFor(store, chat.presetId ?? '')
  const books = await booksForCard(store, card, settings, chat)
  const ctx = { names: chat.names, card, preset, books, scripts: scriptsOf(card, preset, globalScripts, regexSets), local: chat.frameVars ?? {}, global: settings.globalVars ?? {} }
  const opened = openWith(ctx, initialState(books, initvarText(chat.names)), greetings[index])
  Object.assign(chat.nodes.root, { text: opened.text, display: displayText(opened.text), state: opened.state })
  if (opened.errors.length) chat.nodes.root.templateErrors = opened.errors
  else delete chat.nodes.root.templateErrors
  if (opened.local.length) chat.frameVars = applyWrites(chat.frameVars ?? {}, opened.local)
  await saveGlobalWrites(store, opened.global)
  // Nothing has been sent yet: a prefix whose templates read the opening's state is rendered again.
  if (prefixHasTemplates(card, preset, persona)) await rebuildPrompt(store, chat, chat.presetId ?? '')
  chat.updatedAt = new Date().toISOString()
  return store.saveChat(chat)
}

/**
 * MVU per-greeting variables: an <initvar> YAML/JSON block in the chosen
 * opening replaces the card's [InitVar] values (as MVU does), then any update
 * block in the opening applies on top.
 */
export function greetingState(state, greeting) {
  return applyStateUpdates(openingInit(state, greeting), greeting.replace(/<initvar>[\s\S]*?<\/initvar>/gi, '')).state
}

/** The state an opening starts from: its <initvar> block, else the card's initial values. */
function openingInit(state, greeting) {
  const init = /<initvar>([\s\S]*?)<\/initvar>/i.exec(greeting)
  if (init) {
    try {
      const parsed = YAML.parse(init[1])
      if (isPlainObject(parsed)) return parsed
    } catch {
      // A malformed block keeps the card's initial values.
    }
  }
  return state
}

/**
 * A new chat for `cardId` whose root is what `makeRoot({ card, names, state, open })`
 * returns: { text, state, compaction?, title?, local?, global?, errors? }. `state` is
 * the card's initial one; `open(state, greeting)` makes an opening (openWith).
 * The frozen prefix's templates render once here, with the opening's state;
 * what they and the opening write is kept.
 * The persona and the style are the card's picks, else the defaults (newChatPicks).
 * @param options.userName - the player's name in this chat, instead of the card's or the persona's.
 */
async function startChat(store, cardId, makeRoot, { userName = '' } = {}) {
  const card = await store.getCard(cardId)
  const [personas, styles, settings, globalScripts, regexSets] = await Promise.all([store.getPersonas(), store.getStyles(), store.getSettings(), store.getRegex(), store.getRegexSets()])
  const preset = await presetFor(store, settings.presetId)
  const books = await booksForCard(store, card, settings)
  const picks = newChatPicks(card, personas, styles)
  const player = playerOf(card, picks.persona, userName || picks.name)
  const names = { char: card.name, user: player.name }
  const ctx = { names, card, preset, books, scripts: scriptsOf(card, preset, globalScripts, regexSets), local: {}, global: settings.globalVars ?? {} }
  const root = makeRoot({ card, names, state: initialState(books, initvarText(names)), open: (state, greeting) => openWith(ctx, state, greeting) })
  let frameVars = applyWrites({}, root.local)
  const globalVars = applyWrites(settings.globalVars ?? {}, root.global)
  const errors = [...(root.errors ?? [])]
  const now = new Date().toISOString()
  const prefix = prefixTemplates({ ...ctx, state: root.state, local: frameVars, global: globalVars, messages: [{ role: 'assistant', text: root.text }] })
  let built
  let globalWrites = root.global ?? []
  try {
    built = buildChatPrompt({ card, persona: player, style: picks.style.text, settings, books, hasState: Object.keys(root.state).length > 0, preset, render: prefix.render })
    built.systemPrompt = prefix.resolve(built.systemPrompt)
    const writes = prefix.writes()
    root.state = applyWrites(root.state, writes.message)
    frameVars = applyWrites(frameVars, writes.local)
    globalWrites = [...globalWrites, ...writes.global]
    errors.push(...prefix.errors)
  } finally {
    prefix.dispose()
  }
  await saveGlobalWrites(store, globalWrites)
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
    // 你的角色 and 文风 it was started with: kept when the card's picks or the defaults change (chatPicks).
    personaId: picks.persona.id,
    styleId: picks.style.id,
    tips: {},
    stateDirty: false,
    // Chat-wide variables: the template `local` scope, Tavern Helper's chat variables.
    ...(Object.keys(frameVars).length ? { frameVars } : {}),
    nodes: {
      root: {
        id: 'root',
        parent: null,
        role: 'assistant',
        text: root.text,
        display: displayText(root.text),
        state: root.state,
        ...(errors.length ? { templateErrors: errors } : {}),
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

// SillyTavern's default player names: the persona here names the player instead.
const DEFAULT_USER = /^(user|you|你)$/i

/**
 * A new chat for `cardId` from a SillyTavern chat file (st-chat.mjs): every
 * turn on one path, a reply's swipes as its other versions, each reply's
 * variables as SillyTavern kept them (else replayed from its update blocks).
 * Nodes are marked `imported`; nothing here wrote them, so a long chat is
 * compacted before it continues (engine.compactChat).
 * A last player message with no reply comes back as `pendingInput`.
 * @returns {{ chat, turns, chars, pendingInput }}
 */
export async function importSillyTavern(store, cardId, { text, filename = '' } = {}) {
  const st = readSillyTavernChat(text)
  const messages = [...st.messages]
  const opening = messages[0].role === 'assistant' ? messages.shift() : null
  const pendingInput = messages.at(-1)?.role === 'user' ? messages.pop().versions[0].text : ''
  const title = String(filename).replace(/\.jsonl$/i, '').trim().slice(0, 60)
  let base = {}
  const chat = await startChat(
    store,
    cardId,
    ({ card, state }) => {
      base = state
      const first = opening?.versions[opening.selected] ?? { text: '', state: null }
      return { text: first.text, state: first.state ? mergeState(state, first.state) : greetingState(state, first.text), title: msg`${title || card.name}（导入）` }
    },
    { userName: DEFAULT_USER.test(st.userName) ? '' : st.userName },
  )
  const now = new Date().toISOString()
  const root = chat.nodes.root
  root.imported = 'sillytavern'
  let parent = root
  let chars = root.text.length
  for (let i = 0; i < messages.length; i += 2) {
    const said = messages[i].versions[0]
    const reply = messages[i + 1]
    const user = { id: newId(), parent: parent.id, role: 'user', text: said.text, prompt: said.text, injected: [], injectedTitles: [], templateErrors: [], sel: null, createdAt: said.at ?? now, imported: true }
    chat.nodes[user.id] = user
    parent.sel = user.id
    chars += said.text.length
    let chosen = null
    reply.versions.forEach((version, index) => {
      const { state, changes } = version.state ? { state: mergeState(base, version.state), changes: [] } : applyStateUpdates(parent.state, version.text)
      const node = { id: newId(), parent: user.id, role: 'assistant', text: version.text, display: displayText(version.text), state, stateChanges: changes, sdk: null, model: null, sel: null, createdAt: version.at ?? now, imported: true }
      chat.nodes[node.id] = node
      if (index === reply.selected) chosen = node
    })
    chars += chosen.text.length
    user.sel = chosen.id
    parent = chosen
  }
  chat.updatedAt = now
  return { chat: await store.saveChat(chat), turns: messages.length / 2, chars, pendingInput }
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
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
}

/** The child a node continues into: its `sel`, else the newest. */
function nextOf(chat, node) {
  const kids = childrenOf(chat, node.id)
  return kids.find(kid => kid.id === node.sel) ?? kids.at(-1) ?? null
}

/**
 * Follow `sel` pointers from the root; falls back to the newest child. A node
 * marked `cut` (rolled back to) ends the path; what follows it is kept, folded.
 * A node met again (a damaged chat file) ends it too.
 */
export function activePath(chat) {
  const path = []
  const seen = new Set()
  let node = chat.nodes.root
  while (node && !seen.has(node)) {
    seen.add(node)
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
  const seen = new Set([last])
  for (let node = nextOf(chat, last); node && !seen.has(node); node = node.cut ? null : nextOf(chat, node)) {
    seen.add(node)
    if (node.role === 'user') turns++
  }
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
  while (node && !path.includes(node)) {
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
 * @param options.sentInput - input => the input as a turn sends it (the card's prompt-side regex, macros).
 * @returns what changed: { node, before, beforePrompt, behindCompaction, promptMissed }, promptMissed when
 *   the recorded prompt held the old input nowhere, so the model still reads it as it was.
 */
export function editMessage(chat, id, text, { sentInput = input => input } = {}) {
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
  let promptMissed = false
  if (node.role === 'assistant') {
    node.display = displayText(next)
    delete node.historyTrim
  } else if (typeof node.prompt === 'string') {
    const swapped = swapInput(node.prompt, sentInput(before), sentInput(next)) ?? swapInput(node.prompt, before, next)
    if (swapped === null) promptMissed = true
    else node.prompt = swapped
  }
  node.edited = { at: new Date().toISOString(), count: (node.edited?.count ?? 0) + 1 }
  // Context before the latest compaction is the recap, not these messages.
  const behindCompaction = path.slice(index + 1).some(n => n.compaction)
  return { node, before, beforePrompt, behindCompaction, promptMissed }
}

const INPUT_OPEN = '<玩家输入>\n'
const INPUT_CLOSE = '\n</玩家输入>'

/**
 * A turn's recorded prompt with the player's input swapped: the body of its
 * <玩家输入> block (found by the text that was sent, else the last such block)
 * and the preset's copy of it ({{lastUserMessage}} in <预设指令>), or, for a
 * prompt without that block, where the old text sits. null when it is in neither.
 */
function swapInput(prompt, before, next) {
  let start = prompt.lastIndexOf(`${INPUT_OPEN}${before}${INPUT_CLOSE}`)
  let end = start < 0 ? -1 : start + INPUT_OPEN.length + before.length
  if (start < 0) {
    start = prompt.lastIndexOf(INPUT_OPEN)
    end = start < 0 ? -1 : prompt.indexOf(INPUT_CLOSE, start + INPUT_OPEN.length)
  }
  if (end < 0) {
    const at = before ? prompt.indexOf(before) : -1
    return at < 0 ? null : prompt.slice(0, at) + next + prompt.slice(at + before.length)
  }
  const tail = prompt.slice(end).replace(/(<预设指令>\n)([\s\S]*?)(\n<\/预设指令>)/, (whole, open, body, close) => open + (before ? body.split(before).join(next) : body) + close)
  return prompt.slice(0, start + INPUT_OPEN.length) + next + tail
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
      // A player's message: the variables before it, with what its turn's templates wrote.
      state: node.role === 'assistant' ? node.state ?? {} : applyWrites(chat.nodes[node.parent]?.state ?? {}, node.templateWrites),
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
      // 联网: what the reply searched for and the pages it drew on.
      search: node.search ?? undefined,
      stateChanges: node.stateChanges ?? undefined,
      compaction: node.compaction ? compactionView(chat, node) : undefined,
      media: node.media?.images?.length ? node.media : undefined,
      // Brought in from SillyTavern (importSillyTavern): no model of ours wrote it.
      imported: node.imported || undefined,
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
    webSearch: Boolean(chat.webSearch),
    presetId: chat.presetId ?? null,
    presetName: chat.presetName ?? null,
    // null: a chat from before 你的角色 and 文风 were lists, on their first item.
    personaId: chat.personaId ?? null,
    styleId: chat.styleId ?? null,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    path,
    folded: foldedTurns(chat),
    // Turns a manual compaction would fold into a summary; 0 when there is nothing worth it.
    // (Not with turns folded behind a rollback: restored, they would follow a summary they never read.)
    compactable: tip.role === 'assistant' && (tip.sdk || tip.api || tip.imported) && sinceCompaction >= MIN_TURNS && !childrenOf(chat, tip.id).length ? sinceCompaction : 0,
    state: lastAssistant?.state ?? {},
    // The chat variables (Tavern Helper's chat scope, the templates' local scope), for the card's frames.
    frameVars: chat.frameVars ?? {},
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
    preview: (last?.role === 'user' ? last.text : markSpeakers(last?.display ?? '')).slice(0, 80),
  }
}
