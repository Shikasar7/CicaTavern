// 游戏规则的规则书和角色面板. The rule book belongs to the card (cards/<id>/game.json, server/game.mjs):
// how far the rules go and how the player starts. The sheet belongs to the story: each reply keeps a whole
// one in `node.game`, as it keeps `state`, so branches, rollbacks and saves need nothing of their own.
// Only the rules write it, and only when a reply is made; the model and a card's scripts cannot reach it.
import { bagChanged, bagItems, cleanBindings, numberAt, numberWrite, questsAt } from './bindings.js'
import { DEFAULT_SKILLS, SKILLS, cleanAdds, cleanFoeAdds, skillKindOf } from './battle.js'
import { ailsOn, chanceOf, clampDc, judge, modifierOf, rollD20, seedOf, worstAil } from './dice.js'
import { GEAR_SLOTS, PLAYER_FORMS, PRACTICE_DC, cleanGear, gearOf, practiceNeeds } from './growth.js'
import { SKIP_POINTS, bigsOwed, bonusOf, canTake, checkBonus, cleanGrowth, cleanPerks, fightBonus, grownMost, growsOn, perkFor, perkOf, perksOn, perksOwed, skillGrowth } from './growth.js'
import { cleanForms, fightOnly, formAt, formForFight, formOf, formReady, formsOf, nextStageAt, rankGives, skillsInForm, taughtSkills } from './growth.js'
import { bondOf, bondPointsOf, everyGives, levelPointsOf, perkEveryOf, rankRestores } from './growth.js'
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
// 装备: the three places a thing is worn (`trinket` is the slot the rules call charm: that word is an attribute's here) and the four rarities.
export const WORD_KEYS = ['body', 'grace', 'mind', 'charm', 'life', 'minion', 'normal', 'elite', 'boss', 'skill', 'bag', 'experience', 'party', 'perk', 'weapon', 'armour', 'trinket', 'common', 'fine', 'rare', 'epic', 'form', 'evolve']
/** What the rules call them, for the model and where the card says nothing. */
export const DEFAULT_WORDS = { body: '体魄', grace: '灵巧', mind: '心智', charm: '魅力', life: '生命', minion: '杂兵', normal: '普通', elite: '精英', boss: '首领', skill: '技能', bag: '行囊', experience: '经验', party: '队伍', perk: '天赋', weapon: '武器', armour: '防具', trinket: '饰品', common: '普通', fine: '精良', rare: '稀有', epic: '传说', form: '形态', evolve: '进化' }
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
// As often as a skill's use is counted: far past where it stops mattering.
const MAX_USES = 999
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
const MAX_SKILL_PICTURES = 120
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
// 成长节奏: how much experience a level takes, beside what it usually does.
export const PACES = ['fast', 'normal', 'slow']
const PACE_NEEDS = { fast: 0.6, normal: 1, slow: 1.5 }

/** The experience a level takes to leave, at the pace the card keeps (`book`; the usual one without). */
export const levelNeeds = (level, book) => Math.round(level * 100 * (PACE_NEEDS[book?.pace] ?? 1))
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
  // 形态 and the skills a 天赋 or a form teaches: a skill that comes with its kind is one the card knows from then on.
  const forms = cleanForms(book.forms)
  const taught = taughtSkills({ perks: cleanPerks(book.perks), forms })
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
    skills: { ...taught, ...cleanSkills(book.skills) },
    foes: cleanFoes(book.foes),
    // 技能特写: a skill's own picture, cut in full screen when it is used. Kept only when some skill has one.
    ...(Object.keys(cleanSkillPictures(book.skillPictures)).length ? { skillPictures: cleanSkillPictures(book.skillPictures) } : {}),
    companions: cleanCompanions(book.companions),
    words: cleanWords(book.words),
    // 成长 (growth.js): how far it goes, and the 天赋 that are this card's own. Neither said is the rules as they were.
    ...(cleanGrowth(book.growth) ? { growth: cleanGrowth(book.growth) } : {}),
    // 技能的附加: kept only when a skill has some.
    ...(Object.keys(cleanSkillAdds(book.skillAdds, { skills: cleanSkills(book.skills), companions: book.companions })).length ? { skillAdds: cleanSkillAdds(book.skillAdds, { skills: cleanSkills(book.skills), companions: book.companions }) } : {}),
    // 成长节奏: kept only when it is not the usual one, so a book from before this is as it was.
    ...(PACES.includes(book.pace) && book.pace !== 'normal' ? { pace: book.pace } : {}),
    ...(cleanPerks(book.perks).length ? { perks: cleanPerks(book.perks) } : {}),
    ...(Object.keys(forms).length ? { forms } : {}),
    // 玩法模块 (plans/14): who fights, what beats what, and whether a foe brought down can be taken along. Each kept only when on.
    ...(book.lead === 'command' ? { lead: 'command' } : {}),
    ...(book.tame === true ? { tame: true } : {}),
    ...(Object.keys(cleanTypes(book.types)).length ? { types: cleanTypes(book.types), ...(Object.keys(cleanSkillTypes(book.skillTypes, cleanTypes(book.types))).length ? { skillTypes: cleanSkillTypes(book.skillTypes, cleanTypes(book.types)) } : {}), ...(Object.hasOwn(cleanTypes(book.types), typeName(book.selfType)) ? { selfType: typeName(book.selfType) } : {}) } : {}),
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
    skills: named(kit.skills, 6).map(kitSkill),
    things: named(kit.things, 8).map(thing => ({
      name: text(thing.name, 24),
      count: Number.isInteger(thing.count) && thing.count > 0 ? Math.min(thing.count, 9) : 1,
      type: thing.type === 'gear' || EFFECTS.includes(thing.type) ? thing.type : '',
      size: STRENGTHS.includes(thing.size) ? thing.size : 'medium',
      // 装备: where it is worn, how rare, what it does.
      ...(cleanGear(thing, text(thing.name, 24)) ? { gear: cleanGear(thing, text(thing.name, 24)) } : {}),
    })),
    foes: named(kit.foes, 8).map(foe => ({ name: text(foe.name, 24), looks: text(foe.looks, 300), moves: words(foe.moves, 4), ...(cleanFoeAdds(foe.adds).length ? { adds: cleanFoeAdds(foe.adds) } : {}), ...(typeName(foe.type) ? { type: typeName(foe.type) } : {}) })),
    // Who travels with the player: the card's own people, each with what they are good at.
    companions: named(kit.companions, 4).map(companion => ({
      name: text(companion.name, 24),
      keys: words(companion.keys, 6),
      attributes: shared(companion.attributes),
      skills: named(companion.skills, 4).map(kitSkill),
      start: companion.start !== false,
      ...(typeName(companion.type) ? { type: typeName(companion.type) } : {}),
    })),
    // What this world calls things and how its ladder runs (创作角色卡 asks; a revised plan comes back in these names).
    energyName: text(kit.energy ?? kit.energyName, 6),
    ranks: words(kit.ranks, MAX_RANKS),
    rankSpan: RANK_SPANS.includes(kit.rank_span ?? kit.rankSpan) ? kit.rank_span ?? kit.rankSpan : 'wide',
    sanity: kit.sanity === true,
    words: cleanWords(kit.words),
    // 天赋 of this world's own, each with effects from the rules' table (growth.js).
    perks: cleanPerks(kit.perks),
    // 形态: who changes into what, where this world has that.
    ...(Object.keys(cleanForms(kit.forms)).length ? { forms: cleanForms(kit.forms) } : {}),
    // 玩法模块: only what this world has.
    ...(Object.keys(cleanTypes(kit.types)).length ? { types: cleanTypes(kit.types), ...(Object.hasOwn(cleanTypes(kit.types), typeName(kit.selfType)) ? { selfType: typeName(kit.selfType) } : {}) } : {}),
    ...(kit.lead === 'command' ? { lead: 'command' } : {}),
    ...(kit.tame === true ? { tame: true } : {}),
  }
}

