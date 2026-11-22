// 剧本的路线图 (plans/22): the plot drawn as a line map in the 剧情向导 panel's 剧本 tab. Where the story has been is
// solid, the scene now has a ring, what lies ahead is hollow; endings are diamonds. How much shows follows the chat's
// 剧透 setting (web/shared/plot.js shown): played blind, only the way walked and question marks below it. A plot of many
// scenes opens with its chapters folded but the one now (按章折叠); on a phone a map too wide becomes an indented list.
// The arrow keys go from scene to scene.
import { t } from '/i18n.js'
import { exitLacks, sceneOf, shown } from '/shared/plot.js'
import { blindMap, chaptersOf, COL, edgePath, foldChapters, layoutMap, neighbour } from '/shared/plot-map.js'

const SVG = 'http://www.w3.org/2000/svg'
const svg = (tag, attrs = {}, children = []) => {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) node.setAttribute(key, value)
  for (const child of children) if (child) node.append(child)
  return node
}
const ENDING_NAMES = () => ({ good: t`圆满结局`, normal: t`结局`, sad: t`遗憾结局`, hidden: t`隐藏结局` })
const clipTitle = title => (title.length > 8 ? `${title.slice(0, 7)}…` : title)
// More scenes on the main line than this: the chapters but the one now start folded.
const FOLD_AT = 12
// The chapters folded, by plot, while the page is open (the map is drawn anew at each change of the chat).
const foldKept = new Map()
const phone = matchMedia('(max-width: 560px)')

/**
 * The map of a chat's plot (chatView().plot) as an element.
 * @param onJump - (sceneId) => …: the player sends the story to that scene (asked first).
 * @param onSpoiler - (spoiler) => …: the 剧透 setting changed from the map.
 * @param path - the chat's way (chatView().path), for 从这里换一条路 at a fork walked; onBranch(after, to): the next turn
 *   is sent from reply `after`, on the way `to` (回到岔路口). `forks`: say so above the map (the ending card's button).
 */
