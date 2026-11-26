// 随身册 (养成): a seal over the story, where the player puts it, and the panel it opens: who fights and who stands by, those boarded out,
// the 图鉴 and the 克制. What is done here joins the turn's operations, like everything in the 游戏菜单, and can be taken
// back one at a time. The panel is not modal: the story can be read beside it. On a phone it comes up from the bottom.
import { lang, t, zh } from '/i18n.js'
import { pageZoom } from '/theme.js'
import { MAX_BOX, MAX_FIELDED, dexKnown, dexOf, fieldedOf, levelNeeds } from '/shared/game/sheet.js'
import { bondOf, formAt, formNeeds, formOf, formReady, formsOf, nextForm } from '/shared/game/growth.js'
import { badges, raisedPower, raisesOn, showEvolved, shownName, stageOfMember, statBars, talentWord } from '/game-raise.js'
import * as growth from '/game-growth.js'
import { TALENTS, liftLevels, rankOf } from '/shared/game/raise.js'

const SPOT_KEY = 'cicatavern.slabSpot'
const MAX_PARTY = 8
const SEAL = 56
const EDGE = 4
const MAX_QUEUE = 20
const SVG = 'http://www.w3.org/2000/svg'
// Where the three who fight stand on the ring, in its own units (376 × 346).
const RING = [[188, 92], [82, 232], [294, 232]]

const kept = () => { try { return JSON.parse(localStorage.getItem(SPOT_KEY)) ?? {} } catch { return {} } }
const keep = change => { try { localStorage.setItem(SPOT_KEY, JSON.stringify({ ...kept(), ...change })) } catch { /* private mode: for this page only */ } }
const svg = (tag, attrs, kids = []) => {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  node.append(...kids)
  return node
}
/** A ring that shows a share of something. */
const arc = (share, r, kind, width) => [
  svg('circle', { cx: 50, cy: 50, r, class: 'slab-arc-track', 'stroke-width': width }),
  svg('circle', { cx: 50, cy: 50, r, class: `slab-arc ${kind}`, 'stroke-width': width, pathLength: 100, 'stroke-dasharray': `${Math.max(0, Math.min(1, share)) * 100} 100` }),
]
const ringOf = member => svg('svg', { viewBox: '0 0 100 100', class: 'slab-arcs', 'aria-hidden': 'true' })

/**
 * @param deps - { el, toast, sound (), context () → { chat, book, play, sheet, face, ops } or null where there is nothing
 *   to show, addOp (op), undo (), openBag (tab), hidden () (a fight on the screen) }
 */
