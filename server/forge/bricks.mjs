// 玩法积木: abilities a card can have, picked in 创作角色卡's 高级选项. The code writes the works (the rule
// entries, the regex, the formats); the model only fills in what is the card's own (what to check, who may turn
// up, the ladder). Nothing here reaches the model unless the brick is picked.
//
// Everything runs on what SillyTavern has too: entries, regex and {{random}}, so a card keeps them when exported.
// The prompts name no genre: a brick is for any kind of card.
import { EVENT_RATES, cleanPath } from '../../web/shared/status.js'
import { CREATION_TALK, creationEntry, creationPlan, creationReady, creationScripts, creationText } from './creation.mjs'
import { regexEntry } from './status.mjs'

const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const texts = (value, max, size) => [...new Set((Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []).map(item => clip(typeof item === 'string' ? item : String(item ?? ''), size)).filter(Boolean))].slice(0, max)

export const SELF_CHECK = 'self_check'
export const JUDGE = 'judge'
/** The tag around each brick's rule: how a card is known to have it. */
export const RULE_TAGS = { selfcheck: 'self_check_rules', events: 'random_event_rules', judge: 'judge_rules', world: 'world_move_rules' }
const MIN_GROUP = 2
const MAX_GROUPS = 4
const MAX_ITEMS = 24
const MAX_RANKS = 12
const MAX_GAPS = 6
const MAX_KNOWN = 40
const MAX_LINES = 6
const MIN_STAGES = 2
const MAX_STAGES = 8
// What a reply says when nothing happens, in the draw and in the rule that reads it.
export const NOTHING = { zh: '无', en: 'nothing' }

// ─── What the guide and the planner are told ──────────────────────────────

export const BRICK_TALK = {
  books: '这张卡要有能增能减的册子：玩的时候会变多变少的记录。和用户商量要哪一到三本、每本记什么，开局有什么。用户说交给你，就按这张卡定。',
  selfcheck: '这张卡的模型写之前要先自查。问一句这张卡最怕写崩什么，选项给这张卡里具体的情形；用户说交给你，就按这张卡定。',
  events: '这张卡有随机事件：程序每轮抽一次，抽中了就发生。和用户商量可能碰到哪些人和事、要不要按场合分开。用户说交给你，就按这张卡定。',
  judge: '这张卡用等级定成败：程序不算，模型按表判定，不放水。和用户商量比的是什么、从低到高有哪些等级、差多少是什么结果。用户说交给你，就按这张卡定。',
  creation: CREATION_TALK,
  world: '这张卡的世界自己在动：几件事各有进度，玩家不管它们也会往前走。和用户商量有哪几件事、各分几步。用户说交给你，就按这张卡定。',
}

const BOOKS_PLAN = root => `tracking.enabled 为 true。tracking.variables 里写一到三本册子，记玩的时候会增减的东西，一本一个变量：{"path": "${root}.册子名", "label": "短名", "type": "book", "show": "table", "columns": ["每行要记的项"], "initial": [{"name": "开局就有的一行", "项": "值"}], "check": "什么时候加一行、删一行、改一行"}。columns 1 到 3 个，不算名字：每行的 name 就是第一列。initial 可以是 []。一样东西只记一处：已经是单独变量的（比如钱、灯油），不再写进册子。记什么按这张卡定，不要只想到一种。`

const SELFCHECK_PLAN = battle => `方案里多写一个 selfcheck 字段：["要查的一句话"]，3 到 6 条，每条写成能答是或否的问题，写这张卡最容易写崩的地方：人物的声口和分寸、这个世界的规矩、前后要连得上的事。通用的不写（不替 <user> 说话、角色不知道不该知道的事）${battle ? '，强弱和得失也不写（程序算）' : ''}。`

const EVENTS_PLAN = '方案里多写一个 random_events 字段：{"rate": "normal", "groups": [{"when": "什么场合用这一组，一句话；只有一组就留空", "items": ["一句话：是谁或什么事、怎么出现"]}]}。rate 是多常发生：rare 约八轮一次，normal 约五轮一次，often 约三轮一次。groups 1 到 4 组，每组 4 到 16 条。条目贴着这张卡的日子写：人、小事、消息、别处传来的动静都可以，彼此要有差别，不写结果，不替 <user> 做决定。'

