// What the model is asked while a card is being created, and how its answers
// are read back. The method follows the tavern-cards way of building a card
// (settle the world and the core character first, keep the user's own words,
// say out loud what was assumed, keep the lore terse and concrete), written
// here in this app's own words.
import { configureEntries } from './configure.mjs'
import { DISCUSS_REFERENCE_RULES, DISCUSS_STRUCTURE_RULES, PLAN_REFERENCE_RULES, PLAN_STRUCTURE_RULES, referenceBlock, referenceRules, userMessage } from './references.mjs'
import { defaultShow } from './status.mjs'
import { BRICKS, EVENT_RATES, SHOWS, STATUS_THEMES, bookText, bookValue, cleanPalette, cleanPath, cleanScale, limitsOf, needsVariables } from '../../web/shared/status.js'
import { cleanCreation, creationVariables } from './creation.mjs'
import { BRICK_TALK, brickEntries, brickGaps, brickPlanLines, cleanEvents, cleanJudge, cleanWorld, fallbackChecks, worldPath } from './bricks.mjs'
import { ATTRIBUTES, ATTRIBUTE_POINTS, AVERAGE, EFFECTS, STRENGTHS, cleanKit } from '../../web/shared/game/sheet.js'
import { SKILLS } from '../../web/shared/game/battle.js'
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
export const WRITING_RULES = [
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
// A plan with bricks or a bigger scale. Real models spent 21~27k of a 32k cap thinking about one, and were cut off halfway
// through the second character. Nothing else about the request depends on this, and a plain card keeps LONG_TOKENS.
const BIG_PLAN_TOKENS = 64000
const planTokens = options => (options.bricks?.length || options.scale ? BIG_PLAN_TOKENS : LONG_TOKENS)

// ─── Kinds of card ────────────────────────────────────────────────────────
// What the player says the card is, before or while talking: it shapes the
// questions, the cast the plan calls for and the openings. '' = not said; the
// guide goes by the talk.
export const CARD_TYPES = {
  single: {
    talk: '一个角色：故事围着一个核心角色和 <user> 的关系展开。',
    cast: '核心角色 1 个；配角 0 到 3 个，每个都要有在故事里的作用。',
  },
  ensemble: {
    talk: '几个角色（群像）：两到四个核心角色，各有自己想要的东西、和 <user> 的关系，彼此之间也有关系和张力。早一点问清有哪几个人、他们之间是什么关系。',
    cast: '核心角色 2 到 4 个，各有目的、和 <user> 的关系不同，彼此之间也有关系和张力；配角 0 到 4 个。',
  },
  world: {
    talk: '一个世界（冒险、探索、模拟）：主角是这个世界，模型当叙述者和主持人，<user> 在里面行动。先问清舞台、规则、地点、势力和 <user> 能做什么，再问会遇到的关键人物；人物不必一开始就定死。',
    cast: '这是一张以世界为主的卡：地点、势力和规则写得具体，至少 3 个地点；核心角色 1 到 2 个关键人物（同伴、引路人或对手）；配角 3 到 8 个，各自属于某个地点或势力，给出能被遇到的理由。扮演准则里写明模型是叙述者，描写 <user> 所到之处和遇到的人，不替 <user> 行动。',
  },
  game: {
    talk: '带玩法的卡（数值、成长、关系阶段）：除了人和故事，要商量清楚玩法：记录哪些会变化的数值、它们怎么涨落、到了什么程度剧情会变。这一类一定要记录数值，不必问要不要，直接问记哪些、怎么变。',
    cast: '核心角色 1 到 3 个；配角 0 到 4 个。这是一张带玩法的卡：tracking.enabled 为 true，变量 4 到 10 个，check 写清什么事让它怎么变；扮演准则里写明数值到了什么程度剧情或角色态度会变。',
  },
}

export const cleanCardType = value => (Object.hasOwn(CARD_TYPES, value) ? value : '')

// What the player picks about the card before talking (创作角色卡's home), in groups that combine:
// who the story is about, a world of its own, the characters' gender, the kinds of play (each with
// its numbers), and the format (plain text, MVU variables, MVU with a styled status bar and its look).
// Each pick adds a line for the guide (talk) and one for the planner (plan).
export const CARD_CHOICES = {
  cast: {
    single: { talk: CARD_TYPES.single.talk, plan: CARD_TYPES.single.cast },
    ensemble: { talk: CARD_TYPES.ensemble.talk, plan: CARD_TYPES.ensemble.cast },
  },
  gender: {
    female: { talk: '核心角色是女性。', plan: '核心角色都是女性（配角不限）。' },
    male: { talk: '核心角色是男性。', plan: '核心角色都是男性（配角不限）。' },
    mixed: { talk: '核心角色男女都有。', plan: '核心角色男女都有。' },
  },
  // The player's own (<user>): how the card calls and refers to them. Not picked, nothing is said and the rule
  // against 他/她 for <user> stands, as it always did.
  userGender: {
    female: { talk: '<user> 是女性：样例和试写里指代 <user> 用「她」，称呼按女性来。', plan: '<user> 是女性：指代 <user> 用「她」（别的语言用对应的代词），称呼和关系的叫法也按女性来。' },
    male: { talk: '<user> 是男性：样例和试写里指代 <user> 用「他」，称呼按男性来。', plan: '<user> 是男性：指代 <user> 用「他」（别的语言用对应的代词），称呼和关系的叫法也按男性来。' },
  },
  play: {
    bond: '好感与关系阶段（好感、信任这类关系数值，核心角色的性格随它分阶段）',
    growth: '成长与能力（等级、修为、技能这类会提升的数值，以及提升的条件）',
    resources: '经营与资源（金钱、物资、声望这类有收有支的资源和代价）',
    countdown: '倒计时与事件（剩余天数或期限，到了节点就发生事件）',
    explore: '探索与线索（地点一个个解锁、线索一条条收集，够了才揭开真相）',
    battle: '战斗与成长（内置规则：检定、回合制战斗、背包、任务、升级）',
  },
  format: {
    text: { talk: '纯文本卡：不记录数值，不用问状态栏。', plan: 'tracking.enabled 为 false：这张卡不记录数值。' },
    mvu: { talk: '要记录会变化的数值，显示在状态栏里（文字显示就好）。', plan: 'tracking.enabled 为 true，变量 3 到 10 个。' },
    'mvu-ui': { talk: '要记录会变化的数值，配一个美化的状态栏。', plan: 'tracking.enabled 为 true，变量 3 到 10 个；每个变量的 show 选最合适的显示方式（meter 进度条、number、text、tags、flag）。' },
  },
}
const WORLD_TALK = '重世界观（冒险、探索、模拟）：世界本身也是主角，模型兼任叙述者和主持人，<user> 在里面行动。先问清舞台、规则、地点、势力和 <user> 能做什么，人物不必一开始就定死。'
// 战斗与成长 runs on the app's rules, whatever the format: the numbers are not the card's to keep.
const BATTLE_TALK = '这张卡用应用内置的规则：生命、气力、等级、背包、任务、检定和战斗都由程序算，不用记成变量。要和用户商量的是：玩家开局擅长什么、会哪几招、带什么东西，这个世界常见什么敌人。'
const BATTLE_PLAN = `这张卡用应用内置的规则：生命、气力、等级、经验、背包、任务、检定和战斗结算都由程序算。tracking 里不要有这些数值，扮演准则也不写战斗流程和伤害。方案里多写一个 game 字段：{"attributes": {"body": 12, "grace": 10, "mind": 11, "charm": 10}, "skills": [{"name": "技能名", "kind": "strike"}], "things": [{"name": "物品名", "count": 2, "type": "heal", "size": "medium"}], "foes": [{"name": "敌人名", "looks": "English tags for its picture", "moves": ["招式名"]}]}。attributes 是 ${ATTRIBUTES.map(item => `${item.id}（${item.name}）`).join('、')}，常人 ${AVERAGE}，比 ${AVERAGE} 多出来的加起来不超过 ${ATTRIBUTE_POINTS} 点，贴合 <user> 的身份。skills 2 到 4 个，名字贴合题材，kind 从 ${Object.keys(SKILLS).join('、')} 选（重击、群攻、连击、中毒、眩晕、治疗、增益）。things 是开局带的 0 到 5 样东西，type 从 ${EFFECTS.join('、')} 选（回血、回气力、伤害、解毒、增益、没有效果），size 是 ${STRENGTHS.join('、')}。foes 写这个世界常见的 2 到 6 种敌人。"companions" 是和 <user> 一起行动、会一起打架的固定同伴：[{"name": "同伴名", "keys": ["别称"], "attributes": {...}, "skills": [{"name": "技能名", "kind": "strike"}], "start": true}]，从这张卡的主要角色里选 0 到 3 个，属性同样按常人 ${AVERAGE}、多出来的不超过 ${ATTRIBUTE_POINTS} 点、贴合人设，技能 1 到 3 个，start 写开局是否已经同行；<user> 独自行动的故事写 []。game 里再写："energy" 是这个世界对气力的叫法，两三个字；"words" 是这个世界对属性、生命、敌人档位这些的叫法，和默认（体魄、灵巧、心智、魅力、生命、杂兵、普通、精英、首领、技能、行囊、经验、队伍）一样就不写，比如怪兽养成写 {"body": "力量", "grace": "速度", "mind": "智力", "charm": "羁绊", "life": "HP", "skill": "必杀技", "party": "伙伴"}，键是 body、grace、mind、charm、life、minion、normal、elite、boss、skill、bag、experience、party；"ranks" 是这个世界明确的等级，从低到高，只写大的等级，没有就写 []；"rank_span"：差一级就很难打写 wide，差几级才打不过写 narrow；"sanity"：这个世界的恐怖会伤到人的心智、要记理智就写 true，否则 false。世界设定和开场里要有能打起来的理由。`

// 卡的规模: a bigger card is planned short and written in batches. The plan is the catalog: a line for each side
// character and place, which the player can look through before anything is written.
const SCALE_TALK = {
  standard: '这张卡的世界比一般的大：地点、势力和配角都多一些，早一点问清版图和主要势力，名单可以交给你。',
  epic: '这张卡是大作：世界很大，地点、势力和配角都很多。先定版图、势力和主线，名单大多交给你，不用逐个问。',
}
const SCALE_SIZE = { standard: { places: 6, factions: 3, npcs: 8 }, epic: { places: 12, factions: 5, npcs: 20 } }
const scalePlan = scale => {
  const most = limitsOf(scale)
  const least = SCALE_SIZE[scale]
  return `这张卡的世界比一般的大：地点 ${least.places} 到 ${most.places} 个，势力 ${least.factions} 到 ${most.factions} 个，配角 ${least.npcs} 个以上，角色一共最多 ${most.characters} 个，事件最多 ${most.events} 个，变量按需要写，最多 ${most.variables} 个，不受上面的数目限制。配角和地点写短：配角只写 name、kind、aliases、identity、role，地点的 description 一句话，之后会分批展开。名字彼此不要太像，别名不要重复，它们是触发设定的关键词。`
}
const PAGES_PLAN = '状态栏分页：每个变量多写一个 page 字段，页名两三个字，把状态栏分成 2 到 4 页，按这张卡最自然的分法，一页至少两项。'
const COLORS_PLAN = '方案里多写一个 status_colors 字段：{"bg": "#背景色", "ink": "#文字色", "accent": "#强调色"}，配合这张卡的气氛，文字要看得清。'
const LOOKS = [...STATUS_THEMES, 'auto']

const WORLD_PLAN = '这张卡重世界观：地点、势力和规则写得具体，至少 3 个地点；配角各自属于某个地点或势力，给出能被遇到的理由；扮演准则里写明模型兼任叙述者，描写 <user> 所到之处和遇到的人，不替 <user> 行动。'
const pick = (value, group) => (Object.hasOwn(CARD_CHOICES[group], value) ? value : '')

/**
 * The picks as kept with a draft. A draft from before them has a card type: it maps
 * onto them (几个角色 = a cast of several, 带玩法 = relationship and growth with a styled bar).
 */
export function cleanCardOptions(raw, cardType = '') {
  const legacy = { single: { cast: 'single' }, ensemble: { cast: 'ensemble' }, world: { world: true }, game: { play: ['bond', 'growth'], format: 'mvu-ui' } }[cleanCardType(cardType)] ?? {}
  const value = raw && typeof raw === 'object' ? raw : legacy
  const play = (Array.isArray(value.play) ? value.play : []).filter((p, i, all) => Object.hasOwn(CARD_CHOICES.play, p) && all.indexOf(p) === i)
  // 裁判表 and 战斗与成长 are two ways of judging: the rules win (web/shared/status.js settlePicks has the page's way).
  const bricks = (Array.isArray(value.bricks) ? value.bricks : []).filter((b, i, all) => BRICKS.includes(b) && all.indexOf(b) === i && !(b === 'judge' && play.includes('battle')))
  const picked = pick(value.format, 'format')
  const format = picked === 'text' && needsVariables(bricks) ? 'mvu-ui' : picked
  const scale = cleanScale(value.scale)
  return {
    cast: pick(value.cast, 'cast'),
    world: value.world === true,
    gender: pick(value.gender, 'gender'),
    // Only when picked: a draft from before it, or one left at 不限, keeps its options as they were.
    ...(pick(value.userGender, 'userGender') ? { userGender: value.userGender } : {}),
    play,
    format,
    statusTheme: format === 'mvu-ui' && LOOKS.includes(value.statusTheme) ? value.statusTheme : format === 'mvu-ui' ? 'plain' : '',
    // 高级选项: there only when picked, so a card without them is kept as it always was.
    ...(bricks.length ? { bricks } : {}),
    ...(bricks.includes('events') && Object.hasOwn(EVENT_RATES, value.eventRate ?? '') ? { eventRate: value.eventRate } : {}),
    ...(bricks.includes('judge') && ['on', 'off'].includes(value.judgeDice) ? { judgeDice: value.judgeDice } : {}),
    ...(bricks.includes('world') && Object.hasOwn(EVENT_RATES, value.worldRate ?? '') ? { worldRate: value.worldRate } : {}),
    ...(scale ? { scale } : {}),
    ...(format === 'mvu-ui' && value.statusPages === true ? { statusPages: true } : {}),
    ...(typeof value.formatBefore === 'string' && (value.formatBefore === '' || Object.hasOwn(CARD_CHOICES.format, value.formatBefore)) ? { formatBefore: value.formatBefore } : {}),
  }
}

/** What the picks tell the guide (talk), the planner (plan) and the ideas (story: no format). */
export function optionLines(options, language = DEFAULT_LANGUAGE) {
  const o = cleanCardOptions(options)
  const battle = o.play.includes('battle')
  // Told apart from the rest: those are numbers of the card's own, this is the app's.
  const playList = o.play.filter(p => p !== 'battle').map(p => CARD_CHOICES.play[p]).join('、')
  const talk = [
    o.cast && CARD_CHOICES.cast[o.cast].talk,
    o.world && WORLD_TALK,
    o.gender && CARD_CHOICES.gender[o.gender].talk,
    o.userGender && CARD_CHOICES.userGender[o.userGender].talk,
    playList && (o.format === 'text'
      ? `玩法：${playList}。这是纯文本卡，玩法靠叙述体现，不记录数值。`
      : `玩法：${playList}。要和用户商量清楚记录哪些会变化的数值、怎么涨落、到了什么程度剧情会变；不必问要不要记录。`),
    battle && BATTLE_TALK,
    o.format && CARD_CHOICES.format[o.format].talk,
    ...(o.bricks ?? []).map(brick => BRICK_TALK[brick]),
    o.scale && SCALE_TALK[o.scale],
  ].filter(Boolean)
  const plan = [
    o.cast ? CARD_CHOICES.cast[o.cast].plan : o.world ? '核心角色 1 到 2 个关键人物（同伴、引路人或对手）；配角 3 到 8 个。' : '',
    o.world && WORLD_PLAN,
    o.gender && CARD_CHOICES.gender[o.gender].plan,
    o.userGender && CARD_CHOICES.userGender[o.userGender].plan,
    playList && (o.format === 'text'
      ? `玩法写进扮演准则，由叙述体现：${playList}。`
      : `tracking.enabled 为 true，变量围绕这些玩法：${playList}；check 写清什么事让它怎么变；扮演准则写明数值到了什么程度剧情或角色态度会变。`),
    battle && BATTLE_PLAN,
    o.format && CARD_CHOICES.format[o.format].plan,
    ...brickPlanLines(o.bricks, { root: playerRoot(language), battle, dice: o.judgeDice }),
    o.scale && scalePlan(o.scale),
    o.statusPages && PAGES_PLAN,
    o.statusTheme === 'auto' && COLORS_PLAN,
  ].filter(Boolean)
  const story = [o.cast && CARD_CHOICES.cast[o.cast].talk, o.world && WORLD_TALK, o.gender && CARD_CHOICES.gender[o.gender].talk, o.play.length > 0 && `玩法：${o.play.map(p => CARD_CHOICES.play[p]).join('、')}`].filter(Boolean)
  return { talk, plan, story }
}

/**
 * The plan as the picks have it, whatever the planner wrote: a plain-text card tracks
 * nothing; the status bar is styled (with the look picked) unless the format says plain MVU.
 */
export function withCardOptions(plan, options) {
  if (!plan) return plan
  const o = cleanCardOptions(options)
  const tracking = o.format === 'text' ? { ...plan.tracking, enabled: false } : plan.tracking
  // A card that fights has its rules even when the planner left them out: they have their defaults.
  const game = o.play.includes('battle') ? plan.game ?? cleanKit({}) : null
  const palette = o.statusTheme === 'auto' ? plan.status_colors ?? null : null
  const status = { ui: o.format !== 'mvu', theme: o.statusTheme || 'plain', ...(palette ? { palette } : {}), ...(o.statusPages ? { pages: true } : {}) }
  return withBricks({ ...editUserGender(plan, o.userGender), tracking, game, status }, o)
}

/** The plan with the player's gender set ('' = not said: no field, as plans were before it). */
export function editUserGender(plan, gender) {
  const role = { ...plan.user_role }
  delete role.gender
  return { ...plan, user_role: Object.hasOwn(CARD_CHOICES.userGender, gender ?? '') ? { ...role, gender } : role }
}

const BOOK_WORDS = {
  zh: { name: '背包', columns: ['数量', '说明'], check: '得到东西加一行，用掉或失去就减数量或删掉这一行', level: '等级', levelCheck: '随故事升降', worldCheck: '世界动向抽中这件事时改成下一步', worldPage: '世界' },
  en: { name: 'Bag', columns: ['Count', 'Note'], check: 'add a row when something is gained; lower the count or remove the row when it is used or lost', level: 'Rank', levelCheck: 'moves with the story', worldCheck: 'set to the next step when the world move draws this', worldPage: 'World' },
}

/**
 * The plan with what the bricks picked call for, whatever the planner wrote: a brick not picked is taken out, one
 * picked has what it cannot go without. A plan without bricks comes back as it is.
 */
function withBricks(plan, o) {
  const picked = o.bricks ?? []
  const fields = { selfcheck: 'selfcheck', events: 'random_events', judge: 'judge', world: 'world_moves', creation: 'creation' }
  const stray = Object.entries(fields).filter(([brick, field]) => !picked.includes(brick) && plan[field])
  if (!picked.length && !stray.length && !o.scale) return plan
  const next = { ...plan, ...(picked.length ? { bricks: picked } : {}), ...(o.scale ? { scale: o.scale } : {}) }
  if (!picked.length) delete next.bricks
  for (const [, field] of stray) delete next[field]
  const language = planLanguage(next)
  const english = englishCard(language)
  const words = BOOK_WORDS[english ? 'en' : 'zh']
  const root = playerRoot(language)
  const variables = [...next.tracking.variables]
  if (picked.includes('selfcheck') && !next.selfcheck?.length) next.selfcheck = fallbackChecks(english)
  if (picked.includes('events')) {
    const events = next.random_events ?? { rate: 'normal', groups: [] }
    next.random_events = { ...events, rate: o.eventRate || events.rate }
  }
  if (picked.includes('books') && !variables.some(v => v.type === 'book')) {
    variables.push({ path: `${root}.${words.name}`, label: words.name, type: 'book', columns: words.columns, initial: '', range: '', check: words.check, show: 'table' })
  }
  if (picked.includes('judge') && next.judge) {
    const measure = next.judge.measure || words.level
    const path = next.judge.rank_path || `${root}.${measure}`
    if (next.judge.ranks.length && !variables.some(v => v.path === path)) variables.push({ path, label: clip(measure, 12), type: 'string', initial: next.judge.ranks[0], range: '', check: words.levelCheck, show: 'badge' })
    next.judge = { ...next.judge, rank_path: path, dice: o.judgeDice ? o.judgeDice === 'on' : next.judge.dice }
  }
  if (picked.includes('world') && next.world_moves) {
    next.world_moves = { ...next.world_moves, rate: o.worldRate || next.world_moves.rate }
    for (const { name, stages } of next.world_moves.lines) {
      const path = worldPath(name, english)
      if (!variables.some(v => v.path === path)) variables.push({ path, label: clip(name, 12), type: 'string', initial: stages[0], range: '', check: words.worldCheck, show: 'badge', ...(o.statusPages ? { page: words.worldPage } : {}) })
    }
  }
  if (picked.includes('creation') && next.creation) variables.push(...creationVariables(next.creation, root, variables, english))
  const enabled = next.tracking.enabled || (needsVariables(picked) && variables.length > 0)
  next.tracking = { ...next.tracking, enabled, variables }
  settleGreetingStates(next)
  next.entries = planEntries(next)
  next.warnings = planWarnings(next)
  return next
}

// How many openings the plan asks for: the player's pick, else 2.
export const MAX_GREETINGS = 6
export const cleanGreetingCount = value => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_GREETINGS, n) : 0
}

