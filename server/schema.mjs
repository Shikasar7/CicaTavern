// 变量规则: a card's MVU schema (Tavern Helper's Zod script, registerMvuSchema), kept to after each update as
// MVU keeps to it in SillyTavern: numbers held to their range, missing fields filled, lists trimmed.
//
// Most cards have none, and no sandbox opens for them. One with a schema runs it in a QuickJS sandbox of its own,
// with no host objects, no network and no files, against the app's small Zod (schema-z.mjs); the sandbox goes
// after IDLE_MS. A schema that cannot run, or a state it rejects, leaves the state as it was.
import { shouldInterruptAfterDeadline } from 'quickjs-emscripten'
import { sandboxEngine } from './template.mjs'
import { createZ } from './schema-z.mjs'
import { createLodash } from './sandbox-lodash.mjs'
import { msg } from './i18n.mjs'

// A schema script carries the whole of Zod and lodash bundled in: 650 KB for a big card's (武侠·江湖), run in 80 ms.
const MAX_SOURCE = 2_000_000
const MAX_STATE = 2_000_000
const MEMORY_LIMIT = 64 * 1024 * 1024
// Slow on a phone without WebAssembly (iOS).
const LOAD_MS = 5_000
// A schema may do real work in its transforms (武侠·江湖's evicts old passers-by and trims its logs: 2.8 s here).
const CHECK_MS = 10_000
// A schema that throws or runs out of time this many times in a row is left alone for the rest of the run: it would
// only cost each turn the same seconds and say the same thing in the error log.
const BREAK_AFTER = 3
const IDLE_MS = 5 * 60_000

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A card's Tavern Helper scripts in any of the shapes cards carry them, each as { name, content, enabled }. */
export function helperScriptsOf(extensions) {
  const helper = extensions?.tavern_helper
  const listed = Array.isArray(helper) ? helper.find(pair => Array.isArray(pair) && pair[0] === 'scripts')?.[1] : helper?.scripts
  const scripts = Array.isArray(listed) && listed.length ? listed : extensions?.TavernHelper_scripts
  return (Array.isArray(scripts) ? scripts : []).filter(isRecord).map(script => (isRecord(script.value) ? script.value : script))
}

/** The card's enabled schema script, or ''. */
export function schemaScript(extensions) {
  const script = helperScriptsOf(extensions).find(s => s.enabled !== false && typeof s.content === 'string' && s.content.includes('registerMvuSchema'))
  return script && script.content.length <= MAX_SOURCE ? script.content : ''
}

// What the card's script finds as globals: the app's small Zod, and the lodash card scripts get (sandbox-lodash.mjs).
const GLOBALS = String.raw`
globalThis.z = (${createZ})()
globalThis._ = (${createLodash})()
globalThis.$ = fn => (typeof fn === 'function' ? fn() : undefined)
globalThis.window = globalThis
globalThis.__check = text => {
  try {
    const schema = typeof globalThis.__schema === 'function' ? globalThis.__schema() : globalThis.__schema
    const result = schema.safeParse(JSON.parse(text))
    return JSON.stringify(result.success ? { data: result.data } : { invalid: String(result.error?.message ?? 'invalid').slice(0, 300) })
  } catch (error) {
    return JSON.stringify({ error: String(error?.message ?? error).slice(0, 300) })
  }
}`

const VIRTUAL = {
  'virtual:mvu': 'export const registerMvuSchema = schema => { globalThis.__schema = schema }',
  'virtual:zod': 'export const z = globalThis.z; export default globalThis.z',
  'virtual:lodash': 'export default globalThis._',
}
let warm = null // { source, runtime, vm, broken, timer }
let report = () => {}

/** `fn(message)` when a card's schema cannot run or rejects a state (the error log, server/http.mjs). */
export function onSchemaProblem(fn) {
  report = fn
}

/** Whether a sandbox is open now (the tests' check that a card without a schema never opens one). */
export const schemaSandboxOpen = () => warm !== null

function resolveModule(_base, name) {
  if (/mvu_zod/.test(name)) return 'virtual:mvu'
  if (/(^|\/)zod(@|\/|\.|$)/.test(name)) return 'virtual:zod'
  if (/(^|\/)lodash(@|\/|\.|$)/.test(name)) return 'virtual:lodash'
  return `virtual:unknown:${name}`
}

