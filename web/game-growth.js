// 成长 on the page: the player's words for what shared/game/growth.js counts, and the pieces of the 游戏菜单 and of a
// reply that show it. Loaded with game-play.js, for a chat whose card has rules.
import { t } from '/i18n.js'
import { worthChange } from '/game-raise.js'
import { BIG_BUDGET, BOND_AT, EFFECT_IDS, GEAR_BUDGET, GEAR_SLOTS, LEVEL_GAINS, RARITIES, STAGE_USES, bigsOwed, bondOf, gearOf, nextBondAt } from '/shared/game/growth.js'
import { MAX_STAGE, SIZES, SKIP_POINTS, EFFECTS, bonusOf, growsOn, nextStageAt, perkOf, perkOffer, perksOn, perksOwed, powerOf, practiceNeeds, stageOf } from '/shared/game/growth.js'
import { MAX_FORMS, PLAYER_FORMS, SHIFT_COST, fightOnly, formAt, formBudget, formForFight, formNeeds, formOf, formReady, formsOf, nextForm, perkEveryOf, rankGives } from '/shared/game/growth.js'
import { bondPointsOf, everyGives, levelPointsOf, rankRestores } from '/shared/game/growth.js'
import { STEPS_PER_RANK, rankAt } from '/shared/game/rank.js'
import { skillKindIn, ATTRIBUTES, startSheet } from '/shared/game/sheet.js'

export { BIG_BUDGET, bigsOwed, bonusOf, growsOn, perkOf, perksOn, perksOwed, powerOf, practiceNeeds, stageOf, gearOf, EFFECT_IDS, GEAR_SLOTS, RARITIES, GEAR_BUDGET, formOf, formsOf, formReady, perkEveryOf }

/** An attribute as the card calls it. */
export const attributeWord = (book, id) => book.words?.[id] || ATTRIBUTE_WORDS()[id] || id

/** 历练 of one of the party, for those attributes that have some: [{ id, name, held, needs }]. */
export const practiceRows = (who, book) => Object.entries(who.practice ?? {}).filter(([id, held]) => held > 0 && who.attributes?.[id] !== undefined).map(([id, held]) => ({ id, name: attributeWord(book, id), held, needs: practiceNeeds(who.attributes[id]) }))

// 天赋 every card has, in the page's language (the rules keep them by id, and tell the model their Chinese names).
const PERK_WORDS = (named = '') => {
  const energy = named || t`气力`
  return {
  iron: [t`铁骨`, t`挨打更轻，也更耐打`],
  heavy: [t`重手`, t`每一下都更重`],
  vigor: [t`气血充盈`, t`生命上限大幅提高`],
  berserk: [t`背水一战`, t`快撑不住时打得更狠`],
  undying: [t`不屈`, t`每场第一次被打倒时还能站住`],
  reckless: [t`以伤换伤`, t`伤害大幅提高，但更容易受伤`],
  swift: [t`先发制人`, t`开打时总是最先出手`],
  nimble: [t`身轻如燕`, t`出手更早，也更容易脱身`],
  keen: [t`眼疾手快`, t`更容易打出暴击`],
  slippery: [t`全身而退`, t`想走的时候几乎拦不住`],
  precise: [t`直取要害`, t`暴击的机会大幅提高`],
  parry: [t`见招拆招`, t`出手更早，挨打更轻`],
  focus: [t`凝神`, t`技能更省${energy}`],
  reserve: [t`气脉悠长`, t`${energy}上限大幅提高`],
  breath: [t`调息`, t`战斗中慢慢回复，打完恢复得更快`],
  study: [t`举一反三`, t`得到的经验更多`],
  adept: [t`融会贯通`, t`所有技能更强，也更省${energy}`],
  insight: [t`洞若观火`, t`心智检定更有把握，也更容易打中要害`],
  guardian: [t`护卫`, t`同伴挨打时替他挡下`],
  kindred: [t`同心`, t`打完恢复得更快，也会替同伴挡下几次`],
  silver: [t`能言善辩`, t`魅力检定大幅提高`],
  relentless: [t`越战越勇`, t`打得更狠，边打边回复`],
  athlete: [t`身强体健`, t`体魄检定更有把握，生命上限提高`],
  deft: [t`心灵手巧`, t`灵巧检定更有把握，也更容易脱身`],
  titan: [t`金刚不坏`, t`挨打轻得多，也耐打得多`],
  slayer: [t`势如破竹`, t`伤害大幅提高，也更容易打出暴击`],
  phoenix: [t`浴火重生`, t`被打倒时站住一次，战斗中不断回复`],
  tempest: [t`疾风迅雷`, t`总是先出手，暴击的机会大幅提高`],
  archon: [t`登堂入室`, t`所有技能更强，${energy}也更多`],
  warden: [t`中流砥柱`, t`常替同伴挡下，自己也更扛得住`],
  }
}
// An attribute goes by the name the story uses for it (the model writes 【检定|灵巧】), as it does everywhere else on
// the page: the 游戏菜单 and a roll's line show the same word, whatever the interface language.
const ATTRIBUTE_WORDS = () => Object.fromEntries(ATTRIBUTES.map(item => [item.id, item.name]))
const KIND_WORDS = () => ({ strike: t`重击`, sweep: t`群攻`, flurry: t`连击`, poison: t`中毒`, stun: t`眩晕`, heal: t`治疗`, boost: t`增益` })
export const SIZE_WORDS = () => ({ small: t`小幅`, medium: t`中幅`, large: t`大幅` })

