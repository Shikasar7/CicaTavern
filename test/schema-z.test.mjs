// The app's small Zod held to Zod itself (a dev dependency, not shipped): the same schemas, the same answers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z as zod } from 'zod'
import { createZ } from '../server/schema-z.mjs'

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi)

// Each builds a schema from whichever z it is given, in the ways variable schemas are written.
const SCHEMAS = {
  'a typical card': z => z.object({
    世界: z.object({
      时间: z.string().prefault('未知'),
      冷却: z.coerce.number().catch(0).transform(v => (Number.isNaN(v) ? 0 : clamp(v, 0, 15))).prefault(0),
      阶段: z.enum(['起', '承', '转', '合']).catch('起').prefault('起'),
    }).catch({}).prefault({}),
    主角: z.object({
      生命: z.coerce.number().transform(v => clamp(v, 0, 100)).prefault(100),
      开关: z.boolean().prefault(false),
      背包: z.record(z.string().describe('物品'), z.object({ 描述: z.string().prefault(''), 数量: z.coerce.number().catch(1).prefault(1) })).prefault({}),
    }).prefault({}),
    台词: z.array(z.string()).prefault([]),
  }),
  'absent keys': z => z.object({
    a: z.string(),
    b: z.string().optional(),
    c: z.string().default('c'),
    d: z.string().prefault('d'),
    e: z.string().catch('e'),
    f: z.any(),
    g: z.string().nullable(),
    h: z.string().nullish(),
    i: z.string().optional().default('i'),
    j: z.string().default('j').optional(),
    k: z.string().optional().transform(v => v ?? 'k'),
    l: z.preprocess(v => v ?? 'l', z.string()),
    m: z.undefined(),
  }),
  'absent keys, all allowed': z => z.object({
    b: z.string().optional(),
    c: z.string().default('c'),
    d: z.string().prefault('d'),
    e: z.string().catch('e'),
    h: z.string().nullish(),
    i: z.string().optional().default('i'),
    j: z.string().default('j').optional(),
    k: z.string().optional().transform(v => v ?? 'k'),
    l: z.preprocess(v => v ?? 'l', z.string()),
    n: z.string().or(z.number()).optional(),
  }),
  'default against prefault': z => z.object({
    a: z.string().transform(v => `${v}!`).default('x'),
    b: z.string().transform(v => `${v}!`).prefault('x'),
    c: z.object({ d: z.number().prefault(1) }).prefault({}),
    e: z.object({ f: z.number().prefault(1) }).default({ f: 2 }),
  }),
  checks: z => z.object({
    a: z.string().trim().min(2).max(4).prefault('abc'),
    b: z.string().regex(/^[a-z]+$/).catch('x'),
    c: z.number().int().min(0).max(10).catch(5),
    d: z.number().positive().catch(1),
    e: z.array(z.number()).max(2).catch([]),
    f: z.string().toLowerCase().catch(''),
    g: z.number().nonnegative().catch(0),
    h: z.array(z.string()).min(1).catch(['x']),
    i: z.number().finite().catch(0),
  }),
  'unions and literals': z => z.object({
    a: z.literal('待初始化').or(z.object({ b: z.number() })).prefault('待初始化'),
    c: z.union([z.string(), z.number()]).catch(0),
    d: z.literal(['x', 'y']).catch('x'),
    e: z.null().or(z.string()).catch(null),
    f: z.string().nullable().catch(null),
  }),
  records: z => z.object({
    a: z.record(z.enum(['x', 'y']), z.number()).catch({}),
    b: z.partialRecord(z.enum(['x', 'y']), z.number()).catch({}),
    c: z.record(z.string(), z.number().prefault(1)).catch({}),
    d: z.record(z.string().max(2), z.any()).catch({}),
  }),
  'unknown keys': z => z.object({
    a: z.object({ b: z.number().prefault(1) }).passthrough().prefault({}),
    c: z.object({ d: z.number().prefault(1) }).strict().catch({ d: 0 }),
    e: z.object({ f: z.number().prefault(1) }).prefault({}),
    g: z.looseObject({ h: z.number().prefault(1) }).prefault({}),
  }),
  'object tools': z => {
    const base = z.object({ a: z.number().prefault(1), b: z.string().prefault('b') })
    return z.object({
      e: base.extend({ c: z.boolean().prefault(true) }).prefault({}),
      p: base.pick({ a: true }).prefault({}),
      o: base.omit({ a: true }).prefault({}),
      q: base.partial().prefault({}),
    })
  },
  'pipes and transforms': z => z.object({
    a: z.coerce.string().pipe(z.string().max(3)).catch(''),
    b: z.preprocess(v => (typeof v === 'string' ? v.trim() : v), z.string().min(1)).catch('空'),
    c: z.record(z.string(), z.object({ 数量: z.coerce.number() })).prefault({}).transform(d => Object.fromEntries(Object.entries(d).filter(([, v]) => v.数量 > 0))),
    d: z.string().transform(v => v.length).catch(-1),
    e: z.coerce.boolean().prefault(false),
    f: z.number().refine(v => v % 2 === 0, '要是偶数').catch(0),
  }),
}

