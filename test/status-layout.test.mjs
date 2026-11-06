// 状态栏: laying out a state with many people and many kinds of value (web/shared/status.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoStatusSpec, cleanStatusSpec, statusGroups, withNewcomers } from '../web/shared/status.js'

const person = (like, mood) => ({ 好感度: like, 心情: mood, 随身物品: ['发簪'] })
const shape = (spec, state, previous) => statusGroups(spec, state, previous).map(group => [group.name, group.rows.map(row => `${row.label}:${row.show}`)])

test('people are found however deep they are', () => {
  const rows = ['好感度:meter', '心情:badge', '随身物品:tags']
  const flat = { 林雪: person(40, '平静'), 苏晚: person(10, '戒备') }
  assert.deepEqual(shape(autoStatusSpec(flat), flat), [['林雪', rows], ['苏晚', rows]])
  const nested = { 角色: flat, 世界: { 时间: '黄昏' } }
  assert.deepEqual(shape(autoStatusSpec(nested), nested), [['林雪', rows], ['苏晚', rows], ['世界', ['时间:text']]])
  const deeper = { 数据: { 人物: { 女性: flat } } }
  assert.deepEqual(shape(autoStatusSpec(deeper), deeper), [['林雪', rows], ['苏晚', rows]])
  const one = { 角色: { 林雪: person(40, '平静') } }
  assert.deepEqual(shape(autoStatusSpec(one), one), [['林雪', rows]])
})

test('what lies inside a person stays theirs, in a section, and two people never share a group', () => {
  const body = 体力 => ({ 身体: { 体力, 耐力: 70 }, 心理: { 压力: 30 } })
  const state = { 角色: { 林雪: body(80), 苏晚: body(60) } }
  const groups = statusGroups(autoStatusSpec(state), state)
  assert.deepEqual(groups.map(group => group.name), ['林雪', '苏晚'])
  assert.deepEqual(groups[1].rows.map(row => [row.section, row.label, row.value]), [['身体', '体力', 60], ['身体', '耐力', 70], ['心理', '压力', 30]])
  // Laid out by hand the same way, not by second-to-last key.
  const spec = cleanStatusSpec({ fields: [{ path: '林雪.身体.体力', show: 'meter' }, { path: '苏晚.身体.体力', show: 'meter' }] })
  assert.deepEqual(statusGroups(spec, { 林雪: { 身体: { 体力: 1 } }, 苏晚: { 身体: { 体力: 2 } } }).map(group => [group.name, group.rows[0].value]), [['林雪', 1], ['苏晚', 2]])
  // Two of one name in different places say where.
  const same = { 甲组: { 小雪: { 好感度: 1 }, 阿明: { 好感度: 2 } }, 队伍: { 乙组: { 小雪: { 好感度: 3 }, 阿强: { 好感度: 4 } } } }
  assert.deepEqual(statusGroups(autoStatusSpec(same), same).map(group => group.name), ['甲组 · 小雪', '阿明', '队伍 · 乙组 · 小雪', '阿强'])
})

test('the kinds of value: what a state holds picks how it shows, and each row has what its kind draws', () => {
  const state = {
    主角: {
      生命: '80/100', 法力: '45%', 星级: 3, 关系: '挚友', 经历: '她'.repeat(60), 备注: '第一行\n第二行',
      随身: ['伞', '钥匙'], 日志: ['第一天到达了城南的茶馆', '第二天在码头遇到了一位陌生人'],
      属性: { 力量: 5, 敏捷: 3, 智力: 7 },
      背包: { 药水: { 数量: 3, 品质: '上' }, 绷带: { 数量: 5, 品质: '中' } },
      任务: [{ 名称: '找到钥匙', 进度: '一半' }, { 名称: '回家', 进度: '未开始' }],
      技能: { 剑术: 5, 医术: 2 },
    },
  }
  const spec = autoStatusSpec(state)
  assert.deepEqual(Object.fromEntries(spec.fields.map(field => [field.path.replace('主角.', ''), field.show])), {
    生命: 'meter', 法力: 'meter', 星级: 'rating', 关系: 'badge', 经历: 'long', 备注: 'long', 随身: 'tags', 日志: 'list', 属性: 'stats', 背包: 'table', 任务: 'table', 技能: 'stats',
  })
  const previous = structuredClone(state)
  previous.主角.生命 = '90/100'
  previous.主角.属性.力量 = 4
  previous.主角.随身 = ['伞']
  previous.主角.关系 = '朋友'
  delete previous.主角.背包.绷带
  const [group] = statusGroups(spec, state, previous)
  const row = label => group.rows.find(item => item.label === label)
  assert.equal(group.changed, true)
  assert.deepEqual([row('生命').value, row('生命').percent, row('生命').words, row('生命').delta], [80, 80, '80/100', -10])
  assert.deepEqual([row('法力').value, row('法力').percent, row('法力').words], [45, 45, '45%'])
  assert.deepEqual([row('星级').value, row('星级').max], [3, 5])
  assert.equal(row('关系').changed, true)
  assert.equal(row('经历').text.length, 60, 'a paragraph is not clipped to a line')
  assert.deepEqual(row('随身').added, ['钥匙'])
  assert.equal(row('日志').items.length, 2)
  assert.deepEqual(row('属性').stats[0], { label: '力量', value: 5, delta: 1 })
  const { table } = row('背包')
  assert.deepEqual([table.named, table.columns], [true, ['数量', '品质']])
  assert.deepEqual(table.rows.map(item => [item.name, item.cells, item.changed]), [['药水', ['3', '上'], undefined], ['绷带', ['5', '中'], true]])
  assert.equal(row('任务').table.named, false)
  assert.deepEqual(row('任务').table.rows[1].cells, ['回家', '未开始'])
})

