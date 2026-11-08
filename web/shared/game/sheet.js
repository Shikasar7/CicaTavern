// 游戏规则的规则书和角色面板. The rule book belongs to the card (cards/<id>/game.json, server/game.mjs):
// how far the rules go and how the player starts. The sheet belongs to the story: each reply keeps a whole
// one in `node.game`, as it keeps `state`, so branches, rollbacks and saves need nothing of their own.
// Only the rules write it, and only when a reply is made; the model and a card's scripts cannot reach it.
import { bagChanged, bagItems, cleanBindings, numberAt, numberWrite, questsAt } from './bindings.js'
import { SKILLS } from './battle.js'
import { ailsOn, chanceOf, clampDc, judge, modifierOf, rollD20, seedOf, worstAil } from './dice.js'
import { STEPS_PER_RANK, levelOfRank, rankAt, rankPower } from './rank.js'
import { getPath, unwrap } from '../vars.js'

export const LEVELS = ['off', 'light', 'full']
export const DIFFICULTIES = ['easy', 'normal', 'hard']
export const FIGHT_RATES = ['rare', 'normal', 'often']
/** How far apart a card's ranks stand: 境界 are walls, 段位 and 军衔 are steps. */
export const RANK_SPANS = ['wide', 'narrow']
const DC_SHIFT = { easy: -2, normal: 0, hard: 2 }
const TIER_WORDS = { crit: '大成功', success: '成功', close: '险胜', fail: '失败' }
const DEFAULT_DC = 12
// What a roll the player took on brings: a risk is worth more than the safe way round.
const CHECK_EXPERIENCE = { crit: 20, success: 10, close: 5, fail: 0 }

/** Four attributes that suit any story, and the words a model may write for them. */
export const ATTRIBUTES = [
  { id: 'body', name: '体魄', words: ['力量', '耐力', '体力', '臂力', '体质', '运动', '格斗', '肉搏', '攀爬', '游泳'] },
  { id: 'grace', name: '灵巧', words: ['敏捷', '闪避', '潜行', '轻功', '身法', '隐匿', '射击', '驾驶', '开锁', '妙手', '反应'] },
  { id: 'mind', name: '心智', words: ['智力', '感知', '意志', '学识', '洞察', '侦查', '聆听', '灵感', '图书馆', '神秘学', '心理学', '理智', '医学', '医疗', '急救', '科技', '工程', '黑客', '骇入', '计算机', '奥术', '法术', '神学', '信仰', '知识', '调查'] },
  { id: 'charm', name: '魅力', words: ['交涉', '说服', '欺骗', '威吓', '话术', '魅惑', '恐吓', '表演', '外交'] },
]

/**
 * 叫法: what a card calls things, where it is not what the rules call them (力量 for 体魄, HP for 生命, BOSS for 首领).
 * Only words: the numbers, the marks and what is kept do not change. The four attributes by their ids, then the rest.
 */
export const WORD_KEYS = ['body', 'grace', 'mind', 'charm', 'life', 'minion', 'normal', 'elite', 'boss', 'skill', 'bag', 'experience', 'party']
/** What the rules call them, for the model and where the card says nothing. */
export const DEFAULT_WORDS = { body: '体魄', grace: '灵巧', mind: '心智', charm: '魅力', life: '生命', minion: '杂兵', normal: '普通', elite: '精英', boss: '首领', skill: '技能', bag: '行囊', experience: '经验', party: '队伍' }
const MAX_WORD = 8

function cleanWords(value) {
  const out = {}
  if (!isRecord(value)) return out
  for (const key of WORD_KEYS) {
    const word = typeof value[key] === 'string' ? value[key].trim().slice(0, MAX_WORD) : ''
    if (word && word !== DEFAULT_WORDS[key]) out[key] = word
  }
  return out
}

/** A thing by the card's name for it, or the rules' own. */
export const wordFor = (book, key) => book?.words?.[key] || DEFAULT_WORDS[key]

/** The attributes the card has its own names for: { body: '力量', … }. */
export const attributeNames = book => Object.fromEntries(ATTRIBUTES.map(({ id }) => [id, book?.words?.[id]]).filter(([, word]) => word))

