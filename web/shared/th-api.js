// Tavern Helper (酒馆助手 4.x) as cards' scripts see it, in one place: the events SillyTavern, MVU and Tavern Helper fire,
// and every script function by module. The page's frames (web/compat.js), the server's sandbox (server/card-scripts.mjs)
// and 检查这张卡's reading of a card's scripts (server/helper-scripts.mjs) all go by this, so one list says what there is.
// Old Android WebViews read this: nothing newer than Chrome 80.

// SillyTavern's own events, by key; their values are what scripts listen for.
const KEYS = 'APP_READY EXTRAS_CONNECTED MESSAGE_SWIPED MESSAGE_SENT MESSAGE_RECEIVED MESSAGE_EDITED MESSAGE_DELETED MESSAGE_UPDATED MESSAGE_FILE_EMBEDDED MESSAGE_REASONING_EDITED MESSAGE_REASONING_DELETED MESSAGE_SWIPE_DELETED MORE_MESSAGES_LOADED IMPERSONATE_READY GENERATION_STARTED GENERATION_STOPPED GENERATION_ENDED SD_PROMPT_PROCESSING EXTENSIONS_FIRST_LOAD EXTENSION_SETTINGS_LOADED SETTINGS_LOADED SETTINGS_UPDATED MOVABLE_PANELS_RESET SETTINGS_LOADED_BEFORE SETTINGS_LOADED_AFTER CHATCOMPLETION_SOURCE_CHANGED CHATCOMPLETION_MODEL_CHANGED OAI_PRESET_CHANGED_BEFORE OAI_PRESET_CHANGED_AFTER OAI_PRESET_EXPORT_READY OAI_PRESET_IMPORT_READY WORLDINFO_SETTINGS_UPDATED WORLDINFO_UPDATED CHARACTER_EDITOR_OPENED CHARACTER_EDITED CHARACTER_PAGE_LOADED USER_MESSAGE_RENDERED CHARACTER_MESSAGE_RENDERED FORCE_SET_BACKGROUND CHAT_DELETED CHAT_CREATED GENERATE_BEFORE_COMBINE_PROMPTS GENERATE_AFTER_COMBINE_PROMPTS GENERATE_AFTER_DATA WORLD_INFO_ACTIVATED TEXT_COMPLETION_SETTINGS_READY CHAT_COMPLETION_SETTINGS_READY CHAT_COMPLETION_PROMPT_READY CHARACTER_FIRST_MESSAGE_SELECTED CHARACTER_DUPLICATED CHARACTER_RENAMED CHARACTER_RENAMED_IN_PAST_CHAT STREAM_REASONING_DONE FILE_ATTACHMENT_DELETED WORLDINFO_FORCE_ACTIVATE OPEN_CHARACTER_LIBRARY ONLINE_STATUS_CHANGED IMAGE_SWIPED CONNECTION_PROFILE_LOADED CONNECTION_PROFILE_CREATED CONNECTION_PROFILE_DELETED CONNECTION_PROFILE_UPDATED TOOL_CALLS_PERFORMED TOOL_CALLS_RENDERED SECRET_WRITTEN SECRET_DELETED SECRET_ROTATED SECRET_EDITED PRESET_CHANGED PRESET_DELETED PRESET_RENAMED PRESET_RENAMED_BEFORE MAIN_API_CHANGED WORLDINFO_ENTRIES_LOADED WORLDINFO_SCAN_DONE MEDIA_ATTACHMENT_DELETED'.split(' ')

export const TAVERN_EVENTS = Object.freeze(Object.assign(
  Object.fromEntries(KEYS.map(key => [key, key.toLowerCase()])),
  {
    CHAT_CHANGED: 'chat_id_changed',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
    SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received',
    // Kept in capitals by SillyTavern itself.
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  },
))

// Tavern Helper's own, around a frame's generate.
export const IFRAME_EVENTS = Object.freeze({
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_REQUESTED: 'js_generation_requested',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  REASONING_TOKEN_RECEIVED_FULLY: 'js_reasoning_token_received_fully',
  REASONING_TOKEN_RECEIVED_INCREMENTALLY: 'js_reasoning_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended',
})

// MVU's, with the spelling it has always had.
export const MVU_EVENTS = Object.freeze({
  VARIABLE_INITIALIZED: 'mag_variable_initiailized',
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  COMMAND_PARSED: 'mag_command_parsed',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
})

const HOST_EVENTS = new Set([...Object.values(TAVERN_EVENTS), ...Object.values(IFRAME_EVENTS), ...Object.values(MVU_EVENTS)])