// ─── Inspiration (给我灵感) ───────────────────────────────────────────────
// A few ideas to start from. Each grows from a seed drawn here, a stage, a bond
// and a twist, so a batch is spread out rather than five takes on what a model
// thinks of first.
const STAGES = ['现代都市的深夜', '海边小镇', '寄宿制高中', '大学社团', '出版社、律所、医院这样的职场', '古代宫廷', '江湖门派', '修仙宗门', '民国上海', '蒸汽朋克城邦', '赛博朋克巨城', '末日废土', '星际航船', '西幻王国', '魔法学院', '雾气笼罩的怪谈小镇', '民俗山村', '灵异事务所', '冒险者公会', '娱乐圈', '电竞战队', '豪门家族', '夜场与地下秩序', '悬案缠身的侦探社', '异世界', '人与异族共居的城市', '夜族统治的城市', '战争前线', '孤岛', '时间循环的小城', '游戏世界', '改写过的童话']
const BONDS = ['青梅竹马', '死对头', '师徒', '主仆', '契约关系', '上司与下属', '室友', '假扮情侣', '久别重逢', '救命恩人', '监视者与被监视者', '追捕者与逃亡者', '搭档', '网友见面', '一夜偶遇的陌生人', '守护者与被守护者', '敌国人质', '分手多年的前任', '雇主与保镖', '医生与病人', '召唤者与被召唤者', '邻居']
const TWISTS = ['隐瞒着一个身份', '一段失去的记忆', '入夜后规则就变了', '一个必须遵守的禁忌', '一个倒计时', '一笔没还清的债', '来自未来', '只有你看得见', '以一场误会开局', '人人都在找的东西在你手上', '被卷进一桩案子', '第二人格', '身体互换', '一封没寄出的信', '出于善意的谎言', '一个赌约', '被选中却不想当', '世界正在慢慢消失', '有限的寿命或力量', '一段必须藏起来的关系', '替身与冒名', '一次回到过去的机会', '只有你们知道的秘密', '被困在同一个地方']

