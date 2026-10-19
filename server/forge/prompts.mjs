// What the model is asked while a card is being created, and how its answers
// are read back. The method follows the tavern-cards way of building a card
// (settle the world and the core character first, keep the user's own words,
// say out loud what was assumed, keep the lore terse and concrete), written
// here in this app's own words.
import { configureEntries } from './configure.mjs'
import { defaultShow } from './status.mjs'
import { SHOWS, cleanPath } from '../../web/shared/status.js'
import { msg } from '../i18n.mjs'

// ─── Languages ────────────────────────────────────────────────────────────
// The guide talks to the user in the page's language (界面语言). What goes into
// the card is in the language its stories are written in (设置 → 写作语言): the
// sample passages, the plan, every entry and greeting. The plan keeps that
// language, so a draft is written in one language to the end.

export const DEFAULT_LANGUAGE = '简体中文'

/** The languages of one job: reply = the page's (zh | en), card = 写作语言. */
export const forgeLanguages = (uiLanguage, writing) => ({
  reply: uiLanguage === 'en' ? 'English' : DEFAULT_LANGUAGE,
  card: String(writing ?? '').trim() || DEFAULT_LANGUAGE,
})

/** A card in English gets English names for the parts the code names itself. */
export const englishCard = language => /^(en\b|english|英文|英语)/i.test(String(language ?? '').trim())

// ─── Shared writing rules ─────────────────────────────────────────────────
// Kinds of wording to avoid, named by kind only: listing the phrases themselves
// in a prompt tends to put them into the answer. The checker has the list.
const WRITING_RULES = [
  '名称一律具体：地名、学校、组织、店名都要有名字，不写「某城市」「某学校」「那个地方」。',
  '写具体的画面和行为，不贴性格标签，不写空泛的赞美或评价。',
  '不用套话：陈旧比喻、「仿佛/似乎」一类的模糊词、细小表情的固定写法、「带着……的语气」一类的声线描写、夸张的情绪词。',
  '一句一个意思，说完就停，不做同义反复。',
  '玩家角色写作 <user>，不写 {{user}}。',
]

/** The writing rules, everything in one language (the card's). */
export const plainWriting = (language = DEFAULT_LANGUAGE) => [`全文${language}。不用破折号。`, ...WRITING_RULES].join('\n')

/** The same for the guide, whose talk can be in another language than the card. */
function talkWriting({ reply = DEFAULT_LANGUAGE, card = DEFAULT_LANGUAGE } = {}) {
  if (reply === card) return plainWriting(card)
  return [
    `对用户说的话用${reply}写：<reply>，问题的 title 和 why，选项的 label 和 detail，草图的 title、label、value 和 open。`,
    `选项的 sample 和 taste 的试写是这张卡正文的样子，用${card}写。`,
    '不用破折号。',
    ...WRITING_RULES,
  ].join('\n')
}

// Output caps. They only stop a runaway answer, so they leave room for thinking:
// models that think by default (DeepSeek's flash) count it against the same cap,
// and an answer cut off before its closing tag can't be read at all.
export const TALK_TOKENS = 16000
export const LONG_TOKENS = 32000

// ─── Talking it through ───────────────────────────────────────────────────