const WORLD_PLAN = '方案里多写一个 world_moves 字段：{"rate": "normal", "lines": [{"name": "这件事的名字，几个字", "stages": ["现在的样子", "下一步", "结局"]}]}。rate 是世界动得多快：rare、normal 或 often。lines 2 到 5 条，写 <user> 不动也会往前走的事，记什么按这张卡定。stages 3 到 6 步，每步几个字，第一步是开局时的样子，最后一步是这件事的结局。'

// `dice` is what the player picked (平手看骰子 on, 不看运气 off), or '' when it is left to the guide.
const JUDGE_LUCK = {
  '': `dice 是差距为 0 时要不要看骰子。骰子由程序掷，一次 1 到 20，只在差距为 0 时看，11 及以上 <user> 占优，其余对方占优。gaps 的 result 只写发生什么，不写点数、门槛、加值和掷法；dice 为 true 时，差距 0 那条写清 <user> 占优和对方占优各是什么结果。`,
  on: `dice 写 true。骰子由程序掷，一次 1 到 20，只在差距为 0 时看，11 及以上 <user> 占优，其余对方占优。gaps 的 result 只写发生什么，不写点数、门槛、加值和掷法；差距 0 那条写清 <user> 占优和对方占优各是什么结果。`,
  off: 'dice 写 false：这张卡不看运气，没有骰子。gaps 的 result 只写发生什么，差距 0 那条写平手时的结果，不提骰子和运气。',
}
const JUDGE_PLAN = (root, dice = '') => `方案里多写一个 judge 字段：{"measure": "比的是什么，两三个字", "when": "什么时候要判定，一句话", "ranks": ["等级名，从低到高"], "rank_path": "tracking 里记 <user> 等级的变量 path", "gaps": [{"gap": 0, "result": "差这么多时是什么结果"}], "known": [{"name": "要紧的人或事", "rank": "它的等级"}], "dice": true}。ranks 3 到 12 个。gaps 从 0 写起，3 到 5 条，最后一条是这么多及以上。known 的等级要在 ranks 里。${JUDGE_LUCK[dice]}tracking.enabled 为 true，<user> 的等级是一个 string 变量，path 用「${root}.比的东西」，show 用 badge，check 写怎么升降。`

/** What the planner is told of the bricks picked. */
export function brickPlanLines(bricks = [], { root, battle = false, dice = '' } = {}) {
  return [
    bricks.includes('books') && BOOKS_PLAN(root),
    bricks.includes('selfcheck') && SELFCHECK_PLAN(battle),
    bricks.includes('events') && EVENTS_PLAN,
    bricks.includes('judge') && JUDGE_PLAN(root, dice),
    bricks.includes('world') && WORLD_PLAN,
    bricks.includes('creation') && creationPlan(root),
  ].filter(Boolean)
}

// ─── What the plan keeps ──────────────────────────────────────────────────

/** Random events as a plan keeps them, or null when the model wrote none. */
export function cleanEvents(raw) {
  if (!raw || typeof raw !== 'object') return null
  const groups = (Array.isArray(raw.groups) ? raw.groups : [])
    .filter(group => group && typeof group === 'object')
    .map(group => ({ when: clip(group.when, 60), items: texts(group.items, MAX_ITEMS, 80) }))
    .filter(group => group.items.length >= MIN_GROUP)
    .slice(0, MAX_GROUPS)
  return { rate: Object.hasOwn(EVENT_RATES, raw.rate) ? raw.rate : 'normal', groups }
}

/** The ladder as a plan keeps it, or null when the model wrote none. */
export function cleanJudge(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ranks = texts(raw.ranks, MAX_RANKS, 16)
  const seen = new Set()
  const gaps = (Array.isArray(raw.gaps) ? raw.gaps : [])
    .filter(item => item && typeof item === 'object' && clip(item.result, 120))
    .map(item => ({ gap: Math.max(0, Math.round(Number(item.gap)) || 0), result: clip(item.result, 120) }))
    .sort((a, b) => a.gap - b.gap)
    .filter(item => !seen.has(item.gap) && seen.add(item.gap))
    .slice(0, MAX_GAPS)
  const known = (Array.isArray(raw.known) ? raw.known : [])
    .filter(item => item && typeof item === 'object' && clip(item.name, 24) && ranks.includes(clip(item.rank, 16)))
    .slice(0, MAX_KNOWN)
    .map(item => ({ name: clip(item.name, 24), rank: clip(item.rank, 16) }))
  return { measure: clip(raw.measure, 8), when: clip(raw.when, 120), ranks, rank_path: cleanPath(clip(raw.rank_path, 60).replace(/[{}\s]+/g, '')), gaps, known, dice: raw.dice !== false }
}

