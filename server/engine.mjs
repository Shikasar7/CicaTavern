// One RP turn through a model provider's API (model `<provider>/<model>`, see
// providers.mjs). The history is rebuilt from the chat tree on every turn
// (apiMessages), byte-identical to what was sent before, so the provider's
// prefix cache hits.
// Other model references go to an optional backend passed in as `subscription`
// (this machine's own install: server/subscription/); without one they are refused.
import { activePath, booksForCard, editMessage as editChatMessage, pathTo, playerOf, presetFor, scriptsOf, selectNode } from './chats.mjs'
import { hasPrefixRules, renderPresetTail } from './presets.mjs'
import { buildTurnPrompt, everyTurnReminder, renderEntry, replaceMacros } from './prompt.mjs'
import { applyStateUpdates, displayText } from './state.mjs'
import { httpError, newId } from './store.mjs'
import { dynamicEntries, triggeredEntries } from './worldbook.mjs'
import { applyScripts, depthWindow, PLACEMENT } from '../web/shared/regex.js'
import { replaceVariableMacros } from '../web/shared/vars.js'
import { accumulatedDynamic, compactThreshold, dynamicMemory, planDynamic, stripDynamicText } from './dynamic.mjs'
import { complete, CONTEXT_FULL, isProviderRef, providerError, resolveRef } from './providers.mjs'
import { canonicalModel } from './models.mjs'
import { extractSummary, MIN_TURNS, recapBlock, recentExchanges, storyPath, storyTurns, summaryInstruction, turnsSinceCompaction } from './recap.mjs'
import { msg } from './i18n.mjs'
import { extractUpdate, fillInstruction, fillRequest, hasUpdateBlock, usesMvu } from './mvu.mjs'

// The preset's per-turn block in a turn's message (buildTurnPrompt).
const PRESET_BLOCK = /\n*<预设指令>\n[\s\S]*?\n<\/预设指令>/

// Output tokens a story turn may ask for at most (presets often say 65535): enough for any
// reply with its thinking and status blocks, and within what current Claude models accept.
const MAX_REPLY_TOKENS = 32000
// 补写变量: a big card's update block (many fields, its analysis) fits in this.
const FILL_MAX_TOKENS = 4000
// An imported chat's history is summarised in parts of about this many characters (well inside 200k tokens).
const IMPORTED_PART_CHARS = 120000

/** A failure without a status in words that say what to do (the backend words its own). */
function friendlyError(message, subscription) {
  const text = String(message ?? '')
  const said = subscription?.friendlyError(text) ?? text
  if (said !== text) return said
  if (/overloaded|529/i.test(text)) return msg`模型繁忙，稍后重试。（${text.slice(0, 160)}）`
  return text
}

/**
 * @param isolation - { proxy } for provider requests (a getter: the setting can change).
 * @param ledger - usage ledger (see usage.mjs); optional in tests.
 * @param subscription - the optional backend for models without a provider (server/subscription/).
 */