const discussSystem = languages => `你是一位角色卡共创向导。用户想在 SillyTavern 一类的角色扮演应用里玩一张新角色卡，但往往说不清自己真正想要什么。你陪他把一个模糊的念头聊成清晰的设想：用具体、可感的选择帮他发现自己的偏好，而不是替他做决定。

做法：
- 每轮先用一两句话说出你此刻理解的样子，要具体、有画面；再提 2 到 3 个此刻最影响全局的问题，不要一次问很多。
- 提问的先后：先定舞台（世界）和核心角色是谁，再定 <user> 的身份、和角色的关系、互动方式与玩法，然后是基调、文风和开场，最后才是要不要记录会变化的数值。已经定下的不再问。
- 每个问题给 3 到 4 个彼此差别明显的选项。每个选项都要具体，并附一句样例：角色可能说的一句话，或一两句小场景，让用户凭感觉挑。样例要像活人说的话。
- 文风、语气这类难以描述的东西，用 kind 为 taste 的问题：给两到三段同一情境、不同写法的短试写（每段 60 到 120 字），让用户挑喜欢的一段。
- 用户可能选「你来定」：那就由你挑最合适的一项，在回复里说你选了什么、为什么，并在草图里把这一项的 by 写成 "assistant"。
- 不偷偷替用户拿主意。你自己补出来的设想写进草图时 by 写 "assistant"；用户亲口说的、选的，by 写 "user"，并尽量保留他的原话。谁补的只写在 by 里，value 只写设定本身，不加「谁补的」「随时可改」这类注明，界面会标出来。
- 草图里 locked 为 true 的项是用户锁定的，不能改动，只能在它的基础上补充。
- 用大白话交流，不说「世界书」「条目」「MVU」「常驻」这类术语。问状态记录时说成「要不要记录她对你的好感、你的体力这类会变化的数值，显示在每条回复下面的状态栏里」；用户想要的话，再用一个问题和他商量记哪几项、各自怎么变（比如什么事让好感涨、什么事让它掉），选项给出具体的组合。
- 当核心角色、和 <user> 的关系、舞台、基调都已清楚，readiness 给到 75 以上，并在回复里提一句「可以出方案了，也可以接着细化」。用户可能随时要求出方案，你只管把每一轮聊好。

${talkWriting(languages)}

回答严格分成下面三段，标签之外不写任何东西：
<reply>
对用户说的话，2 到 5 句，像朋友聊天。
</reply>
<questions>
[{"id": "q1", "title": "问题", "why": "这个选择会影响什么，一句话", "kind": "single", "options": [{"label": "短标签", "detail": "一句说明，可以为空", "sample": "样例"}]}]
</questions>
<brief>
{"title": "卡的暂定名", "readiness": 40, "items": [{"key": "stage", "label": "舞台", "value": "一两句，具体", "by": "user"}], "open": ["还没定的关键点，几个字"]}
</brief>

kind 取 single（选一个）、multi（可多选）或 taste（试写挑一段，options 的 sample 放试写正文，label 写「第一段」「第二段」）。
草图的 key 尽量用：stage 舞台、lead 核心角色、user 你的身份、bond 你们的关系、play 玩法、tone 基调、style 文风、cast 配角、track 记录的数值、opening 开场；还没谈到的不要写。`

const LIMITS = { questions: 4, options: 5, items: 14, open: 6 }
const BY = new Set(['user', 'assistant'])
const KINDS = new Set(['single', 'multi', 'taste'])

