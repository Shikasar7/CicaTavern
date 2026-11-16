// The Tavern Helper scripts an imported SillyTavern preset carries, and the preset as Tavern Helper's preset functions
// see it (getPreset / replacePreset). The scripts run as a card's do (card-scripts.mjs, web/card-scripts.js), in every
// chat that uses the preset; their text is kept in a file beside the preset (store.getPresetScripts), since a big one
// is most of a megabyte and the preset list reads every preset whole. The preset keeps what each is (helperList) and
// whether it is on, which the player switches in the preset window.
import { helperScriptsOf } from './schema.mjs'
import { cleanHelperList, helperSummary } from './helper-scripts.mjs'
import { cleanEntry } from '../web/shared/frame-permissions.js'

// A preset's scripts at most, all together (a big preset's seven came to 1.2 MB).
const MAX_SCRIPTS_CHARS = 8_000_000
const MAX_SCRIPTS = 40
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const str = value => (typeof value === 'string' ? value : '')

/**
 * The scripts a preset file carries, each as kept beside the preset: { id, name, content, enabled, button, info }.
 * A SillyTavern preset has them in its extensions; a preset this app exported, in `helperScriptList`.
 */
export function presetScriptsOf(json) {
  const listed = json?.format ? json?.preset?.helperScriptList : helperScriptsOf(json?.extensions)
  let room = MAX_SCRIPTS_CHARS
  return (Array.isArray(listed) ? listed : [])
    .filter(script => isRecord(script) && typeof script.content === 'string')
    .slice(0, MAX_SCRIPTS)
    .filter(script => (room -= script.content.length) >= 0)
    .map(script => ({
      id: str(script.id).slice(0, 80),
      name: str(script.name).slice(0, 120),
      content: script.content,
      enabled: script.enabled !== false,
      ...(isRecord(script.button) ? { button: { enabled: script.button.enabled !== false, buttons: (Array.isArray(script.button.buttons) ? script.button.buttons : []).filter(isRecord).slice(0, 20).map(b => ({ name: str(b.name).slice(0, 40), visible: b.visible !== false })) } } : {}),
      info: str(script.info).slice(0, 4000),
      // Its own variables (Tavern Helper's script variables): its settings, as its author shipped them.
      ...(isRecord(script.data) && JSON.stringify(script.data).length <= 200_000 ? { data: script.data } : {}),
    }))
}

/** `preset` told what scripts it now has (their text is saved beside it): each on as its file had it. */
export function withPresetScripts(preset, scripts) {
  preset.helperScripts = scripts.length
  preset.helperList = cleanHelperList(helperSummary(scripts)) ?? []
  preset.helperSaved = scripts.length > 0
  // When they were read: a page running the old ones starts the new ones (web/app.js presetPageScripts).
  preset.helperReadAt = new Date().toISOString()
  return preset
}

/** A preset's scripts as they run: the text kept beside it, each on or off as the player switched it. */
export function scriptsAsSwitched(preset, scripts) {
  const list = Array.isArray(preset?.helperList) ? preset.helperList : []
  return (scripts ?? []).map((script, i) => ({ ...script, enabled: list[i] ? list[i].on !== false : script.enabled !== false }))
}

/** What the player lets this preset's scripts do: as frame-permissions.js keeps a card's. */
export function presetPermissions(preset) {
  return cleanEntry(preset?.scriptPermissions)
}

// ─── The preset as Tavern Helper's functions see it ─────────────────────
// SillyTavern's own entries are named differently there.
const TH_IDS = {
  enhanceDefinitions: 'enhance_definitions',
  worldInfoBefore: 'world_info_before',
  personaDescription: 'persona_description',
  charDescription: 'char_description',
  charPersonality: 'char_personality',
  worldInfoAfter: 'world_info_after',
  dialogueExamples: 'dialogue_examples',
  chatHistory: 'chat_history',
}
const FROM_TH = Object.fromEntries(Object.entries(TH_IDS).map(([own, th]) => [th, own]))
const ROLES = new Set(['system', 'user', 'assistant'])

function thPrompt(prompt) {
  const position = prompt.absolute ? { type: 'in_chat', depth: prompt.depth ?? 4, order: 100 } : { type: 'relative' }
  const id = TH_IDS[prompt.id] ?? prompt.id
  if (prompt.marker) return { id, name: prompt.name, enabled: prompt.enabled !== false, position }
  return { id, name: prompt.name, enabled: prompt.enabled !== false, position, role: prompt.role, content: prompt.content ?? '' }
}

