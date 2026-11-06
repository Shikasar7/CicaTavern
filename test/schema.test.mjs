// 变量规则: a card's MVU schema run in a sandbox of its own, only for cards that have one.
import { test, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { initTemplates } from '../server/template.mjs'
import { closeSchema, helperScriptsOf, keepToSchema, onSchemaProblem, schemaSandboxOpen, schemaScript } from '../server/schema.mjs'

const IMPORT = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';"
const SCHEMA = `${IMPORT}
export const Schema = z.object({
  世界: z.object({ 冷却: z.coerce.number().catch(0).transform(v => _.clamp(v, 0, 15)).prefault(0) }).prefault({}),
  主角: z.object({
    生命: z.coerce.number().transform(v => (isNaN(v) ? 100 : _.clamp(v, 0, 100))).prefault(100),
    背包: z.record(z.string(), z.object({ 数量: z.coerce.number().prefault(1) })).prefault({}).transform(data => _.pickBy(data, ({ 数量 }) => 数量 > 0)),
  }).prefault({}),
  记录: z.record(z.string(), z.string()).prefault({}).transform(data => _(data).entries().takeRight(2).fromPairs().value()),
});
$(() => { registerMvuSchema(Schema); });`

let problems = []
before(async () => {
  await initTemplates()
  onSchemaProblem(message => problems.push(message))
})
afterEach(() => {
  closeSchema()
  problems = []
})

test('the shapes cards carry their helper scripts in', () => {
  const script = { name: 'Zod', content: SCHEMA, enabled: true }
  assert.deepEqual(helperScriptsOf({ tavern_helper: { scripts: [script] } }), [script])
  assert.deepEqual(helperScriptsOf({ tavern_helper: [['scripts', [script]], ['variables', {}]] }), [script])
  assert.deepEqual(helperScriptsOf({ TavernHelper_scripts: [{ type: 'script', value: script }] }), [script])
  assert.deepEqual(helperScriptsOf({}), [])
  assert.deepEqual(helperScriptsOf(null), [])
})

test('the schema script is the enabled one that registers a schema', () => {
  const other = { name: 'MVU', content: "import 'https://example.test/mvu.js'", enabled: true }
  assert.equal(schemaScript({ tavern_helper: { scripts: [other, { name: 'Zod', content: SCHEMA, enabled: true }] } }), SCHEMA)
  assert.equal(schemaScript({ tavern_helper: { scripts: [other, { name: 'Zod', content: SCHEMA, enabled: false }] } }), '')
  assert.equal(schemaScript({ tavern_helper: { scripts: [other] } }), '')
})

test('a card without a schema loads nothing and gets its state back as it was', () => {
  const state = { 生命: 999 }
  assert.deepEqual(keepToSchema('', state), { state })
  assert.equal(schemaSandboxOpen(), false)
})

test('numbers are held to their range, bad ones replaced, missing fields filled, lists trimmed, unknown keys dropped', () => {
  const { state: out, problem } = keepToSchema(SCHEMA, {
    世界: { 冷却: 99 },
    主角: { 生命: 180, 背包: { 灵石: { 数量: 0 }, 丹药: { 数量: 2 } } },
    记录: { a: '1', b: '2', c: '3' },
    多余: 1,
  })
  assert.equal(problem, undefined)
  assert.deepEqual(out, { 世界: { 冷却: 15 }, 主角: { 生命: 100, 背包: { 丹药: { 数量: 2 } } }, 记录: { b: '2', c: '3' } })
  assert.deepEqual(keepToSchema(SCHEMA, {}).state, { 世界: { 冷却: 0 }, 主角: { 生命: 100, 背包: {} }, 记录: {} })
  assert.deepEqual(problems, [])
  assert.deepEqual(keepToSchema(SCHEMA, out).state, out, 'running it twice changes nothing')
})

test('a state the schema rejects stays as it was, and says so', () => {
  const strict = `${IMPORT}\nexport const Schema = z.object({ 名字: z.string() });\n$(() => { registerMvuSchema(Schema); });`
  const state = { 名字: 3 }
  const kept = keepToSchema(strict, state)
  assert.equal(kept.state, state)
  assert.match(kept.problem, /名字/)
  assert.equal(problems.length, 1)
})

test('a script that cannot run leaves the state alone: an unknown import, a page it reaches for, none registered', () => {
  const state = { a: 1 }
  for (const source of [
    `import x from 'https://example.test/other.js';\n${SCHEMA}`,
    `${IMPORT}\ndocument.body.remove();\nregisterMvuSchema(z.object({}));`,
    `${IMPORT}\nconst Schema = z.object({});`,
  ]) {
    problems = []
    assert.deepEqual(keepToSchema(source, state), { state }, 'the card\'s fault, not this turn\'s')
    assert.equal(problems.length, 1)
    closeSchema()
  }
})

test('the script has no way out of the sandbox', () => {
  const probe = `${IMPORT}
export const Schema = z.object({ seen: z.string().prefault('') }).transform(() => ({ seen: [typeof fetch, typeof process, typeof require, typeof XMLHttpRequest].join() }));
$(() => { registerMvuSchema(Schema); });`
  assert.equal(keepToSchema(probe, {}).state.seen, 'undefined,undefined,undefined,undefined')
})

test('a schema that never ends is cut off, and the state stays', () => {
  const stuck = `${IMPORT}\nexport const Schema = z.object({}).transform(() => { for (;;); });\n$(() => { registerMvuSchema(Schema); });`
  const state = { a: 1 }
  const kept = keepToSchema(stuck, state)
  assert.equal(kept.state, state)
  assert.ok(kept.problem)
  assert.equal(problems.length, 1)
  assert.equal(schemaSandboxOpen(), false, 'a sandbox stopped midway does not stay')
})

test('the sandbox is kept for the card in play and replaced for another', () => {
  keepToSchema(SCHEMA, {})
  assert.equal(schemaSandboxOpen(), true)
  const other = `${IMPORT}\nexport const Schema = z.object({ b: z.number().prefault(2) });\n$(() => { registerMvuSchema(Schema); });`
  assert.deepEqual(keepToSchema(other, {}).state, { b: 2 })
  closeSchema()
  assert.equal(schemaSandboxOpen(), false)
})
