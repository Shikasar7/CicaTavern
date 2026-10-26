// Matches for regex-guard.mjs, one request at a time: a card's pattern that
// backtracks without end only ever stops this thread, which regex-guard ends
// and starts again. `signal[0]` says a reply is waiting, `signal[1]` that the
// thread is ready.
import { workerData } from 'node:worker_threads'

const { port, signal } = workerData

const shape = match => ({ index: match.index, groups: [...match], named: match.groups ?? null })

port.on('message', ({ source, flags, text }) => {
  let reply
  try {
    const regex = new RegExp(source, flags)
    reply = regex.global ? [...text.matchAll(regex)].map(shape) : [regex.exec(text)].filter(Boolean).map(shape)
  } catch (error) {
    reply = { error: String(error?.message ?? error) }
  }
  port.postMessage(reply)
  Atomics.store(signal, 0, 1)
  Atomics.notify(signal, 0)
})

Atomics.store(signal, 1, 1)
Atomics.notify(signal, 1)