// 技能的附加 (shared/game/battle.js SKILL_ADDS): a name for the list, and what it does in a few words (`energy`: what the
// card calls 气力).
export const ADD_NAMES = () => ({ poison: t`持续伤害`, stun: t`眩晕`, weaken: t`削弱`, expose: t`破绽`, slow: t`迟缓`, leech: t`吸取`, surge: t`回气`, cleanse: t`净化`, recoil: t`反噬` })
const ADD_WORDS = (energy = '') => ({ poison: t`3 回合持续掉血`, stun: t`可能打晕`, weaken: t`对方 3 回合打得更轻`, expose: t`对方 3 回合更怕打`, slow: t`对方动作变慢，会错过出手`, leech: t`伤害的一部分回复自己`, surge: t`命中后回一点${energy || t`气力`}`, cleanse: t`解除你的一个异常`, recoil: t`自己掉一点血` })

// 敌人的招式效果 (shared/game/battle.js FOE_ADDS): what a 精英 or a 首领 of a kind leaves on whom it strikes.
export const FOE_ADD_NAMES = () => ({ poison: t`持续伤害`, weaken: t`削弱`, expose: t`破绽`, stun: t`眩晕`, leech: t`吸取` })
const FOE_ADD_WORDS = () => ({ poison: t`打中后 3 回合持续掉血`, weaken: t`打中后 3 回合让你打得更轻`, expose: t`打中后 3 回合让你更怕打`, stun: t`打中后可能让你错过一次出手`, leech: t`打中后自己回复生命` })
/** A foe's adds by their names, for a tag: 持续伤害、吸取. '' for one with none. */
export const foeAddsLine = adds => (adds ?? []).map(add => FOE_ADD_NAMES()[add.id]).filter(Boolean).join(t`、`)
/** And in words, for where there is room: 打中后 3 回合持续掉血（中幅）；打中后自己回复生命（小幅）. */
export const foeAddsText = adds => (adds ?? []).map(add => t`${FOE_ADD_WORDS()[add.id]}（${SIZE_WORDS()[add.size]}）`).join(t`；`)

/**
 * What a skill does on top of its kind, in a line: 对方 3 回合更怕打（中幅）；自己掉一点血（小幅）. '' for one with nothing.
 * `energy`: the card's name for 气力 (book.energyName), for 回气.
 */
export const addsText = (adds, energy = '') => (adds ?? []).map(add => (add.size ? t`${ADD_WORDS(energy)[add.id]}（${SIZE_WORDS()[add.size]}）` : ADD_WORDS(energy)[add.id])).join(t`；`)
/** What each effect is called where a card's own 天赋 are edited. `words`: the card's names for life and energy. */
export const EFFECT_NAMES = (words = {}) => ({
  attack: t`伤害`, guard: t`减伤`, life: words.life ? t`${words.life}上限` : t`生命上限`, energy: words.energy ? t`${words.energy}上限` : t`气力上限`, speed: t`出手顺序`, crit: t`暴击率`, check: t`属性检定`, flee: t`逃跑`,
  first: t`先手`, stand: t`不屈`, fury: t`背水`, regen: t`每回合回复`, thrift: t`技能省力`, cover: t`替同伴挡下`, mend: t`战后回复`, gain: t`经验`, hone: t`技能威力`,
})

const percent = share => Math.round(share * 100)

/** One effect in the player's words: 伤害 +15%. `words`: the card's names for life, energy and the attributes. */
export function effectText(effect, words = {}) {
  const rule = EFFECTS[effect.id]
  const amount = rule.sizes ? rule.sizes[SIZES.indexOf(effect.size)] : 0
  const life = words.life || t`生命`
  const energy = words.energy || t`气力`
  const more = effect.minus ? '−' : '+'
  const less = effect.minus ? '+' : '−'
  if (effect.id === 'attack') return t`伤害 ${more}${percent(amount)}%`
  if (effect.id === 'guard') return t`受到的伤害 ${less}${percent(amount)}%`
  if (effect.id === 'life') return t`${life}上限 ${more}${percent(amount)}%`
  if (effect.id === 'energy') return t`${energy}上限 ${more}${amount}`
  if (effect.id === 'speed') return t`出手顺序 ${more}${amount}`
  if (effect.id === 'crit') return t`暴击率 ${more}${percent(amount)}%`
  if (effect.id === 'check') return t`${words[effect.on] || ATTRIBUTE_WORDS()[effect.on]}检定 ${more}${amount}`
  if (effect.id === 'flee') return t`逃跑 ${more}${amount}`
  if (effect.id === 'first') return t`第一回合最先出手`
  if (effect.id === 'stand') return t`每场第一次被打倒时，以 1 点${life}站住`
  if (effect.id === 'fury') return t`${life}低于三成时伤害 ${more}${percent(amount)}%`
  if (effect.id === 'regen') return t`战斗中每回合回复 ${percent(amount)}% ${life}`
  if (effect.id === 'thrift') return t`技能消耗 ${less}${percent(amount)}%`
  if (effect.id === 'cover') return t`同伴挨打时有 ${percent(amount)}% 的机会替他挡下`
  if (effect.id === 'mend') return t`打赢后回复 ${percent(amount)}% ${life}`
  if (effect.id === 'gain') return t`经验 ${more}${percent(amount)}%`
  const on = effect.on ? KIND_WORDS()[effect.on] ? t`${KIND_WORDS()[effect.on]}类技能` : t`「${effect.on}」` : t`所有技能`
  return t`${on}威力 ${more}${percent(amount)}%`
}

