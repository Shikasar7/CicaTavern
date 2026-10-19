// Prompt layout. The system prompt is the stable prefix: rules, card, persona and
// constant worldbook, rendered once when a chat starts and frozen on the chat so
// every later turn hits the same prompt cache. Per-turn material (triggered and
// state-dependent worldbook, character note, state refresh, the player's input)
// only ever goes into the new user message at the tail.
//
// Claude Code caches up to the last message, so the history must only ever
// grow at the end: editing an earlier user message loses the cache for all
// that follows (measured). Material SillyTavern keeps near the end of every
// request (@depth entries, post-history rules) therefore lives in the prefix's
// last section, and each turn carries a one-line reminder naming it.
import { constantEntries, entryText, entryTitle, lateEntries } from './worldbook.mjs'
import { renderTemplate } from './template.mjs'
import { renderPresetPrefix } from './presets.mjs'
import { basicRules } from './basic.mjs'
import { replaceVariableMacros, variablesOf } from '../web/shared/vars.js'

export function replaceMacros(text, names) {
  return String(text ?? '')
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
    .replace(/\{\{char\}\}|<BOT>/gi, names.char)
    .replace(/\{\{user\}\}|<USER>/gi, names.user)
    .replace(/\{\{newline\}\}/gi, '\n')
    .replace(/\{\{trim\}\}/gi, '')
    .replace(/\{\{random(?:::|:)([^}]*)\}\}/gi, (_, body) => {
      const options = body.includes('::') ? body.split('::') : body.split(',')
      return options[Math.floor(Math.random() * options.length)]?.trim() ?? ''
    })
    .replace(/\{\{roll:?\s*(\d*)d(\d+)\}\}/gi, (_, count, sides) => {
      let total = 0
      for (let i = 0; i < (Number(count) || 1); i++) total += 1 + Math.floor(Math.random() * Number(sides))
      return String(total)
    })
}

/**
 * Render one worldbook entry against the current state: EJS in the sandbox,
 * then variable macros, then name macros. A template that fails falls back to
 * its text with the EJS removed.
 */
export function renderEntry(entry, { state, names }) {
  const rendered = renderTemplate(entry.content, { variables: variablesOf(state), names })
  const text = rendered.text ?? entryText(entry)
  return { text: replaceMacros(replaceVariableMacros(text, state), names).trim(), error: rendered.error }
}

const titled = (title, text) => (title ? `【${title}】\n${text}` : text)

const section = (title, body) => (body && body.trim() ? `## ${title}\n${body.trim()}` : '')