/** What moves on its own as a plan keeps it, or null when the model wrote none. A name is part of a variable's path. */
export function cleanWorld(raw) {
  if (!raw || typeof raw !== 'object') return null
  const seen = new Set()
  const lines = (Array.isArray(raw.lines) ? raw.lines : [])
    .filter(line => line && typeof line === 'object')
    .map(line => ({ name: clip(line.name, 16).replace(/[./\\\s{}$]+/g, ''), stages: texts(line.stages, MAX_STAGES, 24) }))
    .filter(line => line.name && line.stages.length >= MIN_STAGES && !seen.has(line.name) && seen.add(line.name))
    .slice(0, MAX_LINES)
  return { rate: Object.hasOwn(EVENT_RATES, raw.rate) ? raw.rate : 'normal', lines }
}

/** The variable a line's stage is kept in. */
export const worldPath = (name, english) => `${english ? 'World' : '世界'}.${name}`

/** What to check when the planner wrote nothing: enough to hold any card together. */
export const fallbackChecks = english => (english
  ? ['Does every character still sound like themselves?', 'Does this fit what the story has already settled?', 'Does this follow the rules of this world?']
  : ['每个人说话和做事还像不像他自己？', '这段和前文定下的事对不对得上？', '这段合不合这个世界的规矩？'])

// ─── The entries ──────────────────────────────────────────────────────────

const ENTRY_WORDS = {
  zh: { selfcheck: '[每轮]写前自查', selfcheckPurpose: '写之前先过一遍这张卡最容易写崩的几处', events: '[每轮]随机事件', eventsPurpose: '程序每轮抽一次，抽中了就写进故事', judge: '[规则]裁判表', judgePurpose: measure => `按${measure || '等级'}定成败，不放水`, world: '[每轮]世界动向', worldPurpose: '世界自己在动：程序隔几轮抽一件事往前推一步' },
  en: { selfcheck: '[Each turn] Self-check', selfcheckPurpose: 'goes over what this card is most likely to get wrong before writing', events: '[Each turn] Random events', eventsPurpose: 'drawn by the code each turn; what comes up goes into the story', judge: '[Rule] Judge table', judgePurpose: measure => `settles outcomes by ${measure || 'rank'}, with no favors`, world: '[Each turn] World moves', worldPurpose: 'the world moves on its own: every few turns the code picks one thing to take a step' },
}

export const eventToken = index => `[RANDOM_EVENT_${index + 1}]`
export const DICE_TOKEN = '[JUDGE_DICE]'
const DICE_DRAW = '{{roll:1d20}}'
export const WORLD_TOKEN = '[WORLD_MOVE]'

/** The entries the bricks in a plan call for. They are built in code, as the state entries are. */
export function brickEntries(plan, english) {
  const words = ENTRY_WORDS[english ? 'en' : 'zh']
  return [
    plan.selfcheck?.length ? { name: words.selfcheck, type: '状态', part: 'selfcheck', purpose: words.selfcheckPurpose } : null,
    plan.random_events?.groups.length ? { name: words.events, type: '状态', part: 'events', purpose: words.eventsPurpose } : null,
    judgeReady(plan.judge) ? { name: words.judge, type: '状态', part: 'judge', purpose: words.judgePurpose(plan.judge.measure) } : null,
    plan.world_moves?.lines.length ? { name: words.world, type: '状态', part: 'world', purpose: words.worldPurpose } : null,
    creationReady(plan) ? creationEntry(plan, english) : null,
  ].filter(Boolean)
}

const judgeReady = judge => Boolean(judge) && judge.ranks.length >= 2 && judge.gaps.length >= 1