const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** Text between <tag> and </tag>; up to the end when the answer was cut off. */
export function section(text, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`, 'i').exec(String(text ?? ''))
  return match ? match[1].trim() : ''
}

/** JSON from a model's answer: fences and chatter around it are ignored. */
export function looseJson(text) {
  const body = String(text ?? '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  try {
    return JSON.parse(body)
  } catch {
    const start = body.search(/[[{]/)
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(body.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'))
    } catch {
      return null
    }
  }
}

export function cleanQuestions(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const [i, q] of raw.entries()) {
    if (out.length >= LIMITS.questions) break
    if (!q || typeof q !== 'object') continue
    const kind = KINDS.has(q.kind) ? q.kind : 'single'
    const options = (Array.isArray(q.options) ? q.options : [])
      .map(o => (typeof o === 'string' ? { label: o } : o))
      .filter(o => o && typeof o === 'object' && clip(o.label, 40))
      .slice(0, kind === 'taste' ? 3 : LIMITS.options)
      .map(o => ({ label: clip(o.label, 40), detail: clip(o.detail, 120), sample: clip(o.sample, kind === 'taste' ? 500 : 160) }))
    const title = clip(q.title, 80)
    if (!title || options.length < 2) continue
    out.push({ id: clip(q.id, 24).replace(/[^\w-]/g, '') || `q${i + 1}`, title, why: clip(q.why, 120), kind, options })
  }
  // Ids must tell the questions of one round apart.
  const seen = new Set()
  for (const [i, q] of out.entries()) {
    if (seen.has(q.id)) q.id = `q${i + 1}`
    seen.add(q.id)
  }
  return out
}

// A note on who wrote an item, which some models add to the value itself:
// "（assistant 补的版本，随时可改）". The page tags items by `by` already.
// Not "user": values name the player as <user>, in brackets too.
const BY_NOTE = /\s*[（(][^（）()]*(?:assistant|向导补|随时可改)[^（）()]*[）)]/gi

/** One sketch item as the page and the model both keep it. */
function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const value = clip(typeof raw.value === 'string' ? raw.value.replace(BY_NOTE, '') : raw.value, 400)
  const label = clip(raw.label, 16)
  const key = clip(raw.key, 24).replace(/[^\w-]/g, '') || label
  if (!key || !label) return null
  return { key, label, value, by: BY.has(raw.by) ? raw.by : 'assistant', locked: raw.locked === true }
}

/**
 * The sketch after a round: the model's, over the one before it. Locked items
 * stay as the user left them; items the model left out are kept.
 */
export function mergeBrief(raw, previous = emptyBrief()) {
  const fresh = raw && typeof raw === 'object' ? raw : {}
  const before = new Map(previous.items.map(item => [item.key, item]))
  const items = []
  for (const candidate of Array.isArray(fresh.items) ? fresh.items : []) {
    const item = cleanItem(candidate)
    if (!item || items.some(i => i.key === item.key)) continue
    const old = before.get(item.key)
    items.push(old?.locked ? old : { ...item, locked: false })
    before.delete(item.key)
  }
  for (const old of before.values()) items.push(old)
  const readiness = Number(fresh.readiness)
  return {
    title: clip(fresh.title, 40) || previous.title,
    readiness: Number.isFinite(readiness) ? Math.max(0, Math.min(100, Math.round(readiness))) : previous.readiness,
    items: items.slice(0, LIMITS.items),
    open: (Array.isArray(fresh.open) ? fresh.open : previous.open).map(o => clip(o, 40)).filter(Boolean).slice(0, LIMITS.open),
  }
}

export function emptyBrief() {
  return { title: '', readiness: 0, items: [], open: [] }
}

/** The user's edits to the sketch: values, labels and locks; the model's notes stay the model's until edited. */
export function editBrief(previous, edit) {
  const items = Array.isArray(edit?.items) ? edit.items.map(cleanItem).filter(Boolean) : previous.items
  return {
    ...previous,
    title: typeof edit?.title === 'string' ? clip(edit.title, 40) : previous.title,
    items: items.slice(0, LIMITS.items),
  }
}

/** What the user said in one round, as the model reads it. */
export function userTurnText(user, { first = false } = {}) {
  const lines = []
  if (first) lines.push(`我的想法：${user.text}`)
  else {
    if (user.picks?.length) {
      lines.push('我的选择：')
      for (const pick of user.picks) {
        const answer = pick.delegate ? '你来定' : pick.custom ? `都不是，我想要：${pick.custom}` : pick.labels.join('、')
        lines.push(`- ${pick.title} → ${answer}`)
      }
    }
    if (user.text) lines.push(user.picks?.length ? `我想补充：${user.text}` : user.text)
  }
  return lines.join('\n')
}

/** The request for the next round of talk; languages from forgeLanguages. */
export function discussRequest(rounds, brief, languages) {
  const messages = []
  rounds.forEach((round, i) => {
    let content = userTurnText(round.user, { first: i === 0 })
    const last = i === rounds.length - 1
    if (last && i > 0) content += `\n\n<sketch>\n现在的草图（我可能改过一些，locked 的是我锁定的）：\n${JSON.stringify(brief)}\n</sketch>`
    messages.push({ role: 'user', content })
    if (!last && round.assistant) messages.push({ role: 'assistant', content: round.assistant.raw })
  })
  return { system: discussSystem(languages), messages, maxTokens: TALK_TOKENS, softCap: true }
}

/** A round's answer → { reply, questions, brief }; whatever could be read. */
export function readDiscussion(text, previous) {
  const reply = section(text, 'reply') || (/<questions>|<brief>/i.test(text) ? '' : String(text ?? '').trim())
  const questions = cleanQuestions(looseJson(section(text, 'questions')))
  const briefJson = looseJson(section(text, 'brief'))
  return { reply: reply.slice(0, 2000), questions, brief: briefJson ? mergeBrief(briefJson, previous) : previous, readable: Boolean(briefJson) }
}

/** The reply part of an answer still being written, for the page to show as it comes. */
export function partialReply(text) {
  const open = /<reply>/i.exec(text)
  if (!open) return ''
  const rest = text.slice(open.index + open[0].length)
  const close = rest.search(/<\/reply>/i)
  return (close < 0 ? rest : rest.slice(0, close)).trim()
}

// ─── The plan ─────────────────────────────────────────────────────────────

const PLAN_SCHEMA = `{
  "name": "卡名，具体好记",
  "summary": "给玩家看的简介，2 到 3 句",
  "user_role": {"identity": "<user> 是谁、为什么在这里", "constraints": ["<user> 的限制，可为空"]},
  "world": {
    "kind": "真实 或 架空",
    "overview": "舞台概述，几句",
    "rules": ["只写和常识不同、模型会弄错的设定"],
    "places": [{"name": "地点名", "aliases": [], "description": "样子、氛围、在这里会发生什么", "scenes": ["其中的具体场所"]}],
    "factions": [{"name": "势力或组织名", "description": "", "members": []}],
    "history": [{"event": "会影响眼下局势的往事", "impact": "它造成了什么"}]
  },
  "characters": [{
    "name": "全名", "kind": "core 或 npc", "aliases": ["昵称、外号"],
    "age": "", "gender": "", "identity": "身份",
    "relationship": "和 <user> 的关系，写具体画面",
    "appearance": ["只写让人认得出她的特征"], "outfit": "平时的穿着",
    "personality": {"base": "底色", "main": ["主色调 1 到 2 个"], "accent": ["点缀，可为空"]},
    "facets": false,
    "voice": "说话方式，口头禅",
    "role": "配角在故事里的作用（npc 才写）",
    "looks_tags": "English booru tags for the unchanging look: apparent age, hair, eyes, build, marks",
    "outfit_tags": "English booru tags for the usual outfit"
  }],
  "style": {"perspective": "第三人称 或 第二人称", "tone": "语言基调", "mood": "情绪氛围", "reference": "参照的作品或文风，可为空", "special": ["特别要求"]},
  "play_rules": ["扮演时的互动规则，可执行的指令，例如不替 <user> 说话做决定"],
  "tracking": {"enabled": false, "title": "状态栏标题，可为空", "variables": [{"path": "林小雨.好感度", "label": "好感", "type": "number", "initial": "20", "range": "0~100", "show": "meter", "check": "什么事会让它怎么变"}]},
  "greetings": [{"title": "开场的名字", "scene": "时间、地点", "situation": "开场时正在发生什么、悬念在哪", "length": "500~700"}],
  "avatar": {"character": "头像画的是谁", "description": "中文，外貌、神态、构图", "tags": "English tags for the picture"},
  "assumptions": ["你补出来、用户没有说过的设定，一条一句"],
  "verbatim": ["用户原话里应当原样保留的句子"]
}`

const planSystem = language => `你是角色卡策划。根据你和用户的讨论，写出一张 SillyTavern 角色卡的创作方案，之后会按方案逐项写出角色设定、世界书和开场白。

要求：
- 讨论里定下的一切都要体现在方案里；用户的原话放进 verbatim，并在相关字段里原样使用。
- 没讨论到但写卡必需的部分，你可以补，但每一处都要写进 assumptions，让用户确认。
- 核心角色通常 1 个，最多 4 个；配角 0 到 3 个，每个都要有在故事里的作用。
- 外貌只写让人认得出的特征，不写放在谁身上都成立的美貌描写。
- 性格用「底色 + 主色调 + 点缀」来想：底色是最深层、最稳定的那一面，主色调是最常表现出来的，点缀是偶尔露出的。facets 只在角色在不同处境下判若两人时才设为 true。
- 只有用户想要记录好感、体力、金钱这类会变化的数值时，tracking.enabled 才为 true；变量路径用「角色名.变量名」，<user> 自己的用「主角.变量名」，不要用 <user> 或 {{user}} 当键名。
- 这些变量会显示在每条回复下面的状态栏里。label 是状态栏上的短名（2 到 4 个字）；show 是显示方式：meter 进度条（有范围的数值）、number 数字、text 一句话、tags 标签（物品、状态这类列表）、flag 是或否、hidden 只给模型看不显示。状态栏放玩家最在意的 3 到 8 项，其余用 hidden。
- 开场白默认 2 个，场景各不相同，每个都要有悬念或张力，并让 <user> 一开口就有话可接。
- 所有专有名词在这里一次定好，之后不再新造。

${plainWriting(language)}

只输出一段 <plan> 包着的 JSON，结构如下：
<plan>
${PLAN_SCHEMA}
</plan>`

/** The whole talk as one transcript, the user's words as they were said. */
export function transcript(rounds) {
  return rounds
    .map((round, i) => {
      const parts = [`【用户】\n${userTurnText(round.user, { first: i === 0 })}`]
      if (round.assistant?.reply) parts.push(`【向导】\n${round.assistant.reply}`)
      return parts.join('\n')
    })
    .join('\n\n')
}

/** The plan, in the card's language (languages from forgeLanguages). */
export function planRequest(rounds, brief, { card = DEFAULT_LANGUAGE } = {}) {
  const content = `<discussion>\n${transcript(rounds)}\n</discussion>\n\n<sketch>\n${JSON.stringify(brief)}\n</sketch>\n\n按上面的讨论和草图写出创作方案。`
  return { system: planSystem(card), messages: [{ role: 'user', content }], maxTokens: LONG_TOKENS, softCap: true }
}

/** Changes to a plan: the current plan and what the user wants different, in the plan's language. */
export function reviseRequest(rounds, plan, { text = '', notes = [] } = {}) {
  const asked = [
    ...notes.filter(n => n.text).map(n => `- 关于「${n.section}」：${n.text}`),
    text ? `- 总体：${text}` : '',
  ].filter(Boolean)
  const content = [
    `<discussion>\n${transcript(rounds)}\n</discussion>`,
    `<current_plan>\n${JSON.stringify(rawPlan(plan))}\n</current_plan>`,
    `用户对方案的意见：\n${asked.join('\n')}`,
    '按意见改方案：只改意见涉及的部分，其余保持原样。新补出来的设定同样写进 assumptions。输出完整的新方案。',
  ].join('\n\n')
  return { system: planSystem(planLanguage(plan)), messages: [{ role: 'user', content }], maxTokens: LONG_TOKENS, softCap: true }
}

// ─── Reading a plan back ──────────────────────────────────────────────────

const PLACEHOLDER = /某(城市|学校|组织|公司|地方|小镇|国家|人)|那个地方|XX|xx/
const list = (value, max, size) => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []).map(v => clip(typeof v === 'string' ? v : String(v ?? ''), size)).filter(Boolean).slice(0, max)
// Keywords: no single characters (they match everywhere), no duplicates.
const keywordsOf = (...names) => [...new Set(names.flat().map(n => clip(n, 24)).filter(n => n.length >= 2))]

/** A plan as the model wrote it, without the parts the app derives or keeps. */
function rawPlan(plan) {
  const { entries, warnings, language, ...rest } = plan ?? {}
  return rest
}

/** The language a plan (and so its card) is written in. Plans from before it was kept are Chinese. */
export const planLanguage = plan => plan?.language || DEFAULT_LANGUAGE

// What the code itself names in a card, for a card in Chinese or in English.
const OWN_WORDS = {
  zh: {
    world: '世界设定', worldPurpose: overview => `舞台的框架和与常识不同的规则：${overview}`,
    rules: '扮演准则', rulesPurpose: '怎么演：互动规则、文风要点',
    history: '往事',
    catalog: '角色速览', catalogPurpose: '谁是谁：每人的姓名、性别、年龄、身份',
    basic: name => `${name}_基础信息`, basicPurpose: name => `${name}的档案：身份、外貌、背景、与 <user> 的关系`,
    palette: name => `${name}_性格调色盘`,
    palettePurpose: (name, base, main) => `${name}的性格：底色${base ? `「${base}」` : ''}，主色调${main.map(m => `「${m}」`).join('')}，每一面落到具体场景和行为`,
    facets: name => `${name}_三面性`, facetsPurpose: name => `${name}在不同处境下的几副面孔：触发、状态、语料、身体习惯`,
    rephrase: name => `${name}_二次解释`, rephrasePurpose: name => `纠正对${name}的刻板理解：每种性格真正的意思、何时出现、何时不出现`,
    initvar: '[InitVar]请勿打开', initvarPurpose: '变量的初始值（不发给模型，开局时读入）',
    variables: '变量列表', variablesPurpose: '每轮把当前变量交给模型',
    updateRules: '[mvu_update]变量更新规则', updateRulesPurpose: '每个变量什么时候、怎么变',
    updateFormat: '[mvu_update]变量输出格式', updateFormatPurpose: '让模型在回复末尾写出变量更新',
    perspective: '第三人称', greeting: n => `开场 ${n}`, separator: '；',
  },
  en: {
    world: 'World', worldPurpose: overview => `the stage and the rules that differ from common sense: ${overview}`,
    rules: 'Roleplay rules', rulesPurpose: 'how to play it: interaction rules, style points',
    history: 'Backstory',
    catalog: 'Cast overview', catalogPurpose: 'who is who: each one\'s name, gender, age, role',
    basic: name => `${name}_Profile`, basicPurpose: name => `${name}'s profile: identity, looks, background, relationship with <user>`,
    palette: name => `${name}_Personality`,
    palettePurpose: (name, base, main) => `${name}'s personality: base${base ? ` "${base}"` : ''}, main tones${main.map(m => ` "${m}"`).join('')}, each shown in concrete scenes and behavior`,
    facets: name => `${name}_Facets`, facetsPurpose: name => `${name}'s faces in different situations: trigger, state, lines, physical habits`,
    rephrase: name => `${name}_Clarifications`, rephrasePurpose: name => `correct stock readings of ${name}: what each trait really means, when it shows and when it doesn't`,
    initvar: '[InitVar] do not open', initvarPurpose: 'the variables\' starting values (not sent to the model; read when a chat starts)',
    variables: 'Variables', variablesPurpose: 'gives the model the current variables every turn',
    updateRules: '[mvu_update] Variable update rules', updateRulesPurpose: 'when and how each variable changes',
    updateFormat: '[mvu_update] Variable output format', updateFormatPurpose: 'has the model write the variable updates at the end of its reply',
    perspective: 'Third person', greeting: n => `Greeting ${n}`, separator: '; ',
  },
}

