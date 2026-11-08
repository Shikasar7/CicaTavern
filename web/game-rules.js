// 游戏规则 (角色卡菜单): how far this card's rules go. Each change is kept at once and counts from the card's next turn.
import { t } from '/i18n.js'
import { ATTRIBUTES, ATTRIBUTE_POINTS, AVERAGE, MAX_FIELDED, MIN_ATTRIBUTE, WORD_KEYS, effectOf, startSheet } from '/shared/game/sheet.js'
import { skillKindOf } from '/shared/game/battle.js'
import { fitsField, guessBindings, variablePaths } from '/shared/game/bindings.js'

const ATTRIBUTES_HINT = () => ({ body: t`力量、耐力、硬抗`, grace: t`敏捷、潜行、手上功夫`, mind: t`智力、感知、意志`, charm: t`说服、欺骗、威慑` })

const BINDING_WORDS = () => [['life', t`生命`], ['maxLife', t`生命上限`], ['energy', t`气力`], ['maxEnergy', t`气力上限`], ['sanity', t`理智`], ['level', t`等级`], ['rank', t`等级（文字）`], ['money', t`金钱`], ['things', t`背包`], ['quests', t`任务`]]

const SKILL_KINDS = () => ({ strike: t`重击`, sweep: t`群攻`, flurry: t`连击`, poison: t`中毒`, stun: t`眩晕`, heal: t`治疗`, boost: t`增益` })
// 叫法: what each word is, in the page's language, and what it is called unless the card says otherwise.
const WORD_LABELS = () => ({ body: t`体魄`, grace: t`灵巧`, mind: t`心智`, charm: t`魅力`, life: t`生命`, minion: t`杂兵`, normal: t`普通`, elite: t`精英`, boss: t`首领`, skill: t`技能`, bag: t`行囊`, experience: t`经验`, party: t`队伍` })

/**
 * 题材: a template for a kind of story. What it calls energy and the rest (words), the skills it starts with.
 * The rules underneath are the same for all of them; only what things are called, and what one starts with, change.
 */
const THEMES = () => ({
  plain: { label: t`通用`, energyName: '', skills: { [t`强击`]: 'strike', [t`横扫`]: 'sweep' } },
  wuxia: { label: t`武侠`, energyName: t`内力`, skills: { [t`裂石掌`]: 'strike', [t`扫堂腿`]: 'sweep', [t`连环剑`]: 'flurry' } },
  xianxia: { label: t`修仙`, energyName: t`灵力`, skills: { [t`御剑术`]: 'strike', [t`雷诀`]: 'sweep', [t`回春诀`]: 'heal' } },
  fantasy: { label: t`奇幻`, energyName: t`法力`, skills: { [t`重斩`]: 'strike', [t`火球术`]: 'sweep', [t`治愈术`]: 'heal' } },
  modern: { label: t`现代`, energyName: t`精力`, skills: { [t`重拳`]: 'strike', [t`连打`]: 'flurry', [t`包扎`]: 'heal' } },
  scifi: { label: t`科幻`, energyName: t`能量`, skills: { [t`过载射击`]: 'strike', [t`脉冲波`]: 'sweep', [t`能量护盾`]: 'boost' } },
  horror: { label: t`克苏鲁`, energyName: t`精力`, sanity: true, skills: { [t`开枪`]: 'strike', [t`猛击`]: 'strike', [t`急救`]: 'heal' } },
  monster: { label: t`怪兽养成`, energyName: t`能量`, words: { body: t`力量`, grace: t`速度`, mind: t`智力`, charm: t`羁绊`, life: 'HP', minion: t`野生`, boss: 'BOSS', skill: t`必杀技`, bag: t`道具`, party: t`伙伴` }, skills: { [t`猛撞`]: 'strike', [t`连续攻击`]: 'flurry', [t`冲击波`]: 'sweep' } },
  netgame: { label: t`网游`, energyName: 'MP', words: { body: t`力量`, grace: t`敏捷`, mind: t`智力`, charm: t`魅力`, life: 'HP', minion: t`小怪`, elite: t`精英怪`, boss: 'BOSS', bag: t`背包`, party: t`小队` }, skills: { [t`重击`]: 'strike', [t`旋风斩`]: 'sweep', [t`治疗术`]: 'heal' } },
  apocalypse: { label: t`末日求生`, energyName: t`体力`, words: { minion: t`游荡者`, boss: t`首领`, bag: t`物资` }, skills: { [t`重击`]: 'strike', [t`扫射`]: 'sweep', [t`包扎`]: 'heal' } },
  daily: { label: t`日常`, energyName: t`精力`, words: { body: t`体力`, grace: t`手巧`, mind: t`头脑`, charm: t`人缘`, bag: t`随身物品` }, skills: {} },
})