/** A kit as the rule book's own fields. */
/** A kit's skill as kept: its name, its kind when one was given, and what it does on top when that could be read. */
function kitSkill(skill) {
  const name = typeof skill.name === 'string' ? skill.name.trim().slice(0, 24) : ''
  const kind = Object.hasOwn(SKILLS, skill.kind) ? skill.kind : ''
  const adds = cleanAdds(skill.adds, kind || skillKindOf(name))
  return { name, kind, ...(adds.length ? { adds } : {}), ...(typeName(skill.type) ? { type: typeName(skill.type) } : {}) }
}

/** The adds of a kit's skills, the player's and the companions', by the skill's name: the first to have a name keeps it. */
function kitAdds(kit) {
  const out = new Map()
  for (const skill of [...kit.skills, ...(kit.companions ?? []).flatMap(companion => companion.skills)]) if (skill.adds?.length && !out.has(skill.name)) out.set(skill.name, skill.adds)
  return [...out]
}

export function kitBook(kit) {
  const set = (items, value) => Object.fromEntries(items.map(item => [item.name, value(item)]))
  return {
    attributes: kit.attributes,
    start: { things: kit.things.map(({ name, count }) => ({ name, count })), skills: kit.skills.map(skill => skill.name), ...((kit.companions ?? []).some(companion => companion.start) ? { party: kit.companions.filter(companion => companion.start).map(companion => companion.name).slice(0, MAX_FIELDED) } : {}) },
    items: set(kit.things.filter(thing => thing.type), ({ type, size, gear }) => gear ?? { type, size }),
    skills: set(kit.skills.filter(skill => skill.kind), skill => skill.kind),
    ...(kitAdds(kit).length ? { skillAdds: Object.fromEntries(kitAdds(kit)) } : {}),
    foes: set(kit.foes, ({ looks, moves, adds, type }) => ({ looks, moves, ...(adds?.length ? { adds } : {}), ...(type ? { type } : {}) })),
    ...(kit.types ? { types: kit.types, skillTypes: Object.fromEntries([...kit.skills, ...(kit.companions ?? []).flatMap(companion => companion.skills)].filter(skill => skill.type).map(skill => [skill.name, skill.type])), ...(kit.selfType ? { selfType: kit.selfType } : {}) } : {}),
    ...(kit.lead ? { lead: kit.lead } : {}),
    ...(kit.tame ? { tame: true } : {}),
    ...(Object.keys(kit.words ?? {}).length ? { words: kit.words } : {}),
    // A kit that brings 天赋 is for a card that has them to choose; any other grows as a level makes it.
    growth: { level: kit.perks?.length ? 'rich' : 'standard' },
    ...(kit.perks?.length ? { perks: kit.perks } : {}),
    ...(kit.forms ? { forms: kit.forms } : {}),
    ...(kit.companions?.length ? { companions: set(kit.companions, ({ keys, attributes, skills, type }) => ({ keys, attributes, skills: Object.fromEntries(skills.map(skill => [skill.name, skill.kind])), ...(type ? { type } : {}) })) } : {}),
  }
}

/** A kit's world as the rule book's own fields: left out of kitBook, which also serves books that have these already. */
export const kitWorld = ({ energyName = '', ranks = [], rankSpan = 'wide', sanity = false }) => ({ energyName, ranks, rankSpan, sanity })

