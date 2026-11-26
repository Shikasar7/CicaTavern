// 养成 on the page (shared/game/raise.js): one creature's card in the 队伍 window, what is shown when one is caught and
// when one evolves, and how much more it is worth than before.
import { t } from '/i18n.js'
import { ATTRIBUTES } from '/shared/game/sheet.js'
import { RAISED_MOST, formAt, formOf, formsOf } from '/shared/game/growth.js'
import { modifierOf } from '/shared/game/dice.js'
import { NATURE_DOWN, NATURE_UP, TALENTS, natureOf, raisedPower, raisesOn, rankOf, speciesOf, talentOf } from '/shared/game/raise.js'

export { raisedPower, raisesOn }

const NATURE_WORDS = () => ({ 'body-grace': t`沉稳`, 'body-mind': t`莽撞`, 'body-charm': t`孤僻`, 'grace-body': t`轻灵`, 'grace-mind': t`急躁`, 'grace-charm': t`机警`, 'mind-body': t`聪慧`, 'mind-grace': t`沉静`, 'mind-charm': t`冷傲`, 'charm-body': t`亲人`, 'charm-grace': t`憨厚`, 'charm-mind': t`活泼` })
const TALENT_WORDS = () => ({ plain: t`普通`, good: t`良好`, fine: t`优秀`, rare: t`卓越`, peerless: t`绝世` })
export const natureWord = id => (natureOf(id) ? NATURE_WORDS()[id] : '')
export const talentWord = id => (talentOf(id) ? TALENT_WORDS()[id] : '')
/** How high a 资质 stands, for its look: 0 to 4. */
const talentStep = id => Math.max(0, TALENTS.findIndex(item => item.id === id))

const attributeWord = (book, id) => book.words?.[id] || ATTRIBUTES.find(item => item.id === id).name
/** What a 性格 does, in a line: 体魄 +2，灵巧 −1. */
const natureText = (id, book) => { const own = natureOf(id); return own ? `${attributeWord(book, own.up)} +${NATURE_UP}${t`，`}${attributeWord(book, own.down)} −${NATURE_DOWN}` : '' }

/** The rank one stands at, as the card says it: that of its form, or of its kind. */
export const stageOfMember = (member, book) => formOf(member, book)?.stage ?? book.foes?.[member.name]?.rank ?? ''
/** How high that rank is, 0 the first: for its look. */
const stageStep = (member, book) => { const at = rankOf(book, member.name, formsOf(member, book).length ? formAt(member, book) : 0); return at === null ? 0 : Math.floor(at / 4) }
/** What one is called now: its form's name, where it has come to one. */
export const shownName = (member, book) => (formAt(member, book) > 0 ? formOf(member, book)?.name : null) ?? member.name

const picture = (el, face, name) => {
  const src = face?.(name) ?? ''
  return el('span', { class: 'raise-pic' }, [src ? el('img', { src, alt: '', draggable: 'false' }) : el('i', { text: name.slice(0, 1) })])
}
const faceOf = (face, member, book) => name => face?.(name) || face?.(member.name) || ''

export const badges = (el, member, book) => [
  stageOfMember(member, book) ? el('b', { class: `raise-stage s${Math.min(4, stageStep(member, book))}`, text: stageOfMember(member, book) }) : null,
  (formAt(member, book) > 0 ? formOf(member, book)?.type : null) ?? member.type ?? book.companions?.[member.name]?.type ? el('i', { class: 'raise-type', text: (formAt(member, book) > 0 ? formOf(member, book)?.type : null) ?? member.type ?? book.companions?.[member.name]?.type }) : null,
  member.talent ? el('i', { class: `raise-talent q${talentStep(member.talent)}`, title: t`资质：天生比同类多出的属性`, text: t`资质 ${talentWord(member.talent)}` }) : null,
  member.nature ? el('i', { class: 'raise-nature', title: natureText(member.nature, book), text: t`${natureWord(member.nature)}的性格` }) : null,
]