/** The card's own words (book.words), with what it calls 气力 as `energy`. */
export const wordsOf = book => ({ ...(book.words ?? {}), energy: book.energyName })

/** A 天赋 as the page shows it: { key, name, note, effects (in words) }, or null for one that is gone. */
export function perkShown(book, keyOrPerk) {
  const perk = typeof keyOrPerk === 'string' ? perkOf(book, keyOrPerk) : keyOrPerk
  if (!perk) return null
  const own = PERK_WORDS(book.energyName)[perk.id]
  const effects = [perk.skill ? t`学会${book.words?.skill || t`技能`}「${perk.skill}」` : '', ...perk.effects.map(effect => effectText(effect, wordsOf(book)))].filter(Boolean)
  return { key: perk.key, name: perk.own ? perk.name : own?.[0] ?? perk.name, note: perk.own ? perk.note : own?.[1] ?? perk.note, effects: effects.join(t`，`), branch: perk.branch ?? '', big: perk.big === true }
}

/** How far a skill has come, in a word: 二阶. Nothing at the first. */
export const stageWord = stage => ['', '', t`二阶`, t`三阶`, t`四阶`, t`五阶`][stage] ?? ''

/** A skill's name as it is shown once it has come some way: 破风斩·二阶. */
export const skillShown = (name, uses) => (stageOf(uses) > 1 ? `${name}·${stageWord(stageOf(uses))}` : name)

/** What the player or one of the party has still to do in the 游戏菜单: points to spend, 天赋 to choose. */
export const pendingOf = (sheet, book) => (sheet.points ?? 0) + perksOwed(sheet, book) + bigsOwed(sheet, book) + (book.growth?.companions === 'manual' ? (sheet.party ?? []).reduce((sum, member) => sum + perksOwed(member, book) + bigsOwed(member, book), 0) : 0) + [sheet, ...(sheet.party ?? [])].filter(who => formReady(who, book, sheet.things)).length

/** The skills of one of the party with how far each has come, for a card that counts growth. */
export function skillRows(el, who, book) {
  return (who.skills ?? []).map(name => {
    const uses = who.mastery?.[name] ?? 0
    const stage = stageOf(uses)
    const next = nextStageAt(uses)
    return el('div', { class: 'bag-row growth-skill' }, [
      el('span', { class: 'bag-name', text: name }),
      stage > 1 ? el('b', { class: 'growth-stage', text: stageWord(stage) }) : null,
      el('span', { class: 'hint', text: stage >= MAX_STAGE ? t`用过 ${uses} 次，已经练到头了` : t`用过 ${uses} 次，再用 ${next - uses} 次升到${stageWord(stage + 1)}` }),
    ])
  })
}

/**
 * 天赋 of one of the party: those had, and the three to choose from when one is owed.
 * @param options - { el, who (the sheet, or one of its party), book, seed (the chat), word (what the card calls them), act (op), name (a companion's, for the op) }
 */
export function perkSection({ el, who, book, seed, word, act, name = '' }) {
  if (!perksOn(book)) return []
  const owed = perksOwed(who, book)
  const had = (who.perks ?? []).map(key => perkShown(book, key)).filter(Boolean)
  const offer = perkOffer(who, book, seed).map(perk => perkShown(book, perk))
  const tag = name ? { who: name } : {}
  const level = who.level ?? 1
  const bigs = bigsOwed(who, book)
  const every = perkEveryOf(book)
  const card = perk => el('button', { type: 'button', class: 'growth-card', onclick: () => act({ op: 'perk', key: perk.key, ...tag }) }, [
    el('b', { text: perk.name }),
    perk.branch ? el('span', { class: 'growth-branch', text: perk.branch }) : null,
    el('span', { class: 'hint', text: perk.note }),
    el('span', { class: 'growth-effects', text: perk.effects }),
  ])
  return [
    el('h3', { text: owed ? t`${word}（有 ${owed} 个可选）` : word }),
    ...had.map(perk => el('div', { class: 'bag-thing growth-perk' }, [el('div', { class: 'bag-main' }, [el('span', { class: 'bag-name', text: perk.big ? t`${perk.name}（大${word}）` : perk.name }), el('span', { class: 'hint', text: perk.effects })])])),
    !had.length && !owed ? el('p', { class: 'hint', text: t`每 ${every} 级可以选一个，下一个在 ${(Math.floor(level / every) + 1) * every} 级。` }) : null,
    owed ? el('div', { class: 'growth-offer' }, [
      ...offer.map(card),
      el('button', { type: 'button', class: 'btn small growth-skip', text: t`都不要，换成 ${SKIP_POINTS} 点属性`, onclick: () => act({ op: 'perk', skip: true, ...tag }) }),
    ]) : null,
    // 大天赋: one for each 突破.
    bigs ? el('h3', { text: t`大${word}（突破得来，有 ${bigs} 个可选）` }) : null,
    bigs ? el('div', { class: 'growth-offer big' }, [
      ...perkOffer(who, book, seed, true).map(perk => perkShown(book, perk)).map(card),
      el('button', { type: 'button', class: 'btn small growth-skip', text: t`都不要，换成 ${SKIP_POINTS} 点属性`, onclick: () => act({ op: 'perk', skip: true, big: true, ...tag }) }),
    ]) : null,
  ]
}

