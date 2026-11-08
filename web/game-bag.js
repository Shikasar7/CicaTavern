// 行囊 (游戏规则): the player's side of the sheet: who they are, what they carry, what they are after. Nothing here
// changes the story at once. What is done goes into the turn's operations, shown by the input box, and is settled
// with the next turn (app.js), so a rollback or a branch takes it back like everything else.
import { t } from '/i18n.js'

const TABS = () => [['self', t`角色`], ['party', t`队伍`], ['bag', t`背包`], ['quests', t`任务`], ['map', t`地图`], ['deeds', t`成就`], ['sound', t`声音`]]
const LAYER_WORDS = () => [['effects', t`音效`], ['ambience', t`环境音`], ['music', t`音乐`]]
const MAX_TRACK = 28 * 1024 * 1024
const EFFECT_WORDS = () => ({ heal: t`回血`, energy: t`回气力`, calm: t`回复理智`, damage: t`攻击`, cure: t`解除异常`, boost: t`增益`, none: t`只有剧情用途` })
const SIZE_WORDS = () => ({ small: t`小`, medium: t`中等`, large: t`大` })
// Things the helper has been asked about on this page: once each.
const asked = new Set()

/**
 * @param deps - { el, api, toast, chat, tab (the page to open on), book, play (web/game-play.js), sound (web/game-sound.js), queue () → the turn's
 *   operations, addOp (op), fill (text), onBook (book), onMusic () (the tracks changed), onClose () }
 */