function selfCheckText(items, english) {
  const numbered = items.map((item, i) => `${i + 1}. ${item}`)
  return english
    ? [
      '<self_check_rules>',
      'Every reply opens with this self-check. Anything other rules put at the start of a reply comes after it:',
      `<${SELF_CHECK}>`,
      '1. one line: fine, or what to change',
      '2. ...',
      `</${SELF_CHECK}>`,
      '- Go through each point below in one line. Do not write the story here.',
      '- If something is off, write it right in the story.',
      '- This is not part of the story: the player does not see it, and the story never mentions it.',
      'What to check:',
      ...numbered,
      '</self_check_rules>',
    ].join('\n')
    : [
      '<self_check_rules>',
      '每次回复都从这段自查开始。别的规则要放在开头的内容，一律排在这段后面：',
      `<${SELF_CHECK}>`,
      '1. 一句话：没问题，或者哪里要改',
      '2. ……',
      `</${SELF_CHECK}>`,
      '- 下面每条一句话过一遍，不写正文的内容。',
      '- 查出不对的，就在正文里写成对的。',
      '- 这段不算故事：玩家看不到，正文里也不提它。',
      '要查的：',
      ...numbered,
      '</self_check_rules>',
    ].join('\n')
}

/** The line of 随机事件 that reads a draw. `when`: where it is for, null when it is the only one. */
export function eventLine(index, when, english) {
  if (when === null) return english ? `This turn's draw: ${eventToken(index)}` : `本轮抽到：${eventToken(index)}`
  return english ? `${when || `Group ${index + 1}`}: ${eventToken(index)}` : `${when || `第 ${index + 1} 组`}：${eventToken(index)}`
}

function eventsText({ groups }, english) {
  const draws = groups.map((group, i) => eventLine(i, groups.length === 1 ? null : group.when, english))
  return english
    ? [
      '<random_event_rules>',
      'The code draws a random event for you each turn; the result is below. Go by it, and arrange no chance meeting or mishap of your own.',
      ...draws,
      ...(groups.length > 1 ? ['- Read only the line that fits where the story is now. The other lines are void.'] : []),
      `- If it says ${NOTHING.en}: this rule is void this turn. Nothing unplanned happens.`,
      '- If it could not happen here, if the scene is at a point that must not be broken, or if the last event is not over: this rule is void this turn. Do not put anything else in its place.',
      '- Otherwise it happens this turn: bring it in through the scene as it stands and show how it arrives. Do not write how it ends. What happens next is up to <user>.',
      '</random_event_rules>',
    ].join('\n')
    : [
      '<random_event_rules>',
      '程序每轮替你抽一次随机事件，结果在下面。照这个结果写，不要自己另外安排偶遇或意外。',
      ...draws,
      ...(groups.length > 1 ? ['- 只看和当前场合对得上的那一行，其余的作废。'] : []),
      `- 抽到「${NOTHING.zh}」：这条作废，这一轮不安排任何意外。`,
      '- 这件事不可能出现在这里、眼下这段戏不能打断、或者上一件事还没结束：这条作废，也不要换成别的事。',
      '- 否则这件事这一轮发生：顺着当前场景带进来，写它怎么出现，不写结果，接下来怎么办留给 <user>。',
      '</random_event_rules>',
    ].join('\n')
}

/** The line of 裁判表 that reads the die. */
export const diceLine = english => (english
  ? `This turn's die: ${DICE_TOKEN} (1 to 20, used only when they are level: 11 or more favors <user>, the rest the other side).`
  : `本轮骰子：${DICE_TOKEN}（1 到 20，只在差 0 时用：11 及以上<user>占优，其余对方占优）`)

