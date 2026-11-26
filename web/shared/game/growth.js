// 成长: what makes one of the party stronger, all of it as entries of one table of effects (plans/16). A level, a 天赋,
// later a thing worn or a form taken: each is a source that gives some of these effects, and a fight is handed their sum.
// The rules know the effects and nothing of what a story calls them: a card (or the model that writes one) gives a
// source its name and picks its effects from the table, and how much each is worth is set here.
// Nothing worked out here is kept: the sheet keeps what was chosen and how often a skill was used, the rest is read
// from those each time. Runs on old WebViews too.
import { ADD_BUDGET, FOE_ADDS, FOE_ADD_ROOM, MAX_ADDS, SHIFT_COST, SHIFT_UPKEEP, SKILLS, SKILL_ADDS } from './battle.js'
import { modifierOf, randomFrom, seedOf } from './dice.js'

/** How far a card takes it: not at all (as the rules were), what a level brings by itself, or 天赋 too. */
export const GROWTH_LEVELS = ['off', 'standard', 'rich']
export const growthOf = book => (book?.level === 'full' && GROWTH_LEVELS.includes(book?.growth?.level) ? book.growth.level : 'off')
export const growsOn = book => growthOf(book) !== 'off'
export const perksOn = book => growthOf(book) === 'rich'

export const SIZES = ['small', 'medium', 'large']
const ATTRIBUTE_IDS = ['body', 'grace', 'mind', 'charm']
/** How far an attribute of one who is raised (raise.js) may come, past a person's 20, and the least it may be. */
export const RAISED_MOST = 40
export const RAISED_LEAST = 6
/** 种族值 as a card gives them, all four, or null for none. */
export function cleanSpecies(value) {
  if (!isRecord(value)) return null
  const out = {}
  for (const id of ATTRIBUTE_IDS) {
    if (typeof value[id] !== 'number' || !Number.isFinite(value[id])) return null
    out[id] = Math.max(RAISED_LEAST, Math.min(RAISED_MOST, Math.round(value[id])))
  }
  return out
}
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The effects. `sizes`: what small, medium and large come to; one with none is had or not (`cost` says what it is worth).
 * `most`: as much as all the sources together may give. `on`: what it must name ('attribute'), or may ('skill': a kind
 * of skill or one by name; none is every skill, and costs one more). `leans`: the attribute of those it suits, for
 * choosing on behalf of a companion.
 */
export const EFFECTS = {
  attack: { sizes: [0.04, 0.07, 0.1], most: 0.4, leans: 'body' },
  guard: { sizes: [0.03, 0.05, 0.08], most: 0.3, leans: 'body' },
  life: { sizes: [0.05, 0.1, 0.16], most: 1, leans: 'body' },
  energy: { sizes: [3, 6, 10], most: 30, leans: 'mind' },
  speed: { sizes: [1, 2, 3], most: 5, leans: 'grace' },
  crit: { sizes: [0.04, 0.08, 0.12], most: 0.4, leans: 'grace' },
  check: { sizes: [1, 2, 3], most: 3, on: 'attribute' },
  flee: { sizes: [2, 4, 6], most: 8, leans: 'grace' },
  first: { cost: 2, leans: 'grace' },
  stand: { cost: 2, leans: 'body' },
  fury: { sizes: [0.15, 0.25, 0.4], most: 0.6, leans: 'body' },
  regen: { sizes: [0.03, 0.05, 0.08], most: 0.1, leans: 'mind' },
  thrift: { sizes: [0.1, 0.2, 0.3], most: 0.4, leans: 'mind' },
  cover: { sizes: [0.2, 0.35, 0.5], most: 0.6, leans: 'charm' },
  mend: { sizes: [0.1, 0.2, 0.3], most: 0.4, leans: 'charm' },
  gain: { sizes: [0.1, 0.2, 0.3], most: 0.5, leans: 'mind' },
  hone: { sizes: [0.1, 0.2, 0.3], most: 0.5, on: 'skill', leans: 'mind' },
}
export const EFFECT_IDS = Object.keys(EFFECTS)
/** What a 天赋 may come to, in points: small 1, medium 2, large 3; a drawback gives half of its own back. */
export const PERK_BUDGET = 3
/** 大天赋: one for each rank crossed (突破), worth a point more. */
export const BIG_BUDGET = 4
const MAX_EFFECTS = 3
export const MAX_PERKS = 12
/** What a skill a 天赋 teaches is worth, of the points the 天赋 has. */
export const PERK_SKILL_COST = 2
// What a level brings by itself.
const LIFE_PER_LEVEL = 0.02
const LEVELS_PER_ENERGY = 2
/** A 天赋 every so many levels, where the card has not said. */
export const PERK_EVERY = 3
export const PERK_EVERY_RANGE = [2, 5]
/** The most attribute points a 突破 may bring over a level's own. */
export const RANK_POINTS_MOST = 4
/** How many levels lie between two 天赋 on this card. */
export const perkEveryOf = book => book?.growth?.perkEvery ?? PERK_EVERY
/**
 * 里程碑: what crossing into a new rank brings on this card besides being whole again: { big (a 大天赋 to choose),
 * points (attribute points), skills (every skill a stage further) }.
 */
export const rankGives = book => ({ big: perksOn(book) && book?.growth?.rankBig !== false, points: growsOn(book) ? book?.growth?.rankPoints ?? 0 : 0, skills: growsOn(book) && book?.growth?.rankSkills === true })
// 里程碑 → 奖励: what the other steps of growing bring, where a card says other than the usual.
const USUAL_POINTS = 2
export const LEVEL_POINTS_MOST = 4
export const BOND_POINTS_MOST = 2
/** The attribute points a level brings on this card. `points: false` is none, from before a card could say how many. */
export const levelPointsOf = book => (!growsOn(book) ? USUAL_POINTS : book.growth?.points === false ? 0 : book.growth?.levelPoints ?? USUAL_POINTS)
/** What every `perkEveryOf` levels bring besides a 天赋 to choose: { points, restore (whole again) }. */
export const everyGives = book => ({ points: growsOn(book) ? book?.growth?.everyPoints ?? 0 : 0, restore: growsOn(book) && book?.growth?.everyRestore === true })
/** Whether crossing into a new rank makes one whole again: the usual, unless the card says not. */
export const rankRestores = book => book?.growth?.rankRestore !== false
/** The attribute points a companion gets for each step of 羁绊. */
export const bondPointsOf = book => (growsOn(book) ? book?.growth?.bondPoints ?? 0 : 0)
/** The points one who would rather not choose takes instead. */
export const SKIP_POINTS = 2
// 熟练: a skill used this often has come this far; each stage hits harder, the later ones cost less.
const MASTERY_USES = [5, 15, 30, 50]
const STAGE_POWER = 0.03
const STAGE_THRIFT = 0.1
const THRIFT_FROM = 3
export const MAX_STAGE = MASTERY_USES.length + 1
/** The uses each stage after the first takes, and what a level brings by itself: for a page that lays them out. */
export const STAGE_USES = MASTERY_USES.slice()
export const LEVEL_GAINS = { life: LIFE_PER_LEVEL, energyEvery: LEVELS_PER_ENERGY }
const BELOW = 0.3