/** The card's own words for a plan's language. */
export const ownWords = language => OWN_WORDS[englishCard(language) ? 'en' : 'zh']

const VARIABLE_TYPES = ['number', 'string', 'boolean', 'list']

/**
 * The tracked variables as the plan keeps them, from the model or from the
 * player's edits in the plan's status bar editor. `show` (how the status bar
 * shows it) is filled in from the type when missing.
 */
export function cleanVariables(list) {
  const seen = new Set()
  return (Array.isArray(list) ? list : [])
    .filter(v => v && typeof v === 'object' && clip(v.path, 60))
    .map(v => {
      const type = VARIABLE_TYPES.includes(v.type) ? v.type : 'string'
      const variable = {
        path: cleanPath(clip(v.path, 60).replace(/[{}\s]+/g, '')),
        label: clip(v.label, 12),
        type,
        initial: clip(String(v.initial ?? ''), 120),
        range: clip(v.range, 40),
        check: clip(v.check, 200),
      }
      variable.show = SHOWS.includes(v.show) ? v.show : defaultShow(variable)
      return variable
    })
    .filter(v => v.path && !seen.has(v.path) && seen.add(v.path))
    .slice(0, 24)
}

/** @param language - 写作语言 when the plan was made (forgeLanguages().card). */
export function normalizePlan(raw, { language = DEFAULT_LANGUAGE } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const words = ownWords(language)
  const world = raw.world && typeof raw.world === 'object' ? raw.world : {}
  const characters = (Array.isArray(raw.characters) ? raw.characters : [])
    .filter(c => c && typeof c === 'object' && clip(c.name, 24))
    .slice(0, 12)
    .map(c => ({
      name: clip(c.name, 24),
      kind: c.kind === 'npc' ? 'npc' : 'core',
      aliases: list(c.aliases, 6, 24),
      age: clip(String(c.age ?? ''), 20),
      gender: clip(c.gender, 10),
      identity: clip(c.identity, 120),
      relationship: clip(c.relationship, 300),
      appearance: list(c.appearance, 8, 80),
      outfit: clip(c.outfit, 200),
      personality: {
        base: clip(c.personality?.base, 40),
        main: list(c.personality?.main, 2, 40),
        accent: list(c.personality?.accent, 4, 40),
      },
      facets: c.facets === true,
      voice: clip(c.voice, 200),
      role: clip(c.role, 200),
      looks_tags: clip(c.looks_tags, 400),
      outfit_tags: clip(c.outfit_tags, 300),
    }))
  if (!characters.some(c => c.kind === 'core')) {
    if (!characters.length) return null
    characters[0].kind = 'core'
  }
  const tracking = raw.tracking && typeof raw.tracking === 'object' ? raw.tracking : {}
  const variables = cleanVariables(tracking.variables)
  const plan = {
    name: clip(raw.name, 40) || characters[0].name,
    summary: clip(raw.summary, 400),
    user_role: { identity: clip(raw.user_role?.identity, 300), constraints: list(raw.user_role?.constraints, 6, 120) },
    world: {
      kind: /^(真实|real)/i.test(String(world.kind ?? '').trim()) ? '真实' : '架空',
      overview: clip(world.overview, 800),
      rules: list(world.rules, 12, 200),
      places: (Array.isArray(world.places) ? world.places : [])
        .filter(p => p && clip(p.name, 24))
        .slice(0, 10)
        .map(p => ({ name: clip(p.name, 24), aliases: list(p.aliases, 4, 24), description: clip(p.description, 400), scenes: list(p.scenes, 8, 40) })),
      factions: (Array.isArray(world.factions) ? world.factions : [])
        .filter(f => f && clip(f.name, 24))
        .slice(0, 8)
        .map(f => ({ name: clip(f.name, 24), description: clip(f.description, 400), members: list(f.members, 8, 24) })),
      history: (Array.isArray(world.history) ? world.history : [])
        .filter(h => h && clip(h.event, 200))
        .slice(0, 10)
        .map(h => ({ event: clip(h.event, 200), impact: clip(h.impact, 200) })),
    },
    characters,
    style: {
      perspective: clip(raw.style?.perspective, 20) || words.perspective,
      tone: clip(raw.style?.tone, 80),
      mood: clip(raw.style?.mood, 80),
      reference: clip(raw.style?.reference, 120),
      special: list(raw.style?.special, 6, 120),
    },
    play_rules: list(raw.play_rules, 8, 160),
    tracking: { enabled: tracking.enabled === true && variables.length > 0, title: clip(tracking.title, 30), variables },
    greetings: (Array.isArray(raw.greetings) ? raw.greetings : [])
      .filter(g => g && typeof g === 'object')
      .slice(0, 4)
      .map((g, i) => ({ title: clip(g.title, 30) || words.greeting(i + 1), scene: clip(g.scene, 200), situation: clip(g.situation, 400), length: clip(g.length, 20) || '500~700' })),
    avatar: { character: clip(raw.avatar?.character, 24) || characters[0].name, description: clip(raw.avatar?.description, 400), tags: clip(raw.avatar?.tags, 400) },
    assumptions: list(raw.assumptions, 20, 200),
    verbatim: list(raw.verbatim, 12, 300),
  }
  if (!plan.greetings.length) plan.greetings.push({ title: words.greeting(1), scene: '', situation: '', length: '500~700' })
  plan.language = language
  plan.entries = planEntries(plan)
  plan.warnings = planWarnings(plan)
  return plan
}