export const MIN_ATTRIBUTE = 6
const MAX_ATTRIBUTE = 20
export const AVERAGE = 10
/** What the player may share out over the average when a card's rules are set up. */
export const ATTRIBUTE_POINTS = 8
const MAX_LIFE = 100
const MAX_ENERGY = 30
const MAX_THINGS = 200
const MAX_QUESTS = 100
const MAX_FOES = 100
const MAX_RANKS = 24
const MAX_CONDITIONS = 8
// 队伍: who the card has to stand with the player, who is with them now, and how many of those go into a fight.
const MAX_COMPANIONS = 8
const MAX_PARTY = 8
/** How many stand with the player in a fight: four in all. */
export const MAX_FIELDED = 3
// A skill a companion brings when the card says nothing of what they can do.
const COMPANION_SKILL = '强击'
// How many of the story's days a condition lasts when nobody cures it: a model forgets, and nothing should stay for good.
const AIL_DAYS = { light: 1, medium: 3, heavy: 7 }
// And how many replies at most: a story that writes no dates never sees a day go by.
const AIL_TURNS = { light: 6, medium: 15, heavy: 30 }
/** What a thing that helps adds to a roll. */
export const AID_BONUS = 2
// What a lost fight leaves, and getting up from one.
const DEFEATED = { name: '重伤', stat: '', size: 'medium' }
const RALLIED = { name: '透支', stat: '', size: 'heavy' }
// 理智: it starts below the top and comes back slowly. What a shock costs and calm brings, in points of a hundred.
const MAX_SANITY = 100
const SANITY_START = 80
const SANITY_PER_MIND = 2
const SHOCKS = { light: 3, medium: 8, heavy: 15 }
const CALM = { small: 10, medium: 20, large: 40 }
const SANITY_REST = 1
// At nothing the player goes mad, and comes to with this much of it.
const AFTER_MADNESS = 0.2
const MADNESS = { name: '疯狂', stat: '', size: 'heavy' }
// Low, the mind is not to be trusted: not a condition, it lasts as long as the sanity stays there.
const STRAINS = [[0.25, { name: '濒临崩溃', stat: 'mind', size: 'medium' }], [0.5, { name: '动摇', stat: 'mind', size: 'light' }]]
const FOE_PICTURE = /^[\w-]{1,64}\.(png|jpg|webp)$/
const MAX_OPS = 20
// What a day's rest gives back, of the most there is.
const REST = 0.5
/** What a thing does: a kind, and for three of them how strongly. */
export const EFFECTS = ['heal', 'energy', 'calm', 'damage', 'cure', 'boost', 'none']
export const STRENGTHS = ['small', 'medium', 'large']
const HEAL = { small: 0.25, medium: 0.5, large: 1 }
const ENERGY = { small: 0.33, medium: 0.66, large: 1 }
const STRENGTHLESS = new Set(['cure', 'boost', 'none'])
// What a name says a thing does, the first that fits: 炸药 and 毒药 are no medicine, 子弹 is no blow by itself, 魔力药水 gives back 魔力.
const KEYWORDS = [
  [/子弹|弹匣|弹药|火药/, 'none'],
  [/炸|毒药|毒雾|手榴|燃烧瓶|[符雷]|弹$/, 'damage'],
  [/解毒|净化|圣水/, 'cure'],
  [/镇静|安神|定神|清心/, 'calm'],
  [/魔力|法力|灵力|内力|回气|回蓝|灵泉|灵液|灵石|能量|电池|精力/, 'energy'],
  [/[药丹膏]|急救|绷带|医疗|修复|止血|吗啡|治疗/, 'heal'],
]
const FIELD_WORDS = { life: '生命', energy: '气力', sanity: '理智' }
// What is left to a player beaten in a fight: the story goes on from there.
const AFTER_DEFEAT = 0.3
const LEVEL_POINTS = 2
/** Experience from one level to the next. */
export const levelNeeds = level => level * 100
// What 【受伤】 and 【恢复】 are worth, of the most life there is.
const SIZES = { light: 0.1, medium: 0.25, heavy: 0.5 }

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const words = (value, max) => (Array.isArray(value) ? value.filter(word => typeof word === 'string' && word.trim()).map(word => word.trim().slice(0, 40)).slice(0, max) : [])

function cleanThings(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(thing => isRecord(thing) && typeof thing.name === 'string' && thing.name.trim())
    .map(thing => ({ name: thing.name.trim().slice(0, 40), count: Number.isInteger(thing.count) && thing.count > 0 ? thing.count : 1 }))
    .slice(0, MAX_THINGS)
}

/** A rule book as kept: whatever was stored or sent, what is not known goes and what is missing is the default. */
export function cleanRulebook(value) {
  const book = isRecord(value) ? value : {}
  const start = isRecord(book.start) ? book.start : {}
  const attributes = {}
  for (const { id } of ATTRIBUTES) {
    const stored = Number(book.attributes?.[id])
    attributes[id] = Number.isFinite(stored) ? Math.min(MAX_ATTRIBUTE, Math.max(MIN_ATTRIBUTE, Math.round(stored))) : AVERAGE
  }
  return {
    level: LEVELS.includes(book.level) ? book.level : 'off',
    // 题材: what the rule window shows as picked; what it set is below.
    theme: typeof book.theme === 'string' ? book.theme.slice(0, 20) : '',
    // What this story calls energy; '' = 气力.
    energyName: typeof book.energyName === 'string' ? book.energyName.trim().slice(0, 6) : '',
    difficulty: DIFFICULTIES.includes(book.difficulty) ? book.difficulty : 'normal',
    // 战斗设置: how hard the foes are (a book from before this followed 难度), and how often the story brings them on.
    fightDifficulty: DIFFICULTIES.includes(book.fightDifficulty) ? book.fightDifficulty : DIFFICULTIES.includes(book.difficulty) ? book.difficulty : 'normal',
    fightRate: FIGHT_RATES.includes(book.fightRate) ? book.fightRate : 'normal',
    // 剧情暂停: true, false, or null for what suits the preset (pausesOn).
    pause: typeof book.pause === 'boolean' ? book.pause : null,
    attributes,
    start: { things: cleanThings(start.things), skills: words(start.skills, 40), ...(words(start.party, MAX_PARTY).length ? { party: words(start.party, MAX_PARTY) } : {}), ...(typeof start.rank === 'string' && start.rank.trim() ? { rank: start.rank.trim().slice(0, 40) } : {}) },
    // 等级阶梯: low to high; none and the model says how foes stand to the player.
    ranks: words(book.ranks, MAX_RANKS),
    rankSpan: RANK_SPANS.includes(book.rankSpan) ? book.rankSpan : 'wide',
    // 理智: a story of horror counts it.
    sanity: book.sanity === true,
    bindings: cleanBindings(book.bindings),
    items: cleanItems(book.items),
    skills: cleanSkills(book.skills),
    foes: cleanFoes(book.foes),
    companions: cleanCompanions(book.companions),
    words: cleanWords(book.words),
  }
}

/**
 * How a player starts and what they will meet, in the shape a model writes it (创作角色卡, 辅助模型配置):
 * { attributes, skills: [{ name, kind }], things: [{ name, count, type, size }], foes: [{ name, looks, moves }] }.
 * The attributes share the points the rule window gives.
 */
/** Attributes that share the points the rule window gives, as the player's do. */
function shared(value) {
  const attributes = {}
  let spare = ATTRIBUTE_POINTS
  for (const { id } of ATTRIBUTES) {
    const wanted = Math.round(Number(value?.[id]))
    attributes[id] = Number.isFinite(wanted) ? Math.max(MIN_ATTRIBUTE, Math.min(wanted, AVERAGE + spare)) : AVERAGE
    spare -= attributes[id] - AVERAGE
  }
  return attributes
}