export function createEngine(store, isolation, ledger = null, { subscription = null } = {}) {
  const running = new Map()

  function scanWindow(path, depth, input) {
    const recent = path.slice(-Math.max(1, depth)).map(node => (node.role === 'user' ? node.text : node.display ?? node.text))
    return [...recent, input].join('\n')
  }

  function recentRefs(path, turns) {
    const refs = new Set()
    const users = path.filter(node => node.role === 'user').slice(-Math.max(0, turns))
    for (const node of users) for (const ref of node.injected ?? []) refs.add(ref)
    return refs
  }

  /** @param marks - ask for the 视觉小说格式 this turn (the page's visual novel mode has it on). */
  async function preparePrompt(chat, parent, input, { forceFull = false, marks = false } = {}) {
    const [settings, card, preset, persona, globalScripts] = await Promise.all([store.getSettings(), store.getCard(chat.cardId), presetFor(store, chat.presetId), store.getPersona(), store.getRegex()])
    const books = await booksForCard(store, card, settings)
    const scripts = scriptsOf(card, preset, globalScripts)
    const names = chat.names
    const macros = text => replaceMacros(text, names)
    const path = pathTo(chat, parent.id)
    // Continuing from a compaction point opens a new session that has seen only
    // the frozen prefix: everything the history used to carry is sent again.
    const newSession = Boolean(parent.compaction)
    if (newSession) forceFull = true
    const state = parent.state ?? {}
    const templateErrors = []
    const render = entry => {
      const { text, error } = renderEntry(entry, { state, names })
      if (error) templateErrors.push(`${entry.comment || entry.uid}: ${error}`)
      return { title: entry.comment, text }
    }

    // A book may look further back or less far than the setting (世界书 → 扫描深度).
    const windows = new Map()
    const scanFor = book => {
      const depth = book.scanDepth || settings.scanDepth
      if (!windows.has(depth)) windows.set(depth, scanWindow(storyPath(path), depth, input))
      return windows.get(depth)
    }
    const hits = triggeredEntries(books, scanFor, newSession ? new Set() : recentRefs(path, settings.reinjectAfter))
    const dynamic = dynamicEntries(books)
    // A card that feeds its own variables through a dynamic entry
    // ({{format_message_variable::stat_data}}) does not need our state block too.
    const cardShowsState = dynamic.some(entry => /stat_data/.test(entry.content))
    const userTurns = path.filter(node => node.role === 'user').length
    const refreshState =
      !cardShowsState &&
      Object.keys(state).length > 0 &&
      (userTurns === 0 || newSession || chat.stateDirty || (settings.stateRefreshEvery > 0 && userTurns % settings.stateRefreshEvery === 0))
    // Prompt-side regex (e.g. hiding the status-bar placeholder or MVU blocks from the model).
    const opening = parent.id === 'root' && !newSession ? applyScripts(parent.text, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: 0, macros }) : ''
    const promptInput = applyScripts(input, scripts, { placement: PLACEMENT.USER_INPUT, target: 'prompt', depth: 0, macros })
    const characterNote = card.depthPrompt ? replaceMacros(replaceVariableMacros(card.depthPrompt, state), names).trim() : ''
    const presetText = preset
      ? renderPresetTail(preset, { card, persona: playerOf(card, persona, names.user), names, vars: chat.presetVars, input: promptInput, lastChar: parent.display ?? parent.text })
      : ''

    const renderedDynamic = dynamic
      .map(render)
      .filter(item => item.text)
      .map(item => (item.title ? `【${item.title}】\n${item.text}` : item.text))
      .join('\n\n')
    const plan = planDynamic({ rendered: renderedDynamic, ...dynamicMemory(path), forceFull })
    const recap = newSession
      ? recapBlock(
          parent.compaction.summary,
          recentExchanges(storyPath(path), names, ({ role, text, depth }) =>
            applyScripts(text, scripts, { placement: role === 'user' ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT, target: 'prompt', depth: depth + 1, macros }),
          ),
        )
      : ''
    const prompt = buildTurnPrompt({
      names,
      opening,
      recap,
      entries: hits.map(hit => render(hit.entry)),
      dynamic: plan.text ? [{ title: '', text: plan.text }] : [],
      characterNote,
      stateText: refreshState ? JSON.stringify(state, null, 1) : '',
      input: promptInput,
      replyLength: Number(settings.replyLength) || 0,
      presetText,
      reminder: everyTurnReminder(chat.systemPrompt, books, { presetRules: hasPrefixRules(preset), mvu: usesMvu(card, books) }),
      marks,
    })
    return {
      settings,
      prompt,
      injected: hits.map(hit => hit.ref),
      injectedTitles: hits.map(hit => hit.entry.comment || hit.entry.keys[0] || hit.entry.uid),
      templateErrors,
      // A new session holds no earlier <动态设定>, so the pile-up count restarts here.
      dynamicState: newSession ? { ...plan.state, compacted: true } : plan.state,
      shouldCompact: !forceFull && Boolean(renderedDynamic) && accumulatedDynamic(path) >= compactThreshold(path, settings.dynamicStrip),
    }
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
  async function apiMessages(chat, parent, { stripAll = false } = {}) {
    const [card, preset, globalScripts] = await Promise.all([store.getCard(chat.cardId).catch(() => null), presetFor(store, chat.presetId), store.getRegex()])
    const scripts = scriptsOf(card, preset, globalScripts)
    const macros = text => replaceMacros(text, chat.names)
    const path = pathTo(chat, parent.id)
    let start = 0
    path.forEach((node, index) => {
      if (node.compaction) start = index
    })
    const turns = path.slice(start + 1)
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
        const prompt = node.prompt ?? node.text
        return { role: 'user', content: index < stripBefore ? stripDynamicText(prompt) : prompt }
      }
      const reply = applyScripts(node.text, scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: turns.length - index, macros })
      return { role: 'assistant', content: reply.trim() || '……' }
    })
    // 'latest' preset mode: the post-history prompts ride only on the newest message, as in
    // SillyTavern. Older messages lose them, so the newest one changes next turn: the reply
    // before it is the last thing that stays put.
    const latestOnly = preset?.postMode === 'latest'
    if (latestOnly) {
      for (const message of messages) if (message.role === 'user') message.content = message.content.replace(PRESET_BLOCK, '')
    }
    const settled = Math.min(window >= 0 ? turns.length - window - 1 : Infinity, latestOnly ? messages.length - 1 : Infinity)
    // Only this one mark in the history. Measured on two Claude relays (2026-10-08): with a
    // second message-level mark besides the newest message they bill the history about twice
    // and lose the cache between turns; with only the system prompt and the newest message
    // marked they count and cache normally.
    if (Number.isFinite(settled) && settled >= 0) messages[settled].cache = true
    return messages
  }

  /**
   * The story archive from an API history. When the whole history no longer fits
   * the model's context, the older half is archived first and the newer half is
   * then archived on top of it (halving again as often as needed).
   * @param carry - an archive of what came before `history`, or ''
   */
  /**
   * The archive of `history`, in parts when it does not fit: each part's archive
   * is carried into the next. A history longer than `maxChars` is cut before it
   * is sent (an imported one has no cache to read from, and a refused request
   * would only be sent again in halves).
   */
  async function summarizeInParts(target, chat, history, signal, carry = '', depth = 0, { maxChars = Infinity } = {}) {
    const instruction = { role: 'user', content: summaryInstruction(chat.names) }
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
        return await generateApi(target, { system: chat.systemPrompt, messages: [...lead, ...history, instruction] }, signal, () => {})
      } catch (error) {
        if (!CONTEXT_FULL.test(error.message) || history.length < 4 || depth >= 4) throw error
      }
    }
    // Cut at a user message near the middle: each part reads as a conversation of its own.
    let cut = Math.floor(history.length / 2)
    while (cut < history.length && history[cut].role !== 'user') cut++
    if (cut >= history.length) cut = history.length - 2
    const plain = history.map(({ role, content }) => ({ role, content }))
    const older = await summarizeInParts(target, chat, plain.slice(0, cut), signal, carry, depth + 1, { maxChars })
    const archive = extractSummary(older.reply)
    if (archive.length < 200) throw httpError(502, msg`前半段的剧情存档没有写完整，这次没有压缩，可以再试一次`)
    const newer = await summarizeInParts(target, chat, plain.slice(cut), signal, archive, depth + 1, { maxChars })
    const tokens = Object.fromEntries(Object.entries(newer.tokens).map(([key, value]) => [key, typeof value === 'number' ? value + (older.tokens[key] ?? 0) : value]))
    return { ...newer, tokens }
  }

  /** One API completion with the 思考 / 努力程度 settings; provider failures become readable 502s. */
  async function generateApi(target, request, signal, onText) {
    const { thinking, effort } = await store.getSettings()
    let result
    try {
      result = await complete(target.provider, target.modelId, { ...request, reasoning: { thinking, effort }, signal, onDelta: onText }, { proxy: isolation.proxy })
    } catch (error) {
      if (signal.aborted || error.status) throw error
      throw httpError(502, providerError(target.provider, error))
    }
    if (!result.text.trim()) throw httpError(502, msg`${target.provider.name} 没有返回正文${result.stopReason ? msg`（${result.stopReason}）` : ''}`)
    const u = result.usage ?? {}
    const tokens = { input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheWrite1h: 0, cacheWrite5m: u.cacheWrite ?? 0, output: u.output ?? 0, costUsd: null }
    const api = { provider: target.provider.id, model: result.model ?? target.modelId, ...(result.truncated ? { truncated: true } : {}) }
    return { reply: result.text, model: target.model, tokens, sdk: null, api }
  }

  /**
   * A story turn's output limit: the preset's max response length, as SillyTavern sends it,
   * unless the provider sets its own. Capped, and dropped again if the model refuses it.
   */
  async function replyCap(chat, provider) {
    if (provider.maxTokens) return {}
    const preset = await presetFor(store, chat.presetId)
    const wanted = Math.floor(Number(preset?.params?.maxTokens) || 0)
    return wanted > 0 ? { maxTokens: Math.min(wanted, MAX_REPLY_TOKENS), softCap: true } : {}
  }

  /**
   * Run one turn. `emit` receives { type: 'delta', text } while streaming.
   * @param parentId - the assistant node to continue from.
   * @param userNodeId - reuse an existing user node (regenerate) instead of creating one.
   * @param marks - ask for the 视觉小说格式 (a regenerated turn keeps what it asked).
   */
  async function runTurn(chatId, { parentId, input, userNodeId, marks = false }, emit) {
    if (running.has(chatId)) throw httpError(409, msg`这个对话正在生成`)
    const abortController = new AbortController()
    running.set(chatId, abortController)
    // A failed turn on a subscription session resumed in place: the backend forgets its tip.
    let resumedInPlace = null
    try {
      const chat = await store.getChat(chatId)
      let userNode = userNodeId ? chat.nodes[userNodeId] : null
      if (userNodeId && (!userNode || userNode.role !== 'user')) throw httpError(404, msg`要重新生成的回合不存在`)
      const parent = chat.nodes[userNode ? userNode.parent : parentId]
      if (!parent || parent.role !== 'assistant') throw httpError(400, msg`只能在一条叙述之后继续`)
      const text = userNode ? userNode.text : String(input ?? '').trim()
      if (!text) throw httpError(400, msg`输入不能为空`)

      // Regenerating reuses the recorded prompt verbatim, so the fork's prefix
      // (and its worldbook injections) matches the original attempt exactly.
      let prepared = userNode
        ? { settings: await store.getSettings(), prompt: userNode.prompt, injected: userNode.injected, injectedTitles: userNode.injectedTitles }
        : await preparePrompt(chat, parent, text, { marks })
      const target = await targetFor(modelFor(chat, prepared.settings), prepared.settings)
      const newSession = Boolean(parent.compaction)
      // The turn's prompt again with the full variable list, the piled-up copies gone.
      const reprepare = async () => {
        const full = await preparePrompt(chat, parent, text, { forceFull: true, marks })
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
          prepared = await reprepare()
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
        injected: prepared.injectedTitles,
        templateErrors: prepared.templateErrors ?? [],
        trimmed,
        compacted,
      })

      const started = Date.now()
      let firstToken = 0
      const onText = delta => {
        if (!firstToken) firstToken = Date.now() - started
        emit({ type: 'delta', text: delta })
      }
      let outcome
      if (target.api) {
        const history = await apiMessages(chat, parent, { stripAll: Boolean(compacted || userNode?.dynamic?.compacted) })
        const cap = await replyCap(chat, target.provider)
        outcome = await generateApi(target, { system: chat.systemPrompt, messages: [...history, { role: 'user', content: prepared.prompt }], ...cap }, abortController.signal, onText)
      } else {
        outcome = await subscription.generate(prepared.prompt, run, { onText, onRate: info => emit({ type: 'rate_limit', info }) })
        if (!outcome.sdk) throw httpError(502, msg`模型没有返回正文`)
      }
      const reply = outcome.reply
      if (!reply.trim()) throw httpError(502, msg`模型没有返回正文`)

      // Re-read: another request may have changed selection meanwhile (not the tree).
      const fresh = await store.getChat(chatId)
      const now = new Date().toISOString()
      if (!userNode) {
        userNode = {
          id: newId(),
          parent: parent.id,
          role: 'user',
          text,
          prompt: prepared.prompt,
          injected: prepared.injected,
          injectedTitles: prepared.injectedTitles,
          templateErrors: prepared.templateErrors ?? [],
          ...(prepared.dynamicState ? { dynamic: prepared.dynamicState } : {}),
          sel: null,
          createdAt: now,
        }
        fresh.nodes[userNode.id] = userNode
      }
      const { state, changes } = applyStateUpdates(parent.state, reply)
      const node = {
        id: newId(),
        parent: userNode.id,
        role: 'assistant',
        text: reply,
        display: displayText(reply),
        state,
        stateChanges: changes,
        sdk: outcome.sdk ?? null,
        ...(outcome.api ? { api: outcome.api } : {}),
        model: outcome.model,
        usage: outcome.tokens,
        timing: { totalMs: Date.now() - started, firstTokenMs: firstToken || null, forked: fork, ...(target.api ? { api: true } : {}) },
        sel: null,
        createdAt: now,
      }
      fresh.nodes[node.id] = node
      // Also lifts a rollback on the parent: the new turn is now the visible branch.
      selectNode(fresh, node.id)
      if (!target.api) subscription.afterTurn(fresh, outcome)
      if (trimmed) fresh.nodes[parent.id].historyTrim = trimmed
      fresh.stateDirty = false
      await store.saveChat(fresh)
      await ledger?.recordTurn(fresh, node).catch(() => {})
      return { chat: fresh, nodeId: node.id }
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
   * Summarise the active path into its tip (see recap.mjs). The summary comes
   * from the model that wrote it where possible (the same provider with the
   * rebuilt history, or the subscription backend's own session), so the
   * history is read from cache; the next turn from the tip starts afresh.
   */
  async function compactChat(chatId) {
    if (running.has(chatId)) throw httpError(409, msg`这个对话正在生成`)
    const abortController = new AbortController()
    running.set(chatId, abortController)
    try {
      const chat = await store.getChat(chatId)
      const path = activePath(chat)
      const tip = path.at(-1)
      if (tip.role !== 'assistant' || (!tip.sdk && !tip.api && !tip.imported)) throw httpError(400, msg`还没有可以压缩的剧情`)
      if (turnsSinceCompaction(path) < MIN_TURNS) throw httpError(400, msg`上次压缩之后不到 ${MIN_TURNS} 轮，不用再压缩`)
      const settings = await store.getSettings()
      const target = await compactionTarget(chat, tip, settings)
      const started = Date.now()
      let used
      if (target.api) {
        used = await summarizeInParts(target, chat, await apiMessages(chat, tip), abortController.signal, '', 0, { maxChars: tip.imported ? IMPORTED_PART_CHARS : Infinity })
      } else {
        used = await subscription.compact({ chat, tip, settings, abortController, model: target.model })
      }
      const summary = extractSummary(used.reply)
      if (summary.length < 200) throw httpError(502, msg`模型没有写出完整的剧情存档，这次没有压缩，可以再试一次`)
      const now = new Date().toISOString()
      const fresh = await store.getChat(chatId)
      fresh.nodes[tip.id].compaction = { summary, turns: storyTurns(path), model: used.model, usage: used.tokens, at: now }
      await store.saveChat(fresh)
      const record = { createdAt: now, model: used.model, usage: used.tokens, timing: { totalMs: Date.now() - started, firstTokenMs: null, forked: !target.api } }
      await ledger?.recordTurn(fresh, record).catch(() => {})
      return fresh
    } catch (error) {
      if (abortController.signal.aborted) throw httpError(499, msg`已停止压缩`)
      if (!error.status) error.message = friendlyError(error.message, subscription)
      throw error
    } finally {
      running.delete(chatId)
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
  async function askInContext(chatId, nodeId, instruction, { maxTokens, signal } = {}) {
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
    const started = Date.now()
    const result = await generateApi(target, { system: chat.systemPrompt, messages: [...history, { role: 'user', content: instruction }], maxTokens }, signal ?? new AbortController().signal, () => {})
    const record = { createdAt: new Date().toISOString(), model: result.model, usage: result.tokens, timing: { totalMs: Date.now() - started, firstTokenMs: null, forked: false, api: true } }
    await ledger?.recordTurn(chat, record).catch(() => {})
    return { text: result.reply, model: result.model, usage: result.tokens, history: history.length }
  }

  /**
   * Edit a message on the active path. An API history is rebuilt from the chat
   * on the next turn; a subscription session keeps its own copy, which the
   * backend updates. From that message on the next turn writes the cache again.
   * @returns { chat, unchanged?, behindCompaction?, sessions?, missed? }
   */
  async function editMessage(chatId, nodeId, text) {
    if (running.has(chatId)) throw httpError(409, msg`正在生成，先停止`)
    const chat = await store.getChat(chatId)
    const edit = editChatMessage(chat, nodeId, text)
    if (edit.unchanged) return { chat, unchanged: true }
    const { sessions, missed } = subscription
      ? await subscription.editTranscripts({ chat, node: edit.node, edit, path: activePath(chat) })
      : { sessions: null, missed: false }
    await store.saveChat(chat)
    return { chat, behindCompaction: edit.behindCompaction, sessions, missed }
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
  async function fillUpdate(chatId, nodeId) {
    if (running.has(chatId)) throw httpError(409, msg`正在生成，先停止`)
    const abortController = new AbortController()
    running.set(chatId, abortController)
    try {
      const chat = await store.getChat(chatId)
      const path = activePath(chat)
      const node = path.at(-1)
      if (!node || node.id !== nodeId || node.role !== 'assistant' || node.id === 'root') throw httpError(400, msg`只能给最新一条回复补写变量`)
      if (hasUpdateBlock(node.text)) throw httpError(400, msg`这条回复已经有变量更新了`)
      const [settings, card] = await Promise.all([store.getSettings(), store.getCard(chat.cardId)])
      const books = await booksForCard(store, card, settings)
      if (!usesMvu(card, books)) throw httpError(400, msg`这张卡不用 MVU 变量`)
      // As the turn worked it out: from the reply it continued (the player's message sits in between).
      const before = chat.nodes[chat.nodes[node.parent]?.parent]?.state ?? {}
      const started = Date.now()
      let answer = await askInContext(chatId, nodeId, fillInstruction(), { maxTokens: FILL_MAX_TOKENS, signal: abortController.signal })
      if (!answer) {
        // A subscription session cannot be borrowed: the helper model gets what it needs to work it out.
        const ref = [settings.media?.helperModel, settings.model].find(r => isProviderRef(r))
        if (!ref) throw httpError(400, msg`补写变量要用供应商的模型（这条回复不是供应商模型写的，借不了它的上下文）：在顶栏选一个供应商的模型，或在「配图与朗读」里选一个辅助模型`)
        const target = await targetFor(ref, settings)
        const render = entry => renderEntry(entry, { state: before, names: chat.names }).text
        const result = await generateApi(target, fillRequest({ books, render, state: before, reply: node.display ?? node.text, maxTokens: FILL_MAX_TOKENS }), abortController.signal, () => {})
        await ledger?.recordTurn(chat, { createdAt: new Date().toISOString(), model: result.model, usage: result.tokens, timing: { totalMs: Date.now() - started, firstTokenMs: null, forked: false, api: true } }).catch(() => {})
        answer = { text: result.reply, model: result.model }
      }
      const block = extractUpdate(answer.text)
      if (!block) throw httpError(502, msg`模型没有写出变量更新块，可以再试一次`)
      const fresh = await store.getChat(chatId)
      const edit = editChatMessage(fresh, nodeId, `${fresh.nodes[nodeId].text.trimEnd()}\n\n${block}`)
      const { state, changes } = applyStateUpdates(before, edit.node.text)
      edit.node.state = state
      edit.node.stateChanges = changes
      edit.node.filledUpdate = { at: new Date().toISOString(), model: answer.model ?? null }
      if (subscription) await subscription.editTranscripts({ chat: fresh, node: edit.node, edit, path: activePath(fresh) })
      return await store.saveChat(fresh)
    } catch (error) {
      if (abortController.signal.aborted) throw httpError(499, msg`已停止补写`)
      throw error
    } finally {
      running.delete(chatId)
    }
  }

  /** The exact user message a turn would send, without calling the model. */
  async function previewTurn(chatId, { parentId, input, marks = false }) {
    const chat = await store.getChat(chatId)
    const parent = chat.nodes[parentId]
    if (!parent || parent.role !== 'assistant') throw httpError(400, msg`只能在一条叙述之后继续`)
    let prepared = await preparePrompt(chat, parent, String(input ?? ''), { marks })
    const api = isProviderRef(modelFor(chat, prepared.settings))
    const inPlace = subscription?.inPlace(chat, parent) ?? false
    if (prepared.shouldCompact && (api || inPlace)) prepared = await preparePrompt(chat, parent, String(input ?? ''), { forceFull: true, marks })
    return { prompt: prepared.prompt, injected: prepared.injectedTitles, templateErrors: prepared.templateErrors }
  }

  return {
    runTurn,
    compactChat,
    askInContext,
    fillUpdate,
    previewTurn,
    editMessage,
    stop(chatId) {
      const controller = running.get(chatId)
      if (!controller) return false
      controller.abort()
      return true
    },
    isRunning: chatId => running.has(chatId),
    busy: () => running.size > 0,
    rateLimit: () => subscription?.rateLimit() ?? null,
    lastInit: () => subscription?.lastInit() ?? null,
  }
}