/** What a level has brought by itself, in a line; nothing at the first level. */
export function levelLine(who, book) {
  if (!growsOn(book) || (who.level ?? 1) < 2) return ''
  // Named as nobody, so that no chain of 形态 is theirs: this is what the level alone brings.
  const bonus = bonusOf({ level: who.level, name: '\u0000' }, book)
  const words = wordsOf(book)
  return [t`等级带来：${words.life || t`生命`}上限 +${percent(bonus.life)}%`, bonus.energy ? t`${words.energy || t`气力`}上限 +${bonus.energy}` : ''].filter(Boolean).join(t`，`)
}

// 形态: what a form asks for, in the page's words.
const needText = (need, book, marked = true) => (need.kind === 'level' ? t`${need.need} 级` : need.kind === 'item' ? t`有「${need.need}」` : t`羁绊${[t`一档`, t`二档`, t`三档`][need.need - 1]}`) + (need.met && marked ? ' ✓' : '')
/** The same for a page that marks it itself. */
export const needWord = (need, book) => needText(need, book, false)
/** What a skill does, in a few words: by its kind on this card. */
export const kindText = (book, name) => ({ strike: t`重击一个敌人`, sweep: t`打所有敌人`, flurry: t`连打两下`, poison: t`打一下，让敌人中毒`, stun: t`打一下，可能打晕`, heal: t`回复生命`, boost: t`自己变强`, finish: t`残血的敌人伤害加倍`, mend: t`全队回复`, ward: t`一层护盾`, rally: t`全队变强`, taunt: t`引敌人来打自己` })[skillKindIn(book, name)] ?? ''
/** A form in a few words: 炎角兽（成熟期）. */
export const formName = form => (form ? (form.stage ? t`${form.name}（${form.stage}）` : form.name) : '')
/** What a form gives, in a line: 伤害 +10%，会「超级火焰」. */
export const formText = (form, book) => [...(form?.effects ?? []).map(effect => effectText(effect, wordsOf(book))), ...Object.keys(form?.skills ?? {}).map(name => t`会「${name}」`)].join(t`，`)

/**
 * 形态 of one of the party: the chain with where they are in it, what the next asks for, and the way to it when all
 * of that is met. Nothing for one with no chain.
 * @param sheet - the player's sheet: a thing a form asks for is looked for in their bag.
 */
/**
 * The chain as a row of pictures, where any of its forms has one (`face(name)` → an address or ''): the one they are
 * in marked, those not come to yet as shadows. Null when none has a picture: the chain is then a row of names.
 */
function formPictures(el, chain, at, face) {
  const pictures = face ? chain.map(form => face(form.name)) : []
  if (!pictures.some(Boolean)) return null
  return el('div', { class: 'status-chain-row growth-chain' }, chain.flatMap((form, i) => {
    const tile = el('div', { class: `status-form${i === at ? ' now' : i < at ? ' past' : ' later'}`, title: formName(form) }, [
      el('span', { class: 'status-form-pic' }, pictures[i] ? el('img', { src: pictures[i], alt: '', draggable: 'false', loading: 'lazy' }) : el('i', { text: form.name.slice(0, 1) })),
      form.stage ? el('span', { class: 'status-form-stage', text: form.stage }) : null,
      el('span', { class: 'status-form-name', text: form.name }),
    ])
    return i ? [el('span', { class: `status-chain-arrow${i <= at ? ' done' : ''}`, 'aria-hidden': 'true', text: '›' }), tile] : [tile]
  }))
}

/** The form one can come to now, or null. */
export const readyOf = (who, book, things) => formReady(who, book, things)

export function formSection({ el, who, sheet, book, act, name = '', face = null }) {
  const chain = formsOf(who, book)
  if (!chain.length) return []
  const at = formAt(who, book)
  // The one come to next for good, and the one for a single fight: the same form, or two (超进化 between two stages).
  const next = nextForm(who, book)
  const burst = formForFight(who, book)
  const ready = formReady(who, book, sheet.things)
  const needs = next ? formNeeds(next, who, sheet.things) : []
  const cost = t`战斗里可以花 ${Math.round(SHIFT_COST * 100)}% ${wordsOf(book).energy || t`气力`}临时变成它` + (burst?.drain ? t`，之后每回合还要耗一些，耗尽就变回来` : '')
  const form = book.words?.form || t`形态`
  const evolve = book.words?.evolve || t`进化`
  return [
    el('h3', { text: form }),
    formPictures(el, chain, at, face) ?? el('div', { class: 'growth-forms' }, chain.map((item, i) => el('span', { class: `growth-form${i === at ? ' on' : i < at && !fightOnly(item) ? ' done' : ''}${fightOnly(item) ? ' side' : ''}`, text: formName(item) }))),
    formText(chain[at], book) ? el('p', { class: 'hint', text: t`现在：${formText(chain[at], book)}` }) : null,
    next ? el('div', { class: 'bag-row growth-next-form' }, [
      el('span', { class: 'hint', text: [t`下一个：${formName(next)}`, formText(next, book), needs.length ? t`需要 ${needs.map(need => needText(need, book)).join(t`、`)}` : t`要等剧情里发生`, burst === next ? cost : ''].filter(Boolean).join(t`；`) }),
      ready ? el('button', { type: 'button', class: 'btn small primary', text: t`${evolve}成${ready.name}`, onclick: () => act({ op: 'form', label: ready.name, ...(name ? { who: name } : {}) }) }) : null,
    ]) : null,
    burst && burst !== next ? el('p', { class: 'hint', text: [formName(burst), formText(burst, book), cost].filter(Boolean).join(t`；`) }) : null,
    !next && !burst ? el('p', { class: 'hint', text: t`已经是最后一个${form}。` }) : null,
  ]
}

