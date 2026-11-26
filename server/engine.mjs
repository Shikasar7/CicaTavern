// One RP turn through a model provider's API (model `<provider>/<model>`, see
// providers.mjs). The history is rebuilt from the chat tree on every turn
// (apiMessages), byte-identical to what was sent before, so the provider's
// prefix cache hits.
// Other model references go to an optional backend passed in as `subscription`
// (this machine's own install: server/subscription/); without one they are refused.
import { readFile } from 'node:fs/promises'
import { activePath, booksForCard, chatPicks, childrenOf, compactBlock, editMessage as editChatMessage, forgetDeleted, pathTo, playerOf, presetFor, scriptsOf, selectNode } from './chats.mjs'
import { hasPrefixRules, renderPresetTailParts } from './presets.mjs'
import { asksChoices, asksNoNotes, asksSelfCheck, choicesInstruction, choicesRequest, extractChoices, lengthRule, replyScripts, withChoices } from './basic.mjs'
import { DIRECT_CARD, VN_ID, BASIC_ID, FOLD_TAG, builtinOptions, choicesOf, isBuiltinPreset } from '../web/shared/basic.js'
import { cleanReferences, referenceBlock } from './forge/references.mjs'
import { appHelp, helpSystem, lookupLabel, lookupLine, lookupMark, lookupOf, MAX_LOOKUPS, retrieve, runLookup } from './help.mjs'
import { ASK_TOKENS, callGate, callId, callKey, callMarks, keptStep, MAX_STEPS, nativeCall, nativeResult, resultBlock, SAME_CALL, toolCall, withSteps } from './tools/calls.mjs'
import { GUIDE_BLOCK, guideBlock } from './guide-text.mjs'
import { WEAR_BLOCK, wearBlock } from './wear.mjs'
import { applyMark, applySet, PLOT_BLOCK, plotBlock, progressOn, sceneOf, takePlotMark } from '../web/shared/plot.js'
import { noteEnding } from './plot-endings.mjs'
import { judgeRequest, readJudge } from './plot.mjs'
import { chatMaterial } from './roster.mjs'
import { buildTurnPrompt, chatTemplates, drawnEntries, everyTurnReminder, openingBlock, placeDeep, renderEntry, replaceMacros, takeDeep, templateText, webSearchNote } from './prompt.mjs'
import { applyStateUpdates, applyWrites, displayText, keepReadOnly, stateWrites, withoutOpenEnd, writeLabels } from './state.mjs'
import { choiceFights, cutAtGate, withoutGameMarks } from '../web/shared/game/marks.js'
import { cgList, readCgs } from './card-cgs.mjs'
import { formsTold, growsOn, perkOf, perksOn } from '../web/shared/game/growth.js'
import { applyOps, checkExperience, checkLine, checkPractice, cleanCheck, cleanOps, fieldedOf, formWrites, gateKinds, keptSheet, opWrites, pausesOn, rankNow, rollCheck, rulesOn, sheetOf, sheetOnPath } from '../web/shared/game/sheet.js'
import { cleanFight, encounterSetup, fightLine, fightResult } from '../web/shared/game/encounter.js'
import { asksForFight, foesRequest, gamePrompt, mayAskForFight, parseFoes, parseSuggestion, parseThings, settledSheet, suggestRequest, thingsRequest } from './game.mjs'
import { variablePaths } from '../web/shared/game/bindings.js'
import { httpError, newId } from './store.mjs'
import { deepConstantEntries, depthOf, dynamicEntries, initialState, inPrefix, isConstant, isInitvar, isPreprocessing, triggeredEntries } from './worldbook.mjs'
import { depthWindow, PLACEMENT } from '../web/shared/regex.js'
import { applyScripts } from './regex-guard.mjs'
import { replaceVariableMacros } from '../web/shared/vars.js'
import { decoratorsOf, hasEjs, hasTemplate, stripTemplates, templateSession } from './template.mjs'
import { accumulatedDynamic, compactThreshold, dynamicMemory, planDynamic, stripDynamicText } from './dynamic.mjs'
import { backNote, castNames, leftNote, presentState, returnedState } from './present.mjs'
import { chatReasoning, complete, CONTEXT_FULL, isProviderRef, nativeTools, providerError, refLabel, resolveRef, streams, unreadReply, webSearchKind } from './providers.mjs'
import { canonicalModel } from './models.mjs'
import { completeWhole, goesRound, joinContinued, joinedStream } from './whole.mjs'
import { directSummaryInstruction, extractSummary, keptArchive, looksLikeArchive, MIN_TURNS, recapBlock, recentExchanges, storyPath, storyTurns, summaryInstruction, turnsSinceCompaction, withoutHidden } from './recap.mjs'
import { contextUsed, limitFromError, thresholdFor, toolNote, windowOf, withToolNote } from './context.mjs'

/** An instruction asked inside the story with the player's 附加提示词 after it ({{user}} / {{char}} named). */
const withNote = (text, note, names) => (note ? `${text}\n\n${replaceMacros(note, names)}` : text)
import { msg } from './i18n.mjs'
import { FILTERED, PROHIBITED, RECITATION, surelyAtGate, upstreamCut } from './reply-end.mjs'
import { extractUpdate, fillInstruction, fillRequest, fixInstruction, fixRequest, hasUpdateBlock, updateBlocks, usesMvu, withoutUpdateBlocks } from './mvu.mjs'
import { issueLines, stateDiff, turnVarIssues } from './turn-vars.mjs'
import { rawOfPicture } from './cards.mjs'
import { keepToSchema, schemaScript } from './schema.mjs'
import { rawRequest } from './frames.mjs'
import { blockRequest, blockSent } from './blockwords.mjs'
import { blockText } from '../web/shared/blockwords.js'
import { memoryOf, memoryOnlyInstruction, memoryRequest, memoryText, mergeEntries, parseEntries, placeEntries, recallEntries, recalledSince, snapshotOf, TIDY_FIRST_MAX, tidyInContext, tidyRequest, turnTexts } from './memory.mjs'
import { span } from './perf.mjs'
import { cardScriptsFor } from './card-scripts.mjs'
import { afterTurn, turnInjections } from './injections.mjs'

// The preset's per-turn block in a turn's message (buildTurnPrompt).
const PRESET_BLOCK = /\n*<预设指令>\n[\s\S]*?\n<\/预设指令>/
// Lore sent 紧挨着回复 (prompt.mjs NEAR_TAG): only on the newest message, as the preset's 同酒馆.
const NEAR_LORE = /\n*<世界书·紧挨回复>\n[\s\S]*?\n<\/世界书·紧挨回复>/

// Output tokens a story turn may ask for at most (presets often say 65535): enough for any
// reply with its thinking and status blocks, and within what current Claude models accept.
const MAX_REPLY_TOKENS = 32000

/** What to tell the player when the model's content check kept the reply back, or null when it was not that. */
function filteredReply(name, reason) {
  if (PROHIBITED.test(reason)) return msg`${name} 的内容审查拦下了这次请求（${reason}）。这是 Gemini 服务端的审查，设置里关不掉，换 API Key 或中转也一样。可以换用别的模型；或者回滚最近几轮、改掉角色卡和预设里可能触发它的内容再试（最常见的是露骨内容里出现了年龄小或看起来年幼的角色）。`
  if (RECITATION.test(reason)) return msg`${name} 认为回复和已有的受版权保护的文字太像，没有给出（${reason}）。重试一次，或者换个说法。`
  if (FILTERED.test(reason)) return msg`${name} 的安全过滤拦下了这次回复（${reason}）。可以重试、改写最近的输入，或者换用别的模型。`
  return null
}
/** A preset's max response length, as the turn's message says it; 0 for none, or one so long that no reply comes near it. */
const softLength = preset => {
  const tokens = Math.floor(Number(preset?.params?.maxTokens) || 0)
  return tokens > 0 && tokens < MAX_REPLY_TOKENS ? tokens : 0
}
// Upstream sends nothing for this long: the page is told so, and again this often. A gap this long is kept with the reply.
const QUIET_MS = 5000
const QUIET_EVERY_MS = 2000
const GAP_KEPT_MS = 3000
// 补写变量: a big card's update block (many fields, its analysis) fits in this.
// A thinking model spends thousands of tokens before the block starts.
const FILL_MAX_TOKENS = 16000
// 重写选项: four lines, with room for a thinking model's reasoning.
const CHOICES_MAX_TOKENS = 2000
// An imported chat's history is summarised in parts of about this many characters (well inside 200k tokens).
const IMPORTED_PART_CHARS = 120000
// A story too long for its model even in halves is read again under this much of the chat's system prompt.
const LEAN_SYSTEM_CHARS = 6000

/**
 * How long upstream has sent nothing while a turn waits for it: the page is told ({ type: 'quiet', seconds, begun }; 0 once
 * something came), and the longest time of it after the reply began is kept (longest()).
 */
function quietWatch(emit) {
  let last = 0
  let begun = false
  let told = 0
  let longest = 0
  let timer = null
  const settle = () => {
    if (begun) longest = Math.max(longest, Date.now() - last)
    if (told) emit({ type: 'quiet', seconds: 0 })
    told = 0
  }
  return {
    start() {
      last = Date.now()
      timer ??= setInterval(() => {
        const now = Date.now()
        if (now - last < QUIET_MS || now - told < QUIET_EVERY_MS) return
        told = now
        emit({ type: 'quiet', seconds: Math.round((now - last) / 1000), begun })
      }, 500)
    },
    came() {
      settle()
      last = Date.now()
      begun = true
    },
    /** Asked again after a wait of this app's own. */
    waits(ms) {
      settle()
      last = Date.now() + ms
    },
    stop() {
      if (timer === null) return
      clearInterval(timer)
      timer = null
      settle()
    },
    longest: () => longest,
  }
}

/** Why a compaction is not done here, in words (chats.mjs compactBlock). */
function compactRefusal(block, turns) {
  if (block === 'folded') return msg`回滚之后这里只剩 ${turns} 轮，不到 ${MIN_TURNS} 轮：先点对话底部的「恢复」放回后面的回合，再压缩`
  if (block === 'recent') return msg`上次压缩之后不到 ${MIN_TURNS} 轮，不用再压缩`
  return msg`这段对话还不到 ${MIN_TURNS} 轮，不用压缩`
}
// Display-time rendering (renderForDisplay): at most this many texts, this long each and all
// together, and this long for one request; what is left after the time is returned without its EJS.
const DISPLAY_TEXTS = 64
const DISPLAY_TEXT_CHARS = 256 * 1024
const DISPLAY_TOTAL_CHARS = 1024 * 1024
const DISPLAY_TIME_MS = 3000
// Rounds of entries activated by entries activated in the round before (activewi).
const ACTIVATION_ROUNDS = 3

/** A failure without a status in words that say what to do (the backend words its own). */
function friendlyError(message, subscription) {
  const text = String(message ?? '')
  const said = subscription?.friendlyError(text) ?? text
  if (said !== text) return said
  if (/overloaded|529/i.test(text)) return msg`模型繁忙，稍后重试。（${text.slice(0, 160)}）`
  return text
}

// The 联网 note as a new turn's message ends with it (webSearchNote).
const SEARCH_NOTE = () => `\n\n${webSearchNote()}`

// 继续生成: after the reply as far as it went, what the model is asked (SillyTavern's /continue nudge, said for a story).
export { joinContinued }
const CONTINUE_NUDGE = '（上一条回复写到这里断了。从断开的地方直接接着写：第一个字紧接着上面最后一个字，不要重复已经写过的内容，不要加任何说明。写到一半的标签或块接着写完，这条回复本来该有、还没写到的部分（比如变量更新、行动选项）照常写上。）'

// How often a reply cut at the output limit is written on by itself (自动续写), and the length past which it is left as it
// is: a reply that long is one that does not stop.
const AUTO_ROUNDS = 2
const AUTO_MOST = 30000

/** What a session from compaction point `node` opens with: its summary and the last turns of `story`, as the prompt sends them. */
// How long an archive is at the least, or it was cut off. A summary of a short question and answer can be short.
const archiveMinimum = chat => (chat.cardId === DIRECT_CARD ? 30 : 200)

/** Messages taking turns again, starting with the player's and ending with a reply: a stand-in where one was deleted. */
function closeGaps(messages) {
  const standIn = role => ({ role, content: '（这条消息已删除）' })
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === messages[i - 1].role) messages.splice(i, 0, standIn(messages[i].role === 'user' ? 'assistant' : 'user'))
  }
  if (messages[0]?.role === 'assistant') messages.unshift(standIn('user'))
  if (messages.at(-1)?.role === 'user') messages.push(standIn('assistant'))
}

/**
 * The preset's 用户 / AI 助手 entries before the history (chats.mjs presetLead), as messages ahead of it, the way
 * SillyTavern sends them. A first one from AI 助手 gets a short user line before it (a conversation starts with the
 * player's side); a last one from 用户 goes at the front of the history's first message, so the sides keep taking
 * turns. They read the same every turn: the cache reads past them.
 */
export function withLead(chat, messages) {
  const lead = (chat.presetLead ?? []).filter(m => String(m.content ?? '').trim()).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  if (!lead.length) return messages
  if (lead[0].role === 'assistant') lead.unshift({ role: 'user', content: '开始。' })
  const first = messages[0]
  if (lead.at(-1).role === 'user' && first?.role === 'user' && typeof first.content === 'string') {
    return [...lead.slice(0, -1), { ...first, content: `${lead.at(-1).content}\n\n${first.content}` }, ...messages.slice(1)]
  }
  return [...lead, ...messages]
}

// Providers and models that turned a system message after the turn's away (400): the entries go in a user message.
const refusesSystemTail = new Set()
// Providers and models that turned a 预填 away (400: the newer Claude models, DeepSeek's reasoner): it goes as text after
// the turn's message, as before.
const refusesPrefill = new Set()
// By what such a refusal says, not any 400 that names a role: that one would be asked twice and the 预填 lost for the run.
// Gemini's own API (2026-11-16): "Requests ending with a model turn are not supported."
const PREFILL_REFUSED = /pre-?fill|must end with (a |an )?user|(last|final) (message|turn|role)[^.\n]{0,80}\b(user|assistant)\b|\bassistant\b[^.\n]{0,80}\b(last|final|continu\w*)\b|conversation must end|ending with (a |an )?(model|assistant) (turn|message)/i
// A 预填 that ends inside a thinking tag it opened (「…<think>」): the reply starts in it, so it is kept with that tag in
// front, and folds as the model's thinking; a preset's regex for `…</think>` finds it as it would in SillyTavern.
const OPEN_FOLD_END = new RegExp(`<(${FOLD_TAG})>(?![\\s\\S]*</\\1>)[^<]*$`, 'i')
const foldLead = prefill => {
  const open = OPEN_FOLD_END.exec(prefill)
  return open ? `<${open[1]}>\n` : ''
}
// The Claude models that take a system message after the conversation's start (Anthropic's mid-conversation
// system messages; not Claude Sonnet 5 or older); only Anthropic's own API is known to pass one on as it is.
const SYSTEM_TAIL_MODELS = /^claude-(opus-5(?![\d.])|opus-5-5|opus-4-8|fable-|mythos-|sonnet-5-5|haiku-5-5)/i

/** Whether this turn sends its preset's 系统 after-history entries as a system message of their own. */
/**
 * 应用帮助: a reply's tokens over all the calls it took (its lookups, then the answer). `prompt` (what the context
 * held) is the first call's: the lookups are not kept, so the next turn's context is that one's and the answer.
 */
function addUsage(sum, tokens) {
  if (!tokens) return sum
  if (!sum) return { ...tokens, prompt: tokens.prompt ?? (Number(tokens.input) || 0) + (Number(tokens.cacheRead) || 0) + (Number(tokens.cacheWrite) || 0) }
  const out = { ...sum }
  for (const [key, value] of Object.entries(tokens)) {
    if (key !== 'prompt' && typeof value === 'number') out[key] = (Number(out[key]) || 0) + value
  }
  out.costUsd = null
  return out
}

