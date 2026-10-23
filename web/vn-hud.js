// 游戏式 HUD in the visual novel mode (web/vn.js): a few of the story's
// variables in the corner, each a bar, a number or an icon (chosen per card on
// this device; by default the layout's first few numbers), and what a reply
// changed popping up as the player reaches its end (好感 +5, 获得：铜钥匙).
// Only reads the chat's state (web/shared/hud.js); the model is asked for nothing.
import { t } from '/i18n.js'
import { hudPicks, hudRows } from '/shared/hud.js'

// Per card: { paths, looks } — what the player chose to keep and how.
const PICKS_KEY = 'cicatavern.vnHud'
// How long a note stays, and the gap between notes popping up together.
const NOTE_MS = 3200
const NOTE_GAP = 260

function recall(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback
  } catch {
    return fallback
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode: kept for this page only.
  }
}

const signed = n => (n > 0 ? `+${n}` : `−${Math.abs(n)}`)
const shown = n => String(Math.round(n * 100) / 100)

/**
 * @param deps.prefs - the mode's settings (prefs.hud, prefs.hudNotes: false turns them off); deps.savePrefs keeps them.
 * @param deps.open - () opens the HUD's settings (a click on the HUD).
 */
export function initVnHud({ el, prefs, savePrefs, open }) {
  const box = el('div', { class: 'vn-hud', hidden: true, title: t`HUD：点一下选显示哪些变量` })
  const notes = el('div', { class: 'vn-notes', 'aria-live': 'polite' })
  box.addEventListener('click', event => {
    event.stopPropagation()
    open()
  })
  // The rows on screen by path, kept between draws so a bar slides to its new length.
  const rowsOn = new Map()
  // What the HUD last drew: { cardId, spec, state }.
  let last = null

  const savedFor = cardId => recall(PICKS_KEY, {})[cardId] ?? null
  const picksOf = (cardId, spec) => hudPicks(spec, savedFor(cardId))

  function rowNode(row) {
    const value = el('b', { class: 'vn-hud-value' })
    const parts = row.look === 'icon'
      ? [el('span', { class: 'vn-hud-icon', 'aria-hidden': 'true', text: row.icon }), value]
      : row.look === 'meter'
        ? [el('span', { class: 'vn-hud-label' }), el('span', { class: 'vn-hud-bar' }, el('i')), value]
        : [el('span', { class: 'vn-hud-label' }), value]
    return el('div', { class: `vn-hud-row look-${row.look}` }, parts)
  }

  /** The HUD showing `state` (the one before a reply until the player reaches its end). */
  function draw({ cardId, spec, state }) {
    last = { cardId, spec, state }
    const rows = prefs.hud === false || !spec ? [] : hudRows(spec, picksOf(cardId, spec), state)
    const nodes = rows.map(row => {
      let item = rowsOn.get(row.path)
      if (!item || item.look !== row.look) item = { look: row.look, node: rowNode(row), value: undefined }
      rowsOn.set(row.path, item)
      const { node } = item
      node.title = row.label
      node.querySelector('.vn-hud-label')?.replaceChildren(row.label)
      const value = node.querySelector('.vn-hud-value')
      value.textContent = row.look !== 'text' ? shown(row.value) : row.on === undefined ? row.text : row.on ? t`是` : t`否`
      if (row.look === 'meter') node.querySelector('.vn-hud-bar i').style.width = `${row.percent.toFixed(1)}%`
      // A number that moved: it lights up for a moment.
      if (typeof row.value === 'number' && typeof item.value === 'number' && row.value !== item.value) {
        node.classList.remove('bump', 'up', 'down')
        void node.offsetWidth
        node.classList.add('bump', row.value > item.value ? 'up' : 'down')
      }
      item.value = row.value
      return node
    })
    for (const path of [...rowsOn.keys()]) if (!rows.some(row => row.path === path)) rowsOn.delete(path)
    box.replaceChildren(...nodes)
    box.hidden = !nodes.length
  }

  /** What a reply changed, each a note popping up for a moment (web/shared/hud.js changeNotes). */
  function notify(list) {
    if (prefs.hudNotes === false) return
    list.forEach((note, i) => {
      const text = note.kind === 'up' || note.kind === 'down'
        ? `${note.label} ${signed(note.delta)}`
        : note.kind === 'gain'
          ? t`获得：${note.item}${note.count > 1 ? ` ×${note.count}` : ''}`
          : note.kind === 'lose'
            ? t`失去：${note.item}${note.count > 1 ? ` ×${note.count}` : ''}`
            : note.kind === 'on' ? t`${note.label}：是` : t`${note.label}：否`
      const pill = el('div', { class: `vn-note ${note.kind}`, text, style: `--delay: ${i * NOTE_GAP}ms` })
      notes.append(pill)
      setTimeout(() => pill.remove(), NOTE_MS + i * NOTE_GAP)
    })
  }

  function clear() {
    box.hidden = true
    box.replaceChildren()
    rowsOn.clear()
    notes.replaceChildren()
    last = null
  }

  /**
   * The settings (the ▾ menu's body): the HUD and its notes on or off, then
   * every variable the layout has, ticked if kept, with its look.
   * @param redraw - () draws the menu again after a change.
   */
  function settings(redraw) {
    if (!last?.spec) return [el('p', { class: 'muted small', text: t`这个对话还没有变量。角色卡用 MVU 变量或状态栏时，这里可以挑几个常驻在画面角落。` })]
    const { cardId, spec, state } = last
    const picks = picksOf(cardId, spec)
    const save = next => {
      const all = recall(PICKS_KEY, {})
      if (next) all[cardId] = next
      else delete all[cardId]
      remember(PICKS_KEY, all)
      draw(last)
      redraw()
    }
    const asSaved = () => ({ paths: picks.map(pick => pick.path), looks: Object.fromEntries(picks.map(pick => [pick.path, pick.look])) })
    const switchRow = (text, hint, on, onChange) => {
      const input = el('input', { type: 'checkbox', class: 'switch', checked: on })
      input.addEventListener('change', () => onChange(input.checked))
      return el('label', { class: 'vn-pop-switch' }, [el('span', {}, [text, el('small', { text: hint })]), input])
    }
    const lookNames = { meter: t`条`, number: t`数字`, icon: t`图标` }
    const fields = spec.fields.filter(field => field.show !== 'hidden')
    const rowsNow = hudRows(spec, fields.map(field => ({ path: field.path, look: 'text' })), state)
    const list = fields.map(field => {
      const kept = picks.find(pick => pick.path === field.path)
      const now = rowsNow.find(row => row.path === field.path)
      const tick = el('input', { type: 'checkbox', checked: Boolean(kept) })
      tick.addEventListener('change', () => {
        const next = asSaved()
        if (tick.checked) {
          next.paths.push(field.path)
          next.looks[field.path] = field.show === 'meter' || field.show === 'number' ? field.show : 'text'
        } else next.paths = next.paths.filter(path => path !== field.path)
        save(next)
      })
      const numeric = field.show === 'meter' || field.show === 'number'
      const looks = numeric && kept
        ? el('span', { class: 'seg small' }, Object.entries(lookNames).map(([look, text]) => {
          const b = el('button', { type: 'button', 'aria-pressed': String(kept.look === look), text })
          b.addEventListener('click', () => {
            const next = asSaved()
            next.looks[field.path] = look
            save(next)
          })
          return b
        }))
        : null
      return el('div', { class: 'vn-hud-pick' }, [
        el('label', {}, [tick, el('span', { text: now?.label ?? field.label ?? field.path }), el('small', { class: 'muted', text: now?.on === undefined ? now?.text ?? '' : now.on ? t`是` : t`否` })]),
        looks,
      ])
    })
    return [
      switchRow(t`显示 HUD`, t`常驻在画面左上角，点一下回到这里`, prefs.hud !== false, on => {
        prefs.hud = on
        savePrefs()
        draw(last)
        redraw()
      }),
      switchRow(t`数值变化提示`, t`读到一轮的结尾时，弹出「好感 +5」「获得：铜钥匙」`, prefs.hudNotes !== false, on => {
        prefs.hudNotes = on
        savePrefs()
        redraw()
      }),
      el('p', { class: 'muted small', text: t`常驻显示哪些（这张卡，这台设备）：` }),
      el('div', { class: 'vn-hud-picks' }, list),
      el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small', text: t`恢复默认`, title: t`默认显示前几个数值（好感、体力、金钱……）`, onclick: () => save(null) })]),
    ]
  }

  return { box, notes, draw, notify, clear, settings }
}
