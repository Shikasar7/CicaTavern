// 剧本的路线图 (plans/22 十一·3): where each 幕 sits, laid out from the plot alone, so the map stays put as the story
// walks it. Layers top to bottom (a scene below every way into it), the main line (each scene's first way on) in the
// middle column, other ways fanned out to the sides, ways back up drawn round the outside. Shared, so it is tested.
import { exitOpen, sceneOf } from './plot.js'

export const COL = 92
export const ROW = 66
const PAD = 28

const SIDE_GAP = 36

/**
 * @returns { nodes: [{ id, layer, col, x, y, main, lost, side? }], edges: [{ from, to, back, points: [[x, y], …],
 *   opens? }], labels: [{ x, y, text, side }], width, height }. `lost`: a scene the start never reaches (bottom row).
 *   Dummy points carry long edges; they are not nodes. 支线 (plans/22 十三·6): each laid out on its own to the right
 *   of the main line, level with the scene that opens it, a dashed line from that scene to its start.
 */
export function layoutMap(plot, options = {}) {
  const sides = plot?.sides ?? []
  const main = layoutLine({ ...plot, scenes: (plot?.scenes ?? []).filter(scene => !scene.side) }, options)
  if (!sides.length) return { ...main, labels: [] }
  let { nodes, edges, width, height } = main
  const labels = []
  for (const side of sides) {
    const line = layoutLine({ ...plot, start: side.start, scenes: plot.scenes.filter(scene => scene.side === side.id) }, options)
    const opener = nodes.find(node => node.id === side.opens)
    const dx = width + SIDE_GAP
    const dy = opener ? opener.y - PAD : 0
    const shift = ([x, y]) => [x + dx, y + dy]
    const placed = line.nodes.map(node => ({ ...node, x: node.x + dx, y: node.y + dy, main: false, side: side.id }))
    const start = placed.find(node => node.id === side.start)
    nodes = [...nodes, ...placed]
    edges = [...edges, ...line.edges.map(edge => ({ ...edge, points: edge.points.map(shift) }))]
    if (opener && start) edges.push({ from: opener.id, to: start.id, back: true, opens: true, points: [[opener.x, opener.y], [start.x, opener.y], [start.x, start.y]] })
    labels.push({ x: start?.x ?? dx + PAD, y: (start?.y ?? dy + PAD) - 18, text: side.name, side: side.id })
    width = dx + line.width
    height = Math.max(height, dy + line.height)
  }
  return { nodes, edges, labels, width, height }
}