function loadModule(name) {
  if (VIRTUAL[name]) return VIRTUAL[name]
  throw new Error(`the schema imports ${name.slice('virtual:unknown:'.length)}`)
}
function close() {
  if (!warm) return
  clearTimeout(warm.timer)
  if (warm.vm) warm.vm.dispose()
  if (warm.runtime) warm.runtime.dispose()
  warm = null
}

/** Let the sandbox go now. */
export const closeSchema = close

function run(vm, runtime, code, options) {
  const result = vm.evalCode(code, options?.file, options?.type ? { type: options.type } : undefined)
  if (result.error) {
    const error = vm.dump(result.error)
    result.error.dispose()
    throw new Error(String(error?.message ?? error))
  }
  const jobs = runtime.executePendingJobs()
  if (jobs.error) {
    const error = vm.dump(jobs.error)
    jobs.error.dispose()
    throw new Error(String(error?.message ?? error))
  }
  return result.value
}

function open(source) {
  if (warm?.source === source) return warm
  close()
  const runtime = sandboxEngine().newRuntime()
  runtime.setMemoryLimit(MEMORY_LIMIT)
  runtime.setMaxStackSize(1024 * 1024)
  runtime.setModuleLoader(loadModule, resolveModule)
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + LOAD_MS))
  const vm = runtime.newContext()
  warm = { source, runtime, vm, broken: false, timer: null }
  try {
    run(vm, runtime, GLOBALS).dispose()
    run(vm, runtime, source, { file: 'card-schema.mjs', type: 'module' }).dispose()
    const registered = run(vm, runtime, 'typeof globalThis.__schema')
    const kind = vm.dump(registered)
    registered.dispose()
    if (kind === 'undefined') throw new Error('the script registered no schema')
  } catch (error) {
    warm.broken = true
    report(String(error?.message ?? error).slice(0, 300))
  }
  return warm
}

/**
 * `state` as the schema makes it.
 * @param source - the card's schema script; '' is no schema, and costs nothing.
 * @returns { state, problem }: the same state object when there is nothing to do or the schema gives no answer.
 *   `problem` says why when this state is what failed; a script that cannot run at all is the card's, for the error log.
 */
export function keepToSchema(source, state) {
  if (!source) return { state }
  const text = JSON.stringify(state ?? {})
  if (text.length > MAX_STATE) return { state }
  const key = keyOf(source)
  if ((failing.get(key) ?? 0) >= BREAK_AFTER) return { state }
  let sandbox
  try {
    sandbox = open(source)
  } catch (error) {
    report(String(error?.message ?? error).slice(0, 300))
    close()
    return { state }
  }
  clearTimeout(sandbox.timer)
  sandbox.timer = setTimeout(close, IDLE_MS)
  sandbox.timer.unref?.()
  if (sandbox.broken) return { state }
  try {
    sandbox.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + CHECK_MS))
    const handle = run(sandbox.vm, sandbox.runtime, `__check(${JSON.stringify(text)})`)
    const answer = JSON.parse(sandbox.vm.dump(handle))
    handle.dispose()
    if (answer.error === undefined) failing.delete(key)
    if (answer.data !== undefined) return { state: answer.data }
    // A state the schema rejects: that one state's problem.
    if (answer.invalid !== undefined) {
      report(answer.invalid)
      return { state, problem: answer.invalid }
    }
    failed(key, answer.error)
    return { state, problem: answer.error }
  } catch (error) {
    // Past its time or its memory: the sandbox may be in any state, so it does not stay.
    const problem = String(error?.message ?? error).slice(0, 300)
    failed(key, problem)
    close()
    return { state, problem }
  }
}

// Schemas that threw or ran out of time, by their text: how many times in a row (BREAK_AFTER).
const failing = new Map()

// The schema's whole text: two schemas that differ anywhere are told apart (a Map keeps a string's hash on it).
const keyOf = source => source

function failed(key, problem) {
  const times = (failing.get(key) ?? 0) + 1
  failing.set(key, times)
  report(times >= BREAK_AFTER ? msg`${problem}（连续 ${times} 次出错，这次运行里不再检查这张卡的变量规则）` : problem)
}