function stateProtocol(card, hasState) {
  const usesMvu = /_\.set\s*\(|UpdateVariable|JSONPatch/.test(
    [card.systemPrompt, card.postHistoryInstructions, ...(card.book?.entries ?? []).map(e => e.content)].join('\n'),
  )
  if (usesMvu || !hasState) return ''
  return [
    '## 状态记录',
    '<当前状态> 是游戏变量的最新值。本轮剧情让某些变量变化时，在回复末尾追加一个 <state> 块，内容是只含变化字段的 JSON（嵌套对象按层级写，值为 null 表示删除）。没有变化就不要写。示例：',
    '<state>{"好感度": 35, "位置": "后院"}</state>',
    '<state> 块不会展示给玩家，正文里不要提到它。',
  ].join('\n')
}

/**
 * The built-in narrator rules. `options`: the built-in preset's (basic.mjs),
 * whose paragraphs open the every-turn section; without them the rules read as
 * they did before that preset existed.
 */
export function buildSystemPrompt({ card, persona, settings, books, hasState, options = null }) {
  const names = { char: card.name, user: persona.name || '你' }
  const m = text => replaceMacros(text, names)
  const constants = constantEntries(books)
    .map(entry => {
      const text = m(entryText(entry))
      return text ? titled(entry.comment, text) : ''
    })
    .filter(Boolean)
    .join('\n\n')
  const authorSystem = m(card.systemPrompt.replace(/\{\{original\}\}/gi, ''))

  return [
    `你是一场互动小说的叙述者，同时扮演除玩家以外的所有角色。玩家扮演「${names.user}」。`,
    [
      '## 基本规则',
      options
        ? `- 除了「${EVERY_TURN}」一节要求的格式块，只写故事正文，不写解释、点评或任何元信息。`
        : '- 只写故事正文，不写解释、点评、选项菜单或任何元信息。',
      // With the built-in preset its 防抢话 option says this (or nothing, when it is off).
      options ? '' : `- 不替玩家决定「${names.user}」的想法、台词和行动；可以写出他的行动带来的直接结果。`,
      '- 每条玩家消息里，<玩家输入> 是玩家本轮想做的事或希望看到的发展。用你自己的叙述把它演出来，不要照抄原句，然后顺着情节自然推进。',
      '- <世界书> 和 <动态设定> 是和当前情节相关的设定资料，<当前状态> 是游戏状态的最新值，<角色备注> 是作者给本轮的提醒，<本轮提醒> 指向系统提示里每轮都要执行的规则。它们不要原样复述。',
      '- 角色按各自的人设行动和说话，可以有自己的意志，不必顺着玩家。',
      '- 篇幅随情节而定；不要重复前文已经写过的内容。',
      `- 使用${settings.language || '简体中文'}写作。`,
    ].filter(Boolean).join('\n'),
    stateProtocol(card, hasState),
    section('文风与写作要求', m(settings.writingRules)),
    section(`玩家角色：${names.user}`, m(persona.description)),
    [
      `## 角色卡：${card.name}`,
      section('描述', m(card.description)).replace(/^## /, '### '),
      section('性格', m(card.personality)).replace(/^## /, '### '),
      section('场景', m(card.scenario)).replace(/^## /, '### '),
      section('对话示例', m(card.mesExample.replace(/<START>/gi, '---'))).replace(/^## /, '### '),
    ].filter(Boolean).join('\n\n'),
    section('角色卡作者的指示', authorSystem),
    section('常驻设定', constants),
    section(EVERY_TURN, [options ? m(basicRules(options)) : '', m(card.postHistoryInstructions), lateText(books, m)].filter(t => t.trim()).join('\n\n')),
  ].filter(Boolean).join('\n\n')
}

export const EVERY_TURN = '每轮回复都要遵守'

function lateText(books, m) {
  return lateEntries(books)
    .map(entry => {
      const text = m(entryText(entry))
      return text ? titled(entry.comment, text) : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The per-turn reminder of the prefix's every-turn rules. Chats started before
 * late entries had their own section keep them elsewhere in the prefix, so the
 * entry titles alone must identify them.
 */
export function everyTurnReminder(systemPrompt, books, { presetRules = false } = {}) {
  const titles = lateEntries(books).map(entry => `【${entryTitle(entry)}】`)
  const hasSection = systemPrompt.includes(`## ${EVERY_TURN}`)
  if (!titles.length && !hasSection) return ''
  // SillyTavern sends a preset's post-history prompts right before the reply; here they sit in
  // the prefix, a long history away, and the blocks they ask for after the story get dropped.
  const preset = presetRules && hasSection ? '预设规定的输出格式和顺序（正文之后要求附加的内容块一个都不能省）' : ''
  if (!titles.length) return `本轮回复同样要遵守系统提示末尾「${EVERY_TURN}」一节的全部要求${preset ? `，尤其是${preset}` : ''}。`
  const inSection = hasSection && systemPrompt.lastIndexOf(titles[0]) > systemPrompt.lastIndexOf(`## ${EVERY_TURN}`)
  if (inSection) return `本轮回复同样要遵守系统提示末尾「${EVERY_TURN}」一节的全部要求，包括${preset ? `${preset}、` : ''}${titles.join('、')}。`
  return preset
    ? `本轮回复同样要遵守系统提示末尾「${EVERY_TURN}」一节里${preset}，以及系统提示中${titles.join('、')}的要求。`
    : `本轮回复同样要遵守系统提示中${titles.join('、')}的要求。`
}

/**
 * A chat's frozen system prompt. With a SillyTavern preset the preset's prompts
 * lead, in its own order, and the card data lands where its markers sit; our
 * notes on the message format follow. Returns the variables the preset's
 * macros set, which every later turn starts from.
 */
export function buildChatPrompt({ card, persona, settings, books, hasState, preset = null }) {
  if (!preset || preset.builtin) return { systemPrompt: buildSystemPrompt({ card, persona, settings, books, hasState, options: preset?.options ?? null }), presetVars: {} }
  const names = { char: card.name, user: persona.name || '你' }
  const m = text => replaceMacros(text, names)
  const world = after =>
    constantEntries(books)
      .filter(entry => (entry.position === 1) === after)
      .map(entry => m(entryText(entry)))
      .filter(Boolean)
      .join('\n\n')
  const prefix = renderPresetPrefix(preset, { card, persona, names, worldBefore: world(false), worldAfter: world(true) })
  const notes = [
    '## 本应用的消息格式',
    `玩家扮演「${names.user}」。每条玩家消息由标签块组成：`,
    '- <玩家输入> 是玩家本轮的行动、对白或希望看到的发展。',
    '- <世界书>、<动态设定>、<当前状态>、<角色备注> 是与当前情节相关的设定资料，只供参考，不要原样复述。',
    '- <预设指令> 是本轮要遵守的写作指令；<回复要求> 是本轮的篇幅要求；<本轮提醒> 指向系统提示里每轮都要执行的规则。',
    `- 使用${settings.language || '简体中文'}写作。`,
  ].join('\n')
  const systemPrompt = [
    prefix.text,
    notes,
    stateProtocol(card, hasState),
    section('文风与写作要求', m(settings.writingRules)),
    section(EVERY_TURN, [prefix.rules, lateText(books, m)].filter(t => t.trim()).join('\n\n')),
  ]
    .filter(Boolean)
    .join('\n\n')
  return { systemPrompt, presetVars: prefix.vars }
}

/**
 * The user message for one turn.
 * @param opening - the greeting, only on a chat's first turn (already prompt-processed).
 * @param entries - rendered keyword-triggered entries `{ title, text }`.
 * @param dynamic - rendered state-dependent constant entries `{ title, text }`.
 * @param characterNote - the card's depth prompt, rendered.
 * @param stateText - JSON of the current state when it should be refreshed.
 * @param input - the player's input (already prompt-processed).
 * @param replyLength - target reply length in characters, 0 for none.
 * @param presetText - the preset's per-turn paragraphs, rendered for this turn.
 * @param reminder - one line pointing at the prefix's every-turn rules.
 */
export function buildTurnPrompt({ names, opening, recap = '', entries = [], dynamic = [], characterNote = '', stateText, input, replyLength = 0, presetText = '', reminder = '' }) {
  const parts = []
  const block = (tag, items) => {
    const body = items.filter(item => item.text).map(item => titled(item.title, item.text)).join('\n\n')
    if (body) parts.push(`<${tag}>\n${body}\n</${tag}>`)
  }
  if (opening) parts.push(`<开场>\n以下是故事的开场，已作为第一段正文展示给玩家：\n${replaceMacros(opening, names)}\n</开场>`)
  // After a manual compaction: the summary and last few turns open the new session.
  if (recap) parts.push(recap)
  block('世界书', entries)
  block('动态设定', dynamic)
  if (stateText) parts.push(`<当前状态>\n${stateText}\n</当前状态>`)
  if (characterNote) parts.push(`<角色备注>\n${characterNote}\n</角色备注>`)
  if (replyLength > 0) parts.push(`<回复要求>\n本轮正文约 ${replyLength} 字（上下浮动两成以内），只计叙事正文，不含状态栏、变量更新等标签块。\n</回复要求>`)
  parts.push(`<玩家输入>\n${replaceMacros(input, names)}\n</玩家输入>`)
  // After the input, like SillyTavern's post-history prompts.
  if (presetText) parts.push(`<预设指令>\n${presetText}\n</预设指令>`)
  if (reminder) parts.push(`<本轮提醒>${reminder}</本轮提醒>`)
  return parts.join('\n\n')
}