/** n seeds, no stage, bond or twist twice in one batch. `random` is for tests. */
export function ideaSeeds(n = 5, random = Math.random) {
  const draw = list => {
    const pool = [...list]
    return () => pool.splice(Math.floor(random() * pool.length), 1)[0]
  }
  const [stage, bond, twist] = [draw(STAGES), draw(BONDS), draw(TWISTS)]
  return Array.from({ length: n }, () => ({ stage: stage(), bond: bond(), twist: twist() }))
}

/** The request for a batch of ideas, in the page's language; `exclude` = titles shown before. */
export function ideasRequest(seeds, { reply = DEFAULT_LANGUAGE } = {}, { cardType = '', options = null, exclude = [] } = {}) {
  const story = optionLines(cleanCardOptions(options, cardType)).story
  const system = `你帮想玩角色扮演的人找灵感：给出几张角色卡的点子，每个都让人一看就想玩。
- 每个点子按给你的一颗种子（舞台、关系、转折）长出来；种子只是起点，可以化用、改写，三样拼在一起别扭时换掉一样，但几个点子之间要明显不同。
- pitch 一两句，有画面：谁、在哪、和玩家是什么关系、钩子在哪。写具体的人和事，不写空泛的形容。
- title 是几个字的卡名，具体好记。tags 两三个，写题材和基调。
${story.length ? `- 每个点子都要符合用户选的：${story.join('')}\n` : ''}- 点子是给玩家看的，会填进他的第一句话里：玩家称作「你」，不写 <user>，也不替玩家定男女（不写他、她、前女友、男友这类）。用${reply}写，不用破折号。

只输出一段 <ideas> 包着的 JSON 数组：
<ideas>
[{"title": "卡名", "pitch": "一两句", "tags": ["题材", "基调"]}]
</ideas>`
  const lines = seeds.map((s, i) => `${i + 1}. 舞台：${s.stage}；关系：${s.bond}；转折：${s.twist}`)
  const avoid = exclude.length ? `\n\n这些已经给过了，不要再出一样或很像的：${exclude.join('、')}` : ''
  return { system, messages: [{ role: 'user', content: `种子：\n${lines.join('\n')}${avoid}\n\n每颗种子一个点子，共 ${seeds.length} 个。` }], maxTokens: TALK_TOKENS, softCap: true }
}

/** A batch of ideas back: [{ title, pitch, tags }]. */
export function readIdeas(text) {
  const raw = looseJson(section(text, 'ideas') || text)
  return (Array.isArray(raw) ? raw : [])
    .filter(idea => idea && typeof idea === 'object' && clip(idea.pitch, 300))
    .slice(0, 8)
    .map(idea => ({ title: clip(idea.title, 30), pitch: clip(idea.pitch, 300), tags: list(idea.tags, 4, 12) }))
}

// ─── Talking it through ───────────────────────────────────────────────────

// ─── The player's name ────────────────────────────────────────────────────
// A card names the player <user>: the app (and SillyTavern) puts in the name
// the player goes by. The guide asks whether that is the name in settings or
// one of the card's own; the answer is the sketch item user_name, and only
// that answer (or the player's own words) names the player. A name a model
// made up on its own is taken back out of the plan.

/** Whether a settings name was filled in (the default is 你 / You). */
const settingsNameOf = name => (/^(你|you)?$/i.test(String(name ?? '').trim()) ? '' : String(name).trim())

// "The name in settings", however the guide put it, and other ways of saying "no name of its own".
const NO_OWN_NAME = /设置|設定|setting|默认|default|^(你|you|<user>|\{\{user\}\}|主角|protagonist)$/i

