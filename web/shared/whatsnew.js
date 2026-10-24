// 更新了什么 (web/whatsnew.js): which versions' notes to show. Shared with the tests.

/** a < b → negative, a > b → positive; "1.10.0" after "1.9.2"; a missing part counts as 0. */
export function compareVersions(a, b) {
  const parts = value => String(value ?? '').split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/** The release series a version belongs to: 1.8.1 → "1.8". */
export const seriesOf = version => String(version ?? '').split(/[.-]/).slice(0, 2).map(part => Number.parseInt(part, 10) || 0).join('.')

/** Notes with pages, up to the one running. */
const shippedUpTo = (versions, current) => (Array.isArray(versions) ? versions : [])
  .filter(entry => entry?.version && Array.isArray(entry.items) && entry.items.length && compareVersions(entry.version, current) <= 0)

/**
 * A series' notes as they read: the release first, then the fixes after it
 * (1.8.0, 1.8.1), up to the one running.
 */
export function seriesNotes(versions, version) {
  return shippedUpTo(versions, version)
    .filter(entry => seriesOf(entry.version) === seriesOf(version))
    .sort((a, b) => compareVersions(a.version, b.version))
}

/**
 * The notes due after an update: every version after the one last seen, up to
 * the one running. A series any of whose versions is due shows whole (an update
 * to 1.8.1 shows 1.8.0's pages, then 1.8.1's), newest series first. Seen
 * nothing yet: someone who already played (`returning`) gets the running
 * version's series; a new player nothing.
 * @param versions - notes.json's versions ({ version, items }).
 */
export function notesToShow(versions, { current, seen = '', returning = false } = {}) {
  const list = shippedUpTo(versions, current).sort((a, b) => compareVersions(b.version, a.version))
  const due = !seen
    ? (returning ? list.filter(entry => compareVersions(entry.version, current) === 0) : [])
    : list.filter(entry => compareVersions(entry.version, seen) > 0)
  const series = [...new Set(due.map(entry => seriesOf(entry.version)))]
  const notes = series.map(name => seriesNotes(list, list.find(entry => seriesOf(entry.version) === name).version))
  // A page recapping an earlier series ("recap": "1.8") stands for that series' pages.
  const recapped = new Set(notes.flat().flatMap(entry => entry.items.map(item => item?.recap).filter(Boolean).map(seriesOf)))
  return notes.filter((_, i) => !recapped.has(series[i])).flat()
}

/** The series there are notes for, up to the one running, newest first, each with its newest version: the picker in 更新了什么. */
export function shelfOf(versions, current) {
  const shelf = []
  for (const entry of shippedUpTo(versions, current).sort((a, b) => compareVersions(b.version, a.version))) {
    const series = seriesOf(entry.version)
    if (!shelf.some(item => item.series === series)) shelf.push({ series, version: entry.version })
  }
  return shelf
}