export function createSlab(deps) {
  const { el, toast } = deps
  let open = false
  let tab = 'team'
  let shown = ''
  let picking = null
  let pickedType = ''
  const query = { text: '', sort: 'power', type: '' }
  const c = () => deps.context()
  const said = (key, fallback) => c()?.book.words?.[key] || fallback
  const nameOf = book => book.growth?.slabName || t`随身册`

  // ─── the seal ───
  const seal = el('button', { type: 'button', class: 'slab-seal', hidden: true })
  const face = (name, kind = '') => {
    const src = c()?.face?.(name) ?? ''
    return el('span', { class: `slab-face ${kind}` }, [src ? el('img', { src, alt: '', draggable: 'false', loading: 'lazy' }) : el('i', { text: name.slice(0, 1) })])
  }
  const faceFor = (member, book, kind = '') => {
    const name = shownName(member, book)
    const has = c()?.face?.(name)
    return face(has ? name : member.name, kind)
  }
  /** The window in the page's own lengths, which the 界面大小 stretches. */
  const room = () => { const zoom = pageZoom(); return { zoom, w: innerWidth / zoom, h: innerHeight / zoom } }
  /** Not put anywhere yet: inside the story's column, at its right, just over the input box. */
  function usualSpot() {
    const { zoom, w, h } = room()
    const box = selector => { const one = document.querySelector(selector)?.getBoundingClientRect(); return one?.width ? one : null }
    const reader = box('.reader')
    if (!reader) return { x: w - SEAL - 12, y: h * 0.58 }
    const novel = document.querySelector('.stage')?.classList.contains('vn-on')
    const column = novel ? reader : box('.composer-box') ?? reader
    return { x: Math.min(column.right, reader.right) / zoom - SEAL - 8, y: novel ? (reader.top + reader.height * 0.4) / zoom : reader.bottom / zoom - SEAL - 12 }
  }
  function putSeal(x, y) {
    const { w, h } = room()
    seal.style.left = `${Math.round(Math.max(EDGE, Math.min(w - SEAL - EDGE, x)))}px`
    seal.style.top = `${Math.round(Math.max(EDGE, Math.min(h - SEAL - EDGE, y)))}px`
  }
  // Where it was put is kept as a share of the window's room, so that it is there again in a window of another size.
  function placeSeal() {
    if (drag?.moved) return
    const { seal: spot } = kept()
    const { w, h } = room()
    if (spot) putSeal(spot.x * (w - SEAL), spot.y * (h - SEAL))
    else { const { x, y } = usualSpot(); putSeal(x, y) }
  }
  // The pointer passes over cards' frames on the way, which would keep what is done there to themselves.
  const over = on => document.documentElement.classList.toggle('slab-moving', on)
  let drag = null
  seal.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    drag = { x: event.clientX, y: event.clientY, box: seal.getBoundingClientRect(), moved: false }
    seal.setPointerCapture(event.pointerId)
    over(true)
  })
  seal.addEventListener('pointermove', event => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < 6) return
    drag.moved = true
    seal.classList.add('dragging')
    const { zoom } = room()
    putSeal((drag.box.left + dx) / zoom, (drag.box.top + dy) / zoom)
  })
  const dropSeal = event => {
    if (!drag) return
    const { moved } = drag
    drag = null
    over(false)
    seal.classList.remove('dragging')
    if (moved) {
      const { w, h } = room()
      keep({ seal: { x: parseFloat(seal.style.left) / (w - SEAL), y: parseFloat(seal.style.top) / (h - SEAL) } })
    } else if (event.type === 'pointerup') toggle()
  }
  seal.addEventListener('pointerup', dropSeal)
  seal.addEventListener('pointercancel', dropSeal)
  // A click that came of the keyboard: the pointer's own is settled above.
  seal.addEventListener('click', event => { if (event.detail === 0) toggle() })
  seal.addEventListener('contextmenu', event => {
    event.preventDefault()
    keep({ off: true })
    refresh()
    toast(t`收起来了。在游戏菜单的「${said('party', t`队伍`)}」里能再放出来`)
  })

  // ─── the panel ───
  const title = el('b', { class: 'slab-name' })
  const count = el('span', { class: 'slab-count' })
  const head = el('div', { class: 'slab-top' }, [title, count, el('button', { type: 'button', class: 'slab-x', 'aria-label': t`收起`, text: '×', onclick: () => toggle(false) })])
  const page = el('div', { class: 'slab-page' })
  const line = el('div', { class: 'slab-queue', hidden: true })
  const tabs = el('div', { class: 'slab-tabs', role: 'tablist' })
  const sheetBox = el('div', { class: 'slab-sheet' })
  const askBox = el('div', { class: 'slab-ask', hidden: true })
  const slab = el('section', { class: 'slab', hidden: true }, [head, page, line, tabs, sheetBox, askBox])
  document.body.append(seal, slab)
  const narrow = () => innerWidth <= 620
  function placeSlab() {
    if (narrow()) { slab.style.left = slab.style.top = ''; return }
    const { slab: spot } = kept()
    const w = slab.offsetWidth || 392
    const h = slab.offsetHeight || 700
    const all = room()
    // Beside the seal, on the side that has room for it.
    const at = seal.hidden ? usualSpot().x : parseFloat(seal.style.left)
    const x = spot?.x ?? (at - w - 12 >= 8 ? at - w - 12 : at + SEAL + 12)
    const y = spot?.y ?? Math.max(12, (all.h - h) / 2)
    slab.style.left = `${Math.round(Math.max(8, Math.min(all.w - w - 8, x)))}px`
    slab.style.top = `${Math.round(Math.max(8, Math.min(all.h - 120, y)))}px`
  }
  let carry = null
  head.addEventListener('pointerdown', event => {
    if (narrow() || event.button !== 0 || event.target.closest('button')) return
    const box = slab.getBoundingClientRect()
    carry = { x: event.clientX - box.left, y: event.clientY - box.top }
    head.setPointerCapture(event.pointerId)
    over(true)
  })
  head.addEventListener('pointermove', event => {
    if (!carry) return
    const { zoom } = room()
    keep({ slab: { x: (event.clientX - carry.x) / zoom, y: (event.clientY - carry.y) / zoom } })
    placeSlab()
  })
  for (const type of ['pointerup', 'pointercancel']) head.addEventListener(type, () => { if (carry) over(false); carry = null })
  // Back to where both are on their own.
  head.addEventListener('dblclick', () => { keep({ slab: null, seal: null }); placeSeal(); placeSlab() })
  const placeAll = () => { if (!seal.hidden) placeSeal(); if (open) placeSlab() }
  window.addEventListener('resize', placeAll)
  // A pane folded, the column made wider, the input box grown.
  const reader = document.querySelector('.reader')
  if (reader && typeof ResizeObserver !== 'undefined') {
    const watch = new ResizeObserver(() => { if (!kept().seal) placeAll() })
    for (const one of [reader, document.querySelector('.composer-box')]) if (one) watch.observe(one)
  }
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !open || document.querySelector('dialog[open]')) return
    event.stopPropagation()
    if (!askBox.hidden) closeAsk()
    else if (shown) show('')
    else toggle(false)
  }, true)

  function toggle(want = !open) {
    if (want && !c()) return
    open = want
    slab.hidden = !open
    if (!open) { shown = ''; picking = null; closeAsk(); sheetBox.classList.remove('up') } else { placeSlab(); draw(); requestAnimationFrame(() => slab.classList.add('in')) }
    if (!open) slab.classList.remove('in')
    seal.setAttribute('aria-expanded', String(open))
  }

  // ─── what is done ───
  /** One more operation for the turn, if it can be done and there is room for it. */
  function act(op) {
    const { ops, play, chat, book } = c()
    if (ops.length >= MAX_QUEUE) return toast(t`这一轮的改动太多了，先发出去再改`)
    const tried = play.applyOps(play.sheetFor(chat, book, ops), book, [op])
    if (tried.dropped.length) return toast(t`现在做不了`)
    const was = op.op === 'form' ? find(op.who) : null
    deps.addOp(op)
    draw()
    const now = was ? find(op.who) : null
    if (now && now.form !== was.form) showEvolved(el, { before: was, after: now, book, face: c().face, word: said('evolve', t`进化`), sound: deps.sound() })
  }
  const all = (sheet = c().sheet) => [...(sheet.party ?? []), ...(sheet.box ?? [])]
  const find = name => all().find(member => member.name === name) ?? null
  const party = (act, name, more = {}) => ({ op: 'party', act, name, ...more })
  const whereOf = member => { const { sheet } = c(); return (sheet.box ?? []).some(one => one.name === member.name) ? 'box' : fieldedOf(sheet).some(one => one.name === member.name) ? 'field' : 'bench' }
  /** Moved by a drag or a button: to a place, or into another's. */
  function move(name, where, over = '') {
    const { sheet, book } = c()
    const member = find(name)
    const from = whereOf(member)
    if (over && over !== name) {
      const other = find(over)
      const there = whereOf(other)
      if ((there === 'field' && member.hurt) || (from === 'field' && other.hurt)) return toast(t`负伤的不能上场`)
      return act(party('swap', name, { with: over, label: shownName(member, book), other: shownName(other, book) }))
    }
    if (from === where) return
    if (where === 'field') {
      if (member.hurt) return toast(t`${shownName(member, book)}负伤了，养好再上场`)
      if (from === 'box') return toast(t`先接回队伍，再上场`)
      if (fieldedOf(sheet).length >= MAX_FIELDED) return pickOut(member)
      return act(party('field', name))
    }
    if (from === 'field' && fieldedOf(sheet).length === 1) return toast(t`至少留一只出战`)
    if (where === 'bench') {
      if (from === 'field') return act(party('bench', name))
      return (sheet.party ?? []).length >= MAX_PARTY ? swapFor(member) : act(party('fetch', name))
    }
    if ((sheet.box ?? []).length >= MAX_BOX) return toast(t`寄养满 ${MAX_BOX} 只了`)
    act(party('store', name))
  }

  // ─── questions ───
  function ask(kids) {
    askBox.hidden = false
    askBox.replaceChildren(el('div', {}, kids))
    askBox.querySelector('button')?.focus()
  }
  function closeAsk() { askBox.hidden = true; askBox.replaceChildren() }
  const row = kids => el('div', { class: 'slab-ask-row' }, kids)
  const button = (text, onclick, kind = '') => el('button', { type: 'button', class: `btn small ${kind}`, text, onclick })
  const choose = (text, list, done) => ask([el('p', { text }), el('div', { class: 'slab-choose' }, list.map(member => el('button', { type: 'button', class: 'slab-mini', onclick: () => { closeAsk(); done(member) } }, [faceFor(member, c().book), el('b', { text: shownName(member, c().book) }), el('small', { text: `Lv.${member.level}` })]))), row([button(t`先不换`, closeAsk)])])
  const pickOut = member => choose(t`出战满 ${MAX_FIELDED} 只了。换下谁，让${shownName(member, c().book)}上？`, fieldedOf(c().sheet), other => move(member.name, 'field', other.name))
  const swapFor = member => choose(t`队伍满 ${MAX_PARTY} 只了。让谁去寄养，换${shownName(member, c().book)}回来？`, c().sheet.party, other => act(party('swap', member.name, { with: other.name, label: shownName(member, c().book), other: shownName(other, c().book) })))
  function letGo(list, done = () => {}) {
    ask([
      el('p', { text: list.length > 1 ? t`放走这 ${list.length} 只？等级和羁绊都没了，以后只能再收服。` : t`放走${shownName(list[0], c().book)}？等级和羁绊都没了，以后只能再收服。` }),
      row([button(t`留着`, closeAsk), button(t`放走`, () => { closeAsk(); for (const member of list) act(party('leave', member.name)); done() }, 'danger')]),
    ])
  }

  // ─── dragging ───
  const target = event => document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-slab-drop]') ?? null
  function draggable(node, member) {
    let held = null
    node.addEventListener('pointerdown', event => { if (event.button === 0) held = { x: event.clientX, y: event.clientY, id: event.pointerId, on: false } })
    node.addEventListener('pointermove', event => {
      if (!held) return
      if (!held.on) {
        if (Math.hypot(event.clientX - held.x, event.clientY - held.y) < 9) return
        held.on = true
        node.setPointerCapture(held.id)
        held.ghost = el('div', { class: 'slab-ghost' }, [faceFor(member, c().book)])
        document.body.append(held.ghost)
      }
      held.ghost.style.left = `${event.clientX}px`
      held.ghost.style.top = `${event.clientY}px`
      slab.querySelectorAll('.over').forEach(one => one.classList.remove('over'))
      held.target = target(event)
      held.target?.classList.add('over')
    })
    const end = event => {
      if (!held) return
      const { on, ghost, target: spot } = held
      held = null
      if (!on) return
      ghost.remove()
      slab.querySelectorAll('.over').forEach(one => one.classList.remove('over'))
      // The click this drag ends with is no click.
      node.dataset.dragged = '1'
      setTimeout(() => { delete node.dataset.dragged }, 0)
      if (event.type !== 'pointerup' || !spot) return
      const [where, name] = spot.dataset.slabDrop.split(':')
      move(member.name, where, name ?? '')
    }
    node.addEventListener('pointerup', end)
    node.addEventListener('pointercancel', end)
    node.addEventListener('click', event => { if (node.dataset.dragged) { event.stopImmediatePropagation(); event.preventDefault() } }, true)
    return node
  }

  // ─── 队伍 ───
  const ready = member => formReady(member, c().book, c().sheet.things)
  const share = (value, most) => (most ? value / most : 0)
  function mini(member, where, picker = false) {
    const { book } = c()
    const name = shownName(member, book)
    const low = share(member.life, member.maxLife) < 0.35
    const node = el('button', {
      type: 'button', class: `slab-mini${member.hurt ? ' hurt' : ''}${picking?.has(member.name) ? ' on' : ''}`, 'aria-label': t`${name}，${member.level} 级`, title: name,
      ...(picker ? { 'aria-pressed': String(picking.has(member.name)) } : { 'data-slab-drop': `${where}:${member.name}` }),
      onclick: () => {
        if (!picker) return show(member.name)
        if (picking.has(member.name)) picking.delete(member.name)
        else picking.add(member.name)
        draw()
      },
    }, [
      faceFor(member, book),
      ready(member) ? el('span', { class: 'slab-evo', text: said('evolve', t`进化`) }) : null,
      picker ? el('span', { class: 'slab-pick', 'aria-hidden': 'true', text: picking.has(member.name) ? '✓' : '' }) : null,
      el('b', { text: name }),
      el('small', { text: member.hurt ? t`负伤` : where === 'box' ? `Lv.${member.level} · ${sortValue(member)}` : `Lv.${member.level}` }),
      where === 'bench' ? el('span', { class: `slab-bar${low ? ' low' : ''}` }, el('i', { style: `width: ${share(member.life, member.maxLife) * 100}%` })) : null,
    ])
    return picker ? node : draggable(node, member)
  }
  function teamPage() {
    const { sheet, book } = c()
    const field = fieldedOf(sheet)
    const bench = (sheet.party ?? []).filter(member => !field.includes(member))
    const ring = el('div', { class: 'slab-ring' }, [svg('svg', { viewBox: '0 0 376 346', class: 'slab-circle', 'aria-hidden': 'true' }, [
      svg('circle', { cx: 188, cy: 172, r: 134, class: 'a' }),
      svg('circle', { cx: 188, cy: 172, r: 126, class: 'b' }),
      svg('path', { d: `M${RING.map(point => point.join(' ')).join('L')}Z`, class: 'c' }),
    ])])
    RING.forEach(([x, y], i) => {
      const member = field[i]
      const style = `left: ${(x / 376) * 100}%; top: ${(y / 346) * 100}%`
      if (!member) return ring.append(el('div', { class: 'slab-slot empty', style, 'data-slab-drop': 'field' }, el('span', { text: t`空位` })))
      const name = shownName(member, book)
      const arcs = ringOf(member)
      arcs.append(...arc(share(member.life, member.maxLife), 48, share(member.life, member.maxLife) < 0.35 ? 'low' : 'life', 3), ...arc(share(member.experience ?? 0, levelNeeds(member.level, book)), 44.4, 'exp', 1.6))
      ring.append(draggable(el('button', { type: 'button', class: 'slab-slot', style, 'data-slab-drop': `field:${member.name}`, 'aria-label': t`${name}，${member.level} 级`, onclick: () => show(member.name) }, [
        arcs,
        faceFor(member, book),
        el('span', { class: 'slab-pos', 'aria-hidden': 'true', text: String(i + 1) }),
        ready(member) ? el('span', { class: 'slab-evo', text: t`可${said('evolve', t`进化`)}` }) : null,
        el('span', { class: 'slab-tag' }, [name, el('small', { text: [`Lv.${member.level}`, stageOfMember(member, book)].filter(Boolean).join(' · ') })]),
      ]), member))
    })
    return [
      ring,
      el('h3', {}, [t`待命`, el('small', { text: t`跟着走，得一半经验` })]),
      el('div', { class: 'slab-bench' }, [
        ...bench.map(member => mini(member, 'bench')),
        ...Array.from({ length: Math.max(0, MAX_PARTY - MAX_FIELDED - bench.length) }, () => el('div', { class: 'slab-mini empty', 'data-slab-drop': 'bench' }, [el('span', { class: 'slab-face' }), el('small', { text: t`空` })])),
      ]),
      el('p', { class: 'hint', text: t`点一只看详情。按住拖到环上换人，拖到下面的「寄养」就不带在身边。` }),
    ]
  }

  // ─── 寄养 ───
  const talentStep = member => TALENTS.findIndex(item => item.id === member.talent)
  const typeOf = member => { const { book } = c(); return (formAt(member, book) > 0 ? formOf(member, book)?.type : null) ?? member.type ?? book.companions?.[member.name]?.type ?? '' }
  const rankStep = member => rankOf(c().book, member.name, formsOf(member, c().book).length ? formAt(member, c().book) : 0) ?? -1
  const SORTS = () => ({ power: t`战力`, level: t`等级`, rank: said('form', t`阶位`), talent: t`资质`, type: t`属性` })
  const compare = { power: (a, b) => raisedPower(b, c().book) - raisedPower(a, c().book), level: (a, b) => b.level - a.level, rank: (a, b) => rankStep(b) - rankStep(a) || b.level - a.level, talent: (a, b) => talentStep(b) - talentStep(a) || b.level - a.level, type: (a, b) => typeOf(a).localeCompare(typeOf(b), 'zh') || b.level - a.level }
  const sortValue = member => (query.sort === 'talent' ? talentWord(member.talent) : query.sort === 'type' ? typeOf(member) : query.sort === 'rank' ? stageOfMember(member, c().book) : String(raisedPower(member, c().book)))
  function boxPage() {
    const { sheet, book } = c()
    const box = sheet.box ?? []
    const types = [...new Set(box.map(typeOf).filter(Boolean))]
    if (query.type && !types.includes(query.type)) query.type = ''
    const list = box.filter(member => (!query.type || typeOf(member) === query.type) && (!query.text || [shownName(member, book), member.name, ...member.skills].join(' ').includes(query.text))).sort(compare[query.sort])
    const search = el('input', { type: 'search', id: 'slab-find', placeholder: t`找名字或招式`, 'aria-label': t`找名字或招式`, value: query.text })
    search.addEventListener('input', () => {
      query.text = search.value.trim()
      draw()
      const again = page.querySelector('#slab-find')
      again?.focus()
      again?.setSelectionRange(again.value.length, again.value.length)
    })
    const sort = el('select', { 'aria-label': t`排序` }, Object.entries(SORTS()).map(([key, word]) => el('option', { value: key, text: t`按${word}`, selected: query.sort === key })))
    sort.addEventListener('change', () => { query.sort = sort.value; draw() })
    const picked = picking ? box.filter(member => picking.has(member.name)) : []
    const room = MAX_PARTY - (sheet.party ?? []).length
    return [
      el('div', { class: 'slab-tools' }, [
        el('div', { class: 'slab-tools-line' }, [search, sort, box.length ? button(picking ? t`完成` : t`多选`, () => { picking = picking ? null : new Set(); draw() }) : null]),
        types.length > 1 ? el('div', { class: 'slab-chips' }, [['', t`全部 ${box.length}`], ...types.map(type => [type, type])].map(([key, word]) => el('button', { type: 'button', 'aria-pressed': String(query.type === key), text: word, onclick: () => { query.type = key; draw() } }))) : null,
      ]),
      list.length
        ? el('div', { class: 'slab-grid' }, list.map(member => mini(member, 'box', Boolean(picking))))
        : el('p', { class: 'hint', text: box.length ? t`没有符合的。换个词，或者点「全部」。` : t`还没有寄养的。队伍满 ${MAX_PARTY} 只以后，再收服的会先到这里；也可以在「${said('party', t`队伍`)}」里把谁拖过来。` }),
      picking
        ? el('div', { class: 'slab-actions' }, [
          el('span', { text: picked.length ? t`选了 ${picked.length} 只` : t`点一下选中` }),
          el('button', { type: 'button', class: 'btn small', text: t`接回`, disabled: !picked.length, onclick: () => { if (picked.length > room) return toast(room > 0 ? t`队伍只剩 ${room} 个位置` : t`队伍满 ${MAX_PARTY} 只了，先寄养几只`); picking = null; for (const member of picked) act(party('fetch', member.name)); draw() } }),
          el('button', { type: 'button', class: 'btn small danger', text: t`放走`, disabled: !picked.length, onclick: () => letGo(picked, () => { picking = null; draw() }) }),
        ])
        : list.length ? el('p', { class: 'hint', text: t`点开看详情，也可以直接拖到下面的「${said('party', t`队伍`)}」接回来。` }) : null,
    ]
  }

  // ─── 图鉴 ───
  function dexPage() {
    const { sheet, book, chat } = c()
    const names = dexOf(book)
    const { caught, seen } = dexKnown(book, chat.path, sheet)
    const groups = new Map()
    for (const name of names) {
      const where = book.foes?.[name]?.where || (book.companions?.[name] ? t`伙伴` : book.foes?.[name]?.type || t`其他`)
      groups.set(where, [...(groups.get(where) ?? []), name])
    }
    const cell = name => {
      const has = caught.has(name)
      const met = seen.has(name)
      return el('button', { type: 'button', class: 'slab-mini', onclick: () => (find(name) ? show(name) : entry(name, met)) }, [face(name, has ? '' : met ? 'gray' : 'shadow'), el('b', { text: met ? name : t`？？？` }), el('small', { text: has ? (find(name) ? t`已收服` : t`收服过`) : met ? t`见过` : t`没见过` })])
    }
    const got = names.filter(name => caught.has(name)).length
    return [
      el('div', { class: 'slab-prog' }, [el('span', { text: t`收服 ${got} / ${names.length}` }), el('span', { class: 'slab-bar wide' }, el('i', { style: `width: ${share(got, names.length) * 100}%` })), el('span', { text: t`见过 ${names.filter(name => seen.has(name)).length}` })]),
      ...[...groups].flatMap(([where, list]) => [el('h3', {}, [where, el('small', { text: `${list.filter(name => caught.has(name)).length}/${list.length}` })]), el('div', { class: 'slab-grid' }, list.map(cell))]),
    ]
  }
  function entry(name, met) {
    const { book } = c()
    const foe = book.foes?.[name] ?? {}
    const chain = book.forms?.[name] ?? []
    const stage = chain[0]?.stage ?? foe.rank ?? ''
    const type = foe.type ?? book.companions?.[name]?.type ?? ''
    const moves = foe.moves ?? Object.keys(book.companions?.[name]?.skills ?? {})
    ask([
      el('div', { class: 'slab-entry' }, [face(name, met ? 'gray' : 'shadow'), el('div', {}, [el('b', { text: met ? name : t`？？？` }), el('div', { class: 'raise-badges' }, met ? [stage ? el('b', { class: 'raise-stage', text: stage }) : null, type ? el('i', { text: type }) : null] : [el('i', { text: t`还没遇到过` })])])]),
      el('p', { text: met ? [moves.length ? t`招式：${moves.join(t`、`)}。` : '', chain.length > 1 ? t`能${said('evolve', t`进化`)} ${chain.length - 1} 次。` : t`没有别的${said('form', t`形态`)}。`].join('') : foe.where ? t`在${foe.where}能遇到，打过一次就会记下来。` : t`遇到一次就会记下来。` }),
      row([button(t`知道了`, closeAsk)]),
    ])
  }

  // ─── 克制 ───
  function typePage() {
    const { book, sheet } = c()
    const beats = book.types ?? {}
    const names = Object.keys(beats)
    const lead = fieldedOf(sheet)[0]
    const me = names.includes(pickedType) ? pickedType : names.includes(lead ? typeOf(lead) : '') ? typeOf(lead) : names[0]
    const by = names.filter(name => beats[name].includes(me))
    const R = 122
    const at = name => { const turn = (names.indexOf(name) / names.length) * Math.PI * 2; return [188 + R * Math.sin(turn), 165 - R * Math.cos(turn)] }
    const line = (from, to, kind) => {
      const [x1, y1] = at(from)
      const [x2, y2] = at(to)
      const far = Math.hypot(x2 - x1, y2 - y1) || 1
      const [ux, uy] = [(x2 - x1) / far, (y2 - y1) / far]
      // Two that beat each other: the two lines stand a little apart.
      const [ox, oy] = [-uy * 5, ux * 5]
      const tip = [x2 - ux * 33 + ox, y2 - uy * 33 + oy]
      return [svg('path', { d: `M${x1 + ux * 31 + ox} ${y1 + uy * 31 + oy}L${tip[0] - ux * 6} ${tip[1] - uy * 6}`, class: `slab-edge ${kind}` }), svg('path', { d: `M${tip[0]} ${tip[1]}L${tip[0] - ux * 10 - uy * 5} ${tip[1] - uy * 10 + ux * 5}L${tip[0] - ux * 10 + uy * 5} ${tip[1] - uy * 10 - ux * 5}Z`, class: `slab-tip ${kind}` })]
    }
    const go = name => { pickedType = name; draw() }
    const dot = name => {
      const [x, y] = at(name)
      const text = svg('text', { x, y })
      text.textContent = name
      const node = svg('g', { class: `slab-dot${name === me ? ' me' : ''}${beats[me].includes(name) ? ' beaten' : ''}${by.includes(name) ? ' beats' : ''}`, tabindex: 0, role: 'button', 'aria-label': name, 'aria-pressed': String(name === me) }, [svg('circle', { cx: x, cy: y, r: 28 }), text])
      node.addEventListener('click', () => go(name))
      node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go(name) } })
      return node
    }
    const mine = all().filter(member => by.includes(typeOf(member))).sort(compare.power)
    return [
      svg('svg', { viewBox: '0 0 376 330', class: 'slab-types' }, [svg('circle', { cx: 188, cy: 165, r: R, class: 'a' }), ...beats[me].flatMap(name => line(me, name, 'good')), ...by.flatMap(name => line(name, me, 'bad')), ...names.map(dot)]),
      el('p', { class: 'slab-verdict', text: [beats[me].length ? t`${me}克${beats[me].join(t`、`)}` : t`${me}谁也不克`, by.length ? t`被${by.join(t`、`)}克` : t`谁也不克它`].join(t`；`) }),
      el('h3', {}, [t`能克${me}的，你有`, el('small', { text: t`${mine.length} 只` })]),
      mine.length ? el('div', { class: 'slab-grid' }, mine.map(member => mini(member, whereOf(member)))) : el('p', { class: 'hint', text: t`还没有克${me}的。` }),
    ]
  }

  // ─── one of them ───
  function show(name) {
    shown = name
    if (!name) return sheetBox.classList.remove('up')
    drawSheet()
    sheetBox.querySelector('.slab-body').scrollTop = 0
    sheetBox.classList.add('up')
  }
  function drawSheet() {
    const { book, sheet, face: faces, chat } = c()
    const member = find(shown)
    if (!member) return show('')
    const where = whereOf(member)
    const list = where === 'box' ? (sheet.box ?? []) : where === 'field' ? fieldedOf(sheet) : (sheet.party ?? []).filter(one => whereOf(one) === 'bench')
    const i = list.findIndex(one => one.name === shown)
    const name = shownName(member, book)
    const src = faces?.(name) || faces?.(member.name) || ''
    const chain = formsOf(member, book)
    const at = formAt(member, book)
    const next = nextForm(member, book)
    const can = ready(member)
    const needs = next ? formNeeds(next, member, sheet.things) : []
    const needed = levelNeeds(member.level, book)
    const apart = member.level - (sheet.level ?? 1)
    const heeded = liftLevels(member.level, sheet.level ?? 1, bondOf(member))
    const bar = (value, most, kind) => el('span', { class: `slab-bar wide ${kind}` }, el('i', { style: `width: ${Math.min(1, share(value, most)) * 100}%` }))
    const foot = []
    if (can) foot.push(el('button', { type: 'button', class: 'btn primary wide', text: t`${said('evolve', t`进化`)}成${can.name}`, onclick: () => act({ op: 'form', label: can.name, who: member.name }) }))
    if (where === 'box') foot.push(el('button', { type: 'button', class: `btn${can ? '' : ' primary'}`, text: t`接回`, onclick: () => move(member.name, 'bench') }))
    else {
      if (where === 'field') foot.push(el('button', { type: 'button', class: 'btn', text: t`换到待命`, onclick: () => move(member.name, 'bench') }))
      else if (member.hurt) foot.push(el('button', { type: 'button', class: 'btn', text: t`已经好了`, title: t`故事里伤已经好了，让${name}能上场`, onclick: () => act(party('back', member.name)) }))
      else foot.push(el('button', { type: 'button', class: `btn${can ? '' : ' primary'}`, text: t`出战`, onclick: () => move(member.name, 'field') }))
      foot.push(el('button', { type: 'button', class: 'btn', text: t`寄养`, onclick: () => move(member.name, 'box') }))
    }
    foot.push(el('button', { type: 'button', class: 'btn danger', text: t`放走`, onclick: () => letGo([member], () => show('')) }))
    const kept = sheetBox.querySelector('.slab-body')?.scrollTop ?? 0
    const folds = [...growth.bondLine(member, book) ? [el('p', { class: 'hint', text: growth.bondLine(member, book) })] : [], ...growth.gearSection({ el, who: member, sheet, book, act, name: member.name }), ...(growth.perksOn(book) && ((member.perks ?? []).length || growth.perksOwed(member, book) || growth.bigsOwed(member, book)) ? growth.perkSection({ el, who: member, book, seed: chat.id, word: said('perk', t`天赋`), act: op => act(op.key ? { ...op, label: growth.perkShown(book, op.key)?.name ?? op.key } : op), name: member.name }) : [])]
    sheetBox.replaceChildren(
      el('div', { class: 'slab-sheet-top' }, [el('button', { type: 'button', text: t`‹ 返回`, onclick: () => show('') }), el('span', {}, [el('button', { type: 'button', text: t`上一只`, disabled: i < 1, onclick: () => show(list[i - 1].name) }), el('button', { type: 'button', text: t`下一只`, disabled: i < 0 || i >= list.length - 1, onclick: () => show(list[i + 1].name) })])]),
      el('div', { class: 'slab-body' }, [
        el('div', { class: 'slab-hero' }, [
          el('div', { class: 'slab-art' }, src ? el('img', { src, alt: '', draggable: 'false' }) : el('i', { text: name.slice(0, 1) })),
          el('div', { class: 'slab-who' }, [
            el('h2', { text: name }),
            name !== member.name ? el('p', { class: 'hint', text: member.name }) : null,
            el('div', { class: 'raise-badges' }, [...badges(el, member, book), member.hurt ? el('i', { class: 'slab-hurt', text: t`负伤` }) : null]),
            el('div', { class: 'slab-lv' }, [el('b', { text: `Lv.${member.level}` }), el('span', {}, [t`战力`, ' ', el('b', { text: String(raisedPower(member, book)) })])]),
            el('small', { text: `${said('life', t`生命`)} ${member.life}/${member.maxLife}` }),
            bar(member.life, member.maxLife, share(member.life, member.maxLife) < 0.35 ? 'low' : ''),
            el('small', { text: `${said('experience', t`经验`)} ${member.experience ?? 0}/${needed}` }),
            bar(member.experience ?? 0, needed, 'exp'),
          ]),
        ]),
        apart > heeded ? el('p', { class: 'hint', text: t`比你高 ${apart} 级，现在只肯出 ${heeded} 级的力：羁绊每升一档多听一级，你升级也行。` }) : apart <= -2 ? el('p', { class: 'hint', text: t`比你低 ${-apart} 级：打起来吃亏，不过得到的经验更多。` }) : null,
        el('h3', {}, [t`能力`, member.points ? el('small', { text: t`还有 ${member.points} 点可加` }) : null]),
        statBars(el, member, book, { add: id => act({ op: 'point', id, who: member.name }) }),
        el('h3', { text: said('skill', t`技能`) }),
        el('div', { class: 'slab-moves' }, member.skills.map(skill => el('div', {}, [growth.skillShown(skill, member.mastery?.[skill]), el('small', { text: growth.kindText(book, skill) })]))),
        chain.length > 1 ? el('h3', { text: said('form', t`形态`) }) : null,
        chain.length > 1 ? el('div', { class: 'slab-chain' }, chain.flatMap((form, k) => [k ? el('span', { class: 'slab-arrow', 'aria-hidden': 'true', text: '›' }) : null, el('div', { class: `slab-step${k === at ? ' now' : ''}` }, [face(form.name === member.name || faces?.(form.name) ? form.name : k ? form.name : member.name, k > at ? 'shadow' : ''), el('span', { text: form.stage || form.name }), k > at && form.at?.level ? el('span', { text: `Lv.${form.at.level}` }) : null])])) : null,
        needs.length ? el('div', { class: 'slab-need' }, needs.map(need => el('span', { class: need.met ? 'ok' : '', text: `${need.met ? '✓' : '○'} ${growth.needWord(need, book)}` }))) : null,
        ...folds,
      ]),
      el('div', { class: 'slab-foot' }, foot),
    )
    sheetBox.querySelector('.slab-body').scrollTop = kept
  }

  // ─── drawn ───
  function draw() {
    const now = c()
    if (!now) return toggle(false)
    const { sheet, book, play, ops } = now
    const field = fieldedOf(sheet).length
    const held = (sheet.party ?? []).length
    const box = (sheet.box ?? []).length
    const types = Object.keys(book.types ?? {}).length > 1
    if (tab === 'types' && !types) tab = 'team'
    title.textContent = nameOf(book)
    slab.setAttribute('aria-label', nameOf(book))
    count.textContent = { team: t`出战 ${field}/${MAX_FIELDED} · 同行 ${held}/${MAX_PARTY}`, box: t`寄养 ${box}/${MAX_BOX}`, dex: t`图鉴`, types: t`属性克制` }[tab]
    tabs.replaceChildren(...[['team', said('party', t`队伍`), `${held}/${MAX_PARTY}`, 'bench'], ['box', t`寄养`, `${box}/${MAX_BOX}`, 'box'], ['dex', t`图鉴`, ''], ...(types ? [['types', lang === 'en' ? t`属性克制` : zh`克制`, '']] : [])  /* 克制 alone is the intimacy level in English */].map(([key, word, number, drop]) => el('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === key), ...(drop ? { 'data-slab-drop': drop } : {}), onclick: () => { tab = key; picking = null; show(''); draw(); page.scrollTop = 0 } }, [word, number ? el('small', { text: number }) : null])))
    const top = page.scrollTop
    page.replaceChildren(...{ team: teamPage, box: boxPage, dex: dexPage, types: typePage }[tab]().filter(Boolean))
    page.scrollTop = top
    line.hidden = !ops.length
    if (ops.length) line.replaceChildren(el('span', { text: ops.length > 1 ? t`${play.opLabel(ops.at(-1))}，连同前面共 ${ops.length} 处改动，下一轮生效` : t`${play.opLabel(ops.at(-1))}，下一轮生效` }), button(t`撤回`, () => deps.undo()))
    if (shown) drawSheet()
  }

  /** Whatever may have changed it: the story went on, a chat was opened, an operation was made or taken back. */
  function refresh() {
    const now = c()
    const usable = Boolean(now) && !deps.hidden()
    seal.hidden = !usable || Boolean(kept().off)
    if (!usable) { if (open) toggle(false); return }
    const lead = fieldedOf(now.sheet)[0] ?? now.sheet.party?.[0] ?? now.sheet.box?.[0]
    const waiting = all(now.sheet).filter(member => ready(member)).length
    seal.setAttribute('aria-label', waiting ? t`打开${nameOf(now.book)}，${waiting} 只可以${said('evolve', t`进化`)}` : t`打开${nameOf(now.book)}`)
    seal.title = t`${nameOf(now.book)}：点开；能拖；右键收起`
    const arcs = svg('svg', { viewBox: '0 0 100 100', class: 'slab-arcs', 'aria-hidden': 'true' }, lead ? arc(share(lead.life, lead.maxLife), 47, share(lead.life, lead.maxLife) < 0.35 ? 'low' : 'life', 5) : [])
    seal.replaceChildren(arcs, lead ? faceFor(lead, now.book) : el('span', { class: 'slab-face' }, el('i', { text: '❖' })), ...(waiting ? [el('span', { class: 'slab-badge', 'aria-hidden': 'true', text: String(waiting) })] : []))
    placeSeal()
    if (open) draw()
  }
  /** 离队, asked for in the 游戏菜单: shown, and asked again. */
  function release(name) {
    keep({ off: false })
    refresh()
    toggle(true)
    const member = open ? find(name) : null
    if (member) letGo([member])
  }
  return { refresh, open: () => { keep({ off: false }); refresh(); toggle(true) }, close: () => toggle(false), release }
}