export function cleanKit(raw) {
  const kit = isRecord(raw) ? raw : {}
  const attributes = shared(kit.attributes)
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const named = (value, max) => (Array.isArray(value) ? value : []).filter(item => isRecord(item) && text(item.name, 24)).slice(0, max)
  return {
    attributes,
    skills: named(kit.skills, 6).map(skill => ({ name: text(skill.name, 24), kind: Object.hasOwn(SKILLS, skill.kind) ? skill.kind : '' })),
    things: named(kit.things, 8).map(thing => ({
      name: text(thing.name, 24),
      count: Number.isInteger(thing.count) && thing.count > 0 ? Math.min(thing.count, 9) : 1,
      type: EFFECTS.includes(thing.type) ? thing.type : '',
      size: STRENGTHS.includes(thing.size) ? thing.size : 'medium',
    })),
    foes: named(kit.foes, 8).map(foe => ({ name: text(foe.name, 24), looks: text(foe.looks, 300), moves: words(foe.moves, 4) })),
    // Who travels with the player: the card's own people, each with what they are good at.
    companions: named(kit.companions, 4).map(companion => ({
      name: text(companion.name, 24),
      keys: words(companion.keys, 6),
      attributes: shared(companion.attributes),
      skills: named(companion.skills, 4).map(skill => ({ name: text(skill.name, 24), kind: Object.hasOwn(SKILLS, skill.kind) ? skill.kind : '' })),
      start: companion.start !== false,
    })),
    // What this world calls things and how its ladder runs (创作角色卡 asks; a revised plan comes back in these names).
    energyName: text(kit.energy ?? kit.energyName, 6),
    ranks: words(kit.ranks, MAX_RANKS),
    rankSpan: RANK_SPANS.includes(kit.rank_span ?? kit.rankSpan) ? kit.rank_span ?? kit.rankSpan : 'wide',
    sanity: kit.sanity === true,
    words: cleanWords(kit.words),
  }
}

/** A kit as the rule book's own fields. */
export function kitBook(kit) {
  const set = (items, value) => Object.fromEntries(items.map(item => [item.name, value(item)]))
  return {
    attributes: kit.attributes,
    start: { things: kit.things.map(({ name, count }) => ({ name, count })), skills: kit.skills.map(skill => skill.name), ...((kit.companions ?? []).some(companion => companion.start) ? { party: kit.companions.filter(companion => companion.start).map(companion => companion.name).slice(0, MAX_FIELDED) } : {}) },
    items: set(kit.things.filter(thing => thing.type), ({ type, size }) => ({ type, size })),
    skills: set(kit.skills.filter(skill => skill.kind), skill => skill.kind),
    foes: set(kit.foes, ({ looks, moves }) => ({ looks, moves })),
    ...(Object.keys(kit.words ?? {}).length ? { words: kit.words } : {}),
    ...(kit.companions?.length ? { companions: set(kit.companions, ({ keys, attributes, skills }) => ({ keys, attributes, skills: Object.fromEntries(skills.map(skill => [skill.name, skill.kind])) })) } : {}),
  }
}

/** A kit's world as the rule book's own fields: left out of kitBook, which also serves books that have these already. */
export const kitWorld = ({ energyName = '', ranks = [], rankSpan = 'wide', sanity = false }) => ({ energyName, ranks, rankSpan, sanity })

/** 敌人图鉴: what is known of a foe once it has been met. { name: { looks, moves, file } } */
function cleanFoes(value) {
  const out = {}
  if (!isRecord(value)) return out
  for (const [name, foe] of Object.entries(value).slice(0, MAX_FOES)) {
    if (!isRecord(foe)) continue
    out[name.slice(0, 40)] = {
      looks: typeof foe.looks === 'string' ? foe.looks.trim().slice(0, 300) : '',
      moves: words(foe.moves, 4),
      ...(FOE_PICTURE.test(foe.file ?? '') ? { file: foe.file } : {}),
    }
  }
  return out
}

/** 队伍名册: who the card has to stand with the player. { name: { keys, attributes, skills: { name: kind or '' }, level? } } */
function cleanCompanions(value) {
  const out = {}
  if (!isRecord(value)) return out
  for (const [name, companion] of Object.entries(value).slice(0, MAX_COMPANIONS)) {
    if (!isRecord(companion) || !name.trim()) continue
    const attributes = {}
    for (const { id } of ATTRIBUTES) {
      const stored = Number(companion.attributes?.[id])
      attributes[id] = Number.isFinite(stored) ? Math.min(MAX_ATTRIBUTE, Math.max(MIN_ATTRIBUTE, Math.round(stored))) : AVERAGE
    }
    const skills = {}
    for (const [skill, kind] of Object.entries(isRecord(companion.skills) ? companion.skills : {}).slice(0, 6)) if (skill.trim()) skills[skill.trim().slice(0, 40)] = SKILLS[kind] ? kind : ''
    out[name.trim().slice(0, 40)] = { keys: words(companion.keys, 6), attributes, skills, ...(Number.isInteger(companion.level) && companion.level > 0 ? { level: Math.min(99, companion.level) } : {}) }
  }
  return out
}

/** Who on the card a name is: by their name or another they go by. → { name, ...entry } or null */
export function companionOf(book, name) {
  const said = String(name ?? '').trim()
  if (!said) return null
  const list = Object.entries(book?.companions ?? {})
  const found = list.find(([own]) => own === said) ?? list.find(([, entry]) => (entry.keys ?? []).includes(said))
  return found ? { name: found[0], ...found[1] } : null
}

/** One who has just joined: as the card has them, or, one it does not know, average with one plain skill. */
export function memberOf(book, name, level = 1) {
  const known = companionOf(book, name)
  return {
    name: known?.name ?? String(name).trim().slice(0, 40),
    level: known?.level ?? level,
    experience: 0,
    points: 0,
    attributes: known ? { ...known.attributes } : Object.fromEntries(ATTRIBUTES.map(({ id }) => [id, AVERAGE])),
    life: MAX_LIFE,
    maxLife: MAX_LIFE,
    energy: MAX_ENERGY,
    maxEnergy: MAX_ENERGY,
    skills: known && Object.keys(known.skills).length ? Object.keys(known.skills) : [COMPANION_SKILL],
    bench: false,
    hurt: false,
  }
}

