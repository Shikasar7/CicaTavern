// The regexes a card, a preset or a lorebook brings run here with a bound on
// their time. One that backtracks without end (/^(a+)+$/ on a long run of a's)
// held the whole server, every chat and the phone app, until it was killed.
//
// V8 goes on with its linear-time engine once a match backtracks too much; the
// `l` flag (that engine only) says which patterns it can run. The others (case-
// insensitive or unicode ones, lookarounds, backreferences, large counts…) are
// matched in a worker thread (regex-worker.mjs) and waited for at most
// DEADLINE_MS; one that runs past it is left out from then on.
import v8 from 'node:v8'
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads'
import { applyScripts as applyEach } from '../web/shared/regex.js'

v8.setFlagsFromString('--enable-experimental-regexp-engine')
v8.setFlagsFromString('--enable-experimental-regexp-engine-on-excessive-backtracks')

const DEADLINE_MS = 250
// The worker's own start (slower on a phone) is not the pattern's time.
const STARTUP_MS = 10_000

const linear = new Map() // `${flags}/${source}` → whether the linear engine runs it
const slow = new Set() // patterns that ran past the deadline
// What the worker found, by pattern and text, the oldest let go past FOUND_CHARS: each turn sends the history
// through the same scripts again.
const found = new Map()
const FOUND_CHARS = 4_000_000
let foundChars = 0
let runner = null // { worker, port, signal }
let report = () => {}

const keyOf = regex => `${regex.flags}/${regex.source}`

/** `fn(regex)` for each pattern left out for running too long (the error log, server/http.mjs). */
export function onSlowPattern(fn) {
  report = fn
}

function runsLinear(regex) {
  const key = keyOf(regex)
  if (!linear.has(key)) {
    let runs = false
    try {
      new RegExp(regex.source, `${regex.flags}l`)
      runs = true
    } catch {
      // Not one that engine takes.
    }
    linear.set(key, runs)
  }
  return linear.get(key)
}

function startRunner() {
  const signal = new Int32Array(new SharedArrayBuffer(8))
  const { port1, port2 } = new MessageChannel()
  const worker = new Worker(new URL('./regex-worker.mjs', import.meta.url), { workerData: { port: port2, signal }, transferList: [port2] })
  // Never what keeps the server running.
  worker.unref()
  port1.unref()
  worker.on('error', () => {
    if (runner?.worker === worker) runner = null
  })
  return { worker, port: port1, signal }
}

function stopRunner() {
  runner?.worker.terminate().catch(() => {})
  runner?.port.close()
  runner = null
}

/**
 * Every match of `regex` in `text` as matchAll gives them (the first only, unless global), worked out in the
 * worker: null past the deadline, undefined when there is no worker to ask (then it runs here, as before).
 */
function workerMatches(regex, text) {
  try {
    runner ??= startRunner()
  } catch {
    return undefined
  }
  const { port, signal } = runner
  if (Atomics.load(signal, 1) !== 1 && Atomics.wait(signal, 1, 0, STARTUP_MS) === 'timed-out') {
    stopRunner()
    return undefined
  }
  Atomics.store(signal, 0, 0)
  port.postMessage({ source: regex.source, flags: regex.flags, text })
  const deadline = Date.now() + DEADLINE_MS
  for (;;) {
    const state = Atomics.wait(signal, 0, 0, Math.max(0, deadline - Date.now()))
    const reply = receiveMessageOnPort(port)
    if (reply) return Array.isArray(reply.message) ? reply.message : undefined
    if (state === 'timed-out' || Date.now() >= deadline) {
      stopRunner()
      return null
    }
  }
}

function matchesOf(regex, text) {
  const key = `${keyOf(regex)}\u0000${text}`
  const known = found.get(key)
  if (known) {
    found.delete(key)
    found.set(key, known)
    return known
  }
  const matches = workerMatches(regex, text)
  if (matches) {
    found.set(key, matches)
    foundChars += key.length
    for (const [old] of found) {
      if (foundChars <= FOUND_CHARS) break
      found.delete(old)
      foundChars -= old.length
    }
  }
  return matches
}

function tooSlow(regex) {
  slow.add(keyOf(regex))
  report(regex)
}

/** text.replace(regex, replacer), the matching done within the deadline; past it, `text` as it was. */
export function guardedReplace(text, regex, replacer) {
  if (slow.has(keyOf(regex))) return text
  if (runsLinear(regex)) return text.replace(regex, replacer)
  const matches = matchesOf(regex, text)
  if (matches === undefined) return text.replace(regex, replacer)
  if (matches === null) {
    tooSlow(regex)
    return text
  }
  let out = ''
  let last = 0
  for (const match of matches) {
    // As String.prototype.replace calls it: the match, its groups, where, the text, and the named groups if any.
    out += text.slice(last, match.index) + replacer(...match.groups, match.index, text, ...(match.named ? [match.named] : []))
    last = match.index + match.groups[0].length
  }
  return out + text.slice(last)
}

/** Whether `regex` matches somewhere in `text`, within the deadline; past it, no. */
export function guardedTest(regex, text) {
  if (slow.has(keyOf(regex))) return false
  // Whether it matches at all: a global pattern's lastIndex is no part of it.
  const once = regex.global ? new RegExp(regex.source, regex.flags.replace('g', '')) : regex
  if (runsLinear(once)) return once.test(text)
  const matches = matchesOf(once, text)
  if (matches === undefined) return once.test(text)
  if (matches === null) {
    tooSlow(regex)
    return false
  }
  return matches.length > 0
}

/** applyScripts (web/shared/regex.js) with each pattern run as guardedReplace runs it. */
export function applyScripts(text, scripts, options) {
  return applyEach(text, scripts, { ...options, replace: guardedReplace })
}
