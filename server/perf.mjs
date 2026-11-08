// 性能记录 (设置 → 更多 → 性能记录): how long the server spent on a request the page asked to have timed
// (its x-perf header): reading and writing the chat, building its view and the prompt, waiting for the model.
// Off, nothing is kept: a request without the header runs outside any trace, and span() is one lookup.
import { AsyncLocalStorage } from 'node:async_hooks'

const traces = new AsyncLocalStorage()
const NOOP = () => {}

/** Runs `fn` with a trace of its own when `on`; the trace is `trace()` inside it. */
export function traced(on, fn) {
  return on ? traces.run({ spans: [], startedAt: performance.now() }, fn) : fn()
}

/** The running request's trace, or undefined when it is not timed. */
export const trace = () => traces.getStore()

/**
 * Starts timing `name` in the running request's trace; the function it gives ends it (`extra`: sizes, counts).
 * Spans of one name add up: { name, ms, count, ...the last extra }.
 */
export function span(name, detail) {
  const current = traces.getStore()
  if (!current) return NOOP
  const startedAt = performance.now()
  return extra => {
    const ms = performance.now() - startedAt
    const same = current.spans.find(item => item.name === name)
    if (same) Object.assign(same, detail, extra, { ms: same.ms + ms, count: same.count + 1 })
    else current.spans.push({ name, ms, count: 1, ...detail, ...extra })
  }
}

/** `fn`'s result, timed as `name` when the request is timed. */
export async function timed(name, fn, detail) {
  const end = span(name, detail)
  try {
    return await fn()
  } finally {
    end()
  }
}

/** The trace as it goes back to the page: spans rounded, the request's whole time. */
export function traceReport(current = traces.getStore()) {
  if (!current) return null
  return {
    total: Math.round((performance.now() - current.startedAt) * 10) / 10,
    spans: current.spans.map(item => ({ ...item, ms: Math.round(item.ms * 10) / 10 })),
  }
}