// 装备: where a thing is worn and how rare it is, in the page's words.
// A card may call them its own way (book.words: 兵刃、法器、蓝装): `book` is whose words to use, none for the app's.
export const SLOT_WORDS = (book = null) => ({ weapon: book?.words?.weapon || t`武器`, armour: book?.words?.armour || t`防具`, charm: book?.words?.trinket || t`饰品` })
export const RARITY_WORDS = (book = null) => ({ common: book?.words?.common || t`普通`, fine: book?.words?.fine || t`精良`, rare: book?.words?.rare || t`稀有`, epic: book?.words?.epic || t`传说` })

/** What a piece of gear is, in a line: 武器 · 精良：伤害 +7%. '' for a thing that is not gear on this card. */
export function gearText(book, name) {
  const item = gearOf(book, name)
  return item ? `${SLOT_WORDS(book)[item.slot]} · ${RARITY_WORDS(book)[item.rarity]}${t`：`}${item.effects.map(effect => effectText(effect, wordsOf(book))).join(t`；`)}` : ''
}

/**
 * 装备 of one of the party: a row to each slot, with what there is in the bag to put there. Nothing on a card that
 * does not count growth, or with no gear about.
 * @param sheet - the player's sheet: the bag is theirs, and what the others have on is not to be had twice.
 */
export function gearSection({ el, who, sheet, book, act, name = '' }) {
  if (!growsOn(book)) return []
  const owned = sheet.things.filter(thing => gearOf(book, thing.name))
  if (!owned.length && !Object.keys(who.gear ?? {}).length) return []
  const tag = name ? { who: name } : {}
  const worn = thing => [sheet, ...(sheet.party ?? [])].filter(one => one !== who).reduce((sum, one) => sum + Object.values(one.gear ?? {}).filter(item => item === thing).length, 0)
  return [
    el('h3', { text: t`装备` }),
    ...GEAR_SLOTS.map(slot => {
      const now = who.gear?.[slot] ?? ''
      const fits = owned.filter(thing => gearOf(book, thing.name).slot === slot && (thing.name === now || thing.count > worn(thing.name)))
      const select = el('select', { 'aria-label': name ? t`${name}的${SLOT_WORDS(book)[slot]}` : SLOT_WORDS(book)[slot] }, [['', t`空着`], ...fits.map(thing => [thing.name, thing.name])].map(([value, text]) => el('option', { value, text, selected: value === now })))
      select.addEventListener('change', () => act(select.value ? { op: 'equip', name: select.value, ...tag } : { op: 'unequip', slot, ...tag }))
      return el('div', { class: 'bag-row growth-gear' }, [
        el('span', { class: 'bag-name', text: SLOT_WORDS(book)[slot] }),
        select,
        now ? el('span', { class: `hint rarity-${gearOf(book, now)?.rarity ?? 'common'}`, text: gearText(book, now).split(t`：`).slice(1).join(t`：`) }) : null,
      ])
    }),
  ]
}

/** 羁绊 of a companion, in a line; '' on a card that does not count growth. */
export function bondLine(member, book) {
  if (!growsOn(book)) return ''
  const next = nextBondAt(member)
  const fought = member.bond ?? 0
  const step = [t`还没有`, t`一档（减伤）`, t`二档（减伤、伤害）`, t`三档（减伤、伤害、替你挡下）`][bondOf(member)]
  return next ? t`羁绊：${step}，并肩打赢过 ${fought} 场，到 ${next} 场升一档` : t`羁绊：${step}，并肩打赢过 ${fought} 场，已经到顶`
}

