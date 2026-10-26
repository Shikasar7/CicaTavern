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
import { constantEntries, entryText, entryTitle, keywordEntries, lateEntries, preloadEntries, templateInitialVariables } from './worldbook.mjs'
import { renderTemplate, stripTemplates, templateSession } from './template.mjs'
import { renderPresetPrefix } from './presets.mjs'
import { basicRules } from './basic.mjs'
import { hasVariableMacros, replaceVariableMacros } from '../web/shared/vars.js'
import { PLACEMENT } from '../web/shared/regex.js'
import { applyScripts } from './regex-guard.mjs'
import { EFFECT_WORDS, FACE_WORDS } from '../web/shared/stage.js'

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
    .replace(/\{\{roll:?\s*(\d*)d(\d+)\}\}/gi, (whole, count, sides) => {
      const dice = Number(count) || 1
      const faces = Number(sides)
      // More dice than anyone rolls is left as written: {{roll:100000000000d6}} kept the server busy for most of an hour.
      if (dice > MAX_DICE || !Number.isSafeInteger(faces) || faces < 1) return whole
      let total = 0
      for (let i = 0; i < dice; i++) total += 1 + Math.floor(Math.random() * faces)
      return String(total)
    })
}

const MAX_DICE = 1000

/**
 * Render one worldbook entry against the current state: EJS in the sandbox,
 * then variable macros, then name macros. A template that fails falls back to
 * its text with the EJS removed. An entry rendered before keyword matching
 * (`preprocessed`) is already done.
 * @param session - the turn's templateSession (its books and messages for getwi
 *   and matchChatMessages); without one the entry renders in a sandbox of its own.
 * @param world - the name of the entry's book (the template's `world_info.world`).
 */
export function renderEntry(entry, { state, names, session = null, world = '' }) {
  const uid = Number(entry.uid)
  const data = { world_info: { comment: entry.comment, uid: Number.isFinite(uid) ? uid : entry.uid, world } }
  const rendered = entry.preprocessed ? { text: entry.content, error: null } : session ? session.render(entry.content, data) : renderTemplate(entry.content, { state, names })
  const text = rendered.text ?? entryText(entry)
  // Variable macros read the state and the chat's and app's variables as the turn's templates have left them.
  const used = session && hasVariableMacros(text)
  const vars = used ? session.currentState() : state
  return { text: replaceMacros(replaceVariableMacros(text, vars, used ? session.currentVariables() : {}), names).trim(), error: rendered.error }
}

/**
 * A template sandbox for one chat (template.mjs templateSession) with what
 * ST-Prompt-Template gives templates there: the card and its books, the
 * chat's names and preset, the story so far as the card's prompt-side regex
 * leaves each message (at its depth, the last message being 0, as engine
 * apiMessages sends them), and the @@preload entries run first.
 * @param messages - [{ role, text }], oldest first, the greeting as floor 0.
 * @param local / global - the chat's frameVars and the settings' globalVars.
 */
export function chatTemplates({ names, card = null, preset = null, books = [], scripts = [], state = {}, local = {}, global = {}, messages = [], runType = 'generate', context = {} }) {
  const macros = text => replaceMacros(text, names)
  const last = messages.length - 1
  return templateSession({
    state,
    local,
    global,
    initial: () => templateInitialVariables(books, entry => renderTemplate(entry.content, { names }).text ?? entryText(entry)),
    names,
    books,
    messages,
    messageText: (message, index) => applyScripts(message.text, scripts, { placement: message.role === 'user' ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT, target: 'prompt', depth: last - index, macros }),
    card,
    preset,
    preload: preloadEntries(books),
    matchKeys: text => keywordEntries(books, text),
    runType,
    context,
  })
}

/**
 * A text's EJS through `session` (renderText), for prompt material: what it
 * printed, or the text with its EJS taken out when it fails (the error goes to `errors`).
 */
