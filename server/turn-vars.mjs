// 这轮变量没更新上: what went wrong with the variables in one reply, worked out when the turn is written (and again
// after 补写变量 or 修好), kept on the reply as `varIssues` for the page to list. Each item is one of
//   { kind: 'unread', text }               a piece of the update block that could not be read
//   { kind: 'idle', path, why, text }      a command that changed nothing (why: missing, notNumber, noFrom, nothing)
//   { kind: 'unknown', path, near, text }  a variable the card does not have (`near`: a name it has that is close)
//   { kind: 'rule', path, why, text }      what the card's variable rules (Zod) rejected; no path when it cannot tell
//                                          which command it was (`earlier` when the variables broke them already)
// The page words them (web/app.js varIssueLine); issueLines words them for the model that puts them right.
import { applyCommands, lostPaths, updateSteps } from './state.mjs'

const MAX_ITEMS = 20
const MAX_TEXT = 200
// Finding the command the rules reject runs them once per command: not for a long update, nor for long.
const MAX_TRIES = 40
const TRY_MS = 2000

const clip = (text, max = MAX_TEXT) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/**
 * @param before - the variables before the reply's update ran
 * @param text - the reply as it is kept
 * @param written - the variables after the update, before the rules
 * @param kept - { state, problem } the rules made of `written` (keepToSchema); { state: written } for a card without
 * @param check - state → Promise<problem | undefined> by the card's rules, or null for a card without them
 * @param scripted - the card's scripts ran the update: what they made of the commands is theirs, so only what could
 *   not be read and what the rules said are told
 * @param initial - the card's starting variables (a name there is the card's own, whatever the chat has)
 * @returns the items, at most MAX_ITEMS
 */
export async function turnVarIssues({ before, text, written, kept, check = null, scripted = false, initial = {} }) {
  const { lost, steps } = updateSteps(before ?? {}, text)
  const items = lost.map(piece => ({ kind: 'unread', text: clip(piece) }))
  if (!scripted) {
    for (const step of steps) if (step.did === 'idle') items.push({ kind: 'idle', path: step.path, why: step.why, text: clip(step.text) })
    const dropped = check && !kept?.problem ? lostPaths(written, kept?.state) : null
    const told = new Set()
    for (const step of steps) {
      if (step.did !== 'new' || told.has(step.added)) continue
      const near = nearName(before, initial, step.added)
      // With rules that passed, what they dropped is not the card's. Without rules (or with rules that failed, so
      // dropped nothing), a new name is often a new character or item: only one a letter or two off a name the card
      // has is told.
      const unknown = dropped ? dropped.some(path => step.added === path || step.added.startsWith(`${path}.`)) : !step.group && near && !has(initial, step.added)
      if (!unknown) continue
      told.add(step.added)
      items.push({ kind: 'unknown', path: step.added, near: near ?? undefined, text: clip(step.text) })
    }
  }
  if (kept?.problem) items.push(...(await ruleItems({ before, steps: scripted ? [] : steps, problem: kept.problem, check })))
  return items.slice(0, MAX_ITEMS)
}

/**
 * What the rules rejected, command by command: each is added to the variables before the reply in turn, and one
 * that makes them fail the rules is told (and left out, so the next is tried on what passed). When the variables
 * failed the rules before the reply already (an earlier turn left them so), the commands that write what the rules
 * name are told instead; none, and the rules' own words for the whole, `earlier` set. Too many commands to try, or
 * none of them alone does it: the rules' own words.
 */
async function ruleItems({ before, steps, problem, check }) {
  const whole = extra => [{ kind: 'rule', why: clip(problem, 300), ...extra }]
  if (!check || !steps.length || steps.length > MAX_TRIES) return whole()
  if (await check(before)) {
    const said = ruleLines(problem)
    const found = steps.flatMap(step => {
      const lines = said.filter(line => line.path === step.path || line.path.startsWith(`${step.path}.`) || step.path.startsWith(`${line.path}.`))
      return lines.length ? [{ kind: 'rule', path: step.path, why: clip(lines.map(line => line.text).join('; '), 300), text: clip(step.text) }] : []
    })
    return found.length ? found : whole({ earlier: true })
  }
  const until = Date.now() + TRY_MS
  const found = []
  let state = before
  for (const step of steps) {
    if (Date.now() > until) return whole()
    const next = applyCommands(state, [step.command]).state
    const failed = await check(next)
    if (failed) found.push({ kind: 'rule', path: step.path, why: clip(failed, 300), text: clip(step.text) })
    else state = next
  }
  return found.length ? found : whole()
}