test('a value that does not suit its kind still shows, as words', () => {
  const spec = cleanStatusSpec({ fields: [{ path: 'a', show: 'stats' }, { path: 'b', show: 'table' }, { path: 'c', show: 'rating' }, { path: 'd', show: 'meter' }] })
  assert.deepEqual(statusGroups(spec, { a: '一句话', b: 3, c: '满', d: '未知' })[0].rows.map(row => [row.show, row.text]), [['text', '一句话'], ['text', '3'], ['text', '满'], ['text', '未知']])
})

test('stars keep to their scale; a rating asks for at most ten', () => {
  const spec = cleanStatusSpec({ fields: [{ path: 'a', show: 'rating', max: 3 }, { path: 'b', show: 'rating', max: 50 }, { path: 'c', show: 'rating' }] })
  assert.deepEqual(spec.fields.map(field => field.max), [3, 5, 5])
  assert.deepEqual(statusGroups(spec, { a: 9, b: -1, c: 2.6 })[0].rows.map(row => row.value), [3, 0, 3])
})

test('old MVU pairs: words read as their value only in a state written that way, and only when the second says more', () => {
  const described = { 林雪: { 好感度: [40, '对你的好感'], 心情: ['平静', '她现在的心情'], 随身: ['油纸伞', '旧怀表'], 背包: [['药', '绳'], '带着的东西'] } }
  const spec = autoStatusSpec(described)
  const [group] = statusGroups(spec, described)
  assert.deepEqual(group.rows.map(row => [row.label, row.value ?? row.text ?? row.tags]), [['好感度', 40], ['心情', '平静'], ['随身', ['油纸伞', '旧怀表']], ['背包', ['药', '绳']]])
  const plain = { 林雪: { 心情: ['平静', '她现在的心情'] } }
  assert.deepEqual(statusGroups(autoStatusSpec(plain), plain)[0].rows[0].tags, ['平静', '她现在的心情'], 'without numbers saying so, it is a list of two')
})

test('MVU marks stay out of sight', () => {
  const state = { 背包: ['$__META_EXTENSIBLE__$', '伞'], 档案: { $meta: { extensible: true }, 林雪: { 好感度: 1, $隐藏: 2 } } }
  const groups = statusGroups(autoStatusSpec(state), state)
  assert.deepEqual(groups.flatMap(group => group.rows.map(row => row.tags ?? row.label)), [['伞'], '好感度'])
})

test('more variables than fit are counted, not dropped without a word', () => {
  const crowd = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`角色${i}`, { 好感度: 1, 信任度: 2, 心情: 'a', 位置: 'b' }]))
  const spec = autoStatusSpec(crowd)
  assert.equal(spec.fields.length, 200)
  assert.equal(spec.more, 40)
  assert.equal(statusGroups(spec, crowd).length, 50)
  assert.equal(autoStatusSpec({ 林雪: person(1, 'a') }).more, undefined)
})

test('a card\'s own layout takes in someone new beside the people it names, as it shows them', () => {
  const own = cleanStatusSpec({ title: '状态', theme: 'paper', fields: [
    { path: '林雪.好感度', label: '好感', show: 'meter', min: 0, max: 200 },
    { path: '林雪.秘密', show: 'hidden' },
    { path: '顾念念.好感度', label: '好感', show: 'meter', min: 0, max: 200 },
    { path: '天气', show: 'text' },
  ] })
  const state = { 林雪: { 好感度: 40, 秘密: 'x' }, 顾念念: { 好感度: 70 }, 苏晚: { 好感度: 10, 秘密: 'y', 别的: 1 }, 世界: { 时间: '夜' }, 天气: '雨' }
  const spec = withNewcomers(own, state)
  assert.deepEqual(spec.fields.at(-1), { path: '苏晚.好感度', label: '好感', show: 'meter', min: 0, max: 200 })
  assert.equal(spec.theme, 'paper')
  assert.equal(spec.fields.length, own.fields.length + 1, 'nothing hidden, nothing the layout does not show, nobody without its values')
  assert.deepEqual(statusGroups(spec, state).map(group => group.name), ['林雪', '顾念念', '', '苏晚'])
  assert.equal(withNewcomers(own, { 林雪: { 好感度: 40 } }), own, 'nobody new: the layout as it is')
  // Under a container, and with sections.
  const deep = cleanStatusSpec({ fields: [{ path: '角色.林雪.身体.体力', show: 'meter' }, { path: '角色.顾念念.身体.体力', show: 'meter' }] })
  assert.equal(withNewcomers(deep, { 角色: { 苏晚: { 身体: { 体力: 5 } } } }).fields.at(-1).path, '角色.苏晚.身体.体力')
})