/** @param deps - { el, api, toast, chatId (an open chat with the card, or ''), state (its variables, or null), drawFoe (name, done), onChange (the rules changed) } */
export async function openGameRules(card, deps) {
  const { el, api, toast, chatId, state, drawFoe, onChange } = deps
  const [book, details] = await Promise.all([api(`/api/cards/${card.id}/game`), api(`/api/cards/${card.id}`).catch(() => null)])
  // The card seems to bring a fight of its own.
  const ownFights = (details?.regexScriptList ?? []).some(script => /战斗|battle/i.test(`${script.scriptName} ${script.replaceString}`))
  const row = (title, hint, control) => el('div', { class: 'cp-row' }, [el('div', { class: 'cp-text' }, [el('span', { class: 'cp-title', text: title }), el('span', { class: 'hint', text: hint })]), control])
  const save = async change => {
    Object.assign(book, await api(`/api/cards/${card.id}/game`, { method: 'PUT', body: change }))
    onChange?.()
  }
  const failed = error => toast(error.message)
  const choice = (label, value, options, change) => {
    const select = el('select', { 'aria-label': label }, options.map(([key, text]) => el('option', { value: key, text, selected: key === value })))
    select.addEventListener('change', () => save(change(select.value)).catch(failed))
    return select
  }
  // The attributes share out a set number of points over the average; a story already begun keeps its own.
  const spare = el('span', { class: 'hint' })
  const left = () => ATTRIBUTE_POINTS - ATTRIBUTES.reduce((sum, item) => sum + book.attributes[item.id] - AVERAGE, 0)
  const showSpare = () => { spare.textContent = t`还可以分配 ${left()} 点` }
  const attribute = ({ id, name }) => {
    const input = el('input', { type: 'number', min: MIN_ATTRIBUTE, max: AVERAGE + ATTRIBUTE_POINTS, value: book.attributes[id], 'aria-label': name, class: 'game-attribute' })
    input.addEventListener('change', () => {
      const next = Math.round(Number(input.value))
      const most = book.attributes[id] + left()
      const value = Math.max(MIN_ATTRIBUTE, Math.min(Number.isFinite(next) ? next : AVERAGE, most))
      input.value = value
      save({ attributes: { ...book.attributes, [id]: value } }).then(showSpare, failed)
    })
    return row(name, ATTRIBUTES_HINT()[id], input)
  }
  showSpare()
  // A card's own variables as the sheet's fields, chosen from those of the chat open now.
  const paths = variablePaths(state)
  const links = el('div')
  const showLinks = () => links.replaceChildren(...BINDING_WORDS().map(([field, label]) => {
    const fits = paths.filter(item => fitsField(field, item.kind)).map(item => item.path)
    const known = book.bindings[field]
    const list = known && !fits.includes(known) ? [known, ...fits] : fits
    return row(label, '', choice(label, known ?? '', [['', t`不绑定`], ...list.map(path => [path, path])], value => ({ bindings: { ...book.bindings, [field]: value } })))
  }))
  showLinks()
  const guess = el('button', { type: 'button', class: 'btn small', text: t`按名字自动匹配`, onclick: () => save({ bindings: { ...guessBindings(state), ...book.bindings } }).then(showLinks, failed) })
  // A fight to try the rules on: with this card's attributes, a kit of its own, and nothing kept.
  const TRIALS = [[t`一只普通敌人`, [{ name: t`山贼`, count: 1, tier: 'normal' }]], [t`两只杂兵和一只精英`, [{ name: t`灰狼`, count: 2, tier: 'minion' }, { name: t`狼王`, count: 1, tier: 'elite' }]], [t`首领`, [{ name: t`山贼头目`, count: 1, tier: 'boss' }]], [t`四只普通敌人`, [{ name: t`山贼`, count: 4, tier: 'normal' }]], [t`远强于你的敌人`, [{ name: t`魔修长老`, count: 1, tier: 'elite', gap: 3 }]]]
  const trial = el('select', { 'aria-label': t`试打一场` }, TRIALS.map(([label], i) => el('option', { value: i, text: label })))
  const tryFight = async () => {
    const { battleSetup, fieldFoes } = await import('/shared/game/battle.js')
    const { openBattle } = await import('/game-battle.js')
    const sheet = startSheet(book)
    const kit = { ...sheet, things: [{ name: t`回春丹`, count: 2 }, { name: t`雷符`, count: 1 }, ...sheet.things], skills: sheet.skills.length ? sheet.skills : [t`强击`, t`横扫`, t`连击`] }
    const effects = name => (name === t`回春丹` ? { type: 'heal', size: 'medium' } : name === t`雷符` ? { type: 'damage', size: 'medium' } : effectOf(book, name))
    const kinds = { [t`强击`]: 'strike', [t`横扫`]: 'sweep', [t`连击`]: 'flurry', ...book.skills }
    openBattle({ el, energyName: book.energyName, setup: battleSetup(kit, { foes: fieldFoes(TRIALS[Number(trial.value)][1]), seed: String(Date.now()), difficulty: book.fightDifficulty, effects, kinds }) })
  }
  // 敌人图鉴: who has been met, and their pictures.
  const bestiary = el('div')
  const setPicture = (name, image) => api(`/api/cards/${card.id}/foes/image`, { method: 'PUT', body: { name, image } }).then(next => {
    Object.assign(book, next)
    showBestiary()
  }, failed)
  const pickPicture = name => {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' })
    input.addEventListener('change', () => {
      const reader = new FileReader()
      reader.onload = () => setPicture(name, reader.result)
      if (input.files[0]) reader.readAsDataURL(input.files[0])
    })
    input.click()
  }
  function showBestiary() {
    const names = Object.keys(book.foes)
    bestiary.replaceChildren(...(names.length ? names.map(name => {
      const foe = book.foes[name]
      const draw = () => {
        drawFoe(name, next => {
          Object.assign(book, next)
          showBestiary()
        })
        toast(t`在后台画${name}的立绘，下次遇到就能看到`)
      }
      return row(name, foe.moves.join(t`、`), el('span', { class: 'battle-trial' }, [
        foe.file ? el('img', { class: 'foe-thumb', src: `/api/foes/${card.id}/${foe.file}`, alt: '' }) : null,
        foe.looks ? el('button', { type: 'button', class: 'btn small', text: foe.file ? t`重画` : t`画立绘`, onclick: draw }) : null,
        el('button', { type: 'button', class: 'btn small', text: t`上传`, onclick: () => pickPicture(name) }),
        foe.file ? el('button', { type: 'button', class: 'btn small', text: t`删除`, onclick: () => setPicture(name, null) }) : null,
      ]))
    }) : [el('p', { class: 'hint', text: t`还没遇到过敌人。遭遇时辅助模型会写下外貌和招式。` })]))
  }
  showBestiary()
  // What each skill does: guessed from its name until it is set.
  const skillKinds = el('div')
  const showSkillKinds = () => skillKinds.replaceChildren(...book.start.skills.map(name => row(name, '', choice(t`${name}的效果`, book.skills[name] ?? skillKindOf(name), Object.entries(SKILL_KINDS()), kind => ({ skills: { ...book.skills, [name]: kind } })))))
  function skillsInput() {
    const input = el('input', { type: 'text', value: book.start.skills.join(t`、`), 'aria-label': t`开局技能`, placeholder: t`强击、横扫` })
    input.addEventListener('change', () => save({ start: { ...book.start, skills: input.value.split(/[、，,\s]+/).filter(Boolean) } }).then(showSkillKinds, failed))
    return input
  }
  showSkillKinds()
  // 队伍名册: who on the card stands with the player, each with their own attributes and skills.
  const roster = el('div')
  const splitWords = text => text.split(/[、，,\s]+/).map(word => word.trim()).filter(Boolean)
  function companionBox(name) {
    const companion = book.companions[name]
    const put = change => save({ companions: { ...book.companions, [name]: { ...companion, ...change } } }).then(showRoster, failed)
    const starts = (book.start.party ?? []).includes(name)
    const startBox = el('input', { type: 'checkbox', checked: starts, 'aria-label': t`开局就在队里` })
    startBox.addEventListener('change', () => {
      const party = (book.start.party ?? []).filter(other => other !== name)
      save({ start: { ...book.start, party: startBox.checked ? [...party, name] : party } }).then(showRoster, failed)
    })
    const keys = el('input', { type: 'text', value: companion.keys.join(t`、`), 'aria-label': t`别名`, placeholder: t`挽霜、霜姐姐` })
    keys.addEventListener('change', () => put({ keys: splitWords(keys.value) }))
    const skills = el('input', { type: 'text', value: Object.keys(companion.skills).join(t`、`), 'aria-label': t`${name}的技能`, placeholder: t`强击、横扫` })
    skills.addEventListener('change', () => put({ skills: Object.fromEntries(splitWords(skills.value).map(skill => [skill, companion.skills[skill] ?? ''])) }))
    const level = el('input', { type: 'number', min: 1, max: 99, value: companion.level ?? '', placeholder: t`同你`, 'aria-label': t`${name}的等级`, class: 'game-attribute' })
    level.addEventListener('change', () => {
      const value = Math.round(Number(level.value))
      const { level: _was, ...rest } = companion
      save({ companions: { ...book.companions, [name]: value >= 1 ? { ...rest, level: Math.min(99, value) } : rest } }).then(showRoster, failed)
    })
    // Their attributes share out the same points over the average as the player's.
    const spareOf = attributes => ATTRIBUTE_POINTS - ATTRIBUTES.reduce((sum, item) => sum + attributes[item.id] - AVERAGE, 0)
    const stat = ({ id, name: label }) => {
      const input = el('input', { type: 'number', min: MIN_ATTRIBUTE, max: AVERAGE + ATTRIBUTE_POINTS, value: companion.attributes[id], 'aria-label': t`${name}的${label}`, class: 'game-attribute' })
      input.addEventListener('change', () => {
        const next = Math.round(Number(input.value))
        const most = companion.attributes[id] + spareOf(companion.attributes)
        const value = Math.max(MIN_ATTRIBUTE, Math.min(Number.isFinite(next) ? next : AVERAGE, most))
        put({ attributes: { ...companion.attributes, [id]: value } })
      })
      return row(label, ATTRIBUTES_HINT()[id], input)
    }
    const remove = () => {
      const { [name]: _gone, ...rest } = book.companions
      save({ companions: rest, start: { ...book.start, party: (book.start.party ?? []).filter(other => other !== name) } }).then(showRoster, failed)
    }
    const summary = [starts ? t`开局在队里` : '', Object.keys(companion.skills).join(t`、`)].filter(Boolean).join(' · ')
    return el('details', { class: 'game-companion' }, [
      el('summary', {}, [el('b', { text: name }), el('span', { class: 'hint', text: summary })]),
      row(t`开局就在队里`, t`新故事一开始就同行。最多 ${MAX_FIELDED} 人上场，多的待命。`, startBox),
      row(t`别名`, t`故事里也这么叫他，用来认出是谁入队、立绘用哪张。`, keys),
      row(t`技能`, t`战斗里他能用的招，用逗号分开。空着就给强击。`, skills),
      ...Object.keys(companion.skills).map(skill => row(skill, '', choice(t`${skill}的效果`, companion.skills[skill] || skillKindOf(skill), Object.entries(SKILL_KINDS()), kind => ({ companions: { ...book.companions, [name]: { ...companion, skills: { ...companion.skills, [skill]: kind } } } })))),
      row(t`等级`, t`入队时的等级，空着就和你一样。`, level),
      el('p', { class: 'hint', text: t`属性：10 是常人，还可以分配 ${spareOf(companion.attributes)} 点。` }),
      ...ATTRIBUTES.map(stat),
      el('div', { class: 'row end' }, [el('button', { type: 'button', class: 'btn small danger', text: t`从名册删掉`, onclick: remove })]),
    ])
  }
  function showRoster() {
    const name = el('input', { type: 'text', maxlength: 40, placeholder: t`名字`, 'aria-label': t`同伴的名字` })
    const add = () => {
      const said = name.value.trim()
      if (!said || book.companions[said]) return
      save({ companions: { ...book.companions, [said]: { keys: [], attributes: {}, skills: {} } } }).then(showRoster, failed)
    }
    name.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        add()
      }
    })
    roster.replaceChildren(
      ...Object.keys(book.companions).map(companionBox),
      el('div', { class: 'bag-add' }, [name, el('button', { type: 'button', class: 'btn small', text: t`加一个同伴`, onclick: add })]),
    )
  }
  showRoster()
  // 叫法: the card's own names for things, each kept as it is typed; empty is the app's.
  const wordRow = key => {
    const input = el('input', { type: 'text', maxlength: 8, value: book.words?.[key] ?? '', placeholder: WORD_LABELS()[key], 'aria-label': t`「${WORD_LABELS()[key]}」的叫法`, class: 'game-word' })
    input.addEventListener('change', () => {
      const words = { ...book.words }
      const word = input.value.trim()
      if (word) words[key] = word
      else delete words[key]
      save({ words }).catch(failed)
    })
    return el('label', { class: 'game-word-row' }, [el('span', { text: WORD_LABELS()[key] }), input])
  }
  const wordsBox = el('div', { class: 'game-words' }, WORD_KEYS.map(wordRow))

  // What the window shows was read when it opened: after a change to many of them at once, it opens again.
  const again = async () => {
    await openGameRules(card, deps)
    dialog.close()
  }
  const pickTheme = id => {
    const theme = THEMES()[id]
    save({ theme: id, energyName: theme.energyName, words: theme.words ?? {}, skills: { ...book.skills, ...theme.skills }, start: { ...book.start, skills: Object.keys(theme.skills) }, ...(theme.sanity ? { sanity: true } : {}) }).then(again).catch(failed)
  }
  const themeSelect = el('select', { 'aria-label': t`题材` }, Object.entries(THEMES()).map(([id, theme]) => el('option', { value: id, text: theme.label, selected: id === (book.theme || 'plain') })))
  themeSelect.addEventListener('change', () => pickTheme(themeSelect.value))
  // The helper's proposal: shown, and kept only if taken.
  const proposal = el('div')
  const showProposal = found => {
    const take = () => save({ ...found, foes: { ...found.foes, ...book.foes }, skills: { ...book.skills, ...found.skills }, items: { ...book.items, ...found.items }, bindings: { ...book.bindings, ...found.bindings }, companions: { ...(found.companions ?? {}), ...book.companions }, words: { ...(found.words ?? {}), ...book.words } }).then(again).catch(failed)
    const attributes = ATTRIBUTES.map(item => `${item.name} ${found.attributes[item.id]}`).join(t`、`)
    const lines = [
      [t`题材`, THEMES()[found.theme].label + (found.energyName ? t`（${found.energyName}）` : '')],
      [t`叫法`, Object.entries(found.words ?? {}).map(([key, word]) => `${WORD_LABELS()[key]} → ${word}`).join(t`、`)],
      [t`属性`, attributes],
      [t`技能`, found.start.skills.join(t`、`)],
      [t`开局物品`, found.start.things.map(thing => (thing.count > 1 ? `${thing.name} ×${thing.count}` : thing.name)).join(t`、`)],
      [t`常见敌人`, Object.keys(found.foes).join(t`、`)],
      [t`同伴`, Object.keys(found.companions ?? {}).join(t`、`)],
      [t`等级阶梯`, (found.ranks ?? []).join(t`、`)],
      [t`理智`, found.sanity ? t`开` : ''],
      [t`绑定变量`, Object.entries(found.bindings).map(([field, path]) => `${BINDING_WORDS().find(([key]) => key === field)[1]} → ${path}`).join(t`、`)],
    ].filter(([, text]) => text)
    proposal.replaceChildren(el('div', { class: 'game-proposal' }, [
      ...lines.map(([label, text]) => el('p', { class: 'hint' }, [el('b', { text: label }), ` ${text}`])),
      el('div', { class: 'row end' }, [
        el('button', { type: 'button', class: 'btn small', text: t`算了`, onclick: () => proposal.replaceChildren() }),
        el('button', { type: 'button', class: 'btn small primary', text: t`采用`, onclick: take }),
      ]),
    ]))
  }
  const askHelper = el('button', { type: 'button', class: 'btn small', text: t`读卡配置`, onclick: () => {
    askHelper.disabled = true
    askHelper.textContent = t`读卡中…`
    api(`/api/cards/${card.id}/game/suggest`, { method: 'POST', body: { chatId } }).then(showProposal, failed).finally(() => {
      askHelper.disabled = false
      askHelper.textContent = t`读卡配置`
    })
  } })
  const levelChoice = choice(t`规则`, book.level, [['off', t`关`], ['light', t`轻度`], ['full', t`完整`]], level => ({ level }))
  function ranksInput() {
    const input = el('input', { type: 'text', value: book.ranks.join(t`、`), 'aria-label': t`等级阶梯`, placeholder: t`炼气、筑基、金丹` })
    input.addEventListener('change', () => save({ ranks: input.value.split(/[、，,\s]+/).filter(Boolean) }).then(again).catch(failed))
    return input
  }
  // 战斗设置: only the full rules have fights.
  const fightSettings = el('div', { hidden: book.level !== 'full' }, [
    el('h3', { text: t`战斗设置` }),
    row(t`战斗难度`, t`敌人的生命和伤害。宽松时更好打，严苛时敌人更耐打、打得更疼。`, choice(t`战斗难度`, book.fightDifficulty, [['easy', t`宽松`], ['normal', t`标准`], ['hard', t`严苛`]], fightDifficulty => ({ fightDifficulty }))),
    row(t`战斗频率`, t`模型多久安排一次打斗。少：只在剧情需要时；多：隔一两轮就有战斗选项。`, choice(t`战斗频率`, book.fightRate, [['rare', t`少`], ['normal', t`适中`], ['often', t`多`]], fightRate => ({ fightRate }))),
    row(t`等级阶梯`, t`这个世界的等级，从低到高，用逗号分开。填了以后敌人按等级算差距；不填时由模型写敌人比你强多少。`, ranksInput()),
    book.ranks.length ? row(t`阶梯跨度`, t`大：差一级就很难打，比如修仙的境界。小：差几级才打不过，比如段位、军衔。`, choice(t`阶梯跨度`, book.rankSpan, [['wide', t`大`], ['narrow', t`小`]], rankSpan => ({ rankSpan }))) : null,
    book.ranks.length ? row(t`开局等级`, t`玩家从哪一级开始，只影响新故事。绑定了「等级（文字）」的卡按变量来。`, choice(t`开局等级`, book.start.rank || book.ranks[0], book.ranks.map(rank => [rank, rank]), rank => ({ start: { ...book.start, rank } }))) : null,
    el('h3', { text: t`队伍名册` }),
    el('p', { class: 'hint', text: t`和你一起打架的人：各有各的属性和技能，在行囊的「队伍」里安排谁上场。故事里写到有人入队时，名册里没有的人按常人加进来。` }),
    roster,
  ])
  levelChoice.addEventListener('change', () => { fightSettings.hidden = levelChoice.value !== 'full' })
  const dialog = el('dialog', { class: 'dialog card-permissions', 'aria-label': t`游戏规则` }, [
    el('form', { method: 'dialog', class: 'cp-form' }, [
      el('button', { class: 'btn small primary dialog-x', value: 'close', text: t`完成` }),
      el('h2', { text: t`「${card.name}」的游戏规则` }),
      el('p', { class: 'hint', text: t`打开后，成败、物品和数值由程序计算，模型只按结果写故事。只对这张卡生效，随时可以关掉，已有的对话不受影响。` }),
      row(t`规则`, t`轻度：检定、背包、任务和地图。完整：再加战斗和等级。`, levelChoice),
      ownFights ? el('p', { class: 'hint warn', text: t`这张卡好像自带战斗界面。开「完整」后两套可能同时出现，可以只开「轻度」。` }) : null,
      row(t`检定难度`, t`检定的难度整体调低或调高，战斗的在下面单独设。`, choice(t`检定难度`, book.difficulty, [['easy', t`宽松`], ['normal', t`标准`], ['hard', t`严苛`]], difficulty => ({ difficulty }))),
      row(t`剧情暂停`, t`让模型在有风险的地方停下来等你掷骰。导入的预设有自己的输出格式，可能和这个冲突，所以默认不开，只有选项上的检定。`, choice(t`剧情暂停`, book.pause === null ? 'auto' : book.pause ? 'on' : 'off', [['auto', t`自动`], ['on', t`开`], ['off', t`关`]], value => ({ pause: value === 'auto' ? null : value === 'on' }))),
      row(t`理智`, t`恐怖题材用：目睹恐怖时理智下降，很难恢复，低了影响心智，归零时发疯。`, choice(t`理智`, book.sanity ? 'on' : 'off', [['off', t`关`], ['on', t`开`]], value => ({ sanity: value === 'on' }))),
      fightSettings,
      row(t`题材`, t`套一个模板：属性、生命、敌人档位这些的叫法，气力的叫法和开局技能。规则本身不变。叫法马上生效，开局技能只影响新故事。`, themeSelect),
      el('h3', { text: t`叫法` }),
      el('p', { class: 'hint', text: t`这张卡怎么叫这些东西，界面和发给模型的规则一起换。只换名字，数值和存档不变；空着就用默认的叫法。` }),
      wordsBox,
      row(t`辅助模型配置`, t`让辅助模型读这张卡，给出题材、叫法、属性、技能、物品、常见敌人、同伴、等级阶梯和变量绑定，你看过再采用。`, askHelper),
      proposal,
      row(t`试打一场`, t`用这张卡的属性打一场，看看战斗怎么玩。什么都不会保存。`, el('span', { class: 'battle-trial' }, [trial, el('button', { type: 'button', class: 'btn small', text: t`开始`, onclick: () => tryFight().catch(failed) })])),
      row(t`开局技能`, t`战斗里能用的技能，用逗号分开。效果先按名字猜，下面可以改。空着就给强击和横扫。`, skillsInput()),
      skillKinds,
      el('h3', { text: t`开局属性` }),
      el('p', { class: 'hint' }, [t`10 是常人。只影响新故事，已经开始的故事保持原样。`, ' ', spare]),
      ...ATTRIBUTES.map(attribute),
      el('h3', { text: t`敌人图鉴` }),
      bestiary,
      el('h3', { text: t`绑定变量` }),
      el('p', { class: 'hint', text: t`这张卡已有的变量可以当作生命、背包这些来用：故事里归卡管，用物品时由规则写回。` }),
      paths.length ? el('div', { class: 'row' }, [guess]) : el('p', { class: 'hint', text: t`打开这张卡的对话后才能选变量。` }),
      paths.length ? links : null,
    ]),
  ])
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
}