/** 敌人图鉴: what is known of a foe once it has been met. { name: { looks, moves, file, adds? } }; `adds` is what its blows leave behind when it comes as a 精英 or a 首领 (battle.js FOE_ADDS). */
/**
 * 技能特写: every skill the book names, with whose it is: { name, owner } where owner is a companion's name, or '' for
 * the player (their own, a 天赋's, or one of their forms').
 */
export function skillsNamed(book) {
  const out = new Map()
  for (const name of book?.start?.skills ?? []) out.set(name, '')
  for (const [owner, companion] of Object.entries(book?.companions ?? {})) for (const name of Object.keys(companion.skills ?? {})) if (!out.has(name)) out.set(name, owner)
  for (const [owner, chain] of Object.entries(book?.forms ?? {})) for (const form of chain) for (const name of Object.keys(form.skills ?? {})) if (!out.has(name)) out.set(name, owner === PLAYER_FORMS || !book?.companions?.[owner] ? '' : owner)
  for (const name of Object.keys(book?.skills ?? {})) if (!out.has(name)) out.set(name, '')
  return [...out].map(([name, owner]) => ({ name, owner }))
}

/** 技能特写: { skill name: its picture's file }, the files as the server writes them. */
export function cleanSkillPictures(value) {
  const out = {}
  if (!isRecord(value)) return out
  for (const [name, file] of Object.entries(value)) {
    const key = name.trim().slice(0, 40)
    if (!key || !FOE_PICTURE.test(file ?? '')) continue
    out[key] = file
    if (Object.keys(out).length >= MAX_SKILL_PICTURES) break
  }
  return out
}

function cleanFoes(value) {
  const out = {}
  if (!isRecord(value)) return out
  for (const [name, foe] of Object.entries(value).slice(0, MAX_FOES)) {
    if (!isRecord(foe)) continue
    out[name.slice(0, 40)] = {
      looks: typeof foe.looks === 'string' ? foe.looks.trim().slice(0, 300) : '',
      moves: words(foe.moves, 4),
      ...(FOE_PICTURE.test(foe.file ?? '') ? { file: foe.file } : {}),
      ...(cleanFoeAdds(foe.adds).length ? { adds: cleanFoeAdds(foe.adds) } : {}),
      ...(typeName(foe.type) ? { type: typeName(foe.type) } : {}),
    }
  }
  return out
}

/** A type's name, as kept: a few characters, or ''. */
const typeName = value => (typeof value === 'string' ? value.trim().slice(0, 8) : '')
const MAX_TYPES = 8

/** 类型克制: the card's types and what each beats, as kept: { type: [those it beats] }. Fewer than two is none. */
export function cleanTypes(value) {
  const out = {}
  if (!isRecord(value)) return out
  const names = Object.keys(value).map(typeName).filter(Boolean).slice(0, MAX_TYPES)
  for (const [name, beats] of Object.entries(value)) {
    const own = typeName(name)
    if (!names.includes(own)) continue
    out[own] = [...new Set((Array.isArray(beats) ? beats : []).map(typeName).filter(beaten => beaten !== own && names.includes(beaten)))]
  }
  return Object.keys(out).length > 1 ? out : {}
}

/** The types of skills by name, for those of a type the card has. */
function cleanSkillTypes(value, types) {
  const out = {}
  for (const [name, type] of Object.entries(isRecord(value) ? value : {}).slice(0, 60)) if (name.trim() && Object.hasOwn(types, typeName(type))) out[name.trim().slice(0, 40)] = typeName(type)
  return out
}

/** The player's own type: that of a form they have come to for good, or the one the card gives them. */
const playerType = (book, sheet) => (sheet && formAt(sheet, book) > 0 ? formOf(sheet, book)?.type : undefined) ?? book.selfType
/** 类型克制 as a fight is handed it (battle.js battleSetup), or null on a card with none. `sheet`: the player, for their own type. */
export const typesFor = (book, sheet = null) => (growsOn(book) || book?.level === 'full' ? (Object.keys(book?.types ?? {}).length ? { beats: book.types, skills: book.skillTypes ?? {}, ...(playerType(book, sheet) ? { player: playerType(book, sheet) } : {}) } : null) : null)

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
    out[name.trim().slice(0, 40)] = { keys: words(companion.keys, 6), attributes, skills, ...(Number.isInteger(companion.level) && companion.level > 0 ? { level: Math.min(99, companion.level) } : {}), ...(typeName(companion.type) ? { type: typeName(companion.type) } : {}) }
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

/**
 * The points one joining at a level brings: those a player who started the story would have had by then, two a
 * level above the one the story starts at. No more than their attributes have room for.
 */
export function joiningPoints(book, level, attributes) {
  const above = Math.max(0, level - levelOfRank(Array.isArray(book?.ranks) ? book.ranks : [], book?.start?.rank))
  const room = ATTRIBUTES.reduce((sum, { id }) => sum + MAX_ATTRIBUTE - attributes[id], 0)
  return Math.min(above * LEVEL_POINTS, room)
}