/** One of this app's presets in Tavern Helper's shape (getPreset). A built-in preset is read as its entries. */
export function thPreset(preset) {
  const params = preset?.params ?? {}
  return {
    settings: {
      max_context: params.maxContext ?? 200000,
      max_completion_tokens: params.maxTokens ?? 8192,
      reply_count: 1,
      should_stream: true,
      temperature: params.temperature ?? 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      top_p: params.topP ?? 1,
      repetition_penalty: 1,
      min_p: 0,
      top_k: 0,
      top_a: 0,
      seed: -1,
      squash_system_messages: false,
      reasoning_effort: 'auto',
      request_thoughts: false,
      request_images: false,
      enable_function_calling: false,
      enable_web_search: false,
      allow_sending_images: 'disabled',
      allow_compressing_images: false,
      character_name_prefix: 'none',
      wrap_user_messages_in_quotes: false,
    },
    prompts: (preset?.prompts ?? []).map(thPrompt),
    prompts_unused: [],
    extensions: {},
  }
}

/**
 * `th` (Tavern Helper's shape, as replacePreset hands it) put into `preset`: each entry's switch, text, name, role
 * and place, the order of the entries, new entries added. An entry left out stays as it was; one moved to
 * prompts_unused is switched off (nothing outside the order is sent). → whether anything changed.
 */
export function applyThPreset(preset, th) {
  if (!isRecord(th) || !Array.isArray(th.prompts)) throw new Error('预设的格式不对：缺少 prompts')
  const before = JSON.stringify([preset.prompts, preset.params])
  // The settings as getPreset showed them: only what a script changed is taken (a default shown is no setting).
  const shown = thPreset(preset).settings
  const byId = new Map(preset.prompts.map(p => [p.id, p]))
  const seen = new Set()
  const ordered = []
  const take = (item, used) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) return
    const id = FROM_TH[item.id] ?? item.id
    if (seen.has(id)) return
    let prompt = byId.get(id)
    if (!prompt) {
      // A new entry: only one with text of its own (SillyTavern's own entries are never new).
      if (!used || typeof item.content !== 'string') return
      prompt = { id: id.slice(0, 80), name: '', role: 'system', content: '', marker: false, absolute: false, depth: 4, enabled: true }
    }
    seen.add(id)
    if (used) {
      if (typeof item.enabled === 'boolean') prompt.enabled = item.enabled
      if (!prompt.marker) {
        if (typeof item.content === 'string') prompt.content = item.content
        if (typeof item.name === 'string' && item.name.trim()) prompt.name = item.name.trim().slice(0, 80)
        if (ROLES.has(item.role)) prompt.role = item.role
      }
      if (isRecord(item.position)) {
        if (item.position.type === 'in_chat') {
          prompt.absolute = true
          const depth = Math.trunc(Number(item.position.depth))
          if (Number.isFinite(depth)) prompt.depth = Math.min(999, Math.max(0, depth))
        } else if (item.position.type === 'relative') prompt.absolute = false
      }
      if (!prompt.name) prompt.name = prompt.id
      ordered.push(prompt)
    } else prompt.enabled = false
  }
  th.prompts.forEach(item => take(item, true))
  if (Array.isArray(th.prompts_unused)) th.prompts_unused.forEach(item => take(item, false))
  // Those not in the order (left out, or moved to prompts_unused) keep their places after the ordered ones.
  preset.prompts = [...ordered, ...preset.prompts.filter(p => !ordered.includes(p))]
  if (isRecord(th.settings)) {
    const num = value => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : undefined)
    const params = { ...preset.params }
    const set = (key, thKey) => {
      const value = num(th.settings[thKey])
      if (value !== undefined && value !== shown[thKey]) params[key] = value
    }
    set('temperature', 'temperature')
    set('topP', 'top_p')
    set('maxTokens', 'max_completion_tokens')
    set('maxContext', 'max_context')
    preset.params = params
  }
  if (preset.quick) preset.quick = preset.quick.filter(id => preset.prompts.some(p => p.id === id))
  return JSON.stringify([preset.prompts, preset.params]) !== before
}