/** What an effect is worth, in points. */
function costOf(effect) {
  const rule = EFFECTS[effect.id]
  const base = rule.sizes ? SIZES.indexOf(effect.size) + 1 : rule.cost
  const own = base + (effect.id === 'hone' && !effect.on ? 1 : 0)
  return effect.minus ? -own / 2 : own
}

/** One effect as kept, or null for one the rules do not know. A size not said is medium. */
function cleanEffect(value) {
  if (!isRecord(value) || !Object.hasOwn(EFFECTS, value.id)) return null
  const rule = EFFECTS[value.id]
  const effect = { id: value.id }
  if (rule.sizes) effect.size = SIZES.includes(value.size) ? value.size : 'medium'
  if (rule.on === 'attribute') {
    if (!ATTRIBUTE_IDS.includes(value.on)) return null
    effect.on = value.on
  }
  if (rule.on === 'skill' && typeof value.on === 'string' && value.on.trim()) effect.on = value.on.trim().slice(0, 40)
  // Only what has a size can be a drawback: there is no less of standing back up.
  if (value.minus === true && rule.sizes) effect.minus = true
  return effect
}

/** Effects as kept: those known, no two of a kind, the last dropped while they come to more than the budget. */
export function cleanEffects(value, budget = PERK_BUDGET) {
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    const effect = cleanEffect(item)
    if (!effect || out.some(other => other.id === effect.id && other.on === effect.on)) continue
    out.push(effect)
    if (out.length === MAX_EFFECTS) break
  }
  const spent = () => out.reduce((sum, effect) => sum + costOf(effect), 0)
  while (out.length && spent() > budget) {
    // A big one too many becomes a smaller one before it goes.
    const last = out.findLast(effect => !effect.minus)
    if (!last) break
    const at = SIZES.indexOf(last.size)
    if (at > 0) last.size = SIZES[at - 1]
    else out.splice(out.indexOf(last), 1)
  }
  // What is left must give something: drawbacks alone are no 天赋.
  return out.some(effect => !effect.minus) ? out : []
}

// 天赋 a name alone says something of, for one whose effects could not be read.
const PERK_WORDS = [[/[快疾迅影闪]|身法|轻功/, { id: 'speed', size: 'small' }], [/[盾甲铁护守]|硬/, { id: 'guard', size: 'small' }], [/[血命体]/, { id: 'life', size: 'small' }], [/[气灵魔蓝能]/, { id: 'energy', size: 'small' }]]
const byName = name => PERK_WORDS.find(([word]) => word.test(name))?.[1] ?? null

/** The card's own 天赋 as kept: [{ name, note, effects, branch?, needs? }]. */
export function cleanPerks(value) {
  const out = []
  const text = (item, max) => (typeof item === 'string' ? item.trim().slice(0, max) : '')
  for (const item of Array.isArray(value) ? value : []) {
    const name = text(item?.name, 24)
    if (!name || name.startsWith('#') || out.some(other => other.name === name)) continue
    // One whose effects cannot be read is given a small one its name suggests; a name that says nothing is no 天赋.
    const big = item.big === true
    // 技能: a 天赋 may teach a skill, which takes some of its points: { name, kind } as a model writes it, or the name alone.
    const skill = text(isRecord(item.skill) ? item.skill.name : item.skill, 40)
    const kind = isRecord(item.skill) ? item.skill.kind : item.skillKind
    const read = cleanEffects(item.effects, (big ? BIG_BUDGET : PERK_BUDGET) - (skill ? PERK_SKILL_COST : 0))
    const effects = read.length ? read : skill ? [] : [byName(name)].filter(Boolean)
    if (!effects.length && !skill) continue
    out.push({
      name,
      note: text(item.note, 80),
      effects,
      ...(skill ? { skill, ...(Object.hasOwn(SKILLS, kind) ? { skillKind: kind } : {}) } : {}),
      ...(big ? { big: true } : {}),
      ...(text(item.branch, 12) ? { branch: text(item.branch, 12) } : {}),
      ...(text(item.needs, 24) ? { needs: text(item.needs, 24) } : {}),
    })
    if (out.length === MAX_PERKS) break
  }
  // One that asks for another the card does not have asks for nothing.
  return out.map(({ needs, ...perk }) => (needs && needs !== perk.name && out.some(other => other.name === needs) ? { ...perk, needs } : perk))
}

/** What a rule book says of growth, as kept. */
export function cleanGrowth(value) {
  if (!isRecord(value) || !GROWTH_LEVELS.includes(value.level) || value.level === 'off') return null
  // `points: false`: a level brings no attribute points, they come of 历练 alone. `power: true`: the page shows 战力.
  // 里程碑: how often a 天赋 comes, and what a 突破 brings; each kept only where it is not the usual.
  const every = Number.isInteger(value.perkEvery) && value.perkEvery >= PERK_EVERY_RANGE[0] && value.perkEvery <= PERK_EVERY_RANGE[1] && value.perkEvery !== PERK_EVERY ? { perkEvery: value.perkEvery } : {}
  const points = Number.isInteger(value.rankPoints) && value.rankPoints > 0 ? { rankPoints: Math.min(RANK_POINTS_MOST, value.rankPoints) } : {}
  // 里程碑 → 奖励: the points of a level (none is `points: false`, as it was kept before), of every few levels, of a step of 羁绊.
  const whole = (key, most) => (Number.isInteger(value[key]) && value[key] > 0 ? { [key]: Math.min(most, value[key]) } : {})
  const none = value.points === false || value.levelPoints === 0
  const each = !none && Number.isInteger(value.levelPoints) && value.levelPoints > 0 && value.levelPoints !== USUAL_POINTS ? { levelPoints: Math.min(LEVEL_POINTS_MOST, value.levelPoints) } : {}
  const more = { ...each, ...whole('everyPoints', LEVEL_POINTS_MOST), ...(value.everyRestore === true ? { everyRestore: true } : {}), ...(value.rankRestore === false ? { rankRestore: false } : {}), ...whole('bondPoints', BOND_POINTS_MOST) }
  return { level: value.level, ...(value.companions === 'manual' ? { companions: 'manual' } : {}), ...(none ? { points: false } : {}), ...(value.power === true ? { power: true } : {}), ...(value.raise === true ? { raise: true } : {}), ...(typeof value.slabName === 'string' && value.slabName.trim() ? { slabName: value.slabName.trim().slice(0, 8) } : {}), ...every, ...(value.rankBig === false ? { rankBig: false } : {}), ...points, ...(value.rankSkills === true ? { rankSkills: true } : {}), ...more }
}

/** The skills a card's 天赋 and 形态 teach, with the kind of each that says one: { name: kind }. */
export function taughtSkills(book) {
  const out = {}
  for (const perk of book?.perks ?? []) if (perk.skill && perk.skillKind) out[perk.skill] = perk.skillKind
  for (const chain of Object.values(book?.forms ?? {})) for (const form of chain) for (const [name, kind] of Object.entries(form.skills ?? {})) if (kind) out[name] = kind
  return out
}