/** Where one of the party is in it, by any name they go by, or -1. */
function memberAt(party, book, name) {
  const own = companionOf(book, name)?.name ?? String(name ?? '').trim()
  return party.findIndex(member => member.name === own)
}

/** Who goes into a fight with the player: those not standing by and not hurt, the first three. */
export const fieldedOf = sheet => (sheet.party ?? []).filter(member => !member.bench && !member.hurt).slice(0, MAX_FIELDED)

/** The kinds of what a companion can do, as the card sets them. */
export function companionKinds(book, name) {
  const skills = companionOf(book, name)?.skills ?? {}
  return Object.fromEntries(Object.entries(skills).filter(([, kind]) => kind))
}

/**
 * A change to the party: join, leave, hurt, back (from being hurt), bench, field, up (one place nearer the front).
 * → the sheet, or null when it changes nothing.
 */
export function partyChanged(sheet, book, act, name) {
  const party = sheet.party ?? []
  const at = memberAt(party, book, name)
  const set = (index, change) => ({ ...sheet, party: party.map((member, i) => (i === index ? { ...member, ...change } : member)) })
  if (act === 'join') {
    if (at >= 0 || party.length >= MAX_PARTY || !String(name ?? '').trim()) return null
    const member = { ...memberOf(book, name, sheet.level ?? 1), bench: fieldedOf(sheet).length >= MAX_FIELDED }
    return { ...sheet, party: [...party, member] }
  }
  if (at < 0) return null
  const member = party[at]
  if (act === 'leave') return { ...sheet, party: party.filter((_, i) => i !== at) }
  if (act === 'hurt') return member.hurt ? null : set(at, { hurt: true })
  if (act === 'back') return member.hurt ? set(at, { hurt: false }) : null
  if (act === 'bench') return member.bench ? null : set(at, { bench: true })
  if (act === 'field') return member.bench && fieldedOf(sheet).length < MAX_FIELDED ? set(at, { bench: false }) : null
  if (act === 'up') {
    if (at === 0) return null
    const moved = party.slice()
    moved.splice(at - 1, 2, party[at], party[at - 1])
    return { ...sheet, party: moved }
  }
  return null
}

/** What stands with the player in a fight, in the shape battle.js takes. */
export const alliesFor = (sheet, book) => fieldedOf(sheet).map(member => ({ ...member, kinds: companionKinds(book, member.name) }))

function cleanSkills(value) {
  const out = {}
  if (!isRecord(value)) return out
  for (const [name, kind] of Object.entries(value).slice(0, MAX_THINGS)) if (SKILLS[kind]) out[name.slice(0, 40)] = kind
  return out
}

function cleanItems(value) {
  const out = {}
  if (!isRecord(value)) return out
  for (const [name, effect] of Object.entries(value).slice(0, MAX_THINGS)) {
    if (!isRecord(effect) || !EFFECTS.includes(effect.type)) continue
    out[name.slice(0, 40)] = { type: effect.type, ...(STRENGTHLESS.has(effect.type) ? {} : { size: STRENGTHS.includes(effect.size) ? effect.size : 'medium' }) }
  }
  return out
}

/** What a thing does: as set for this card, else as its name says, else null. */
export function effectOf(book, name) {
  const set = book.items?.[name]
  if (set) return set
  const type = KEYWORDS.find(([word]) => word.test(name))?.[1]
  return type ? { type, size: 'medium' } : null
}

/** Whether a thing does anything outside a fight. */
export const usableNow = effect => ['heal', 'energy', 'cure', 'calm'].includes(effect?.type)

/** Whether using it now would be wasted: what it restores is full, or there is nothing to cure. */
export function nothingToRestore(effect, sheet) {
  if (effect?.type === 'heal') return sheet.life >= sheet.maxLife
  if (effect?.type === 'cure') return !sheet.conditions?.length
  if (effect?.type === 'calm') return sheet.sanity === undefined || sheet.sanity >= sheet.maxSanity
  return effect?.type === 'energy' && sheet.energy >= sheet.maxEnergy
}

export const rulesOn = book => Boolean(book) && book.level !== 'off'

/**
 * Whether a reply may stop on a mark. An imported preset has its own output format, and 「stop at the mark」
 * can fight it: at the light level it waits to be asked for. A fight has no other way in, so the full level needs it.
 */
export const pausesOn = (book, builtinPreset) => book.level === 'full' || (book.pause ?? builtinPreset)

/** The stops a reply can make at this level. */
export const gateKinds = book => (book.level === 'full' ? ['check', 'battle'] : ['check'])

/** What a mind starts with: a steady one more. */
const startSanity = attributes => Math.min(MAX_SANITY, SANITY_START + (attributes.mind - AVERAGE) * SANITY_PER_MIND)

/** What low sanity does to the mind, while it stays low. */
const strainOf = sheet => (sheet.sanity === undefined ? [] : STRAINS.filter(([share]) => sheet.sanity <= sheet.maxSanity * share).map(([, strain]) => strain).slice(0, 1))

/** The state of the mind in a word, for the model. */
export const sanityWord = sheet => strainOf(sheet)[0]?.name ?? '清醒'

/** The story's first sheet, from what the rule book says the player starts with. */
export function startSheet(book) {
  const { attributes, start, ranks, sanity } = cleanRulebook(book)
  return {
    life: MAX_LIFE,
    maxLife: MAX_LIFE,
    energy: MAX_ENERGY,
    maxEnergy: MAX_ENERGY,
    level: levelOfRank(ranks, start.rank),
    experience: 0,
    points: 0,
    attributes,
    things: start.things,
    skills: start.skills,
    quests: [],
    conditions: [],
    party: startParty(book, levelOfRank(ranks, start.rank)),
    ...(sanity ? { sanity: startSanity(attributes), maxSanity: MAX_SANITY } : {}),
  }
}

/** Who is with the player from the start: as many as fight beside them, the rest standing by. */
function startParty(book, level) {
  const clean = cleanRulebook(book)
  return (clean.start.party ?? []).reduce((sheet, name) => partyChanged(sheet, clean, 'join', name) ?? sheet, { level, party: [] }).party
}