/** One who has just joined: as the card has them, or, one it does not know, average with one plain skill. */
export function memberOf(book, name, level = 1) {
  const known = companionOf(book, name)
  const joins = known?.level ?? level
  const attributes = known ? { ...known.attributes } : Object.fromEntries(ATTRIBUTES.map(({ id }) => [id, AVERAGE]))
  return {
    name: known?.name ?? String(name).trim().slice(0, 40),
    level: joins,
    experience: 0,
    points: joiningPoints(book, joins, attributes),
    attributes,
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

/** One of the party with the skills they fight with said: one with none has those everybody has. */
const skilled = (who, own) => ((who.skills ?? []).length ? who : { ...who, skills: own ? DEFAULT_SKILLS : [COMPANION_SKILL] })

/** One of the party in another form of their chain: its name kept, the skills of the form left gone and the new one's come. */
function inForm(who, book, to, own) {
  const first = formsOf(who, book)[0]
  const { form: _was, ...rest } = who
  const skills = skillsInForm(Object.keys(to.skills ?? {}).length || Object.keys(formOf(who, book)?.skills ?? {}).length ? skilled(who, own) : who, book, to)
  return { ...rest, ...(to === first ? {} : { form: to.name }), skills }
}

/** 临时进化: what one of the party becomes if they take their next form in a fight (battle.js battleSetup), or null. */
function shiftFor(who, book, kinds, own, to = formForFight(who, book)) {
  if (!to) return null
  const as = inForm(who, book, to, own)
  // A second form for a fight only, right after this one (变身 → 强化形态), is taken from it in the same fight.
  const chain = formsOf(who, book)
  const after = chain[chain.indexOf(to) + 1]
  const then = after && fightOnly(after) ? shiftFor(as, book, kinds, own, after) : null
  return { name: to.name, names: as.skills, bonus: fightBonus(bonusOf(as, book)), grown: skillGrowth(as, book, as.skills, kinds), ...(to.type ? { type: to.type } : {}), ...(to.drain ? { drain: true } : {}), ...(then ? { then } : {}) }
}

/** What stands with the player in a fight, in the shape battle.js takes. */
export function alliesFor(sheet, book) {
  return fieldedOf(sheet).map(member => {
    const kinds = companionKinds(book, member.name)
    // 类型克制: that of the form they have come to, their own (one tamed keeps what it was), or what the card says of them.
    const type = (formAt(member, book) > 0 ? formOf(member, book)?.type : undefined) ?? member.type ?? companionOf(book, member.name)?.type
    if (!growsOn(book)) return { ...member, kinds, ...(type ? { type } : {}) }
    const shift = shiftFor(member, book, { ...book.skills, ...kinds }, false)
    const form = formAt(member, book) > 0 ? formOf(member, book) : null
    return { ...member, kinds, ...(type ? { type } : {}), ...(form ? { shown: form.name } : {}), bonus: fightBonus(bonusOf(member, book)), grown: skillGrowth(member, book, member.skills ?? [], { ...book.skills, ...kinds }), ...(shift ? { shift } : {}) }
  })
}

/** What growth gives the player in a fight, in the shape battle.js takes; nothing on a card that does not count it. */
export function playerGrowth(sheet, book) {
  if (!growsOn(book)) return {}
  const names = sheet.skills.length ? sheet.skills : DEFAULT_SKILLS
  const kinds = Object.fromEntries(names.map(name => [name, book.skills?.[name] ?? skillKindOf(name)]))
  const shift = shiftFor(sheet, book, book.skills ?? {}, true)
  return { grows: true, bonus: fightBonus(bonusOf(sheet, book)), grown: skillGrowth(sheet, book, names, kinds), ...(shift ? { shift } : {}) }
}

/** The most life and energy of one who has not grown, kept the first time growth is counted: what a card's own numbers were. */
const baseOf = who => who.grew ?? { life: who.maxLife, energy: who.maxEnergy }

/** One of the party with the most life and energy set to `most`: what was added is theirs at once, what is taken is only a ceiling. */
function fitted(who, most, { life = true, energy = true } = {}) {
  const out = { ...who }
  if (life && most.life !== out.maxLife) {
    out.life = most.life > out.maxLife ? out.life + (most.life - out.maxLife) : Math.min(out.life, most.life)
    out.maxLife = most.life
  }
  if (energy && most.energy !== out.maxEnergy) {
    out.energy = most.energy > out.maxEnergy ? (out.energy ?? out.maxEnergy) + (most.energy - out.maxEnergy) : Math.min(out.energy ?? most.energy, most.energy)
    out.maxEnergy = most.energy
  }
  return out
}

/**
 * The sheet with what growth makes of it: the most life and energy of each of the party, from their level and 天赋,
 * and a 天赋 chosen for a companion who has one to choose (unless the card leaves that to the player). The same sheet
 * always comes to the same thing. A card that stopped counting growth gets its numbers back.
 * @param bound - the fields the card keeps itself: those are the card's to say.
 */
export function grownSheet(sheet, book, bound = sheet.bound ?? []) {
  const free = { life: !bound.includes('life') && !bound.includes('maxLife'), energy: !bound.includes('energy') && !bound.includes('maxEnergy') }
  if (!growsOn(book)) {
    if (!sheet.grew && !(sheet.party ?? []).some(member => member.grew)) return sheet
    const back = who => {
      if (!who.grew) return who
      const { grew, ...rest } = who
      return fitted(rest, grew, who === sheet ? free : undefined)
    }
    const plain = back(sheet)
    return { ...plain, ...(sheet.party ? { party: sheet.party.map(back) } : {}) }
  }
  sheet = fitGear(sheet, book)
  const one = (who, own) => {
    let grown = { ...who, grew: baseOf(who) }
    if (!own && book.growth?.companions !== 'manual') {
      for (let key = perkFor(grown, book); perksOwed(grown, book) > 0 && key; key = perkFor(grown, book)) grown = { ...grown, perks: [...(grown.perks ?? []), key] }
      // 大天赋: a companion who has crossed a rank has one too, chosen the same way.
      for (let key = perkFor(grown, book, true); bigsOwed(grown, book) > 0 && key; key = perkFor(grown, book, true)) grown = { ...grown, perks: [...(grown.perks ?? []), key] }
    }
    // What a 天赋 they have teaches, and the skills of the form they are in, are theirs.
    const taught = [...(perksOn(book) ? (grown.perks ?? []).map(key => perkOf(book, key)?.skill).filter(Boolean) : []), ...Object.keys(formOf(grown, book)?.skills ?? {})]
    const missing = taught.filter((name, i) => !skilled(grown, own).skills.includes(name) && taught.indexOf(name) === i)
    if (missing.length) grown = { ...grown, skills: [...skilled(grown, own).skills, ...missing] }
    return fitted(grown, grownMost(grown, book, grown.grew), own ? free : undefined)
  }
  const player = one(sheet, true)
  return { ...player, ...(sheet.party ? { party: sheet.party.map(member => one(member, false)) } : {}) }
}

/** What kind a skill by a name is on this card: the player's, one of the companions', or what its name suggests. */
export function skillKindIn(book, name) {
  const theirs = Object.values(book?.companions ?? {}).map(companion => companion?.skills?.[name]).find(kind => SKILLS[kind])
  return SKILLS[book?.skills?.[name]] ? book.skills[name] : theirs ?? skillKindOf(name)
}

/** 技能的附加 as kept: { name: [{ id, size }] }, for whoever on the card has a skill by that name (battle.js cleanAdds). */
function cleanSkillAdds(value, book) {
  const out = {}
  if (!isRecord(value)) return out
  for (const [name, adds] of Object.entries(value).slice(0, MAX_THINGS)) {
    const kept = cleanAdds(adds, skillKindIn(book, name))
    if (name.trim() && kept.length) out[name.trim().slice(0, 40)] = kept
  }
  return out
}

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
    // 装备: a thing that is worn (growth.js).
    if (cleanGear(effect, name)) {
      out[name.slice(0, 40)] = cleanGear(effect, name)
      continue
    }
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
  return grownSheet({ ...sheet, strain: strainOf(sheet), bound: Object.keys(bindings), broken, named: attributeNames(book) }, book)
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
  const result = judge(rollD20(seedOf(...spot, check.stat, String(check.dc))), modifierFor(sheet, check.stat) + (aid ? AID_BONUS : 0) + checkBonus(sheet, book, attributeOf(check.stat, sheet.named)), dc)
  return { stat: check.stat, ...result, ...(lacks ? { tier: 'fail', lacks } : {}), ...(ails.length ? { ails } : {}), ...(aid ? { aid: { name: aid, by: AID_BONUS } } : {}) }
}

/** The chance a choice is shown with, in percent. */
export function chanceFor(sheet, book, check) {
  const { aid, lacks } = aidFor(sheet, check)
  return lacks ? 0 : chanceOf(modifierFor(sheet, check.stat) + (aid ? AID_BONUS : 0) + checkBonus(sheet, book, attributeOf(check.stat, sheet.named)), dcFor(check.dc, book.difficulty))
}

/** A roll in a line: what a settling turn says it was, for the model and for what comes after a compaction. */
export function checkLine(result) {
  return `掷骰：${result.stat ? `${result.stat} ` : ''}${result.total}，需要 ${result.dc}，${result.lacks ? `缺${result.lacks}，` : ''}${TIER_WORDS[result.tier]}`
}

/**
 * 历练: what a roll that came off leaves on the attribute it was made on, on a card that counts growth:
 * { practice: id, by } to go with the roll's experience, or null. A roll against less than `PRACTICE_DC` teaches nothing.
 */
export function checkPractice(sheet, book, check, result) {
  if (!growsOn(book) || result.lacks || result.dc < PRACTICE_DC) return null
  const by = result.tier === 'crit' ? 2 : result.tier === 'success' ? 1 : 0
  const id = attributeOf(check.stat, sheet.named)
  return by && ATTRIBUTES.some(item => item.id === id) && sheet.attributes[id] < MAX_ATTRIBUTE ? { practice: id, by } : null
}

/** 历练 added to an attribute, and the points of it that come of enough. */
function drilled(sheet, id, by) {
  let value = sheet.attributes[id]
  let held = (sheet.practice?.[id] ?? 0) + by
  while (value < MAX_ATTRIBUTE && held >= practiceNeeds(value)) {
    held -= practiceNeeds(value)
    value += 1
  }
  return { ...sheet, attributes: { ...sheet.attributes, [id]: value }, practice: { ...(sheet.practice ?? {}), [id]: value < MAX_ATTRIBUTE ? held : 0 } }
}

/** What the model is told of a level come by, on a card that counts growth: a rank crossed is a 突破. */
function grewLine(before, after, book) {
  if (!growsOn(book) || (after.level ?? 1) <= (before.level ?? 1)) return ''
  const ranks = Array.isArray(book.ranks) ? book.ranks : []
  const rank = ranks.length ? rankAt(ranks, after.level) : ''
  return rank && rank !== rankAt(ranks, before.level ?? 1) ? `玩家突破到了${rank}，伤势和疲惫一扫而空，叙述里要写出这一刻` : `玩家升到了 ${after.level} 级`
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
    else if (op.op === 'equip' && name) out.push({ op: 'equip', name, ...(typeof op.who === 'string' && op.who.trim() ? { who: op.who.trim().slice(0, 40) } : {}) })
    else if (op.op === 'unequip' && GEAR_SLOTS.includes(op.slot)) out.push({ op: 'unequip', slot: op.slot, ...(typeof op.who === 'string' && op.who.trim() ? { who: op.who.trim().slice(0, 40) } : {}) })
    else if (op.op === 'form') out.push({ op: 'form', ...(typeof op.who === 'string' && op.who.trim() ? { who: op.who.trim().slice(0, 40) } : {}) })
    else if (op.op === 'perk' && (op.skip === true || (typeof op.key === 'string' && op.key.trim()))) out.push({ op: 'perk', ...(op.skip === true ? { skip: true, ...(op.big === true ? { big: true } : {}) } : { key: op.key.trim().slice(0, 41) }), ...(typeof op.who === 'string' && op.who.trim() ? { who: op.who.trim().slice(0, 40) } : {}) })
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
function grow(sheet, experience, book) {
  let { level = 1 } = sheet
  let total = (sheet.experience ?? 0) + experience
  if (!sheet.bound?.includes('level') && !sheet.bound?.includes('rank')) {
    while (total >= levelNeeds(level, book)) {
      total -= levelNeeds(level, book)
      level += 1
    }
  }
  const gained = levelsGive(sheet.level ?? 1, level, book)
  return restored({ ...sheet, level, points: (sheet.points ?? 0) + gained.points, experience: total }, sheet.level ?? 1, book, gained.whole)
}

/**
 * 里程碑 → 奖励: the attribute points the levels from `was` to `level` bring on this card (a card may leave them to
 * 历练 alone, or give more), with those of every few levels, and whether one of those makes whole again.
 */
function levelsGive(was, level, book) {
  const every = perkEveryOf(book)
  const steps = growsOn(book) ? Math.floor(level / every) - Math.floor(was / every) : 0
  const gives = everyGives(book)
  return { points: (level - was) * levelPointsOf(book) + steps * gives.points, whole: steps > 0 && gives.restore }
}

/** Whole again, where the rules keep those numbers. */
const madeWhole = sheet => ({ ...sheet, ...(sheet.bound?.includes('life') ? {} : { life: sheet.maxLife }), ...(sheet.bound?.includes('energy') || sheet.maxEnergy === undefined ? {} : { energy: sheet.maxEnergy }) })

/** 突破: one who has crossed into a new rank, on a card that counts growth, is whole again, where the rules keep those numbers. */
function restored(sheet, was, book, whole = false) {
  const ranks = Array.isArray(book?.ranks) ? book.ranks : []
  if (!growsOn(book) || !ranks.length || sheet.level <= was || rankAt(ranks, sheet.level) === rankAt(ranks, was)) return whole && growsOn(book) ? madeWhole(sheet) : sheet
  // 大天赋: one to choose for each rank crossed, on a card that has 天赋.
  const step = level => Math.min(ranks.length - 1, Math.max(0, Math.floor((level - 1) / STEPS_PER_RANK)))
  const crossed = step(sheet.level) - step(was)
  const gives = rankGives(book)
  const bigs = gives.big ? { bigs: (sheet.bigs ?? 0) + crossed } : {}
  // 里程碑: a card may have a 突破 bring attribute points, and every skill a stage further.
  const points = gives.points && crossed > 0 ? { points: (sheet.points ?? 0) + gives.points * crossed } : {}
  const mastery = { ...(sheet.mastery ?? {}) }
  if (gives.skills) for (let i = 0; i < crossed; i++) for (const name of (sheet.skills ?? []).length ? sheet.skills : DEFAULT_SKILLS) mastery[name] = nextStageAt(mastery[name]) ?? mastery[name]
  const out = { ...sheet, ...bigs, ...points, ...(gives.skills && crossed > 0 ? { mastery } : {}) }
  return whole || rankRestores(book) ? madeWhole(out) : out
}

/** A blow to the mind: at nothing it breaks, and comes back with a madness that wears off like anything else. */
function shaken(sheet, lost) {
  const sanity = sheet.sanity - lost
  if (sanity > 0) return { ...sheet, sanity }
  return { ...sheet, sanity: Math.round(sheet.maxSanity * AFTER_MADNESS), conditions: ailed(sheet.conditions ?? [], MADNESS) }
}

/** A steady mind takes a little less of it, never nothing. */
const shock = (sheet, size) => Math.max(1, SHOCKS[size] - Math.max(0, modifierOf(sheet.attributes.mind)))

/** How often each skill has been used, with a fight's own count added: what 熟练 is read from. */
function practised(who, uses) {
  if (!uses || !Object.keys(uses).length) return who
  const mastery = { ...(who.mastery ?? {}) }
  for (const [name, count] of Object.entries(uses)) if (Number.isInteger(count) && count > 0) mastery[name.slice(0, 40)] = Math.min(MAX_USES, (mastery[name] ?? 0) + count)
  return { ...who, mastery }
}

// How many foes a story keeps the strength of: the oldest are let go.
const MAX_MET = 80

/** The foes a story has met, with those of one more fight: { name: { at, gap, level } }, how each stood when first met. */
function remembered(held = {}, met) {
  const out = { ...held }
  for (const [name, one] of Object.entries(met)) {
    if (!Number.isFinite(one?.at) || !Number.isInteger(one?.gap) || !Number.isInteger(one?.level)) continue
    delete out[name]
    // `worn`: what the party had on when they met, which the foe followed part of and goes on following.
    const worn = Number.isFinite(one.worn?.deal) && Number.isFinite(one.worn?.take) ? { worn: { deal: Math.max(0, Math.min(2, one.worn.deal)), take: Math.max(0, Math.min(2, one.worn.take)) } } : {}
    out[name.slice(0, 40)] = { at: one.at, gap: one.gap, level: one.level, ...worn }
  }
  return Object.fromEntries(Object.entries(out).slice(-MAX_MET))
}

/** 收服: a foe brought down joins the party as what it was: its moves for skills, its type its own. Nothing when there is no room, or one by its name is there already. */
function tamed(sheet, book, name) {
  const joined = partyChanged(sheet, book, 'join', name)
  if (!joined || companionOf(book, name)) return joined ?? sheet
  const known = book.foes?.[name]
  const moves = (known?.moves ?? []).slice(0, 3)
  return { ...joined, party: joined.party.map(member => (member.name === name ? { ...member, tamed: true, ...(moves.length ? { skills: moves } : {}), ...(known?.type ? { type: known.type } : {}) } : member)) }
}

/** A fight's outcome on the sheet: nothing changed until now, whatever it took. */
function afterFight(sheet, op, book = {}) {
  const things = Object.entries(op.used).reduce((left, [name, count]) => lose(left, { name, count }), sheet.things)
  // 成长: what was won is worth more to one who learns faster, and one who mends faster is the better for it at once.
  const grows = growsOn(book)
  const earned = (who, experience) => (grows ? Math.round(experience * (1 + bonusOf(who, book).gain)) : experience)
  const mended = (who, left) => (grows && op.over === 'won' ? Math.min(who.maxLife, left + Math.round(who.maxLife * bonusOf(who, book).mend)) : left)
  // 指挥: one who led from behind was not struck: a fight lost is their companions' to bear.
  const beaten = op.over === 'lost' && !op.commanded
  const life = beaten ? Math.max(1, Math.round(sheet.maxLife * AFTER_DEFEAT)) : op.commanded ? sheet.life : mended(sheet, op.life)
  const energy = sheet.bound?.includes('energy') ? op.energy : sheet.energy
  const left = (sheet.conditions ?? []).filter(item => !op.cured?.includes(item.name))
  const conditions = [...(beaten ? [DEFEATED] : []), ...(op.rallied ? [RALLIED] : [])].reduce(ailed, left)
  const party = (sheet.party ?? []).map(member => {
    const fought = op.party?.find(item => item.name === member.name)
    if (!fought) return member
    const life = op.over === 'lost' ? Math.max(1, Math.round(member.maxLife * AFTER_DEFEAT)) : mended(member, Math.max(1, Math.min(member.maxLife, fought.life)))
    // Those who fell get half of what the fight was worth. 羁绊: a fight won beside the player is one more between them,
    // and a step of it may bring attribute points on a card that says so.
    const bond = grows && op.over === 'won' ? Math.min(MAX_USES, (member.bond ?? 0) + 1) : null
    const stepped = bond !== null && bondOf({ bond }) > bondOf(member) ? bondPointsOf(book) : 0
    return grow(practised({ ...member, life, ...(bond !== null ? { bond } : {}), ...(stepped ? { points: (member.points ?? 0) + stepped } : {}) }, grows ? fought.uses : null), earned(member, op.over === 'lost' ? 0 : fought.fell ? Math.floor(op.experience / 2) : op.experience), book)
  })
  const settled = practised({ ...sheet, things, life, energy, conditions, ...(sheet.party ? { party } : {}), ...(grows && op.met ? { met: remembered(sheet.met, op.met) } : {}) }, grows ? op.uses : null)
  const after = op.tamed ? tamed(settled, book, op.tamed) : settled
  return grow(op.shock && sheet.sanity !== undefined ? shaken(after, op.shock) : after, earned(sheet, op.experience), book)
}

/** A 天赋 taken, or passed over for points, by the player or one of the party. → { sheet, line } or null. */
function perkTaken(sheet, book, op) {
  const at = op.who ? (sheet.party ?? []).findIndex(member => member.name === op.who) : -1
  const who = op.who ? sheet.party?.[at] : sheet
  if (!who || (op.skip ? !(op.big ? bigsOwed(who, book) : perksOwed(who, book)) : !canTake(who, book, op.key))) return null
  const skipped = op.big ? { bigSkips: (who.bigSkips ?? 0) + 1 } : { perkSkips: (who.perkSkips ?? 0) + 1 }
  const changed = op.skip ? { ...who, ...skipped, points: (who.points ?? 0) + SKIP_POINTS } : { ...who, perks: [...(who.perks ?? []), op.key] }
  const after = op.who ? { ...sheet, party: sheet.party.map((member, i) => (i === at ? changed : member)) } : changed
  return { sheet: after, line: op.skip ? '' : `${op.who ?? '玩家'}有了新的${wordFor(book, 'perk')}「${perkOf(book, op.key).name}」` }
}

/** 进化: the player or one of the party comes to the next form of their chain, with all it asks for met. → { sheet, line } or null. */
function evolved(sheet, book, op) {
  const at = op.who ? (sheet.party ?? []).findIndex(member => member.name === op.who) : -1
  const who = op.who ? sheet.party?.[at] : sheet
  const to = who ? formReady(who, book, sheet.things) : null
  if (!to) return null
  const changed = inForm(who, book, to, !op.who)
  const after = op.who ? { ...sheet, party: sheet.party.map((member, i) => (i === at ? changed : member)) } : changed
  return { sheet: after, line: `${op.who ?? '玩家'}${wordFor(book, 'evolve')}成了「${to.name}」${to.stage ? `（${to.stage}）` : ''}，接下来的叙述里按新的${wordFor(book, 'form')}写` }
}

/** 【进化】: the story puts one of the party into a form of their chain, whatever it asks for; the first is the way back. */
function formed(sheet, book, mark) {
  const party = sheet.party ?? []
  const named = mark.who ? companionOf(book, mark.who)?.name ?? mark.who : null
  // Said of nobody, it is whoever has a form by that name: the player first.
  const has = who => formsOf(who, book).some(form => form.name === mark.name)
  const at = named ? party.findIndex(member => member.name === named) : has(sheet) ? -1 : party.findIndex(has)
  const who = at >= 0 ? party[at] : named && !['玩家', '你', '{{user}}'].includes(named) ? null : sheet
  const to = who ? formsOf(who, book).find(form => form.name === mark.name) : null
  if (!to || formOf(who, book) === to) return sheet
  const changed = inForm(who, book, to, at < 0)
  return at >= 0 ? { ...sheet, party: party.map((member, i) => (i === at ? changed : member)) } : changed
}

/** How many of a thing are worn by the party, but for one of them. */
const wornBy = (sheet, name, but) => [sheet, ...(sheet.party ?? [])].filter(one => one !== but).reduce((sum, one) => sum + Object.values(one.gear ?? {}).filter(worn => worn === name).length, 0)

/** 装备 put on or taken off, by the player or one of the party. → { sheet, line } or null. */
function geared(sheet, book, op) {
  if (!growsOn(book)) return null
  const at = op.who ? (sheet.party ?? []).findIndex(member => member.name === op.who) : -1
  const who = op.who ? sheet.party?.[at] : sheet
  if (!who) return null
  const gear = { ...(who.gear ?? {}) }
  if (op.op === 'unequip') {
    if (!gear[op.slot]) return null
    delete gear[op.slot]
  } else {
    const item = gearOf(book, op.name)
    // There has to be one to spare: what another of the party has on is theirs.
    if (!item || gear[item.slot] === op.name || held(sheet, op.name) <= wornBy(sheet, op.name, who)) return null
    gear[item.slot] = op.name
  }
  const { gear: _was, ...bare } = who
  const changed = Object.keys(gear).length ? { ...bare, gear } : bare
  const after = op.who ? { ...sheet, party: sheet.party.map((member, i) => (i === at ? changed : member)) } : changed
  return { sheet: after, line: op.op === 'equip' ? `${op.who ?? '玩家'}装备了「${op.name}」` : '' }
}

/** Gear nobody has any more comes off: a thing lost, given away, or no longer gear on this card. The player's first, then the others'. */
function fitGear(sheet, book) {
  const left = new Map(sheet.things.map(thing => [thing.name, thing.count]))
  const fit = who => {
    if (!who.gear) return who
    const gear = {}
    for (const [slot, name] of Object.entries(who.gear)) {
      if (gearOf(book, name)?.slot !== slot || !(left.get(name) > 0)) continue
      left.set(name, left.get(name) - 1)
      gear[slot] = name
    }
    if (Object.keys(gear).length === Object.keys(who.gear).length) return who
    const { gear: _was, ...bare } = who
    return Object.keys(gear).length ? { ...bare, gear } : bare
  }
  const player = fit(sheet)
  const party = sheet.party?.map(fit)
  return player === sheet && (!party || party.every((member, i) => member === sheet.party[i])) ? sheet : { ...player, ...(party ? { party } : {}) }
}

/** One operation on the sheet: { sheet, line } (what the model is told), or null when it cannot be done now. */
function applyOp(sheet, book, op) {
  if (op.op === 'battle') {
    const after = afterFight(sheet, op, book)
    return { sheet: after, line: grewLine(sheet, after, book) }
  }
  if (op.op === 'grow') {
    const grown = grow(sheet, growsOn(book) ? Math.round(op.experience * (1 + bonusOf(sheet, book).gain)) : op.experience, book)
    const learns = growsOn(book) && ATTRIBUTES.some(item => item.id === op.practice) && grown.attributes[op.practice] < MAX_ATTRIBUTE
    return { sheet: learns ? drilled(grown, op.practice, op.by === 2 ? 2 : 1) : grown, line: grewLine(sheet, grown, book) }
  }
  if (op.op === 'perk') return perkTaken(sheet, book, op)
  if (op.op === 'form') return evolved(sheet, book, op)
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
  if (op.op === 'equip' || op.op === 'unequip') return geared(sheet, book, op)
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
  // A level or a 天赋 gained just now is felt at once.
  if (done.ops.length) done.sheet = grownSheet(done.sheet, book)
  return done
}

/**
 * What the operations change in the card's own variables. A number as what it comes to, so whatever the
 * model does to it this turn it ends up there; a bag in its own shape.
 */
export function opWrites(book, state, before, after, ops) {
  const bindings = book.bindings ?? {}
  const writes = []
  // A fight settles them even where they end as they began (hurt, then healed back with a pill): the model's own
  // change to them in that turn would stand otherwise.
  const fought = ops.some(op => op.op === 'battle')
  for (const field of ['life', 'energy', 'sanity']) {
    if (bindings[field] && (fought || before[field] !== after[field])) writes.push(numberWrite(state, bindings[field], after[field]))
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
function promoted(sheet, power, book) {
  const level = power === null ? sheet.level : Math.min(power + 1, sheet.level + STEPS_PER_RANK)
  return level > sheet.level ? restored({ ...sheet, level, experience: 0, points: (sheet.points ?? 0) + levelPointsOf(book) }, sheet.level, book) : sheet
}

function applyMark(sheet, mark, ranks, book) {
  if (mark.kind === 'party') return partyChanged(sheet, book, mark.act, mark.name) ?? sheet
  if (mark.kind === 'form') return formed(sheet, book, mark)
  if (mark.kind === 'learn' && mark.who) {
    const at = (sheet.party ?? []).findIndex(member => member.name === (companionOf(book, mark.who)?.name ?? mark.who))
    if (at < 0 || sheet.party[at].skills.includes(mark.name)) return sheet
    return { ...sheet, party: sheet.party.map((member, i) => (i === at ? { ...member, skills: [...member.skills, mark.name] } : member)) }
  }
  if (mark.kind === 'gain') return { ...sheet, things: gain(sheet.things, mark) }
  if (mark.kind === 'lose') return { ...sheet, things: lose(sheet.things, mark) }
  if (mark.kind === 'quest') return { ...sheet, quests: quest(sheet.quests, mark) }
  if (mark.kind === 'learn') return sheet.skills.includes(mark.name) ? sheet : { ...sheet, skills: [...sheet.skills, mark.name] }
  if (mark.kind === 'promote') return promoted(sheet, rankPower(ranks, mark.name), book)
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
  // A rank the story gave is felt at once, as a level won is.
  const settled = grownSheet(taken.reduce((held, mark) => applyMark(held, mark, ranks, book), { ...sheet, conditions: wornOff(sheet.conditions, newDay) }), book, bound)
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
