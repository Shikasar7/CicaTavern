// 状态栏上的图: a book of places shown as a map, who is fielded on the ring of types, companions with their chains of
// 形态. What the rows are worked out to (web/shared/status.js); the drawing itself is looked at in a browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanMap, cleanStatusSpec, isMapPath, onPage, phoneApps, planMap, sameName, statusGroups, statusPages } from '../web/shared/status.js'
import { statusLines, statusSpecOf } from '../server/forge/status.mjs'
import { normalizePlan } from '../server/forge/prompts.mjs'

const SPEC = {
  title: '星纹录',
  map: { places: [{ name: '白塔神殿', zone: '上城区', x: 13, y: 12 }, { name: '深谷遗迹第二层·水晶溶洞', short: '水晶溶洞', zone: '深谷遗迹', x: 181, y: -4 }, { name: '旧桥酒馆' }, { name: '白塔神殿' }, { name: '' }], here: 'stat_data.世界.当前地点' },
  fields: [
    { path: '世界.当前地点', show: 'text' },
    { path: '地图', show: 'map', page: '地图' },
    { path: '主角.出战魔宠', show: 'types', page: '克制' },
    { path: '魔宠', show: 'forms', page: '魔宠' },
    { path: '人物', show: 'table', page: '关系' },
  ],
}
const STATE = {
  世界: { 当前地点: '水晶溶洞' },
  地图: { 白塔神殿: { 区域: '上城区', 通行: '凭请柬入内', 见闻: '白石穹顶' }, '深谷遗迹第二层·水晶溶洞': { 区域: '深谷遗迹', 通行: '可前往', 见闻: '' }, 码头: { 通行: '开放' } },
  主角: { 出战魔宠: '山猫幼崽' },
  魔宠: { 影纹山猫: { 形态: '裂影山猫', 阶位: '成长期', 等级: 6 }, 白羽隼: '跟着' },
  人物: { 莉瑟: { 态度: '戒备', 所在: '白塔神殿' }, 维拉: { 态度: '轻蔑' } },
}

test('a bar keeps its map only with a field that shows one, places cleaned', () => {
  const spec = cleanStatusSpec(SPEC)
  assert.deepEqual(spec.map, { places: [{ name: '白塔神殿', zone: '上城区', x: 13, y: 12 }, { name: '深谷遗迹第二层·水晶溶洞', short: '水晶溶洞', zone: '深谷遗迹', x: 100, y: 0 }, { name: '旧桥酒馆' }], here: '世界.当前地点' })
  assert.equal(cleanStatusSpec({ ...SPEC, fields: SPEC.fields.filter(field => field.show !== 'map') }).map, undefined)
  assert.equal(cleanMap({ places: [] }), null)
  assert.ok(sameName('深谷遗迹第二层·水晶溶洞', '水晶溶洞') && !sameName('', '水晶溶洞') && !sameName('白', '黑'))
})

test('a map row: the places the variables know, which are shut, where the player is and who is where', () => {
  const spec = cleanStatusSpec(SPEC)
  const before = structuredClone(STATE)
  delete before.地图.码头
  const row = statusGroups(spec, STATE, before).flatMap(group => group.rows).find(one => one.show === 'map')
  assert.deepEqual(row.spots.map(spot => [spot.name, spot.shut, spot.changed === true]), [['白塔神殿', true, false], ['深谷遗迹第二层·水晶溶洞', false, false], ['码头', false, true]])
  assert.deepEqual(row.spots[0].facts, [['区域', '上城区'], ['通行', '凭请柬入内'], ['见闻', '白石穹顶']])
  assert.equal(row.here, '水晶溶洞')
  assert.deepEqual(row.people, [{ name: '莉瑟', where: '白塔神殿' }])
  assert.equal(row.places.length, 3)
  assert.equal(row.changed, true)
  // In 小手机 the map is an app of its own, with the card's places still beside it.
  const app = phoneApps({ ...spec, phone: true, fields: spec.fields.map(({ page: _, ...field }) => field) }).apps.find(one => one.spec.fields[0].show === 'map')
  assert.equal(app.spec.map.places.length, 3)
  // Who is where, read from the whole bar: the map on a page of its own, or an app of its own, still has 莉瑟.
  const mapRow = shown => statusGroups(shown, STATE).flatMap(group => group.rows).find(one => one.show === 'map')
  assert.deepEqual(mapRow(app.spec).people, [{ name: '莉瑟', where: '白塔神殿' }])
  const paged = { ...spec, fields: spec.fields.map(field => ({ ...field, page: field.show === 'map' ? '地图' : '人物' })) }
  assert.deepEqual(mapRow(onPage(paged, '地图', statusPages(paged))).people, [{ name: '莉瑟', where: '白塔神殿' }])
})