/** What growth changed between two replies, as the HUD's notes: a skill come further, a 天赋 a companion took. */
export function growthNotes(before, after, book) {
  if (!growsOn(book)) return []
  const notes = []
  const staged = (was, now, who) => {
    for (const [name, uses] of Object.entries(now?.mastery ?? {})) {
      if (stageOf(uses) > stageOf(was?.mastery?.[name])) notes.push({ kind: 'level', icon: '✨', text: who ? t`${who}的${name}升到${stageWord(stageOf(uses))}` : t`${name}升到${stageWord(stageOf(uses))}` })
    }
  }
  staged(before, after, '')
  // 形态: one of the party in another form than before.
  const formed = (was, now, who) => {
    if (!was || !formsOf(now, book).length || formOf(was, book)?.name === formOf(now, book)?.name) return
    const back = formAt(now, book) < formAt(was, book)
    notes.push({ kind: 'level', icon: '🧬', text: back ? t`${who || t`你`}变回了${formOf(now, book).name}` : t`${who || t`你`}${book.words?.evolve || t`进化`}成了${formOf(now, book).name}` + worthChange(was, now, book) })
  }
  formed(before, after, '')
  // 历练: a mark more on an attribute, or the point that enough of them came to.
  for (const [id, held] of Object.entries(after?.practice ?? {})) {
    const was = before?.practice?.[id] ?? 0
    if (held === was) continue
    const rose = (after.attributes?.[id] ?? 0) > (before?.attributes?.[id] ?? 0)
    notes.push({ kind: 'level', icon: rose ? '💪' : '📖', text: rose ? t`${attributeWord(book, id)}在历练中 +1` : t`${attributeWord(book, id)}历练 ${held}/${practiceNeeds(after.attributes[id])}` })
  }
  const old = new Map((before?.party ?? []).map(member => [member.name, member]))
  for (const member of after?.party ?? []) {
    const was = old.get(member.name)
    if (!was) continue
    staged(was, member, member.name)
    formed(was, member, member.name)
    if (bondOf(member) > bondOf(was)) notes.push({ kind: 'level', icon: '🤝', text: t`和${member.name}的羁绊升到${[t`一档`, t`二档`, t`三档`][bondOf(member) - 1]}` })
    for (const key of member.perks ?? []) if (!(was.perks ?? []).includes(key)) notes.push({ kind: 'level', icon: '🌟', text: t`${member.name}：${perkShown(book, key)?.name ?? key}` })
  }
  return notes
}

/**
 * Under the reply that brought a level: what it changed, side by side, and the way to what is left to choose.
 * Null when the reply brought none, or the card does not count growth.
 * @param open - () opens the 游戏菜单 on the player's own page.
 */
export function levelUpCard(el, before, after, book, open) {
  if (!growsOn(book) || !after || (after.level ?? 1) <= (before?.level ?? 1)) return null
  const words = wordsOf(book)
  const rows = []
  const moved = (label, was, now) => { if (was !== now) rows.push([label, `${was} → ${now}`]) }
  moved(t`${words.life || t`生命`}上限`, before?.maxLife ?? after.maxLife, after.maxLife)
  moved(t`${words.energy || t`气力`}上限`, before?.maxEnergy ?? after.maxEnergy, after.maxEnergy)
  const points = (after.points ?? 0) - (before?.points ?? 0)
  if (points > 0) rows.push([t`属性点`, `+${points}`])
  const owed = perksOwed(after, book)
  const todo = [after.points ? t`加点` : '', owed ? t`选${words.perk || t`天赋`}` : '', bigsOwed(after, book) ? t`选大${words.perk || t`天赋`}` : ''].filter(Boolean).join(t`、`)
  // 突破: a rank crossed is more than a level.
  const rank = book.ranks?.length ? rankAt(book.ranks, after.level) : ''
  const broke = Boolean(rank) && rank !== rankAt(book.ranks, before?.level ?? 1)
  if (broke) rows.unshift([t`突破`, [rankRestores(book) ? t`${words.life || t`生命`}和${words.energy || t`气力`}回满` : '', rankGives(book).skills ? t`${words.skill || t`技能`}各升一阶` : ''].filter(Boolean).join(t`，`)])
  return el('div', { class: `level-up${broke ? ' breakthrough' : ''}` }, [
    el('b', { class: 'level-up-title', text: broke ? t`突破 · ${rank}` : t`升到 ${after.level} 级` }),
    el('div', { class: 'level-up-rows' }, rows.map(([label, text]) => el('span', {}, [el('span', { class: 'hint', text: label }), ' ', el('b', { text })]))),
    todo ? el('button', { type: 'button', class: 'btn small primary', text: todo, onclick: open }) : null,
  ])
}

// ─── 游戏菜单的「成长」页 ─────────────────────────────────────────────────
/** Where a rank begins, as a level. */
const rankStarts = (ranks, at) => at * STEPS_PER_RANK + 1

/**
 * 里程碑: what this card's growth brings and when, as its settings have it now: [{ when, what, state }], `state`
 * 'done' for one reached, 'next' for the nearest one ahead, '' for what holds all along or lies further off.
 */
