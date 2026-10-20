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

/**
 * The notes due after an update, newest first: every version after the one
 * last seen, up to the one running. Seen nothing yet: someone who already
 * played (`returning`) gets the running version's; a new player nothing.
 * @param versions - notes.json's versions ({ version, items }).
 */
export function notesToShow(versions, { current, seen = '', returning = false } = {}) {
  const list = (Array.isArray(versions) ? versions : [])
    .filter(entry => entry?.version && Array.isArray(entry.items) && entry.items.length && compareVersions(entry.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
  if (!seen) return returning ? list.filter(entry => compareVersions(entry.version, current) === 0) : []
  return list.filter(entry => compareVersions(entry.version, seen) > 0)
}
