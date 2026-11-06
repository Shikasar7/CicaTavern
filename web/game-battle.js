// 战斗画面: a fight on the whole screen, over the chat or the visual novel alike. All the rules are in shared/game/battle.js;
// this only asks what the player does and shows what comes of it, one event at a time. Timers, not animation frames: a
// page out of sight still has to finish a round.
import { t } from '/i18n.js'
import { ailName, banner, countWord, currentLook, enterFight, fitFigure, heroNow, letters, lookFields, slideSlab, sweep } from '/game-look.js'
import { fightResult } from '/shared/game/encounter.js'
import { aliveFoes, attemptSetup, autoAction, canRally, foesOf, needsTarget, playerOf, refusal, replay as replayFight, skillCost, startBattle, step } from '/shared/game/battle.js'
import { cutOut, spriteFrame } from '/shared/cutout.js'

const SPEED_KEY = 'cicatavern.battleSpeed'
const EVENT_MS = 480
const STILL_MS = 140
const AUTO_MS = 260

const remembered = () => {
  try {
    return localStorage.getItem(SPEED_KEY) === '2' ? 2 : 1
  } catch {
    return 1
  }
}

const SKILL_WORDS = () => ({ strike: t`重击一个敌人`, sweep: t`打所有敌人`, flurry: t`连打两下`, poison: t`打一下，让敌人中毒`, stun: t`打一下，可能打晕`, heal: t`回复生命`, boost: t`提高攻击力，3 回合` })
const THING_WORDS = () => ({ heal: t`回复生命`, energy: t`回复气力`, damage: t`打一个敌人`, cure: t`解除异常`, boost: t`提高攻击力，3 回合` })
const REFUSALS = () => ({ boss: t`首领面前跑不掉` })
const RESULT_WORDS = () => ({ won: t`胜利`, lost: t`战败`, fled: t`逃脱` })
const RESULT_SEALS = () => ({ won: t`捷`, lost: t`败`, fled: t`遁` })
const PICTURE_SIDE = 480
const OUT_OF_REACH = 3
// How long an effect plays at normal speed. What each blow looks like, by the kind of skill or thing behind it.
const EFFECT_MS = 620
const BLOWS = { attack: 'slash', strike: 'strike', sweep: 'cut', flurry: 'flurry', poison: 'slash', stun: 'strike', damage: 'burst' }
const SPARKS = { heal: 22, energy: 22, boost: 24, poison: 7, stun: 3, down: 8 }
// How wide sparks spread: over the player's side they have the whole width of the screen to fill.
const SPREAD = { heal: 560, energy: 560, boost: 560 }
const CLAWS = 3
// How long a skill's name holds the screen before its blow, where a look writes it out; and how long it stays, in effects.
const SKILL_MS = { ink: 820 }
const NAME_STAYS = 2.7
const BLOWS_LANDED = new Set(['slash', 'strike', 'cut', 'flurry', 'burst'])
// Pictures cut out of their white on this page: address → a promise of the cut one, or of null.
const cuts = new Map()

/** A foe's picture without its plain background; null when it has none to lose, and the picture is shown as it is. */
export function cutPicture(url) {
  if (!cuts.has(url)) {
    cuts.set(url, (async () => {
      const blob = await fetch(url).then(res => (res.ok ? res.blob() : null), () => null)
      const bitmap = blob ? await createImageBitmap(blob).catch(() => null) : null
      if (!bitmap) return null
      const scale = Math.min(1, PICTURE_SIDE / bitmap.height)
      const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) })
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      bitmap.close()
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      const result = cutOut(image, { gaps: true })
      if (!result.ok) return null
      context.putImageData(image, 0, 0)
      const { x, y, width, height } = spriteFrame(image, result.box)
      const out = Object.assign(document.createElement('canvas'), { width, height })
      out.getContext('2d').drawImage(canvas, x, y, width, height, 0, 0, width, height)
      const png = await new Promise(resolve => out.toBlob(resolve, 'image/png'))
      return png ? URL.createObjectURL(png) : null
    })())
  }
  return cuts.get(url)
}