function sendsSystemTail(target, prepared) {
  return Boolean(prepared.presetTail?.system.trim()) && target.provider?.api === 'anthropic-messages' && /(^|\.)api\.anthropic\.com$/i.test(hostOf(target.provider.baseURL))
    && SYSTEM_TAIL_MODELS.test(target.modelId) && !refusesSystemTail.has(`${target.provider.id}/${target.modelId}`)
}
const hostOf = url => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * The turn's message for a provider API. 同酒馆 (prepared.presetTail) on Claude's own Messages API: the message
 * without its <预设指令>, as the history keeps it, then the after-history entries as messages of their own: the 用户 and
 * AI 助手 ones in a user message (the API joins it to the turn's), the 系统 ones as a system message where the model takes
 * one (`system`), else with the others. They are marked `tail`: the cache mark stays on the turn's message, so the next
 * turn, which no longer has them, reads the cache up to there. Elsewhere, the message as it is, the entries in it.
 */
export function turnMessages(target, prepared, system = true) {
  const tail = target.provider?.api === 'anthropic-messages' ? prepared.presetTail : null
  if (!tail) return [{ role: 'user', content: prepared.prompt }]
  const asSystem = system && sendsSystemTail(target, prepared)
  const inline = [asSystem ? '' : tail.system, tail.user].filter(text => text.trim()).join('\n\n')
  return [
    { role: 'user', content: prepared.prompt.replace(PRESET_BLOCK, '') },
    ...(inline ? [{ role: 'user', content: `<预设指令>\n${inline}\n</预设指令>`, tail: true }] : []),
    ...(asSystem ? [{ role: 'system', content: tail.system, tail: true }] : []),
  ]
}

function compactionRecap(node, story, names, scripts, chat) {
  const macros = text => replaceMacros(text, names)
  return recapBlock(
    node.compaction.summary,
    recentExchanges(story, names, ({ role, text, depth, node: message }) =>
      applyScripts(text, replyScripts(scripts, chat, message), { placement: role === 'user' ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT, target: 'prompt', depth: depth + 1, macros }),
    ),
    { direct: chat.cardId === DIRECT_CARD },
  )
}

/**
 * @param isolation - { proxy } for provider requests (a getter: the setting can change).
 * @param ledger - usage ledger (see usage.mjs); optional in tests.
 * @param subscription - the optional backend for models without a provider (server/subscription/).
 */
// Whether a chat tells its story with a preset of this app's own ('' is the default one).
const ownPreset = chat => !chat.presetId || isBuiltinPreset(chat.presetId)

// 应用帮助 (直连对话): on unless the chat turned it off.
const helpOn = chat => chat.cardId === DIRECT_CARD && chat.appHelp !== false

/**
 * @param app - { version, platform } of this install, for 应用帮助 (help.mjs helpSystem).
 * @param tools - createTools() (tools/index.mjs): what a 直连对话 may use of files; null in tests without.
 */
export function createEngine(store, isolation, ledger = null, { subscription = null, rulebooks = null, app = { version: '', platform: '' }, tools = null } = {}) {
  const running = new Map()
  // The card's own scripts that follow its variables (card-scripts.mjs): around each reply's update. Those the player
  // has let call the model (Tavern Helper generate) get it here.
  const cardScripts = cardScriptsFor(store)
  cardScripts.useModel((chat, request, signal) => generateFor(chat, { ...request, borrow: false }, signal))
  // Cards whose schema was looked for in their picture again this run (cardWithSchema).
  const schemaReread = new Set()

  function scanWindow(path, depth, input) {
    const recent = path.slice(-Math.max(1, depth)).map(node => (node.role === 'user' ? node.text : node.display ?? node.text))
    return [...recent, input].join('\n')
  }

  /** Entries injected in the last `turns` user turns (0: none held back) since the last compaction: the session after it never saw the ones before. */
  function recentRefs(path, turns) {
    const refs = new Set()
    const count = Math.max(0, Math.trunc(Number(turns)) || 0)
    if (!count) return refs
    const start = path.findLastIndex(node => node.compaction) + 1
    const users = path.slice(start).filter(node => node.role === 'user').slice(-count)
    for (const node of users) for (const ref of node.injected ?? []) refs.add(ref)
    return refs
  }

  /**
   * 长期记忆（Beta）: the 记忆簿 entries this turn brings back (memory.mjs recallEntries). Only what the
   * latest compaction on `path` folded away, and once until the next one: the message carrying an
   * entry stays in the context.
   */
  function recallFor(path, input, settings, newSession) {
    const compacted = path.findLast(node => node.compaction)
    const snapshot = compacted ? memoryOf(path) : null
    if (!snapshot) return []
    const seen = withoutHidden(storyPath(path))
    return recallEntries(snapshot, {
      compactedTurns: Number(compacted.compaction.turns) || 0,
      recalled: newSession ? new Set() : recalledSince(path),
      scanText: scanWindow(seen, settings.scanDepth, input),
      focusText: `${input}\n${seen.at(-1)?.text ?? ''}`,
      budget: settings.memory.budget,
    })
  }

  /**
   * @param marks - ask for the 视觉小说格式 this turn (the page's visual novel mode has it on).
   * The turn's templates share one sandbox, let go of when the prompt is built.
   */
  /**
   * 直连对话's message: the words as typed and the files that came with them; after a compaction, what it kept first.
   * 应用帮助 on (the default): the help sections a message plainly about the app finds go with it (help.mjs retrieve).
   */
  async function directPrompt(chat, parent, input, files) {
    const path = pathTo(chat, parent.id)
    const start = Math.max(0, path.findLastIndex(node => node.compaction))
    const newSession = Boolean(path[start].compaction) && !withoutHidden(path.slice(start + 1)).some(node => node.role === 'user')
    const recap = newSession ? compactionRecap(path[start], storyPath(path.slice(0, start + 1)), chat.names, [], chat) : ''
    // Sections a message since the last compaction carried are still in what the model reads.
    const given = new Set(path.slice(start + 1).flatMap(node => node.helpIds ?? []))
    const found = helpOn(chat) ? retrieve(await appHelp(), input, given) : { ids: [], text: '' }
    return {
      settings: await store.getSettings(),
      prompt: [recap, referenceBlock(files), found.text, input].filter(Boolean).join('\n\n'),
      input,
      injected: [],
      injectedTitles: [],
      templateErrors: [],
      shouldCompact: false,
      ...(found.ids.length ? { helpIds: found.ids } : {}),
    }
  }

  /**
   * The built-in preset's 正文字数 for this chat's turn, over 语言与字数's 字数; '' when the chat has another preset or
   * no range is set. Kept within the output cap of the provider the chat's model is on.
   */
  async function replyRange(chat, settings) {
    if (!ownPreset(chat)) return ''
    const options = builtinOptions(settings, chat.presetId === VN_ID ? VN_ID : BASIC_ID)
    if (!options.lengthMin && !options.lengthMax) return ''
    const ref = modelFor(chat, settings)
    let maxTokens = 0
    if (isProviderRef(ref)) {
      try {
        maxTokens = Number(resolveRef(ref, await store.getProviders()).provider.maxTokens) || 0
      } catch {
        // A provider gone: the turn fails on it later, with its own message.
      }
    }
    return lengthRule(options, maxTokens)
  }

  async function preparePrompt(chat, parent, input, options = {}) {
    if (chat.cardId === DIRECT_CARD) return directPrompt(chat, parent, input, options.files)
    const templates = { session: null }
    try {
      return await buildPrompt(chat, parent, input, options, templates)
    } finally {
      templates.session?.dispose()
    }
  }

  async function buildPrompt(chat, parent, input, { forceFull = false, marks = false, rules = null, startWrites = [] }, templates) {
    const [settings, card, preset, globalScripts, regexSets] = await Promise.all([store.getSettings(), store.getCard(chat.cardId), presetFor(store, chat.presetId), store.getRegex(), store.getRegexSets()])
    const { persona } = await chatPicks(store, chat, card)
    const books = await booksForCard(store, card, settings, chat)
    const scripts = scriptsOf(card, preset, globalScripts, regexSets, chat.regexChanges)
    const names = chat.names
    const macros = text => replaceMacros(text, names)
    const path = pathTo(chat, parent.id)
    // What the model reads: the path without its hidden rounds (隐藏这一轮).
    const seen = withoutHidden(path)
    // Where that context starts: the opening, or the latest compaction point. This turn opens
    // it when it is the first after it, or every turn since was hidden.
    const start = Math.max(0, path.findLastIndex(node => node.compaction))
    const opens = !withoutHidden(path.slice(start + 1)).some(node => node.role === 'user')
    const game = rules ? gamePrompt(rules, withoutHidden(path.slice(start + 1))) : null
    // Continuing from a compaction point opens a new session that has seen only
    // the frozen prefix: everything the history used to carry is sent again.
    const newSession = Boolean(path[start].compaction) && opens
    if (newSession) forceFull = true
    // What the rules settle this turn is already so: the card's own lists show it. So is what the card's scripts set as it began.
    const state = applyWrites(parent.state ?? {}, [...startWrites, ...(rules?.writes ?? [])])
    const templateErrors = []
    const story = storyPath(path)
    // The turn's sandbox, opened by the first template: getwi reads these books;
    // getChatMessages and matchChatMessages the story so far and this input.
    const session = () =>
      (templates.session ??= chatTemplates({
        names, card, preset, books, scripts, state,
        local: chat.frameVars ?? {},
        global: settings.globalVars ?? {},
        messages: [...story.map(node => ({ role: node.role, text: node.text ?? '' })), { role: 'user', text: input }],
      }))
    // The player's own templates run once, before anything reads the input
    // (ST-Prompt-Template's raw message evaluation); the result is the message kept.
    let said = input
    if (hasEjs(input)) {
      said = templateText(session(), input, templateErrors, msg`输入`)
      session().setMessage(story.length, said)
    }

    // Entries rendered before keyword matching (@@preprocessing): their content and keywords.
    const turnBooks = books.map(book =>
      book.entries.some(isPreprocessing) ? { ...book, entries: book.entries.map(entry => (isPreprocessing(entry) ? preprocess(entry, book) : entry)) } : book,
    )
    function preprocess(entry, book) {
      const keyed = [...entry.keys, ...entry.secondaryKeys].some(hasEjs)
      // A constant entry without a template is in the frozen prefix already.
      if (!hasTemplate(entry.content) && (!keyed || isConstant(entry))) return entry
      const key = text => (hasEjs(text) ? templateText(session(), text, templateErrors, entry.comment || entry.uid) : text)
      const { text, error } = renderEntry(entry, { state, names, session: session(), world: book.name })
      if (error) templateErrors.push(`${entry.comment || entry.uid}: ${error}`)
      // A key whose template came out empty matches nothing (as in SillyTavern), not every text.
      const keys = list => list.map(key).map(k => String(k ?? '').trim()).filter(Boolean)
      return { ...entry, content: text, keys: keys(entry.keys), secondaryKeys: keys(entry.secondaryKeys), preprocessed: true }
    }
    const bookOf = new Map(turnBooks.flatMap(book => book.entries.map(entry => [entry, book])))
    const refOf = (entry, book = bookOf.get(entry)) => `${book?.id}:${entry.uid}`
    const render = (entry, book = bookOf.get(entry)) => {
      const { text, error } = renderEntry(entry, { state, names, session: session(), world: book?.name ?? '', scripts })
      if (error) templateErrors.push(`${entry.comment || entry.uid}: ${error}`)
      return { title: entry.comment, text }
    }

    // What the card's scripts injected for this chat (injections.mjs): sent with the turn, and scanned when they say so.
    const injections = turnInjections(chat)
    // A book may look further back or less far than the setting (世界书 → 扫描深度).
    const windows = new Map()
    const scanFor = book => {
      const depth = book.scanDepth || settings.scanDepth
      if (!windows.has(depth)) windows.set(depth, scanWindow(withoutHidden(story), depth, injections.scan ? `${said}\n${injections.scan}` : said))
      return windows.get(depth)
    }
    const hits = triggeredEntries(turnBooks, scanFor, newSession ? new Set() : recentRefs(seen, settings.reinjectAfter), { recursion: settings.worldRecursion })
    const dynamic = dynamicEntries(turnBooks)
    // A card that feeds its own variables through a dynamic entry
    // ({{format_message_variable::stat_data}}) does not need our state block too.
    const cardShowsState = dynamic.some(entry => /stat_data/.test(entry.content))
    const userTurns = path.filter(node => node.role === 'user').length
    const refreshState =
      !cardShowsState &&
      Object.keys(state).length > 0 &&
      (userTurns === 0 || newSession || chat.stateDirty || (settings.stateRefreshEvery > 0 && userTurns % settings.stateRefreshEvery === 0))
    // Prompt-side regex (e.g. hiding the status-bar placeholder or MVU blocks from the model).
    const opening = opens && !newSession ? applyScripts(path[0].text, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: 0, macros }) : ''
    const promptInput = applyScripts(said, scripts, { placement: PLACEMENT.USER_INPUT, target: 'prompt', depth: 0, macros })

    // A chat whose prefix was built since there was 聊天中 @深度 (chat.loreAtDepth) sends its constant @深度 entries each
    // turn, at their depth; an older one has them in its prefix, where they stay until it is applied again.
    const atDepth = chat.loreAtDepth === true
    const renderedDynamic = [...dynamic.map(entry => render(entry)), ...drawnEntries(books, scripts, names, { atDepth })]
      .filter(item => item.text)
      .map(item => (item.title ? `【${item.title}】\n${item.text}` : item.text))
      .join('\n\n')
    // A keyword entry whose template (an @@if) printed nothing was not sent, so it is not recorded either.
    const sent = hits.map(hit => ({ ref: hit.ref, entry: hit.entry, item: render(hit.entry) })).filter(hit => hit.item.text)
    const deepConstant = atDepth ? deepConstantEntries(turnBooks).map(entry => ({ entry, item: render(entry) })).filter(hit => hit.item.text) : []
    const note = card.depthPrompt && hasEjs(card.depthPrompt) ? templateText(session(), card.depthPrompt, templateErrors, msg`角色备注`) : card.depthPrompt
    const characterNote = note
      ? replaceMacros(replaceVariableMacros(note, templates.session ? templates.session.currentState() : state, templates.session ? templates.session.currentVariables() : { local: chat.frameVars ?? {}, global: settings.globalVars ?? {} }), names).trim()
      : ''
    const presetRender = text => (hasEjs(text) ? templateText(session(), text, templateErrors, msg`预设提示词`) : text)
    const presetParts = preset
      ? renderPresetTailParts(preset, { card, persona: playerOf(card, persona, names.user), names, vars: chat.presetVars, input: promptInput, lastChar: seen.at(-1).display ?? seen.at(-1).text, render: presetRender })
      : { text: '', system: '', user: '' }
    // 预填 (the AI 助手 entries at the end, see renderPresetTailParts): sent as the reply's start where the model takes it
    // (turn time, prefillMessages), so the turn's message goes without them.
    const prefill = presetParts.prefill?.trim() ? presetParts.prefill : ''
    const presetSent = prefill ? presetParts.rest : presetParts
    const presetText = presetSent.text
    // Entries the templates asked for (activewi) join the keyword hits, rendered in the same sandbox.
    const taken = new Set([...hits.map(hit => hit.ref), ...dynamic.map(entry => refOf(entry))])
    for (let round = 0; round < ACTIVATION_ROUNDS && templates.session; round++) {
      const asked = templates.session.activations().filter(({ book, entry, force }) => {
        const ref = refOf(entry, book)
        if (taken.has(ref) || inPrefix(entry) || isInitvar(entry)) return false
        if (!force && decoratorsOf(entry.content).has('@@dont_activate')) return false
        taken.add(ref)
        return true
      })
      if (!asked.length) break
      for (const { book, entry } of asked) {
        const item = render(entry, book)
        if (item.text) sent.push({ ref: refOf(entry, book), entry, item })
      }
    }
    // getPromptsInjected placeholders, filled now that everything has rendered.
    const resolve = text => (templates.session ? templates.session.resolveInjected(text) : text)
    const writes = templates.session?.writes() ?? { message: [], local: [], global: [], state }
    if (templates.session) templateErrors.unshift(...templates.session.preloadErrors())

    const plan = planDynamic({ rendered: resolve(renderedDynamic), ...dynamicMemory(seen), forceFull })
    const recap = newSession ? compactionRecap(path[start], storyPath(path.slice(0, start + 1)), names, scripts, chat) : ''
    const recalled = settings.memory?.enabled ? recallFor(path, said, settings, newSession) : []
    // 只发在场角色的变量: a long state goes without the groups of characters not around; the turn one of them shows up,
    // their group goes on its own. What was left out and not sent since rides on the turn's node (stateLeft).
    const cast = settings.statePresent === false || cardShowsState ? null : castNames({ roster: card.media?.roster, books, player: [names.user, persona?.name] })
    const around = cast ? scanWindow(withoutHidden(story), settings.scanDepth, said) : ''
    const leftBefore = seen.findLast(node => Array.isArray(node.stateLeft))?.stateLeft ?? []
    let stateText = ''
    let stateLeft
    if (refreshState) {
      const shown = presentState(writes.state, { cast, text: around })
      stateText = `${JSON.stringify(shown.state, null, 1)}${shown.left.length ? `\n${leftNote(shown.left)}` : ''}`
      if (shown.left.length || leftBefore.length) stateLeft = shown.left
    } else if (leftBefore.length) {
      const returned = returnedState(writes.state, { cast, text: around, left: leftBefore })
      if (returned.back.length) {
        stateText = `${JSON.stringify(returned.state, null, 1)}\n${backNote()}`
        stateLeft = leftBefore.filter(name => !returned.back.includes(name))
      }
    }
    // 聊天中 @深度 (worldbook.mjs depthOf): the constant entries there and the keyword ones found, by 顺序.
    // 剧本: where the story is on the plot (the player's own change since the last reply in), and the scene it plays now.
    // An ended plot sends nothing: the story goes on free. The 剧情向导's plan rests while a plot runs.
    const playing = chat.plot?.copy && !chat.plot.paused ? chat.plot : null
    let plotSet = null
    let plotSent = null
    let plotText = ''
    if (playing) {
      let base = progressOn(playing.copy, seen, playing.start)
      if (playing.pending?.after === parent.id && playing.pending.set) {
        plotSet = { of: playing.copy.id, ...playing.pending.set }
        base = applySet(playing.copy, base, plotSet)
      }
      if (!base.ended) {
        const block = plotBlock(playing.copy, base, { tightness: playing.tightness, pace: playing.pace, state, pull: Boolean(plotSet?.pull), push: plotSet?.push ?? null, mark: playing.judge?.by !== 'helper' })
        plotText = block.text
        if (block.sent) plotSent = { of: playing.copy.id, ...block.sent }
      }
    }
    const atDepthLore = [...deepConstant, ...sent.filter(hit => depthOf(hit.entry) !== null)]
      .map(hit => ({ ...hit, depth: depthOf(hit.entry) }))
      .sort((a, b) => a.entry.order - b.entry.order)
    const prompt = buildTurnPrompt({
      names,
      opening,
      recap,
      entries: sent.filter(hit => depthOf(hit.entry) === null).map(hit => ({ ...hit.item, text: resolve(hit.item.text) })),
      nearEntries: atDepthLore.filter(hit => hit.depth === 0).map(hit => ({ ...hit.item, text: resolve(hit.item.text) })),
      deep: [
        ...atDepthLore.filter(hit => hit.depth > 0).map(hit => ({ ...hit.item, depth: hit.depth, kind: '世界书', text: resolve(hit.item.text) })),
        ...(presetSent.deep ?? presetParts.deep ?? []).map(item => ({ depth: item.depth, kind: '预设指令', text: resolve(item.text) })),
      ],
      memory: memoryText(recalled),
      dynamic: plan.text ? [{ title: '', text: plan.text }] : [],
      characterNote: resolve(characterNote),
      stateText,
      input: resolve(promptInput),
      replyLength: Number(settings.replyLength) || 0,
      replyRange: await replyRange(chat, settings),
      replyTokens: softLength(preset),
      presetText: resolve(presetText),
      plot: plotText,
      guide: playing ? '' : guideBlock(chat.guide?.active, path),
      wear: wearBlock(chat, path, card.media?.roster),
      reminder: [everyTurnReminder(chat.systemPrompt, books, { presetRules: hasPrefixRules(preset), mvu: usesMvu(card, books, preset), choices: asksChoices(chat), selfCheck: asksSelfCheck(chat), noNotes: asksNoNotes(preset, chat.systemPrompt), scripts, atDepth }), game?.reminder].filter(Boolean).join(''),
      marks,
      cgs: marks ? cgList(await readCgs(store.dirs, chat.cardId)) : [],
      game: game?.text,
      injected: { before: injections.before.map(item => ({ ...item, text: resolve(item.text) })), after: injections.after.map(item => ({ ...item, text: resolve(item.text) })) },
    })
    // The card's scripts' own macros (registerMacroLike), over the whole message.
    const withMacros = await cardScripts.applyMacros(card, prompt, { role: 'user', messageId: path.length, chat })
    // 同酒馆: the same after-history entries by role, for a provider that takes them as messages of their own after the
    // turn's message (tailMessages); the turn's message then goes without its <预设指令>, as the history keeps it.
    const tailOf = async text => (text.trim() ? cardScripts.applyMacros(card, resolve(text), { role: 'user', messageId: path.length, chat }) : '')
    const presetTail = preset?.postMode === 'latest' && presetText.trim() ? { system: await tailOf(presetSent.system), user: await tailOf(presetSent.user) } : null
    return {
      settings,
      prompt: withMacros,
      ...(presetTail ? { presetTail } : {}),
      ...(prefill ? { prefill: await cardScripts.applyMacros(card, resolve(prefill), { role: 'assistant', messageId: path.length, chat }) } : {}),
      // The input as the turn keeps it (its own templates run).
      input: resolve(said),
      injected: sent.map(hit => hit.ref),
      injectedTitles: sent.map(hit => hit.entry.comment || hit.entry.keys[0] || hit.entry.uid),
      // 长期记忆: the entries the turn's <往事> brought back.
      recalled: recalled.map(entry => entry.id),
      recalledTitles: recalled.map(entry => entry.title),
      templateErrors,
      // 剧本: the player's change this turn carried and what the turn told the model, for the reply's progress.
      ...(plotSet ? { plotSet } : {}),
      ...(plotSent ? { plotSent } : {}),
      // 只发在场角色的变量: who is still left out after this turn ([] once everyone has been sent).
      ...(stateLeft ? { stateLeft } : {}),
      // What the templates wrote: the chat state (kept on the user node), chat-wide and app-wide variables. The card's scripts'
      // changes at the turn's start go first.
      templateWrites: [...startWrites, ...writes.message],
      localWrites: writes.local,
      globalWrites: writes.global,
      // A new session holds no earlier <动态设定>, so the pile-up count restarts here.
      dynamicState: newSession ? { ...plan.state, compacted: true } : plan.state,
      shouldCompact: !forceFull && Boolean(renderedDynamic) && accumulatedDynamic(seen) >= compactThreshold(seen, settings.dynamicStrip),
    }
  }

  /**
   * A template sandbox for chat `chat` at `nodeId`: the card's books, the chat's
   * names and variables, the messages up to and including that node.
   * @param state - the chat state templates see there.
   * @param extra - more messages after the node ([{ role, text }]).
   */
  async function nodeTemplates(chat, nodeId, state, { extra = [], runType = 'generate', context = {} } = {}) {
    const [settings, card, preset, globalScripts, regexSets] = await Promise.all([store.getSettings(), store.getCard(chat.cardId), presetFor(store, chat.presetId), store.getRegex(), store.getRegexSets()])
    const books = await booksForCard(store, card, settings, chat)
    const story = storyPath(pathTo(chat, nodeId)).filter(node => !node.deleted)
    return chatTemplates({
      names: chat.names, card, preset, books, scripts: scriptsOf(card, preset, globalScripts, regexSets, chat.regexChanges), state,
      local: chat.frameVars ?? {},
      global: settings.globalVars ?? {},
      messages: [...story.map(node => ({ role: node.role, text: node.text ?? '' })), ...extra],
      runType,
      context: { ...context, message_id: story.length - 1 + extra.length },
    })
  }

  /**
   * A reply's own templates, run once with the state after its update blocks
   * (ST-Prompt-Template's raw message evaluation): the text to keep, what it
   * wrote, and its errors (the text then keeps everything but the EJS).
   */
  async function evaluateReply(chat, userNode, reply, state) {
    const session = await nodeTemplates(chat, userNode.id, state, { extra: [{ role: 'assistant', text: reply }], runType: 'render_permanent' })
    try {
      const errors = []
      const text = session.resolveInjected(templateText(session, reply, errors))
      return { text, writes: session.writes(), errors }
    } finally {
      session.dispose()
    }
  }

  /**
   * Texts rendered as templates with what chat `chatId` had at node `nodeId`:
   * its state (variables up to there), names, the card's books, the messages
   * up to there. A dry run: nothing they write is kept. One sandbox for all.
   * @returns { texts, errors? }: a text that fails comes back without its EJS,
   *   and `errors` lists [{ index, error }].
   */
  async function renderAtNode(chat, nodeId, texts, { runType = 'render' } = {}) {
    const node = chat.nodes[nodeId]
    if (!node) throw httpError(404, msg`节点不存在`)
    if (!texts.some(hasEjs)) return { texts: [...texts] }
    const state = node.role === 'assistant' ? node.state ?? {} : applyWrites(chat.nodes[node.parent]?.state ?? {}, node.templateWrites)
    const path = activePath(chat)
    const siblings = node.parent ? Object.values(chat.nodes).filter(n => n.parent === node.parent).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [node]
    const context = {
      swipe_id: Math.max(0, siblings.findIndex(n => n.id === node.id)),
      is_last: path.at(-1)?.id === node.id,
      is_user: node.role === 'user',
      is_system: false,
      name: node.role === 'user' ? chat.names.user : chat.names.char,
    }
    const session = await nodeTemplates(chat, nodeId, state, { runType, context })
    const started = Date.now()
    try {
      const errors = []
      const out = texts.map((text, index) => {
        if (!hasEjs(text)) return text
        if (Date.now() - started > DISPLAY_TIME_MS) {
          errors.push({ index, error: 'skipped: this request ran out of time' })
          return stripTemplates(text)
        }
        const rendered = session.renderText(text)
        if (rendered.error) {
          errors.push({ index, error: rendered.error })
          return stripTemplates(text)
        }
        return session.resolveInjected(rendered.text)
      })
      return errors.length ? { texts: out, errors } : { texts: out }
    } finally {
      session.dispose()
    }
  }

  /**
   * 楼层渲染: HTML a card's display regex produced for one message, its EJS
   * rendered at that message (renderAtNode). Capped in count and size.
   */
  async function renderForDisplay(chatId, { nodeId, texts } = {}) {
    if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string')) throw httpError(400, msg`texts 要是字符串列表`)
    if (texts.length > DISPLAY_TEXTS) throw httpError(400, msg`一次最多渲染 ${DISPLAY_TEXTS} 段`)
    if (texts.some(text => text.length > DISPLAY_TEXT_CHARS) || texts.reduce((sum, text) => sum + text.length, 0) > DISPLAY_TOTAL_CHARS) throw httpError(400, msg`要渲染的内容太长`)
    return renderAtNode(await store.getChat(chatId), String(nodeId ?? ''), texts)
  }

  /** A chat's own model wins over the global default. */
  function modelFor(chat, settings) {
    const ref = chat.model || settings.model
    return isProviderRef(ref) ? ref : canonicalModel(ref)
  }

  /** Where a model reference goes: an API provider, or the subscription backend. */
  async function targetFor(ref, settings) {
    if (isProviderRef(ref)) {
      const { provider, modelId } = resolveRef(ref, await store.getProviders())
      return { api: true, provider, modelId, model: ref }
    }
    if (!subscription) throw httpError(400, msg`还没有选模型：在顶栏或设置里选一个供应商的模型`)
    if (settings.subscription === 'off') throw httpError(400, msg`已关闭 Claude 订阅：在顶栏或设置里选一个供应商的模型`)
    return subscription.target(ref)
  }

  /**
   * What an API provider sees before this turn's message: every turn since the
   * root or the latest compaction, user messages exactly as sent, replies with
   * the card's prompt-side regex as SillyTavern applies it at their depth.
   * Rebuilt the same way each turn, so the prefix matches.
   * A user node marked `dynamic.compacted` stripped the piled-up <动态设定>
   * before it; `stripAll` does that for this turn.
   */
  async function apiMessages(chat, parent, options = {}) {
    return (await historyFor(chat, parent, options)).messages
  }

  /**
   * apiMessages, and with `newest` (this turn's message as written) its 聊天中 @深度 blocks put at their depth
   * (prompt.mjs placeDeep): { messages, newest } (that message as it goes now).
   */
  /** @param steps - 'keep': what each reply did with tools stays beside it (stepsOf), for withSteps to write out. */
  async function historyFor(chat, parent, { stripAll = false, newest = null, steps: how = 'text' } = {}) {
    const [card, preset, globalScripts, regexSets] = await Promise.all([store.getCard(chat.cardId).catch(() => null), presetFor(store, chat.presetId), store.getRegex(), store.getRegexSets()])
    const scripts = scriptsOf(card, preset, globalScripts, regexSets, chat.regexChanges)
    const macros = text => replaceMacros(text, chat.names)
    const path = pathTo(chat, parent.id)
    let start = 0
    path.forEach((node, index) => {
      if (node.compaction) start = index
    })
    // Hidden rounds (隐藏这一轮) are left out before anything counts depth or places a cache mark.
    const turns = withoutHidden(path.slice(start + 1))
    let stripBefore = 0
    turns.forEach((node, index) => {
      if (node.role === 'user' && node.dynamic?.compacted) stripBefore = index
    })
    if (stripAll) stripBefore = turns.length
    // Depth as SillyTavern counts it: the new message is 0, the reply before it 1, and so on.
    // A preset that wraps only the last replies (<ai_last_output>) or keeps only summaries of
    // old ones does so here too. Replies deeper than the window never change again, so the
    // newest of them carries a cache breakpoint: the next turn reads up to there.
    const window = depthWindow(scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt' })
    const messages = turns.map((node, index) => {
      if (node.role === 'user') {
        let prompt = node.prompt ?? node.text
        // A searched turn keeps its 联网 note while 联网 is on (the history stays as sent, the cache hits); with it
        // off, the note goes, so no turn reads that it may search (the first turn after switching writes the cache again).
        if (!chat.webSearch && prompt.endsWith(SEARCH_NOTE())) prompt = prompt.slice(0, -SEARCH_NOTE().length)
        // Its 聊天中 @深度 blocks went where they were for that turn only: this turn's own go in at their depth.
        prompt = takeDeep(prompt).text
        return { role: 'user', content: index < stripBefore ? stripDynamicText(prompt) : prompt }
      }
      const reply = applyScripts(node.text, replyScripts(scripts, chat, node), { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: turns.length - index, macros })
      // 直连对话: what it did with tools before this reply goes ahead of it (at the end, so nothing here counts them).
      return { role: 'assistant', content: reply.trim() || '……', ...(node.steps?.length ? { stepsOf: { steps: node.steps, undone: node.fileUndone === true } } : {}), ...(node.thought ? { thought: node.thought } : {}) }
    })
    // A branch written before its parent was compacted (turns folded behind a rollback, then restored)
    // never had the archive in its first message: it goes there now, or nothing would carry what came before.
    // So does the first turn sent when the one that carried the archive or the opening was hidden.
    const opener = messages.findIndex(message => message.role === 'user')
    if (path[start]?.compaction && opener >= 0 && !messages[opener].content.includes('<前情提要>')) {
      messages[opener].content = `${compactionRecap(path[start], storyPath(path.slice(0, start + 1)), chat.names, scripts, chat)}\n\n${messages[opener].content}`
    } else if (opener >= 0 && turns[0] !== path[start + 1] && path[start + 1]?.prompt?.includes('<开场>')) {
      const opening = applyScripts(path[start].text, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: 0, macros })
      messages[opener].content = `${openingBlock(opening, chat.names)}\n\n${messages[opener].content}`
    }
    // 删除 can leave two messages of one side together, or a reply first; some models' templates take only turns in order.
    if (path.slice(start + 1).some(node => node.deleted)) closeGaps(messages)
    // 'latest' preset mode: the post-history prompts ride only on the newest message, as in
    // SillyTavern. Older messages lose them, so the newest one changes next turn: the reply
    // before it is the last thing that stays put.
    const latestOnly = preset?.postMode === 'latest'
    if (latestOnly) {
      for (const message of messages) if (message.role === 'user') message.content = message.content.replace(PRESET_BLOCK, '')
    }
    // Lore sent 紧挨着回复, and the 剧情向导 a turn carried: the same, the message before the newest changing with it.
    let nearLore = false
    for (const message of messages) {
      if (message.role !== 'user') continue
      const kept = message.content.replace(NEAR_LORE, '').replace(GUIDE_BLOCK, '').replace(PLOT_BLOCK, '').replace(WEAR_BLOCK, '')
      if (kept === message.content) continue
      message.content = kept
      nearLore = true
    }
    // This turn's 聊天中 @深度 blocks, out of its message and in at their depth: the messages from the first one changed
    // read differently next turn (the same depth is two messages further on), so the history's cache mark goes before it.
    let newestText = newest
    let moved = Infinity
    if (newest !== null) {
      const { text, deep } = takeDeep(newest)
      const placed = placeDeep([...messages, { role: 'user', content: text }], deep)
      messages.splice(0, messages.length, ...placed.messages.slice(0, -1))
      newestText = placed.messages.at(-1).content
      moved = placed.moved
    }
    const settled = Math.min(window >= 0 ? turns.length - window - 1 : Infinity, latestOnly || nearLore ? messages.length - 1 : Infinity, moved - 1)
    // Only this one mark in the history (with the newest message's, two at most). Two Claude relays
    // (2026-10-08) billed the history about twice with more marks than that; with this one besides the
    // newest, two Claude relays (2026-10-29, three turns of 15k characters) bill exactly
    // what they do without it, so it stays: without it a depth window rewrites the history's cache every turn.
    if (Number.isFinite(settled) && settled >= 0) messages[settled].cache = true
    const whole = withLead(chat, messages)
    return { messages: how === 'keep' ? whole : withSteps(whole), newest: newestText }
  }

  /**
   * The archive of `history`, in parts when it does not fit the model's context:
   * the older half is archived first and the newer half then on top of it
   * (halving again as often as needed). A history longer than `maxChars` is cut
   * before it is sent (an imported one has no cache to read from, and a refused
   * request would only be sent again in halves).
   * @param carry - an archive of what came before `history`, or ''
   * @param options.system - the system prompt to send (the chat's own unless it is itself too much)
   * @param options.onPart - called as each request goes out, for the page's progress
   */
  async function summarizeInParts(target, chat, history, signal, carry = '', depth = 0, options = {}) {
    const { maxChars = Infinity, system = chat.systemPrompt, onPart = () => {}, extra = '', note = '' } = options
    const instruction = { role: 'user', content: chat.cardId === DIRECT_CARD ? directSummaryInstruction(note) : summaryInstruction(chat.names, extra, note) }
    const lead = carry
      ? [
          { role: 'user', content: `<前情提要>\n下面是这段故事更早部分的剧情存档，之后是接着发生的原文。写存档时把这份前情一并写进去。\n<剧情存档>\n${carry}\n</剧情存档>\n</前情提要>` },
          { role: 'assistant', content: '（已读前情。）' },
        ]
      : []
    const size = history.reduce((sum, message) => sum + String(message.content ?? '').length, 0)
    const tooLong = size > maxChars && history.length >= 4 && depth < 8
    if (!tooLong) {
      try {
        onPart()
        return await generateApi(target, { system, messages: [...lead, ...history, instruction] }, signal, () => {})
      } catch (error) {
        if (!error.contextFull || history.length < 4 || depth >= 8) throw error
      }
    }
    // Cut at a user message near the middle: each part reads as a conversation of its own.
    let cut = Math.floor(history.length / 2)
    while (cut < history.length && history[cut].role !== 'user') cut++
    if (cut >= history.length) cut = history.length - 2
    const plain = history.map(({ role, content }) => ({ role, content }))
    const older = await summarizeInParts(target, chat, plain.slice(0, cut), signal, carry, depth + 1, options)
    const archive = extractSummary(older.reply)
    if (archive.length < archiveMinimum(chat) || !looksLikeArchive(older.reply)) throw httpError(502, msg`前半段的剧情存档没有写完整，这次没有压缩，可以再试一次`)
    const newer = await summarizeInParts(target, chat, plain.slice(cut), signal, archive, depth + 1, options)
    const tokens = Object.fromEntries(Object.entries(newer.tokens).map(([key, value]) => [key, typeof value === 'number' ? value + (older.tokens[key] ?? 0) : value]))
    // Every part's reply, oldest first: each may carry the 记忆条目 of its part.
    return { ...newer, tokens, replies: [...(older.replies ?? [older.reply]), ...(newer.replies ?? [newer.reply])] }
  }

  /**
   * One API completion with the 思考 / 努力程度 settings; provider failures become readable 502s.
   * Every request to a provider passes here, so the 屏蔽词 are applied here, last.
   */
  async function generateApi(target, request, signal, onText) {
    const [{ thinking, effort, showReasoning }, words] = await Promise.all([store.getSettings(), store.getBlockWords()])
    // A story turn carries its chat's own 思考 (顶栏), over the provider's and the settings'.
    // `whole`: a made answer (a plot) is asked on till it is whole when it runs into the output limit.
    const { chatThinking, whole, ...asked } = request
    const { provider, reasoning: asks } = chatReasoning(target.provider, { thinking, effort }, chatThinking)
    // 显示思考过程: a story turn's native thinking (request.onReasoning) goes to the page and stays with the reply.
    const onReasoning = showReasoning ? request.onReasoning : undefined
    let result
    // Text came: whatever went wrong came after the address and the key had worked.
    let begun = false
    const onDelta = onText && (delta => {
      begun = true
      onText(delta)
    })
    try {
      result = await (whole ? completeWhole : complete)(provider, target.modelId, { ...blockRequest(asked, words), reasoning: asks, signal, onDelta, onReasoning }, { proxy: isolation.proxy })
    } catch (error) {
      if (signal.aborted || error.status || error.toolsRefused) throw error
      // Too long for the model (413 is a request too big for the provider at all): marked for the page
      // (压缩后重试) and for compaction (in parts); the limit the provider names is kept for 自动压缩.
      const contextFull = error.providerStatus === 413 || CONTEXT_FULL.test(String(error.message ?? ''))
      const limit = contextFull ? limitFromError(error.message) : 0
      if (limit) await store.learnModelContext({ [`${target.provider.id}/${target.modelId}`]: limit }).catch(() => {})
      const text = String(error.message ?? '')
      const blocked = PROHIBITED.test(text) ? filteredReply(target.provider.name, text.match(PROHIBITED)[0]) : null
      // detail: the provider's answer whole, for the error log (the message quotes only its start).
      // The provider's own status kept beside ours: a 400 is what a refused 预填 or system message comes back as.
      throw Object.assign(httpError(502, blocked ?? providerError(target.provider, error, { begun })), { detail: error.body || text, ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}) }, contextFull ? { contextFull: true } : {}, error.gaveUp ? { gaveUp: true } : {})
    }
    if (!result.text.trim() && !result.calls?.length) {
      const reason = String(result.stopReason ?? '')
      const said = filteredReply(target.provider.name, reason) ?? unreadReply(target.provider, result) ?? (result.truncated ? msg`${target.provider.name} 的模型光是思考就用完了输出上限${result.cap ? msg`（${result.cap} token）` : ''}，还没写到正文。在「模型供应商」这个供应商的「高级」里把「最大输出 token」填大（比如 32000），或者把思考调低、关掉` : null) ?? msg`${target.provider.name} 没有返回正文${reason ? msg`（${reason}）` : ''}`
      throw Object.assign(httpError(502, said), { detail: JSON.stringify({ stopReason: result.stopReason ?? null, model: result.model ?? target.modelId, usage: result.usage ?? null }) })
    }
    const u = result.usage ?? {}
    // prompt / thinking: what the context held (the last call's input) and the thinking in output (context.mjs contextUsed).
    const tokens = { input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheWrite1h: 0, cacheWrite5m: u.cacheWrite ?? 0, output: u.output ?? 0, ...(u.prompt != null ? { prompt: u.prompt } : {}), ...(u.thinking ? { thinking: u.thinking } : {}), costUsd: null }
    // Cut off: at the output limit, or (联网 on Anthropic) still paused mid-search after being carried on a few times.
    const cut = result.truncated ? true : result.stopReason === 'pause_turn' ? 'paused' : null
    const api = { provider: target.provider.id, model: result.model ?? target.modelId, ...(cut ? { truncated: cut } : {}), ...(cut === true && result.cap ? { cap: result.cap } : {}) }
    const reasoning = onReasoning ? String(result.reasoning ?? '').trim() : ''
    return { reply: result.text, model: target.model, tokens, sdk: null, api, end: { stop: result.stopReason ?? null, ended: result.ended !== false }, search: result.search ?? null, ...(reasoning ? { reasoning } : {}), ...(result.calls ? { calls: result.calls } : {}), ...(result.thought ? { thought: result.thought } : {}), ...(request.tools && Array.isArray(result.content) ? { blocks: result.content } : {}) }
  }

  /**
   * A story turn's output limit, unless the provider sets its own. The preset's max response length is not it: that is
   * only said to the model (softLength), and a reply that goes past it is not cut. With one set, the API is asked for
   * room enough all the same, as a service's own default may be small; dropped again if the model refuses that much.
   */
  async function replyCap(chat, provider) {
    if (provider.maxTokens) return {}
    const preset = await presetFor(store, chat.presetId)
    return Number(preset?.params?.maxTokens) > 0 ? { maxTokens: MAX_REPLY_TOKENS, softCap: true } : {}
  }

  /**
   * Where the cap a reply ran into came from, for the page to say what to change: 'provider' (最大输出 token), 'model'
   * (less than was asked for: what the model takes), or 'default' (nothing set; a preset's length is no cap).
   */
  const capFrom = (cap, provider, api) => {
    const asked = provider.maxTokens || cap.maxTokens || 0
    if (asked && api.cap && api.cap < asked) return 'model'
    return provider.maxTokens ? 'provider' : 'default'
  }

  /**
   * Run one turn. `emit` receives { type: 'delta', text } while streaming.
   * @param parentId - the assistant node to continue from.
   * @param userNodeId - reuse an existing user node (regenerate) instead of creating one.
   * @param continueId - 继续生成: the reply to write on from where it stopped, from its turn's prompt as regenerate sends it;
   *   the reply and what comes are saved as a new version of it, the one cut short kept among its versions.
   * @param marks - ask for the 视觉小说格式 (a regenerated turn keeps what it asked).
   * @param options.keepCut - a provider's reply stopped partway (by the player, or by a failure) is saved as far as it
   *   went, marked (api.truncated 'stopped' or 'broken'), and the result's `cut` says why. Without it such a turn fails whole.
   */
  /** @param files - 直连对话: what came with the message, as read for the page (forge/references.mjs). */
  async function runTurn(chatId, { parentId, input, userNodeId, continueId = null, marks = false, game = null, files: attached = [] }, emit, { keepCut = false } = {}) {
    if (running.has(chatId)) throw httpError(409, msg`这个对话正在生成`)
    const abortController = new AbortController()
    running.set(chatId, abortController)
    // A failed turn on a subscription session resumed in place: the backend forgets its tip.
    let resumedInPlace = null
    try {
      let chat = await store.getChat(chatId)
      const files = chat.cardId === DIRECT_CARD ? cleanReferences(attached) : []
      const continued = continueId ? chat.nodes[continueId] : null
      if (continueId) {
        if (!continued || continued.role !== 'assistant' || continued.deleted) throw httpError(404, msg`要继续生成的回复不存在`)
        if (chat.nodes[continued.parent]?.role !== 'user') throw httpError(400, msg`开场白不能继续生成，可以直接修改它`)
        userNodeId = continued.parent
      }
      let userNode = userNodeId ? chat.nodes[userNodeId] : null
      if (userNodeId && (!userNode || userNode.role !== 'user')) throw httpError(404, msg`要重新生成的回合不存在`)
      if (userNode?.deleted) throw httpError(400, msg`这条消息已经删除，不能从它重新生成`)
      let parent = chat.nodes[userNode ? userNode.parent : parentId]
      if (!parent || parent.role !== 'assistant') throw httpError(400, msg`只能在一条叙述之后继续`)
      const rules = userNode ? null : await gameTurn(chat, parent, input, game)
      const text = userNode ? userNode.text : rules?.input ?? String(input ?? '').trim()
      if (!text) throw httpError(400, msg`输入不能为空`)
      // 自动压缩: a new turn on a story past the threshold starts from its archive.
      if (!userNode) {
        const compacted = await compactBeforeTurn(chat, parent, abortController, emit)
        if (compacted) {
          chat = compacted
          parent = chat.nodes[parent.id]
        }
      }

      // The card's scripts at a new turn's start (MESSAGE_SENT and after): what they inject goes into this turn, and the
      // variables they set are what it starts from, kept with the turn as its template writes are (a regenerate replays them).
      // What else they change on the chat (its variables, injections, books, prompt) is kept with the reply, on the chat as
      // it is read then: a turn that fails keeps none of it, and what came meanwhile (a card frame's writes) stays.
      let startWrites = []
      let startNotes = []
      let startSide = null
      if (!userNode && chat.cardId !== DIRECT_CARD) {
        const sides = () => new Map(Object.keys(chat).filter(key => key !== 'nodes').map(key => [key, JSON.stringify(chat[key])]))
        const before = sides()
        const started = await cardScripts.turnStarting(await store.getCard(chat.cardId).catch(() => null), chat, [...pathTo(chat, parent.id), { role: 'user', text, state: parent.state ?? {} }])
        if (started.state) startWrites = stateWrites(parent.state ?? {}, started.state)
        startNotes = started.notes
        const after = sides()
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key))
        if (changed.length) startSide = Object.fromEntries(changed.map(key => [key, chat[key]]))
      }
      // Regenerating reuses the recorded prompt verbatim, so the fork's prefix
      // (and its worldbook injections) matches the original attempt exactly.
      const preparing = span('prompt')
      let prepared = userNode
        ? { settings: await store.getSettings(), prompt: userNode.prompt, injected: userNode.injected, injectedTitles: userNode.injectedTitles, templateWrites: userNode.templateWrites ?? [], ...(userNode.presetTail ? { presetTail: userNode.presetTail } : {}), ...(userNode.prefill ? { prefill: userNode.prefill } : {}) }
        : await preparePrompt(chat, parent, text, { marks, rules, files, startWrites })
      preparing()
      const target = await targetFor(modelFor(chat, prepared.settings), prepared.settings)
      if (continued && !target.api) throw httpError(400, msg`订阅模型不能继续生成：换一个供应商的模型再试`)
      // 联网: the provider's own search, when this chat has it on and the model has one. A new turn's
      // message says when to search (kept with the turn, so a regenerate sends the same).
      const webSearch = Boolean(chat.webSearch && target.api && webSearchKind(target.provider, target.modelId))
      // Its words are for a story; 直连对话 has the search tool and needs no more said.
      const withSearchNote = p => (webSearch && !userNode && chat.cardId !== DIRECT_CARD ? { ...p, prompt: `${p.prompt}${SEARCH_NOTE()}` } : p)
      prepared = withSearchNote(prepared)
      const newSession = Boolean(parent.compaction)
      // The turn's prompt again with the full variable list, the piled-up copies gone.
      const reprepare = async () => {
        const full = await preparePrompt(chat, parent, text, { forceFull: true, marks, rules, files })
        full.dynamicState = { ...full.dynamicState, compacted: true }
        return full
      }
      let compacted = null
      let trimmed = null
      let fork = false
      let run = null // the subscription backend's query options
      if (target.api) {
        // The history is rebuilt every turn (and applies the card's regex as it goes), so the strip always applies.
        if (!userNode && prepared.shouldCompact) {
          const removedChars = accumulatedDynamic(pathTo(chat, parent.id))
          // Built again: the 联网 note with it, as the search tool still goes.
          prepared = withSearchNote(await reprepare())
          compacted = { changed: true, removedChars }
        }
      } else {
        const before = await subscription.beforeTurn({ chat, parent, prepared, userNode, newSession, abortController, model: target.model, reprepare })
        ;({ prepared, compacted, trimmed, fork, resumedInPlace } = before)
        run = before.options
      }
      emit({
        type: 'start',
        fork,
        newSession,
        api: target.api ? target.provider.name : null,
        // Who writes it, as the page names it while it waits; `watch`: the page hears of every long silence (quietWatch).
        ...(target.api ? { by: `${target.provider.name} · ${target.modelId}`, watch: streams(target.provider) } : {}),
        injected: prepared.injectedTitles,
        templateErrors: prepared.templateErrors ?? [],
        trimmed,
        compacted,
        // What the rules settled for this turn: the page shows it while the reply is written.
        ...(rules ? { sheet: keptSheet(rules.sheet) } : {}),
      })

      const started = Date.now()
      const waiting = span('model.first')
      const writing = span('model')
      let firstToken = 0
      // What has been shown of the reply and of its thinking, for a reply that stops partway.
      let shown = ''
      let thought = ''
      const onText = delta => {
        if (!firstToken) {
          firstToken = Date.now() - started
          waiting()
        }
        shown += delta
        emit({ type: 'delta', text: delta })
      }
      // The relay lost the system prompt, seen only at the end: the page drops what it showed, and the answer comes again.
      const onRestart = () => {
        shown = ''
        thought = ''
        lookedTo = 0
        reached = null
        emit({ type: 'restart' })
      }
      // The model's own thinking as it comes (显示思考过程 on): shown above the reply, never sent back to the model.
      const onReasoning = delta => {
        thought += delta
        emit({ type: 'reasoning', text: delta })
      }
      // A busy provider (Vertex AI's 429) asked again after a wait: the page says so meanwhile.
      const onRetry = info => {
        quiet.waits(info.wait)
        emit({ type: 'retrying', provider: target.provider?.name, ...info })
      }
      // While upstream is waited for (a streaming provider): how long it has sent nothing.
      const quiet = quietWatch(emit)
      const streamed = Boolean(target.api) && streams(target.provider)
      // 游戏规则: the stops that end this turn's reply (looked at again as it is kept). Past one, the rest is not waited for.
      const ahead = target.api ? await rulebooks?.read(chat.cardId).catch(() => null) : null
      const turnOf = userNode ?? rules
      const stopsAhead = rulesOn(ahead) && pausesOn(ahead, ownPreset(chat)) && !turnOf?.battle ? gateKinds(ahead).filter(kind => kind !== 'check' || !turnOf?.check) : []
      let lookedTo = 0
      let reached = null
      const enough = () => {
        // Looked at only when a mark has been closed since.
        const end = shown.lastIndexOf('】') + 1
        if (end <= lookedTo) return false
        lookedTo = end
        reached = surelyAtGate(continued ? joinContinued(continued.text, shown) : shown, stopsAhead)
        return Boolean(reached)
      }
      let outcome
      let cut = null
      // 直连对话: what the model did with tools this turn, kept with the reply however the turn ends.
      const toolSteps = []
      let toolset = null
      // The tokens of the calls before the answer.
      let usage = null
      if (target.api) {
        const building = span('prompt.history')
        // 聊天中 @深度: this turn's blocks at their depth (historyFor), the message itself as it goes now (`sending`).
        const { messages: history, newest: turnText } = await historyFor(chat, parent, { stripAll: Boolean(compacted || userNode?.dynamic?.compacted), newest: prepared.prompt, steps: 'keep' })
        const sending = { ...prepared, prompt: turnText }
        building()
        const cap = await replyCap(chat, target.provider)
        try {
          // 同酒馆 on a provider that takes them: the turn's message as the history will keep it, its after-history
          // entries after it as messages of their own (tailMessages); the cache mark stays on the turn's message.
          // 继续生成: the reply so far, then the ask to write on (a user message: not every model takes a reply to finish).
          // Marked `tail`: the cache mark stays on the turn's message, which the next turn sends as it is.
          const more = continued ? [{ role: 'assistant', content: continued.text, tail: true }, { role: 'user', content: CONTINUE_NUDGE, tail: true }] : []
          // 应用帮助 (直连对话): what the assistant knows of the app after the chat's own system prompt, and it may look
          // things up before it answers (help.mjs). Its lookups and what they found go after the turn's message for this
          // turn only (`tail`); the newest result gets a cache mark, so each lookup reads the one before from the cache.
          const helping = helpOn(chat) && !continued
          // 游戏规则: a reply that has come to its mark stops there; what comes after it is not wanted.
          const stopsAtMark = async text => {
            const book = await rulebooks?.read(chat.cardId).catch(() => null)
            return rulesOn(book) && pausesOn(book, ownPreset(chat)) && !userNode?.battle && Boolean(cutAtGate(text, gateKinds(book)).gate)
          }
          // Files (tools/index.mjs), in a 直连对话 the player gave folders.
          toolset = chat.cardId === DIRECT_CARD && !continued ? await tools?.forTurn(chatId) ?? null : null
          // The API's own tool calling where it has it; else, or once a model refuses it, calls as text.
          const pair = `${target.provider.id}/${target.modelId}`
          let native = Boolean(toolset) && nativeTools(target.provider, target.modelId)
          const helpText = helping ? helpSystem(await appHelp(), app) : ''
          const system = () => [chat.systemPrompt, helpText, toolset?.system(native) ?? ''].filter(Boolean).join('\n\n')
          // What a reply asks for before it can be an answer: { calls } of tools, { lookup } the help; null for an answer.
          const requestOf = result => {
            if (result.calls?.length) return { calls: result.calls.map(item => ({ ...nativeCall(item, toolset.names), native: item })) }
            const call = toolset ? toolCall(result.reply, toolset.names) : null
            if (call) return { calls: [call] }
            const lookup = helping ? lookupOf(result.reply) : null
            return lookup ? { lookup } : null
          }
          const steps = []
          const lookups = []
          // 预填 (prepared.prefill): the reply's own start, where the model takes one; else as text after the turn's message,
          // as it went before. Not with 继续生成 (the reply so far is its start) or 应用帮助.
          const prefill = continued || helping || toolset ? '' : prepared.prefill ?? ''
          // By the provider's address too: two providers of one name (or a test's) are not one another.
          const prefillKey = `${target.provider.baseURL}|${target.modelId}`
          let asPrefill = Boolean(prefill) && !refusesPrefill.has(prefillKey)
          const prefillMessages = () => (prefill ? [{ role: asPrefill ? 'assistant' : 'user', content: prefill, tail: true }] : [])
          const ask = asSystem => {
            // A lookup or a tool call is held back from the page; an answer comes on as it is written.
            const gate = helping || toolset ? callGate([...(toolset ? callMarks : []), ...(helping ? [lookupMark] : [])], onText, onRestart) : null
            // Taken as the reply's start inside a thinking tag: the reply is shown and kept with that tag in front.
            // The model may write the tag itself (DeepSeek did, 2026-11-16): the reply's first characters are held
            // till that is known, so it is not there twice.
            let lead = asPrefill ? foldLead(prefill) : ''
            const front = lead
            const tag = front.trim().toLowerCase()
            const ownTag = text => text.trimStart().toLowerCase().startsWith(tag)
            let head = ''
            const written = lead
              ? delta => {
                  if (!lead) return onText(delta)
                  head += delta
                  const start = head.trimStart().toLowerCase()
                  if (start.length < tag.length && tag.startsWith(start)) return
                  if (!ownTag(head)) onText(lead)
                  lead = ''
                  const held = head
                  head = ''
                  onText(held)
                }
              : onText
            // Written afresh (the stream broke and is asked again): the tag in front again.
            const restarted = () => {
              lead = front
              head = ''
              onRestart?.()
            }
            const asNative = native
            if (streamed) quiet.start()
            return generateApi(target, { system: system(), messages: [...withSteps(history, { native, pair }), ...turnMessages(target, sending, asSystem), ...prefillMessages(), ...more, ...steps.flatMap(step => (step.render ? step.render(asNative) : [step]))], ...cap, ...(native ? { tools: toolset.defs } : {}), webSearch, onRestart: restarted, onRetry, onReasoning, onData: () => quiet.came(), ...(stopsAhead.length ? { enough } : {}), chatThinking: chat.thinking }, abortController.signal, gate ? delta => gate.push(delta) : written).finally(() => quiet.stop()).then(result => {
              gate?.end(Boolean(requestOf(result)))
              if (!front) return result
              // Shorter than the tag: what was held goes on as it is.
              if (lead && head) onText(head)
              lead = ''
              head = ''
              const whole = ownTag(result.reply) ? result.reply : `${front}${result.reply}`
              // The tag never closed: the model wrote no thinking and went straight into the story. Kept as written;
              // with the tag in front it would all fold away as thinking.
              const closed = new RegExp(`</${tag.slice(1, -1)}>`, 'i').test(whole)
              return { ...result, reply: closed ? whole : result.reply }
            })
          }
          let asSystem = true
          const asked = () => ask(asSystem).catch(error => {
            // No tools of its own after all: the same again, the calls as text.
            if (error.toolsRefused && native) {
              native = false
              return asked()
            }
            // A model or relay that refuses a system message after the turn's: the entries go with the turn's message.
            if (!sendsSystemTail(target, prepared) || !asSystem || (error.status !== 400 && error.providerStatus !== 400) || !/system/i.test(error.message ?? '')) throw error
            refusesSystemTail.add(pair)
            asSystem = false
            return ask(false)
          })
          outcome = await asked().catch(error => {
            // One that refuses a 预填 (the newer Claude models, DeepSeek's reasoner): as text, as before, from now on.
            if (!asPrefill || (error.status !== 400 && error.providerStatus !== 400) || error.contextFull || !PREFILL_REFUSED.test(error.message ?? '')) throw error
            refusesPrefill.add(prefillKey)
            asPrefill = false
            return asked()
          })
          const times = new Map()
          let askAt = ASK_TOKENS
          for (let wanted = requestOf(outcome); wanted; wanted = requestOf(outcome)) {
            usage = addUsage(usage, outcome.tokens)
            if (wanted.calls) {
              const own = Boolean(wanted.calls[0].native)
              // A reply's words before its calls: said with the first of them.
              const said = own ? outcome.reply.trim() : wanted.calls[0].said
              // No more: what it said before the call is its answer.
              const stopHere = why => {
                outcome = { ...outcome, reply: [said, why].filter(Boolean).join('\n\n'), stopped: true }
              }
              if (toolSteps.length >= MAX_STEPS) {
                stopHere(msg`（这一轮用了 ${MAX_STEPS} 次工具还没做完，先停在这里。要接着做就说一声。）`)
                break
              }
              const spent = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)
              if (spent > askAt) {
                emit({ type: 'tool_wait' })
                if (!(await toolset.goOn(spent, { signal: abortController.signal }))) {
                  if (abortController.signal.aborted) throw httpError(499, msg`已停止生成`)
                  stopHere(msg`（用量比较大，按你的意思先停在这里。）`)
                  break
                }
                askAt = spent + ASK_TOKENS
              }
              const reply = callId()
              const entries = []
              for (const [index, call] of wanted.calls.entries()) {
                const item = call.native ?? null
                const number = toolSteps.length + 1
                if (index === 0) call.said = said
                const key = callKey(call)
                times.set(key, (times.get(key) ?? 0) + 1)
                const begun = Date.now()
                let done
                if (toolSteps.length >= MAX_STEPS) done = { text: '工具次数用完了，没有执行', ok: false, past: true }
                else {
                  emit({ type: 'tool', step: number, name: call.name, args: call.args, said: call.said })
                  done = times.get(key) > SAME_CALL
                    ? { text: `出错：同样的调用已经做过 ${SAME_CALL} 次了，没有再做。换个办法，或者告诉用户做不到`, ok: false }
                    : await toolset.step(call, { signal: abortController.signal, onWait: () => emit({ type: 'tool_wait' }) })
                }
                const kept = keptStep({ call, result: done.text, ok: done.ok, summary: done.summary, ms: Date.now() - begun, native: item ? { id: item.id, extra: item.extra, thought: index === 0 ? outcome.thought : null, by: pair, reply } : null })
                if (!done.past) {
                  toolSteps.push(kept)
                  emit({ type: 'tool_done', step: number, ok: done.ok, summary: done.summary ?? null })
                }
                const left = Math.max(0, MAX_STEPS - toolSteps.length)
                entries.push({ call, id: kept.id, item, ok: done.ok, text: nativeResult(done.text, { left }), block: resultBlock(call.name, done.text, { left, note: call.more ? '你在调用后面写的没有用上。' : '' }) })
                if (abortController.signal.aborted) throw httpError(499, msg`已停止生成`)
              }
              // Both ways of writing this step out: a model that refuses tools halfway is asked again with it as text.
              const { thought, blocks } = outcome
              // The ids as kept: the model's own, unless the API's would not be taken back.
              const asWritten = blocks?.map(block => (block?.type === 'tool_use' ? { ...block, id: entries.find(entry => entry.item?.id === block.id)?.id ?? block.id } : block))
              const step = {
                cache: true,
                render(asNative) {
                  if (asNative && own) {
                    return [
                      { role: 'assistant', content: said, tail: true, by: pair, calls: entries.map(({ id, item }) => ({ id, name: item.name, input: item.input, ...(item.extra ? { extra: item.extra } : {}) })), ...(thought ? { thought: { ...thought, by: pair } } : {}), ...(asWritten ? { blocks: asWritten } : {}) },
                      { role: 'tool', tail: true, results: entries.map(({ id, text, ok }) => ({ id, text, ok })), ...(step.cache ? { cache: true } : {}) },
                    ]
                  }
                  return entries.flatMap(({ call, block }, index) => [
                    { role: 'assistant', content: [call.said, call.raw].filter(Boolean).join('\n\n') || '……', tail: true },
                    { role: 'user', content: block, tail: true, ...(step.cache && index === entries.length - 1 ? { cache: true } : {}) },
                  ])
                },
              }
              for (const earlier of steps) delete earlier.cache
              steps.push(step)
              outcome = await asked()
              continue
            }
            const request = wanted.lookup
            if (lookups.length >= MAX_LOOKUPS) throw httpError(502, msg`助手查了 ${MAX_LOOKUPS} 次资料还没有回答：可以重新生成，或者换个问法`)
            const label = lookupLabel(request)
            lookups.push(label)
            emit({ type: 'lookup', ...label, step: lookups.length })
            const found = await runLookup(request, { help: await appHelp() })
            const left = MAX_LOOKUPS - lookups.length
            for (const step of steps) delete step.cache
            steps.push(
              { role: 'assistant', content: lookupLine(outcome.reply), tail: true },
              { role: 'user', content: `<lookup_result>\n${found}\n</lookup_result>\n${left ? `（还能查 ${left} 次）` : '（查询次数用完了，现在直接回答，不能再查）'}`, tail: true, cache: true },
            )
            outcome = await asked()
          }
          // Steps with tools are kept in the history: what the context holds is the last call's. One stopped at a call has been counted.
          // 自动续写: a reply cut at the output limit is asked on from where it stopped, as 继续生成 does it, into the same
          // reply. Not one with tools in it (a call may be what was cut), nor one that goes round in circles.
          const autoContinue = (await store.getSettings()).autoContinue !== false
          for (let round = 1; autoContinue && round <= AUTO_ROUNDS && outcome.api?.truncated === true && !outcome.calls && !toolset; round++) {
            const sofar = continued && !outcome.joined ? joinContinued(continued.text, outcome.reply) : outcome.reply
            if (sofar.length > AUTO_MOST || goesRound(sofar) || (await stopsAtMark(sofar))) break
            emit({ type: 'continuing', round })
            let joined = joinedStream(sofar)
            const onMore = delta => {
              const text = joined.push(delta)
              if (text) onText(text)
            }
            const before = shown
            // Written afresh: the page starts over, with what was there.
            const restarted = () => {
              onRestart()
              onText(before)
              joined = joinedStream(sofar)
            }
            const rest = [...turnMessages(target, sending, asSystem), ...steps.flatMap(step => (step.render ? step.render(false) : [step])), { role: 'assistant', content: sofar.trimEnd(), tail: true }, { role: 'user', content: CONTINUE_NUDGE, tail: true }]
            let next
            if (streamed) quiet.start()
            try {
              next = await generateApi(target, { system: system(), messages: [...withSteps(history, { native, pair }), ...rest], ...cap, onRestart: restarted, onRetry, onReasoning, onData: () => quiet.came(), ...(stopsAhead.length ? { enough } : {}), chatThinking: chat.thinking }, abortController.signal, onMore).finally(() => quiet.stop())
            } catch (error) {
              if (abortController.signal.aborted) {
                // Stopped: the part before is kept with what came since, and paid for.
                usage = addUsage(usage, outcome.tokens)
                throw error
              }
              // What was written stays, marked as cut: the player can go on from it.
              break
            }
            const tail = joined.end()
            if (tail) onText(tail)
            outcome = {
              ...outcome,
              reply: joinContinued(sofar, next.reply),
              // With 继续生成: the reply before it is in front already.
              joined: Boolean(continued),
              // What the context held is what the first call was sent.
              tokens: addUsage(addUsage(null, outcome.tokens), next.tokens),
              api: { ...next.api, more: round },
              // How the whole ended is how its last part did.
              end: next.end,
              ...(outcome.reasoning || next.reasoning ? { reasoning: [outcome.reasoning, next.reasoning].filter(Boolean).join('\n\n') } : {}),
            }
          }
          if (outcome.api?.truncated === true) outcome = { ...outcome, api: { ...outcome.api, capFrom: capFrom(cap, target.provider, outcome.api) } }
          if (usage) outcome = { ...outcome, tokens: { ...(outcome.stopped ? usage : addUsage(usage, outcome.tokens)), ...(toolSteps.length && outcome.tokens ? { prompt: outcome.tokens.prompt ?? (outcome.tokens.input ?? 0) + (outcome.tokens.cacheRead ?? 0) + (outcome.tokens.cacheWrite ?? 0) } : {}) } }
          if (lookups.length) outcome = { ...outcome, lookups }
        } catch (error) {
          // The provider tells the tokens at the end of an answer, so this one has none. An update block it finished still counts.
          // 继续生成: what came on after the reply, kept with it; nothing new, and the turn fails (the reply stays as it was).
          // What was done with tools is kept too, though no word of the answer came: the files are changed.
          const partial = displayText(withoutOpenEnd(shown)) ? shown : toolSteps.length ? msg`（这一轮没有写完，上面是已经做了的事。）` : ''
          if (!keepCut || !partial) throw error
          const kept = withoutOpenEnd(continued ? joinContinued(continued.text, partial) : partial)
          const stopped = abortController.signal.aborted
          cut = stopped ? { stopped } : { stopped, status: error.status ?? 500, message: error.message, detail: error.detail }
          outcome = { reply: kept, model: target.model, tokens: usage, sdk: null, api: { provider: target.provider.id, model: target.modelId, truncated: stopped ? 'stopped' : error.gaveUp ? 'timeout' : 'broken' }, search: null, joined: Boolean(continued), ...(thought.trim() ? { reasoning: thought.trim() } : {}) }
        }
      } else {
        // The turn's message as the session will hold it: the 屏蔽词 applied (the system prompt in beforeTurn).
        // A 预填 has no place of its own there: after the turn's message, as text.
        const sent = blockSent(prepared.prefill ? `${prepared.prompt}\n\n${prepared.prefill}` : prepared.prompt, await store.getBlockWords())
        outcome = await subscription.generate(sent, run, { onText, onRate: info => emit({ type: 'rate_limit', info }) })
        if (!outcome.sdk) throw httpError(502, msg`模型没有返回正文`)
      }
      writing()
      // Not read past its stop: the story's wrapper is closed for it.
      if (reached?.wrapper && !cut) outcome = { ...outcome, reply: `${outcome.reply.trimEnd()}\n</${reached.wrapper}>` }
      // What is left is this app's own work: the reply kept, its variables worked out.
      emit({ type: 'written' })
      if (!outcome.reply.trim()) throw httpError(502, msg`模型没有返回正文`)
      const written = continued && !outcome.joined ? joinContinued(continued.text, outcome.reply) : outcome.reply

      // Re-read and saved with no other change to the chat in between (a picture drawn, the card's variables):
      // what came meanwhile stays.
      const settling = span('settle')
      return await store.withChat(chatId, async () => {
        const fresh = await store.getChat(chatId)
        // What the card's scripts changed on the chat as the turn began, now that the turn has its reply.
        for (const [key, value] of Object.entries(startSide ?? {})) {
          if (value === undefined) delete fresh[key]
          else fresh[key] = value
        }
        const now = new Date().toISOString()
        let globalWrites = []
        if (!userNode) {
          userNode = {
            id: newId(),
            parent: parent.id,
            role: 'user',
            text: prepared.input ?? text,
            prompt: prepared.prompt,
            // 同酒馆's entries by role, so a regenerate sends them as this turn did.
            ...(prepared.presetTail ? { presetTail: prepared.presetTail } : {}),
            ...(prepared.prefill ? { prefill: prepared.prefill } : {}),
            injected: prepared.injected,
            injectedTitles: prepared.injectedTitles,
            ...(prepared.recalled?.length ? { recalled: prepared.recalled, recalledTitles: prepared.recalledTitles } : {}),
            // 应用帮助: the help sections this message carried (later ones leave them out).
            ...(prepared.helpIds?.length ? { helpIds: prepared.helpIds } : {}),
            ...(files.length ? { files: files.map(({ id, name, kind, text, chars, total }) => ({ id, name, kind, text, chars, total })) } : {}),
            templateErrors: prepared.templateErrors ?? [],
            // What the turn's templates wrote to the chat state: a regenerate plays it back, never runs it twice.
            ...(prepared.templateWrites?.length ? { templateWrites: prepared.templateWrites } : {}),
            ...(prepared.dynamicState ? { dynamic: prepared.dynamicState } : {}),
            ...(prepared.stateLeft ? { stateLeft: prepared.stateLeft } : {}),
            ...(rules?.check ? { check: rules.check } : {}),
            ...(rules?.battle ? { battle: rules.battle } : {}),
            ...(rules?.auto ? { auto: true } : {}),
            ...(rules?.ops.length ? { gameOps: rules.ops } : {}),
            ...(rules?.writes.length ? { gameWrites: rules.writes } : {}),
            ...(prepared.plotSet ? { plotSet: prepared.plotSet } : {}),
            ...(prepared.plotSent ? { plotSent: prepared.plotSent } : {}),
            sel: null,
            createdAt: now,
          }
          fresh.nodes[userNode.id] = userNode
          forgetDeleted(fresh)
          // Chat-wide and app-wide variables are outside the tree: written once, when the turn is first taken.
          if (prepared.localWrites?.length) fresh.frameVars = applyWrites(fresh.frameVars ?? {}, prepared.localWrites)
          globalWrites = prepared.globalWrites ?? []
          // 剧本: the player's change it carried has been sent.
          if (prepared.plotSet && fresh.plot?.pending?.after === parent.id) fresh.plot.pending = null
        }
        // 游戏规则: a reply stops at its mark, what was written past it goes. A turn that has rolled does not roll again.
        const book = await rulebooks?.read(fresh.cardId).catch(() => null)
        const ruled = rulesOn(book)
        const stops = ruled && pausesOn(book, ownPreset(fresh)) && !userNode.battle ? gateKinds(book).filter(kind => kind !== 'check' || !userNode.check) : []
        const { text: gated, gate } = cutAtGate(written, stops)
        // 剧本: the 剧本进度 mark comes out of the reply as it is kept (so out of everything that reads it later), and the
        // progress it made goes on the reply, read against what the turn told the model.
        const { text: reply, mark: plotMark, raw: plotRaw } = takePlotMark(gated)
        // A reply that upstream did not end as it should is marked: the page says whose doing it was, and offers 继续生成.
        if (!cut && !gate && outcome.end && outcome.api && !outcome.api.truncated && !outcome.stopped) {
          const more = fresh.cardId !== DIRECT_CARD && !hasUpdateBlock(reply) && (await asksUpdate(fresh, prepared.settings).catch(() => false))
          const kind = upstreamCut(reply, outcome.end, { more })
          outcome.api = { ...outcome.api, ...(kind ? { truncated: kind } : {}), ...(outcome.end.stop ? { stop: String(outcome.end.stop).slice(0, 60) } : {}) }
        }
        const plotCopy = fresh.plot?.copy
        const plotBase = plotCopy && userNode.plotSent?.of === plotCopy.id
          ? applySet(plotCopy, progressOn(plotCopy, withoutHidden(pathTo(fresh, userNode.parent)), fresh.plot.start), userNode.plotSet?.of === plotCopy.id ? userNode.plotSet : null)
          : null
        const gameWrites = userNode.gameWrites ?? []
        const turnWrites = [...(userNode.templateWrites ?? []), ...gameWrites]
        const replyFrom = applyWrites(parent.state, turnWrites)
        // A card whose scripts follow its variables has them run around the reply's update, as MVU runs them; any
        // other card's update is applied as it always was.
        const turnCard = await store.getCard(fresh.cardId).catch(() => null)
        const scripted = await cardScripts.update(turnCard, fresh, { before: replyFrom, text: reply, path: pathTo(fresh, parent.id), received: true })
        // 只读变量: what the card marks read-only stays as it was, whatever the reply wrote.
        const updated = keepReadOnly(replyFrom, scripted ?? applyStateUpdates(replyFrom, reply), turnCard?.readOnly)
        // The reply's own templates run once and the rendered text is what is kept, shown and
        // sent back later; what they write lands after the reply's own update blocks.
        const evaluated = hasEjs(reply) ? await evaluateReply(fresh, userNode, reply, updated.state) : null
        const replyText = evaluated?.text ?? reply
        if (evaluated?.writes.local.length) fresh.frameVars = applyWrites(fresh.frameVars ?? {}, evaluated.writes.local)
        if (evaluated) globalWrites = [...globalWrites, ...evaluated.writes.global]
        // What the rules settled this turn stands, whatever the reply did to it. These go last, and with the
        // reply's own writes, so 补写变量 keeps them too. A bag is not among them: what the reply put in it stays.
        const replyWrites = [...(evaluated?.writes.message ?? []), ...gameWrites.filter(write => typeof write.value === 'number')]
        // The card's variable rules have the last word on the state, so the sheet reads what they kept.
        const ruleInput = applyWrites(updated.state, replyWrites)
        let kept = await keptToSchema(fresh, ruleInput, turnCard, { before: parent.state })
        // 这轮变量没更新上: what of the reply's update did not take, as the rules first saw it.
        const varIssues = await varIssuesOf(fresh, turnCard, { before: replyFrom, text: reply, written: ruleInput, kept, scripted: Boolean(scripted), keepFrom: parent.state })
        const sheet = ruled ? settledSheet(book, pathTo(fresh, parent.id), userNode, replyText, kept.state) : null
        // 形态 come to this turn (from the menu, or by the reply's own mark) are in the card's variables too, whether
        // or not the reply remembered to put them there.
        const formed = sheet ? formWrites(book, kept.state, sheetOf(book, sheetOnPath(pathTo(fresh, parent.id)), parent.state), sheet) : []
        if (formed.length) {
          replyWrites.push(...formed)
          kept = await keptToSchema(fresh, applyWrites(kept.state, formed), turnCard, { before: parent.state })
        }
        const finalState = kept.state
        // 剧本: the progress the reply made, with what the program knows after it (the variables, this turn's roll and
        // fight, for the exits that need them); an ending reached the first time goes in the card's 结局收集.
        const plotProgress = plotBase
          ? applyMark(plotCopy, plotBase, plotMark, userNode.plotSent, {
            whole: !cut && !gate && !outcome.api?.truncated,
            facts: {
              state: finalState,
              check: userNode.check ? (userNode.check.tier === 'fail' ? 'fail' : 'pass') : null,
              battle: userNode.battle?.over === 'won' ? 'won' : userNode.battle?.over === 'lost' || userNode.battle?.over === 'fled' ? 'lost' : null,
            },
          })
          : null
        // 辅助模型判断: a reply counts towards the helper's next look; at its count, it looks once the reply is in.
        const judging = plotProgress && fresh.plot?.judge?.by === 'helper' && !plotProgress.ended
        if (judging) plotProgress.wait = (plotBase.wait ?? 0) + 1
        const judgeNow = judging && plotProgress.wait >= (fresh.plot.judge.every ?? 3) && !cut && !gate
        if (plotProgress?.ended && !plotBase.ended) {
          const firstTime = await noteEnding(store, fresh.cardId, plotCopy.id, sceneOf(plotCopy, plotProgress.at)).catch(() => false)
          if (firstTime) plotProgress.first = true
        }
        const node = {
          id: newId(),
          parent: userNode.id,
          role: 'assistant',
          text: replyText,
          display: displayText(ruled ? withoutGameMarks(replyText) : replyText),
          state: finalState,
          ...(sheet ? { game: sheet } : {}),
          ...(gate ? { gate } : {}),
          ...(plotProgress ? { plot: plotProgress } : {}),
          // The 剧本进度 mark as the model wrote it (at most 200 characters), to look into; the page never gets it.
          ...(plotRaw ? { plotMark: plotRaw } : {}),
          stateChanges: [...new Set([...writeLabels(turnWrites), ...updated.changes, ...writeLabels(evaluated?.writes.message), ...writeLabels(formed)])],
          ...(updated.unread ? { updateUnread: true } : {}),
          ...(kept.problem ? { schemaProblem: kept.problem } : {}),
          ...(varIssues.length ? { varIssues } : {}),
          ...(startNotes.length || scripted?.notes.length ? { scriptNotes: [...startNotes, ...(scripted?.notes ?? [])] } : {}),
          ...(replyWrites.length ? { templateWrites: replyWrites } : {}),
          ...(evaluated?.errors.length ? { templateErrors: evaluated.errors } : {}),
          sdk: outcome.sdk ?? null,
          ...(outcome.api ? { api: outcome.api } : {}),
          ...(outcome.search ? { search: outcome.search } : {}),
          // 应用帮助: what the assistant looked up before it answered ({ op, target }), shown under the reply.
          ...(outcome.lookups ? { lookups: outcome.lookups } : {}),
          // 直连对话's tools: what it did before it answered, and the turn's file changes (tools/history.mjs), to take back.
          ...(toolSteps.length ? { steps: toolSteps } : {}),
          ...(toolset?.changed() ? { fileRun: toolset.run } : {}),
          // The thinking a service wants back with every reply while there are tools (DeepSeek); not shown, unlike `reasoning`.
          ...(toolset && outcome.thought ? { thought: { ...outcome.thought, by: `${target.provider.id}/${target.modelId}` } } : {}),
          ...(outcome.reasoning ? { reasoning: outcome.reasoning } : {}),
          model: outcome.model,
          usage: outcome.tokens,
          timing: { totalMs: Date.now() - started, firstTokenMs: firstToken || null, forked: fork, ...(target.api ? { api: true } : {}), ...(quiet.longest() >= GAP_KEPT_MS ? { gapMs: quiet.longest() } : {}) },
          sel: null,
          createdAt: now,
        }
        // A new version of the reply the story was compacted into carries the archive on (the last
        // turns after it are sent verbatim, this reply among them), or the compaction would be gone.
        const replaced = userNodeId ? fresh.nodes[fresh.nodes[userNode.id]?.sel] : null
        if (replaced?.compaction && !childrenOf(fresh, replaced.id).length) node.compaction = { ...replaced.compaction, at: now }
        // A chat from before replies kept their choices: this one and those after it do, the older ones stay as sent.
        fresh.choicesKept ??= now
        fresh.nodes[node.id] = node
        // 撤销修复 is for the latest reply: the one this turn follows keeps that it was put right, not what it was before.
        if (fresh.nodes[parent.id]?.varFix?.before) delete fresh.nodes[parent.id].varFix.before
        // A card script's injection for the next turn only has been sent.
        if (!userNodeId) afterTurn(fresh)
        // Also lifts a rollback on the parent: the new turn is now the visible branch.
        selectNode(fresh, node.id)
        if (!target.api) subscription.afterTurn(fresh, outcome)
        // The session holds the reply as the model wrote it: it gets the rendered one, before
        // the next turn reads it back (the same rewrite an edit makes, so no cache is lost).
        if (!target.api && replyText !== written && node.sdk) {
          const rewritten = await subscription.editTranscripts({ chat: fresh, node, edit: { node, before: written }, path: activePath(fresh) })
          if (!rewritten.sessions) delete node.historyTrim
        }
        if (trimmed) fresh.nodes[parent.id].historyTrim = trimmed
        fresh.stateDirty = false
        await store.saveChat(fresh)
        if (globalWrites.length) {
          await store.updateSettings(current => ({ globalVars: applyWrites(current.globalVars ?? {}, globalWrites) })).catch(() => {})
        }
        if (node.usage) await ledger?.recordTurn(fresh, node).catch(() => {})
        settling()
        if (judgeNow) {
          const judged = judgePlot(chatId, node.id)
          plotJudges.set(chatId, judged)
          judged.catch(() => {}).finally(() => plotJudges.get(chatId) === judged && plotJudges.delete(chatId))
        }
        return { chat: fresh, nodeId: node.id, ...(cut ? { cut } : {}) }
      })
    } catch (error) {
      if (resumedInPlace) await subscription.forgetTip(chatId, resumedInPlace)
      if (abortController.signal.aborted) throw httpError(499, msg`已停止生成`)
      if (!error.status) error.message = friendlyError(error.message, subscription)
      throw error
    } finally {
      running.delete(chatId)
    }
  }

  /**
   * Who writes the archive. The model that wrote the tip reads its history
   * from cache: an API tip goes back to its provider, a subscription tip to
   * its session. Otherwise the chat's current model, if it can see the history.
   */
  async function compactionTarget(chat, tip, settings) {
    if (tip.api && isProviderRef(tip.model)) {
      const providers = await store.getProviders()
      if (providers.some(p => p.id === tip.model.slice(0, tip.model.indexOf('/')))) return targetFor(tip.model, settings)
    }
    if (tip.sdk && subscription && settings.subscription !== 'off') return subscription.target(tip.model || modelFor(chat, settings))
    const current = await targetFor(modelFor(chat, settings), settings)
    if (!current.api && !tip.sdk) {
      throw httpError(400, tip.imported ? msg`导入的剧情要用供应商的模型来压缩（订阅模型读不到它）：在顶栏选一个供应商的模型再压缩` : msg`这段剧情是用自定义供应商写的，订阅模型读不到它的上下文：选一个供应商的模型再压缩`)
    }
    return current
  }

  /**
   * Summarise the active path into its tip (compactAt).
   * @param options - { model, keepRecent } as compactAt takes them
   */
  async function compactChat(chatId, options = {}) {
    if (running.has(chatId)) throw httpError(409, msg`这个对话正在生成`)
    const abortController = new AbortController()
    running.set(chatId, abortController)
    try {
      let chat = await store.getChat(chatId)
      let tip = activePath(chat).at(-1)
      // 重写这份存档: the latest reply is the compaction point (just compacted, nothing written since). It is
      // written again from what came before it, the old one replaced only once the new one is in.
      if (options.again && tip?.compaction) {
        if (tip.compaction.imported) throw httpError(400, msg`这是导入的存档，没有原来的剧情可以重写`)
        if (childrenOf(chat, tip.id).length) throw httpError(400, msg`回滚收起的回合还在这条后面：先恢复它们，或从这里接着写一轮再压缩`)
        chat = structuredClone(chat)
        delete chat.nodes[tip.id].compaction
        tip = chat.nodes[tip.id]
      }
      return await compactAt(chat, tip, abortController, options)
    } catch (error) {
      if (abortController.signal.aborted) throw httpError(499, msg`已停止压缩`)
      if (!error.status) error.message = friendlyError(error.message, subscription)
      throw error
    } finally {
      running.delete(chatId)
    }
  }

  // A compaction under way: how many requests it has sent (the page shows 第 N 段 for a story read in parts).
  const compacting = new Map()

  /**
   * Summarise the story up to `tip` into it (see recap.mjs) and save the chat. The summary
   * comes from the model that wrote it where possible (the same provider with the rebuilt
   * history, or the subscription backend's own session), so the history is read from cache;
   * the next turn from the tip starts afresh.
   * @param options.model - another model to write it (one with a longer context, say)
   * @param options.keepRecent - no model at all: the archive before (if any) and the last turns
   *   verbatim carry the story on, the way on when no model can read it any more.
   * @param options.again - asked for all the same (the page said so first): one turn since the last compaction is
   *   enough, before a switch to a model with a shorter context, say.
   */
  async function compactAt(chat, tip, abortController, { model = '', keepRecent = false, again = false } = {}) {
    const path = pathTo(chat, tip.id)
    const blocked = compactBlock(chat, path)
    if (blocked === 'none') throw httpError(400, msg`还没有可以压缩的剧情`)
    if (tip.hidden) throw httpError(400, msg`最后一轮已隐藏：先取消隐藏，或接着写一轮再压缩`)
    const anyway = again && (blocked === 'recent' || blocked === 'start') && turnsSinceCompaction(path) >= 1
    if (blocked && !anyway) throw httpError(400, compactRefusal(blocked, turnsSinceCompaction(path)))
    const since = turnsSinceCompaction(path)
    const started = Date.now()
    const settings = await store.getSettings()
    let used
    let target = null
    try {
      if (keepRecent) {
        used = { reply: keptArchive(path, since), model: null, tokens: null }
      } else {
        target = model ? await targetFor(model, settings) : await compactionTarget(chat, tip, settings)
        if (target.api) {
          const extra = settings.memory?.enabled ? memoryRequest(chat.names, memoryOf(path)?.entries ?? []) : ''
          used = await archiveByApi(target, chat, tip, abortController.signal, settings, extra, toolNote(settings, 'memory'))
        } else {
          // A subscription session holds the turns after it, which its summary would not reach.
          if (childrenOf(chat, tip.id).length) throw httpError(400, msg`回滚收起的回合还在这条后面：先恢复它们，或从这里接着写一轮再压缩`)
          used = await subscription.compact({ chat, tip, settings, abortController, model: target.model })
        }
        if (!looksLikeArchive(used.reply)) throw httpError(502, msg`模型没有写出剧情存档（可能接着写了剧情），这次没有压缩，可以再试一次`)
        if (extractSummary(used.reply).length < archiveMinimum(chat)) throw httpError(502, msg`模型没有写出完整的剧情存档，这次没有压缩，可以再试一次`)
      }
    } finally {
      compacting.delete(chat.id)
    }
    const summary = extractSummary(used.reply)
    // 长期记忆: the entries go with the archive; a failure there leaves the compaction as it is.
    const memory = settings.memory?.enabled && !keepRecent ? await compactionMemory(chat, path, used, target, abortController.signal).catch(() => null) : null
    const now = new Date().toISOString()
    const fresh = await store.withChat(chat.id, async () => {
      const latest = await store.getChat(chat.id)
      latest.nodes[tip.id].compaction = { summary, turns: storyTurns(path), model: used.model, usage: used.tokens, at: now, ...(keepRecent ? { kept: since } : {}), ...(memory ? { memory } : {}) }
      return store.saveChat(latest)
    })
    if (used.tokens) {
      const record = { createdAt: now, model: used.model, usage: used.tokens, timing: { totalMs: Date.now() - started, firstTokenMs: null, forked: !target?.api } }
      await ledger?.recordTurn(fresh, record).catch(() => {})
    }
    return fresh
  }

  /**
   * The archive from a provider. Too long for its context even in halves, the chat's own system
   * prompt (the card and its always-on lore) may be most of what is sent: then in parts sized for
   * the model's window, under the start of that prompt only.
   */
  async function archiveByApi(target, chat, tip, signal, settings, extra = '', note = '') {
    const history = await apiMessages(chat, tip)
    const onPart = () => compacting.set(chat.id, (compacting.get(chat.id) ?? 0) + 1)
    try {
      return await summarizeInParts(target, chat, history, signal, '', 0, { maxChars: tip.imported ? IMPORTED_PART_CHARS : Infinity, onPart, extra, note })
    } catch (error) {
      if (!error.contextFull || signal.aborted) throw error
      const window = windowOf(`${target.provider.id}/${target.modelId}`, { settings, learned: await store.getModelContext() }).tokens
      const system = `${chat.systemPrompt.slice(0, LEAN_SYSTEM_CHARS)}\n\n（设定很长，这里只保留了开头部分。）`
      try {
        return await summarizeInParts(target, chat, history, signal, '', 0, { maxChars: Math.max(20_000, Math.floor(window * 0.5)), system, onPart, extra, note })
      } catch (again) {
        if (!again.contextFull || signal.aborted) throw again
        // Not the turn's "compact it" advice: this is the compaction.
        throw Object.assign(httpError(502, msg`故事太长，${target.provider.name} · ${target.modelId} 分段也读不下：换一个上下文更大的模型来压缩，或者只保留最近两轮`), { contextFull: true })
      }
    }
  }

  /** A model call outside the story, for the usage ledger. */
  const sideRecord = (result, started) => ({ createdAt: new Date().toISOString(), model: result.model, usage: result.tokens, timing: { totalMs: Date.now() - started, firstTokenMs: null, forked: false, api: true } })

  /**
   * 长期记忆: the 记忆簿 after a compaction of `path`, from the 记忆条目 its archive came with; written
   * without them, they are asked for on their own (the same history, read from cache). null when
   * none came.
   */
  async function compactionMemory(chat, path, used, target, signal) {
    const before = memoryOf(path)
    const entries = before?.entries ?? []
    let notes = (used.replies ?? [used.reply]).map(parseEntries).filter(Boolean)
    if (!notes.length && target?.api) {
      const started = Date.now()
      const history = await apiMessages(chat, path.at(-1))
      const ask = withNote(memoryOnlyInstruction(chat.names, entries), toolNote(await store.getSettings(), 'memory'), chat.names)
      const again = await generateApi(target, { system: chat.systemPrompt, messages: [...history, { role: 'user', content: ask }] }, signal, () => {})
      await ledger?.recordTurn(chat, sideRecord(again, started)).catch(() => {})
      const note = parseEntries(again.reply)
      if (note) notes = [note]
    }
    if (!notes.length) return null
    const total = storyTurns(path)
    const place = placeEntries(turnTexts(path), { from: Math.min((before?.turns ?? 0) + 1, total), to: total })
    const book = notes.reduce((book, note) => mergeEntries(book, note, { locate: place }), entries)
    return snapshotOf(book, { turns: total, model: used.model, by: 'compaction' })
  }

  // 边玩边整理 under way, by chat: { controller, nodeId }; and the last one's failure, by chat.
  const tidying = new Map()
  const tidyErrors = new Map()

  /**
   * The model a tidy uses (settings.memory.tidy.model): the helper, the chat's own reading its history from cache, or
   * one picked by name (as the helper does, the recent turns only); a picked one no longer there: the helper's.
   */
  async function tidyTarget(chat, node, settings) {
    const providers = await store.getProviders()
    const usable = ref => isProviderRef(ref) && providers.some(p => p.id === ref.slice(0, ref.indexOf('/')))
    const picked = settings.memory.tidy.model
    if (picked !== 'chat' && picked !== 'helper' && usable(picked)) return { target: await targetFor(picked, settings), inContext: false }
    if (settings.memory.tidy.model === 'chat') {
      const own = node.api && usable(node.model) ? node.model : usable(modelFor(chat, settings)) ? modelFor(chat, settings) : null
      if (own) return { target: await targetFor(own, settings), inContext: true }
    }
    const ref = [settings.media?.helperModel, modelFor(chat, settings), settings.model].find(usable)
    if (!ref) throw httpError(400, msg`边玩边整理要用供应商的模型：在「配图与朗读」里选一个辅助模型，或在顶栏选一个供应商的模型`)
    return { target: await targetFor(ref, settings), inContext: false }
  }

  /**
   * 边玩边整理 (长期记忆): the turns since the 记忆簿 was last written, up to reply `nodeId`, noted down
   * once there are `every` of them (`force`: one is enough), as a snapshot on that reply. Runs on its
   * own (the turn is in already); a reply that is gone by then gets nothing.
   * @returns whether it wrote one; failures are kept for the page (tidyError), never thrown.
   */
  async function tidyMemory(chatId, nodeId, { force = false, onStart = () => {} } = {}) {
    if (tidying.has(chatId)) return false
    const controller = new AbortController()
    tidying.set(chatId, { controller, nodeId })
    let started = false
    try {
      const settings = await store.getSettings()
      if (!settings.memory.enabled || (!force && !settings.memory.tidy.enabled)) return false
      const chat = await store.getChat(chatId)
      const node = chat.nodes[nodeId]
      if (node?.role !== 'assistant') return false
      const path = pathTo(chat, nodeId)
      const snapshot = memoryOf(path)
      const total = storyTurns(path)
      const since = Math.min(snapshot?.turns ?? 0, total)
      if (total - since < (force ? 1 : settings.memory.tidy.every)) return false
      // Behind by more than one tidy reads (tidies that failed, 边玩边整理 off for a while): the oldest not yet read,
      // and the snapshot says how far it got, so the next replies go on from there. Taking the latest instead left the
      // turns between out of the book for good. The first tidy of a long story takes its latest turns.
      const unread = turnTexts(path).filter(item => item.turn > since)
      const behind = Boolean(snapshot) && unread.length > TIDY_FIRST_MAX
      const turns = behind ? unread.slice(0, TIDY_FIRST_MAX) : unread.slice(-TIDY_FIRST_MAX)
      if (!turns.length) return false
      const readTo = behind ? turns.at(-1).turn : total
      started = true
      tidyErrors.delete(chatId)
      onStart()
      const entries = snapshot?.entries ?? []
      const { target, inContext } = await tidyTarget(chat, node, settings)
      const note = toolNote(settings, 'memory')
      const request = inContext
        ? { system: chat.systemPrompt, messages: [...(await apiMessages(chat, node)), { role: 'user', content: withNote(tidyInContext(chat.names, entries, turns.length, turns[0].user, behind ? turns.at(-1).user : null), note, chat.names) }] }
        : (({ system, user }) => withToolNote({ system, messages: [{ role: 'user', content: user }] }, replaceMacros(note, chat.names)))(tidyRequest(chat.names, entries, turns, !behind))
      const begun = Date.now()
      const result = await generateApi(target, request, controller.signal, () => {})
      await ledger?.recordTurn(chat, sideRecord(result, begun)).catch(() => {})
      const notes = parseEntries(result.reply)
      if (!notes) throw httpError(502, msg`${target.provider.name} · ${target.modelId} 没有写出记忆条目，下次到了间隔再试`)
      return await store.withChat(chatId, async () => {
        const fresh = await store.getChat(chatId).catch(() => null)
        const reply = fresh?.nodes[nodeId]
        if (!reply) return false
        const freshPath = pathTo(fresh, nodeId)
        // On what is there now: the player may have edited the book meanwhile.
        const base = memoryOf(freshPath)?.entries ?? []
        const place = placeEntries(turnTexts(freshPath), { from: turns[0].turn, to: turns.at(-1).turn })
        reply.memory = snapshotOf(mergeEntries(base, notes, { locate: place }), { turns: readTo, model: result.model, by: 'tidy' })
        await store.saveChat(fresh)
        return true
      })
    } catch (error) {
      if (!controller.signal.aborted && started) tidyErrors.set(chatId, friendlyError(error.message, subscription))
      return false
    } finally {
      tidying.delete(chatId)
    }
  }

  /**
   * 自动压缩: before a new turn, a story past the threshold for the chat's model (context.mjs)
   * is compacted first. Failing that, the turn goes on as it is (it may still fit); the page
   * hears either way.
   * @returns the chat compacted, or null
   */
  async function compactBeforeTurn(chat, parent, abortController, emit) {
    const settings = await store.getSettings()
    if (!settings.compaction.auto || parent.hidden || compactBlock(chat, pathTo(chat, parent.id))) return null
    const used = contextUsed(parent)
    const ref = modelFor(chat, settings)
    const window = windowOf(ref, { settings, learned: await store.getModelContext() }).tokens
    const threshold = thresholdFor(window, settings.compaction)
    if (!used || used < threshold) return null
    emit({ type: 'compacting', used, threshold })
    try {
      const compacted = await compactAt(chat, parent, abortController)
      const info = compacted.nodes[parent.id].compaction
      emit({ type: 'compacted', turns: info.turns, chars: info.summary.length })
      return compacted
    } catch (error) {
      if (abortController.signal.aborted) throw error
      emit({ type: 'compact_failed', message: error.status ? error.message : friendlyError(error.message, subscription) })
      return null
    }
  }

  /**
   * A side question asked at the end of the conversation (an image prompt):
   * the chat's frozen system prompt and its history up to `nodeId`, exactly as
   * the next turn would send them, then `instruction`. The provider's prefix
   * cache therefore hits, and the model sees the whole story. The model is the
   * one that wrote that reply, else the chat's own, and must be a provider
   * (a subscription session cannot be borrowed for this).
   * @returns { text, model, usage } or null when no provider model can answer.
   */
  async function askInContext(chatId, nodeId, instruction, { maxTokens, signal, onText = () => {} } = {}) {
    const chat = await store.getChat(chatId)
    const node = chat.nodes[nodeId]
    if (!node || node.role !== 'assistant') throw httpError(404, msg`这条叙述不存在`)
    const settings = await store.getSettings()
    const providers = await store.getProviders()
    const usable = ref => isProviderRef(ref) && providers.some(p => p.id === ref.slice(0, ref.indexOf('/')))
    const ref = node.api && usable(node.model) ? node.model : usable(modelFor(chat, settings)) ? modelFor(chat, settings) : null
    if (!ref) return null
    const target = await targetFor(ref, settings)
    const history = await apiMessages(chat, node)
    // A reply that carries a compaction has no history after it: its summary and last turns stand in, as for the next turn.
    if (node.compaction) {
      const [card, preset, globalScripts, regexSets] = await Promise.all([store.getCard(chat.cardId).catch(() => null), presetFor(store, chat.presetId), store.getRegex(), store.getRegexSets()])
      instruction = `${compactionRecap(node, storyPath(pathTo(chat, node.id)), chat.names, scriptsOf(card, preset, globalScripts, regexSets, chat.regexChanges), chat)}\n\n${instruction}`
    }
    const started = Date.now()
    const result = await generateApi(target, { system: chat.systemPrompt, messages: [...history, { role: 'user', content: instruction }], maxTokens }, signal ?? new AbortController().signal, onText)
    const record = { createdAt: new Date().toISOString(), model: result.model, usage: result.tokens, timing: { totalMs: Date.now() - started, firstTokenMs: null, forked: false, api: true } }
    await ledger?.recordTurn(chat, record).catch(() => {})
    return { text: result.reply, model: result.model, usage: result.tokens, history: history.length }
  }

  /**
   * A model call a card's frame makes (Tavern Helper generate / generateRaw),
   * streamed through `onText`; nothing is written to the chat, the usage is
   * recorded. generate: the card's text as the next player turn after the
   * story, by the chat's own model when it is a provider's (its cache hits),
   * else by the helper model with the story written out. generateRaw: the card's
   * own prompt layout (frames.mjs rawRequest), by the same model.
   */
  async function frameGenerate(chatId, { raw = false, config = {} }, signal, onText) {
    if (running.has(chatId)) throw httpError(409, msg`正在生成，先停止`)
    return generateFor(await store.getChat(chatId), { raw, config, borrow: true }, signal, onText)
  }

  /**
   * frameGenerate's work on `chat` as it is: also for a card's scripts on the server (card-scripts.mjs), in the middle of
   * a turn. `borrow`: a plain generate may ask inside the chat's own conversation (askInContext); a turn under way
   * keeps its conversation to itself.
   */
  async function generateFor(chat, { raw = false, config = {}, borrow = false }, signal, onText = () => {}) {
    const chatId = chat.id
    const path = activePath(chat)
    const tip = path.at(-1)
    const input = String(config.user_input ?? '').trim()
    const maxTokens = 4000
    // The card shows what it gets back: the 屏蔽词 that change what is shown apply to it.
    const shown = async text => blockText(text, await store.getBlockWords(), { target: 'display' })
    if (borrow && !raw && tip.role === 'assistant') {
      const asked = await askInContext(chatId, tip.id, input || '继续。', { maxTokens, signal, onText })
      if (asked) return shown(asked.text)
    }
    const settings = await store.getSettings()
    const providers = await store.getProviders()
    const usable = ref => isProviderRef(ref) && providers.some(p => p.id === ref.slice(0, ref.indexOf('/')))
    const ref = [modelFor(chat, settings), settings.media?.helperModel, settings.model].find(usable)
    if (!ref) throw httpError(400, msg`卡片界面调用模型要用供应商的模型：在顶栏选一个，或在「配图与朗读」里选一个辅助模型`)
    const target = await targetFor(ref, settings)
    // The story as plain turns: the opening as the player's first message, so every model takes it.
    const story = []
    for (const node of withoutHidden(storyPath(path))) {
      const text = String(node.role === 'user' ? node.text : node.display ?? node.text ?? '').trim()
      if (!text) continue
      const role = node.id === 'root' || node.id === 'opening' ? 'user' : node.role
      const content = node.id === 'root' || node.id === 'opening' ? `（开场）\n${text}` : text
      if (story.at(-1)?.role === role) story.at(-1).content += `\n\n${content}`
      else story.push({ role, content })
    }
    let request
    if (raw) {
      const card = await store.getCard(chat.cardId)
      const persona = playerOf(card, (await chatPicks(store, chat, card)).persona, chat.names.user)
      request = { ...rawRequest({ card, persona, history: story, config }), maxTokens }
    } else {
      const messages = story.slice(-20)
      if (messages.at(-1)?.role === 'user') messages.at(-1).content += `\n\n${input || '继续。'}`
      else messages.push({ role: 'user', content: input || '继续。' })
      if (messages[0]?.role === 'assistant') messages.shift()
      request = { system: chat.systemPrompt, messages, maxTokens }
    }
    const started = Date.now()
    const result = await generateApi(target, request, signal, onText)
    await ledger?.recordTurn(chat, { createdAt: new Date().toISOString(), model: result.model, usage: result.tokens, timing: { totalMs: Date.now() - started, firstTokenMs: null, forked: false, api: true } }).catch(() => {})
    return shown(result.reply)
  }

  /**
   * Edit a message on the active path. An API history is rebuilt from the chat
   * on the next turn; a subscription session keeps its own copy, which the
   * backend updates. From that message on the next turn writes the cache again.
   * @returns { chat, unchanged?, behindCompaction?, sessions?, missed?, promptMissed? }
   */
  function editMessage(chatId, nodeId, text) {
    return store.withChat(chatId, () => editMessageNow(chatId, nodeId, text))
  }

  async function editMessageNow(chatId, nodeId, text) {
    if (running.has(chatId)) throw httpError(409, msg`正在生成，先停止`)
    const chat = await store.getChat(chatId)
    // Templates in the new text run once, as a new message's do; the turn's variables stay as they were.
    const next = hasEjs(text) && chat.nodes[nodeId] ? (await renderAtNode(chat, nodeId, [String(text)], { runType: 'render_permanent' })).texts[0] : text
    // The input as its turn sent it (buildPrompt: the card's prompt-side regex at depth 0, then macros).
    const [card, preset, globalScripts, regexSets] = await Promise.all([store.getCard(chat.cardId).catch(() => null), presetFor(store, chat.presetId), store.getRegex(), store.getRegexSets()])
    const scripts = scriptsOf(card, preset, globalScripts, regexSets, chat.regexChanges)
    const macros = input => replaceMacros(input, chat.names)
    const sentInput = input => macros(applyScripts(input, scripts, { placement: PLACEMENT.USER_INPUT, target: 'prompt', depth: 0, macros }))
    const edit = editChatMessage(chat, nodeId, next, { sentInput })
    if (edit.unchanged) return { chat, unchanged: true }
    const { sessions, missed } = subscription
      ? await subscription.editTranscripts({ chat, node: edit.node, edit, path: activePath(chat) })
      : { sessions: null, missed: false }
    await store.saveChat(chat)
    return { chat, behindCompaction: edit.behindCompaction, sessions, missed, promptMissed: edit.promptMissed }
  }

  /**
   * The state as the chat's card's schema makes it, as { state, problem } (keepToSchema). A card
   * imported before schemas were kept has its script in its picture only: read from there once.
   * Variables at the top the rules do not name stay when the chat had them `before` this turn, or its lorebooks start
   * with them (one attached beside the card since), or (`keepAll`) they were written by hand in the 状态 panel.
   */
  async function keptToSchema(chat, state, read = null, { before = null, keepAll = false } = {}) {
    const card = await cardWithSchema(chat.cardId, read)
    if (!card?.mvuSchema) return { state }
    const keep = new Set(Object.keys((keepAll ? state : before) ?? {}))
    if (!keepAll) {
      const books = await booksForCard(store, card, await store.getSettings(), chat).catch(() => [])
      for (const key of Object.keys(initialState(books))) keep.add(key)
    }
    return keepToSchema(card.mvuSchema, state, [...keep])
  }

  /**
   * The card with its mvuSchema filled in from its picture if it had none yet; checks no state. One imported while
   * schemas were held to 300 KB kept none of a bigger one: read once more (once a run, in case it is still too big).
   */
  async function cardWithSchema(cardId, read = null) {
    // The card as the caller just read it (a turn reads it once for its scripts and its rules).
    const card = read?.id === cardId ? read : await store.getCard(cardId).catch(() => null)
    if (!card) return null
    const missed = card.mvuSchema === '' && card.helperList?.some(script => script.kind === 'schema' && script.on) && !schemaReread.has(card.id)
    if (missed) schemaReread.add(card.id)
    if (typeof card.mvuSchema !== 'string' || missed) {
      const picture = card.hasAvatar ? await readFile(store.avatarPath(card.id)).catch(() => null) : null
      const raw = picture ? rawOfPicture(picture) : null
      card.mvuSchema = schemaScript((raw?.data ?? raw)?.extensions)
      await store.saveCard(card)
    }
    return card
  }

  /**
   * Whether a reply of an MVU card came without an <UpdateVariable> block that could be read (what 补写变量 is for).
   * One stopped at a roll or a fight was told to leave it for the reply after.
   */
  async function missesUpdate(chat, node) {
    if (!node || node.role !== 'assistant' || node.gate || (hasUpdateBlock(node.text) && !node.updateUnread)) return false
    return asksUpdate(chat, await store.getSettings())
  }

  /** Whether the card's replies end in a variable update block. */
  async function asksUpdate(chat, settings) {
    const [card, preset] = await Promise.all([store.getCard(chat.cardId), presetFor(store, chat.presetId)])
    return usesMvu(card, await booksForCard(store, card, settings, chat), preset)
  }

  /**
   * 这轮变量没更新上 (turn-vars.mjs): what went wrong with the variables of a reply's update block, [] when nothing
   * did or it has none (补写变量 is for that). Never fails the turn: what cannot be worked out is not told.
   * @param keepFrom - the variables the chat had before the turn (keptToSchema's `before`)
   */
  async function varIssuesOf(chat, read, { before, text, written, kept, scripted, keepFrom }) {
    if (!hasUpdateBlock(text)) return []
    try {
      const card = await cardWithSchema(chat.cardId, read)
      const books = card ? await booksForCard(store, card, await store.getSettings(), chat).catch(() => []) : []
      const initial = initialState(books)
      const keep = [...new Set([...Object.keys(keepFrom ?? {}), ...Object.keys(initial)])]
      const check = card?.mvuSchema ? async state => keepToSchema(card.mvuSchema, state, keep).problem : null
      return await turnVarIssues({ before, text, written, kept, check, scripted, initial })
    } catch {
      return []
    }
  }

  /**
   * 补写变量: the latest reply of an MVU card came without its <UpdateVariable>
   * block. Asked inside the conversation when a provider wrote it (the same
   * prefix and history, so the cache hits), else of the helper model with the
   * card's variable rules, the variables and the reply. The block is appended
   * to the reply (as an edit, so a subscription session sees it too) and the
   * reply's state is worked out again.
   * @returns the chat.
   */
  function fillUpdate(chatId, nodeId) {
    return rewriteUpdate(chatId, nodeId, 'fill')
  }

  /**
   * 修好这轮变量: the latest reply's update block written again by the model, whole, told what the program found wrong
   * with it (its varIssues; with none it checks the block against the story: 核对这轮变量). The new block takes the
   * old one's place and the reply's state is worked out again; what it was before is kept for 撤销修复.
   * @returns the chat.
   */
  function fixUpdate(chatId, nodeId) {
    return rewriteUpdate(chatId, nodeId, 'fix')
  }

  async function rewriteUpdate(chatId, nodeId, mode) {
    const fixing = mode === 'fix'
    if (running.has(chatId)) throw httpError(409, msg`正在生成，先停止`)
    const abortController = new AbortController()
    running.set(chatId, abortController)
    try {
      const chat = await store.getChat(chatId)
      const path = activePath(chat)
      const node = path.at(-1)
      if (!node || node.id !== nodeId || node.role !== 'assistant' || node.id === 'root') throw httpError(400, fixing ? msg`只能修最新一条回复的变量` : msg`只能给最新一条回复补写变量`)
      // Its text is in the summary now, and a compaction point is not edited (editMessage).
      if (node.compaction) throw httpError(400, fixing ? msg`这条回复已经压缩进剧情存档，不能再改变量` : msg`这条回复已经压缩进剧情存档，不能再补写变量`)
      const readable = hasUpdateBlock(node.text) && !node.updateUnread
      if (!fixing && readable) throw httpError(400, msg`这条回复已经有变量更新了`)
      if (fixing && !readable) throw httpError(400, msg`这条回复没有能读的变量更新，用「补写变量」`)
      const [settings, card, preset] = await Promise.all([store.getSettings(), store.getCard(chat.cardId), presetFor(store, chat.presetId)])
      const books = await booksForCard(store, card, settings, chat)
      if (!usesMvu(card, books, preset)) throw httpError(400, msg`这张卡不用 MVU 变量`)
      // As the turn worked it out: from the reply it continued (the player's message sits in between),
      // with what that turn's templates wrote.
      const turn = chat.nodes[node.parent]
      const before = applyWrites(chat.nodes[turn?.parent]?.state ?? {}, [...(turn?.templateWrites ?? []), ...(turn?.gameWrites ?? [])])
      const lines = fixing ? issueLines(node.varIssues) : []
      const started = Date.now()
      let answer = await askInContext(chatId, nodeId, fixing ? fixInstruction({ lines, state: before }) : fillInstruction(), { maxTokens: FILL_MAX_TOKENS, signal: abortController.signal })
      if (!answer) {
        // A subscription session cannot be borrowed: the helper model gets what it needs to work it out.
        const ref = [settings.media?.helperModel, settings.model].find(r => isProviderRef(r))
        if (!ref) throw httpError(400, fixing ? msg`修好变量要用供应商的模型（这条回复不是供应商模型写的，借不了它的上下文）：在顶栏选一个供应商的模型，或在「配图与朗读」里选一个辅助模型` : msg`补写变量要用供应商的模型（这条回复不是供应商模型写的，借不了它的上下文）：在顶栏选一个供应商的模型，或在「配图与朗读」里选一个辅助模型`)
        const target = await targetFor(ref, settings)
        const session = templateSession({ state: before, names: chat.names, books, messages: activePath(chat).filter(item => !item.deleted).map(item => ({ role: item.role, text: item.text ?? '' })) })
        let request
        try {
          const asked = { books, render: entry => renderEntry(entry, { state: before, names: chat.names, session }).text, state: before, reply: node.display ?? node.text, maxTokens: FILL_MAX_TOKENS }
          request = fixing ? fixRequest({ ...asked, blocks: updateBlocks(node.text), lines }) : fillRequest(asked)
        } finally {
          session.dispose()
        }
        const result = await generateApi(target, request, abortController.signal, () => {})
        await ledger?.recordTurn(chat, { createdAt: new Date().toISOString(), model: result.model, usage: result.tokens, timing: { totalMs: Date.now() - started, firstTokenMs: null, forked: false, api: true } }).catch(() => {})
        answer = { text: result.reply, model: result.model }
      }
      const block = extractUpdate(answer.text)
      if (!block) throw httpError(502, msg`模型没有写出变量更新块，可以再试一次`)
      return await store.withChat(chatId, async () => {
        const fresh = await store.getChat(chatId)
        const was = fresh.nodes[nodeId]
        // An earlier fix goes in with it: each 撤销 steps back one.
        const kept = fixing ? structuredClone({ text: was.text, state: was.state, stateChanges: was.stateChanges, varIssues: was.varIssues, schemaProblem: was.schemaProblem, updateUnread: was.updateUnread, varFix: was.varFix }) : null
        const edit = editChatMessage(fresh, nodeId, fixing ? `${withoutUpdateBlocks(was.text)}\n\n${block}` : `${was.text.trimEnd()}\n\n${block}`)
        await settleUpdate(fresh, edit.node, card, before, turn)
        if (fixing) {
          const changed = stateDiff(kept.state, edit.node.state)
          edit.node.varFix = { at: new Date().toISOString(), model: answer.model ?? null, text: edit.node.text, changed: changed.slice(0, 6), count: changed.length, before: kept }
        } else {
          edit.node.filledUpdate = { at: new Date().toISOString(), model: answer.model ?? null }
        }
        if (subscription) await subscription.editTranscripts({ chat: fresh, node: edit.node, edit, path: activePath(fresh) })
        return store.saveChat(fresh)
      })
    } catch (error) {
      if (abortController.signal.aborted) throw httpError(499, fixing ? msg`已停止修复` : msg`已停止补写`)
      throw error
    } finally {
      running.delete(chatId)
    }
  }

  /** A reply's state worked out again from its text, as its turn did (after 补写变量 or 修好), on `node` itself. */
  async function settleUpdate(chat, node, card, before, turn) {
    const scripted = await cardScripts.update(card, chat, { before, text: node.text, path: pathTo(chat, turn?.id ?? 'root') })
    const { state, changes, unread } = keepReadOnly(before, scripted ?? applyStateUpdates(before, node.text), card?.readOnly)
    if (unread) node.updateUnread = true
    else delete node.updateUnread
    // The reply's own template writes land after its update blocks again.
    const written = applyWrites(state, node.templateWrites)
    const kept = await keptToSchema(chat, written, null, { before })
    node.state = kept.state
    if (kept.problem) node.schemaProblem = kept.problem
    else delete node.schemaProblem
    const issues = await varIssuesOf(chat, card, { before, text: node.text, written, kept, scripted: Boolean(scripted), keepFrom: before })
    if (issues.length) node.varIssues = issues
    else delete node.varIssues
    node.stateChanges = [...new Set([...writeLabels(turn?.templateWrites), ...changes, ...writeLabels(node.templateWrites)])]
  }

  /**
   * 撤销修复: the latest reply put back as it was before 修好这轮变量, while it is still as that left it.
   * @returns the chat.
   */
  function undoFix(chatId, nodeId) {
    return store.withChat(chatId, async () => {
      if (running.has(chatId)) throw httpError(409, msg`正在生成，先停止`)
      const chat = await store.getChat(chatId)
      const node = activePath(chat).at(-1)
      if (!node || node.id !== nodeId || !node.varFix?.before) throw httpError(400, msg`只能撤销最新一条回复的修复`)
      if (node.text !== node.varFix.text) throw httpError(400, msg`这条回复修好以后又改过，不能撤销了`)
      const { before } = node.varFix
      const edit = editChatMessage(chat, nodeId, before.text)
      for (const key of ['state', 'stateChanges', 'varIssues', 'schemaProblem', 'updateUnread', 'varFix']) {
        if (before[key] === undefined) delete edit.node[key]
        else edit.node[key] = before[key]
      }
      if (subscription) await subscription.editTranscripts({ chat, node: edit.node, edit, path: activePath(chat) })
      return store.saveChat(chat)
    })
  }

  /**
   * 重写选项: the latest reply's <choices> written again, its story left as it is. Asked inside the
   * conversation when a provider can answer (the next turn's prefix and history, so the cache hits), else
   * of the helper model with the last turns. The block takes the old one's place (or goes at the end) as an
   * edit, so a subscription session reads it too, and the next turn sends it back with the reply
   * (basic.mjs keepsChoices): the newest reply was never in a cached prefix, so nothing else changes.
   * @returns the chat.
   */
  async function rewriteChoices(chatId, nodeId) {
    if (running.has(chatId)) throw httpError(409, msg`正在生成，先停止`)
    const abortController = new AbortController()
    running.set(chatId, abortController)
    try {
      const chat = await store.getChat(chatId)
      const node = activePath(chat).at(-1)
      if (!node || node.id !== nodeId || node.role !== 'assistant' || node.id === 'root') throw httpError(400, msg`只能给最新一条回复重写选项`)
      if (node.compaction) throw httpError(400, msg`这条回复已经压缩进剧情存档，不能再重写选项`)
      if (!asksChoices(chat)) throw httpError(400, msg`这个对话的预设不写行动选项`)
      const previous = choicesOf(node.text)
      const started = Date.now()
      let answer = await askInContext(chatId, nodeId, choicesInstruction(chat.names.user, previous), { maxTokens: CHOICES_MAX_TOKENS, signal: abortController.signal })
      if (!answer) {
        // A subscription session cannot be borrowed: the helper model reads the last turns.
        const settings = await store.getSettings()
        const ref = [settings.media?.helperModel, settings.model].find(r => isProviderRef(r))
        if (!ref) throw httpError(400, msg`重写选项要用供应商的模型（这条回复不是供应商模型写的，借不了它的上下文）：在顶栏选一个供应商的模型，或在「配图与朗读」里选一个辅助模型`)
        const target = await targetFor(ref, settings)
        const story = withoutHidden(storyPath(activePath(chat))).slice(-6).map(item => ({ role: item.role, text: String(item.role === 'user' ? item.text : item.display ?? item.text ?? '') }))
        const request = choicesRequest({ names: chat.names, story, previous, language: settings.language || '简体中文', maxTokens: CHOICES_MAX_TOKENS })
        const result = await generateApi(target, request, abortController.signal, () => {})
        await ledger?.recordTurn(chat, { createdAt: new Date().toISOString(), model: result.model, usage: result.tokens, timing: { totalMs: Date.now() - started, firstTokenMs: null, forked: false, api: true } }).catch(() => {})
        answer = { text: result.reply, model: result.model }
      }
      const block = extractChoices(answer.text)
      if (!block) throw httpError(502, msg`模型没有写出选项，可以再试一次`)
      return await store.withChat(chatId, async () => {
        const fresh = await store.getChat(chatId)
        // A chat from before replies kept their choices: from this reply on they do.
        fresh.choicesKept ??= fresh.nodes[nodeId].createdAt
        const edit = editChatMessage(fresh, nodeId, withChoices(fresh.nodes[nodeId].text, block))
        if (edit.unchanged) return fresh
        edit.node.rewroteChoices = { at: new Date().toISOString(), model: answer.model ?? null }
        if (subscription) await subscription.editTranscripts({ chat: fresh, node: edit.node, edit, path: activePath(fresh) })
        return store.saveChat(fresh)
      })
    } catch (error) {
      if (abortController.signal.aborted) throw httpError(499, msg`已停止重写选项`)
      throw error
    } finally {
      running.delete(chatId)
    }
  }

  /** The exact user message a turn would send, without calling the model. */
  /**
   * What the 游戏规则 bring to a new turn, or null with them off. A roll is made here: for the choice the
   * player sent (`game.check`), or for the reply this turn settles (`game.settle`), which needs no words
   * from the player: the turn's input is then the roll in a line. A fight taken from the choices settles
   * the same way (`game.choice`), with the choice as the player's words.
   */
  async function gameTurn(chat, parent, input, game) {
    const book = await rulebooks?.read(chat.cardId).catch(() => null)
    if (!rulesOn(book)) return null
    const before = sheetOf(book, sheetOnPath(pathTo(chat, parent.id)), parent.state)
    const queued = applyOps(before, book, cleanOps(game?.ops))
    const settling = game?.settle === true
    const fights = gateKinds(book).includes('battle')
    const choice = String(game?.choice ?? '').trim()
    const chosen = settling && !parent.gate && fights ? choiceFights(parent.text).get(choice) ?? null : null
    const gate = parent.gate ?? chosen
    if (settling && !gate) throw httpError(400, msg`这条回复没有待掷的检定`)
    const fight = settling && gate.kind === 'battle' ? settleFight(queued.sheet, book, chat, gate, chosen ? `${parent.id}:${choice}` : parent.id, game.battle) : null
    const asked = fight ? null : settling ? gate : cleanCheck(game?.check)
    const check = asked ? rollCheck(queued.sheet, book, asked, chat.id, parent.id, settling ? '' : String(input ?? '').trim()) : null
    const earned = check ? checkExperience(book, check) : 0
    // 历练: a roll that came off leaves its mark on the attribute, with the experience or without.
    const practice = check ? checkPractice(queued.sheet, book, asked, check) : null
    const settled = fight?.op ?? (earned || practice ? { op: 'grow', experience: earned, ...(practice ?? {}) } : null)
    const { sheet, ops, lines } = settled ? applyOps(queued.sheet, book, [settled]) : { ...queued, ops: [], lines: [] }
    const done = [...queued.ops, ...ops]
    const own = game?.own === true && !settling && !check
    const wantsFight = fights && !settling && !check && asksForFight(input)
    return {
      sheet,
      rank: fights ? rankNow(sheet, book) : '',
      ranks: fights ? book.ranks : [],
      check,
      battle: fight?.battle ?? null,
      ops: done,
      lines: [...queued.lines, ...lines],
      writes: [...opWrites(book, parent.state, before, sheet, done), ...formWrites(book, parent.state, before, sheet)],
      bound: Object.keys(book.bindings),
      auto: settling && !chosen,
      input: chosen ? null : fight ? fightLine(fight.battle) : settling ? checkLine(check) : null,
      pausing: pausesOn(book, ownPreset(chat)),
      fights,
      fightRate: book.fightRate,
      // Those with a picture first: they are the ones the story should call by the bestiary's names.
      foes: Object.keys(book.foes).sort((a, b) => Boolean(book.foes[b].file) - Boolean(book.foes[a].file)),
      wantsFight,
      mayFight: fights && own && !wantsFight && mayAskForFight(input),
      own,
      safe: game?.safe === true && !settling,
      spot: `${chat.id}:${parent.id}`,
      companions: Object.keys(book.companions ?? {}).length > 0,
      words: book.words ?? {},
      perks: perksOn(book) ? (sheet.perks ?? []).map(key => perkOf(book, key)?.name).filter(Boolean) : [],
      grows: growsOn(book),
      gear: growsOn(book) ? Object.values(sheet.gear ?? {}) : [],
      forms: formsTold(sheet, book),
      lead: book.lead === 'command' && fieldedOf(sheet).length > 0,
      tame: book.tame === true,
    }
  }

  /** The fight a reply stopped on or offered (`spot` tells them apart), as the page reports it, played through again here. */
  function settleFight(sheet, book, chat, gate, spot, report) {
    const fight = cleanFight(report)
    if (!fight) throw httpError(400, msg`这场战斗的记录对不上，重打一次吧`)
    try {
      return fightResult(encounterSetup(sheet, book, gate, chat.id, spot), fight)
    } catch {
      throw httpError(400, msg`这场战斗的记录对不上，重打一次吧`)
    }
  }

  /** Which model sideCall would use: its ref (undefined: none of them is a provider's). */
  async function sideRef(chat, preferred) {
    const [settings, providers] = await Promise.all([store.getSettings(), store.getProviders()])
    const usable = ref => isProviderRef(ref) && providers.some(p => p.id === ref.slice(0, ref.indexOf('/')))
    const ref = [preferred, settings.media?.helperModel, chat && modelFor(chat, settings), settings.model].find(usable)
    return { ref, settings, providers }
  }

  /** The same for the page: { ref, label, from: 'preferred' | 'helper' | 'other' }, or null. */
  async function sideModel(chat, preferred) {
    const { ref, settings, providers } = await sideRef(chat, preferred)
    if (!ref) return null
    return { ref, label: refLabel(ref, providers) ?? ref, from: ref === preferred ? 'preferred' : ref === settings.media?.helperModel ? 'helper' : 'other' }
  }

  /**
   * A model call beside the story on a provider's model: `preferred` when it is one still there, else the helper
   * (配图与朗读), the chat's own, the default. Its usage goes on the chat's. → { text, model, usage }
   * @param missing - what to say when none of them is a provider's.
   */
  async function sideCall(chat, preferred, request, { signal, onText = () => {}, group = 'helper', missing = null } = {}) {
    const { ref, settings } = await sideRef(chat, preferred)
    if (!ref) throw httpError(400, missing ?? msg`这里要用供应商的模型：在顶栏选一个，或在「配图与朗读」里选一个辅助模型`)
    const begun = Date.now()
    const result = await generateApi(await targetFor(ref, settings), withToolNote(request, toolNote(settings, group)), signal ?? new AbortController().signal, onText)
    if (chat) await ledger?.recordTurn(chat, sideRecord(result, begun)).catch(() => {})
    return { text: result.reply, model: result.model, usage: result.tokens }
  }

  // 辅助模型判断: chat id → the look under way (the tests wait on it).
  const plotJudges = new Map()

  /**
   * 剧本, 辅助模型判断 (plans/22 十三·3): the helper reads the last turns and says how far the scene has come; its word
   * stands as the mark of reply `nodeId`, the progress worked out again. Only while that reply is still where it was
   * and no turn is being written; a reply written again later is judged again by its own count.
   */
  async function judgePlot(chatId, nodeId) {
    const chat = await store.getChat(chatId)
    const node = chat.nodes[nodeId]
    const userNode = chat.nodes[node?.parent]
    const copy = chat.plot?.copy
    if (!node?.plot || !copy || node.plot.of !== copy.id || userNode?.plotSent?.of !== copy.id) return null
    const baseOf = now => applySet(copy, progressOn(copy, withoutHidden(pathTo(now, userNode.parent)), now.plot.start), userNode.plotSet?.of === copy.id ? userNode.plotSet : null)
    const story = chatMaterial(withoutHidden(pathTo(chat, nodeId)), { turns: (chat.plot.judge?.every ?? 3) + 1, budget: 12000 })
    const answer = await sideCall(chat, null, judgeRequest(copy, baseOf(chat), userNode.plotSent, story), { missing: msg`辅助模型判断要用供应商的模型：在「配图与朗读」里选一个辅助模型，或在顶栏选一个供应商的模型` })
    const mark = readJudge(answer.text)
    if (!mark) return null
    return store.withChat(chatId, async () => {
      if (running.has(chatId)) return null
      const now = await store.getChat(chatId)
      const target = now.nodes[nodeId]
      if (!target?.plot || now.plot?.copy?.id !== copy.id) return null
      const base = baseOf(now)
      const facts = {
        state: target.state,
        check: userNode.check ? (userNode.check.tier === 'fail' ? 'fail' : 'pass') : null,
        battle: userNode.battle?.over === 'won' ? 'won' : userNode.battle?.over === 'lost' || userNode.battle?.over === 'fled' ? 'lost' : null,
      }
      const next = { ...applyMark(copy, base, mark, userNode.plotSent, { whole: !target.gate && !target.api?.truncated, facts, judged: true }), judged: true, wait: 0 }
      if (next.ended && !base.ended && await noteEnding(store, now.cardId, copy.id, sceneOf(copy, next.at)).catch(() => false)) next.first = true
      target.plot = next
      await store.saveChat(now)
      return next
    })
  }

  /** A small request about the rules, on the helper model, kept on the books like the rest. → the answer's text */
  async function askAboutRules(chat, request) {
    return (await sideCall(chat, null, request, { missing: msg`物品归类要用供应商的模型：在顶栏选一个，或在「配图与朗读」里选一个辅助模型` })).text
  }

  /** A card's rules laid out from what it says: `chatId` for the variables of a story with it, if any. Nothing is kept until the player takes it. */
  async function suggestRules(cardId, chatId) {
    const card = await store.getCard(cardId)
    const chat = chatId ? await store.getChat(chatId) : null
    const paths = variablePaths(chat ? activePath(chat).findLast(node => node.role === 'assistant')?.state : null)
    const found = parseSuggestion(await askAboutRules(chat, suggestRequest(card, paths)), paths)
    if (!found) throw httpError(502, msg`辅助模型的回答读不出来，再试一次`)
    return found
  }

  /** What things do, for a card's rule book: one small request for all of them. */
  async function sortThings(chatId, things, options = {}) {
    return parseThings(await askAboutRules(await store.getChat(chatId), thingsRequest(things, options)), things)
  }

  /** What foes look like and do, for the 敌人图鉴: one small request, with the reply that brought them on. */
  async function describeFoes(chatId, names) {
    const chat = await store.getChat(chatId)
    const story = activePath(chat).filter(node => node.role === 'assistant').at(-1)?.display ?? ''
    // 类型克制: on a card with types, each foe is given one of them.
    const types = Object.keys((await rulebooks?.read(chat.cardId).catch(() => null))?.types ?? {})
    return parseFoes(await askAboutRules(chat, foesRequest(names, String(story).slice(-800), types)), names, types)
  }

  async function previewTurn(chatId, { parentId, input, marks = false }) {
    const chat = await store.getChat(chatId)
    const parent = chat.nodes[parentId]
    if (!parent || parent.role !== 'assistant') throw httpError(400, msg`只能在一条叙述之后继续`)
    const rules = await gameTurn(chat, parent, input, null)
    let prepared = await preparePrompt(chat, parent, String(input ?? ''), { marks, rules })
    const api = isProviderRef(modelFor(chat, prepared.settings))
    const inPlace = subscription?.inPlace(chat, parent) ?? false
    if (prepared.shouldCompact && (api || inPlace)) prepared = await preparePrompt(chat, parent, String(input ?? ''), { forceFull: true, marks, rules })
    // The 预填 goes on its own, as the reply's start: shown after the message, said so.
    const shown = prepared.prefill ? `${prepared.prompt}\n\n${msg`【预填：作为模型回复的开头发送；模型不接受时附在这条消息后面】`}\n${prepared.prefill}` : prepared.prompt
    return { prompt: blockSent(shown, await store.getBlockWords()), injected: prepared.injectedTitles, templateErrors: prepared.templateErrors }
  }

  /**
   * 屏蔽词 changed from `before` to `after`: what chat `chatId` sends differently
   * on its next turn, so where its cache is written again.
   * @returns { system, turnsAgo, subscription } — system: the frozen prefix changes (all of
   *   it is written again); turnsAgo: the history changes from that many turns back (0 the
   *   latest), null when it stays; subscription: the chat's model keeps its own session,
   *   whose earlier turns keep what was sent then.
   */
  async function blockImpact(chatId, before, after) {
    const [chat, settings] = await Promise.all([store.getChat(chatId), store.getSettings()])
    const changed = text => blockSent(text, before) !== blockSent(text, after)
    const subscription = !isProviderRef(modelFor(chat, settings))
    const tip = activePath(chat).at(-1)
    let turnsAgo = null
    if (!subscription && tip?.role === 'assistant') {
      const history = await apiMessages(chat, tip)
      const index = history.findIndex(message => changed(message.content))
      const turnOf = end => history.slice(0, end + 1).filter(message => message.role === 'user').length
      if (index >= 0) turnsAgo = turnOf(history.length - 1) - turnOf(index)
    }
    return { system: changed(chat.systemPrompt), turnsAgo, subscription }
  }

  return {
    runTurn,
    // 辅助模型判断 under way for a chat, if any (a promise of the progress it wrote).
    plotJudging: chatId => plotJudges.get(chatId) ?? null,
    compactChat,
    askInContext,
    sideCall,
    sideModel,
    frameGenerate,
    fillUpdate,
    fixUpdate,
    undoFix,
    missesUpdate,
    keptToSchema,
    cardScripts,
    cardWithSchema,
    rewriteChoices,
    previewTurn,
    sortThings,
    suggestRules,
    describeFoes,
    blockImpact,
    editMessage,
    renderForDisplay,
    stop(chatId) {
      const controller = running.get(chatId)
      if (!controller) return false
      controller.abort()
      return true
    },
    isRunning: chatId => running.has(chatId),
    tidyMemory,
    // 边玩边整理 under way, its last failure, and stopping it.
    isTidying: chatId => tidying.has(chatId),
    tidyError: chatId => tidyErrors.get(chatId) ?? null,
    cancelTidy(chatId) {
      const job = tidying.get(chatId)
      job?.controller.abort()
      return Boolean(job)
    },
    // Requests a compaction under way has sent (第 N 段), 0 when none is.
    compactProgress: chatId => compacting.get(chatId) ?? 0,
    busy: () => running.size > 0,
    rateLimit: () => subscription?.rateLimit() ?? null,
    lastInit: () => subscription?.lastInit() ?? null,
  }
}
