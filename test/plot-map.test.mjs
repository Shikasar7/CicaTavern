// 剧本的路线图 (web/shared/plot-map.js): layers, the main line in the middle, ways fanned out, long lines through every
// row, ways back outside; the same every time; the blind map shows only the way walked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blindMap, edgePath, layoutMap } from '../web/shared/plot-map.js'
import { cleanPlot, startProgress } from '../web/shared/plot.js'

const plot = (scenes, start) => cleanPlot({ id: 'p', start, scenes: scenes.map(([id, exits = [], ending = false]) => ({ id, title: id, exits: exits.map(to => ({ to })), ending: ending ? { kind: 'good' } : null })) })
const byId = map => Object.fromEntries(map.nodes.map(node => [node.id, node]))

test('a straight line: one column, one row each', () => {
  const map = byId(layoutMap(plot([['a', ['b']], ['b', ['c']], ['c', [], true]])))
  assert.deepEqual(['a', 'b', 'c'].map(id => [map[id].layer, map[id].col]), [[0, 0], [1, 0], [2, 0]])
  assert.ok(map.a.main && map.c.main)
})

test('a fork and a merge: the merge below both ways, the ways either side; four ways fan +1 -1 +2 -2', () => {
  const map = byId(layoutMap(plot([['a', ['b', 'c']], ['b', ['d']], ['c', ['d']], ['d', [], true]])))
  assert.equal(map.b.col, 0)
  assert.equal(map.c.col, 1)
  assert.equal(map.d.layer, 2)
  const four = byId(layoutMap(plot([['a', ['m', 'x', 'y', 'z']], ['m', [], true], ['x', [], true], ['y', [], true], ['z', [], true]])))
  assert.deepEqual(['m', 'x', 'y', 'z'].map(id => four[id].col), [0, 1, -1, 2])
})

test('a line over several rows passes a point on each; a way back is drawn outside and leaves the rows alone', () => {
  const map = layoutMap(plot([['a', ['b', 'e']], ['b', ['c']], ['c', ['d']], ['d', ['a', 'e']], ['e', [], true]]))
  const nodes = byId(map)
  const long = map.edges.find(edge => edge.from === 'a' && edge.to === 'e')
  assert.equal(nodes.e.layer, 4)
  assert.equal(long.points.length, 5, 'from row 0 to row 4: three points between')
  const back = map.edges.find(edge => edge.from === 'd' && edge.to === 'a')
  assert.equal(back.back, true)
  assert.ok(back.points[1][0] > Math.max(...map.nodes.map(node => node.x)), 'outside every scene')
  assert.match(edgePath(back), /^M[\d. ]+ L/)
  assert.match(edgePath(long), /^M[\d. ]+ C/)
})

test('a scene the start never reaches goes to the bottom, marked', () => {
  const map = byId(layoutMap(plot([['a', ['b']], ['b', [], true], ['z', ['b']]])))
  assert.equal(map.z.lost, true)
  assert.ok(map.z.layer > map.b.layer)
})

// A small seeded random, so a failure can be read again.
function random(seed) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

test('any plot: no two scenes in one place, lines down go down, all inside, the same twice, quick', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = random(seed)
    const count = 1 + Math.floor(rand() * 60)
    const ids = Array.from({ length: count }, (_, i) => `s${i}`)
    const scenes = ids.map(id => [id, Array.from({ length: Math.floor(rand() * 5) }, () => ids[Math.floor(rand() * count)]), rand() < 0.15])
    const p = plot(scenes)
    const started = performance.now()
    const map = layoutMap(p)
    const took = performance.now() - started
    assert.ok(took < 50, `seed ${seed}: ${took} ms`)
    const places = new Set(map.nodes.map(node => `${node.layer}:${node.col}`))
    assert.equal(places.size, map.nodes.length, `seed ${seed}: two in one place`)
    const nodes = byId(map)
    for (const edge of map.edges) if (!edge.back && !nodes[edge.from].lost && !nodes[edge.to].lost) assert.ok(nodes[edge.to].layer > nodes[edge.from].layer, `seed ${seed}: ${edge.from}>${edge.to}`)
    for (const node of map.nodes) assert.ok(node.x >= 0 && node.x <= map.width && node.y >= 0 && node.y <= map.height, `seed ${seed}: outside`)
    assert.deepEqual(layoutMap(p), map, `seed ${seed}: not the same twice`)
  }
})

test('played blind: only the way walked, the scene now and question marks for its open ways', () => {
  const p = cleanPlot({ id: 'p', scenes: [
    { id: 'a', title: '初遇', exits: [{ to: 'b' }] },
    { id: 'b', title: '雨夜', exits: [{ to: 'c' }, { to: 'd' }, { to: 'e', needs: { unseen: 'a' } }] },
    { id: 'c', title: '秘密结局', ending: { kind: 'hidden' } }, { id: 'd', title: '寄信', ending: { kind: 'sad' } }, { id: 'e', title: '?', ending: { kind: 'good' } },
  ] })
  const progress = { ...startProgress(p, 'b'), seen: ['a'] }
  const map = blindMap(p, progress)
  assert.deepEqual(map.nodes.map(node => node.kind), ['walked', 'now', 'unknown', 'unknown'], 'the third way is shut: not even a question mark')
  assert.deepEqual(map.nodes.filter(node => node.id).map(node => node.id), ['a', 'b'])
  assert.ok(!JSON.stringify(map).includes('秘密结局'))
  const later = blindMap(p, { ...progress, at: 'd', seen: ['a', 'b'] })
  assert.equal(later.nodes.filter(node => node.kind === 'unknown').length, 0, 'an ending has no way on')
})