export function plotMap(view, { el, guard, onJump, onSpoiler, path = null, onBranch = null, forks = false, preview = false, onShowBar = null }) {
  const { copy, progress, spoiler } = view
  const blind = spoiler === 'blind'
  const walked = new Set([...progress.seen, progress.at])
  // 支线: the scenes their lines have been through count as walked.
  for (const line of Object.values(progress.sides ?? {})) for (const id of [...(line.seen ?? []), line.at]) walked.add(id)
  const sideSeen = id => Object.values(progress.sides ?? {}).some(line => line.seen?.includes(id))
  const card = el('div', { class: 'pm-card', hidden: true })
  // A preview (the editor, a draft): no story on it, so no 剧透 to switch.
  const head = el('div', { class: 'pm-head' }, [
    el('b', { text: copy.name }),
    preview ? null : el('div', { class: 'plot-seg', role: 'group', 'aria-label': t`剧透` }, [['blind', t`盲玩`], ['outline', t`看大纲`], ['all', t`全看`]].map(([id, name]) => el('button', {
      type: 'button', class: 'btn small', text: name, 'aria-pressed': String(id === spoiler),
      onclick: guard(async () => {
        if (id === spoiler) return
        if ((spoiler === 'blind' || (spoiler === 'outline' && id === 'all')) && !confirm(t`切到「${name}」会看到还没走到的内容，确定吗？`)) return
        await onSpoiler(id)
      }),
    }))),
  ])

  // 按章折叠: never the chapter the story is in; played blind, nothing to fold.
  const chapters = blind ? [] : chaptersOf(copy)
  const nowChapter = sceneOf(copy, progress.at)?.chapter ?? ''
  if (!foldKept.has(copy.id)) foldKept.set(copy.id, new Set(copy.scenes.filter(scene => !scene.side).length > FOLD_AT ? chapters.filter(chapter => chapter !== nowChapter) : []))
  const collapsed = foldKept.get(copy.id)
  collapsed.delete(nowChapter)
  const chips = el('div', { class: 'pm-chapters', role: 'group', 'aria-label': t`按章折叠` })
  const holder = el('div', { class: 'pm-holder' })
  let current = null
  let scroller = null

  const toggle = chapter => {
    if (collapsed.has(chapter)) collapsed.delete(chapter)
    else collapsed.add(chapter)
    card.hidden = true
    draw()
  }

  function draw() {
    const folded = foldChapters(copy, collapsed)
    const map = blind ? blindMap(copy, progress) : layoutMap(folded)
    chips.hidden = chapters.length < 2
    chips.replaceChildren(...chapters.map(chapter => el('button', {
      type: 'button', class: 'btn small ghost pm-chapter', 'aria-pressed': String(!collapsed.has(chapter)), disabled: chapter === nowChapter,
      title: chapter === nowChapter ? t`故事现在在这一章` : collapsed.has(chapter) ? t`展开这一章` : t`把这一章收成一个点`,
      text: `${collapsed.has(chapter) ? '▸' : '▾'} ${chapter}`, onclick: () => toggle(chapter),
    })))
    const columns = new Set(map.nodes.map(node => node.x)).size
    current = null
    holder.replaceChildren(!blind && phone.matches && columns > 3 ? listOf(folded, map) : pictureOf(folded, map))
  }

  // What a point on the map is: a scene, a folded chapter, or (blind) a way not found yet.
  function nodeInfo(plot, node) {
    const scene = node.id ? sceneOf(plot, node.id) : null
    const isWalked = id => walked.has(id) || Boolean(sceneOf(plot, id)?.members?.some(member => walked.has(member)))
    const seen = blind ? (node.kind === 'unknown' ? 'none' : 'full') : scene?.folded ? 'full' : shown(scene, spoiler, progress)
    const now = blind ? node.kind === 'now' : node.id === progress.at
    const kind = blind ? (node.kind === 'unknown' ? 'ahead' : now ? 'now' : 'walked') : now ? 'now' : isWalked(node.id) ? 'walked' : 'ahead'
    const label = scene?.folded ? t`${scene.chapter}（${scene.members.length} 幕）` : node.kind === 'unknown' || seen === 'none' ? t`？` : scene.title
    return { scene, seen, now, kind, label, isWalked }
  }

  function pictureOf(plot, map) {
    const picture = svg('svg', { class: 'pm-svg', viewBox: `0 0 ${map.width} ${map.height}`, width: map.width, height: map.height, role: 'img', 'aria-label': t`路线图` })
    const isWalked = nodeInfo(plot, {}).isWalked
    const seenFrom = id => progress.seen.includes(id) || sideSeen(id) || Boolean(sceneOf(plot, id)?.members?.some(member => progress.seen.includes(member)))
    // Lines first, under the scenes.
    for (const edge of map.edges) {
      const done = !blind && isWalked(edge.from) && isWalked(edge.to) && (seenFrom(edge.from) || edge.opens)
      picture.append(svg('path', { d: edgePath(edge), class: `pm-line${edge.back && !edge.opens ? ' back' : ''}${edge.opens ? ' opens' : ''}${done || (blind && !edge.dashed) ? ' walked' : ''}${edge.dashed ? ' dashed' : ''}` }))
    }
    for (const label of map.labels ?? []) picture.append(svg('text', { x: label.x, y: label.y, 'text-anchor': 'middle', class: 'pm-side-label' }, [document.createTextNode(t`支线 · ${label.text}`)]))
    const groups = new Map()
    for (const node of map.nodes) {
      const { scene, seen, now, kind, label } = nodeInfo(plot, node)
      const ending = scene?.ending ? ` ending ${scene.ending.kind}` : ''
      const shape = scene?.folded
        ? svg('rect', { x: node.x - 11, y: node.y - 8, width: 22, height: 16, rx: 5, class: 'pm-dot' })
        : scene?.ending
          ? svg('rect', { x: node.x - 7, y: node.y - 7, width: 14, height: 14, transform: `rotate(45 ${node.x} ${node.y})`, class: 'pm-dot' })
          : svg('circle', { cx: node.x, cy: node.y, r: now ? 8 : 6.5, class: 'pm-dot' })
      // Labels beside the scenes on the middle line (and on the blind map's one line), under them elsewhere.
      const beside = blind || node.main
      const group = svg('g', {
        class: `pm-node ${kind}${ending}${scene?.folded ? ' folded' : ''}`,
        tabindex: node.id ? '0' : null,
        role: node.id ? 'button' : null,
        'aria-label': node.id ? (scene?.folded ? t`${scene.chapter}，收起了 ${scene.members.length} 幕：点开` : `${seen === 'none' ? t`没走到的一幕` : scene.title}${now ? t`（现在）` : ''}`) : t`还没发现的路`,
      }, [
        now ? svg('circle', { cx: node.x, cy: node.y, r: 14, class: 'pm-ring' }) : null,
        shape,
        svg('text', { x: beside ? node.x + 14 : node.x, y: beside ? node.y + 4 : node.y + 22, 'text-anchor': beside ? 'start' : 'middle', class: 'pm-label' }, [document.createTextNode(scene?.folded ? label : clipTitle(label))]),
        svg('title', {}, [document.createTextNode(label)]),
      ])
      if (now) current = node
      if (node.id) {
        groups.set(node.id, { group, node })
        const pick = () => (scene?.folded ? toggle(scene.chapter) : showCard(node.id, seen))
        group.addEventListener('click', pick)
        group.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            pick()
            return
          }
          const next = neighbour(node, event.key, [...groups.values()].map(item => item.node))
          if (!next) return
          event.preventDefault()
          groups.get(next.id)?.group.focus()
        })
      }
      picture.append(group)
    }
    scroller = el('div', { class: 'pm-scroll' }, [picture])
    // Opened at the scene now.
    requestAnimationFrame(() => {
      if (!current || !scroller) return
      scroller.scrollLeft = Math.max(0, current.x - scroller.clientWidth / 2)
      scroller.scrollTop = Math.max(0, current.y - scroller.clientHeight / 2)
    })
    return scroller
  }

  // On a phone, a map wider than three columns: the scenes as a list, from the top down, indented by column.
  function listOf(plot, map) {
    const left = Math.min(...map.nodes.map(node => node.x))
    const nodes = [...map.nodes].filter(node => node.id).sort((a, b) => a.y - b.y || a.x - b.x)
    return el('ol', { class: 'pm-list', 'aria-label': t`路线图` }, nodes.map(node => {
      const { scene, seen, kind, label } = nodeInfo(plot, node)
      const depth = Math.min(4, Math.round((node.x - left) / COL))
      return el('li', { class: `pm-item ${kind}${scene?.ending ? ` ending ${scene.ending.kind}` : ''}${scene?.side ? ' side' : ''}`, style: `padding-left: ${depth * 14}px` }, [
        el('button', { type: 'button', onclick: () => (scene?.folded ? toggle(scene.chapter) : showCard(node.id, seen)) }, [
          el('i', { class: 'pm-item-dot', 'aria-hidden': 'true' }),
          el('span', { text: label }),
          kind === 'now' ? el('small', { class: 'muted', text: t`（现在）` }) : null,
        ].filter(Boolean)),
      ])
    }))
  }

  // 回到岔路口: the last reply still in fork `id` on the way, the way the story took from it, the others.
  function branchesAt(id) {
    const scene = sceneOf(copy, id)
    if (!path || !onBranch || !scene || scene.exits.length < 2 || !progress.seen.includes(id)) return null
    const way = path.filter((node, index) => !node.hidden && !(node.role === 'user' && path[index + 1]?.hidden))
    const at = way.findLastIndex(node => node.role === 'assistant' && node.plot?.of === copy.id && node.plot.at === id)
    const reply = way[at]
    if (!reply) return null
    // Where the story went from it: a way the player picked is on their message, one the model took on the reply.
    const next = way.slice(at + 1).find(node => (node.role === 'user' && node.plotSet?.of === copy.id && node.plotSet.at) || (node.role === 'assistant' && node.plot?.of === copy.id && node.plot.from === id))
    const taken = next ? (next.role === 'user' ? next.plotSet.at : next.plot.at) : null
    const ways = scene.exits.filter(exit => exit.to !== taken).map(exit => ({ exit, lacks: exitLacks(exit, reply.plot, reply.state) }))
    return ways.length ? { reply, ways } : null
  }

  function showCard(id, seen) {
    const scene = sceneOf(copy, id)
    const here = id === progress.at
    const branches = here ? null : branchesAt(id)
    const ending = scene.ending ? ENDING_NAMES()[scene.ending.kind] : ''
    card.hidden = false
    card.replaceChildren(...[
      el('h4', { text: seen === 'none' ? t`还没走到的一幕` : scene.title }),
      ending && seen !== 'none' ? el('span', { class: `pm-kind ${scene.ending.kind}`, text: ending }) : null,
      seen === 'full' && scene.what ? el('p', { text: scene.what }) : seen === 'title' ? el('p', { class: 'muted small', text: t`看大纲：只显示标题` }) : null,
      here ? el('p', { class: 'muted small', text: t`故事现在在这一幕` }) : scene.side ? el('button', {
        // A side line's scene: that line goes there (opened if it was not), the main story stays.
        type: 'button', class: 'btn small', text: progress.sides?.[scene.side]?.at === id ? t`支线现在在这一段` : t`让支线走到这一段`, disabled: progress.sides?.[scene.side]?.at === id,
        onclick: guard(async () => {
          const name = (copy.sides ?? []).find(side => side.id === scene.side)?.name ?? ''
          if (!confirm(t`下一轮支线「${name}」走到「${seen === 'none' ? t`？` : scene.title}」？主线不变。`)) return
          await onJump(id)
        }),
      }) : el('button', {
        type: 'button', class: 'btn small', text: t`跳到这一幕`,
        onclick: guard(async () => {
          if (!confirm(t`下一轮直接从「${seen === 'none' ? t`？` : scene.title}」开始？没演完的要点会跳过。`)) return
          await onJump(id)
        }),
      }),
      branches ? el('div', { class: 'pm-branch' }, [
        el('p', { class: 'muted small', text: t`从这里换一条路：从当时那条回复开一条新分支，原来的路还在` }),
        ...branches.ways.map(({ exit, lacks }) => {
          const target = sceneOf(copy, exit.to)
          const name = exit.hint || (shown(target, spoiler, progress) === 'none' ? t`？（还没走过的路）` : target.title)
          return el('button', {
            type: 'button', class: 'plot-way', disabled: lacks.length > 0, title: lacks.length ? t`当时条件还没满足` : '',
            onclick: guard(async () => {
              await onBranch(branches.reply.id, exit.to, scene.title)
            }),
          }, [el('span', { text: lacks.length ? t`🔒 ${name}` : name }), exit.when && spoiler !== 'blind' ? el('small', { class: 'muted', text: exit.when }) : null].filter(Boolean))
        }),
      ]) : null,
    ].filter(Boolean))
  }

  draw()
  // 剧本条 hidden on this device: shown again from here.
  const barNote = onShowBar ? el('p', { class: 'pm-hint small' }, [el('span', { text: t`剧本条藏起来了。` }), el('button', { type: 'button', class: 'btn small ghost', text: t`显示剧本条`, onclick: () => onShowBar() })]) : null
  return el('div', { class: 'pm' }, [head, barNote, forks ? el('p', { class: 'pm-hint small', text: t`点一个走过的岔路口，从那里换一条路` }) : null, chips, holder, card, el('p', { class: 'pm-legend muted small', text: blind ? t`盲玩：只显示走过的路，问号是这一幕还能去的地方` : t`实心是走过的，带圈的是现在，空心是还没到的，菱形是结局` })].filter(Boolean))
}
