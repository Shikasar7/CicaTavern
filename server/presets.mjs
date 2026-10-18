// SillyTavern Chat Completion presets ("OpenAI Settings" JSON: prompts +
// prompt_order). The prompts before the chat-history marker are rendered once
// into a chat's frozen system prompt, where the card markers (description,
// personality, worldbook...) expand in the preset's own order.
//
// SillyTavern sends the prompts after the marker (and depth injections) once,
// at the end of every request. Here every user message stays in the session
// history — and cannot be edited later without losing the cache for all that
// follows — so repeating them each turn would pile up thousands of characters
// per turn. By default ("prefix" mode) they join the frozen prefix, in order,
// under the every-turn rules; only the paragraphs that change per turn
// ({{lastUserMessage}}, dice, time) go into the turn's message. "turn" mode
// sends all of them each turn, closest to SillyTavern but growing the history.
import { normalizeScripts } from '../web/shared/regex.js'
import { httpError, newId } from './store.mjs'
import { replaceMacros } from './prompt.mjs'
import { msg } from './i18n.mjs'

export const MARKERS = new Set([
  'chatHistory', 'dialogueExamples', 'worldInfoBefore', 'worldInfoAfter',
  'charDescription', 'charPersonality', 'scenario', 'personaDescription',
])
const ROLES = new Set(['system', 'user', 'assistant'])
const str = value => (typeof value === 'string' ? value : '')

export function isPresetJson(json) {
  return Boolean(json && typeof json === 'object' && Array.isArray(json.prompts) && json.prompts.length)
}

// A preset as this app keeps it, edits made here included, to move it to another device.
export const PRESET_FORMAT = 'agent-tavern-preset'

export function exportPreset(preset) {
  return { format: PRESET_FORMAT, version: 1, exportedAt: new Date().toISOString(), preset }
}

/** An exported preset → a new preset (fresh id); null when the file is not one. */
export function importOwnPreset(json) {
  if (json?.format !== PRESET_FORMAT) return null
  const preset = json.preset
  const valid = preset && typeof preset.name === 'string' && Array.isArray(preset.prompts) &&
    preset.prompts.every(p => p && typeof p.id === 'string' && typeof p.content === 'string')
  if (!valid) throw httpError(400, msg`预设文件不完整`)
  return { ...preset, id: newId(), importedAt: new Date().toISOString() }
}

function countHelperScripts(value) {
  if (Array.isArray(value)) return value.length
  if (Array.isArray(value?.scripts)) return value.scripts.length
  return 0
}

export function normalizePreset(json, fallbackName = '预设') {
  if (!isPresetJson(json)) throw httpError(400, msg`这不是 SillyTavern 预设（没有 prompts）`)
  const byId = new Map(json.prompts.filter(p => p && typeof p.identifier === 'string').map(p => [p.identifier, p]))
  const orders = (Array.isArray(json.prompt_order) ? json.prompt_order : []).filter(o => Array.isArray(o?.order) && o.order.length)
  // 100001 is the order SillyTavern edits for every character; older files only have 100000.
  const chosen = orders.find(o => String(o.character_id) === '100001') ?? [...orders].sort((a, b) => b.order.length - a.order.length)[0]
  const order = chosen ? chosen.order : json.prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false }))
  const seen = new Set()
  const prompts = []
  for (const item of order) {
    const raw = byId.get(item?.identifier)
    if (!raw || seen.has(raw.identifier)) continue
    seen.add(raw.identifier)
    const content = str(raw.content)
    prompts.push({
      id: raw.identifier,
      name: str(raw.name).trim() || raw.identifier,
      role: ROLES.has(raw.role) ? raw.role : 'system',
      content,
      marker: raw.marker === true || (MARKERS.has(raw.identifier) && !content),
      absolute: Number(raw.injection_position) === 1,
      depth: Number.isFinite(Number(raw.injection_depth)) ? Number(raw.injection_depth) : 4,
      enabled: item.enabled !== false,
    })
  }
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : null)
  return {
    id: newId(),
    name: str(json.name).trim() || fallbackName,
    prompts,
    formats: {
      wi: str(json.wi_format) || '{0}',
      scenario: str(json.scenario_format) || '{{scenario}}',
      personality: str(json.personality_format) || '{{personality}}',
      exampleChat: str(json.new_example_chat_prompt) || '[Example Chat]',
    },
    regexScripts: normalizeScripts(json.extensions?.regex_scripts),
    helperScripts: countHelperScripts(json.extensions?.tavern_helper),
    // Sampling knobs: only maxTokens is used (for provider models, see engine replyCap).
    params: { temperature: num(json.temperature), topP: num(json.top_p), maxTokens: num(json.openai_max_tokens), maxContext: num(json.openai_max_context) },
    postMode: 'prefix',
    importedAt: new Date().toISOString(),
  }
}