/**
 * The sheet as it stands: the story's, with what lives in the card's variables read from them. A variable that
 * no longer reads as it should leaves the last good value, and says so in `broken`.
 * → sheet + { bound, broken }, which `keptSheet` leaves out.
 */
export function sheetOf(book, game, state) {
  const sheet = { conditions: [], ...(game ?? startSheet(book)) }
  // A story from before there were parties starts with the one the card has now.
  if (!Array.isArray(sheet.party)) sheet.party = startParty(book, sheet.level ?? 1)
  const bindings = book.bindings ?? {}
  const broken = []
  // Turned on in a story under way, it starts now; turned off, it is gone.
  if (book.sanity) {
    sheet.sanity = sheet.sanity ?? startSanity(cleanRulebook(book).attributes)
    sheet.maxSanity = sheet.maxSanity ?? MAX_SANITY
  } else {
    delete sheet.sanity
    delete sheet.maxSanity
  }
  for (const field of ['life', 'maxLife', 'energy', 'maxEnergy', 'level', 'money', ...(book.sanity ? ['sanity'] : [])]) {
    if (!bindings[field]) continue
    const value = numberAt(state, bindings[field])
    if (value === null) broken.push(field)
    else sheet[field] = value
  }
  if (bindings.rank) {
    const words = unwrap(getPath(state ?? {}, bindings.rank))
    if (typeof words === 'string' && words.trim()) sheet.rank = words.trim().slice(0, 40)
    else broken.push('rank')
    // A rank kept in words still says how far along the player is.
    const power = rankPower(book.ranks ?? [], sheet.rank)
    if (power !== null && !bindings.level) sheet.level = power + 1
  }
  // With nothing to say what the most is: the most it has been.
  sheet.maxLife = Math.max(sheet.maxLife, sheet.life)
  sheet.maxEnergy = Math.max(sheet.maxEnergy, sheet.energy)
  if (book.sanity) sheet.maxSanity = Math.max(sheet.maxSanity, sheet.sanity)
  for (const [field, read] of [['things', bagItems], ['quests', questsAt]]) {
    if (!bindings[field]) continue
    const value = read(getPath(state ?? {}, bindings[field]))
    if (value === null) broken.push(field)
    else sheet[field] = value
  }
  return { ...sheet, strain: strainOf(sheet), bound: Object.keys(bindings), broken, named: attributeNames(book) }
}

/** A sheet as a reply keeps it: a rank in words is the card's, read again each time. */
export function keptSheet({ bound, broken, rank, strain, named, ...sheet }) {
  return sheet
}

/** The sheet the story has reached along a path: the newest reply that keeps one. */
export function sheetOnPath(path) {
  for (let i = path.length - 1; i >= 0; i--) if (path[i].game) return path[i].game
  return null
}

/** The sheet a turn leaves before its reply has said anything: where the story stood, with what the turn settled. `path` ends with the turn. */
export function turnSheet(book, path) {
  const told = path.slice(0, -1)
  const reply = [...told].reverse().find(node => node.role === 'assistant')
  return applyOps(sheetOf(book, sheetOnPath(told), reply?.state), book, path.at(-1)?.gameOps ?? []).sheet
}

/** An attribute's id from what a mark calls it, or null for a word that is none of them. */
export function attributeOf(word, named = {}) {
  const text = String(word ?? '').trim()
  // The card's own name first: its 速度 is 灵巧, whatever the word list says of it.
  const own = Object.entries(named ?? {}).find(([, name]) => name === text)?.[0]
  return own ?? ATTRIBUTES.find(item => item.name === text || item.words.includes(text))?.id ?? null
}

/** What holds the player back on a roll on this word: [{ name, by }]. A word that is no attribute feels only what is on everything. */
export const ailsFor = (sheet, word) => ailsOn([...(sheet.conditions ?? []), ...(sheet.strain ?? [])], attributeOf(word, sheet.named))

/** What the sheet adds to a roll on this word. A word that is no attribute adds nothing of its own. */
export function modifierFor(sheet, word) {
  const id = attributeOf(word, sheet.named)
  return (id ? modifierOf(sheet.attributes[id]) : 0) - ailsFor(sheet, word).reduce((sum, ail) => sum + ail.by, 0)
}

/** The player's rank in words, '' on a card with none. */
export const rankNow = (sheet, book) => sheet.rank ?? rankAt(book.ranks ?? [], sheet.level ?? 1)

export const dcFor = (dc, difficulty) => clampDc(dc + (DC_SHIFT[difficulty] ?? 0))

/** The thing in the bag a word means: the same name, else one that holds the other (钥匙, 铜钥匙). */
function inBag(sheet, word) {
  if (!word) return null
  return sheet.things.find(thing => thing.name === word) ?? sheet.things.find(thing => thing.name.includes(word) || word.includes(thing.name)) ?? null
}

/** What the bag does for a check: the thing that helps, if it is there; the thing it cannot do without, if it is not. → { aid, lacks } */
export function aidFor(sheet, check) {
  return { aid: inBag(sheet, check.item)?.name ?? '', lacks: check.needs && !inBag(sheet, check.needs) ? check.needs : '' }
}

/** A check as sent by the page: only what a roll needs. */
export function cleanCheck(value) {
  if (!isRecord(value)) return null
  const dc = Number(value.dc)
  const named = field => (typeof value[field] === 'string' && value[field].trim() ? { [field]: value[field].trim().slice(0, 40) } : {})
  return { stat: typeof value.stat === 'string' ? value.stat.trim().slice(0, 40) : '', dc: Number.isFinite(dc) ? clampDc(dc) : DEFAULT_DC, ...named('item'), ...named('needs') }
}

/**
 * A roll on the sheet. `spot` is what makes it this roll and no other (the chat, the reply it follows,
 * the action): the same spot always rolls the same, on the page and on the server.
 */
export function rollCheck(sheet, book, check, ...spot) {
  const dc = dcFor(check.dc, book.difficulty)
  const ails = ailsFor(sheet, check.stat)
  const { aid, lacks } = aidFor(sheet, check)
  const result = judge(rollD20(seedOf(...spot, check.stat, String(check.dc))), modifierFor(sheet, check.stat) + (aid ? AID_BONUS : 0), dc)
  return { stat: check.stat, ...result, ...(lacks ? { tier: 'fail', lacks } : {}), ...(ails.length ? { ails } : {}), ...(aid ? { aid: { name: aid, by: AID_BONUS } } : {}) }
}