/**
 * @param deps - { el, setup (battle.js battleSetup), resume ({ attempt, actions }: a fight to pick up), onProgress ({ attempt, actions }),
 *   onEnd ({ over: 'won'|'lost'|'fled'|'story', attempt, actions }), sound (web/game-sound.js),
 *   foeShown (name → { moves, picture }), background (the scene's picture), forced (the story left no way round it) }
 */
export function openBattle({ el, setup, resume = null, onProgress, onEnd, sound = null, foeShown = () => ({ moves: [], picture: '' }), background = '', energyName = '', forced = false, hero = heroNow() }) {
  const energyWord = energyName || t`气力`
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  let attempt = resume?.attempt ?? 0
  let actions = resume?.actions ? [...resume.actions] : []
  let state = replayFight(attemptSetup(setup, attempt), actions)
  let speed = remembered()
  let auto = false
  let busy = false
  let mode = 'choose'
  let pending = null
  let aimed = 0
  let blowing = ''
  const bold = currentLook().look === 'bold'
  const nameOf = id => (id === 'player' ? t`你` : state.units.find(unit => unit.id === id)?.name ?? '')

  const round = el('span', { class: 'battle-round' })
  const speedButton = el('button', { type: 'button', class: 'battle-top-button', onclick: () => setSpeed(speed === 1 ? 2 : 1) })
  const autoButton = el('button', { type: 'button', class: 'battle-top-button', text: t`自动`, onclick: () => setAuto(!auto) })
  const storyButton = el('button', { type: 'button', class: 'battle-top-button', text: t`交给剧情`, title: t`不打了，让故事自己写这一段`, onclick: () => finish('story') })
  const foeRow = el('div', { class: 'battle-foes' })
  const line = el('div', { class: 'battle-line', role: 'status' })
  const lifeBar = el('i')
  const lifeLag = el('i', { class: 'lag' })
  const energyBar = el('i')
  const lifeText = el('b')
  const energyText = el('b')
  const selfBox = el('div', { class: 'battle-self' }, [
    el('div', { class: 'battle-meter' }, [el('span', { text: t`生命` }), el('span', { class: 'battle-bar life' }, [lifeLag, lifeBar]), lifeText]),
    el('div', { class: 'battle-meter' }, [el('span', { text: energyWord }), el('span', { class: 'battle-bar energy' }, energyBar), energyText]),
  ])
  const panel = el('div', { class: 'battle-panel' })
  const endBox = el('div', { class: 'battle-end', hidden: true })
  const flash = el('div', { class: 'battle-flash', 'aria-hidden': 'true' })
  const hurt = el('div', { class: 'battle-hurt', 'aria-hidden': 'true' })
  const effects = el('div', { class: 'battle-fx', 'aria-hidden': 'true' })
  const heroBox = hero ? el('img', { class: 'look-figure battle-hero', src: hero, alt: '' }) : null
  if (heroBox) fitFigure(heroBox, hero)
  const dialog = el('dialog', { class: `battle${background ? ' scene' : ''}`, 'aria-label': t`战斗`, ...(background ? { style: `--battle-scene: url("${background}"); --vn-picture: url("${background}")` } : {}) }, [
    lookFields(el),
    flash,
    hurt,
    heroBox,
    el('div', { class: 'battle-top' }, [round, el('span', { class: 'battle-gap' }), speedButton, autoButton, forced ? null : storyButton]),
    el('div', { class: 'battle-field' }, [foeRow, line]),
    el('div', { class: 'battle-bottom' }, [selfBox, panel]),
    effects,
    endBox,
    el('div', { class: 'battle-veil', 'aria-hidden': 'true' }),
  ])

  const wait = ms => new Promise(resolve => setTimeout(resolve, still ? STILL_MS : ms / speed))

  function setSpeed(next) {
    speed = next
    try {
      localStorage.setItem(SPEED_KEY, String(next))
    } catch {
      // Private mode: for this fight only.
    }
    speedButton.textContent = next === 2 ? t`两倍速` : t`一倍速`
    dialog.style.setProperty('--fx', `${EFFECT_MS / next}ms`)
  }

  function setAuto(on) {
    auto = on
    autoButton.classList.toggle('on', on)
    if (on && !busy && !state.over) take(autoAction(state))
  }

  function drawFoes() {
    foeRow.classList.toggle('four', foesOf(state).length === 4)
    foeRow.dataset.count = String(foesOf(state).length)
    foeRow.replaceChildren(...foesOf(state).map((foe, i) => el('button', { type: 'button', class: `battle-foe tier-${foe.tier}`, style: `--i: ${i}`, 'data-id': foe.id, onclick: event => { event.stopPropagation(); aimAt(foe.id) } }, [
      foePicture(foe),
      el('span', { class: 'foe-name', text: foe.name }),
      el('span', { class: 'battle-bar foe' }, [el('i', { class: 'lag' }), el('i')]),
      el('span', { class: 'foe-tag' }),
    ])))
  }

  /** A foe's picture on its mark, once there is one. */
  function paint(box, name) {
    const { picture } = foeShown(name)
    if (!picture || box.classList.contains('drawn')) return
    cutPicture(picture).then(cut => {
      box.replaceChildren(el('img', { src: cut ?? picture, alt: '' }))
      box.classList.add('drawn')
    })
  }

  /** The foe's mark at once, its picture over it when that is ready: a fight never waits for one. */
  function foePicture(foe) {
    const box = el('span', { class: 'foe-face', 'aria-hidden': 'true', text: foe.name.slice(0, 1) })
    paint(box, foe.name)
    return box
  }

  const foeNode = id => foeRow.querySelector(`[data-id="${id}"]`)
  const faceOf = id => foeNode(id)?.querySelector('.foe-face')

  /** A picture finished while the fight goes on: it takes its place. */
  const showPictures = () => foesOf(state).forEach(foe => {
    const box = faceOf(foe.id)
    if (box) paint(box, foe.name)
  })

  /** An effect played over part of the screen, gone by itself. Places are shares of the screen: the page may be zoomed. */
  function effect(kind, node, { crit = false, text = '' } = {}) {
    if (still || !node) return
    const screen = dialog.getBoundingClientRect()
    const at = node.getBoundingClientRect()
    const sparks = Array.from({ length: kind === 'claw' ? CLAWS : SPARKS[kind] ?? 0 }, (_, i) => el('i', { style: `--n: ${i}; --x: ${Math.round((Math.random() - 0.5) * (SPREAD[kind] ?? 150))}px; --lift: ${70 + Math.round(Math.random() * 70)}px; --late: ${Math.round(Math.random() * 180)}ms` }))
    if (currentLook().look === 'bold' && BLOWS_LANDED.has(kind)) {
      sparks.push(el('i', { class: 'bold-burst' }), ...Array.from({ length: crit ? 22 : 14 }, (_, i) => {
        const angle = (i / (crit ? 22 : 14)) * Math.PI * 2 + Math.random() * 0.3
        const reach = 170 + Math.random() * 330
        return el('i', { class: 'bold-shard', style: `--dx: ${Math.round(Math.sin(angle) * reach)}px; --dy: ${Math.round(-Math.cos(angle) * reach)}px; --r: ${Math.round((angle * 180) / Math.PI)}deg` })
      }))
    }
    if (currentLook().look === 'ink' && BLOWS_LANDED.has(kind)) sparks.push(...Array.from({ length: crit ? 30 : 16 }, () => {
      const angle = Math.random() * Math.PI * 2
      const reach = 60 + Math.random() * Math.random() * 340
      return el('i', { class: 'ink-drop', style: `--s: ${Math.round(3 + Math.random() * Math.random() * 26)}px; --dx: ${Math.round(Math.cos(angle) * reach)}px; --dy: ${Math.round(Math.sin(angle) * reach * 0.7)}px; --r: ${Math.round(Math.random() * 180)}deg` })
    }))
    const mark = el('span', { class: `fx fx-${kind}${crit ? ' crit' : ''}`, style: `left: ${((at.left + at.width / 2 - screen.left) / screen.width) * 100}%; top: ${((at.top + at.height / 2 - screen.top) / screen.height) * 100}%` }, text ? [text] : sparks)
    effects.append(mark)
    setTimeout(() => mark.remove(), (EFFECT_MS * (kind === 'name' ? NAME_STAYS : 1.6)) / speed)
  }

  function replay(node, name) {
    if (still) return
    node.classList.remove(name)
    void node.offsetWidth
    node.classList.add(name)
  }

  function drawFoe(foe, life = foe.life) {
    const node = foeNode(foe.id)
    for (const bar of node.querySelectorAll('.battle-bar i')) bar.style.width = `${(life / foe.maxLife) * 100}%`
    node.classList.toggle('down', life <= 0)
    node.disabled = life <= 0
    const tags = [foe.charging ? t`⚠ 正在蓄力` : '', foe.stun > 0 ? t`眩晕` : '', foe.poison > 0 ? t`中毒` : ''].filter(Boolean)
    node.querySelector('.foe-tag').textContent = life > 0 ? tags.join(' ') : t`倒下`
    node.classList.toggle('charging', foe.charging && life > 0)
  }

  function drawLife(life = playerOf(state).life) {
    const { maxLife } = playerOf(state)
    for (const bar of [lifeBar, lifeLag]) bar.style.width = `${(life / maxLife) * 100}%`
    lifeText.replaceChildren(String(life), el('small', { text: `/${maxLife}` }))
  }

  function drawEnergy(energy = playerOf(state).energy) {
    const { maxEnergy } = playerOf(state)
    energyBar.style.width = `${maxEnergy ? (energy / maxEnergy) * 100 : 0}%`
    energyText.replaceChildren(String(energy), el('small', { text: `/${maxEnergy}` }))
  }

  function drawAll() {
    round.replaceChildren(el('span', {}, letters(el, t`第${countWord(state.round)}回合`)))
    foesOf(state).forEach(foe => drawFoe(foe))
    drawLife()
    drawEnergy()
    drawPanel()
  }

  // ─── What the player can do ──────────────────────────────────────
  const actionButton = (label, onclick, key, reason = null) => el('button', { type: 'button', class: 'battle-action', disabled: busy || Boolean(reason), title: reason ?? '', onclick }, [el('span', { class: 'battle-key', text: key }), el('span', { text: label })])

  function drawPanel() {
    dialog.classList.toggle('aiming', mode === 'target')
    // A list stands over the foot of the page: the foot keeps its height, and the foes their place.
    const foot = panel.parentElement
    if (mode === 'choose') foot.style.minHeight = ''
    else if (!foot.style.minHeight) foot.style.minHeight = `${foot.offsetHeight}px`
    panel.className = `battle-panel ${mode}`
    foeRow.querySelectorAll('.aimed').forEach(node => node.classList.remove('aimed'))
    if (mode === 'target') {
      const foes = aliveFoes(state)
      foeNode(foes[aimed % foes.length].id).classList.add('aimed')
      return panel.replaceChildren(el('p', { class: 'battle-hint', text: t`选一个目标` }), backButton())
    }
    if (mode === 'skill') return panel.replaceChildren(listOf(state.skills.map(skillRow), t`还没有技能`), backButton())
    if (mode === 'item') return panel.replaceChildren(listOf(state.things.filter(thing => thing.count > 0).map(thingRow), t`没有能用的东西`), backButton())
    const fleeReason = REFUSALS()[refusal(state, { kind: 'flee' })] ?? null
    const actions = el('div', { class: 'battle-actions' }, [
      actionButton(t`攻击`, () => choose({ kind: 'attack' }), '1'),
      actionButton(t`技能`, () => show('skill'), '2'),
      actionButton(t`道具`, () => show('item'), '3'),
      actionButton(t`防御`, () => choose({ kind: 'guard' }), '4'),
      actionButton(t`逃跑`, () => choose({ kind: 'flee' }), '5', fleeReason),
    ])
    panel.replaceChildren(actions)
    slideSlab(el, actions, '.battle-action')
  }

  const listOf = (rows, empty) => el('div', { class: 'battle-list' }, rows.length ? rows : [el('p', { class: 'battle-hint', text: empty })])
  const backButton = () => el('button', { type: 'button', class: 'battle-back', text: t`返回`, onclick: () => goBack() })

  function skillRow(skill) {
    const cost = skillCost(state, skill)
    const reason = playerOf(state).energy < cost ? t`${energyWord}不够` : null
    return el('button', { type: 'button', class: 'battle-row', disabled: busy || Boolean(reason), onclick: () => choose({ kind: 'skill', name: skill.name }) }, [
      el('b', { text: skill.name }),
      el('span', { text: SKILL_WORDS()[skill.kind] }),
      el('span', { class: 'battle-cost', text: reason ?? `${energyWord} ${cost}` }),
    ])
  }

  function thingRow(thing) {
    const reason = refusal(state, { kind: 'item', name: thing.name }) === 'nothing' ? t`现在没有要解除的状态` : null
    return el('button', { type: 'button', class: 'battle-row', disabled: busy || Boolean(reason), onclick: () => choose({ kind: 'item', name: thing.name }) }, [
      el('b', { text: thing.count > 1 ? `${thing.name} ×${thing.count}` : thing.name }),
      el('span', { text: reason ?? THING_WORDS()[thing.effect.type] }),
    ])
  }

  function show(next) {
    sound?.play('tap')
    mode = next
    drawPanel()
  }

  function goBack() {
    const from = pending?.kind
    pending = null
    show(mode === 'target' && (from === 'skill' || from === 'item') ? from : 'choose')
  }

  /** An action chosen: on one foe at once, else the foes light up to be picked. */
  function choose(action) {
    if (!needsTarget(state, action)) return take(action)
    const foes = aliveFoes(state)
    if (foes.length === 1) return take({ ...action, target: foes[0].id })
    pending = action
    aimed = 0
    show('target')
  }

  function aimAt(id) {
    if (mode === 'target') take({ ...pending, target: id })
    else if (mode === 'choose' && !busy) choose({ kind: 'attack', target: id })
  }

  // ─── What comes of it ────────────────────────────────────────────
  /** A number over what took it, above whatever else is going off there. */
  function float(node, text, kind) {
    if (still) return
    const screen = dialog.getBoundingClientRect()
    const at = node.getBoundingClientRect()
    const mark = el('span', { class: `battle-float ${kind}`, style: `left: ${((at.left + at.width / 2 - screen.left) / screen.width) * 100}%; top: ${((at.top + 4 - screen.top) / screen.height) * 100}%` }, [kind === 'crit' ? el('em', { text: t`暴击` }) : null, text])
    effects.append(mark)
    setTimeout(() => mark.remove(), 1000)
  }

  const shake = node => replay(node, 'struck')

  /** What a foe does, by name when the bestiary has one for it: the same one each round of a fight, as a fight replays. */
  function moveOf(id) {
    const { moves } = foeShown(nameOf(id))
    return moves.length ? moves[(state.round + Number(id.slice(4))) % moves.length] : ''
  }

  const crit = event => (event.crit ? t`暴击！` : '')

  function playEvent(event) {
    const say = text => {
      line.textContent = text
    }
    if (event.type === 'hit') {
      const foe = state.units.find(unit => unit.id === event.target)
      drawFoe(foe, event.life)
      effect(BLOWS[blowing] ?? 'slash', faceOf(event.target), { crit: event.crit })
      shake(foeNode(event.target))
      float(foeNode(event.target), String(event.amount), event.crit ? 'crit' : 'hurt')
      sound?.play(event.crit ? 'crit' : 'hit')
      if (event.crit) replay(flash, 'on')
      say(t`${crit(event)}${foe.name}受到 ${event.amount} 点伤害`)
    } else if (event.type === 'struck') {
      drawLife(event.life)
      replay(hurt, 'on')
      effect('claw', foeRow, { crit: event.crit || event.charged })
      shake(selfBox)
      float(selfBox, String(event.amount), event.crit ? 'crit' : 'hurt')
      sound?.play(event.crit ? 'crit' : 'hit')
      if (event.charged) replay(dialog, 'quake')
      const move = moveOf(event.by)
      say(event.charged ? t`${crit(event)}${nameOf(event.by)}蓄力一击，你受到 ${event.amount} 点伤害` : move ? t`${crit(event)}${nameOf(event.by)}使出${move}，${event.amount} 点伤害` : t`${crit(event)}${nameOf(event.by)}打中了你，${event.amount} 点伤害`)
    } else if (event.type === 'heal') {
      drawLife(event.life)
      effect('heal', selfBox)
      float(selfBox, `+${event.amount}`, 'heal')
      sound?.play('heal')
      say(t`回复 ${event.amount} 点生命`)
    } else if (event.type === 'energy') {
      drawEnergy(event.energy)
      if (event.amount) {
        effect('energy', selfBox)
        say(t`回复 ${event.amount} 点${energyWord}`)
      }
    } else if (event.type === 'guard') {
      effect('guard', selfBox)
      say(t`你摆好了防御姿势`)
    } else if (event.type === 'skill') {
      drawEnergy(event.energy)
      effect('name', foeRow, { text: event.name })
      if (blowing === 'sweep') effect('sweep', foeRow)
      say(t`你使出${event.name}`)
    } else if (event.type === 'item') say(t`你用了${event.name}`)
    else if (event.type === 'cure') {
      effect('heal', selfBox)
      sound?.play('heal')
      say(t`${ailName(event.name)}好了`)
    } else if (event.type === 'charge') {
      effect('charge', faceOf(event.by))
      foeNode(event.by).classList.add('charging')
      foeNode(event.by).querySelector('.foe-tag').textContent = t`⚠ 正在蓄力`
      say(t`${nameOf(event.by)}在蓄力，下回合会打得很重`)
    } else if (event.type === 'stunned') say(t`${nameOf(event.by)}动弹不得`)
    else if (event.type === 'status') {
      effect(event.status, event.status === 'boost' ? selfBox : faceOf(event.target))
      say(event.status === 'poison' ? t`${nameOf(event.target)}中毒了` : event.status === 'stun' ? t`${nameOf(event.target)}被打晕了` : t`你的攻击力提高了`)
    } else if (event.type === 'poison') {
      const foe = state.units.find(unit => unit.id === event.target)
      drawFoe(foe, event.life)
      effect('poison', faceOf(event.target))
      say(t`${foe.name}毒发，${event.amount} 点伤害`)
    } else if (event.type === 'down') {
      effect('down', faceOf(event.target))
      say(t`${nameOf(event.target)}倒下了`)
    } else if (event.type === 'flee') say(event.tier === 'fail' ? t`没跑掉（掷出 ${event.total}，需要 ${event.dc}）` : t`你跑掉了（掷出 ${event.total}，需要 ${event.dc}）`)
    else return false
    return true
  }

  /** The kind of blow an action lands, for how it looks. */
  const blowOf = action => (action.kind === 'skill' ? state.skills.find(item => item.name === action.name)?.kind : action.kind === 'item' ? state.things.find(item => item.name === action.name)?.effect.type : action.kind)

  /** 酷炫: the skill's banner over a stopped picture. */
  async function bannerFor(name, action) {
    const skill = state.skills.find(item => item.name === action.name)
    dialog.classList.add('frozen')
    await banner(el, dialog, { text: name, small: skill ? `${energyWord} -${skillCost(state, skill)}` : '', picture: hero, ms: 1250 / speed })
    dialog.classList.remove('frozen')
  }

  /** 酷炫: back to where the figure stands. */
  function stepBack() {
    dialog.classList.remove('dashing')
    for (const place of ['--hx', '--hy', '--hs']) heroBox?.style.removeProperty(place)
  }

  /** 酷炫: across the screen in a blink; a big one turns the colours over as it lands. */
  async function dash(target, big) {
    const node = faceOf(target)
    if (heroBox && node) {
      // As shares of the screen: the page may be zoomed. The head lands beside the foe's.
      const screen = dialog.getBoundingClientRect()
      const to = node.getBoundingClientRect()
      const across = (to.left - screen.left) / screen.width - heroBox.offsetLeft / dialog.offsetWidth
      const down = (to.top + to.height * 0.1 - screen.top) / screen.height - heroBox.offsetTop / dialog.offsetHeight
      dialog.classList.add('dashing')
      heroBox.style.setProperty('--hx', `calc(${across * 100}vw / var(--page-zoom, 1))`)
      heroBox.style.setProperty('--hy', `calc(${down * 100}vh / var(--page-zoom, 1))`)
      heroBox.style.setProperty('--hs', '.72')
      await wait(150)
    }
    if (big) {
      replay(dialog, 'bold-invert')
      await wait(90)
    }
    replay(dialog, 'quake')
  }

  /** 酷炫: the one that strikes comes at the screen first. */
  async function lunge(by) {
    const node = foeNode(by)
    if (node) replay(node, 'lunge')
    await wait(360)
    if (heroBox) replay(heroBox, 'ow')
  }

  async function take(action) {
    if (busy || state.over || refusal(state, action)) return
    busy = true
    pending = null
    mode = 'choose'
    blowing = blowOf(action)
    drawPanel()
    const { state: next, events } = step(state, action)
    actions.push(action)
    onProgress?.({ attempt, actions })
    let dashed = false
    for (const event of events) {
      if (bold && !still) {
        if (event.type === 'skill') await bannerFor(event.name, action)
        if (event.type === 'hit' && !dashed) {
          dashed = true
          await dash(event.target, action.kind === 'skill' || event.crit)
        }
        if (event.type === 'struck') {
          stepBack()
          await lunge(event.by)
        }
      }
      if (playEvent(event)) await wait(event.type === 'skill' ? SKILL_MS[currentLook().look] ?? EVENT_MS : EVENT_MS)
    }
    stepBack()
    state = next
    busy = false
    drawAll()
    if (state.over) return showEnd()
    if (auto) setTimeout(() => auto && !busy && !state.over && take(autoAction(state)), still ? 0 : AUTO_MS / speed)
  }

  /** Up from a lost fight, once, for what it will cost afterwards. */
  function getUp() {
    const { state: next } = step(state, { kind: 'rally' })
    actions.push({ kind: 'rally' })
    onProgress?.({ attempt, actions })
    state = next
    endBox.hidden = true
    dialog.classList.remove('ended')
    busy = false
    mode = 'choose'
    sound?.play('heal')
    drawAll()
    effect('heal', selfBox)
    line.textContent = t`你咬牙站了起来`
    if (state.over) return showEnd()
    if (auto) take(autoAction(state))
  }

  function showEnd() {
    const player = playerOf(state)
    sound?.play(state.over === 'lost' ? 'lose' : 'win')
    line.textContent = ''
    const { op } = fightResult(setup, { over: state.over, attempt, actions })
    const again = el('button', { type: 'button', class: 'battle-action', text: t`重打这场`, onclick: () => retry() })
    const row = (kind, label, value) => el('div', { class: `battle-tally ${kind}` }, [el('span', { class: 'battle-tally-name', text: label }), value])
    const things = Object.entries(op.used).map(([name, count]) => el('span', { class: 'battle-thing' }, [el('b', { text: name }), count > 1 ? el('i', { text: `×${count}` }) : null]))
    const price = [state.over === 'lost' ? t`重伤：所有属性 −2，3 天` : '', op.rallied ? t`透支：所有属性 −3，7 天` : '', op.shock ? t`理智 −${op.shock}` : ''].filter(Boolean)
    const rally = canRally(state)
    endBox.replaceChildren(el('div', { class: `battle-end-card ${state.over}` }, [
      el('div', { class: 'battle-end-word' }, [el('h2', {}, letters(el, RESULT_WORDS()[state.over])), el('i', { class: 'battle-end-seal', text: RESULT_SEALS()[state.over] })]),
      el('div', { class: 'battle-ledger' }, [
        row('rounds', t`回合`, el('b', { text: String(state.round) })),
        row('life', t`生命`, el('span', { class: 'battle-tally-life' }, [
          el('span', { class: 'battle-bar life' }, el('i', { style: `width: ${(player.life / player.maxLife) * 100}%` })),
          el('b', {}, [String(player.life), el('small', { text: `/${player.maxLife}` })]),
        ])),
        op.experience ? row('gain', t`经验`, el('b', { text: `+${op.experience}` })) : null,
        things.length ? row('things', t`用掉`, el('span', { class: 'battle-things' }, things)) : null,
        price.length ? row('cost', t`代价`, el('span', { class: 'battle-things' }, price.map(text => el('b', { text })))) : null,
      ]),
      rally ? el('p', { class: 'battle-end-note', text: t`拼命再战：生命回到四成、${energyWord}回满，再打一次。之后 7 天所有属性 −3。` }) : null,
      el('div', { class: 'battle-end-actions' }, [
        state.over === 'lost' ? again : null,
        rally ? el('button', { type: 'button', class: 'battle-action', text: t`拼命再战`, onclick: () => getUp() }) : null,
        el('button', { type: 'button', class: 'battle-action primary', text: state.over === 'lost' ? t`接受战败` : t`继续`, onclick: () => finish(state.over) }),
      ]),
    ]))
    // Nothing more to press, while the end comes on.
    busy = true
    drawPanel()
    const shown = () => {
      dialog.classList.add('ended')
      endBox.hidden = false
      endBox.querySelector('.primary').focus()
    }
    if (bold && !still) sweep(dialog, shown)
    else shown()
  }

  /** The same fight again from the start: nothing was settled yet, and the dice are new. */
  function retry() {
    attempt += 1
    state = startBattle(attemptSetup(setup, attempt))
    actions = []
    onProgress?.({ attempt, actions })
    auto = false
    autoButton.classList.remove('on')
    endBox.hidden = true
    busy = false
    dialog.classList.remove('ended')
    line.textContent = ''
    mode = 'choose'
    drawFoes()
    drawAll()
  }

  function finish(over) {
    auto = false
    close()
    onEnd?.({ over, attempt, actions })
  }

  // ─── Keys ────────────────────────────────────────────────────────
  // Before anything else on the page (vn.js listens on the document): nothing gets through to what is underneath,
  // and F5 does not reload the page in the middle of a fight.
  function onKey(event) {
    const { key } = event
    const pressed = /^[1-5]$/.test(key) || key === 'Escape' || key === 'Enter' || key === ' ' || key === 'ArrowLeft' || key === 'ArrowRight'
    event.stopImmediatePropagation()
    if (pressed || key === 'F5' || key === 'F9' || (key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey))) event.preventDefault()
    if (!endBox.hidden) {
      if (key === 'Enter' || key === ' ') document.activeElement?.click()
      return
    }
    if (busy) return
    if (key === 'Escape' && mode !== 'choose') return goBack()
    if (mode === 'target') {
      const foes = aliveFoes(state)
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        aimed = (aimed + (key === 'ArrowRight' ? 1 : foes.length - 1)) % foes.length
        return drawPanel()
      }
      if (key === 'Enter' || key === ' ') take({ ...pending, target: foes[aimed % foes.length].id })
      return
    }
    if (mode === 'choose' && /^[1-5]$/.test(key)) panel.querySelectorAll('.battle-action')[Number(key) - 1]?.click()
  }

  /** What the player goes in with: how far above them this foe is, what holds them back. */
  function openingWords() {
    const held = (setup.player.ails ?? []).map(ail => ailName(ail.name))
    const out = Math.max(...foesOf(state).map(foe => foe.gap ?? 0)) >= OUT_OF_REACH
    return [out ? t`对手强得不像话，打不过就逃` : '', held.length ? t`你带着${held.join(t`、`)}上阵` : ''].filter(Boolean).join(t`。`)
  }

  function close() {
    window.removeEventListener('keydown', onKey, true)
    dialog.close()
    dialog.remove()
  }

  dialog.addEventListener('cancel', event => event.preventDefault())
  dialog.addEventListener('click', event => {
    if (mode === 'target' && event.target.closest('.battle-field') && !event.target.closest('.battle-foe')) goBack()
  })
  window.addEventListener('keydown', onKey, true)
  setSpeed(speed)
  busy = true
  drawFoes()
  drawAll()
  document.body.append(dialog)
  dialog.showModal()
  // Not on the first button: the keys and the buttons both work from here.
  dialog.tabIndex = -1
  dialog.focus()
  enterFight(dialog).then(() => {
    busy = false
    drawPanel()
    if (!actions.length) line.textContent = openingWords()
    if (state.over) showEnd()
    else if (auto) take(autoAction(state))
  })
  return { close, showPictures }
}