/** The four attributes as bars: what its kind is made of, and what it has grown to over that. `was`: those before, to show what rose. */
export function statBars(el, member, book, { was = null, add = null } = {}) {
  const base = speciesOf(book, member.name, formsOf(member, book).length ? formAt(member, book) : 0)
  return el('div', { class: 'raise-stats' }, ATTRIBUTES.map(({ id }) => {
    const value = member.attributes[id]
    const before = was?.attributes[id]
    const nature = natureOf(member.nature)
    const marked = nature?.up === id ? ' up' : nature?.down === id ? ' down' : ''
    return el('div', { class: `raise-stat${marked}`, title: t`种族值 ${base[id]}，修正 ${modifierOf(value) < 0 ? '−' : '+'}${Math.abs(modifierOf(value))}` }, [
      el('span', { class: 'raise-stat-name', text: attributeWord(book, id) }),
      el('span', { class: 'raise-bar' }, [
        el('i', { style: `width: ${Math.min(100, (value / RAISED_MOST) * 100)}%` }),
        el('u', { style: `width: ${Math.min(100, (Math.min(before ?? base[id], value) / RAISED_MOST) * 100)}%` }),
      ]),
      el('b', { text: String(value) }),
      before !== undefined && value !== before ? el('em', { text: value > before ? `+${value - before}` : `−${before - value}` }) : null,
      add && member.points ? el('button', { type: 'button', class: 'btn small', text: '+', 'aria-label': t`给${member.name}加到${attributeWord(book, id)}`, onclick: () => add(id) }) : null,
    ])
  }))
}

/** What one caught turned out to be, under the card that says it was. */
export function caughtPanel(el, { member, book, boxed = false }) {
  return el('div', { class: `raise-caught q${talentStep(member.talent)}` }, [
    el('div', { class: 'raise-badges' }, [el('b', { class: 'raise-level', text: `Lv.${member.level}` }), ...badges(el, member, book), el('span', { class: 'raise-power' }, [t`战力`, ' ', el('b', { text: String(raisedPower(member, book)) })])]),
    statBars(el, member, book),
    el('p', { class: 'raise-skills', text: member.skills.join(t`、`) }),
    boxed ? el('p', { class: 'hint', text: t`队伍满了，先寄养起来，在游戏菜单的「队伍」里接回。` }) : null,
  ])
}

/**
 * 进化: what one was, then what it is, on the whole screen; a click or a key sees it off. Held still for those who
 * would rather nothing moved.
 */
export function showEvolved(el, { before, after, book, face, word, sound = null }) {
  const was = shownName(before, book)
  const now = shownName(after, book)
  const learnt = after.skills.filter(name => !before.skills.includes(name))
  const power = [raisedPower(before, book), raisedPower(after, book)]
  const dialog = el('dialog', { class: `dialog raise-evolve s${Math.min(4, stageStep(after, book))}`, 'aria-label': t`${was}${word}成了${now}` }, [
    el('div', { class: 'raise-evolve-stage', 'aria-hidden': 'true' }, [
      el('span', { class: 'raise-evolve-ring' }),
      el('div', { class: 'raise-evolve-was' }, picture(el, faceOf(face, before, book), was)),
      el('div', { class: 'raise-evolve-now' }, picture(el, faceOf(face, after, book), now)),
    ]),
    el('p', { class: 'raise-evolve-line', text: t`${was}${word}成了` }),
    el('h2', { text: now }),
    el('div', { class: 'raise-badges' }, badges(el, after, book)),
    el('div', { class: 'raise-evolve-power' }, [t`战力`, ' ', el('span', { text: String(power[0]) }), ' → ', el('b', { text: String(power[1]) })]),
    statBars(el, after, book, { was: before }),
    learnt.length ? el('p', { class: 'raise-skills', text: t`学会：${learnt.join(t`、`)}` }) : null,
    el('button', { type: 'button', class: 'btn primary', text: t`继续`, onclick: () => dialog.close() }),
  ])
  dialog.addEventListener('close', () => dialog.remove())
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close() })
  document.body.append(dialog)
  dialog.showModal()
  sound?.play?.('heal')
  return dialog
}

/** What a reply made of one of the party, in a note's words: ⭐ 升到 7 级（战力 312 → 380）. */
export function worthChange(was, now, book) {
  if (!raisesOn(book) || !now?.raised || !was) return ''
  const [before, after] = [raisedPower(was, book), raisedPower(now, book)]
  return before === after ? '' : t`（战力 ${before} → ${after}）`
}

/** 性格 and 资质 of one, in a few words, for a note: 良好 · 沉稳. */
export const birthWords = member => [member.talent ? t`资质 ${talentWord(member.talent)}` : '', member.nature ? t`${natureWord(member.nature)}的性格` : ''].filter(Boolean).join(' · ')