/** 'pre' (before the chat history), 'post' (after it, or a depth injection) or 'marker'. */
export function sectionsOf(preset) {
  const history = preset.prompts.findIndex(p => p.id === 'chatHistory')
  return preset.prompts.map((p, index) => {
    if (p.marker) return 'marker'
    if (p.absolute) return 'post'
    return history >= 0 && index > history ? 'post' : 'pre'
  })
}

/**
 * Where the prompts after the chat history go. 'prefix': the frozen prefix (per-turn
 * paragraphs with the turn). 'turn': every turn's message, kept in the history.
 * 'latest': every turn's message, and dropped from older messages when a provider's
 * history is rebuilt, which is what SillyTavern sends.
 */
export const POST_MODES = ['prefix', 'latest', 'turn']
const sentEachTurn = preset => preset.postMode === 'turn' || preset.postMode === 'latest'

/** Whether the preset's post-history prompts went into the frozen prefix (not sent each turn). */
export function hasPrefixRules(preset) {
  if (!preset || sentEachTurn(preset)) return false
  const sections = sectionsOf(preset)
  return preset.prompts.some((p, i) => p.enabled && sections[i] === 'post' && str(p.content).trim())
}

// Macros whose value differs from one turn to the next.
const PER_TURN = /\{\{\s*(lastUserMessage|lastCharMessage|lastMessage|random|pick|roll|time|date|weekday|isotime|isodate|incvar|decvar|addvar|incglobalvar|decglobalvar|addglobalvar)\b/i

export function isPerTurn(content) {
  return PER_TURN.test(content)
}

/** The {{setvar::…}} / {{setglobalvar::…}} macros in a text, nested braces included. */
function setterMacros(text) {
  const found = []
  const start = /\{\{\s*set(?:global)?var\s*::/gi
  let match
  while ((match = start.exec(text))) {
    let depth = 0
    let i = match.index
    for (; i < text.length - 1; i++) {
      const pair = text.slice(i, i + 2)
      if (pair !== '{{' && pair !== '}}') continue
      depth += pair === '{{' ? 1 : -1
      i++
      if (depth === 0) break
    }
    if (depth !== 0) break
    found.push(text.slice(match.index, i + 1))
    start.lastIndex = i + 1
  }
  return found
}

/** Paragraphs: split on blank lines and `---` rules, the way presets lay out blocks. */
function paragraphsOf(content) {
  return content.replace(/^[ \t]*-{3,}[ \t]*$/gm, '').split(/\n[ \t]*\n/).filter(p => p.trim())
}

/**
 * Where each prompt ends up: 'prefix' (frozen system prompt), 'turn' (each
 * turn's message), 'split' (its per-turn paragraphs go per turn, the rest into
 * the prefix) or 'marker' (card data placeholder).
 */
export function placementsOf(preset) {
  const turnMode = sentEachTurn(preset)
  return sectionsOf(preset).map((section, i) => {
    if (section === 'marker') return 'marker'
    if (section === 'pre') return 'prefix'
    if (turnMode) return 'turn'
    const paragraphs = paragraphsOf(preset.prompts[i].content)
    const perTurn = paragraphs.filter(isPerTurn).length
    if (!perTurn) return 'prefix'
    return perTurn === paragraphs.length ? 'turn' : 'split'
  })
}

export function presetSummary(preset) {
  const sections = sectionsOf(preset)
  const enabled = preset.prompts.filter((p, i) => p.enabled && sections[i] !== 'marker')
  return {
    id: preset.id,
    name: preset.name,
    prompts: preset.prompts.filter(p => !p.marker).length,
    enabled: enabled.length,
    regexScripts: preset.regexScripts.length,
    importedAt: preset.importedAt,
  }
}

export function presetDetail(preset) {
  const sections = sectionsOf(preset)
  const placements = placementsOf(preset)
  return {
    ...presetSummary(preset),
    postMode: POST_MODES.includes(preset.postMode) ? preset.postMode : 'prefix',
    helperScripts: preset.helperScripts ?? 0,
    params: preset.params ?? {},
    regexScriptList: preset.regexScripts,
    quick: preset.quick ?? [],
    prompts: preset.prompts.map((p, i) => ({ ...p, section: sections[i], placement: placements[i] })),
  }
}

/**
 * Apply an edit from the UI: name, postMode; per prompt enabled/content and,
 * as in SillyTavern's prompt editor, name/role/position (absolute = in-chat at
 * `depth`); `add` a new prompt, `remove` prompts, `order` (all ids, new order).
 */
export function editPreset(preset, patch) {
  if (typeof patch.name === 'string' && patch.name.trim()) preset.name = patch.name.trim().slice(0, 80)
  if (POST_MODES.includes(patch.postMode)) preset.postMode = patch.postMode
  for (const change of Array.isArray(patch.prompts) ? patch.prompts : []) {
    const prompt = preset.prompts.find(p => p.id === change?.id)
    if (!prompt) continue
    if (typeof change.enabled === 'boolean') prompt.enabled = change.enabled
    if (prompt.marker) continue
    if (typeof change.content === 'string') prompt.content = change.content
    if (typeof change.title === 'string' && change.title.trim()) prompt.name = change.title.trim().slice(0, 80)
    if (ROLES.has(change.role)) prompt.role = change.role
    if (typeof change.absolute === 'boolean') prompt.absolute = change.absolute
    if (change.depth !== undefined) {
      const depth = Math.trunc(Number(change.depth))
      if (Number.isFinite(depth)) prompt.depth = Math.min(999, Math.max(0, depth))
    }
  }
  if (patch.add && typeof patch.add === 'object') {
    const prompt = {
      id: `custom-${newId()}`,
      name: str(patch.add.name).trim().slice(0, 80) || '新条目',
      role: ROLES.has(patch.add.role) ? patch.add.role : 'system',
      content: str(patch.add.content),
      marker: false,
      absolute: false,
      depth: 4,
      enabled: true,
    }
    // New entries go just before the chat history, where SillyTavern users usually want them.
    const history = preset.prompts.findIndex(p => p.id === 'chatHistory')
    preset.prompts.splice(history >= 0 ? history : preset.prompts.length, 0, prompt)
  }
  if (Array.isArray(patch.remove)) {
    const gone = new Set(patch.remove.filter(id => preset.prompts.some(p => p.id === id && !p.marker)))
    preset.prompts = preset.prompts.filter(p => !gone.has(p.id))
    if (preset.quick) preset.quick = preset.quick.filter(id => !gone.has(id))
  }
  if (Array.isArray(patch.order)) {
    const ids = preset.prompts.map(p => p.id)
    const order = patch.order.map(String)
    if (order.length !== ids.length || new Set(order).size !== ids.length || !order.every(id => ids.includes(id))) {
      throw httpError(409, msg`条目列表已经变了，刷新后再排`)
    }
    const byId = new Map(preset.prompts.map(p => [p.id, p]))
    preset.prompts = order.map(id => byId.get(id))
  }
  // Entries pinned to the chat's quick-switch panel (what Tavern Helper floating menus are usually for).
  if (Array.isArray(patch.quick)) {
    const known = new Set(preset.prompts.filter(p => !p.marker).map(p => p.id))
    preset.quick = [...new Set(patch.quick.filter(id => known.has(id)))].slice(0, 40)
  }
  return preset
}

// ─── Macros ─────────────────────────────────────────────────────────────

/**
 * SillyTavern macros as presets use them: names, {{setvar}}/{{getvar}} and
 * friends (the variables carry from the prefix into every turn), the last
 * messages, dates, {{random}}/{{roll}}. Innermost macros resolve first; an
 * unknown macro is left as written.
 */
export function expandMacros(text, ctx) {
  const source = String(text ?? '').replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
  // {{trim}} removes the whitespace around it.
  return expandFrom(source, 0, ctx, false).text.replace(/\s*\u0001\s*/g, '')
}

/**
 * Left to right, so a {{setvar}} takes effect before a later {{getvar}};
 * a macro's arguments are expanded before the macro itself.
 * @returns { text, end } — `end` is the index after the closing braces when `inner`.
 */
function expandFrom(source, start, ctx, inner) {
  let out = ''
  let i = start
  while (i < source.length) {
    if (source.startsWith('{{', i)) {
      const body = expandFrom(source, i + 2, ctx, true)
      if (body.end < 0) {
        out += source.slice(i)
        return { text: out, end: -1 }
      }
      const value = macroValue(body.text, ctx)
      out += value === undefined ? `{{${body.text}}}` : value
      i = body.end
    } else if (inner && source.startsWith('}}', i)) {
      return { text: out, end: i + 2 }
    } else {
      out += source[i]
      i++
    }
  }
  return { text: out, end: inner ? -1 : i }
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const pad2 = n => String(n).padStart(2, '0')

function macroValue(body, ctx) {
  const [head, ...args] = body.split('::')
  const key = head.trim().toLowerCase()
  const vars = ctx.vars
  const globals = ctx.globals ?? vars
  const name = (args[0] ?? '').trim()
  const now = new Date()
  const bump = (scope, delta) => {
    const next = (Number(scope[name]) || 0) + delta
    scope[name] = String(next)
    return String(next)
  }
  const add = scope => {
    const current = scope[name] ?? ''
    const value = args.slice(1).join('::')
    const a = Number(current)
    const b = Number(value)
    scope[name] = current !== '' && value !== '' && Number.isFinite(a) && Number.isFinite(b) ? String(a + b) : current + value
    return ''
  }
  switch (key) {
    case 'char': return ctx.names.char
    case 'user': return ctx.names.user
    case 'newline': return '\n'
    case 'trim': return '\u0001'
    case 'noop': return ''
    case 'original': return ctx.original ?? ''
    case 'setvar': vars[name] = args.slice(1).join('::'); return ''
    case 'getvar': return vars[name] ?? ''
    case 'addvar': return add(vars)
    case 'incvar': return bump(vars, 1)
    case 'decvar': return bump(vars, -1)
    case 'setglobalvar': globals[name] = args.slice(1).join('::'); return ''
    case 'getglobalvar': return globals[name] ?? ''
    case 'addglobalvar': return add(globals)
    case 'incglobalvar': return bump(globals, 1)
    case 'decglobalvar': return bump(globals, -1)
    case 'lastusermessage': return ctx.lastUser ?? ''
    case 'lastcharmessage': return ctx.lastChar ?? ''
    case 'lastmessage': return ctx.lastUser ?? ctx.lastChar ?? ''
    case 'description': return ctx.card?.description ?? ''
    case 'personality': return ctx.card?.personality ?? ''
    case 'scenario': return ctx.card?.scenario ?? ''
    case 'persona': return ctx.persona?.description ?? ''
    case 'mesexamples': return ctx.card?.mesExample ?? ''
    case 'charprompt': return ctx.card?.systemPrompt ?? ''
    case 'charjailbreak': return ctx.card?.postHistoryInstructions ?? ''
    // By hand, not toLocale*String('zh-CN'): the Android app's Node has no ICU and would answer in English.
    case 'date': return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
    case 'time': return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
    case 'weekday': return WEEKDAYS[now.getDay()]
    case 'isodate': return now.toISOString().slice(0, 10)
    case 'isotime': return now.toTimeString().slice(0, 5)
  }
  if (/^(random|pick|roll)\b/.test(key)) return replaceMacros(`{{${body.replace(/^\s*pick/i, 'random')}}}`, ctx.names)
  return undefined
}

// ─── Assembly ───────────────────────────────────────────────────────────

/** A tag opened right before the chat history and closed right after it wraps
 * history we do not inline (the SDK session carries it), so both halves go. */
function historyWrapper(preset, sections) {
  const history = preset.prompts.findIndex(p => p.id === 'chatHistory')
  if (history < 0) return new Set()
  const before = preset.prompts.slice(0, history).map((p, i) => [p, i]).reverse().find(([p, i]) => p.enabled && sections[i] === 'pre')
  const after = preset.prompts.slice(history + 1).map((p, i) => [p, i + history + 1]).find(([p, i]) => p.enabled && sections[i] === 'post' && !p.absolute)
  if (!before || !after) return new Set()
  const opened = [...before[0].content.matchAll(/<([^\s<>/]+)>/g)].map(m => m[1]).filter(tag => !before[0].content.includes(`</${tag}>`))
  const closes = opened.find(tag => after[0].content.includes(`</${tag}>`) && !after[0].content.includes(`<${tag}>`))
  return closes ? new Set([before[0].id, after[0].id]) : new Set()
}

/**
 * The preset's part of the frozen system prompt.
 * @param data - { card, persona, names, worldBefore, worldAfter } with the
 *   constant worldbook text already rendered.
 * @returns { text, rules, vars }: `text` is the part before the chat history,
 *   `rules` the post-history prompts that read the same every turn (prefix
 *   mode), `vars` the macro variables every later turn starts from.
 */
export function renderPresetPrefix(preset, { card, persona, names, worldBefore = '', worldAfter = '' }) {
  const sections = sectionsOf(preset)
  const skip = historyWrapper(preset, sections)
  const vars = {}
  const ctx = { names, vars, card, persona }
  const m = text => expandMacros(text, ctx).trim()
  const format = (template, value, macro) => (value.trim() ? m(template.replace(macro, () => value)) : '')
  const markers = {
    personaDescription: () => m(persona.description),
    charDescription: () => m(card.description),
    charPersonality: () => format(preset.formats.personality, card.personality, /\{\{personality\}\}/gi),
    scenario: () => format(preset.formats.scenario, card.scenario, /\{\{scenario\}\}/gi),
    dialogueExamples: () => m(card.mesExample.replace(/<START>/gi, preset.formats.exampleChat)),
    worldInfoBefore: () => (worldBefore ? preset.formats.wi.replace('{0}', () => worldBefore) : ''),
    worldInfoAfter: () => (worldAfter ? preset.formats.wi.replace('{0}', () => worldAfter) : ''),
  }
  const parts = []
  let placedWorld = false
  preset.prompts.forEach((p, i) => {
    if (!p.enabled || skip.has(p.id)) return
    if (sections[i] === 'marker') {
      if (p.id.startsWith('worldInfo')) placedWorld = true
      const render = markers[p.id]
      const text = render ? render() : ''
      if (text) parts.push(text)
      return
    }
    if (sections[i] !== 'pre') return
    // The card's own main prompt / post-history instructions replace the preset's, as in SillyTavern.
    let content = p.content
    if (p.id === 'main' && card.systemPrompt.trim()) {
      ctx.original = m(p.content)
      content = card.systemPrompt
    }
    const text = m(content)
    if (text) parts.push(text)
  })
  // A preset without worldbook markers would otherwise drop the constant entries.
  if (!placedWorld && (worldBefore || worldAfter)) parts.push([worldBefore, worldAfter].filter(Boolean).join('\n\n'))
  const rules = renderPost(preset, ctx, 'prefix')
  return { text: parts.join('\n\n'), rules, vars }
}

/**
 * The post-history prompts' paragraphs for one side: 'prefix' takes those that
 * read the same every turn, 'turn' those that change (in turn mode, all of
 * them). Depth injections come first, deepest first, as SillyTavern orders them.
 */
function renderPost(preset, ctx, side) {
  const sections = sectionsOf(preset)
  const skip = historyWrapper(preset, sections)
  const turnMode = sentEachTurn(preset)
  const relative = []
  const injected = []
  preset.prompts.forEach((p, i) => {
    if (!p.enabled || skip.has(p.id) || sections[i] !== 'post') return
    let content = p.content
    if (p.id === 'jailbreak' && ctx.card.postHistoryInstructions.trim()) {
      ctx.original = expandMacros(p.content, ctx).trim()
      content = ctx.card.postHistoryInstructions
    }
    const texts = []
    for (const para of paragraphsOf(content)) {
      if ((turnMode || isPerTurn(para)) === (side === 'turn')) texts.push(expandMacros(para, ctx).trim())
      // A per-turn paragraph may also set a variable a later prefix paragraph reads (an output
      // order listing {{getvar::…}} blocks): set it now, as SillyTavern's in-order pass would.
      else if (side === 'prefix') for (const setter of setterMacros(para)) expandMacros(setter, ctx)
    }
    const text = texts.filter(Boolean).join('\n\n')
    if (!text) return
    if (p.absolute) injected.push({ text, depth: p.depth })
    else relative.push(text)
  })
  injected.sort((a, b) => b.depth - a.depth)
  return [...injected.map(x => x.text), ...relative].join('\n\n')
}

/** The preset's part of one turn's message: the paragraphs that change per turn (all post-history ones in turn mode). */
export function renderPresetTail(preset, { card, persona, names, vars = {}, input = '', lastChar = '' }) {
  return renderPost(preset, { names, vars: { ...vars }, card, persona, lastUser: input, lastChar }, 'turn')
}
