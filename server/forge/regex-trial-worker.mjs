// One regex script tried on a text, in a worker (regex-trial.mjs): a pattern
// that backtracks without end only ever stops this thread. Posts back how many
// times it matched and, for the first few, what the match was and became.
import { parentPort, workerData } from 'node:worker_threads'
import { applyScripts, patternOf } from '../../web/shared/regex.js'

const SAMPLES = 3
const CLIP = 400

const { script, text, placement, names } = workerData
// {{char}} and {{user}} as the chat names them (web/render.js nameMacros), for a script that fills them in.
const macros = names
  ? value => String(value ?? '').replace(/\{\{\/\/[\s\S]*?\}\}/g, '').replace(/\{\{char\}\}|<BOT>/gi, () => names.char).replace(/\{\{user\}\}|<USER>/gi, () => names.user)
  : value => value
const regex = patternOf(script, macros)
const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)
const found = [...text.matchAll(global)]
const one = { ...script, disabled: false, placement: [placement], minDepth: null, maxDepth: null }
// What each match becomes where it stands in the reply: the script run on the whole text, keeping what each
// replacement was (so lookbehinds and anchors see what is around the match) and leaving the text as it is.
// A target the script does not run on (markdownOnly, promptOnly) leaves the match as it was.
const replacements = target => {
  const made = []
  applyScripts(text, [one], {
    placement,
    target,
    macros,
    replace: (from, regex, replacer) =>
      from.replace(regex, (...args) => {
        made.push({ match: args[0], to: replacer(...args) })
        return args[0]
      }),
  })
  return made
}
const shown = replacements('display')
const sent = replacements('prompt')
const runs = shown.length ? shown : sent
const samples = (runs.length ? runs : found.map(match => ({ match: match[0] }))).slice(0, SAMPLES).map((run, i) => ({
  match: run.match.slice(0, CLIP),
  shown: (shown.length ? shown[i]?.to ?? run.match : run.match).slice(0, CLIP),
  sent: (sent.length ? sent[i]?.to ?? run.match : run.match).slice(0, CLIP),
}))
parentPort.postMessage({ matches: found.length, samples })