export function openBag({ el, api, toast, chat, tab: firstTab = 'self', book: firstBook, play, sound, queue, addOp, fill, onBook, onMusic, onClose }) {
  let book = firstBook
  let tab = firstTab
  const body = el('div', { class: 'bag-body' })
  const tabs = el('div', { class: 'bag-tabs', role: 'tablist' })
  const said = (key, fallback) => book.words?.[key] || fallback
  const dialog = el('dialog', { class: 'dialog game-bag', 'aria-label': said('bag', t`行囊`) }, [
    el('button', { type: 'button', class: 'btn small dialog-x', text: t`关闭`, onclick: () => dialog.close() }),
    el('div', { class: 'bag-head' }, [el('h2', { text: said('bag', t`行囊`) }), tabs]),
    body,
    el('p', { class: 'hint bag-foot', text: t`这里做的改动随下一轮一起生效，输入框上方可以取消。` }),
  ])
  const sheet = () => play.sheetFor(chat, book, queue())
  const bound = field => Boolean(book.bindings[field])
  const brokenNote = field => (sheet().broken.includes(field) ? el('p', { class: 'hint warn', text: t`绑定的变量读不出来，显示的是上次的值。` }) : null)
  const act = op => {
    addOp(op)
    render()
  }

  function meter(label, field, most) {
    const value = sheet()[field]
    const input = el('input', { type: 'number', min: 0, max: most, value, 'aria-label': label, class: 'bag-number' })
    input.addEventListener('change', () => act({ op: field, value: Number(input.value) }))
    return el('div', { class: 'bag-row' }, [
      el('div', { class: 'bag-main' }, [
        el('span', { class: 'bag-name', text: label }),
        el('span', { class: 'bag-bar' }, el('i', { style: `width: ${most ? Math.round((value / most) * 100) : 0}%` })),
        bound(field) ? el('span', { class: 'hint', text: t`来自变量 ${book.bindings[field]}` }) : null,
      ]),
      input,
      el('span', { class: 'bag-of', text: `/ ${most}` }),
    ])
  }

  /** What holds the player back: it wears off with the days, and the player can say it is over when the story forgot. */
  function ailRows() {
    const ails = play.ailsOf(sheet())
    return ails.length ? [el('h3', { text: t`状态` }), ...ails.map(ail => el('div', { class: 'bag-thing' }, [
      el('div', { class: 'bag-main' }, [el('span', { class: 'bag-name', text: ail.shown }), el('span', { class: 'hint', text: t`${ail.effect}，最多还有 ${ail.days} 天或 ${ail.turns} 轮` })]),
      el('div', { class: 'bag-actions' }, [el('button', { type: 'button', class: 'btn small', text: t`已经好了`, title: t`故事里已经好了，这里解除`, onclick: () => act({ op: 'mend', name: ail.name }) })]),
    ]))] : []
  }

  function selfPage() {
    const now = sheet()
    return [
      meter(said('life', t`生命`), 'life', now.maxLife),
      brokenNote('life'),
      now.sanity === undefined ? null : meter(t`理智`, 'sanity', now.maxSanity),
      brokenNote('sanity'),
      ...play.strainOf(now).map(text => el('p', { class: 'hint', text })),
      bound('energy') || book.level === 'full' ? meter(book.energyName || t`气力`, 'energy', now.maxEnergy) : null,
      brokenNote('energy'),
      bound('money') ? el('div', { class: 'bag-row' }, [el('span', { class: 'bag-name', text: t`金钱` }), el('b', { text: String(now.money ?? 0) })]) : null,
      book.level === 'full' ? el('div', { class: 'bag-row' }, [
        el('span', { class: 'bag-name', text: [t`等级 ${now.level}`, play.rankNow(now, book)].filter(Boolean).join(' · ') }),
        bound('rank') || bound('level') ? el('span', { class: 'hint', text: t`来自变量 ${book.bindings.rank ?? book.bindings.level}` }) : el('span', { class: 'hint', text: `${said('experience', t`经验`)} ${now.experience ?? 0} / ${play.levelNeeds(now.level)}` }),
      ]) : null,
      brokenNote('rank'),
      ...ailRows(),
      el('h3', { text: now.points ? t`属性（还有 ${now.points} 点可加）` : t`属性` }),
      el('div', { class: 'bag-stats' }, play.attributesOf(now).map(item => el('div', { class: 'bag-stat' }, [
        el('span', { text: item.name }),
        el('b', { text: String(item.value) }),
        el('span', { class: 'hint', text: item.modifier < 0 ? `−${-item.modifier}` : `+${item.modifier}` }),
        now.points ? el('button', { type: 'button', class: 'btn small', text: '+', 'aria-label': t`加到${item.name}`, onclick: () => act({ op: 'point', id: item.id }) }) : null,
      ]))),
      now.skills.length ? el('h3', { text: said('skill', t`技能`) }) : null,
      now.skills.length ? el('p', { text: now.skills.join(t`、`) }) : null,
    ]
  }

  /**
   * 队伍: who fights beside the player (出战, three at most, in this order) and who travels with them but sits a fight
   * out (待命). Changes go with the next turn like everything else here, and the next fight is fought by them already.
   */
  function partyPage() {
    const now = sheet()
    const party = now.party ?? []
    const fielded = play.fieldedOf(now)
    const resting = party.filter(member => !fielded.includes(member))
    const known = Object.keys(book.companions ?? {}).filter(name => !party.some(member => member.name === name))
    const full = fielded.length >= play.MAX_FIELDED
    const memberCard = (member, fighting) => {
      const stats = play.attributesOf({ ...member, named: now.named })
      const at = fielded.indexOf(member)
      return el('div', { class: `bag-member${member.hurt ? ' hurt' : ''}` }, [
        el('div', { class: 'bag-member-head' }, [
          el('b', { class: 'bag-name', text: member.name }),
          el('span', { class: 'hint', text: [t`${member.level} 级`, `${said('life', t`生命`)} ${member.life}/${member.maxLife}`, member.hurt ? t`负伤` : ''].filter(Boolean).join(' · ') }),
          el('span', { class: 'bag-actions' }, [
            fighting && at > 0 ? el('button', { type: 'button', class: 'btn small', text: t`前移`, onclick: () => act({ op: 'party', act: 'up', name: member.name }) }) : null,
            fighting ? el('button', { type: 'button', class: 'btn small', text: t`待命`, onclick: () => act({ op: 'party', act: 'bench', name: member.name }) }) : null,
            !fighting && member.bench && !member.hurt ? el('button', { type: 'button', class: 'btn small', text: t`出战`, disabled: full, title: full ? t`出战最多 ${play.MAX_FIELDED} 人，先让一个人待命` : '', onclick: () => act({ op: 'party', act: 'field', name: member.name }) }) : null,
            member.hurt ? el('button', { type: 'button', class: 'btn small', text: t`已经好了`, title: t`故事里伤已经好了，让${member.name}能上场`, onclick: () => act({ op: 'party', act: 'back', name: member.name }) }) : null,
            el('button', { type: 'button', class: 'btn small', text: t`离队`, onclick: () => act({ op: 'party', act: 'leave', name: member.name }) }),
          ]),
        ]),
        el('div', { class: 'bag-stats' }, stats.map(item => el('div', { class: 'bag-stat' }, [
          el('span', { text: item.name }),
          el('b', { text: String(item.value) }),
          el('span', { class: 'hint', text: item.modifier < 0 ? `−${-item.modifier}` : `+${item.modifier}` }),
          member.points ? el('button', { type: 'button', class: 'btn small', text: '+', 'aria-label': t`给${member.name}加到${item.name}`, onclick: () => act({ op: 'point', id: item.id, who: member.name }) }) : null,
        ]))),
        el('p', { class: 'hint', text: [member.skills.length ? t`${said('skill', t`技能`)}：${member.skills.join(t`、`)}` : '', member.points ? t`还有 ${member.points} 点可加` : '', `${said('experience', t`经验`)} ${member.experience ?? 0} / ${play.levelNeeds(member.level)}`].filter(Boolean).join(' · ') }),
      ])
    }
    return [
      el('p', { class: 'hint', text: t`出战的人和你一起上场，最多 ${play.MAX_FIELDED} 人，按这里的顺序排。待命的人跟着走，但不上场。` }),
      book.level === 'full' ? null : el('p', { class: 'hint warn', text: t`这张卡的规则没开「完整」，没有战斗，这一页暂时用不上。` }),
      el('h3', { text: t`出战（${fielded.length}/${play.MAX_FIELDED}）` }),
      ...(fielded.length ? fielded.map(member => memberCard(member, true)) : [el('p', { class: 'hint', text: t`现在只有你一个人上场。` })]),
      resting.length ? el('h3', { text: t`待命` }) : null,
      ...resting.map(member => memberCard(member, false)),
      known.length ? el('h3', { text: t`还没入队` }) : null,
      ...known.map(name => el('div', { class: 'bag-row' }, [
        el('span', { class: 'bag-name', text: name }),
        el('span', { class: 'hint', text: t`故事里加入时会自动入队，也可以现在就加` }),
        el('button', { type: 'button', class: 'btn small', text: t`入队`, onclick: () => act({ op: 'party', act: 'join', name }) }),
      ])),
      party.length || known.length ? null : el('p', { class: 'hint', text: t`这张卡还没有同伴。可以在角色卡的「游戏规则」里加；故事里有人入队时，也会自动加进来。` }),
      adder(t`名字`, t`让谁入队`, name => act({ op: 'party', act: 'join', name })),
    ]
  }

  async function saveEffect(name, effect) {
    const items = { ...book.items }
    if (effect) items[name] = effect
    else delete items[name]
    book = await api(`/api/cards/${chat.cardId}/game`, { method: 'PUT', body: { items } })
    onBook(book)
    render()
  }

  function effectPicker(thing) {
    const set = book.items[thing.name] ?? null
    const guessed = play.effectOf(book, thing.name)
    const words = EFFECT_WORDS()
    const kind = el('select', { 'aria-label': t`${thing.name}的效果` }, [
      el('option', { value: '', text: guessed && !set ? t`按名字猜：${words[guessed.type]}` : t`未设定效果`, selected: !set }),
      ...Object.entries(words).map(([value, text]) => el('option', { value, text, selected: value === set?.type })),
    ])
    const size = el('select', { 'aria-label': t`${thing.name}的强度`, hidden: !set?.size }, Object.entries(SIZE_WORDS()).map(([value, text]) => el('option', { value, text, selected: value === (set?.size ?? 'medium') })))
    const change = () => saveEffect(thing.name, kind.value ? { type: kind.value, size: size.value } : null).catch(error => toast(error.message))
    kind.addEventListener('change', change)
    size.addEventListener('change', change)
    return el('span', { class: 'bag-effect' }, [kind, size])
  }

  function thingRow(thing) {
    const effect = play.effectOf(book, thing.name)
    const usable = play.usableNow(effect)
    const full = usable && play.nothingToRestore(effect, sheet())
    return el('div', { class: 'bag-thing' }, [
      el('div', { class: 'bag-main' }, [
        el('span', { class: 'bag-name', text: thing.count > 1 ? `${thing.name} ×${thing.count}` : thing.name }),
        thing.note ? el('span', { class: 'hint', text: thing.note }) : null,
        effectPicker(thing),
      ]),
      el('div', { class: 'bag-actions' }, [
        usable ? el('button', { type: 'button', class: 'btn small primary', text: t`使用`, disabled: full, title: full ? (effect.type === 'cure' ? t`现在没有要解除的状态` : t`已经是满的，用了也是浪费`) : '', onclick: () => act({ op: 'use', name: thing.name }) }) : null,
        el('button', { type: 'button', class: 'btn small', text: t`写进行动`, title: t`把它填进输入框，让故事里用上`, onclick: () => { dialog.close(); fill(t`使用${thing.name}`) } }),
        el('button', { type: 'button', class: 'btn small', text: '−', title: t`从背包里减一个`, 'aria-label': t`减少${thing.name}`, onclick: () => act({ op: 'lose', name: thing.name, count: 1 }) }),
      ]),
    ])
  }

  function adder(placeholder, label, add) {
    const input = el('input', { type: 'text', placeholder, 'aria-label': placeholder, maxlength: 40 })
    const go = () => {
      const name = input.value.trim()
      if (name) add(name)
    }
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') go()
    })
    return el('div', { class: 'bag-add' }, [input, el('button', { type: 'button', class: 'btn small', text: label, onclick: go })])
  }

  function bagPage() {
    const { things } = sheet()
    return [
      brokenNote('things'),
      bound('things') ? el('p', { class: 'hint', text: t`来自变量 ${book.bindings.things}` }) : null,
      things.length ? null : el('p', { class: 'hint', text: t`背包是空的。` }),
      ...things.map(thingRow),
      adder(t`漏记的东西`, t`添加`, name => act({ op: 'gain', name, count: 1 })),
    ]
  }

  function questRow(item) {
    const open = item.status === 'new' && !bound('quests')
    return el('div', { class: `bag-thing quest-${item.status}` }, [
      el('div', { class: 'bag-main' }, [el('span', { class: 'bag-name', text: item.title }), item.note ? el('span', { class: 'hint', text: item.note }) : null]),
      open ? el('div', { class: 'bag-actions' }, [
        el('button', { type: 'button', class: 'btn small', text: t`完成`, onclick: () => act({ op: 'quest', name: item.title, status: 'done' }) }),
        el('button', { type: 'button', class: 'btn small', text: t`失败`, onclick: () => act({ op: 'quest', name: item.title, status: 'failed' }) }),
      ]) : null,
    ])
  }

  function questsPage() {
    const { quests } = sheet()
    const group = (title, status) => {
      const list = quests.filter(item => item.status === status)
      return list.length ? [el('h3', { text: title }), ...list.map(questRow)] : []
    }
    return [
      brokenNote('quests'),
      bound('quests') ? el('p', { class: 'hint', text: t`这张卡自己记任务（变量 ${book.bindings.quests}），这里只看。` }) : null,
      quests.length ? null : el('p', { class: 'hint', text: t`还没有任务。` }),
      ...group(t`进行中`, 'new'),
      ...group(t`已完成`, 'done'),
      ...group(t`已失败`, 'failed'),
      bound('quests') ? null : adder(t`漏记的任务`, t`添加`, name => act({ op: 'quest', name, status: 'new' })),
    ]
  }

  // A card's scenes, for the pictures: read when the map is first opened.
  let scenes = null

  function placeCard(place, here) {
    const picture = place.scene?.file ? el('img', { src: `/api/scenes/${chat.cardId}/${place.scene.file}`, alt: '', loading: 'lazy' }) : el('span', { class: 'map-blank', 'aria-hidden': 'true', text: place.name.slice(0, 1) })
    const go = () => {
      dialog.close()
      fill(t`前往${place.name}`)
    }
    return el('button', { type: 'button', class: `map-place${here ? ' here' : ''}`, disabled: here, title: here ? t`你在这里` : t`把「前往${place.name}」填进输入框`, onclick: go }, [
      picture,
      el('span', { class: 'map-name', text: place.name }),
      el('span', { class: 'hint', text: here ? t`你在这里` : place.visits > 1 ? t`来过 ${place.visits} 次` : '' }),
    ])
  }

  function mapPage() {
    if (!scenes) {
      api(`/api/cards/${chat.cardId}/scenes`).then(view => view.scenes, () => []).then(list => {
        scenes = list
        if (dialog.open && tab === 'map') render()
      })
      return []
    }
    const { places, here } = play.visitedPlaces(chat.path, scenes)
    if (!places.length) return [el('p', { class: 'hint', text: t`还没有记下去过的地方。回复写明地点后，这里就会有。` })]
    return [el('div', { class: 'map-grid' }, places.map(place => placeCard(place, place.key === here)))]
  }

  function deedsPage() {
    const tally = play.tallyOf(chat.path)
    const words = play.achievementWords()
    const row = item => {
      const reached = tally[item.counts] >= item.need
      const [name, how] = words[item.id]
      return el('div', { class: `bag-row deed${reached ? ' reached' : ''}` }, [
        el('span', { class: 'deed-mark', 'aria-hidden': 'true', text: reached ? '★' : '☆' }),
        el('div', { class: 'bag-main' }, [el('span', { class: 'bag-name', text: name }), el('span', { class: 'hint', text: how })]),
        el('span', { class: 'hint', text: reached ? t`已达成` : item.need > 1 ? `${tally[item.counts]} / ${item.need}` : '' }),
      ])
    }
    return [
      el('p', { class: 'hint', text: t`这条故事线上做到的事：${play.reachedBy(tally).length} / ${play.ACHIEVEMENTS.length}。回退或走另一条分支时跟着变。` }),
      ...play.ACHIEVEMENTS.map(row),
    ]
  }

  // The player's tracks: read when the page is first opened.
  let tracks = null

  function useChoices(value) {
    const places = play.visitedPlaces(chat.path, []).places.map(place => place.name)
    const list = [['story', t`故事`], ['battle', t`战斗`], ...places.map(name => [name, name])]
    if (value && !list.some(([key]) => key === value)) list.push([value, value])
    return list.map(([key, text]) => el('option', { value: key, text, selected: key === value }))
  }

  function trackRow(track) {
    const use = el('select', { 'aria-label': t`${track.name}用在哪里` }, useChoices(track.use))
    use.addEventListener('change', () => api(`/api/cards/${chat.cardId}/music/${track.id}`, { method: 'PUT', body: { use: use.value } }).then(next => {
      Object.assign(track, next)
      onMusic()
    }, error => toast(error.message)))
    const remove = () => api(`/api/cards/${chat.cardId}/music/${track.id}`, { method: 'DELETE' }).then(() => {
      tracks = tracks.filter(item => item !== track)
      onMusic()
      render()
    }, error => toast(error.message))
    return el('div', { class: 'bag-thing' }, [
      el('div', { class: 'bag-main' }, [el('span', { class: 'bag-name', text: track.name }), use]),
      el('button', { type: 'button', class: 'btn small', text: t`删除`, onclick: remove }),
    ])
  }

  function pickTrack(input) {
    const file = input.files[0]
    input.value = ''
    if (!file) return
    if (file.size > MAX_TRACK) return toast(t`文件太大，音乐不能超过 28 MB`)
    const reader = new FileReader()
    reader.onload = () => api(`/api/cards/${chat.cardId}/music`, { method: 'POST', body: { name: file.name.replace(/\.[^.]+$/, ''), use: 'story', data: reader.result } }).then(track => {
      tracks = [...tracks, track]
      // Music is off until there is some: the player has just asked for it.
      if (!sound.prefs().music) sound.setPrefs({ music: 0.6 })
      onMusic()
      render()
    }, error => toast(error.message))
    reader.readAsDataURL(file)
  }

  function soundPage() {
    if (!sound) return [el('p', { class: 'hint', text: t`这个页面放不了声音。` })]
    if (!tracks) {
      api(`/api/cards/${chat.cardId}/music`).then(view => view.tracks, () => []).then(list => {
        tracks = list
        if (dialog.open && tab === 'sound') render()
      })
      return []
    }
    const prefs = sound.prefs()
    const master = el('input', { type: 'checkbox', checked: prefs.on, 'aria-label': t`声音` })
    master.addEventListener('change', () => {
      sound.setPrefs({ on: master.checked })
      render()
    })
    const slider = ([layer, label]) => {
      const input = el('input', { type: 'range', min: 0, max: 100, value: Math.round(prefs[layer] * 100), 'aria-label': label, disabled: !prefs.on })
      input.addEventListener('input', () => sound.setPrefs({ [layer]: Number(input.value) / 100 }))
      if (layer === 'effects') input.addEventListener('change', () => sound.play('hit'))
      return el('div', { class: 'bag-row' }, [el('span', { class: 'bag-name', text: label }), input])
    }
    const file = el('input', { type: 'file', accept: 'audio/*', hidden: true })
    file.addEventListener('change', () => pickTrack(file))
    return [
      el('label', { class: 'bag-row' }, [master, el('span', { class: 'bag-name', text: t`打开声音` })]),
      ...LAYER_WORDS().map(slider),
      el('p', { class: 'hint', text: t`环境音和音乐只在视觉小说里响，朗读时自动压低。` }),
      el('h3', { text: t`背景音乐` }),
      el('p', { class: 'hint', text: t`用你自己的音乐文件，只存在这张卡下面，不随卡导出。` }),
      ...tracks.map(trackRow),
      file,
      el('button', { type: 'button', class: 'btn small', text: t`上传音乐`, onclick: () => file.click() }),
    ]
  }

  function render() {
    tabs.replaceChildren(...TABS().map(([key, label]) => [key, key === 'party' ? said('party', label) : key === 'bag' ? said('bag', label) : label]).map(([key, label]) => el('button', { type: 'button', role: 'tab', 'aria-selected': String(key === tab), class: key === tab ? 'on' : '', text: label, onclick: () => { tab = key; render() } })))
    const page = { self: selfPage, party: partyPage, bag: bagPage, quests: questsPage, map: mapPage, deeds: deedsPage, sound: soundPage }[tab]
    body.replaceChildren(...page().filter(Boolean))
    if (tab === 'bag') sortThings()
  }

  /** Things nobody has said anything about: the helper looks at them once, in one go. A failure only leaves the names to go by. */
  function sortThings() {
    const unknown = sheet().things.filter(thing => !book.items[thing.name] && !asked.has(`${chat.cardId}:${thing.name}`))
    if (!unknown.length) return
    unknown.forEach(thing => asked.add(`${chat.cardId}:${thing.name}`))
    api(`/api/chats/${chat.id}/game/things`, { method: 'POST', body: { things: unknown.map(({ name, note }) => ({ name, note })) } }).then(next => {
      book = next
      onBook(next)
      if (dialog.open) render()
    }).catch(() => {})
  }

  dialog.addEventListener('close', () => {
    dialog.remove()
    onClose()
  })
  document.body.append(dialog)
  render()
  dialog.showModal()
}