/** The rules' words, one per variable they name (server/schema-z.mjs: 「金钱: 要是 number; 好感: 大于 100」). */
function ruleLines(problem) {
  return String(problem ?? '').split('; ').map(text => ({ text, path: text.includes(': ') ? text.slice(0, text.indexOf(': ')) : '' })).filter(line => line.path && line.path !== '（根）')
}

const has = (root, path) => path.split('.').reduce((at, key) => (at && typeof at === 'object' && Object.hasOwn(at, key) ? at[key] : undefined), root) !== undefined

/** A name beside `path`'s last key, in the variables or the card's starting ones, that it is likely a slip for. */
function nearName(before, initial, path) {
  const keys = path.split('.')
  const name = keys.at(-1)
  const parent = keys.slice(0, -1)
  const siblings = new Set()
  for (const root of [before, initial]) {
    const holder = parent.reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), root)
    if (holder && typeof holder === 'object' && !Array.isArray(holder)) for (const key of Object.keys(holder)) if (key !== name) siblings.add(key)
  }
  const close = [...siblings].filter(other => likely(name, other))
  return close.length === 1 ? [...parent, close[0]].join('.') : null
}

/** 好感 and 好感度, 金钱 and 金錢, hp and HP: one inside the other, a letter apart, or the same but for case. */
function likely(a, b) {
  if (a.toLowerCase() === b.toLowerCase()) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length >= 2 && long.length - short.length <= 2 && long.includes(short)) return true
  return short.length >= 2 && short.length === long.length && [...short].filter((ch, at) => ch !== long[at]).length === 1
}

const WHY = {
  missing: '要删的这一项本来就没有',
  notNumber: '原来的值不是数字，加减不了',
  noFrom: '要搬的那一项不存在',
  nothing: '没有改动任何变量',
}

/** The items as the model that puts them right reads them: one line each. */
export function issueLines(items) {
  return (items ?? []).map(item => {
    const said = item.text ? `（原文：${item.text}）` : ''
    if (item.kind === 'unread') return `- 有一条更新格式写错了，程序读不出来，没有生效${said}`
    if (item.kind === 'idle') return `- 「${item.path}」这条没有生效：${WHY[item.why] ?? WHY.nothing}${said}`
    if (item.kind === 'unknown') return `- 卡里没有「${item.path}」这个变量，这条被丢掉了${item.near ? `，应该是「${item.near}」` : ''}${said}`
    if (item.kind === 'rule' && item.path) return `- 「${item.path}」不符合卡的变量规则：${item.why}${said}`
    if (item.kind === 'rule' && item.earlier) return `- 本轮之前的变量就不符合卡的变量规则，规则整轮没生效，这一轮的更新要把它改对：${item.why}`
    if (item.kind === 'rule') return `- 这一轮的变量不符合卡的变量规则，规则整轮没生效：${item.why}`
    return ''
  }).filter(Boolean)
}

/**
 * What 修好 changed in the variables, for the line under the reply: { path, from, to } of each value that differs
 * (a list counts as one value), each value as short text ('' where there was none).
 */
export function stateDiff(before, after) {
  const flat = (value, path, out) => {
    const plain = value && typeof value === 'object' && !Array.isArray(value)
    if (!plain || path.length >= 6) {
      if (path.length) out.set(path.join('.'), value)
      return out
    }
    for (const [key, item] of Object.entries(value)) flat(item, [...path, key], out)
    return out
  }
  const a = flat(before ?? {}, [], new Map())
  const b = flat(after ?? {}, [], new Map())
  // An old MVU value is [value, "description"]: its value is what changed.
  const bare = value => (Array.isArray(value) && value.length === 2 && typeof value[1] === 'string' && (value[0] === null || typeof value[0] !== 'object') ? value[0] : value)
  const shown = value => (value === undefined ? '' : typeof bare(value) === 'string' ? clip(bare(value), 40) : clip(JSON.stringify(bare(value)), 40))
  const changed = []
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (JSON.stringify(a.get(path)) !== JSON.stringify(b.get(path))) changed.push({ path, from: shown(a.get(path)), to: shown(b.get(path)) })
  }
  return changed
}