function judgeText(judge, english) {
  const measure = judge.measure || (english ? 'rank' : '等级')
  const last = judge.gaps.at(-1).gap
  const gaps = judge.gaps.map(({ gap, result }) => (english ? `- ${gap === last && gap > 0 ? `${gap} or more` : gap} apart: ${result}` : `- 差 ${gap}${gap === last && gap > 0 ? ' 及以上' : ''}：${result}`))
  // Ranks come numbered, here and in what is known: real models miscounted steps on a list (4 apart written as 2), and subtract fine.
  const numbered = judge.ranks.map((rank, i) => `${i + 1} ${rank}`).join(english ? ', ' : '、')
  const numberOf = rank => judge.ranks.indexOf(rank) + 1
  const known = judge.known.map(({ name, rank }) => `${name} ${rank}${numberOf(rank) ? (english ? ` (${numberOf(rank)})` : `（${numberOf(rank)}）`) : ''}`).join(english ? ', ' : '；')
  const when = judge.when || (english ? 'when <user> goes up against someone, or tries something beyond their rank' : '<user> 和别人较量，或者想做超出自己等级的事时')
  return english
    ? [
      '<judge_rules>',
      `In this card ${measure} settles outcomes. Fine words do not, and <user> gets no favors for being the lead.`,
      `Judge ${when}. At any other time this rule is void: write no judgment.`,
      `Ranks, low to high: ${numbered}`,
      ...(known ? [`Known ranks: ${known}`] : []),
      ...(judge.rank_path ? [`The rank of <user> is the variable ${judge.rank_path}.`] : []),
      'The gap is the two rank numbers subtracted:',
      ...gaps,
      ...(judge.dice ? [diceLine(true)] : []),
      'When you judge, write this before the story:',
      `<${JUDGE}>`,
      'Match: rank of <user> (its number) against the other side (its number)',
      'Gap: a number',
      'Result: as above',
      `</${JUDGE}>`,
      'The story must end the way this says. The story itself never mentions ranks as numbers, gaps or dice.',
      '</judge_rules>',
    ].join('\n')
    : [
      '<judge_rules>',
      `这张卡靠「${measure}」定成败，不看话说得多漂亮，也不因为 <user> 是主角就放水。`,
      `要判定的时候：${when}。其余时候这条作废，不写判定。`,
      `等级从低到高：${numbered}`,
      ...(known ? [`已知的等级：${known}`] : []),
      ...(judge.rank_path ? [`<user> 的等级看变量 ${judge.rank_path}。`] : []),
      '差距是两边等级的序号相减：',
      ...gaps,
      ...(judge.dice ? [diceLine(false)] : []),
      '要判定时，在正文前写：',
      `<${JUDGE}>`,
      '对比：<user> 的等级（序号）对 对方的等级（序号）',
      '差距：数字',
      '结果：照上面写',
      `</${JUDGE}>`,
      '正文的结果必须和这段一致。正文里不写差距和骰子这些词。',
      '</judge_rules>',
    ].join('\n')
}

/** The line of 世界动态's rule that reads the draw. */
export const worldLine = english => (english ? `The code draws what moves this turn: ${WORLD_TOKEN}` : `程序每轮抽这一轮动的是哪件：${WORLD_TOKEN}`)

function worldText({ lines }, english) {
  const line = ({ name, stages }) => (english ? `- ${name} (variable ${worldPath(name, true)}): ${stages.join(' → ')}` : `- ${name}（变量 ${worldPath(name, false)}）：${stages.join(' → ')}`)
  return english
    ? [
      '<world_move_rules>',
      'The world moves without <user>. Each of these has come as far as its variable says:',
      ...lines.map(line),
      worldLine(true),
      `- If it says ${NOTHING.en}: this rule is void this turn. Nothing moves.`,
      '- If that one is already at its last step: this rule is void this turn.',
      '- Otherwise it moves one step on: set its variable to the next step, and let <user> catch it in a line or two, as news, talk or a change in what is around them. Do not stop the scene for it, and do not make it a scene of its own.',
      '- What <user> does can change these: when the story has really turned one, set its variable to where it now stands.',
      '</world_move_rules>',
    ].join('\n')
    : [
      '<world_move_rules>',
      '世界不等 <user>，自己在动。下面这几件事各走到哪一步，看对应的变量：',
      ...lines.map(line),
      worldLine(false),
      `- 抽到「${NOTHING.zh}」：这条作废，这一轮世界没有新变化。`,
      '- 抽到的这件事已经在最后一步：这条作废。',
      '- 否则它往后走一步：把变量改成下一步，用一两句让 <user> 知道，可以是消息、闲话或身边的变化。不打断眼下的事，也不单写成一段戏。',
      '- <user> 的所作所为能改变这些事：故事里真的改变了，就把变量改成现在的样子。',
      '</world_move_rules>',
    ].join('\n')
}

// A line of 世界动态's rule as worldText writes it: the head (name and variable) is the code's, the stages the card's.
const WORLD_RULE_LINE = /^(- (.+?)(?:（变量 | \(variable ).+?[）)](?:：|: ))(.+)$/

/** The lines a 世界动态 rule lists: [{ head, name, stages }]. */
export function worldLines(content) {
  return String(content ?? '').split('\n').flatMap(line => {
    const found = WORLD_RULE_LINE.exec(line)
    return found ? [{ head: found[1], name: found[2], stages: found[3].split(' → ') }] : []
  })
}

