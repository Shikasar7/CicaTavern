// One regex script tried on a text, in a worker (regex-trial.mjs): a pattern
// that backtracks without end only ever stops this thread. Posts back how many
// times it matched and, for the first few, what the match was and became.
import { parentPort, workerData } from 'node:worker_threads'
import { applyScripts, regexFromString } from '../../web/shared/regex.js'

const SAMPLES = 3
const CLIP = 400

const { script, text, placement } = workerData
const regex = regexFromString(script.findRegex)
const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)
const found = [...text.matchAll(global)]
const one = { ...script, disabled: false, placement: [placement], minDepth: null, maxDepth: null }
// What one match becomes on its own: the script run on the matched text.
const samples = found.slice(0, SAMPLES).map(match => ({
  match: match[0].slice(0, CLIP),
  shown: applyScripts(match[0], [one], { placement, target: 'display' }).slice(0, CLIP),
  sent: applyScripts(match[0], [one], { placement, target: 'prompt' }).slice(0, CLIP),
}))
parentPort.postMessage({ matches: found.length, samples })