// 形态: one of the party may have a chain of them (幼年期 → 成熟期, 凡人 → 变身), each with effects from the same table,
// skills of its own, and what it takes to come to it. Only the form one is in counts.
/** Whose chain is the player's own, among the names of the companions. */
export const PLAYER_FORMS = '@player'
export const MAX_FORMS = 6
// How many have a chain of 形态: the player, the companions, and a card's tameable creatures (one with a bestiary of NPC pets has dozens).
export const MAX_FORM_OWNERS = 64
/** The points a form's effects may come to, by how far along its chain it is. */
export const FORM_BUDGET = [2, 4, 6, 8]
const MAX_FORM_SKILLS = 3
export { SHIFT_COST, SHIFT_UPKEEP }
export const formBudget = at => FORM_BUDGET[Math.max(0, Math.min(at, FORM_BUDGET.length - 1))]

/**
 * A card's 形态 as kept: { owner: [{ name, stage?, effects, skills?: { name: kind or '' }, at?: { level?, item?, bond? }, temp?, drain? }] }.
 * An owner is one of the companions, the player, or a foe that can be tamed (收服): what it is called is all that ties them.
 * The first of a chain is how its owner starts. `at`: what it takes to come to it for good (all of what is said; with
 * none, only the story can say so). `temp`: it can be taken for one fight by one in the form before it.
 */
export function cleanForms(value, ranks = []) {
  const out = {}
  if (!isRecord(value)) return out
  const text = (item, max) => (typeof item === 'string' ? item.trim().slice(0, max) : '')
  for (const [key, list] of Object.entries(value).slice(0, MAX_FORM_OWNERS)) {
    const owner = ['玩家', 'player', PLAYER_FORMS].includes(key.trim()) ? PLAYER_FORMS : key.trim().slice(0, 40)
    if (!owner || !Array.isArray(list)) continue
    const chain = []
    for (const item of list) {
      const name = text(item?.name, 24)
      if (!name || chain.some(other => other.name === name)) continue
      const at = chain.length
      const skills = {}
      for (const [skill, kind] of Object.entries(isRecord(item.skills) ? item.skills : {}).slice(0, MAX_FORM_SKILLS)) if (skill.trim()) skills[skill.trim().slice(0, 40)] = Object.hasOwn(SKILLS, kind) ? kind : ''
      const needs = {}
      if (at > 0 && isRecord(item.at)) {
        if (Number.isInteger(item.at.level) && item.at.level > 1) needs.level = Math.min(99, item.at.level)
        if (text(item.at.item, 40)) needs.item = text(item.at.item, 40)
        if (Number.isInteger(item.at.bond) && item.at.bond > 0 && owner !== PLAYER_FORMS) needs.bond = Math.min(BOND_AT.length, item.at.bond)
      }
      chain.push({
        name,
        ...(text(item.stage, 12) ? { stage: text(item.stage, 12) } : {}),
        effects: cleanEffects(item.effects, Math.max(formBudget(at), formBudget(ranks.indexOf(text(item.stage, 12))))),
        // 种族值 (raise.js): what one is made of in this form, on a card that raises.
        ...(cleanSpecies(item.attributes) ? { attributes: cleanSpecies(item.attributes) } : {}),
        ...(Object.keys(skills).length ? { skills } : {}),
        ...(Object.keys(needs).length ? { at: needs } : {}),
        ...(at > 0 && item.temp === true ? { temp: true } : {}),
        // 能量耗尽: taken for a fight, it feeds on energy each round and is lost when there is none left.
        ...(at > 0 && item.temp === true && item.drain === true ? { drain: true } : {}),
        // 类型克制: a form may be of another type than the one before it.
        ...(text(item.type, 8) ? { type: text(item.type, 8) } : {}),
        // How it looks, for its picture (创作角色卡's 备齐门面图 draws each form as one of the cast).
        ...(text(item.looks, 300) ? { looks: text(item.looks, 300) } : {}),
      })
      if (chain.length === MAX_FORMS) break
    }
    // One form is no chain.
    if (chain.length > 1) out[owner] = chain
  }
  return out
}

/** Whose chain one of the party has: a companion's by their name, the player's own (a sheet has no name). */
const ownerOf = who => (typeof who?.name === 'string' && who.name ? who.name : PLAYER_FORMS)
/** The chain of one of the party on this card, or []. */
export const formsOf = (who, book) => (growsOn(book) ? book?.forms?.[ownerOf(who)] ?? [] : [])
/** Where in their chain one of the party is: 0 for the first, and for a form the card no longer has. */
export const formAt = (who, book) => Math.max(0, formsOf(who, book).findIndex(form => form.name === who?.form))
/** The form one of the party is in, or null for one with no chain. */
export const formOf = (who, book) => formsOf(who, book)[formAt(who, book)] ?? null
/** A form that is only ever taken for a fight: it asks for nothing, so nobody comes to it for good but by the story. */
export const fightOnly = form => form?.temp === true && !form.at
/**
 * The form one of the party comes to next for good, or null: the first after the one they are in that is not for a
 * fight only (a card may put 超进化 between two stages: it does not stand in the way of the second).
 */
export const nextForm = (who, book) => formsOf(who, book).slice(formAt(who, book) + 1).find(form => !fightOnly(form)) ?? null

/**
 * What a form still asks of one of the party: [{ kind: 'level' | 'item' | 'bond', need, met }]. Empty for one only
 * the story can give. `things`: the player's bag.
 */
export function formNeeds(form, who, things = []) {
  const out = []
  if (form?.at?.level) out.push({ kind: 'level', need: form.at.level, met: (who.level ?? 1) >= form.at.level })
  if (form?.at?.item) out.push({ kind: 'item', need: form.at.item, met: things.some(thing => thing.name === form.at.item && thing.count > 0) })
  if (form?.at?.bond) out.push({ kind: 'bond', need: form.at.bond, met: bondOf(who) >= form.at.bond })
  return out
}

/** The form one of the party can come to now for good, or null: the next of their chain, with all it asks for met. */
export function formReady(who, book, things = []) {
  const next = nextForm(who, book)
  const needs = formNeeds(next, who, things)
  return next && needs.length && needs.every(need => need.met) ? next : null
}

/** The form one of the party can take for a single fight, or null: the one right after theirs, where the card lets it. */
export const formForFight = (who, book) => {
  const next = formsOf(who, book)[formAt(who, book) + 1]
  return next?.temp ? next : null
}

/** The skills of one of the party when they are in another form: those of the form left go, those of the new one come. */
export function skillsInForm(who, book, to) {
  const now = formOf(who, book)
  // 养成: what one has learnt it keeps.
  const gone = book?.growth?.raise === true && !fightOnly(to) ? [] : Object.keys(now?.skills ?? {})
  const kept = (who.skills ?? []).filter(name => !gone.includes(name))
  return [...kept, ...Object.keys(to?.skills ?? {}).filter(name => !kept.includes(name))]
}