export function milestones(sheet, book) {
  if (!growsOn(book)) return []
  const words = wordsOf(book)
  const life = words.life || t`生命`
  const energy = words.energy || t`气力`
  const perk = words.perk || t`天赋`
  const level = sheet.level ?? 1
  const rows = []
  rows.push({ when: t`每升一级`, what: [t`${life}上限 +${percent(LEVEL_GAINS.life)}%`, levelPointsOf(book) ? t`属性点 +${levelPointsOf(book)}` : ''].filter(Boolean).join(t`，`), state: '' })
  rows.push({ when: t`每 ${LEVEL_GAINS.energyEvery} 级`, what: t`${energy}上限 +1`, state: '' })
  const every = perkEveryOf(book)
  const gives = rankGives(book)
  const each = [perksOn(book) ? t`选一个${perk}` : '', everyGives(book).points ? t`属性点 +${everyGives(book).points}` : '', everyGives(book).restore ? t`${life}和${energy}回满` : ''].filter(Boolean)
  if (each.length) rows.push({ when: t`每 ${every} 级`, what: t`${each.join(t`，`)}（下一次在 ${(Math.floor(level / every) + 1) * every} 级）`, state: '' })
  const ranks = book.ranks ?? []
  let ahead = true
  for (let at = 1; at < ranks.length; at++) {
    const starts = rankStarts(ranks, at)
    const done = level >= starts
    rows.push({ when: t`${starts} 级`, what: [t`突破到${ranks[at]}`, rankRestores(book) ? t`${life}和${energy}回满` : '', gives.big ? t`选一个大${perk}` : '', gives.points ? t`属性点 +${gives.points}` : '', gives.skills ? t`${words.skill || t`技能`}各升一阶` : ''].filter(Boolean).join(t`，`), state: done ? 'done' : ahead ? 'next' : '' })
    if (!done) ahead = false
  }
  rows.push({ when: t`技能用到 ${STAGE_USES.join(t`、`)} 次`, what: t`各升一阶，威力提高；三阶起更省${energy}`, state: '' })
  rows.push({ when: t`检定成功（难度 12 以上）`, what: t`那一项属性记历练，攒够了 +1`, state: '' })
  if ((sheet.party ?? []).length || Object.keys(book.companions ?? {}).length) rows.push({ when: t`和同伴并肩打赢 ${BOND_AT.join(t`、`)} 场`, what: bondPointsOf(book) ? t`羁绊各升一档：减伤、伤害、替你挡下；每升一档那个同伴属性点 +${bondPointsOf(book)}` : t`羁绊各升一档：减伤、伤害、替你挡下`, state: '' })
  // 形态: each form still ahead of the player and of those with them, the nearest of each chain marked.
  for (const who of [sheet, ...(sheet.party ?? [])]) {
    const chain = formsOf(who, book)
    const now = formAt(who, book)
    chain.forEach((form, at) => {
      if (!at) return
      const needs = formNeeds(form, who, sheet.things)
      const whose = who === sheet ? '' : t`${who.name}：`
      rows.push({ when: `${whose}${needs.length ? needs.map(need => needText(need, book, false)).join(t`、`) : form.temp ? t`战斗里临时` : t`剧情里发生`}`, what: [t`${words.evolve || t`进化`}成${formName(form)}`, formText(form, book)].filter(Boolean).join(t`，`), state: fightOnly(form) ? '' : at <= now ? 'done' : form === nextForm(who, book) ? 'next' : '' })
    })
  }
  return rows
}

/**
 * 成长记录: what growing a story's replies brought, oldest first: [{ turn, lines }]. Read from the sheet each reply
 * left (nothing is kept for it), so a story gone back over or branched has the record of where it stands.
 * @param path - the story's nodes in order ({ role, game }).
 */
export function growthLog(path, book) {
  if (!growsOn(book)) return []
  const out = []
  // The first reply is measured against how the story starts.
  let before = startSheet(book)
  let turn = 0
  for (const node of path ?? []) {
    if (node.role === 'user') turn += 1
    const after = node.game
    if (!after) continue
    const lines = []
    if (before) {
      if ((after.level ?? 1) > (before.level ?? 1)) {
        const rank = book.ranks?.length ? rankAt(book.ranks, after.level) : ''
        lines.push(rank && rank !== rankAt(book.ranks, before.level ?? 1) ? t`突破到${rank}（${after.level} 级）` : t`升到 ${after.level} 级`)
      }
      for (const key of after.perks ?? []) if (!(before.perks ?? []).includes(key)) lines.push(t`${wordsOf(book).perk || t`天赋`}：${perkShown(book, key)?.name ?? key}`)
      for (const [slot, name] of Object.entries(after.gear ?? {})) if (before.gear?.[slot] !== name) lines.push(t`装上 ${name}`)
      for (const key of after.perks ?? []) if (!(before.perks ?? []).includes(key) && perkOf(book, key)?.skill) lines.push(t`学会「${perkOf(book, key).skill}」`)
      // A mark of 历练 short of a point is not worth a line here: the page above has where each stands.
      lines.push(...growthNotes(before, after, book).filter(note => note.icon !== '📖').map(note => note.text))
    }
    if (lines.length) out.push({ turn, lines })
    before = after
  }
  return out
}

/**
 * The 游戏菜单's 成长 page: what the player is built of, what is still ahead, and how they came by it. Nothing is changed
 * here: `go(tab)` leads to the page where points are spent and 天赋 chosen.
 */