/** The chance a choice is shown with, in percent. */
export function chanceFor(sheet, book, check) {
  const { aid, lacks } = aidFor(sheet, check)
  return lacks ? 0 : chanceOf(modifierFor(sheet, check.stat) + (aid ? AID_BONUS : 0), dcFor(check.dc, book.difficulty))
}

/** A roll in a line: what a settling turn says it was, for the model and for what comes after a compaction. */
export function checkLine(result) {
  return `掷骰：${result.stat ? `${result.stat} ` : ''}${result.total}，需要 ${result.dc}，${result.lacks ? `缺${result.lacks}，` : ''}${TIER_WORDS[result.tier]}`
}

/** The experience a roll brings: only where the rules count levels. */
export const checkExperience = (book, result) => (book.level === 'full' ? CHECK_EXPERIENCE[result.tier] ?? 0 : 0)

function gain(things, { name, count }) {
  const held = things.find(thing => thing.name === name)
  if (held) return things.map(thing => (thing === held ? { ...thing, count: thing.count + count } : thing))
  return things.length < MAX_THINGS ? [...things, { name, count }] : things
}

function lose(things, { name, count }) {
  return things.flatMap(thing => {
    if (thing.name !== name) return [thing]
    return thing.count > count ? [{ ...thing, count: thing.count - count }] : []
  })
}

function quest(quests, { status, title, note }) {
  const held = quests.find(item => item.title === title)
  if (held) return quests.map(item => (item === held ? { ...item, status, note: note || item.note } : item))
  return quests.length < MAX_QUESTS ? [...quests, { title, note, status }] : quests
}

// What the 队伍 window may do, and what the model is told of it.
const PARTY_ACTS = ['join', 'leave', 'bench', 'field', 'up', 'back']
const PARTY_WORDS = { join: '加入了队伍', leave: '离开了队伍', bench: '这次不上场，在队伍里待命', field: '回到出战的队伍里', up: '在队伍里往前站了一位', back: '伤好了，能上场了', hurt: '负伤，暂时不能上场' }

/** Turn operations as sent by the page: only what is known. */
export function cleanOps(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const op of value.slice(0, MAX_OPS)) {
    if (!isRecord(op)) continue
    const name = typeof op.name === 'string' ? op.name.trim().slice(0, 40) : ''
    const count = Number.isInteger(op.count) && op.count > 0 ? op.count : 1
    if (op.op === 'use' && name) out.push({ op: 'use', name })
    else if ((op.op === 'gain' || op.op === 'lose') && name) out.push({ op: op.op, name, count })
    else if (['life', 'energy', 'sanity'].includes(op.op) && Number.isFinite(Number(op.value))) out.push({ op: op.op, value: Math.round(Number(op.value)) })
    else if (op.op === 'quest' && name && ['new', 'done', 'failed'].includes(op.status)) out.push({ op: 'quest', name, status: op.status })
    else if (op.op === 'point' && ATTRIBUTES.some(item => item.id === op.id)) out.push({ op: 'point', id: op.id, ...(typeof op.who === 'string' && op.who.trim() ? { who: op.who.trim().slice(0, 40) } : {}) })
    else if (op.op === 'party' && name && PARTY_ACTS.includes(op.act)) out.push({ op: 'party', act: op.act, name })
    else if (op.op === 'mend' && name) out.push({ op: 'mend', name })
  }
  return out
}

/** A condition on top of those there are: the same one again is the worse of the two, its days counted from now. */
function ailed(conditions, { name, stat, size }) {
  const before = conditions.find(item => item.name === name)
  const worst = before && AIL_DAYS[before.size] > AIL_DAYS[size] ? before.size : size
  return [...conditions.filter(item => item !== before), { name, stat, size: worst, days: AIL_DAYS[worst], turns: AIL_TURNS[worst] }].slice(-MAX_CONDITIONS)
}

const held = (sheet, name) => sheet.things.find(thing => thing.name === name)?.count ?? 0
const clampTo = (value, most) => Math.max(0, Math.min(most, value))

/** Experience gained, and the levels and points that come of it. A level the card keeps itself is the card's to raise. */
function grow(sheet, experience) {
  let { level = 1, points = 0 } = sheet
  let total = (sheet.experience ?? 0) + experience
  if (!sheet.bound?.includes('level') && !sheet.bound?.includes('rank')) {
    while (total >= levelNeeds(level)) {
      total -= levelNeeds(level)
      level += 1
      points += LEVEL_POINTS
    }
  }
  return { ...sheet, level, points, experience: total }
}

/** A blow to the mind: at nothing it breaks, and comes back with a madness that wears off like anything else. */
function shaken(sheet, lost) {
  const sanity = sheet.sanity - lost
  if (sanity > 0) return { ...sheet, sanity }
  return { ...sheet, sanity: Math.round(sheet.maxSanity * AFTER_MADNESS), conditions: ailed(sheet.conditions ?? [], MADNESS) }
}

/** A steady mind takes a little less of it, never nothing. */
const shock = (sheet, size) => Math.max(1, SHOCKS[size] - Math.max(0, modifierOf(sheet.attributes.mind)))

/** A fight's outcome on the sheet: nothing changed until now, whatever it took. */
function afterFight(sheet, op) {
  const things = Object.entries(op.used).reduce((left, [name, count]) => lose(left, { name, count }), sheet.things)
  const life = op.over === 'lost' ? Math.max(1, Math.round(sheet.maxLife * AFTER_DEFEAT)) : op.life
  const energy = sheet.bound?.includes('energy') ? op.energy : sheet.energy
  const left = (sheet.conditions ?? []).filter(item => !op.cured?.includes(item.name))
  const conditions = [...(op.over === 'lost' ? [DEFEATED] : []), ...(op.rallied ? [RALLIED] : [])].reduce(ailed, left)
  const party = (sheet.party ?? []).map(member => {
    const fought = op.party?.find(item => item.name === member.name)
    if (!fought) return member
    const life = op.over === 'lost' ? Math.max(1, Math.round(member.maxLife * AFTER_DEFEAT)) : Math.max(1, Math.min(member.maxLife, fought.life))
    // Those who fell get half of what the fight was worth.
    return grow({ ...member, life }, op.over === 'lost' ? 0 : fought.fell ? Math.floor(op.experience / 2) : op.experience)
  })
  const after = { ...sheet, things, life, energy, conditions, ...(sheet.party ? { party } : {}) }
  return grow(op.shock && sheet.sanity !== undefined ? shaken(after, op.shock) : after, op.experience)
}