// 装备: a thing worn in one of three slots, with effects from the same table as 天赋, as many points as it is rare.
export const GEAR_SLOTS = ['weapon', 'armour', 'charm']
export const RARITIES = ['common', 'fine', 'rare', 'epic']
export const GEAR_BUDGET = { common: 2, fine: 3, rare: 4, epic: 6 }
// What a thing whose effects could not be read does, by where it is worn.
const SLOT_EFFECT = { weapon: { id: 'attack', size: 'small' }, armour: { id: 'guard', size: 'small' }, charm: { id: 'life', size: 'small' } }
const SLOT_WORDS = [[/[剑刀枪弓斧杖棍矛刃匕弩炮鞭锤爪]|武器|法杖|步枪|手枪/, 'weapon'], [/[甲盔衣袍盾靴铠]|披风|外套|头盔|护具|护腕|装甲/, 'armour']]

/** Where a thing is worn, by its name, for one nobody has said. */
export const slotByName = name => SLOT_WORDS.find(([word]) => word.test(name))?.[1] ?? 'charm'

/** A thing that is worn, as kept: { type: 'gear', slot, rarity, effects }, or null for one that is not. */
export function cleanGear(value, name = '') {
  if (!isRecord(value) || value.type !== 'gear') return null
  const slot = GEAR_SLOTS.includes(value.slot) ? value.slot : slotByName(name)
  const rarity = RARITIES.includes(value.rarity) ? value.rarity : 'common'
  const effects = cleanEffects(value.effects, GEAR_BUDGET[rarity])
  return { type: 'gear', slot, rarity, effects: effects.length ? effects : [{ ...SLOT_EFFECT[slot] }] }
}

/** What a thing by a name is as gear on this card, or null. */
export const gearOf = (book, name) => (book?.items?.[name]?.type === 'gear' ? book.items[name] : null)

// 羁绊: a companion who has fought beside the player this many times is the better for it, a step at a time.
export const BOND_AT = [3, 8, 15]
const BOND_EFFECTS = [{ id: 'guard', size: 'small' }, { id: 'attack', size: 'small' }, { id: 'cover', size: 'medium' }]
/** How far a companion's 羁绊 has come: 0 to 3. */
export const bondOf = who => BOND_AT.filter(need => (who?.bond ?? 0) >= need).length
/** The fights still to be fought together for the next step, or null at the last. */
export const nextBondAt = who => BOND_AT.find(need => (who?.bond ?? 0) < need) ?? null
const bondEffects = who => BOND_EFFECTS.slice(0, bondOf(who))

// 属性历练: a roll that came off against a number worth the name leaves a mark on the attribute it was made on, and
// enough of them is a point of it. The higher it already stands, the more it takes.
export const PRACTICE_DC = 12
export const practiceNeeds = value => Math.max(6, 6 * (value - 10))

/**
 * 天赋 every card has: plain names that suit any story (the page has them in its own language, by id). A key
 * starting with # is one of these on a sheet; a card's own is kept by its name.
 */
export const BUILTIN_PERKS = [
  { id: 'iron', name: '铁骨', note: '挨打更轻，也更耐打', effects: [{ id: 'guard', size: 'medium' }, { id: 'life', size: 'small' }] },
  { id: 'heavy', name: '重手', note: '每一下都更重', effects: [{ id: 'attack', size: 'medium' }, { id: 'crit', size: 'small' }] },
  { id: 'vigor', name: '气血充盈', note: '生命上限大幅提高', effects: [{ id: 'life', size: 'large' }] },
  { id: 'berserk', name: '背水一战', note: '快撑不住时打得更狠', effects: [{ id: 'fury', size: 'medium' }, { id: 'attack', size: 'small' }] },
  { id: 'undying', name: '不屈', note: '每场第一次被打倒时还能站住', effects: [{ id: 'stand' }, { id: 'life', size: 'small' }] },
  { id: 'reckless', name: '以伤换伤', note: '伤害大幅提高，但更容易受伤', effects: [{ id: 'attack', size: 'large' }, { id: 'guard', size: 'small', minus: true }] },
  { id: 'swift', name: '先发制人', note: '开打时总是最先出手', effects: [{ id: 'first' }, { id: 'speed', size: 'small' }] },
  { id: 'nimble', name: '身轻如燕', note: '出手更早，也更容易脱身', effects: [{ id: 'speed', size: 'medium' }, { id: 'flee', size: 'small' }] },
  { id: 'keen', name: '眼疾手快', note: '更容易打出暴击', effects: [{ id: 'crit', size: 'medium' }, { id: 'speed', size: 'small' }] },
  { id: 'slippery', name: '全身而退', note: '想走的时候几乎拦不住', effects: [{ id: 'flee', size: 'large' }] },
  { id: 'precise', name: '直取要害', note: '暴击的机会大幅提高', effects: [{ id: 'crit', size: 'large' }] },
  { id: 'parry', name: '见招拆招', note: '出手更早，挨打更轻', effects: [{ id: 'speed', size: 'medium' }, { id: 'guard', size: 'small' }] },
  { id: 'focus', name: '凝神', note: '技能更省气力', effects: [{ id: 'thrift', size: 'medium' }, { id: 'energy', size: 'small' }] },
  { id: 'reserve', name: '气脉悠长', note: '气力上限大幅提高', effects: [{ id: 'energy', size: 'large' }] },
  { id: 'breath', name: '调息', note: '战斗中慢慢回复，打完恢复得更快', effects: [{ id: 'regen', size: 'medium' }, { id: 'mend', size: 'small' }] },
  { id: 'study', name: '举一反三', note: '得到的经验更多', effects: [{ id: 'gain', size: 'large' }] },
  { id: 'adept', name: '融会贯通', note: '所有技能更强，也更省气力', effects: [{ id: 'hone', size: 'small' }, { id: 'thrift', size: 'small' }] },
  { id: 'insight', name: '洞若观火', note: '心智检定更有把握，也更容易打中要害', effects: [{ id: 'check', size: 'medium', on: 'mind' }, { id: 'crit', size: 'small' }] },
  { id: 'guardian', name: '护卫', note: '同伴挨打时替他挡下', effects: [{ id: 'cover', size: 'medium' }, { id: 'guard', size: 'small' }] },
  { id: 'kindred', name: '同心', note: '打完恢复得更快，也会替同伴挡下几次', effects: [{ id: 'mend', size: 'medium' }, { id: 'cover', size: 'small' }] },
  { id: 'silver', name: '能言善辩', note: '魅力检定大幅提高', effects: [{ id: 'check', size: 'large', on: 'charm' }] },
  { id: 'relentless', name: '越战越勇', note: '打得更狠，边打边回复', effects: [{ id: 'attack', size: 'small' }, { id: 'regen', size: 'small' }, { id: 'fury', size: 'small' }] },
  { id: 'athlete', name: '身强体健', note: '体魄检定更有把握，生命上限提高', effects: [{ id: 'check', size: 'medium', on: 'body' }, { id: 'life', size: 'small' }] },
  { id: 'deft', name: '心灵手巧', note: '灵巧检定更有把握，也更容易脱身', effects: [{ id: 'check', size: 'medium', on: 'grace' }, { id: 'flee', size: 'small' }] },
  // 大天赋: these are only offered at a 突破, one of three.
  { id: 'titan', big: true, name: '金刚不坏', note: '挨打轻得多，也耐打得多', effects: [{ id: 'guard', size: 'medium' }, { id: 'life', size: 'medium' }] },
  { id: 'slayer', big: true, name: '势如破竹', note: '伤害大幅提高，也更容易打出暴击', effects: [{ id: 'attack', size: 'large' }, { id: 'crit', size: 'small' }] },
  { id: 'phoenix', big: true, name: '浴火重生', note: '被打倒时站住一次，战斗中不断回复', effects: [{ id: 'stand' }, { id: 'regen', size: 'medium' }] },
  { id: 'tempest', big: true, name: '疾风迅雷', note: '总是先出手，暴击的机会大幅提高', effects: [{ id: 'first' }, { id: 'crit', size: 'medium' }] },
  { id: 'archon', big: true, name: '登堂入室', note: '所有技能更强，气力也更多', effects: [{ id: 'hone', size: 'small' }, { id: 'energy', size: 'medium' }] },
  { id: 'warden', big: true, name: '中流砥柱', note: '常替同伴挡下，自己也更扛得住', effects: [{ id: 'cover', size: 'medium' }, { id: 'guard', size: 'medium' }] },
]
/** How many of them are the ordinary ones every card has. */
export const BUILTIN_COUNT = BUILTIN_PERKS.filter(perk => !perk.big).length