test('who is fielded is a word; companions keep every word their rows say', () => {
  const rows = statusGroups(cleanStatusSpec(SPEC), STATE).flatMap(group => group.rows)
  assert.equal(rows.find(one => one.show === 'types').text, '山猫幼崽')
  const forms = rows.find(one => one.show === 'forms')
  assert.deepEqual(forms.lines, [{ name: '影纹山猫', words: ['裂影山猫', '成长期'] }, { name: '白羽隼', words: ['跟着'] }])
  assert.equal(forms.table.rows.length, 2)
  // Nothing to draw a chain from: a word, as a table with nothing in it is.
  assert.equal(statusGroups(cleanStatusSpec(SPEC), { 魔宠: '还没有' }).flatMap(group => group.rows)[0].show, 'text')
})

const PLAN = {
  name: '雾港',
  summary: '雾里的港城。',
  user_role: { identity: '信使' },
  world: { kind: '架空', overview: '多雾的港城', places: [{ name: '灯塔', description: '港口尽头' }, { name: '鱼市', description: '清晨最吵' }, { name: '旧城门', description: '锁了多年' }] },
  characters: [{ name: '阿潮', kind: 'core', gender: '女', identity: '守塔人', relationship: '雇主', personality: { base: '沉静', main: ['寡言'] } }],
  style: { perspective: '第三人称' },
  tracking: { enabled: true, variables: [
    { path: '世界.当前地点', label: '所在', type: 'string', initial: '灯塔', show: 'text', check: '换地方时改' },
    { path: '世界.地图', label: '地图', type: 'book', columns: ['通行', '见闻'], initial: [{ name: '灯塔', 通行: '可前往', 见闻: '' }], show: 'table', check: '到了新地方加一行' },
    { path: '阿潮.好感度', label: '好感', type: 'number', initial: '10', range: '0~100', show: 'map', check: '' },
  ] },
  greetings: [{ title: '起雾', start: '初遇', scene: '清晨', situation: '她在塔下等', state: {} }],
  avatar: { character: '阿潮' },
}

test('创作角色卡: a book of places is drawn as a map of the world\'s places; a number never is', () => {
  const plan = normalizePlan(PLAN)
  assert.deepEqual(plan.tracking.variables.map(variable => variable.show), ['text', 'map', 'meter'])
  assert.ok(isMapPath('世界.地图') && !isMapPath('世界.地图碎片'))
  assert.deepEqual(planMap(plan), { places: [{ name: '灯塔' }, { name: '鱼市' }, { name: '旧城门' }], here: '世界.当前地点' })
  const spec = statusSpecOf({ ...plan, status: {} })
  assert.equal(spec.map.places.length, 3)
  // Places put where they are on a picture stay there.
  const placed = statusSpecOf({ ...plan, status: { map: { places: [{ name: '灯塔', x: 10, y: 20 }] } } })
  assert.deepEqual(placed.map, { places: [{ name: '灯塔', x: 10, y: 20 }], here: '世界.当前地点' })
})

test('a change of layout or of the map alone reads as a change', () => {
  const spec = cleanStatusSpec(SPEC)
  assert.notEqual(statusLines(spec), statusLines({ ...spec, layout: 'scroll' }))
  assert.notEqual(statusLines(spec), statusLines({ ...spec, map: { ...spec.map, places: spec.map.places.map((place, i) => (i ? place : { ...place, x: 40 })) } }))
})