function layoutLine(plot, { maxCols = 5, col = COL, row = ROW } = {}) {
  const scenes = plot?.scenes ?? []
  const ids = scenes.map(scene => scene.id)
  const exitsOf = id => (sceneOf(plot, id)?.exits ?? []).map(exit => exit.to).filter(to => sceneOf(plot, to))
  // 1. Ways back: from the start, depth first in the order of the exits; an exit to a scene still on the way down is one.
  const back = new Set()
  const reached = new Set()
  const onWay = new Set()
  const order = []
  const visit = id => {
    reached.add(id)
    onWay.add(id)
    for (const to of exitsOf(id)) {
      if (onWay.has(to)) back.add(`${id}>${to}`)
      else if (!reached.has(to)) visit(to)
    }
    onWay.delete(id)
    order.push(id)
  }
  if (scenes.length) visit(plot.start)
  order.reverse()
  // 2. Layers: one more than the deepest way in.
  const layer = new Map([[plot?.start, 0]])
  for (const id of order) {
    for (const to of exitsOf(id)) {
      if (back.has(`${id}>${to}`)) continue
      layer.set(to, Math.max(layer.get(to) ?? 0, (layer.get(id) ?? 0) + 1))
    }
  }
  const deepest = Math.max(0, ...layer.values())
  const lost = ids.filter(id => !reached.has(id))
  lost.forEach((id, i) => layer.set(id, deepest + 1 + Math.floor(i / maxCols)))
  // 3. The main line: the start, then each scene's first way on, down to an ending or a scene it already had.
  const main = new Set()
  for (let id = plot?.start; id && !main.has(id) && reached.has(id);) {
    main.add(id)
    id = exitsOf(id).find(to => !back.has(`${id}>${to}`))
  }
  // 4. Columns, layer by layer: the main line in the middle; the others near their ways in, a scene's ways fanned out
  // +1, -1, +2, -2 in their order; two in one layer never share a column.
  const colOf = new Map()
  const fan = [0, 1, -1, 2, -2, 3, -3]
  const parents = new Map(ids.map(id => [id, []]))
  for (const id of ids) for (const [index, to] of exitsOf(id).entries()) if (!back.has(`${id}>${to}`)) parents.get(to).push({ id, index })
  const layers = Array.from({ length: Math.max(0, ...layer.values()) + 1 }, () => [])
  for (const id of ids) layers[layer.get(id)].push(id)
  for (const inLayer of layers) {
    const taken = new Set()
    for (const id of inLayer.filter(id => main.has(id))) {
      colOf.set(id, 0)
      taken.add(0)
    }
    const wanted = inLayer.filter(id => !main.has(id)).map(id => {
      const ins = parents.get(id).filter(p => colOf.has(p.id))
      if (lost.includes(id)) return { id, want: (lost.indexOf(id) % maxCols) - Math.floor(Math.min(lost.length, maxCols) / 2) }
      if (!ins.length) return { id, want: 1 }
      if (ins.length === 1) {
        // Its place among the parent's ways that are not the main line's.
        const p = ins[0]
        const siblings = exitsOf(p.id).filter(to => !main.has(to) && !back.has(`${p.id}>${to}`))
        const slot = siblings.indexOf(id) + 1
        return { id, want: colOf.get(p.id) + fan[Math.min(slot, fan.length - 1)] * (colOf.get(p.id) < 0 ? -1 : 1) }
      }
      return { id, want: ins.reduce((sum, p) => sum + colOf.get(p.id), 0) / ins.length }
    })
    wanted.sort((a, b) => Math.abs(a.want) - Math.abs(b.want) || a.want - b.want)
    for (const { id, want } of wanted) {
      const near = Math.round(want)
      let pick = near
      for (let d = 0; d < 40; d++) {
        const away = Math.sign(near || 1)
        const tries = [near + d * away, near - d * away]
        const free = tries.find(c => !taken.has(c) && (c !== 0 || !inLayer.some(other => main.has(other))))
        if (free !== undefined) {
          pick = free
          break
        }
      }
      colOf.set(id, pick)
      taken.add(pick)
    }
  }
  const cols = [...colOf.values()]
  const low = Math.min(0, ...cols)
  const high = Math.max(0, ...cols)
  const backLanes = [...back].length
  const width = (high - low) * col + PAD * 2 + (backLanes ? 16 + backLanes * 12 : 0)
  const height = (layers.length - 1) * row + PAD * 2
  const xOf = c => PAD + (c - low) * col
  const yOf = l => PAD + l * row
  const nodes = ids.map(id => ({ id, layer: layer.get(id), col: colOf.get(id), x: xOf(colOf.get(id)), y: yOf(layer.get(id)), main: main.has(id), lost: lost.includes(id) }))
  const at = new Map(nodes.map(node => [node.id, node]))
  // 5. Lines: down ones through a point on each layer they cross (where their column would be); back ones outside.
  const edges = []
  let lane = 0
  for (const id of ids) {
    for (const to of exitsOf(id)) {
      const from = at.get(id)
      const end = at.get(to)
      if (back.has(`${id}>${to}`)) {
        const x = xOf(high) + 16 + lane++ * 12
        edges.push({ from: id, to, back: true, points: [[from.x, from.y], [x, from.y], [x, end.y], [end.x, end.y]] })
        continue
      }
      const points = [[from.x, from.y]]
      for (let l = from.layer + 1; l < end.layer; l++) {
        const t = (l - from.layer) / (end.layer - from.layer)
        points.push([Math.round(from.x + (end.x - from.x) * t), yOf(l)])
      }
      points.push([end.x, end.y])
      edges.push({ from: id, to, back: false, points })
    }
  }
  return { nodes, edges, width, height }
}

/**
 * 按章折叠: `plot` with each chapter of `collapsed` (chapter names) as one scene of its own, id `chapter:<name>`, its
 * ways on those of its scenes that leave it; ways into any of its scenes lead to it. Side lines are not folded.
 * The folded one keeps `members` (its scenes' ids) and `folded: true`.
 */
