// 更新了什么: after an update, a few pages on what is new — a picture, a title,
// a few lines each — from web/whatsnew/notes.json, written with each release
// (pictures beside it, named after their version). Shown once per version;
// opened again from the version under the app's name, or 设置 → 更多 → 更新,
// where the version over the pages also turns back to an earlier series'.
import { lang, t } from '/i18n.js'
import { compareVersions, notesToShow, seriesNotes, seriesOf, shelfOf } from '/shared/whatsnew.js'

const SEEN_KEY = 'cicatavern.seenVersion'

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
    // Private mode: shown again next time.
  }
}

export function initWhatsNew({ el }) {
  const badge = document.getElementById('whatsnew-open')
  let current = ''
  let notes = null
  let dialog = null
  let pages = []
  let shelf = []
  let at = 0

  async function load() {
    notes ??= await fetch('/whatsnew/notes.json').then(res => (res.ok ? res.json() : null)).catch(() => null)
    return Array.isArray(notes?.versions) ? notes.versions : []
  }

  /**
   * At page start: the version under the app's name, and this version's notes
   * once after an update.
   * @param returning - the player has cards already (not a first start).
   */
  async function boot({ version, returning }) {
    current = String(version ?? '')
    if (!current) return
    badge.textContent = `v${current}`
    badge.hidden = false
    const seen = recall(SEEN_KEY, '')
    if (seen && compareVersions(seen, current) >= 0) return
    const due = notesToShow(await load(), { current, seen, returning })
    if (!due.length) return remember(SEEN_KEY, current)
    badge.classList.add('unread')
    open(due)
  }

  /** The notes of `entries`, else of the running version's series (or the newest there are): 1.8.1, then 1.8.0. */
  async function open(entries) {
    const versions = (await load()).slice().sort((a, b) => compareVersions(b.version, a.version))
    const newest = versions.find(entry => compareVersions(entry.version, current) <= 0) ?? versions[0]
    shelf = shelfOf(versions, current)
    show(entries ?? (newest ? seriesNotes(versions, newest.version) : []))
    if (!pages.length) return
    if (!dialog) {
      dialog = el('dialog', { class: 'dialog whatsnew', 'aria-label': t`更新了什么` })
      dialog.addEventListener('close', () => {
        remember(SEEN_KEY, current)
        badge.classList.remove('unread')
      })
      dialog.addEventListener('keydown', event => {
        if (event.target.closest('select')) return
        if (event.key === 'ArrowRight') go(1)
        else if (event.key === 'ArrowLeft') go(-1)
      })
      document.body.append(dialog)
    }
    render()
    if (!dialog.open) dialog.showModal()
  }

  /** `list`'s pages from the first, a recap of an earlier series last. */
  function show(list) {
    pages = list
      .flatMap(entry => (entry.items ?? []).map(item => ({ version: entry.version, date: entry.date ?? '', image: item.image ?? '', icon: item.icon ?? '', recap: item.recap ?? '', ...(item[lang] ?? item.zh ?? {}) })))
      .sort((a, b) => Boolean(a.recap) - Boolean(b.recap))
    at = 0
    // The pictures load while the first page is read.
    for (const page of pages) if (page.image) new Image().src = `/whatsnew/${page.image}`
  }

  /** The picker: another series' pages, read from the first. */
  async function turnTo(series) {
    const shelved = shelf.find(item => item.series === series)
    if (!shelved) return
    show(seriesNotes(await load(), shelved.version))
    if (pages.length) render()
  }

  function go(step) {
    const next = at + step
    if (next < 0 || next >= pages.length) return
    at = next
    render()
  }

  function render() {
    const page = pages[at]
    const last = at === pages.length - 1
    const picture = page.image
      ? el('img', { src: `/whatsnew/${page.image}`, alt: page.title ?? '' })
      : el('div', { class: 'whatsnew-icon', 'aria-hidden': 'true', text: page.icon || '✦' })
    const dots = el('div', { class: 'whatsnew-dots' }, pages.map((_, i) => {
      const dot = el('button', { type: 'button', class: i === at ? 'on' : '', 'aria-label': t`第 ${i + 1} 项`, onclick: () => { at = i; render() } })
      return dot
    }))
    // With more than one series, the version picks which one to read; the page's own version goes by its date.
    const picker = shelf.length > 1
    const when = [picker ? page.version : '', page.date].filter(Boolean).join(' · ')
    dialog.replaceChildren(
      el('div', { class: 'whatsnew-head' }, [
        el('span', { class: 'whatsnew-kicker', text: t`更新了什么` }),
        picker
          ? el('select', { class: 'whatsnew-series', 'aria-label': t`看哪一版的更新`, onchange: event => turnTo(event.target.value) },
            shelf.map(({ series }) => el('option', { value: series, text: `CicaTavern ${series}`, selected: series === seriesOf(page.version) })))
          : el('b', { text: `CicaTavern ${page.version}` }),
        when ? el('span', { class: 'muted small', text: when }) : null,
        el('form', { method: 'dialog', class: 'whatsnew-x' }, [el('button', { class: 'btn ghost icon', 'aria-label': t`关闭`, text: '✕' })]),
      ]),
      el('figure', { class: 'whatsnew-figure' }, [picture]),
      el('div', { class: 'whatsnew-body' }, [el('h3', { text: page.title ?? '' }), el('p', { text: page.text ?? '' })]),
      el('div', { class: 'whatsnew-foot' }, [
        dots,
        el('span', { class: 'muted small', text: `${at + 1} / ${pages.length}` }),
        el('button', { type: 'button', class: 'btn', text: t`上一项`, disabled: at === 0, onclick: () => go(-1) }),
        last
          ? el('form', { method: 'dialog' }, [el('button', { class: 'btn primary', text: t`开始体验` })])
          : el('button', { type: 'button', class: 'btn primary', text: t`下一项`, onclick: () => go(1) }),
      ]),
    )
    dialog.querySelector('.whatsnew-foot .primary')?.focus()
  }

  badge?.addEventListener('click', () => open())
  return { boot, open: () => open() }
}