/** A plan's answer → the plan, or null when nothing usable came back. */
export function readPlan(text, { language = DEFAULT_LANGUAGE } = {}) {
  return normalizePlan(looseJson(section(text, 'plan') || text), { language })
}

/**
 * The worldbook the plan calls for, one entry per kind of fact, configured.
 * Built here rather than asked for: the same plan always gets the same entries.
 */
export function planEntries(plan) {
  const entries = []
  const words = ownWords(planLanguage(plan))
  const add = entry => entries.push({ keywords: [], rephrase: false, ...entry })
  const core = plan.characters.filter(c => c.kind === 'core')
  const npcs = plan.characters.filter(c => c.kind === 'npc')
  add({ name: words.world, type: '世界观', part: '', purpose: words.worldPurpose(plan.world.overview.slice(0, 60)) })
  if (plan.play_rules.length || plan.style.special.length) add({ name: words.rules, type: '扮演准则', part: '', purpose: words.rulesPurpose })
  if (plan.world.history.length) add({ name: words.history, type: '时间线', part: 'history', purpose: plan.world.history.map(h => h.event).join(words.separator).slice(0, 80) })
  // A single place is part of the world; several get one entry each.
  if (plan.world.places.length >= 2) {
    for (const place of plan.world.places) add({ name: place.name, type: '地理', part: 'region', keywords: keywordsOf(place.name, place.aliases), purpose: place.description.slice(0, 80) })
  }
  if (plan.world.factions.length >= 2) {
    for (const faction of plan.world.factions) add({ name: faction.name, type: '地理', part: 'faction', keywords: keywordsOf(faction.name), purpose: faction.description.slice(0, 80) })
  }
  if (plan.characters.length >= 5) add({ name: words.catalog, type: '角色', part: 'catalog', purpose: words.catalogPurpose })
  for (const c of core) {
    const keywords = keywordsOf(c.name, c.aliases)
    const owner = c.name
    add({ name: words.basic(c.name), owner, type: '角色', part: 'basic', keywords, purpose: words.basicPurpose(c.name) })
    add({ name: words.palette(c.name), owner, type: '角色', part: 'personality', keywords, purpose: words.palettePurpose(c.name, c.personality.base, c.personality.main) })
    if (c.facets) add({ name: words.facets(c.name), owner, type: '角色', part: 'facets', keywords, purpose: words.facetsPurpose(c.name) })
    add({ name: words.rephrase(c.name), owner, type: '角色', part: 'personality', rephrase: true, keywords, purpose: words.rephrasePurpose(c.name) })
  }
  for (const c of npcs) add({ name: c.name, owner: c.name, type: 'NPC', part: '', keywords: keywordsOf(c.name, c.aliases), purpose: c.role || c.identity })
  if (plan.tracking.enabled) {
    add({ name: words.initvar, type: '状态', part: 'initvar', purpose: words.initvarPurpose })
    add({ name: words.variables, type: '状态', part: 'variables', purpose: words.variablesPurpose })
    add({ name: words.updateRules, type: '状态', part: 'rules', purpose: words.updateRulesPurpose })
    add({ name: words.updateFormat, type: '状态', part: 'format', purpose: words.updateFormatPurpose })
  }
  return configureEntries(entries)
}