/** A 天赋 by what a sheet keeps of it: { key, name, note, effects, own (the card's) }, or null for one that is gone. */
export function perkOf(book, key) {
  const text = String(key ?? '')
  if (text.startsWith('#')) {
    const found = BUILTIN_PERKS.find(perk => perk.id === text.slice(1))
    return found ? { key: text, ...found } : null
  }
  const own = (book?.perks ?? []).find(perk => perk.name === text)
  return own ? { key: text, own: true, ...own } : null
}

/** All there is to choose from: the card's own first. */
export const perkPool = book => [...(book?.perks ?? []).map(perk => ({ key: perk.name, own: true, ...perk })), ...BUILTIN_PERKS.map(perk => ({ key: `#${perk.id}`, ...perk }))]

/** Whether a 天赋 one has is a 大天赋: those are counted apart. One the card no longer has counts as an ordinary one. */
const isBig = (book, key) => perkOf(book, key)?.big === true

/** How many 天赋 one of the party has still to choose. */
export function perksOwed(who, book) {
  if (!perksOn(book)) return 0
  return Math.max(0, Math.floor((who.level ?? 1) / perkEveryOf(book)) - (who.perks ?? []).filter(key => !isBig(book, key)).length - (who.perkSkips ?? 0))
}

/**
 * How many 大天赋 the player has still to choose: one for each 突破 since the card counted them (`bigs`, kept on the
 * sheet as each rank is crossed, so a story from before this is owed none for the ranks it crossed already).
 */
export function bigsOwed(who, book) {
  if (!perksOn(book)) return 0
  return Math.max(0, (who.bigs ?? 0) - (who.perks ?? []).filter(key => isBig(book, key)).length - (who.bigSkips ?? 0))
}

/** What one may take now: not had already, and what it asks for is had. `big`: of the 大天赋, or of the rest. */
const open = (who, book, big = false) => perkPool(book).filter(perk => Boolean(perk.big) === big && !(who.perks ?? []).includes(perk.key) && (!perk.needs || (who.perks ?? []).includes(perk.needs)))

/** Whether one may take this 天赋 now. */
export const canTake = (who, book, key) => (isBig(book, key) ? bigsOwed(who, book) > 0 && open(who, book, true).some(perk => perk.key === key) : perksOwed(who, book) > 0 && open(who, book).some(perk => perk.key === key))