/** A 世界动态 rule with other stages for some of its lines: `stages` maps a name to them. */
export const withWorldStages = (content, stages) => content.split('\n').map(line => {
  const found = WORLD_RULE_LINE.exec(line)
  return found && stages.has(found[2]) ? `${found[1]}${stages.get(found[2]).join(' → ')}` : line
}).join('\n')

/** A brick entry's text. */
export function brickContent(part, plan, english, root = english ? 'Protagonist' : '主角') {
  if (part === 'selfcheck') return selfCheckText(plan.selfcheck, english)
  if (part === 'events') return eventsText(plan.random_events, english)
  if (part === 'judge') return judgeText(plan.judge, english)
  if (part === 'world') return worldText(plan.world_moves, english)
  if (part === 'creation') return creationText(plan, english, root)
  return ''
}

// ─── The regex ────────────────────────────────────────────────────────────

/**
 * A block in a reply, whole. One still being written (or never closed) goes up to the first blank line, not to
 * the end: a model that leaves out the closing tag must not take the story with it.
 */
export const blockFind = tag => `/<${tag}>(?:[\\s\\S]*?<\\/${tag}>|(?![\\s\\S]*<\\/${tag}>)[\\s\\S]*?(?:\\n\\s*\\n|$))\\s*/gi`

/** The two scripts that keep a block out of what the model reads back and out of what the player sees. */
// keepLast leaves the block on the last two replies (depth 1 and 3), for a block written every turn. DeepSeek wrote it on
// 11 of 24 turns with none of them in the history and stopped for good once it had missed; on 65 of 72 with the last one
// left in, where one miss still left nothing to go by; on 35 of 36 with two.
export const KEPT_DEPTH = 4
export const hiddenBlock = (tag, id, names, { keepLast = false } = {}) => [
  regexEntry(`${id}-prompt`, names.fromModel, blockFind(tag), '', { promptOnly: true, ...(keepLast ? { minDepth: KEPT_DEPTH } : {}) }),
  regexEntry(`${id}-display`, names.fromPlayer, blockFind(tag), '', { markdownOnly: true }),
]

const SCRIPT_WORDS = {
  zh: { selfFromModel: '对模型隐藏更早的写前自查', selfFromPlayer: '对玩家隐藏写前自查', draw: n => `随机事件抽取 ${n}`, dice: '裁判表骰子', judgeFromModel: '对模型隐藏判定', judgeShown: '显示判定结果', judgeHidden: '隐藏判定的其余部分', judgeLine: '〔判定：$1〕', world: '世界动向抽取' },
  en: { selfFromModel: 'Hide older self-checks from the model', selfFromPlayer: 'Hide the self-check from the player', draw: n => `Random event draw ${n}`, dice: 'Judge table die', judgeFromModel: 'Hide the judgment from the model', judgeShown: 'Show the judgment', judgeHidden: 'Hide the rest of the judgment', judgeLine: '[Judgment: $1]', world: 'World move draw' },
}

// A name in {{random::…}} must not end the macro, and $ would read as a group in a replacement.
const drawItem = text => text.replace(/::|[{}$]/g, ' ').trim()

/** {{random::…}} that comes up with an item about one time in `rate`, and with nothing the rest. */
export function eventDraw(items, rate, nothing) {
  const blanks = items.length * (EVENT_RATES[rate] - 1)
  return `{{random::${[...items.map(drawItem), ...Array.from({ length: blanks }, () => nothing)].join('::')}}}`
}

/** What finds a token in an entry. */
export const tokenFind = token => `/${token.replace(/[[\]]/g, '\\$&')}/g`

const worldScript = (id, name, token, draw) => regexEntry(id, name, tokenFind(token), draw, { placement: [5], promptOnly: true })

const scriptWords = english => SCRIPT_WORDS[english ? 'en' : 'zh']

/** What keeps a self-check from the model and from the player: { fromModel, fromPlayer }. */
export function selfCheckScripts(english) {
  const { selfFromModel: fromModel, selfFromPlayer: fromPlayer } = scriptWords(english)
  const [model, player] = hiddenBlock(SELF_CHECK, 'cicatavern-self-check', { fromModel, fromPlayer }, { keepLast: true })
  return { fromModel: model, fromPlayer: player }
}