/** Whether an event name is one of SillyTavern's, Tavern Helper's or MVU's (a card's own is none of these). */
export const isHostEvent = type => HOST_EVENTS.has(type)

// Every script function of Tavern Helper 4.8, by its module (JS-Slash-Runner @types/function), and the event helpers.
export const TH_FUNCTIONS = Object.freeze({
  audio: ['playAudio', 'pauseAudio', 'getAudioList', 'replaceAudioList', 'appendAudioList', 'getAudioSettings', 'setAudioSettings', 'getCurrentAudio'],
  character: ['getCharData', 'getCharAvatarPath', 'getChatHistoryBrief', 'getChatHistoryDetail', 'getCharacter', 'getCharacterNames', 'getCurrentCharacterName', 'createCharacter', 'createOrReplaceCharacter', 'replaceCharacter', 'updateCharacterWith', 'deleteCharacter'],
  chat_message: ['getChatMessages', 'setChatMessages', 'setChatMessage', 'createChatMessages', 'deleteChatMessages', 'rotateChatMessages'],
  displayed_message: ['formatAsDisplayedMessage', 'retrieveDisplayedMessage', 'refreshOneMessage'],
  event: ['eventOn', 'eventOnce', 'eventMakeFirst', 'eventMakeLast', 'eventOnButton', 'eventEmit', 'eventEmitAndWait', 'eventRemoveListener', 'eventClearEvent', 'eventClearListener', 'eventClearAll'],
  extension: ['isAdmin', 'getExtensionType', 'getExtensionInstallationInfo', 'installExtension', 'uninstallExtension', 'reinstallExtension', 'updateExtension'],
  generate: ['generate', 'generateRaw', 'stopGenerationById', 'stopAllGeneration'],
  global: ['initializeGlobal', 'waitGlobalInitialized'],
  import_raw: ['importRawCharacter', 'importRawChat', 'importRawPreset', 'importRawWorldbook', 'importRawTavernRegex'],
  inject: ['injectPrompts', 'uninjectPrompts'],
  lorebook: ['getLorebookSettings', 'setLorebookSettings', 'getCharLorebooks', 'setCurrentCharLorebooks', 'getLorebooks', 'createLorebook', 'deleteLorebook', 'getChatLorebook', 'setChatLorebook', 'getOrCreateChatLorebook'],
  lorebook_entry: ['getLorebookEntries', 'setLorebookEntries', 'replaceLorebookEntries', 'updateLorebookEntriesWith', 'createLorebookEntries', 'createLorebookEntry', 'deleteLorebookEntries', 'deleteLorebookEntry'],
  macro_like: ['registerMacroLike', 'unregisterMacroLike'],
  persona: ['getPersona', 'getPersonaNames', 'getPersonaIds', 'getCurrentPersonaName', 'getCurrentPersonaId', 'getPersonaAvatarPath', 'createPersona', 'createOrReplacePersona', 'replacePersona', 'updatePersonaWith', 'deletePersona'],
  preset: ['getPresetNames', 'getLoadedPresetName', 'loadPreset', 'getPreset', 'createPreset', 'createOrReplacePreset', 'replacePreset', 'updatePresetWith', 'setPreset', 'deletePreset', 'renamePreset'],
  script: ['getScriptId', 'getScriptName', 'getScriptInfo', 'replaceScriptInfo', 'getScriptButtons', 'replaceScriptButtons', 'appendInexistentScriptButtons', 'updateScriptButtonsWith', 'getButtonEvent', 'getAllEnabledScriptButtons', 'getScriptTrees'],
  slash: ['triggerSlash', 'triggerSlashWithResult'],
  tavern_regex: ['formatAsTavernRegexedString', 'isCharacterTavernRegexesEnabled', 'getTavernRegexes', 'replaceTavernRegexes', 'updateTavernRegexesWith'],
  util: ['substitudeMacros', 'getLastMessageId', 'getCurrentMessageId', 'getMessageId', 'getIframeName', 'errorCatched', 'reloadIframe'],
  variables: ['getVariables', 'replaceVariables', 'updateVariablesWith', 'insertOrAssignVariables', 'insertVariables', 'deleteVariable', 'getAllVariables', 'registerVariableSchema'],
  version: ['getTavernHelperVersion', 'getFrontendVersion', 'getTavernVersion', 'updateTavernHelper', 'updateFrontendVersion'],
  worldbook: ['getWorldbookNames', 'getGlobalWorldbookNames', 'rebindGlobalWorldbooks', 'getCharWorldbookNames', 'rebindCharWorldbooks', 'getChatWorldbookName', 'rebindChatWorldbook', 'getOrCreateChatWorldbook', 'createWorldbook', 'createOrReplaceWorldbook', 'deleteWorldbook', 'getWorldbook', 'replaceWorldbook', 'updateWorldbookWith', 'createWorldbookEntries', 'deleteWorldbookEntries'],
})