/**
 * The plan with its tracked variables edited by hand (the status bar editor):
 * `{ enabled?, title?, variables? }`, each left as it was when missing. The
 * state entries come and go with `enabled`.
 */
export function editTracking(plan, edit) {
  const before = plan.tracking ?? { enabled: false, title: '', variables: [] }
  const variables = Array.isArray(edit.variables) ? cleanVariables(edit.variables) : before.variables
  const enabled = (typeof edit.enabled === 'boolean' ? edit.enabled : before.enabled) && variables.length > 0
  const next = { ...plan, tracking: { enabled, title: typeof edit.title === 'string' ? clip(edit.title, 30) : before.title ?? '', variables } }
  next.entries = planEntries(next)
  next.warnings = planWarnings(next)
  return next
}

/** Things worth a look before writing: placeholder names, missing pieces. */
export function planWarnings(plan) {
  const warnings = []
  const names = [plan.name, ...plan.characters.map(c => c.name), ...plan.world.places.map(p => p.name), ...plan.world.factions.map(f => f.name)]
  const vague = names.filter(n => PLACEHOLDER.test(n))
  // For the user to read: in the page's language.
  if (vague.length) warnings.push(msg`这些名字还不够具体：${vague.join(msg`、`)}`)
  for (const c of plan.characters.filter(c => c.kind === 'core')) {
    if (!c.personality.base && !c.personality.main.length) warnings.push(msg`${c.name}的性格还空着`)
    if (!c.relationship) warnings.push(msg`${c.name}和 <user> 的关系还空着`)
  }
  if (!plan.user_role.identity) warnings.push(msg`<user> 的身份还没定`)
  return warnings
}