/** What keeps a judgment from the model, and leaves the player one line of it: { fromModel, shown, rest }. */
export function judgeScripts(english) {
  const { judgeFromModel, judgeShown, judgeHidden, judgeLine } = scriptWords(english)
  return {
    fromModel: regexEntry('cicatavern-judge-prompt', judgeFromModel, blockFind(JUDGE), '', { promptOnly: true }),
    // One plain line of text: it reads the same in a chat, a text box or SillyTavern, and needs no frame.
    shown: regexEntry('cicatavern-judge-display', judgeShown, `/<${JUDGE}>[\\s\\S]*?(?:结果|Result)\\s*[:：]\\s*([^\\n<]*)[\\s\\S]*?<\\/${JUDGE}>\\s*/gi`, `${judgeLine}\n\n`, { markdownOnly: true }),
    rest: regexEntry('cicatavern-judge-hide', judgeHidden, blockFind(JUDGE), '', { markdownOnly: true }),
  }
}

export const diceScript = english => worldScript('cicatavern-judge-dice', scriptWords(english).dice, DICE_TOKEN, DICE_DRAW)

/** The script that draws a group. `draw`: what it comes up with, '' while the list is still to be written. */
export const worldMoveScript = (draw, english) => worldScript('cicatavern-world-move', scriptWords(english).world, WORLD_TOKEN, draw)
export const eventScript = (index, draw, english) => worldScript(`cicatavern-event-${index + 1}`, scriptWords(english).draw(index + 1), eventToken(index), draw)

/** A list as its draw, in a card's language. */
export const drawOf = (items, rate, english) => eventDraw(items, rate, NOTHING[english ? 'en' : 'zh'])

/** What a draw holds: { items, rate }, or null when it is no {{random}} of events. */
export function readDraw(text) {
  const inside = /^\{\{random::([\s\S]*)\}\}$/.exec(String(text ?? '').trim())?.[1]
  if (!inside) return null
  const all = inside.split('::')
  const items = all.filter(item => !Object.values(NOTHING).includes(item))
  if (!items.length) return null
  const odds = all.length / items.length
  return { items, rate: Object.keys(EVENT_RATES).reduce((best, rate) => (Math.abs(EVENT_RATES[rate] - odds) < Math.abs(EVENT_RATES[best] - odds) ? rate : best)) }
}

/** The regex scripts the bricks in a plan call for. */
export function brickScripts(plan, english) {
  const scripts = []
  if (plan.selfcheck?.length) scripts.push(...Object.values(selfCheckScripts(english)))
  plan.random_events?.groups.forEach((group, i) => {
    scripts.push(eventScript(i, drawOf(group.items, plan.random_events.rate, english), english))
  })
  if (judgeReady(plan.judge)) {
    if (plan.judge.dice) scripts.push(diceScript(english))
    scripts.push(...Object.values(judgeScripts(english)))
  }
  if (creationReady(plan)) scripts.push(...creationScripts(plan, english))
  if (plan.world_moves?.lines.length) scripts.push(worldMoveScript(eventDraw(plan.world_moves.lines.map(line => line.name), plan.world_moves.rate, NOTHING[english ? 'en' : 'zh']), english))
  return scripts
}

// ─── What a brick costs ───────────────────────────────────────────────────

// What the model writes each turn for a line of the self-check, and for a judgment when one comes up.
const CHECK_LINE = 25
const JUDGMENT = 60

/** What the bricks add: { always: the characters the rules take up, each turn: what the model writes more }. */
export function brickCost(plan, english) {
  // 建角 comes in with one message and is gone: nothing that stays.
  const entries = brickEntries(plan, english).filter(entry => entry.part !== 'creation').reduce((sum, entry) => sum + brickContent(entry.part, plan, english).length, 0)
  const check = (plan.selfcheck?.length ?? 0) * CHECK_LINE
  // The last two replies' self-checks are read again with the history.
  return { always: entries + check * 2, reply: check + (judgeReady(plan.judge) ? JUDGMENT : 0) }
}

/** What a brick that was picked is still missing, by brick. */
export const brickGaps = plan => [
  ...(plan.bricks?.includes('events') && !plan.random_events?.groups.length ? ['events'] : []),
  ...(plan.bricks?.includes('judge') && !judgeReady(plan.judge) ? ['judge'] : []),
  ...(plan.bricks?.includes('world') && !plan.world_moves?.lines.length ? ['world'] : []),
  ...(plan.bricks?.includes('creation') && !creationReady(plan) ? ['creation'] : []),
]