const MODULE_OF = new Map(Object.entries(TH_FUNCTIONS).flatMap(([module, names]) => names.map(name => [name, module])))
const CALLED = new RegExp(`\\b(${[...MODULE_OF.keys()].join('|')})\\s*\\(`, 'g')

/** The Tavern Helper functions a script's code calls, each once, in the order first met. */
export function calledFunctions(code) {
  return [...new Set([...String(code ?? '').matchAll(CALLED)].map(match => match[1]))]
}

/** The module a Tavern Helper function belongs to ('' for one it does not have). */
export const moduleOf = name => MODULE_OF.get(name) ?? ''

/**
 * Tavern Helper's older lorebook functions (getLorebookEntries and the rest) over today's worldbook ones, for a card
 * frame (web/compat.js) and the server's sandbox (server/card-scripts.mjs) alike. Both put it in as source text, so it
 * uses nothing from outside itself.
 * @param world - { getWorldbook, replaceWorldbook, updateWorldbookWith, createWorldbookEntries, deleteWorldbookEntries,
 *   createWorldbook, names(): the chat's book names, charBooks(): { primary, additional } } as each has them
 */
export function olderLorebooks(world) {
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  const deepMerge = (base, change) => {
    const out = clone(base)
    for (const [key, value] of Object.entries(change || {})) out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : clone(value)
    return out
  }
  // The older entry shape ⇄ today's.
  const legacyOf = (e, index) => ({
    uid: e.uid, display_index: index, comment: e.name, enabled: e.enabled, type: e.strategy?.type ?? 'selective',
    position: e.position?.type ?? 'before_character_definition', depth: e.position?.type === 'at_depth' ? e.position.depth : null, order: e.position?.order ?? 100,
    probability: e.probability ?? 100, keys: e.strategy?.keys ?? [], logic: e.strategy?.keys_secondary?.logic ?? 'and_any', filters: e.strategy?.keys_secondary?.keys ?? [],
    scan_depth: e.strategy?.scan_depth ?? 'same_as_global', case_sensitive: 'same_as_global', match_whole_words: 'same_as_global', use_group_scoring: 'same_as_global',
    automation_id: null, exclude_recursion: Boolean(e.recursion?.prevent_incoming), prevent_recursion: Boolean(e.recursion?.prevent_outgoing), delay_until_recursion: e.recursion?.delay_until ?? false,
    content: e.content ?? '', group: '', group_prioritized: false, group_weight: 100, sticky: e.effect?.sticky ?? null, cooldown: e.effect?.cooldown ?? null, delay: e.effect?.delay ?? null,
  })
  const fromLegacy = l => {
    const out = {}
    if (l.uid !== undefined) out.uid = Number(l.uid)
    if (l.comment !== undefined) out.name = l.comment
    if (l.enabled !== undefined) out.enabled = l.enabled
    if (l.content !== undefined) out.content = l.content
    if (l.probability !== undefined) out.probability = l.probability
    const strategy = {}
    if (l.type !== undefined) strategy.type = l.type
    if (l.keys !== undefined) strategy.keys = l.keys
    if (l.scan_depth !== undefined) strategy.scan_depth = l.scan_depth
    if (l.logic !== undefined || l.filters !== undefined) strategy.keys_secondary = { ...(l.logic !== undefined ? { logic: l.logic } : {}), ...(l.filters !== undefined ? { keys: l.filters } : {}) }
    if (Object.keys(strategy).length) out.strategy = strategy
    const position = {}
    if (l.position !== undefined) position.type = l.position
    if (l.depth !== undefined && l.depth !== null) position.depth = l.depth
    if (l.order !== undefined) position.order = l.order
    if (Object.keys(position).length) out.position = position
    return out
  }
  return {
    getLorebooks: () => world.names(),
    createLorebook: name => world.createWorldbook(name),
    getCharLorebooks: () => world.charBooks(),
    getCurrentCharPrimaryLorebook: () => world.charBooks().primary,
    getChatLorebook: () => null,
    getLorebookEntries: async name => (await world.getWorldbook(name)).map(legacyOf),
    replaceLorebookEntries: async (name, entries) => void (await world.replaceWorldbook(name, (entries || []).map(fromLegacy))),
    updateLorebookEntriesWith: async (name, updater) => {
      await world.updateWorldbookWith(name, async list => ((await updater(list.map(legacyOf))) || []).map(fromLegacy))
      return (await world.getWorldbook(name)).map(legacyOf)
    },
    setLorebookEntries: async (name, entries) => {
      const changes = new Map((entries || []).filter(e => e && e.uid !== undefined).map(e => [Number(e.uid), fromLegacy(e)]))
      await world.updateWorldbookWith(name, list => list.map(e => (changes.has(e.uid) ? deepMerge(e, changes.get(e.uid)) : e)))
    },
    createLorebookEntries: async (name, entries) => {
      const { worldbook, new_entries } = await world.createWorldbookEntries(name, (entries || []).map(fromLegacy))
      return { entries: worldbook.map(legacyOf), new_uids: new_entries.map(e => e.uid) }
    },
    createLorebookEntry: async (name, entry) => {
      const { new_entries } = await world.createWorldbookEntries(name, [fromLegacy(entry || {})])
      return new_entries[0]?.uid
    },
    deleteLorebookEntries: async (name, uids) => {
      const drop = new Set((uids || []).map(Number))
      const { worldbook, deleted_entries } = await world.deleteWorldbookEntries(name, e => drop.has(e.uid))
      return { entries: worldbook.map(legacyOf), delete_occurred: deleted_entries.length > 0 }
    },
    deleteLorebookEntry: async (name, uid) => {
      const { deleted_entries } = await world.deleteWorldbookEntries(name, e => e.uid === Number(uid))
      return deleted_entries.length > 0
    },
  }
}