const shuffled = (list, random) => {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * The three put before one who has a 天赋 to choose: the same three however often the story is gone back over.
 * The card's own come first, with one of every card's among them where there is room, so a build is never only the card's.
 */
export function perkOffer(who, book, seed, big = false) {
  if (!(big ? bigsOwed(who, book) : perksOwed(who, book))) return []
  // Each kind is drawn by how many of its own kind were chosen: taking a 大天赋 does not shuffle the other three.
  const chosen = (who.perks ?? []).filter(key => isBig(book, key) === big).length + ((big ? who.bigSkips : who.perkSkips) ?? 0)
  const random = randomFrom(seedOf(big ? 'big' : 'perk', String(seed), String(who.name ?? ''), String(chosen)))
  const all = open(who, book, big)
  const own = shuffled(all.filter(perk => perk.own), random)
  const plain = shuffled(all.filter(perk => !perk.own), random)
  const fromCard = own.slice(0, plain.length ? 2 : 3)
  return [...fromCard, ...plain].slice(0, 3)
}

/** The attribute a 天赋 suits most. */
function leaning(perk) {
  const tally = {}
  for (const effect of perk.effects) {
    if (effect.minus) continue
    const to = effect.id === 'check' ? effect.on : EFFECTS[effect.id].leans
    tally[to] = (tally[to] ?? 0) + Math.abs(costOf(effect))
  }
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'body'
}

/** The 天赋 chosen for one who does not choose: what suits what they are best at, the card's own before the rest. */
export function perkFor(who, book, big = false) {
  const all = open(who, book, big)
  if (!all.length) return null
  const best = ATTRIBUTE_IDS.slice().sort((a, b) => (who.attributes?.[b] ?? 10) - (who.attributes?.[a] ?? 10))
  for (const attribute of best) {
    const found = all.find(perk => leaning(perk) === attribute)
    if (found) return found.key
  }
  return all[0].key
}

/** How far a skill has come for how often it was used: 1 to 5. */
export const stageOf = uses => 1 + MASTERY_USES.filter(need => (uses ?? 0) >= need).length

/** The uses the next stage takes, or null at the last. */
export const nextStageAt = uses => MASTERY_USES.find(need => (uses ?? 0) < need) ?? null

const emptyBonus = () => ({ attack: 0, guard: 0, life: 0, energy: 0, speed: 0, crit: 0, flee: 0, fury: 0, regen: 0, thrift: 0, cover: 0, mend: 0, gain: 0, first: false, stand: false, check: {}, hone: {} })

/**
 * All that one of the party has from growing, added up: { attack, guard, life, energy, speed, crit, flee, fury, regen,
 * thrift, cover, mend, gain (shares or points, as the table has them), first, stand, check: { attribute: points },
 * hone: { a skill's kind or name, or '' for all: share } }. Nothing at all on a card that does not count growth.
 */
export function bonusOf(who, book) {
  const bonus = emptyBonus()
  if (!growsOn(book)) return bonus
  const level = Math.max(1, who.level ?? 1)
  bonus.life += LIFE_PER_LEVEL * (level - 1)
  bonus.energy += Math.floor((level - 1) / LEVELS_PER_ENERGY)
  const add = (held, key, amount, most) => { held[key] = Math.max(-most, Math.min(most, (held[key] ?? 0) + amount)) }
  const take = effect => {
    const rule = EFFECTS[effect.id]
    if (!rule.sizes) {
      bonus[effect.id] = true
      return
    }
    const amount = rule.sizes[SIZES.indexOf(effect.size)] * (effect.minus ? -1 : 1)
    if (effect.id === 'check') add(bonus.check, effect.on, amount, rule.most)
    else if (effect.id === 'hone') add(bonus.hone, effect.on ?? '', amount, rule.most)
    else add(bonus, effect.id, amount, rule.most)
  }
  if (perksOn(book)) for (const key of who.perks ?? []) for (const effect of perkOf(book, key)?.effects ?? []) take(effect)
  // 装备: what they have on, a thing to each slot.
  for (const name of Object.values(who.gear ?? {})) for (const effect of gearOf(book, name)?.effects ?? []) take(effect)
  // 羁绊: what fighting beside the player has come to, for a companion.
  for (const effect of bondEffects(who)) take(effect)
  // 形态: what the form they are in gives; those before it gave theirs while they lasted.
  for (const effect of formOf(who, book)?.effects ?? []) take(effect)
  // A level's own share of life is over and above what the rest may add up to.
  bonus.life = Math.max(-0.5, bonus.life)
  return bonus
}

/** Whether a bonus changes nothing: then a fight is set up as it always was. */
const idle = bonus => !bonus || (Object.entries(bonus).every(([key, value]) => (typeof value === 'object' ? !Object.keys(value).length : !value)))

/**
 * What a fight is told of one of the party's growth: only what is not nothing, so that with none of it a fight's
 * setup is what it was. `tough`: how much more life they have than one who has not grown; a foe's blow is a share
 * of the life before that, so more of it is more to take. `spare`: the energy growth added, which a skill's cost
 * (a share of the most energy) leaves out for the same reason.
 */
export function fightBonus(bonus) {
  if (idle(bonus)) return null
  const out = {}
  for (const key of ['attack', 'guard', 'speed', 'crit', 'flee', 'fury', 'regen', 'cover']) if (bonus[key]) out[key] = bonus[key]
  if (bonus.life) out.tough = 1 + bonus.life
  if (bonus.energy) out.spare = bonus.energy
  if (bonus.first) out.first = true
  if (bonus.stand) out.stand = true
  return Object.keys(out).length ? out : null
}

/** What growth does to each skill of one of the party in a fight: { name: { power?, cost?, stage? } }, only what is not as it was. */
export function skillGrowth(who, book, names, kinds = {}) {
  const out = {}
  if (!growsOn(book)) return out
  const bonus = bonusOf(who, book)
  for (const name of names) {
    const stage = stageOf(who.mastery?.[name])
    const kind = kinds[name]
    const honed = (bonus.hone[''] ?? 0) + (bonus.hone[name] ?? 0) + (kind && kind !== name ? bonus.hone[kind] ?? 0 : 0)
    const power = (1 + STAGE_POWER * (stage - 1)) * (1 + Math.min(EFFECTS.hone.most, honed))
    const cost = (stage >= THRIFT_FROM ? 1 - STAGE_THRIFT : 1) * (1 - bonus.thrift)
    const grown = { ...(Math.abs(power - 1) > 1e-9 ? { power: Math.round(power * 1000) / 1000 } : {}), ...(Math.abs(cost - 1) > 1e-9 ? { cost: Math.round(cost * 1000) / 1000 } : {}), ...(stage > 1 ? { stage } : {}) }
    if (Object.keys(grown).length) out[name] = grown
  }
  return out
}

// 难度跟上: a foe the story gave only a word (相当、稍强) is as strong as the player was before growing, so one who grows
// leaves it behind. It follows this share of what growing is worth to one who grows as most do; the rest is the player's.
const FOLLOW = { easy: 0.25, normal: 0.5, hard: 0.75 }
// What growing is worth at a level, as `simulate` has it (plans/16): a level's life, skills used about four times a
// level, and on a card with 天赋 one of them every third level, half to what is dealt and half to what is taken.
const USUAL_TAKE = LIFE_PER_LEVEL
const USUAL_DEAL = 0.018
const USUAL_DEAL_MOST = 0.25
const USUAL_PERK = 0.06

/** What one who grows as most do has over one who has not, at a level: { deal, take }, as shares. */
export function usualGrowth(level, book) {
  if (!growsOn(book)) return { deal: 0, take: 0 }
  const levels = Math.max(0, (level ?? 1) - 1)
  const taken = perksOn(book) ? Math.min(MAX_PERKS, levels / perkEveryOf(book)) : 0
  const perks = taken * USUAL_PERK
  return { deal: Math.min(USUAL_DEAL_MOST, USUAL_DEAL * levels) + perks, take: USUAL_TAKE * levels + perks }
}

// 装备: what is worn is worth as much as it adds to what is dealt and to what can be taken. A blow that lands
// harder now and then counts for half its chance, one that only comes when cornered for less; life that comes back
// each round counts for the few rounds a fight lasts.
const WORN_CRIT = 0.5
const WORN_FURY = 0.15
const WORN_REGEN = 3

/**
 * What those who fight have on is worth, as `usualGrowth` has a level's worth: { deal, take }, the average of the
 * player and whoever stands with them, or null when nobody wears anything. Unlike a level's worth this is what they
 * really have: a card with no gear has nothing here for a foe to follow.
 */
export function wornWorth(party, book) {
  if (!growsOn(book) || !party.length) return null
  let deal = 0
  let take = 0
  for (const who of party) {
    // 形态: a form come to for good is followed as what is worn is; the first of a chain is how they always were.
    if (!Object.keys(who.gear ?? {}).length && !(formAt(who, book) > 0)) continue
    const on = bonusOf(who, book)
    const off = bonusOf({ ...who, gear: {}, form: undefined }, book)
    deal += on.attack - off.attack + WORN_CRIT * (on.crit - off.crit) + WORN_FURY * (on.fury - off.fury)
    take += on.guard - off.guard + on.life - off.life + WORN_REGEN * (on.regen - off.regen)
  }
  const round = value => Math.round((value / party.length) * 1000) / 1000
  return round(deal) || round(take) ? { deal: round(deal), take: round(take) } : null
}

/**
 * What a foe with only a word for its strength has for the player's growing: { life, damage } to multiply by, or null
 * when there is nothing to it. `level`: the player's when they first met it. `share`: how much of it, when not the
 * difficulty's own. `worn`: what the party had on then (wornWorth), followed by the same share.
 */
export function foesFollow(level, book, difficulty = 'normal', share = FOLLOW[difficulty] ?? FOLLOW.normal, worn = null) {
  const usual = usualGrowth(level, book)
  const deal = usual.deal + (growsOn(book) ? worn?.deal ?? 0 : 0)
  const take = usual.take + (growsOn(book) ? worn?.take ?? 0 : 0)
  if (!deal && !take) return null
  const round = value => Math.round(value * 1000) / 1000
  return { life: round(1 + share * deal), damage: round(1 + share * take) }
}

/** What growth adds to a roll on an attribute. */
export const checkBonus = (who, book, attribute) => (attribute ? bonusOf(who, book).check[attribute] ?? 0 : 0)

/** The most life and energy one of the party has, from what one who has not grown would have. */
export function grownMost(who, book, { life, energy }) {
  const bonus = bonusOf(who, book)
  return { life: Math.max(1, Math.round(life * (1 + bonus.life))), energy: Math.max(1, energy + bonus.energy) }
}

/**
 * How strong one of the party is, in one number, for a page that shows it: an ordinary person at level 1 is 100.
 * Only a guide: what they can deal and what they can take, multiplied.
 */
export function powerOf(who, book) {
  const bonus = bonusOf(who, book)
  const body = modifierOf(who.attributes?.body ?? 10)
  const deal = (1 + 0.1 * Math.max(body, modifierOf(who.attributes?.mind ?? 10))) * (1 + bonus.attack) * (1 + bonus.crit * 0.5)
  const take = ((1 + bonus.life) / Math.max(0.2, 1 - 0.04 * body)) / Math.max(0.2, 1 - bonus.guard)
  return Math.round(100 * Math.sqrt(deal * take))
}

// What each kind of skill and each add does, as a model that writes skills is told. Every kind and every add the rules
// have is here (a test holds it to that), so a new one is asked for as soon as there is one.
const KIND_ASKS = { strike: '重击一个敌人', sweep: '打所有敌人，每个轻一些', flurry: '对一个敌人连打两下', poison: '打一下，让敌人中毒', stun: '打一下，可能打晕', heal: '回复自己或一个同伴的生命', boost: '自己 3 回合伤害提高', finish: '打一下，对生命不到四成的敌人伤害翻倍', mend: '全队回复生命，每人少一些', ward: '给自己或一个同伴一层护盾，3 回合', rally: '全队 3 回合伤害提高', taunt: '引敌人来打自己，自己少受伤，3 回合' }
const ADD_ASKS = { poison: '敌人 3 回合持续掉血', stun: '可能打晕敌人', weaken: '敌人 3 回合打得更轻', expose: '敌人 3 回合受到的伤害更高', slow: '敌人动作变慢，会错过出手', leech: '伤害的一部分回复自己', surge: '命中后回一点气力', cleanse: '解除一个异常', recoil: '代价：自己掉一点血' }

// What each of a foe's adds does, as a model that writes a bestiary is told. Every one the rules have is here (a test
// holds it to that).
const FOE_ADD_ASKS = { poison: '打中后对方 3 回合持续掉血（毒、流血、灼烧、腐蚀）', weaken: '打中后对方 3 回合打得更轻（恐吓、缴械、寒气）', expose: '打中后对方 3 回合更怕打（破甲、撕开防御）', stun: '打中后可能让对方错过下一次出手（震晕、麻痹、冰封）', leech: '打中后自己回复生命（吸血、吞噬）' }

/** What a model that writes a card's foes is asked for: what a 精英 or a 首领 of that kind does with its blows. */
export function foeAddsAsk() {
  return `foes 里强一些的敌人（会当精英、首领出场的）可以再带 "adds"，是它打中人以后的效果：[{"id": "poison", "size": "medium"}]，id 从这些里选：${Object.keys(FOE_ADDS).map(id => `${id}（${FOE_ADD_ASKS[id]}）`).join('、')}；size 写 small、medium、large，各算 1、2、3 点。每个敌人 0 到 ${FOE_ADD_ROOM.boss.count} 条，加起来不超过 ${FOE_ADD_ROOM.boss.points} 点，按它的外貌和打法来选（带毒的写 poison，吸血的写 leech），杂鱼和没有特点的不写。精英出场时只用第一条（最多 ${FOE_ADD_ROOM.elite.points} 点），首领才两条都用。`
}

/** 形态, as the model that tells the story is told of them: who is in which now, and each chain by its names. Null with none. */
export function formsTold(sheet, book) {
  const now = []
  const chains = []
  // `story`: the forms that are next for somebody and ask for nothing: only the story can bring those.
  const story = []
  for (const who of [sheet, ...(sheet?.party ?? [])]) {
    const chain = formsOf(who, book)
    if (!chain.length) continue
    const name = who === sheet ? '玩家' : who.name
    const form = formOf(who, book)
    now.push(`${name}现在是${form.name}${form.stage ? `（${form.stage}）` : ''}`)
    chains.push(`${name}：${chain.map(item => item.name).join(' → ')}`)
    const next = nextForm(who, book)
    if (next && !next.at) story.push(`${name}的${next.name}`)
  }
  return now.length ? { now, chains, story } : null
}

/** What a model that lays out a card's rules is asked for about 形态: only for a world where somebody changes. */
export function formsAsk() {
  return `"forms" 只在这个世界有人或伙伴会换一副样子、换了以后能力也跟着换时写（变身、觉醒、解放、合体、附身、进化），没有就不写这个字段。只升不降、越升越强的等级（修为、段位、军衔这类）不是形态，那些写在 ranks 里；形态是「变成另一个样子」，可以变回去，也可以只在打斗时才变。写成 {"谁": [形态, 形态]}：谁是 companions 里的名字，玩家自己写 "玩家"；开了收服（tame）的世界，也可以给 foes 里能收服的敌人写，名字和 foes 里的一样，它被收服以后照这条链成长。每条链 2 到 ${MAX_FORMS} 个形态，从最初的样子写到最后的：{"name": "形态名", "stage": "阶段名", "looks": "English description of how it looks", "effects": [{"id": "attack", "size": "medium"}], "skills": {"技能名": "strike"}, "at": {"level": 8, "item": "道具名", "bond": 2}, "temp": true}。第一个是最初的样子，不写 at 和 temp。looks 是这个形态长什么样的一句英文画图描述（体型、颜色、特征，不写名字），用来给它画图。stage 是阶段的叫法（二段变身、完全体），没有就不写。effects 是处在这个形态时的加成，写法同 perks，只算当前形态的，点数上限按第几个形态依次是 ${FORM_BUDGET.join('、')}。skills 是只有这个形态才会的 0 到 2 个技能，值是 kind。形态分两种，按这个世界里它是哪一种来写，不要都写成按等级永久变的：一种是变了就一直是（宠物进化、血脉觉醒、换了机体），写 at，at 是变成它要满足的条件，写了几样就都要满足：level 是等级，item 是背包里要有的道具，bond 是和玩家的羁绊档位（1 到 ${BOND_AT.length}，只有同伴能写），不写 at 也不写 temp 的只能由剧情给；另一种是只在打斗时才变、打完就变回去（变身英雄、魔法少女、机甲合体、爆发状态、超进化），写 "temp": true 并且不写 at，战斗里花气力变；这样的形态连着写两个时（变身 → 强化形态），第二个要先变成第一个、在同一场里再花一次气力才能变。temp 的形态如果在设定里是靠能量撑着、撑不住就解除的，再写 "drain": true：变了以后每回合耗气力，耗尽就变回去。这个世界对「形态」和「变」另有叫法时（变身、觉醒、合体），写在 words 的 form 和 evolve 里。`
}

/** 类型克制, 谁上场 and 收服, as a model that lays out a card's rules is asked for them: only for a world that has them. */
export function modulesAsk() {
  return `下面三项只在这个世界确实有时才写，没有就不写这些字段。"types"：这个世界的东西分属性并且互相克制时（元素、五行、疫苗病毒数据）写 {"火": ["草"], "草": ["水"], "水": ["火"]}，键是属性名（最多 8 种，每个最多 4 个字），值是它克制的属性；然后给 skills 和 companions 的技能各加 "type"，给 foes、companions 各加 "type"，forms 里属性变了的形态也加，都写这里的属性名，没有属性的不写。玩家自己也属于其中一种属性时写 "selfType": "属性名"。"lead"：玩家自己不动手、只指挥伙伴打（驯兽师、召唤师、指挥官）时写 "command"，这时 companions 至少要有一个开局同行的。"tame"：打赢以后能把敌人收为伙伴（收服、契约、捕捉）时写 true。`
}

/** What a model that lays out a card's rules is asked for about gear, among the things the story starts with. */
export function gearAsk() {
  return `things 里可以有 0 到 3 件这个世界标志性的装备，写成 {"name": "名字", "count": 1, "type": "gear", "slot": "weapon", "rarity": "fine", "effects": [{"id": "attack", "size": "medium"}]}。slot 是 weapon（武器）、armour（防具）、charm（饰品）；rarity 是 ${RARITIES.join('、')}，effects 的点数上限分别是 ${RARITIES.map(rarity => GEAR_BUDGET[rarity]).join('、')}（small、medium、large 各算 1、2、3 点），effects 的 id 和写法同 perks。开局带的以 common、fine 为主，名字贴合题材。`
}

/** The same for a helper sorting things the story gave: what gear is, and how to say what it does. */
export function gearSortAsk() {
  const sized = EFFECT_IDS.filter(id => EFFECTS[id].sizes && !EFFECTS[id].on)
  return `gear 能穿戴的装备（武器、防具、饰品、法宝、芯片）。是 gear 的再写 "slot"（weapon 武器、armour 防具、charm 饰品）、"rarity"（${RARITIES.join('、')}，看它听起来多珍贵，拿不准写 common）和 "effects"：1 到 2 条 {"id": "attack", "size": "small"}，id 从这些里选：${sized.map(id => `${id}（${EFFECT_ASKS[id]}）`).join('、')}；size 是 small、medium、large，各算 1、2、3 点，加起来不超过 ${RARITIES.map(rarity => `${rarity} ${GEAR_BUDGET[rarity]}`).join('、')} 点。`
}

/** What a model that writes a card's skills is asked for: the kinds, and what a skill may do on top of its kind. */
export function skillsAsk() {
  const kinds = Object.keys(SKILLS).map(kind => `${kind}（${KIND_ASKS[kind]}）`).join('、')
  const adds = Object.keys(SKILL_ADDS).map(id => `${id}（${ADD_ASKS[id]}）`).join('、')
  const blows = Object.keys(SKILL_ADDS).filter(id => SKILL_ADDS[id].on === 'blow').join('、')
  const cares = Object.keys(SKILLS).filter(kind => SKILLS[kind].heal || SKILLS[kind].ward).join('、')
  return `skills 2 到 4 个，名字贴合题材，kind 从这些里选：${kinds}。技能可以再带 "adds"，让同一种的技能各不相同，比如 {"name": "寒霜剑气", "kind": "strike", "adds": [{"id": "slow", "size": "medium"}]}。adds 每个技能 0 到 ${MAX_ADDS} 条，id 从这些里选：${adds}；size 写 small、medium、large，各算 1、2、3 点（cleanse 固定 1 点），一个技能加起来不超过 ${ADD_BUDGET} 点。附加越多这一招本身越轻，所以不用每个都带：一半左右的技能带附加，其中可以有一个带两条的。按名字和设定来选，几个技能的附加不要都一样：用毒、流血、灼烧的写 poison，冰霜、缠绕、泥沼的写 slow，恐吓、压制、缴械的写 weaken，破甲、看穿弱点的写 expose，吸血、吞噬的写 leech，调息、借力回气的写 surge，以伤换伤、燃烧自己的再加一条 recoil。同一个名字的技能只写一次。${blows} 只能加在会打人的技能上；cleanse 只能加在 ${cares} 上；recoil 是代价，退回一半点数，不能单独写。`
}

// What each effect does, as a model that writes 天赋 is told (the page has its own words for the player, in its language).
const EFFECT_ASKS = {
  attack: '造成的伤害更高',
  guard: '受到的伤害更低',
  life: '生命上限更高',
  energy: '气力上限更高',
  speed: '出手更早',
  crit: '更容易打出暴击',
  check: '某一项属性的检定更有把握，要写 "on"：body、grace、mind 或 charm',
  flee: '更容易从战斗里脱身',
  first: '第一回合必定最先出手',
  stand: '每场第一次被打倒时还能站住',
  fury: '生命低于三成时伤害更高',
  regen: '战斗中每回合回复一点生命',
  thrift: '技能更省气力',
  cover: '同伴挨打时替他挡下',
  mend: '打完以后回复生命',
  gain: '得到的经验更多',
  hone: `技能更强，"on" 可以写一个技能名或一种 kind（${Object.keys(SKILLS).join('、')}），不写就是所有技能`,
}

/**
 * What a model is asked for when it writes a card's own 天赋: the field's shape and every effect there is, from the
 * table, so one added there is offered here too. `word`: what to call them where the card has not said.
 */
export function perksAsk(word = '天赋') {
  const sized = EFFECT_IDS.filter(id => EFFECTS[id].sizes)
  const plain = EFFECT_IDS.filter(id => !EFFECTS[id].sizes)
  return `"perks" 是这个世界的人能练出来的 6 到 10 个${word}（升级时三选一）：[{"name": "名字", "note": "一句话说它是什么", "effects": [{"id": "attack", "size": "medium"}]}]。这个世界有明确的大等级（ranks 不是空的）时，其中 2 到 3 个再写 "big": true：那是跨进下一个大等级时才能选的，分量更重，效果加起来可以到 ${BIG_BUDGET} 点。name 按这个世界的说法起（武学心法、神通、被动技能、特性、改造、专长，看题材），不要和技能重名。effects 每个写 1 到 2 条，尽量把点数用满（一条 large，或者一条 medium 加一条 small），只有一条 medium 的不要超过一半。id 只能从这些里选：${EFFECT_IDS.map(id => `${id}（${EFFECT_ASKS[id]}）`).join('、')}。size 是 ${SIZES.join('、')}；${plain.join(' 和 ')} 不写 size。一个${word}的效果加起来不超过 ${PERK_BUDGET} 点：small 算 1 点，medium 2 点，large 3 点，${plain.join('、')} 各 ${EFFECTS[plain[0]].cost} 点。想写有代价的，给其中一条加 "minus": true，它就反过来变成坏处，并退回一半的点数（只有${sized.slice(0, 3).join('、')}这类带 size 的可以）。几个${word}之间要有区别：偏进攻的、偏防守的、偏身法的、偏检定的都要有，不要全是加伤害。很少打架的故事（日常、恋爱、解谜）以 check 和 gain 为主，不写战斗里才有用的。其中最多两个可以教会一个技能：加 "skill": {"name": "技能名", "kind": "strike"}（kind 同 skills，名字不要和已有的技能重复），这算 ${PERK_SKILL_COST} 点，effects 相应少写 ${PERK_SKILL_COST} 点，也可以不写 effects。`
}