/** One operation on the sheet: { sheet, line } (what the model is told), or null when it cannot be done now. */
function applyOp(sheet, book, op) {
  if (op.op === 'battle') return { sheet: afterFight(sheet, op), line: '' }
  if (op.op === 'grow') return { sheet: grow(sheet, op.experience), line: '' }
  if (op.op === 'point' && op.who) {
    const item = ATTRIBUTES.find(attribute => attribute.id === op.id)
    const at = (sheet.party ?? []).findIndex(member => member.name === op.who)
    const member = sheet.party?.[at]
    if (!member?.points || member.attributes[op.id] >= MAX_ATTRIBUTE) return null
    const party = sheet.party.map((one, i) => (i === at ? { ...one, points: one.points - 1, attributes: { ...one.attributes, [op.id]: one.attributes[op.id] + 1 } } : one))
    return { sheet: { ...sheet, party }, line: `玩家给${member.name}的${item.name}加了 1 点` }
  }
  if (op.op === 'party') {
    const after = partyChanged(sheet, book, op.act, op.name)
    return after ? { sheet: after, line: `${companionOf(book, op.name)?.name ?? op.name}${PARTY_WORDS[op.act]}` } : null
  }
  if (op.op === 'point') {
    const item = ATTRIBUTES.find(attribute => attribute.id === op.id)
    if (!sheet.points || sheet.attributes[op.id] >= MAX_ATTRIBUTE) return null
    return { sheet: { ...sheet, points: sheet.points - 1, attributes: { ...sheet.attributes, [op.id]: sheet.attributes[op.id] + 1 } }, line: `玩家把 1 点加到${item.name}` }
  }
  if (op.op === 'use') {
    const effect = effectOf(book, op.name)
    if (!held(sheet, op.name) || !usableNow(effect)) return null
    const after = { ...sheet, things: lose(sheet.things, { name: op.name, count: 1 }) }
    if (effect.type === 'calm') {
      if (nothingToRestore(effect, sheet)) return null
      const sanity = Math.min(sheet.maxSanity, sheet.sanity + CALM[effect.size ?? 'medium'])
      return { sheet: { ...after, sanity }, line: `玩家使用了${op.name}，已扣除，理智 +${sanity - sheet.sanity}` }
    }
    if (effect.type === 'cure') {
      if (!sheet.conditions?.length) return null
      const cured = worstAil(sheet.conditions)
      return { sheet: { ...after, conditions: sheet.conditions.filter(item => item !== cured) }, line: `玩家使用了${op.name}，已扣除，${cured.name}好了` }
    }
    if (effect.type === 'heal') {
      const life = Math.min(sheet.maxLife, sheet.life + Math.round(sheet.maxLife * HEAL[effect.size]))
      return { sheet: { ...after, life }, line: `玩家使用了${op.name}，已扣除，生命 +${life - sheet.life}` }
    }
    const energy = Math.min(sheet.maxEnergy, sheet.energy + Math.round(sheet.maxEnergy * ENERGY[effect.size]))
    return { sheet: { ...after, energy }, line: `玩家使用了${op.name}，已扣除，气力 +${energy - sheet.energy}` }
  }
  if (op.op === 'gain') return { sheet: { ...sheet, things: gain(sheet.things, op) }, line: `背包里多了${op.name}×${op.count}` }
  if (op.op === 'lose') return held(sheet, op.name) ? { sheet: { ...sheet, things: lose(sheet.things, op) }, line: `背包里少了${op.name}×${Math.min(op.count, held(sheet, op.name))}` } : null
  if (op.op === 'quest') return { sheet: { ...sheet, quests: quest(sheet.quests, { status: op.status, title: op.name, note: '' }) }, line: `任务「${op.name}」：${{ new: '进行中', done: '已完成', failed: '已失败' }[op.status]}` }
  if (op.op === 'mend') return sheet.conditions?.some(item => item.name === op.name) ? { sheet: { ...sheet, conditions: sheet.conditions.filter(item => item.name !== op.name) }, line: `${op.name}好了` } : null
  if (op.op === 'sanity' && sheet.sanity === undefined) return null
  const most = { life: sheet.maxLife, energy: sheet.maxEnergy, sanity: sheet.maxSanity }[op.op]
  return { sheet: { ...sheet, [op.op]: clampTo(op.value, most) }, line: `${FIELD_WORDS[op.op]}改为 ${clampTo(op.value, most)}` }
}

/**
 * The turn's operations on the sheet, in order; one that cannot be done is left out.
 * → { sheet, ops (those done), lines (for the model), spent (things used up), dropped }
 */
export function applyOps(sheet, book, ops) {
  const done = { sheet, ops: [], lines: [], spent: [], dropped: [] }
  for (const op of ops) {
    const result = applyOp(done.sheet, book, op)
    if (!result) {
      done.dropped.push(op)
      continue
    }
    done.sheet = result.sheet
    done.ops.push(op)
    if (result.line) done.lines.push(result.line)
    if (op.op === 'use' || op.op === 'lose') done.spent.push(op.name)
    if (op.op === 'battle') for (const [name, count] of Object.entries(op.used)) done.spent.push(...Array(count).fill(name))
  }
  return done
}

/**
 * What the operations change in the card's own variables. A number as what it comes to, so whatever the
 * model does to it this turn it ends up there; a bag in its own shape.
 */
