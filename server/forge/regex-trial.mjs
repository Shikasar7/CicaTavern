// A proposed regex tried on the chat's latest reply before the user takes it
// (regex-edit.mjs): run in a worker thread and stopped after TIMEOUT, since a
// pattern the model wrote can backtrack for ever and would hang the server.
import { Worker } from 'node:worker_threads'
import { PLACEMENT, regexFromString } from '../../web/shared/regex.js'

const TIMEOUT = 2000

/**
 * → { matches, samples: [{ match, shown, sent }] }, or { error: 'invalid' }
 * (the pattern does not compile), 'timeout' or 'failed'.
 * @param options.names - { char, user } for a script whose pattern fills them in (substituteRegex).
 */
export function tryScript(script, text, { signal, timeout = TIMEOUT, names = null } = {}) {
  if (!regexFromString(script.findRegex)) return Promise.resolve({ error: 'invalid' })
  if (signal?.aborted) return Promise.resolve({ error: 'failed' })
  const placement = script.placement.includes(PLACEMENT.AI_OUTPUT) || !script.placement.includes(PLACEMENT.USER_INPUT) ? PLACEMENT.AI_OUTPUT : PLACEMENT.USER_INPUT
  return new Promise(resolve => {
    let worker
    try {
      worker = new Worker(new URL('./regex-trial-worker.mjs', import.meta.url), { workerData: { script, text, placement, names } })
    } catch {
      resolve({ error: 'failed' })
      return
    }
    const done = result => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      worker.terminate().catch(() => {})
      resolve(result)
    }
    const stop = () => done({ error: 'failed' })
    const timer = setTimeout(() => done({ error: 'timeout' }), timeout)
    signal?.addEventListener('abort', stop, { once: true })
    worker.once('message', result => done(result))
    worker.once('error', () => done({ error: 'failed' }))
  })
}