export function growthPage({ el, sheet, book, path, go }) {
  const words = wordsOf(book)
  const perk = words.perk || t`天赋`
  const had = (sheet.perks ?? []).map(key => perkShown(book, key)).filter(Boolean)
  const worn = Object.entries(sheet.gear ?? {}).filter(([, name]) => gearOf(book, name))
  const todo = [sheet.points ? t`有 ${sheet.points} 点属性可加` : '', perksOwed(sheet, book) ? t`有${perk}可选` : '', bigsOwed(sheet, book) ? t`有大${perk}可选` : '', formReady(sheet, book, sheet.things) ? t`可以${words.evolve || t`进化`}了` : ''].filter(Boolean)
  const rank = book.ranks?.length ? rankAt(book.ranks, sheet.level ?? 1) : ''
  const practice = practiceRows(sheet, book)
  const log = growthLog(path, book)
  const line = (label, text) => el('div', { class: 'bag-row growth-line' }, [el('span', { class: 'bag-name', text: label }), el('span', { class: 'hint', text })])
  return [
    el('h3', { text: t`现在` }),
    line(t`等级`, [rank ? t`${rank} · ${sheet.level ?? 1} 级` : t`${sheet.level ?? 1} 级`, levelLine(sheet, book)].filter(Boolean).join(t`；`)),
    book.growth?.power ? line(t`战力`, String(powerOf(sheet, book))) : null,
    perksOn(book) ? line(perk, had.length ? had.map(item => item.name).join(t`、`) : t`还没有`) : null,
    formOf(sheet, book) ? line(words.form || t`形态`, [formName(formOf(sheet, book)), formText(formOf(sheet, book), book)].filter(Boolean).join(t`：`)) : null,
    worn.length ? line(t`装备`, worn.map(([, name]) => name).join(t`、`)) : null,
    (sheet.skills ?? []).length ? line(words.skill || t`技能`, sheet.skills.map(name => skillShown(name, sheet.mastery?.[name])).join(t`、`)) : null,
    practice.length ? line(t`历练`, practice.map(item => `${item.name} ${item.held}/${item.needs}`).join(t`、`)) : null,
    ...(sheet.party ?? []).map(member => line(member.name, [t`${member.level ?? 1} 级`, formOf(member, book) ? formName(formOf(member, book)) : '', bondLine(member, book)].filter(Boolean).join(t`；`))),
    todo.length ? el('div', { class: 'bag-row' }, [el('span', { class: 'hint', text: todo.join(t`，`) }), el('button', { type: 'button', class: 'btn small primary', text: t`去角色页`, onclick: () => go('self') })]) : null,
    el('h3', { text: t`里程碑` }),
    ...milestones(sheet, book).map(row => el('div', { class: `bag-row growth-mile${row.state ? ` ${row.state}` : ''}` }, [el('span', { class: 'growth-when', text: row.state === 'done' ? `✓ ${row.when}` : row.when }), el('span', { class: 'hint', text: row.what })])),
    el('h3', { text: t`成长记录` }),
    log.length ? null : el('p', { class: 'hint', text: t`这条故事线上还没有升级、突破或学到什么。` }),
    ...log.slice().reverse().map(entry => el('div', { class: 'bag-row growth-log' }, [el('span', { class: 'growth-when', text: t`第 ${entry.turn} 轮` }), el('span', { class: 'hint', text: entry.lines.join(t`；`) })])),
  ]
}

/**
 * The choices that make a thing gear: where it is worn, how rare, and up to two effects with their sizes. For the
 * 游戏菜单's 物品 page and the rule window's list alike. `put(change)` keeps what was chosen ({ slot }, { rarity }, { effects }).
 */
export function gearPickers({ el, name, set, book, put }) {
  return [
    pick(el, t`${name}装在哪`, set.slot, Object.entries(SLOT_WORDS(book)), slot => put({ slot })),
    pick(el, t`${name}的稀有度`, set.rarity, RARITIES.map(rarity => [rarity, t`${RARITY_WORDS(book)[rarity]}（${GEAR_BUDGET[rarity]} 点）`]), rarity => put({ rarity })),
    ...effectPickers({ el, name, effects: set.effects, words: wordsOf(book), put: effects => put({ effects }) }),
  ]
}

function pick(el, label, value, options, change) {
  const select = el('select', { 'aria-label': label }, options.map(([key, text]) => el('option', { value: key, text, selected: key === value })))
  select.addEventListener('change', () => change(select.value))
  return select
}

/** Up to two effects with their sizes, for a thing worn or a 形态. `put(effects)` keeps what was chosen; `words`: the card's. */
export function effectPickers({ el, name, effects, put, words = {} }) {
  // An effect that asks for an attribute is not offered here: 天赋 have those.
  const ids = EFFECT_IDS.filter(id => id !== 'check')
  const effect = at => {
    const now = effects[at]
    const what = pick(el, t`${name}的效果 ${at + 1}`, now?.id ?? '', [['', t`无`], ...ids.filter(id => id === now?.id || !effects.some(other => other.id === id)).map(id => [id, EFFECT_NAMES(words)[id]])], id => {
      const next = effects.map((item, i) => (i === at ? null : item)).filter(Boolean)
      put(id ? [...next.slice(0, at), { id, ...(EFFECTS[id].sizes ? { size: now?.size ?? 'small' } : {}) }, ...next.slice(at)] : next)
    })
    if (!now?.size) return [what]
    return [what, pick(el, t`${name}的效果 ${at + 1} 的幅度`, now.size, Object.entries(SIZE_WORDS()), size => put(effects.map((item, i) => (i === at ? { ...item, size } : item))))]
  }
  return Array.from({ length: Math.min(2, effects.length + 1) }, (_, at) => effect(at)).flat()
}

export { MAX_FORMS, PLAYER_FORMS, formBudget }