export function opWrites(book, state, before, after, ops) {
  const bindings = book.bindings ?? {}
  const writes = []
  for (const field of ['life', 'energy', 'sanity']) {
    if (bindings[field] && before[field] !== after[field]) writes.push(numberWrite(state, bindings[field], after[field]))
  }
  if (bindings.things) {
    let bag = getPath(state ?? {}, bindings.things)
    let touched = false
    for (const op of ops) {
      if (op.op === 'battle') {
        for (const [name, count] of Object.entries(op.used)) {
          bag = bagChanged(bag, name, -count)
          touched = true
        }
      }
      if (op.op !== 'use' && op.op !== 'gain' && op.op !== 'lose') continue
      bag = bagChanged(bag, op.name, op.op === 'gain' ? op.count : -(op.count ?? 1))
      touched = true
    }
    if (touched) writes.push({ op: 'replace', path: bindings.things, value: bag })
  }
  return writes
}

/** Up the ladder as the story says, a rank at a time at most. Down it the story cannot go. */
function promoted(sheet, power) {
  const level = power === null ? sheet.level : Math.min(power + 1, sheet.level + STEPS_PER_RANK)
  return level > sheet.level ? { ...sheet, level, experience: 0, points: (sheet.points ?? 0) + LEVEL_POINTS } : sheet
}

function applyMark(sheet, mark, ranks, book) {
  if (mark.kind === 'party') return partyChanged(sheet, book, mark.act, mark.name) ?? sheet
  if (mark.kind === 'learn' && mark.who) {
    const at = (sheet.party ?? []).findIndex(member => member.name === (companionOf(book, mark.who)?.name ?? mark.who))
    if (at < 0 || sheet.party[at].skills.includes(mark.name)) return sheet
    return { ...sheet, party: sheet.party.map((member, i) => (i === at ? { ...member, skills: [...member.skills, mark.name] } : member)) }
  }
  if (mark.kind === 'gain') return { ...sheet, things: gain(sheet.things, mark) }
  if (mark.kind === 'lose') return { ...sheet, things: lose(sheet.things, mark) }
  if (mark.kind === 'quest') return { ...sheet, quests: quest(sheet.quests, mark) }
  if (mark.kind === 'learn') return sheet.skills.includes(mark.name) ? sheet : { ...sheet, skills: [...sheet.skills, mark.name] }
  if (mark.kind === 'promote') return promoted(sheet, rankPower(ranks, mark.name))
  if (mark.kind === 'sanity') return mark.back ? { ...sheet, sanity: Math.min(sheet.maxSanity, sheet.sanity + SHOCKS[mark.size]) } : shaken(sheet, shock(sheet, mark.size))
  if (mark.kind === 'ail') return { ...sheet, conditions: ailed(sheet.conditions ?? [], { ...mark, stat: attributeOf(mark.stat, attributeNames(book)) ?? '' }) }
  if (mark.kind === 'mend') return { ...sheet, conditions: (sheet.conditions ?? []).filter(item => item.name !== mark.name) }
  // Only a fight can bring the player down: the story leaves them standing.
  const amount = Math.round(sheet.maxLife * SIZES[mark.size])
  if (mark.kind === 'hurt') return { ...sheet, life: Math.max(1, sheet.life - amount) }
  if (mark.kind === 'heal') return { ...sheet, life: Math.min(sheet.maxLife, sheet.life + amount) }
  return sheet
}

// What a mark touches: a field the card keeps itself takes no marks, or the story would count it twice.
const MARK_FIELD = { gain: 'things', lose: 'things', quest: 'quests', hurt: 'life', heal: 'life', sanity: 'sanity' }

/** A reply gone by, and a day if it opened one: what is left of each condition. */
const wornOff = (conditions, newDay) => (conditions ?? []).map(item => ({ ...item, days: item.days - (newDay ? 1 : 0), turns: (item.turns ?? AIL_TURNS[item.size]) - 1 })).filter(item => item.days > 0 && item.turns > 0)

/**
 * The sheet after a reply: its marks, and a night's rest when it opened a new day.
 * @param options.bound - the fields the card keeps itself.
 * @param options.spent - things this turn already took out: a 【失去】 of one says the same again.
 * @param options.fought - this turn settled a fight: life is as it left it, a 【受伤】 would count the same blows twice.
 * @param options.ranks - the card's ladder: a 【晋升】 with none, or on a card that keeps the level itself, says nothing.
 * @param options.book - the rule book, for who on the card one who joins is.
 */
export function settleReply(sheet, marks, { bound = [], spent = [], newDay = false, fought = false, ranks = [], book = {} } = {}) {
  const left = [...spent]
  const taken = marks.filter(mark => {
    if (bound.includes(MARK_FIELD[mark.kind])) return false
    if (fought && MARK_FIELD[mark.kind] === 'life') return false
    if (mark.kind === 'promote' && (bound.includes('level') || bound.includes('rank'))) return false
    if (mark.kind === 'sanity' && sheet.sanity === undefined) return false
    const at = mark.kind === 'lose' ? left.indexOf(mark.name) : -1
    if (at >= 0) left.splice(at, 1)
    return at < 0
  })
  // What this reply brought on is counted from this day.
  const settled = taken.reduce((held, mark) => applyMark(held, mark, ranks, book), { ...sheet, conditions: wornOff(sheet.conditions, newDay) })
  if (!newDay) return settled
  // A night's rest is the party's as well, and a hurt companion is fit again by morning.
  const party = (settled.party ?? []).map(member => ({ ...member, hurt: false, life: Math.min(member.maxLife, member.life + Math.round(member.maxLife * REST)), energy: Math.min(member.maxEnergy, member.energy + Math.round(member.maxEnergy * REST)) }))
  return {
    ...settled,
    ...(settled.party ? { party } : {}),
    life: bound.includes('life') ? settled.life : Math.min(settled.maxLife, settled.life + Math.round(settled.maxLife * REST)),
    energy: bound.includes('energy') ? settled.energy : Math.min(settled.maxEnergy, settled.energy + Math.round(settled.maxEnergy * REST)),
    ...(settled.sanity === undefined || bound.includes('sanity') ? {} : { sanity: Math.min(settled.maxSanity, settled.sanity + SANITY_REST) }),
  }
}