/** A name as the sketch or the plan has it, or '' for "the one in settings". */
export function cleanUserName(value) {
  const name = String(value ?? '')
    .trim()
    .replace(/^[「『“"'《]+|[」』”"'》]+$/g, '')
    .split(/[，,。；;：:（(、\n]/)[0]
    .trim()
  return !name || name.length > 24 || NO_OWN_NAME.test(name) ? '' : name
}

/** The name the player chose in the talk (sketch item user_name); '' = the one in settings. */
export const chosenUserName = brief => cleanUserName(brief?.items?.find(item => item.key === 'user_name')?.value)

// The player's gender, when not picked in 卡的设定: the guide asks it with the name, the answer is the sketch item
// user_gender, and the draft's pick follows it (index.mjs), so the plan and the writers get it the one way they do.
const USER_GENDER_TALK = '- 同一轮或下一轮再问一句 <user> 在故事里是男是女，选项给「女」「男」「不限」，不限的 detail 写「不写明，角色不用他或她指代你」；sample 写一句角色按这个性别称呼 <user> 的话，不限的用不带性别的叫法。用户开口就说了自己是男是女，就直接记下，不再问。用户选了、说了或让你定了，草图里记一项 key 为 user_gender：value 只写「女」「男」或「不限」（草图不是中文就用对应的词）。'

/**
 * The player's gender as the talk settled it (sketch item user_gender): 'female', 'male', '' for 不限 or
 * anything unclear, null when it was not talked about. In whatever language the sketch is written.
 */
export function chosenUserGender(brief) {
  const item = brief?.items?.find(item => item.key === 'user_gender')
  if (!item) return null
  const value = String(item.value ?? '')
  const female = /女|\b(female|woman|girl)\b/i.test(value)
  const male = /男|\b(male|man|boy)\b/i.test(value)
  return female === male ? '' : female ? 'female' : 'male'
}

/** Where the player's own tracked values live in a card of this language. */
export const playerRoot = language => (englishCard(language) ? 'Protagonist' : '主角')

const discussSystem = (languages, settingsName = '', options = null) => `你是一位角色卡共创向导。用户想在 SillyTavern 一类的角色扮演应用里玩一张新角色卡，但往往说不清自己真正想要什么。你陪他把一个模糊的念头聊成清晰的设想：用具体、可感的选择帮他发现自己的偏好，而不是替他做决定。

做法：
- 每轮先用一两句话说出你此刻理解的样子，要具体、有画面；再提 2 到 3 个此刻最影响全局的问题，不要一次问很多。
- 提问的先后：先定舞台（世界）和核心角色是谁，再定 <user> 的身份、和角色的关系、互动方式与玩法，然后是基调、文风和开场，最后才是要不要记录会变化的数值。已经定下的不再问。
- 定 <user> 的身份时，顺带问一句 <user> 在这个故事里叫什么。第一个选项是「用设置里的名字」，detail 写「${settingsName ? `设置里填的是「${settingsName}」，以后改了设置，故事里也跟着变` : '设置里还没填名字，故事里就叫你「你」；以后在设置里填了，就跟着变'}」；再给两三个合这个世界的名字，sample 写一句角色喊这个名字的话。用户选了、说了或让你定了名字，草图里记一项 key 为 user_name：value 只写名字本身，用设置里的名字就写「用设置里的名字」。
- 除了这一问，不替 <user> 起名字；选项的样例和试写里，玩家角色写 <user>，不写名字。
${options?.userGender ? '' : `${USER_GENDER_TALK}
`}- 每个问题给 3 到 4 个彼此差别明显的选项。每个选项都要具体，并附一句样例：角色可能说的一句话，或一两句小场景，让用户凭感觉挑。样例要像活人说的话。
- 文风、语气这类难以描述的东西，用 kind 为 taste 的问题：给两到三段同一情境、不同写法的短试写（每段 60 到 120 字），让用户挑喜欢的一段。
- 用户可能选「你来定」：那就由你挑最合适的一项，在回复里说你选了什么、为什么，并在草图里把这一项的 by 写成 "assistant"。
- 不偷偷替用户拿主意。你自己补出来的设想写进草图时 by 写 "assistant"；用户亲口说的、选的，by 写 "user"，并尽量保留他的原话。谁补的只写在 by 里，value 只写设定本身，不加「谁补的」「随时可改」这类注明，界面会标出来。
- 草图里 locked 为 true 的项是用户锁定的，不能改动，只能在它的基础上补充。
- 用大白话交流，不说「世界书」「条目」「MVU」「常驻」这类术语。问状态记录时说成「要不要记录她对你的好感、你的体力这类会变化的数值，显示在每条回复下面的状态栏里」；用户想要的话，再用一个问题和他商量记哪几项、各自怎么变（比如什么事让好感涨、什么事让它掉），选项给出具体的组合。记了关系类的数值，可以再问一句她会不会随着数值变成不同的样子（比如好感低时戒备、高了才依赖），以及有没有到了某个程度就会发生的事（告白、摊牌、秘密揭开）。
${optionLines(options).talk.length ? `- 用户开始前选好了这些，照着聊，不必再问：${optionLines(options).talk.join('')}
` : ''}- 当核心角色、和 <user> 的关系、舞台、基调都已清楚，readiness 给到 75 以上，并在回复里提一句「可以出方案了，也可以接着细化」。用户可能随时要求出方案，你只管把每一轮聊好。

${talkWriting(languages)}

回答严格分成下面三段，每段用自己的结束标签收尾（</reply>、</questions>、</brief>），标签之外不写任何东西：
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
草图的 key 尽量用：stage 舞台、lead 核心角色、user 你的身份、user_name 你的名字、user_gender 你的性别、bond 你们的关系、play 玩法、tone 基调、style 文风、cast 配角、track 记录的数值、opening 开场；还没谈到的不要写。`

const LIMITS = { questions: 4, options: 5, items: 14, open: 6 }
const BY = new Set(['user', 'assistant'])
const KINDS = new Set(['single', 'multi', 'taste'])

const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

// The sections an answer is split into. <user> is not one: values name the player that way.
const SECTIONS = 'reply|questions|brief|plan|issues|ideas'

/**
 * Text between <tag> and </tag>; up to the next section, or the end when the
 * answer was cut off. Some models close a section with another one's tag
 * (<questions>…</brief>): that stray tag is dropped.
 */
export function section(text, tag) {
  const source = String(text ?? '')
  const open = new RegExp(`<${tag}>`, 'i').exec(source)
  if (!open) return ''
  const rest = source.slice(open.index + open[0].length)
  const end = rest.search(new RegExp(`</${tag}>|<(?:${SECTIONS})>`, 'i'))
  return (end < 0 ? rest : rest.slice(0, end)).replace(new RegExp(`(?:\\s*</(?:${SECTIONS})>)+\\s*$`, 'i'), '').trim()
}

/** Every JSON object or array in a text, in order; for answers whose tags went astray. */
function jsonValues(text) {
  const source = String(text ?? '')
  const found = []
  for (let start = source.search(/[[{]/); start >= 0; ) {
    let depth = 0
    let quoted = false
    let end = -1
    for (let i = start; i < source.length && end < 0; i++) {
      const char = source[i]
      if (quoted) {
        if (char === '\\') i++
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '[' || char === '{') depth++
      else if ((char === ']' || char === '}') && --depth === 0) end = i
    }
    const value = end < 0 ? null : looseJson(source.slice(start, end + 1))
    if (value && typeof value === 'object') found.push(value)
    const next = source.slice(value ? end + 1 : start + 1).search(/[[{]/)
    start = next < 0 ? -1 : (value ? end + 1 : start + 1) + next
  }
  return found
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
    const json = body.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1')
    try {
      return JSON.parse(json)
    } catch {
      try {
        return JSON.parse(innerQuotes(json))
      } catch {
        return null
      }
    }
  }
}

/**
 * Straight quotes inside a string turned into “ ”: models quote a line of dialogue
 * in a sample or an opening as "…" and the JSON breaks there. A quote ends the
 * string only where JSON can go on after it (a colon, a bracket, a comma before
 * the next value, the end).
 */
function innerQuotes(json) {
  let out = ''
  let quoted = false
  let inner = 0
  for (let i = 0; i < json.length; i++) {
    const char = json[i]
    if (!quoted) {
      if (char === '"') {
        quoted = true
        inner = 0
      }
      out += char
    } else if (char === '\\') {
      out += char + (json[i + 1] ?? '')
      i++
    } else if (char === '"') {
      const after = json.slice(i + 1).match(/^\s*(.?)\s*(.?)/)
      const ends = !after[1] || ':}]'.includes(after[1]) || (after[1] === ',' && /["{[\]}\d\-tfn]/.test(after[2]))
      if (ends) quoted = false
      out += ends ? char : inner++ % 2 ? '”' : '“'
    } else out += char
  }
  return out
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
  // Over the limit: unlocked items go from the end, a locked one never does.
  let room = LIMITS.items - items.filter(item => item.locked).length
  const kept = items.filter(item => item.locked || room-- > 0)
  const readiness = Number(fresh.readiness)
  return {
    title: clip(fresh.title, 40) || previous.title,
    readiness: Number.isFinite(readiness) ? Math.max(0, Math.min(100, Math.round(readiness))) : previous.readiness,
    items: kept.slice(0, LIMITS.items),
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

/**
 * The request for the next round of talk; languages from forgeLanguages,
 * userName the name in settings (你的名字), for the guide to offer.
 */
export function discussRequest(rounds, brief, languages, { userName = '', cardType = '', options = null, references = [] } = {}) {
  const messages = []
  const material = referenceBlock(references)
  rounds.forEach((round, i) => {
    let content = userTurnText(round.user, { first: i === 0 })
    if (i === 0 && material) content = `${material}\n\n${content}`
    const last = i === rounds.length - 1
    if (last && i > 0) content += `\n\n<sketch>\n现在的草图（我可能改过一些，locked 的是我锁定的）：\n${JSON.stringify(brief)}\n</sketch>`
    messages.push({ role: 'user', content })
    if (!last && round.assistant) messages.push({ role: 'assistant', content: round.assistant.raw })
  })
  return { system: discussSystem(languages, settingsNameOf(userName), cleanCardOptions(options, cardType)) + referenceRules(references, DISCUSS_REFERENCE_RULES, DISCUSS_STRUCTURE_RULES), messages, maxTokens: TALK_TOKENS, softCap: true }
}

const isQuestions = value => Array.isArray(value) && value.some(q => Array.isArray(q?.options))
const isBrief = value => Boolean(value) && !Array.isArray(value) && (Array.isArray(value.items) || 'readiness' in value)

/**
 * A round's answer → { reply, questions, brief }; whatever could be read.
 * When the tags went astray, the questions and the sketch are told apart by their shape.
 */
export function readDiscussion(text, previous) {
  const reply = section(text, 'reply') || (/<questions>|<brief>/i.test(text) ? '' : String(text ?? '').trim())
  const tagged = [looseJson(section(text, 'questions')), looseJson(section(text, 'brief'))]
  let all
  const find = test => tagged.find(test) ?? (all ??= jsonValues(text)).find(test)
  const questions = cleanQuestions(find(isQuestions))
  const briefJson = find(isBrief)
  // Questions the answer had but that could not be read count as a broken answer too.
  const lost = !questions.length && /<questions>\s*\[\s*\{/i.test(text)
  return { reply: reply.slice(0, 2000), questions, brief: briefJson ? mergeBrief(briefJson, previous) : previous, readable: Boolean(briefJson) && !lost }
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
  "user_role": {"name": "用户给 <user> 定的名字（草图里的 user_name）；没定、用设置里的名字就留空", "identity": "<user> 是谁、为什么在这里", "constraints": ["<user> 的限制，可为空"]},
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
    "stage_by": "她的性格随哪个数值分阶段（tracking 里数值变量的 path），不分阶段留空",
    "stages": [{"name": "阶段名，两三个字", "until": "30", "main": ["这个阶段的主色调"], "accent": ["这个阶段的点缀"], "shift": "到了这个阶段她对 <user> 有什么不同，一句"}],
    "looks_tags": "English booru tags for the unchanging look: apparent age, hair, eyes, build, marks",
    "outfit_tags": "English booru tags for the usual outfit"
  }],
  "style": {"perspective": "第三人称 或 第二人称", "tone": "语言基调", "mood": "情绪氛围", "reference": "参照的作品或文风，可为空", "special": ["特别要求"]},
  "play_rules": ["扮演时的互动规则，可执行的指令，例如不替 <user> 说话做决定"],
  "tracking": {"enabled": false, "title": "状态栏标题，可为空", "variables": [{"path": "林小雨.好感度", "label": "好感", "type": "number", "initial": "20", "range": "0~100", "show": "meter", "check": "什么事会让它怎么变"}]},
  "greetings": [{"title": "开场的名字", "start": "从故事的哪一刻开始：时间点、你们的关系到了哪一步", "scene": "时间、地点", "situation": "开场时正在发生什么、悬念在哪", "length": "500~700", "state": {"林小雨.好感度": "这个开场和默认初始值不同的变量才写，没有就是 {}"}}],
  "events": [{"name": "事件名，几个字", "when": "什么时候会发生，大白话", "keywords": ["对话里提到就触发的词，可为空"], "requires": [{"path": "变量 path", "op": ">=", "value": "60"}], "content": "发生什么、谁会怎么做、之后有什么变化"}],
  "avatar": {"character": "头像画的是谁", "description": "中文，外貌、神态、构图", "tags": "English tags for the picture", "style": "English, the art style for every picture of this card (avatar, sprites, backgrounds), matching its tone, e.g. anime illustration, soft watercolor shading"},
  "assumptions": ["你补出来、用户没有说过的设定，一条一句"],
  "verbatim": ["用户原话里应当原样保留的句子"]
}`

const planSystem = (language, { options = null, greetings = 0 } = {}) => `你是角色卡策划。根据你和用户的讨论，写出一张 SillyTavern 角色卡的创作方案，之后会按方案逐项写出角色设定、世界书和开场白。

要求：
- 讨论里定下的一切都要体现在方案里；用户的原话放进 verbatim，并在相关字段里原样使用。
- 没讨论到但写卡必需的部分，你可以补，但每一处都要写进 assumptions，让用户确认。
${optionLines(options, language).plan.length ? optionLines(options, language).plan.map(line => `- ${line}`).join('\n') : '- 核心角色通常 1 个，最多 4 个；配角 0 到 3 个，每个都要有在故事里的作用。'}
- 外貌只写让人认得出的特征，不写放在谁身上都成立的美貌描写。
- 性格用「底色 + 主色调 + 点缀」来想：底色是最深层、最稳定的那一面，主色调是最常表现出来的，点缀是偶尔露出的。facets 只在角色在不同处境下判若两人时才设为 true。
- 玩家角色一律写 <user>。用户没说 <user> 是男是女，就不用「他」「她」指代 <user>，也不写出 <user> 的性别（男友、前女友这类称呼同样不用）。不替 <user> 起名字：用户没定名字，user_role.name 就留空；定了名字也只写在 user_role.name，其余地方照样写 <user>。
- 只有用户想要记录好感、体力、金钱这类会变化的数值时，tracking.enabled 才为 true；变量路径用「角色名.变量名」，<user> 自己的一律用「${playerRoot(language)}.变量名」，不要用 <user>、{{user}} 或他的名字当键名。
- 这些变量会显示在每条回复下面的状态栏里。label 是状态栏上的短名（2 到 4 个字）；show 是显示方式：meter 进度条（有范围的数值）、number 数字、rating 星级（范围写 0~5）、text 一句话、badge 徽章（阶段、关系这类短词）、long 长文字（内心独白、近况）、tags 标签（物品、状态这类短词列表）、list 列表（一行一条的记录）、flag 是或否、hidden 只给模型看不显示。状态栏放玩家最在意的项，每个角色 3 到 8 项，其余用 hidden；角色多时状态栏会按人分开显示。
- 开场白${greetings ? ` ${greetings} 个` : '默认 2 个，用户要别的数目就按他的'}。每个开场是一个不同的起点，不只是换个地点：故事的不同时刻、关系的不同阶段或不同的处境，也可以是另一条故事线（比如已经在一起、刚刚闹翻、多年后重逢）；title 让人一眼看出差别。每个都要有悬念或张力，并让 <user> 一开口就有话可接。
- 记录数值时，开场的处境和默认初始值对不上（比如关系已经很近），就在这个开场的 state 里写出不同的那几项，键是变量的 path，值照 initial 的写法；对得上就写 {}。
- 记录了和核心角色关系有关的数值（好感、信任这类）、她会随着关系明显变样时，可以让她的性格分阶段：stage_by 写那个数值变量的 path，stages 2 到 4 个，按数值从低到高排，until 是这个阶段的上限（不含），最后一个阶段不写 until。底色不随阶段变；每个阶段的主色调和点缀写这个阶段最常露出的样子，后一个阶段不是前一个的加强版。用户没要、关系也不会大变时不分阶段，stage_by 留空、stages 写 []。
- events 写会在特定时机发生的事（告白、冲突爆发、秘密揭开、节日、危机），0 到 6 个，没有自然的事件就写 []。触发有两种，可以同时有：keywords 是对话里提到就触发的词；requires 是数值到了某个程度（只在记录数值时用，op 取 >=、<=、>、<、==、!=、has（列表里有这一项）；一到三个条件，要同时满足，比如「天数 >= 30」加「信任 >= 60」；不用就写 []）。条件要等故事走到那一步才成立，开局的数值不能已经满足它：开局信任 10，就不要写「信任 <= 20」。两种都没有的事件不要写。事件只发生一次，content 写场面和可能的走向，不写死结果，不替 <user> 做决定。
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
// Said last as well: weaker models (deepseek-v4.1-flash) answer 写出创作方案 with a Markdown write-up otherwise.
const PLAN_FORMAT = '\n\n只输出一段 <plan> 包着的 JSON，字段照系统提示里的格式；不写 Markdown 文档、不写别的说明。'

// 出三版来挑: each version takes the talk from its own angle. What was settled stays in all three.
export const PLAN_ANGLES = {
  close: '这一版贴着讨论来：没定的部分，按最自然、最合讨论走向的方式补。',
  bold: '这一版更大胆：讨论里定下的一律不动；没定的部分往出人意料的方向补，冲突更强，设定或身份更有反差，但要合理、好玩。',
  shift: '这一版换个切入：讨论里定下的一律不动；换一个故事的切入点，核心矛盾、关系的起点或开场处境不同，让玩起来的感觉明显不一样。',
}

/**
 * The plan, in the card's language (languages from forgeLanguages).
 * @param options - cardType and greetings (how many) as the player set them; angle, a PLAN_ANGLES key; references, the draft's.
 */
export function planRequest(rounds, brief, { card = DEFAULT_LANGUAGE } = {}, { cardType = '', options = null, greetings = 0, angle = '', references = [] } = {}) {
  const material = referenceBlock(references)
  const picked = cleanCardOptions(options, cardType)
  const content = `<discussion>\n${transcript(rounds)}\n</discussion>\n\n<sketch>\n${JSON.stringify(brief)}\n</sketch>\n\n按上面的讨论和草图写出创作方案。${PLAN_ANGLES[angle] ?? ''}${PLAN_FORMAT}`
  return { system: planSystem(card, { options: picked, greetings: cleanGreetingCount(greetings) }) + referenceRules(references, PLAN_REFERENCE_RULES, PLAN_STRUCTURE_RULES), messages: [userMessage(material, content)], maxTokens: planTokens(picked), softCap: true }
}

/** Changes to a plan: the current plan and what the user wants different, in the plan's language. */
export function reviseRequest(rounds, plan, { text = '', notes = [] } = {}, { cardType = '', options = null, references = [] } = {}) {
  const material = referenceBlock(references)
  const picked = cleanCardOptions(options, cardType)
  const asked = [
    ...notes.filter(n => n.text).map(n => `- 关于「${n.section}」：${n.text}`),
    text ? `- 总体：${text}` : '',
  ].filter(Boolean)
  const content = [
    `<discussion>\n${transcript(rounds)}\n</discussion>`,
    `<current_plan>\n${JSON.stringify(rawPlan(plan))}\n</current_plan>`,
    `用户对方案的意见：\n${asked.join('\n')}`,
    '按意见改方案：只改意见涉及的部分，其余保持原样。新补出来的设定同样写进 assumptions。输出完整的新方案。' + PLAN_FORMAT,
  ].join('\n\n')
  return { system: planSystem(planLanguage(plan), { options: picked }) + referenceRules(references, PLAN_REFERENCE_RULES, PLAN_STRUCTURE_RULES), messages: [userMessage(material, content)], maxTokens: planTokens(picked), softCap: true }
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
    stagesPurpose: names => `分阶段：${names.join(' → ')}`,
    initvar: '[InitVar]请勿打开', initvarPurpose: '变量的初始值（不发给模型，开局时读入）',
    variables: '变量列表', variablesPurpose: '每轮把当前变量交给模型',
    updateRules: '[mvu_update]变量更新规则', updateRulesPurpose: '每个变量什么时候、怎么变',
    updateFormat: '[mvu_update]变量输出格式', updateFormatPurpose: '让模型在回复末尾写出变量更新',
    event: name => `事件_${name}`, eventOnce: '只发生一次：前文已经写过这件事，就把它当作发生过的事，不再重演。',
    eventOnceMarked: op => `只发生一次：这件事真正写进故事的那一轮，在变量更新的 JSONPatch 里加上 ${op}，之后这一条就不再出现。前文已经写过这件事的，当作发生过的事，不再重演，也照样加上。`,
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
    stagesPurpose: names => `in stages: ${names.join(' → ')}`,
    initvar: '[InitVar] do not open', initvarPurpose: 'the variables\' starting values (not sent to the model; read when a chat starts)',
    variables: 'Variables', variablesPurpose: 'gives the model the current variables every turn',
    updateRules: '[mvu_update] Variable update rules', updateRulesPurpose: 'when and how each variable changes',
    updateFormat: '[mvu_update] Variable output format', updateFormatPurpose: 'has the model write the variable updates at the end of its reply',
    event: name => `Event_${name}`, eventOnce: 'This happens once: if the story has already shown it, treat it as something that happened and do not play it again.',
    eventOnceMarked: op => `This happens once: in the turn the story really shows it, put ${op} in the JSONPatch of the variable update, and this entry will not come again. If the story has already shown it, treat it as something that happened, do not play it again, and add it all the same.`,
    perspective: 'Third person', greeting: n => `Greeting ${n}`, separator: '; ',
  },
}

/** The card's own words for a plan's language. */
export const ownWords = language => OWN_WORDS[englishCard(language) ? 'en' : 'zh']

const VARIABLE_TYPES = ['number', 'string', 'boolean', 'list', 'book']
// DeepSeek writes the way a variable shows as its type ("type": "meter"). Left as a string, a meter compares as text.
const TYPE_OF_SHOW = { meter: 'number', rating: 'number', tags: 'list', flag: 'boolean' }

/** A list's starting items as text. A model may write them as JSON in a string, which would read as one item. */
function listText(raw) {
  if (typeof raw !== 'string' || !raw.trim().startsWith('[')) return raw
  try {
    const items = JSON.parse(raw)
    return Array.isArray(items) ? items.join('、') : raw // i18n-ignore: items as a card keeps them
  } catch {
    return raw
  }
}
const MAX_VARIABLES = 80

/**
 * The tracked variables as the plan keeps them, from the model or from the
 * player's edits in the plan's status bar editor. `show` (how the status bar
 * shows it) is filled in from the type when missing.
 */
export function cleanVariables(variables, most = MAX_VARIABLES) {
  const seen = new Set()
  return (Array.isArray(variables) ? variables : [])
    .filter(v => v && typeof v === 'object' && clip(v.path, 60))
    .map(v => {
      const type = VARIABLE_TYPES.includes(v.type) ? v.type : TYPE_OF_SHOW[v.type] ?? TYPE_OF_SHOW[v.show] ?? 'string'
      const variable = {
        path: cleanPath(clip(v.path, 60).replace(/[{}\s]+/g, '')),
        label: clip(v.label, 12),
        type,
        initial: clip(String((type === 'list' ? listText(v.initial) : v.initial) ?? ''), 120),
        range: clip(v.range, 40),
        check: clip(v.check, 200),
      }
      // 册子: what each row keeps, and its starting rows as text (web/shared/status.js).
      if (type === 'book') {
        variable.columns = list(v.columns, 3, 12)
        if (!variable.columns.length) variable.columns = [BOOK_WORDS.zh.columns[1]]
        // The row's name listed as a column as well: no row fills it, and the table shows an empty column.
        const rows = Array.isArray(v.initial) ? v.initial : []
        if (variable.columns.length > 1 && rows.length && rows.every(row => row?.name && row[variable.columns[0]] === undefined)) variable.columns = variable.columns.slice(1)
        variable.initial = bookText(v.initial, variable.columns)
      }
      variable.show = SHOWS.includes(v.show) ? v.show : defaultShow(variable)
      // 状态栏分页: the page it shows on.
      if (clip(v.page, 8)) variable.page = clip(v.page, 8)
      return variable
    })
    .filter(v => v.path && !seen.has(v.path) && seen.add(v.path))
    .slice(0, most)
}

/** An opening's own starting values as the model wrote them: variable path → value, as text. */
function rawState(raw, most = MAX_VARIABLES) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw).slice(0, most)) {
    const path = cleanPath(clip(key, 60).replace(/[{}\s]+/g, ''))
    const text = Array.isArray(value) ? value.join('、') : value === null || typeof value === 'object' ? '' : String(value)
    if (path && text.trim()) out[path] = clip(text, 120)
  }
  return out
}

/**
 * Each opening's own starting values kept to the variables the plan tracks
 * (none when it tracks nothing): a variable gone takes its value with it.
 */
function settleGreetingStates(plan) {
  const paths = new Set(plan.tracking.enabled ? plan.tracking.variables.map(v => v.path) : [])
  plan.greetings = plan.greetings.map(g => ({ ...g, state: Object.fromEntries(Object.entries(g.state ?? {}).filter(([path]) => paths.has(path))) }))
  return plan
}

/**
 * @param language - 写作语言 when the plan was made (forgeLanguages().card).
 * @param userName - the player's name as the player settled it ('' = the one in
 *   settings); left out, the plan's own is taken as it is.
 * @param said - the player's words this plan answers (a revision's comments):
 *   a name the model put in user_role.name counts only when they contain it.
 */
export function normalizePlan(raw, { language = DEFAULT_LANGUAGE, userName, said = '', scale = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const most = limitsOf(scale)
  const words = ownWords(language)
  const world = raw.world && typeof raw.world === 'object' ? raw.world : {}
  const characters = (Array.isArray(raw.characters) ? raw.characters : [])
    // The player is no character of the card, and a placeholder (第三方（未命名）) no one yet.
    .filter(c => c && typeof c === 'object' && clip(c.name, 24) && !PLAYER_KEYS.has(clip(c.name, 24).toLowerCase()) && !/未命名|待定|unnamed|tbd/i.test(c.name))
    .slice(0, most.characters)
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
      stage_by: cleanPath(clip(c.stage_by, 60).replace(/[{}\s]+/g, '')),
      stages: (Array.isArray(c.stages) ? c.stages : [])
        .filter(s => s && typeof s === 'object' && clip(s.name, 12))
        .slice(0, 5)
        .map(s => ({ name: clip(s.name, 12), until: clip(String(s.until ?? ''), 12), main: list(s.main, 2, 40), accent: list(s.accent, 3, 40), shift: clip(s.shift, 200) })),
    }))
  if (!characters.some(c => c.kind === 'core')) {
    if (!characters.length) return null
    characters[0].kind = 'core'
  }
  const tracking = raw.tracking && typeof raw.tracking === 'object' ? raw.tracking : {}
  const variables = cleanVariables(tracking.variables, most.variables)
  const plan = {
    name: clip(raw.name, 40) || characters[0].name,
    summary: clip(raw.summary, 400),
    user_role: { name: '', identity: clip(raw.user_role?.identity, 300), constraints: list(raw.user_role?.constraints, 6, 120) },
    world: {
      kind: /^(真实|real)/i.test(String(world.kind ?? '').trim()) ? '真实' : '架空',
      overview: clip(world.overview, 800),
      rules: list(world.rules, most.rules, 200),
      places: (Array.isArray(world.places) ? world.places : [])
        .filter(p => p && clip(p.name, 24))
        .slice(0, most.places)
        .map(p => ({ name: clip(p.name, 24), aliases: list(p.aliases, 4, 24), description: clip(p.description, 400), scenes: list(p.scenes, 8, 40) })),
      factions: (Array.isArray(world.factions) ? world.factions : [])
        .filter(f => f && clip(f.name, 24))
        .slice(0, most.factions)
        .map(f => ({ name: clip(f.name, 24), description: clip(f.description, 400), members: list(f.members, 8, 24) })),
      history: (Array.isArray(world.history) ? world.history : [])
        .filter(h => h && clip(h.event, 200))
        .slice(0, most.history)
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
    play_rules: list(raw.play_rules, most.playRules, 160),
    tracking: { enabled: tracking.enabled === true && variables.length > 0, title: clip(tracking.title, 30), variables },
    game: raw.game && typeof raw.game === 'object' ? cleanKit(raw.game) : null,
    greetings: (Array.isArray(raw.greetings) ? raw.greetings : [])
      .filter(g => g && typeof g === 'object')
      .slice(0, MAX_GREETINGS)
      .map((g, i) => ({ title: clip(g.title, 30) || words.greeting(i + 1), start: clip(g.start, 200), scene: clip(g.scene, 200), situation: clip(g.situation, 400), length: clip(g.length, 20) || '500~700', state: rawState(g.state, most.variables) })),
    events: (Array.isArray(raw.events) ? raw.events : [])
      .filter(e => e && typeof e === 'object' && clip(e.name, 20))
      .slice(0, most.events)
      .map(e => ({
        name: clip(e.name, 20),
        when: clip(e.when, 200),
        keywords: list(e.keywords, 6, 24),
        requires: requirementsOf(e)
          .filter(r => r && typeof r === 'object' && clip(r.path, 60))
          .slice(0, 3)
          .map(r => ({ path: cleanPath(clip(r.path, 60).replace(/[{}\s]+/g, '')), op: clip(r.op, 4), value: clip(String(r.value ?? ''), 60) })),
        content: clip(e.content, 600),
      })),
    avatar: { character: clip(raw.avatar?.character, 24) || characters[0].name, description: clip(raw.avatar?.description, 400), tags: clip(raw.avatar?.tags, 400), style: clip(raw.avatar?.style, 200) },
    assumptions: list(raw.assumptions, 20, 200),
    verbatim: list(raw.verbatim, 12, 300),
  }
  if (!plan.greetings.length) plan.greetings.push({ title: words.greeting(1), start: '', scene: '', situation: '', length: '500~700', state: {} })
  plan.language = language
  // 高级选项: there only when asked for, so a plan without them is what it always was.
  if (scale) plan.scale = scale
  const selfcheck = list(raw.selfcheck, 6, 120)
  if (selfcheck.length) plan.selfcheck = selfcheck
  const events = cleanEvents(raw.random_events)
  if (events) plan.random_events = events
  const judge = cleanJudge(raw.judge)
  if (judge) plan.judge = judge
  const moves = cleanWorld(raw.world_moves)
  if (moves) plan.world_moves = moves
  const creation = cleanCreation(raw.creation)
  if (creation) plan.creation = creation
  const colors = cleanPalette(raw.status_colors)
  if (colors) plan.status_colors = colors
  const proposed = cleanUserName(raw.user_role?.name)
  const name = userName === undefined || (proposed && said.includes(proposed)) ? proposed : cleanUserName(userName)
  settleUserName(plan, name, [proposed, ...namedIn(raw.user_role?.identity)])
  if (!plan.characters.length) return null
  settleGreetingStates(plan)
  plan.entries = planEntries(plan)
  plan.warnings = planWarnings(plan)
  return plan
}

/** A plan's answer → the plan, or null when nothing usable came back. Options as normalizePlan's. */
export function readPlan(text, options = {}) {
  return normalizePlan(looseJson(section(text, 'plan') || text), options)
}

// "你叫江砚，" / "<user>名叫江砚。" / "your name is Lin": a name the plan gives the player.
// Only with punctuation (or the end) after it, so the name is all that is caught.
const NAMED = [
  /(?:你|<user>)\s*(?:叫做?|名叫|名为|的名字是|姓名是?)\s*[「『“"]?([^\s，,。；;、：:「」『』“”"（()）<>]{2,6})(?=[」』”"]?(?:[，,。；;、（(\s]|$))/gi,
  /(?:your name is|you are (?:called|named)|<user> is (?:called|named))\s+([A-Z][\w'-]*(?: [A-Z][\w'-]*)?)/g,
]
const namedIn = text => NAMED.flatMap(pattern => [...String(text ?? '').matchAll(pattern)].map(m => m[1]))

// Keys a model uses for the player's own values, besides a name.
const PLAYER_KEYS = new Set(['<user>', '{{user}}', 'user', 'player', '你', '玩家', '主角', 'protagonist'])
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const mapText = (value, fn) =>
  typeof value === 'string' ? fn(value)
    : Array.isArray(value) ? value.map(v => mapText(v, fn))
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapText(v, fn)]))
        : value

/**
 * The player's name settled in a plan: `name` ('' = the one in settings) in
 * user_role.name, and every name the plan gave the player taken back out (the
 * one settled too): the text says <user>, the player's values sit under 主角,
 * and the player is not one of the card's characters.
 * @param others - names the model gave the player (its user_role.name, ones in the identity).
 */
function settleUserName(plan, name, others) {
  plan.user_role.name = name
  const player = new Set([name, cleanUserName(others[0])].filter(Boolean))
  plan.characters = plan.characters.filter(c => !player.has(c.name))
  if (plan.characters.length && !plan.characters.some(c => c.kind === 'core')) plan.characters[0].kind = 'core'
  // A name that is part of another name (青梧 in 顾青梧) is left alone: replacing it would break that one.
  const taken = [plan.name, ...plan.characters.flatMap(c => [c.name, ...c.aliases]), ...plan.world.places.map(p => p.name), ...plan.world.factions.map(f => f.name)]
  const names = [...new Set([...player, ...others.map(cleanUserName)])].filter(n => n.length >= 2 && !taken.some(word => word.includes(n)))
  let strip = text => text
  if (names.length) {
    const alternatives = names.map(escapeRegex).join('|')
    const naming = new RegExp(`(?:你|<user>)\\s*(?:叫做?|名叫|名为|的名字是|姓名是?)\\s*[「『“"]?(?:${alternatives})[」』”"]?[，,、]?\\s*`, 'g')
    const inBrackets = new RegExp(`[（(](?:${alternatives})[）)]`, 'g')
    strip = text => names.reduce((s, n) => s.replaceAll(n, '<user>'), text.replace(naming, '').replace(inBrackets, ''))
    // A guess about the name is no setting of the story.
    plan.assumptions = plan.assumptions.filter(a => !(names.some(n => a.includes(n)) && /定名|起名|取名|名字|叫|name/i.test(a)))
    for (const key of ['summary', 'world', 'characters', 'style', 'play_rules', 'greetings', 'assumptions', 'verbatim']) plan[key] = mapText(plan[key], strip)
    for (const key of ['selfcheck', 'random_events', 'judge', 'world_moves', 'creation']) if (plan[key]) plan[key] = mapText(plan[key], strip)
    plan.user_role.identity = strip(plan.user_role.identity)
    plan.user_role.constraints = plan.user_role.constraints.map(strip)
    plan.avatar.description = strip(plan.avatar.description)
    plan.tracking.title = strip(plan.tracking.title)
  }
  const root = playerRoot(plan.language)
  // The player's own values sit under 主角, in the variables and in the openings' own values alike.
  const ownPath = path => {
    const at = path.indexOf('.')
    const head = at > 0 ? path.slice(0, at) : ''
    const own = head && (PLAYER_KEYS.has(head.toLowerCase()) || names.includes(head) || player.has(head))
    return own ? root + path.slice(at) : path
  }
  const variables = plan.tracking.variables.map(v => ({ ...v, path: ownPath(v.path), label: strip(v.label), check: strip(v.check), initial: strip(v.initial) }))
  plan.tracking.variables = cleanVariables(variables, limitsOf(plan.scale).variables)
  if (plan.judge?.rank_path) plan.judge.rank_path = cleanPath(ownPath(plan.judge.rank_path))
  plan.greetings = plan.greetings.map(g => ({ ...g, state: Object.fromEntries(Object.entries(g.state ?? {}).map(([path, value]) => [cleanPath(ownPath(path)), strip(value)])) }))
  plan.characters = plan.characters.map(c => ({ ...c, stage_by: c.stage_by && cleanPath(ownPath(c.stage_by)) }))
  plan.events = plan.events.map(e => ({ ...e, requires: requirementsOf(e).map(r => ({ ...r, path: cleanPath(ownPath(r.path)), value: strip(r.value) })) }))
  plan.tracking.enabled = plan.tracking.enabled && plan.tracking.variables.length > 0
  if (!plan.characters.some(c => c.name === plan.avatar.character)) plan.avatar.character = plan.characters.find(c => c.kind === 'core')?.name ?? ''
}

/** The plan with the player's name set by hand ('' = the one in settings). */
export function editUserName(plan, name) {
  return { ...plan, user_role: { ...plan.user_role, name: cleanUserName(name) } }
}

// ─── Stages and events: what holds up ─────────────────────────────────────
// Kept in the plan as the model wrote them; whether they are used is asked
// here, against the variables as they are now (the status bar editor can take
// one away, and put it back).

const trackedVariable = (plan, path) => (plan.tracking?.enabled ? plan.tracking.variables.find(v => v.path === path) : null)

/**
 * A core character's stages when they hold up: a tracked number to go by, two
 * to five stages, each but the last with an upper bound above the one before.
 * Each stage gets `below` (its bound as a number; none for the last). Else null.
 */
export function stagesOf(plan, c) {
  const variable = trackedVariable(plan, c?.stage_by)
  const stages = c?.stages ?? []
  if (variable?.type !== 'number' || stages.length < 2) return null
  const bounds = stages.slice(0, -1).map(s => Number(s.until))
  if (bounds.some((b, i) => !Number.isFinite(b) || String(stages[i].until).trim() === '' || (i > 0 && b <= bounds[i - 1]))) return null
  return { variable, stages: stages.map((s, i) => ({ ...s, below: i < bounds.length ? bounds[i] : null })) }
}

const OPS = new Set(['>=', '<=', '>', '<', '==', '!=', 'has'])

/** An event's conditions as a list: one condition (as plans had it at first), several, or none. */
export const requirementsOf = event => (Array.isArray(event?.requires) ? event.requires : event?.requires && typeof event.requires === 'object' ? [event.requires] : [])

/** A tracked variable's starting value, as its type has it. */
export function typedValue(variable) {
  const raw = variable.initial
  if (variable.type === 'number') return Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : 0
  if (variable.type === 'boolean') return /^(true|是|有|1)$/i.test(raw)
  if (variable.type === 'list') return raw ? raw.split(/[、,，]/).map(s => s.trim()).filter(Boolean) : []
  if (variable.type === 'book') return bookValue(raw, variable.columns)
  return raw
}

/** A condition's value as its variable's type has it. */
export const conditionValue = ({ variable, value }) => (variable.type === 'number' ? Number(value) : variable.type === 'boolean' ? /^(true|是|有|1)$/i.test(value) : value)

/** Whether a condition holds for a value. */
function holds(condition, value) {
  const want = conditionValue(condition)
  switch (condition.op) {
    case 'has': return Array.isArray(value) ? value.includes(want) : Boolean(value) && typeof value === 'object' && Object.hasOwn(value, want)
    case '>=': return value >= want
    case '<=': return value <= want
    case '>': return value > want
    case '<': return value < want
    case '==': return value === want
    default: return value !== want
  }
}

/** One condition on a tracked value, when it holds up: { variable, op, value }. Else null. */
function eventCondition(plan, need) {
  const variable = need && trackedVariable(plan, need.path)
  if (!variable || !OPS.has(need.op) || !need.value) return null
  if (variable.type === 'number' && (need.op === 'has' || !Number.isFinite(Number(need.value)))) return null
  if (variable.type === 'list' || variable.type === 'book' ? need.op !== 'has' : need.op === 'has') return null
  if (variable.type !== 'number' && !['==', '!=', 'has'].includes(need.op)) return null
  return { variable, op: need.op, value: need.value }
}

/**
 * An event's conditions on tracked values that hold up, all to be met; null when
 * none does, or when they are met from the start (信任 <= 20 with 信任 starting
 * at 10 would have the event from the first reply on).
 */
export function eventConditions(plan, event) {
  const conditions = requirementsOf(event).map(need => eventCondition(plan, need)).filter(Boolean)
  if (!conditions.length || conditions.every(c => holds(c, typedValue(c.variable)))) return null
  return conditions
}

/**
 * The worldbook the plan calls for, one entry per kind of fact, configured.
 * Built here rather than asked for: the same plan always gets the same entries.
 */
export function planEntries(plan) {
  const entries = []
  const words = ownWords(planLanguage(plan))
  // Entries are written and matched by name: a second one of a name (a place and a faction both 樱井商事) gets a number.
  const add = entry => {
    let name = entry.name
    for (let n = 2; entries.some(e => e.name === name); n++) name = `${entry.name} ${n}`
    entries.push({ keywords: [], rephrase: false, ...entry, name })
  }
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
    // Staged by a tracked number: the palette and the notes are written a part per stage (write.mjs puts them under EJS).
    const staged = stagesOf(plan, c) ? { staged: true } : {}
    const stagesNote = staged.staged ? `${words.separator}${words.stagesPurpose(c.stages.map(s => s.name))}` : ''
    add({ name: words.palette(c.name), owner, type: '角色', part: 'personality', keywords, purpose: words.palettePurpose(c.name, c.personality.base, c.personality.main) + stagesNote, ...staged })
    if (c.facets) add({ name: words.facets(c.name), owner, type: '角色', part: 'facets', keywords, purpose: words.facetsPurpose(c.name) })
    add({ name: words.rephrase(c.name), owner, type: '角色', part: 'personality', rephrase: true, keywords, purpose: words.rephrasePurpose(c.name) + stagesNote, ...staged })
  }
  for (const c of npcs) add({ name: c.name, owner: c.name, type: 'NPC', part: '', keywords: keywordsOf(c.name, c.aliases), purpose: c.role || c.identity })
  // Events: sent when named, or (with a condition on a tracked value) when it holds; one with neither is left out.
  ;(plan.events ?? []).forEach((event, index) => {
    const condition = eventConditions(plan, event)
    const keywords = keywordsOf(event.keywords)
    if (!condition && !keywords.length) return
    add({ name: words.event(event.name), type: '事件', part: '', event: index, keywords, purpose: event.when || event.content.slice(0, 80) })
  })
  if (plan.tracking.enabled) {
    add({ name: words.initvar, type: '状态', part: 'initvar', purpose: words.initvarPurpose })
    add({ name: words.variables, type: '状态', part: 'variables', purpose: words.variablesPurpose })
    add({ name: words.updateRules, type: '状态', part: 'rules', purpose: words.updateRulesPurpose })
    add({ name: words.updateFormat, type: '状态', part: 'format', purpose: words.updateFormatPurpose })
  }
  for (const entry of brickEntries(plan, englishCard(planLanguage(plan)))) add(entry)
  return configureEntries(entries)
}

/**
 * The plan with its tracked variables edited by hand (the status bar editor):
 * `{ enabled?, title?, variables? }`, each left as it was when missing. The
 * state entries come and go with `enabled`.
 */
export function editTracking(plan, edit) {
  const before = plan.tracking ?? { enabled: false, title: '', variables: [] }
  const variables = Array.isArray(edit.variables) ? cleanVariables(edit.variables, limitsOf(plan.scale).variables) : before.variables
  const enabled = (typeof edit.enabled === 'boolean' ? edit.enabled : before.enabled) && variables.length > 0
  const palette = cleanPalette(edit.palette)
  const colors = palette ? { status_colors: palette, status: { ...plan.status, palette } } : {}
  const next = settleGreetingStates({ ...plan, ...colors, tracking: { enabled, title: typeof edit.title === 'string' ? clip(edit.title, 30) : before.title ?? '', variables } })
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
  for (const brick of brickGaps(plan)) warnings.push(brick === 'events' ? msg`随机事件的名单还是空的，这块积木不会写进卡里` : brick === 'world' ? msg`世界动态的几件事还是空的，这块积木不会写进卡里` : brick === 'creation' ? msg`建角页没有能用的项目，这块积木不会写进卡里` : msg`裁判表的等级或差距还没写全，这块积木不会写进卡里`)
  if (plan.scale) {
    const owners = new Map()
    for (const entry of plan.entries ?? []) for (const word of new Set(entry.keywords ?? [])) owners.set(word, [...(owners.get(word) ?? []), entry.owner || entry.name])
    const shared = [...owners].filter(([, names]) => new Set(names).size > 1).map(([word]) => word)
    if (shared.length) warnings.push(msg`这些关键词有两个条目在用，提到时会一起触发：${shared.slice(0, 8).join(msg`、`)}`)
  }
  return warnings
}