export function templateText(session, text, errors = [], label = '') {
  const rendered = session.renderText(text)
  if (rendered.error) errors.push(label ? `${label}: ${rendered.error}` : rendered.error)
  return rendered.text ?? stripTemplates(text)
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
 * they did before that preset existed. `style`: the chat's 文风 (its text).
 */
export function buildSystemPrompt({ card, persona, style = '', settings, books, hasState, options = null, render = text => text }) {
  const names = { char: card.name, user: persona.name || '你' }
  const m = text => replaceMacros(text, names)
  // The card's and the player's own text may hold templates (rendered once, see buildChatPrompt).
  const f = text => m(render(text))
  const constants = constantEntries(books)
    .map(entry => {
      const text = m(entryText(entry))
      return text ? titled(entry.comment, text) : ''
    })
    .filter(Boolean)
    .join('\n\n')
  const authorSystem = f(card.systemPrompt.replace(/\{\{original\}\}/gi, ''))

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
    section('文风与写作要求', m(style)),
    section(`玩家角色：${names.user}`, f(persona.description)),
    [
      `## 角色卡：${card.name}`,
      section('描述', f(card.description)).replace(/^## /, '### '),
      section('性格', f(card.personality)).replace(/^## /, '### '),
      section('场景', f(card.scenario)).replace(/^## /, '### '),
      section('对话示例', f(card.mesExample.replace(/<START>/gi, '---'))).replace(/^## /, '### '),
    ].filter(Boolean).join('\n\n'),
    section('角色卡作者的指示', authorSystem),
    section('常驻设定', constants),
    section(EVERY_TURN, [options ? m(basicRules(options)) : '', f(card.postHistoryInstructions), lateText(books, m)].filter(t => t.trim()).join('\n\n')),
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
export function everyTurnReminder(systemPrompt, books, { presetRules = false, mvu = false } = {}) {
  const late = lateEntries(books)
  const titles = late.map(entry => `【${entryTitle(entry)}】`)
  const hasSection = systemPrompt.includes(`## ${EVERY_TURN}`)
  if (!titles.length && !hasSection) return ''
  // SillyTavern sends a preset's post-history prompts right before the reply; here they sit in
  // the prefix, a long history away, and the blocks they ask for after the story get dropped.
  const preset = presetRules && hasSection ? '预设规定的输出格式和顺序（正文之后要求附加的内容块一个都不能省）' : ''
  // An MVU card's update block is what a long chat drops first: named outright.
  const update = mvu ? '结尾完整闭合的 <UpdateVariable> 变量更新块（照卡里的变量规则写，不能省）' : ''
  const demands = [preset, update].filter(Boolean)
  if (!titles.length) return `本轮回复同样要遵守系统提示末尾「${EVERY_TURN}」一节的全部要求${demands.length ? `，尤其是${demands.join('、')}` : ''}。`
  // Many entries (a world's maps, monsters, lore) would bury the few that ask for something
  // in the reply: those are named, the rest counted.
  const named = late.length > NAME_ALL ? late.filter(asksForOutput).slice(0, NAME_MAX).map(entry => `【${entryTitle(entry)}】`) : titles
  const rest = late.length - named.length
  const others = rest > 0 ? `${named.length ? '，以及' : ''}其余 ${rest} 条常驻设定` : ''
  const listed = named.join('、')
  const inSection = hasSection && systemPrompt.lastIndexOf(titles[0]) > systemPrompt.lastIndexOf(`## ${EVERY_TURN}`)
  if (inSection) return `本轮回复同样要遵守系统提示末尾「${EVERY_TURN}」一节的全部要求，包括${[...demands, listed].filter(Boolean).join('、')}${others}。`
  const where = `系统提示中${listed}${others}`
  return demands.length
    ? `本轮回复同样要遵守系统提示末尾「${EVERY_TURN}」一节里${demands.join('、')}，以及${where}的要求。`
    : `本轮回复同样要遵守${where}的要求。`
}

// Up to this many entries are all named; beyond it, only those asking for something in the reply.
const NAME_ALL = 4
const NAME_MAX = 8
const ASKS_TITLE = /UpdateVariable|JSONPatch|mvu|变量|状态栏|格式|输出|选项|时间戳|时间与|日程|锚点|每轮|每次|规则|禁止|要求/i
const ASKS_TEXT = /UpdateVariable|JSONPatch|<StatusPlaceHolder|每次(回复|输出|剧情)|每轮|回复的?(开头|末尾|结尾|第一行)|(末尾|结尾|开头)(输出|插入|写|附)|按照以下格式|必须|务必|不可|禁止/

/** Whether an entry asks for something in each reply (a format, a block, a rule) rather than describing the world. */
function asksForOutput(entry) {
  return ASKS_TITLE.test(entryTitle(entry)) || ASKS_TEXT.test(entryText(entry).slice(0, 160))
}

/**
 * A chat's frozen system prompt. With a SillyTavern preset the preset's prompts
 * lead, in its own order, and the card data lands where its markers sit; our
 * notes on the message format follow. Returns the variables the preset's
 * macros set, which every later turn starts from.
 * @param style - the chat's 文风 (web/shared/personas.js): its text, after the format notes.
 * @param render - text => text: the EJS in the card's fields, the persona and the
 *   preset's prompts, rendered once with the chat's opening state (chats.mjs).
 *   The prefix is frozen, so a template there that reads changing state keeps
 *   the value it had when the chat started.
 */
export function buildChatPrompt({ card, persona, style = '', settings, books, hasState, preset = null, render = text => text }) {
  if (!preset || preset.builtin) return { systemPrompt: buildSystemPrompt({ card, persona, style, settings, books, hasState, options: preset?.options ?? null, render }), presetVars: {} }
  const names = { char: card.name, user: persona.name || '你' }
  const m = text => replaceMacros(text, names)
  const world = after =>
    constantEntries(books)
      .filter(entry => (entry.position === 1) === after)
      .map(entry => m(entryText(entry)))
      .filter(Boolean)
      .join('\n\n')
  const prefix = renderPresetPrefix(preset, { card, persona, names, worldBefore: world(false), worldAfter: world(true), render })
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
    section('文风与写作要求', m(style)),
    section(EVERY_TURN, [prefix.rules, lateText(books, m)].filter(t => t.trim()).join('\n\n')),
  ]
    .filter(Boolean)
    .join('\n\n')
  return { systemPrompt, presetVars: prefix.vars }
}

/**
 * 视觉小说格式: while the player reads in the visual novel mode with it on
 * (web/vn.js), each turn's message asks for every line marked with who says it
 * and how they look, and effects on lines of their own (web/shared/vn.js reads
 * them). In the turn's message, never in the prefix: switching it costs no cache.
 */
export function dialogueFormat() {
  const faces = Object.values(FACE_WORDS).join('、')
  const effects = Object.values(EFFECT_WORDS).map(words => words[0]).join('、')
  return [
    '<对白格式>',
    `本轮的对白按视觉小说格式写：每句台词单独起一行，开头标上说话人和表情，写成【名字|表情】「台词」，例如【名字|微笑】「……」。表情从 ${faces} 中选一个。动作、神态和叙述照常写在台词前后的行里，不放进标记。`,
    `需要画面效果时，在那一句前面单独一行写【效果|震屏】，可选 ${effects}；只在冲击、雷电、受惊、害怕这类时候用，不要每段都加。其余格式要求不变。`,
    '</对白格式>',
  ].join('\n')
}

/**
 * The turn's word on 联网 (the provider searches when the model asks): search only for what the
 * story or the player needs from the real world, and keep the search out of the story.
 */
export function webSearchNote() {
  return '<联网搜索>\n这一轮可以搜索网页。玩家问到、或剧情需要现实世界的信息（时事、真实的地点和人物、作品资料等）时再搜，否则不用搜。搜索前不要写任何文字；搜完照常以故事的口吻写正文，不提搜索，不写网址和引用标注。\n</联网搜索>'
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
 * @param marks - ask for the 视觉小说格式 (dialogueFormat).
 */
export function buildTurnPrompt({ names, opening, recap = '', entries = [], dynamic = [], characterNote = '', stateText, input, replyLength = 0, presetText = '', reminder = '', marks = false }) {
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
  if (marks) parts.push(dialogueFormat())
  if (reminder) parts.push(`<本轮提醒>${reminder}</本轮提醒>`)
  return parts.join('\n\n')
}