// What the stand-ins do not have, of TH_FUNCTIONS: a call fails there (not defined, or "不支持"). The page's is a card
// frame's (web/compat.js), the server's the sandbox of scripts that follow the variables (server/card-scripts.mjs).
// test/th-api.test.mjs runs both and checks these against what they define.
const words = text => Object.freeze(text.trim().split(/\s+/))
export const MISSING = Object.freeze({
  page: words(`
    getChatHistoryBrief getChatHistoryDetail createCharacter createOrReplaceCharacter replaceCharacter updateCharacterWith deleteCharacter
    rotateChatMessages formatAsDisplayedMessage retrieveDisplayedMessage refreshOneMessage
    isAdmin getExtensionType getExtensionInstallationInfo installExtension uninstallExtension reinstallExtension updateExtension
    importRawCharacter importRawChat importRawPreset importRawWorldbook importRawTavernRegex
    getLorebookSettings setLorebookSettings setCurrentCharLorebooks deleteLorebook setChatLorebook getOrCreateChatLorebook
    createPersona createOrReplacePersona replacePersona updatePersonaWith deletePersona
    getPresetNames getLoadedPresetName loadPreset getPreset createPreset createOrReplacePreset replacePreset updatePresetWith setPreset deletePreset renamePreset
    getTavernHelperVersion getFrontendVersion getTavernVersion updateTavernHelper updateFrontendVersion
    rebindGlobalWorldbooks rebindCharWorldbooks rebindChatWorldbook getOrCreateChatWorldbook deleteWorldbook`),
  server: words(`
    getChatHistoryBrief getChatHistoryDetail createCharacter createOrReplaceCharacter replaceCharacter updateCharacterWith deleteCharacter retrieveDisplayedMessage
    isAdmin getExtensionType getExtensionInstallationInfo installExtension uninstallExtension reinstallExtension updateExtension
    importRawCharacter importRawChat importRawPreset importRawWorldbook importRawTavernRegex
    getLorebookSettings setLorebookSettings setCurrentCharLorebooks deleteLorebook setChatLorebook getOrCreateChatLorebook
    createPersona createOrReplacePersona replacePersona updatePersonaWith deletePersona
    getPresetNames getLoadedPresetName loadPreset getPreset createPreset createOrReplacePreset replacePreset updatePresetWith setPreset deletePreset renamePreset
    getAllEnabledScriptButtons getScriptTrees getFrontendVersion getTavernVersion updateTavernHelper updateFrontendVersion
    rebindGlobalWorldbooks rebindCharWorldbooks rebindChatWorldbook getOrCreateChatWorldbook deleteWorldbook`),
})

/** The Tavern Helper functions `code` calls that do not work `where` ('page' or 'server'), each once. */
export function missingCalls(code, where) {
  const missing = MISSING[where] ?? []
  return calledFunctions(code).filter(name => missing.includes(name))
}