const STATES = [
  undefined, null, 1, 'x', [], {},
  { a: 'abc' }, { a: ' ab ' }, { a: 'toolongtext' }, { a: null }, { a: 1 }, { a: { b: 2 } }, { a: { x: 1, y: 2 } }, { a: { x: 1 } }, { a: { x: 1, y: 2, z: 3 } },
  { a: 'a', f: 1, g: null, m: 1 }, { a: 'a', f: 1, g: 'g' }, { a: 'a', f: undefined, g: null },
  { b: null, c: null, d: null, e: null, h: null, i: null, j: null, k: null, l: null, n: true },
  { b: 'b', c: 'c', d: 'd', e: 1, h: 'h', i: 'i', j: 'j', k: 'k', l: 1, n: 1 },
  { 世界: { 时间: 1, 冷却: 99, 阶段: '错' }, 主角: { 生命: 180, 开关: 'yes', 背包: { 灵石: { 数量: '3' }, 丹药: {}, 坏: 1 } }, 台词: ['a', 1] },
  { 世界: 'x', 主角: null, 台词: 'y' }, { 世界: { 冷却: '不是数字' }, 主角: { 生命: '不是数字' } }, { 主角: { 生命: '12', 背包: { 灵石: { 数量: '不是数字' } } } }, { 多余: 1 },
  { a: 'ABC', b: 'abc', c: 3, d: 2, e: [1, 2], f: 'ABC', g: 1, h: ['y'], i: 1 }, { a: 'a', b: 'ABC', c: 3.5, d: -1, e: [1, 2, 3], f: 1, g: -1, h: [], i: 'x' },
  { a: { b: 1 }, c: 'x', d: 'z', e: null, f: null }, { a: { b: 'x' }, c: true, d: 'y', e: 'e', f: 1 },
  { a: { x: 1, y: 2 }, b: { x: 1 }, c: { k: null, l: 1 }, d: { ab: 1, abc: 2 } }, { a: { x: 'a', y: 2 }, b: { z: 1 }, c: 1, d: null },
  { a: { b: 2, extra: 1 }, c: { d: 1, extra: 1 }, e: { f: 2, extra: 1 }, g: { h: 2, extra: 1 } }, { c: { d: 1 } },
  { e: { a: 2, x: 1 }, p: { a: 2, b: 'x' }, o: { a: 2, b: 'x' }, q: { a: 'bad' } },
  { a: 12, b: '   ', c: { x: { 数量: 0 }, y: { 数量: '2' } }, d: 'abc', e: 'yes', f: 3 }, { a: 'abcd', b: ' ok ', c: { x: {} }, d: 1, e: 0, f: 4 },
  { c: { __proto__: null, toString: 1 } }, JSON.parse('{"__proto__": {"x": 1}, "a": "abc"}'), JSON.parse('{"c": {"__proto__": 1, "k": 1}}'),
]

/** What a schema makes of a state, as far as anything downstream can tell. */
const answer = (schema, state) => {
  try {
    const out = schema.safeParse(state)
    return out.success ? { data: JSON.stringify(out.data) } : { rejected: true }
  } catch {
    return { threw: true }
  }
}

const small = createZ()
for (const [name, build] of Object.entries(SCHEMAS)) {
  test(`same answers as Zod: ${name}`, () => {
    const theirs = build(zod)
    const ours = build(small)
    for (const state of STATES) assert.deepEqual(answer(ours, state), answer(theirs, state), JSON.stringify(state))
  })
}

test('parse answers or throws, as safeParse says', () => {
  const schema = small.object({ a: small.number() })
  assert.deepEqual(schema.parse({ a: 1 }), { a: 1 })
  assert.throws(() => schema.parse({ a: 'x' }), /a: /)
})

test('a value from a transform that throws is not caught for it', () => {
  const build = z => z.object({ a: z.string().transform(() => { throw new Error('卡的代码') }) })
  assert.deepEqual(answer(build(small), { a: 'x' }), answer(build(zod), { a: 'x' }))
})

test('what is not here fails where it is called', () => {
  assert.throws(() => small.string().email())
  assert.equal(small.date, undefined)
})