export function foldChapters(plot, collapsed = new Set()) {
  if (!plot || !collapsed.size) return plot
  const idOf = chapter => `chapter:${chapter}`
  const into = new Map()
  for (const scene of plot.scenes) if (!scene.side && scene.chapter && collapsed.has(scene.chapter)) into.set(scene.id, idOf(scene.chapter))
  if (!into.size) return plot
  const redirect = id => into.get(id) ?? id
  const scenes = []
  const groups = new Map()
  for (const scene of plot.scenes) {
    const folded = into.get(scene.id)
    if (!folded) {
      scenes.push({ ...scene, exits: dedupe(scene.exits.map(exit => ({ ...exit, to: redirect(exit.to) }))) })
      continue
    }
    if (!groups.has(folded)) {
      const group = { id: folded, title: scene.chapter, chapter: scene.chapter, what: '', points: [], done: '', style: '', minTurns: 0, maxTurns: null, exits: [], ending: null, folded: true, members: [] }
      groups.set(folded, group)
      scenes.push(group)
    }
    const group = groups.get(folded)
    group.members.push(scene.id)
    for (const exit of scene.exits) if (redirect(exit.to) !== folded) group.exits.push({ ...exit, to: redirect(exit.to) })
  }
  for (const group of groups.values()) group.exits = dedupe(group.exits)
  return { ...plot, start: redirect(plot.start), sides: (plot.sides ?? []).map(side => ({ ...side, opens: redirect(side.opens) })), scenes }
}

const dedupe = exits => exits.filter((exit, index) => exits.findIndex(other => other.to === exit.to) === index)

/** The chapters of a plot's main line, in order. */
export const chaptersOf = plot => [...new Set((plot?.scenes ?? []).filter(scene => !scene.side && scene.chapter).map(scene => scene.chapter))]

/** An SVG path through `points`: curves between rows for lines down, straight runs for the lines back. */
export function edgePath({ points, back }) {
  if (back) return `M${points.map(p => p.join(' ')).join(' L')}`
  let d = `M${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]
    const [x2, y2] = points[i]
    const mid = (y1 + y2) / 2
    d += ` C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`
  }
  return d
}

/**
 * The map played blind: only what the story has been through, in the order it went (a scene come back to drawn
 * again), the scene now, and below it its open ways as question marks. Nothing else of the plot shows in it: its size
 * tells only how far the story has come. → { nodes: [{ key, id?, x, y, kind: 'walked' | 'now' | 'unknown' }], edges, width, height }
 */
export function blindMap(plot, progress, { col = COL, row = ROW } = {}) {
  const walked = [...progress.seen, progress.at]
  const ways = sceneOf(plot, progress.at)?.ending ? [] : (sceneOf(plot, progress.at)?.exits ?? []).filter(exit => exitOpen(exit, progress))
  const span = Math.max(1, ways.length)
  const width = (span - 1) * col + PAD * 2
  const mid = PAD + ((span - 1) * col) / 2
  const nodes = walked.map((id, i) => ({ key: `w${i}`, id, x: mid, y: PAD + i * row, kind: i === walked.length - 1 ? 'now' : 'walked' }))
  const edges = nodes.slice(1).map((node, i) => ({ points: [[mid, nodes[i].y], [mid, node.y]], back: false }))
  const y = PAD + walked.length * row
  ways.forEach((_, i) => {
    const x = PAD + i * col
    nodes.push({ key: `q${i}`, x, y, kind: 'unknown' })
    edges.push({ points: [[mid, y - row], [x, y]], back: false, dashed: true })
  })
  return { nodes, edges, width, height: (ways.length ? y : y - row) + PAD }
}

/** The point the arrow key `key` goes to from `from`: the nearest one below or above, or beside it on its row. */
export function neighbour(from, key, nodes) {
  const others = nodes.filter(node => node !== from && node.id)
  const row = 8
  const pickBy = (list, score) => list.reduce((best, node) => (!best || score(node) < score(best) ? node : best), null)
  if (key === 'ArrowDown') return pickBy(others.filter(node => node.y > from.y + row), node => (node.y - from.y) * 1000 + Math.abs(node.x - from.x))
  if (key === 'ArrowUp') return pickBy(others.filter(node => node.y < from.y - row), node => (from.y - node.y) * 1000 + Math.abs(node.x - from.x))
  if (key === 'ArrowRight') return pickBy(others.filter(node => Math.abs(node.y - from.y) <= row && node.x > from.x), node => node.x - from.x)
  if (key === 'ArrowLeft') return pickBy(others.filter(node => Math.abs(node.y - from.y) <= row && node.x < from.x), node => from.x - node.x)
  return null
}
