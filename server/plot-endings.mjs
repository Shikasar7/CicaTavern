// 结局收集 (plans/22 十二·6): the endings reached on each of a card's plots, on this device. Kept beside the card
// (cards/<id>/plot-endings.json), so a backup and a move to another device take them along; a card exported to
// someone else does not.
import path from 'node:path'
import { readJsonFile, writeJson } from './store.mjs'

const ID = /^[\w-]{1,64}$/
const fileOf = (store, cardId) => path.join(store.dirs.cards, cardId, 'plot-endings.json')

/** { [plot id]: { [scene id]: { at, title, kind } } } for a card ({} when none was reached). */
export async function readEndings(store, cardId) {
  if (!ID.test(String(cardId))) return {}
  const value = await readJsonFile(fileOf(store, cardId), null).catch(() => null)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const queues = new Map()

/**
 * An ending reached: `scene` of plot `plotId` (the chat's copy keeps the card plot's id). The first time stays.
 * → whether it was new.
 */
export function noteEnding(store, cardId, plotId, scene) {
  if (!ID.test(String(cardId)) || !ID.test(String(plotId)) || !scene?.ending) return Promise.resolve(false)
  const run = (queues.get(cardId) ?? Promise.resolve()).then(async () => {
    const endings = await readEndings(store, cardId)
    const reached = endings[plotId] ?? {}
    if (reached[scene.id]) return false
    endings[plotId] = { ...reached, [scene.id]: { at: new Date().toISOString(), title: scene.title, kind: scene.ending.kind } }
    await writeJson(fileOf(store, cardId), endings)
    return true
  })
  queues.set(cardId, run.catch(() => {}))
  return run
}
