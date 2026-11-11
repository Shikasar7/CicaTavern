// 开场页: what a card shows above its opening before the story starts (web/shared/cover.js says what it holds). The
// name comes in letter by letter, the lines one after another, and each of the card's openings is a door to pick
// before the first reply is asked for. Pictures and colors are found by the page (web/card-art.js, the bar's three colors).
import { t } from '/i18n.js'
import { paletteColors } from '/shared/status.js'
import { openingStart } from '/shared/cover.js'
import { effectLayer, paint, wear } from '/status.js'

const LETTERS_MAX = 18

/**
 * @param options - { name, by (who made the card), cover (cleaned), palette (the bar's three colors, or null), skin
 *   (the bar's 定制外观, { css }: its rules for the cover dress it too), art
 *   ({ backdrop, soft, portrait, zoom } or null), openings (the card's opening texts), picked (which the chat started
 *   with, -1 unknown), canPick, onPick(index) → a promise, always (a door even for a card's only opening: where the
 *   cover stands in the opening's place, in SillyTavern, it is the way in), foldable (a button folds it to one line:
 *   the name and the line under it), onFold(folded): the button was used }
 * @returns { node, mark(index): show which opening is the chat's, fold(folded): fold it or open it }
 */
export function coverPage(el, { name, by = '', cover, palette = null, skin = null, art = null, openings = [], picked = -1, canPick = true, onPick, always = false, foldable = false, onFold = null }) {
  const letters = [...String(name ?? '')]
  const title = el('h2', { class: 'cover-title', 'aria-label': name }, letters.length <= LETTERS_MAX
    ? letters.map((letter, i) => el('span', { style: `--i:${i}`, 'aria-hidden': 'true', text: letter === ' ' ? ' ' : letter }))
    : [el('span', { style: '--i:0', text: name })])
  const doors = openings.length > (always ? 0 : 1)
    ? openings.map((text, index) => {
        const named = cover.openings?.[index]
        const door = el('button', { type: 'button', class: 'cover-door', disabled: !canPick, title: canPick ? t`从这个开场开始` : t`故事已经开始，开场不能再换`, onclick: async () => {
          if (door.classList.contains('picked') || box.classList.contains('switching')) return
          box.classList.add('switching')
          door.classList.add('opening')
          try {
            await onPick(index)
          } finally {
            box.classList.remove('switching')
            door.classList.remove('opening')
          }
        } }, [
          el('span', { class: 'cover-door-no', text: String(index + 1).padStart(2, '0') }),
          el('span', { class: 'cover-door-title', text: named?.title || t`开场 ${index + 1}` }),
          el('span', { class: 'cover-door-brief', text: named?.brief || openingStart(text) }),
        ])
        return door
      })
    : []
  const mark = index => doors.forEach((door, i) => {
    door.classList.toggle('picked', i === index)
    door.setAttribute('aria-pressed', String(i === index))
  })
  mark(picked)
  // With no picture, the name's first letter stands large and faint where one would be.
  const box = el('section', { class: `cover${art?.backdrop ? '' : ' plain'}${art?.portrait ? ' has-figure' : ''}`, 'aria-label': t`开场页`, 'data-initial': art?.backdrop ? undefined : letters[0] ?? '' }, [
    art?.backdrop ? el('div', { class: `cover-back${art.soft ? ' soft' : ''}` }, el('img', { src: art.backdrop, alt: '', draggable: 'false' })) : null,
    el('div', { class: 'cover-veil' }),
    cover.effect ? effectLayer(el, cover.effect, 1.6) : null,
    el('div', { class: 'cover-main' }, [
      by ? el('p', { class: 'cover-kicker', text: by }) : null,
      title,
      el('i', { class: 'cover-rule', 'aria-hidden': 'true' }),
      cover.tagline ? el('p', { class: 'cover-tagline', text: cover.tagline }) : null,
      cover.lines.length ? el('ul', { class: 'cover-lines' }, cover.lines.map((line, i) => el('li', { style: `--i:${i}`, text: line }))) : null,
    ]),
    art?.portrait ? el('figure', { class: `cover-figure${art.zoom ? ' zoom' : ''}` }, el('img', { src: art.portrait, alt: '', draggable: 'false' })) : null,
    doors.length ? el('div', { class: 'cover-doors', role: 'group', 'aria-label': t`选一个开场` }, doors) : null,
    el('p', { class: 'cover-hint', text: doors.length && canPick ? t`选一个开场，再在下面写第一句。故事开始以后开场不能再换。` : t`故事从下面开始。` }),
  ])
  const fold = folded => {
    box.classList.toggle('folded', folded)
    toggle.textContent = folded ? t`展开` : t`收起`
    toggle.setAttribute('aria-expanded', String(!folded))
  }
  const toggle = el('button', { type: 'button', class: 'cover-fold', onclick: () => {
    const folded = !box.classList.contains('folded')
    fold(folded)
    onFold?.(folded)
  } })
  if (foldable) {
    box.append(toggle)
    fold(false)
  }
  const wrap = el('div', { class: 'cover-wrap' }, box)
  if (palette) paint(wrap, paletteColors(palette))
  if (skin?.css) wear(wrap, skin)
  return { node: wrap, mark, fold }
}
