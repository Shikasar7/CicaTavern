// 游戏式 HUD (web/shared/hud.js): which variables it keeps, how they read, and what a reply changed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changeNotes, hudPicks, hudRows, iconFor } from '../web/shared/hud.js'
import { autoStatusSpec } from '../web/shared/status.js'

const state = {
  林青禾: { 好感度: 62, 心情: '平静', 信任: 40 },
  你: { 体力: 80, 金钱: 120, 背包: ['伞', '铜钥匙'], 受伤: false },
}
const spec = autoStatusSpec(state)

test('kept by default: the first few numbers the layout has, as it lays them out', () => {
  assert.deepEqual(hudPicks(spec), [
    { path: '林青禾.好感度', look: 'meter' },
    { path: '林青禾.信任', look: 'number' },
    { path: '你.体力', look: 'meter' },
    { path: '你.金钱', look: 'number' },
  ])
  // The player's own choice, in their order and looks; a look it does not know reads as the layout's.
  assert.deepEqual(hudPicks(spec, { paths: ['你.金钱', '林青禾.心情'], looks: { '你.金钱': 'icon', '林青禾.心情': 'odd' } }), [
    { path: '你.金钱', look: 'icon' },
    { path: '林青禾.心情', look: 'text' },
  ])
  assert.deepEqual(hudPicks(spec, { paths: [] }), [], 'nothing kept is a choice too')
  assert.deepEqual(hudPicks(null), [])
})

test('rows: a bar its share of the range, a number, an icon, words; owners named when there are several', () => {
  const rows = hudRows(spec, [
    { path: '林青禾.好感度', look: 'meter' },
    { path: '你.金钱', look: 'icon' },
    { path: '林青禾.心情', look: 'text' },
    { path: '你.不存在', look: 'number' },
  ], state)
  assert.deepEqual(rows, [
    { path: '林青禾.好感度', label: '林青禾·好感度', look: 'meter', value: 62, percent: 62 },
    { path: '你.金钱', label: '你·金钱', look: 'icon', value: 120, icon: '💰' },
    { path: '林青禾.心情', label: '林青禾·心情', look: 'text', text: '平静' },
  ])
  // One owner: just the names.
  assert.equal(hudRows(spec, [{ path: '你.体力', look: 'number' }], state)[0].label, '体力')
  // A number that is not one reads as words.
  assert.deepEqual(hudRows(spec, [{ path: '你.体力', look: 'meter' }], { 你: { 体力: '满' } })[0], { path: '你.体力', label: '体力', look: 'text', text: '满' })
})

test('what a reply changed: numbers that moved, things gained and lost, switches; words say nothing', () => {
  const after = structuredClone(state)
  after.林青禾.好感度 = 67
  after.林青禾.心情 = '开心'
  after.你.金钱 = 95
  after.你.背包 = ['铜钥匙', '旧信']
  after.你.受伤 = true
  assert.deepEqual(changeNotes(spec, state, after), [
    { kind: 'up', label: '林青禾·好感度', delta: 5 },
    { kind: 'down', label: '你·金钱', delta: -25 },
    { kind: 'gain', label: '你·背包', item: '旧信', count: 1 },
    { kind: 'lose', label: '你·背包', item: '伞', count: 1 },
    { kind: 'on', label: '你·受伤' },
  ])
  // A bag of counts.
  const bagSpec = { fields: [{ path: '物品', show: 'tags' }] }
  assert.deepEqual(changeNotes(bagSpec, { 物品: { 药草: 1 } }, { 物品: { 药草: 3, 火把: 1 } }), [
    { kind: 'gain', label: '物品', item: '药草', count: 2 },
    { kind: 'gain', label: '物品', item: '火把', count: 1 },
  ])
  assert.deepEqual(changeNotes(spec, null, after), [], 'no state before: nothing to compare')
  assert.equal(changeNotes(spec, state, after, { max: 2 }).length, 2)
})

test('icons from the name', () => {
  assert.equal(iconFor('林青禾·好感度'), '❤️')
  assert.equal(iconFor('金钱'), '💰')
  assert.equal(iconFor('HP'), '🩸')
  assert.equal(iconFor('天气'), '◆')
})

test('a list that was not there before: nothing gained yet (the story is only starting)', () => {
  const after = { 你: { 背包: ['伞'] } }
  assert.deepEqual(changeNotes(autoStatusSpec(after), {}, after), [])
})

test('a switch reads as yes or no', () => {
  assert.deepEqual(hudRows(spec, [{ path: '你.受伤', look: 'text' }], state), [{ path: '你.受伤', label: '受伤', look: 'text', on: false }])
})
