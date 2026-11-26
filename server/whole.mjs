// An answer that stopped at the output limit, written on from where it stopped: how the two join, whether asking on is
// worth it, and (completeWhole) a request asked on till its answer is whole. The limits themselves are providers.mjs's.
import { complete } from './providers.mjs'

/** The reply as it was and what the model wrote on: a start that repeats the reply's last words goes. */
export function joinContinued(before, more) {
  const start = String(before ?? '')
  let tail = String(more ?? '')
  if (/\s$/.test(start)) tail = tail.replace(/^\s+/, '')
  const end = start.slice(-400)
  for (let n = Math.min(end.length, tail.length); n >= 8; n--) {
    if (end.endsWith(tail.slice(0, n))) {
      tail = tail.slice(n)
      break
    }
  }
  return start + tail
}

/**
 * What a reply written on shows as it comes: the words that repeat the reply's end are held back till it is known which
 * they are. `push` and `end` give the text to show (joinContinued's, a piece at a time).
 */
export function joinedStream(before) {
  const end = String(before ?? '').slice(-400)
  let held = ''
  let open = true
  const release = () => {
    open = false
    return joinContinued(end, held).slice(end.length)
  }
  return {
    push(delta) {
      if (!open) return delta
      held += delta
      const start = /\s$/.test(end) ? held.replace(/^\s+/, '') : held
      return end.includes(start) ? '' : release()
    },
    end: () => (open ? release() : ''),
  }
}

/**
 * Text going round in circles: its last words came at least twice just before. A model stuck so runs into any limit,
 * and asking it on only costs more.
 */
export function goesRound(text) {
  const all = String(text ?? '').trimEnd()
  for (const size of [40, 120, 400]) {
    if (all.length < size * 3) break
    const last = all.slice(-size)
    // One character over and over (a rule of dashes) counts too.
    const at = all.lastIndexOf(last, all.length - size - 1)
    if (at < 0) continue
    const step = all.length - size - at
    if (step > 0 && all.length >= size + step * 3 && all.slice(-size - step * 2, -step * 2) === last && all.slice(-step) === all.slice(-step * 2, -step)) return true
  }
  return false
}

// How often an answer is asked on.
const ROUNDS = 3
// The most a request that thought its whole cap away is asked again with.
const THINKING_CAP = 64000

const WRITE_ON = '（你的回答写到这里，被单次输出的上限截断了。从断开的地方直接接着写：第一个字紧接着上面最后一个字，不要从头再来，不要重复已经写过的内容，不要加说明或代码围栏。写到一半的字符串、数组和标签接着写完，直到整个回答写完。前面已经想好了，不用再想，直接写。）'

const squeezed = (text, length) => String(text ?? '').replace(/\s+/g, '').slice(0, length)

/** A made answer (JSON, tags) and what was written on: one begun over from the top stands by itself, a fence put in front goes. */
export function joinWhole(before, more) {
  const start = String(before ?? '')
  const tail = String(more ?? '').replace(/^\s*```(?:json|xml|html)?[ \t]*\n/i, '')
  const head = squeezed(start, 60)
  if (head.length >= 40 && squeezed(tail, 60) === head) return tail.length > start.length / 2 ? tail : start
  return joinContinued(start, tail)
}

const addUsage = (a, b) => (a && b ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key, key === 'prompt' ? a[key] ?? b[key] : (a[key] ?? 0) + (b[key] ?? 0)])) : a ?? b)

/**
 * complete(), and an answer cut off at the output limit asked on till it is whole (three times at most). One whose
 * thinking took the whole limit is asked once more, with less thinking and more room.
 * @param onMore - called before each further request, with its number.
 * @returns complete()'s result, the text joined, the usage of all of them; `more`, how many more it took.
 */
export async function completeWhole(provider, modelId, request, options, { rounds = ROUNDS, onMore = () => {} } = {}) {
  let result = await complete(provider, modelId, request, options)
  let more = 0
  let asked = request
  if (result.truncated && !result.text.trim() && result.reasoned && !request.signal?.aborted) {
    onMore(++more)
    asked = { ...request, reasoning: { ...request.reasoning, thinking: 'off', effort: 'low' }, ...(request.softCap && request.maxTokens ? { maxTokens: Math.max(request.maxTokens, THINKING_CAP) } : {}) }
    const again = await complete(provider, modelId, asked, options)
    result = { ...again, usage: addUsage(result.usage, again.usage) }
  }
  for (let round = 0; round < rounds && result.truncated && result.text.trim() && !goesRound(result.text) && !request.signal?.aborted; round++) {
    onMore(++more)
    const so = result.text
    const messages = [...asked.messages, { role: 'assistant', content: so.trimEnd(), tail: true }, { role: 'user', content: WRITE_ON, tail: true }]
    // Begun afresh (the relay lost the system prompt): what was written before it stays.
    const onRestart = request.onRestart && (() => {
      request.onRestart()
      request.onDelta?.(so)
    })
    let next
    try {
      next = await complete(provider, modelId, { ...asked, messages, onRestart }, options)
    } catch (error) {
      // What there is may still do: its reader says so if not.
      if (request.signal?.aborted) throw error
      break
    }
    if (!next.text.trim()) {
      result = { ...result, usage: addUsage(result.usage, next.usage) }
      break
    }
    result = { ...next, text: joinWhole(so, next.text), usage: addUsage(result.usage, next.usage) }
  }
  return more ? { ...result, more } : result
}
