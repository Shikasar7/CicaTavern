// 游戏规则 (角色卡菜单): how far this card's rules go. Each change is kept at once and counts from the card's next turn.
import { t } from '/i18n.js'
import { ATTRIBUTES, ATTRIBUTE_POINTS, AVERAGE, MAX_FIELDED, MIN_ATTRIBUTE, WORD_KEYS, effectOf, skillsNamed, startSheet } from '/shared/game/sheet.js'
import { ADD_SIZES, FOE_ADD_IDS, FOE_ADD_ROOM, MAX_ADDS, SKILL_ADDS, SKILL_ADD_IDS, addFits, cleanFoeAdds, skillKindOf } from '/shared/game/battle.js'
import { BIG_BUDGET, BOND_AT, BOND_POINTS_MOST, EFFECTS, EFFECT_IDS, LEVEL_POINTS_MOST, MAX_PERKS, PERK_BUDGET, PERK_EVERY_RANGE, PERK_SKILL_COST, RANK_POINTS_MOST, SHIFT_COST, SHIFT_UPKEEP, SIZES, bondPointsOf, cleanPerks, everyGives, levelPointsOf, perkEveryOf, rankRestores, slotByName } from '/shared/game/growth.js'
import { ADD_NAMES, EFFECT_NAMES, FOE_ADD_NAMES, MAX_FORMS, PLAYER_FORMS, SIZE_WORDS, addsText, effectPickers, foeAddsLine, foeAddsText, formBudget, formName, gearPickers, gearText, perkShown, wordsOf } from '/game-growth.js'
import { fitsField, guessBindings, variablePaths } from '/shared/game/bindings.js'

const ATTRIBUTES_HINT = () => ({ body: t`力量、耐力、硬抗`, grace: t`敏捷、潜行、手上功夫`, mind: t`智力、感知、意志`, charm: t`说服、欺骗、威慑` })

const BINDING_WORDS = (energy = '') => [['life', t`生命`], ['maxLife', t`生命上限`], ['energy', energy || t`气力`], ['maxEnergy', energy ? t`${energy}上限` : t`气力上限`], ['sanity', t`理智`], ['level', t`等级`], ['rank', t`等级（文字）`], ['money', t`金钱`], ['things', t`背包`], ['quests', t`任务`]]

const SKILL_KINDS = () => ({ strike: t`重击`, sweep: t`群攻`, flurry: t`连击`, poison: t`中毒`, stun: t`眩晕`, heal: t`治疗`, boost: t`增益`, finish: t`斩杀`, mend: t`群体治疗`, ward: t`护盾`, rally: t`鼓舞全队`, taunt: t`挑衅` })
// 叫法: what each word is, in the page's language, and what it is called unless the card says otherwise.
const WORD_LABELS = () => ({ body: t`体魄`, grace: t`灵巧`, mind: t`心智`, charm: t`魅力`, life: t`生命`, minion: t`杂兵`, normal: t`普通`, elite: t`精英`, boss: t`首领`, skill: t`技能`, bag: t`行囊`, experience: t`经验`, party: t`队伍`, perk: t`天赋`, weapon: t`武器`, armour: t`防具`, trinket: t`饰品`, common: t`普通（装备）`, fine: t`精良`, rare: t`稀有`, epic: t`传说`, form: t`形态`, evolve: t`进化（动词）` })

/**
 * 题材包: a template for a kind of story. What it calls energy and the rest (words), the skills it starts with, and
 * what suits it of the rest: who fights (lead), 收服 (tame), a table of types and a chain of 形态 to start from (each
 * only where the card has none), how growth leans (growth), how far the rules go (level) and a look for the fight.
 * The rules underneath are the same for all of them. Picking one shows what it would set, each part to take or leave.
 */
const THEMES = () => ({
  // `growth`: what suits this kind of story, set with the template on a card that counts growth.
  plain: { label: t`通用`, energyName: '', skills: { [t`强击`]: 'strike', [t`横扫`]: 'sweep' } },
  wuxia: { label: t`武侠`, energyName: t`内力`, look: 'ink', words: { perk: t`心法`, weapon: t`兵刃`, armour: t`护甲`, trinket: t`佩饰`, common: t`凡品`, fine: t`良品`, rare: t`珍品`, epic: t`神兵` }, skills: { [t`裂石掌`]: 'strike', [t`扫堂腿`]: 'sweep', [t`连环剑`]: 'flurry' } },
  xianxia: { label: t`修仙`, energyName: t`灵力`, look: 'ink', growth: { rankSkills: true }, words: { perk: t`神通`, weapon: t`法器`, armour: t`法衣`, trinket: t`灵佩`, common: t`凡器`, fine: t`灵器`, rare: t`法宝`, epic: t`仙器` }, skills: { [t`御剑术`]: 'strike', [t`雷诀`]: 'sweep', [t`回春诀`]: 'heal' } },
  fantasy: { label: t`西幻`, energyName: t`法力`, words: { perk: t`专长`, armour: t`护甲`, epic: t`史诗` }, skills: { [t`重斩`]: 'strike', [t`火球术`]: 'sweep', [t`治愈术`]: 'heal' } },
  modern: { label: t`现代`, energyName: t`精力`, skills: { [t`重拳`]: 'strike', [t`连打`]: 'flurry', [t`包扎`]: 'heal' } },
  scifi: { label: t`科幻`, energyName: t`能量`, words: { perk: t`改造`, armour: t`装甲`, trinket: t`芯片` }, skills: { [t`过载射击`]: 'strike', [t`脉冲波`]: 'sweep', [t`能量护盾`]: 'boost' } },
  horror: { label: t`克苏鲁`, energyName: t`精力`, sanity: true, growth: { points: false }, skills: { [t`开枪`]: 'strike', [t`猛击`]: 'strike', [t`急救`]: 'heal' } },
  monster: { label: t`怪兽养成`, energyName: t`能量`, look: 'console', lead: 'command', tame: true, types: { [t`火`]: [t`草`], [t`草`]: [t`水`], [t`水`]: [t`火`] }, growth: { level: 'rich', bondPoints: 1 }, words: { body: t`力量`, grace: t`速度`, mind: t`智力`, charm: t`羁绊`, life: 'HP', minion: t`野生`, boss: 'BOSS', skill: t`必杀技`, bag: t`道具`, party: t`伙伴`, perk: t`特性`, weapon: t`项圈`, armour: t`铭牌`, trinket: t`徽章` }, skills: { [t`猛撞`]: 'strike', [t`连续攻击`]: 'flurry', [t`冲击波`]: 'sweep' } },
  netgame: { label: t`网游`, energyName: 'MP', look: 'console', growth: { level: 'rich', power: true }, words: { body: t`力量`, grace: t`敏捷`, mind: t`智力`, charm: t`魅力`, life: 'HP', minion: t`小怪`, elite: t`精英怪`, boss: 'BOSS', bag: t`背包`, party: t`小队`, perk: t`被动`, common: t`白装`, fine: t`绿装`, rare: t`蓝装`, epic: t`橙装` }, skills: { [t`重击`]: 'strike', [t`旋风斩`]: 'sweep', [t`治疗术`]: 'heal' } },
  hero: { label: t`变身 / 机甲`, energyName: t`能量`, look: 'bold', growth: { level: 'standard' }, words: { evolve: t`变身`, perk: t`能力`, armour: t`装甲` }, skills: { [t`重拳`]: 'strike', [t`连打`]: 'flurry', [t`光束`]: 'sweep' }, forms: { [PLAYER_FORMS]: [{ name: t`平时的样子`, effects: [] }, { name: t`变身形态`, temp: true, effects: [{ id: 'attack', size: 'medium' }, { id: 'guard', size: 'medium' }] }] } },
  apocalypse: { label: t`末日求生`, growth: { level: 'standard' }, energyName: t`体力`, words: { minion: t`游荡者`, boss: t`首领`, bag: t`物资`, perk: t`专长` }, skills: { [t`重击`]: 'strike', [t`扫射`]: 'sweep', [t`包扎`]: 'heal' } },
  daily: { label: t`日常`, level: 'light', energyName: t`精力`, words: { body: t`体力`, grace: t`手巧`, mind: t`头脑`, charm: t`人缘`, bag: t`随身物品` }, skills: {} },
})

/** @param deps - { el, api, toast, chatId (an open chat with the card, or ''), state (its variables, or null), drawFoe (name, done), drawSkill (name, note, done), onChange (the rules changed), viewPicture (src, caption, meta, options: the image viewer) } */
export async function openGameRules(card, deps) {
  const { el, api, toast, chatId, state, drawFoe, drawSkill, onChange, viewPicture } = deps
  const [book, details] = await Promise.all([api(`/api/cards/${card.id}/game`), api(`/api/cards/${card.id}`).catch(() => null)])
  // The card seems to bring a fight of its own.
  const ownFights = (details?.regexScriptList ?? []).some(script => /战斗|battle/i.test(`${script.scriptName} ${script.replaceString}`))
  const row = (title, hint, control) => el('div', { class: 'cp-row' }, [el('div', { class: 'cp-text' }, [el('span', { class: 'cp-title', text: title }), el('span', { class: 'hint', text: hint })]), control])
  const save = async change => {
    const kept = await api(`/api/cards/${card.id}/game`, { method: 'PUT', body: change })
    Object.assign(book, kept)
    // The last of these taken away leaves the answer without the field.
    for (const key of ['forms', 'perks', 'types', 'skillTypes', 'selfType', 'lead', 'tame', 'skillPictures']) if (!Object.hasOwn(kept, key)) delete book[key]
    // A field the answer left out is one that is no more: the last add of the last skill, taken off.
    if (!Object.hasOwn(book, 'skillAdds')) book.skillAdds = undefined
    onChange?.()
    afterSave()
  }
  // What is drawn from more than one setting is drawn again after any of them is saved.
  let afterSave = () => {}
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
  const showLinks = () => links.replaceChildren(...BINDING_WORDS(book.energyName).map(([field, label]) => {
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
    const skillPicture = name => (book.skillPictures?.[name] ? `/api/skills/${card.id}/${book.skillPictures[name]}` : '')
    openBattle({ el, energyName: book.energyName, skillPicture, setup: battleSetup(kit, { foes: fieldFoes(TRIALS[Number(trial.value)][1]), seed: String(Date.now()), difficulty: book.fightDifficulty, effects, kinds, adds: book.skillAdds ?? {} }) })
  }
  // 敌人图鉴: who has been met, and their pictures.
  const bestiary = el('div')
  /** A foe's picture that opens full size on a click, on a checkerboard as the 立绘 do (not opening or closing its row). */
  const foePicture = (name, foe, className) => {
    const img = el('img', { class: className, src: `/api/foes/${card.id}/${foe.file}`, alt: '' })
    if (!viewPicture) return img
    img.classList.add('zoomable')
    img.title = t`点击放大`
    img.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      viewPicture(img.src, foe.looks ? t`${name}：${foe.looks}` : name, '', { cutout: true })
    })
    return img
  }
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
  const removeFoe = name => {
    if (!confirm(t`把「${name}」从敌人图鉴里删掉？立绘和招式效果一起删。下次再遇到，辅助模型会重新写它的外貌和招式。`)) return
    api(`/api/cards/${card.id}/foes`, { method: 'DELETE', body: { name } }).then(next => {
      Object.assign(book, next)
      showBestiary()
      showTypes()
      onChange?.()
    }, failed)
  }
  function showBestiary() {
    const names = Object.keys(book.foes)
    // One being worked on stays open while each change to it is kept.
    const open = new Set([...bestiary.querySelectorAll('details[open]')].map(node => node.dataset.foe))
    bestiary.replaceChildren(...(names.length ? names.map(name => {
      const foe = book.foes[name]
      const draw = () => {
        drawFoe(name, next => {
          Object.assign(book, next)
          showBestiary()
        })
        toast(t`在后台画${name}的立绘，下次遇到就能看到`)
      }
      // 招式效果: what this kind leaves on whom it strikes when it comes as a 精英 (the first) or a 首领 (both).
      const held = foe.adds ?? []
      const putAdds = next => save({ foes: { ...book.foes, [name]: { ...foe, adds: cleanFoeAdds(next) } } }).then(showBestiary, failed)
      const addPicker = at => {
        const now = held[at]
        const what = el('select', { 'aria-label': t`${name}的招式效果 ${at + 1}` }, [['', t`无`], ...FOE_ADD_IDS.filter(id => id === now?.id || !held.some(other => other.id === id)).map(id => [id, FOE_ADD_NAMES()[id]])].map(([key, text]) => el('option', { value: key, text, selected: key === (now?.id ?? '') })))
        what.addEventListener('change', () => putAdds(Array.from({ length: FOE_ADD_ROOM.boss.count }, (_, i) => (i === at ? (what.value ? { id: what.value, size: now?.size ?? 'medium' } : null) : held[i])).filter(Boolean)))
        if (!now) return [what]
        const size = el('select', { 'aria-label': t`${name}的招式效果 ${at + 1} 的幅度` }, ADD_SIZES.map(key => el('option', { value: key, text: SIZE_WORDS()[key], selected: key === now.size })))
        size.addEventListener('change', () => putAdds(held.map((item, i) => (i === at ? { ...item, size: size.value } : item))))
        return [what, size]
      }
      return el('details', { class: 'game-companion game-foe', 'data-foe': name, ...(open.has(name) ? { open: '' } : {}) }, [
        el('summary', {}, [
          foe.file ? foePicture(name, foe, 'foe-thumb') : null,
          el('b', { text: name }),
          el('span', { class: 'hint', text: [foe.moves.join(t`、`), foeAddsText(held)].filter(Boolean).join(' · ') }),
        ]),
        foe.file ? el('div', { class: 'foe-preview' }, [foePicture(name, foe, '')]) : null,
        row(t`立绘`, foe.looks || '', el('span', { class: 'battle-trial' }, [
          foe.looks ? el('button', { type: 'button', class: 'btn small', text: foe.file ? t`重画` : t`画立绘`, onclick: draw }) : null,
          el('button', { type: 'button', class: 'btn small', text: t`上传`, onclick: () => pickPicture(name) }),
          foe.file ? el('button', { type: 'button', class: 'btn small', text: t`删除立绘`, 'aria-label': t`删除${name}的立绘`, onclick: () => setPicture(name, null) }) : null,
        ])),
        row(t`${name}的招式效果`, foeAddsText(held) || t`没有：当精英、首领出场时只是打得重`, el('span', { class: 'game-adds' }, Array.from({ length: Math.min(FOE_ADD_ROOM.boss.count, held.length + 1) }, (_, at) => addPicker(at)).flat())),
        el('div', { class: 'row end' }, [el('button', { type: 'button', class: 'btn small danger', text: t`从图鉴删掉`, 'aria-label': t`把${name}从图鉴删掉`, onclick: () => removeFoe(name) })]),
      ])
    }) : [el('p', { class: 'hint', text: t`还没遇到过敌人。遭遇时辅助模型会写下外貌和招式。` })]), ...(names.length ? [el('p', { class: 'hint', text: t`招式效果只在这种敌人当精英或首领出场时起作用：精英用第一条（最多中幅），首领两条都用（小幅、中幅、大幅各算 1、2、3 点，最多 ${FOE_ADD_ROOM.boss.points} 点）。带了效果的敌人，出手本身会轻一点。` })] : []))
  }
  showBestiary()
  // 技能特写: a picture for a skill, cut in full screen when it is used in a fight.
  const skillArt = el('div')
  const setSkillPicture = (name, image) => api(`/api/cards/${card.id}/skills/image`, { method: 'PUT', body: { name, image } }).then(next => {
    Object.assign(book, next)
    if (!Object.hasOwn(next, 'skillPictures')) delete book.skillPictures
    showSkillArt()
  }, failed)
  const pickSkillPicture = name => {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' })
    input.addEventListener('change', () => {
      const reader = new FileReader()
      reader.onload = () => setSkillPicture(name, reader.result)
      if (input.files[0]) reader.readAsDataURL(input.files[0])
    })
    input.click()
  }
  function showSkillArt() {
    const skills = skillsNamed(book)
    const pictures = book.skillPictures ?? {}
    skillArt.replaceChildren(...(skills.length ? [el('p', { class: 'hint', text: t`给技能配一张图，战斗里放这个技能时会切到全屏特写。「画技能图」用配图设置里的画图方式，按技能名和效果画放技能的那一下，同伴的技能会带上它的人设图当参考。` }), ...skills.map(({ name, owner }) => {
      const file = pictures[name]
      const kind = kindIn(name)
      const draw = () => {
        const adds = addsText(book.skillAdds?.[name] ?? [], book.energyName)
        drawSkill(name, [SKILL_KINDS()[kind], adds].filter(Boolean).join(t`，`), next => {
          Object.assign(book, next)
          showSkillArt()
        })
        toast(t`在后台画「${name}」的技能图`)
      }
      return row(name, owner ? t`${owner}的技能` : t`你的技能`, el('span', { class: 'battle-trial' }, [
        file ? el('img', { class: 'foe-thumb skill-thumb', src: `/api/skills/${card.id}/${file}`, alt: '' }) : null,
        drawSkill ? el('button', { type: 'button', class: 'btn small', text: file ? t`重画` : t`画技能图`, onclick: draw }) : null,
        el('button', { type: 'button', class: 'btn small', text: t`上传`, onclick: () => pickSkillPicture(name) }),
        file ? el('button', { type: 'button', class: 'btn small', text: t`删除`, onclick: () => setSkillPicture(name, null) }) : null,
      ]))
    })] : [el('p', { class: 'hint', text: t`还没有技能。` })]))
  }
  // What each skill does: guessed from its name until it is set.
  const skillKinds = el('div')
  const showSkillKinds = () => skillKinds.replaceChildren(...book.start.skills.map(name => row(name, '', choice(t`${name}的效果`, book.skills[name] ?? skillKindOf(name), Object.entries(SKILL_KINDS()), kind => ({ skills: { ...book.skills, [name]: kind } })))))
  function skillsInput() {
    const input = el('input', { type: 'text', value: book.start.skills.join(t`、`), 'aria-label': t`开局技能`, placeholder: t`强击、横扫` })
    input.addEventListener('change', () => save({ start: { ...book.start, skills: input.value.split(/[、，,\s]+/).filter(Boolean) } }).then(showSkillKinds, failed))
    return input
  }
  showSkillKinds()
  // 技能的附加: what a skill does on top of its kind, for every skill the card names, the companions' too.
  const skillAdds = el('div')
  const kindIn = name => (book.skills[name] || Object.values(book.companions).map(companion => companion.skills[name]).find(Boolean) || skillKindOf(name))
  function addsRow(name) {
    const kind = kindIn(name)
    const held = (book.skillAdds?.[name] ?? []).slice(0, MAX_ADDS)
    const put = (at, add) => {
      const next = Array.from({ length: MAX_ADDS }, (_, i) => (i === at ? add : held[i])).filter(Boolean)
      const { [name]: _was, ...rest } = book.skillAdds ?? {}
      save({ skillAdds: next.length ? { ...rest, [name]: next } : rest }).catch(failed)
    }
    const picker = at => {
      const now = held[at]
      const fits = SKILL_ADD_IDS.filter(id => addFits(kind, id) && (id === now?.id || !held.some(other => other.id === id)))
      const what = el('select', { 'aria-label': t`${name}的附加效果 ${at + 1}` }, [['', t`无`], ...fits.map(id => [id, ADD_NAMES()[id]])].map(([key, text]) => el('option', { value: key, text, selected: key === (now?.id ?? '') })))
      what.addEventListener('change', () => put(at, what.value ? { id: what.value, ...(SKILL_ADDS[what.value].sizes ? { size: now?.size ?? 'medium' } : {}) } : null))
      if (!now?.size) return [what]
      const size = el('select', { 'aria-label': t`${name}的附加效果 ${at + 1} 的幅度` }, ADD_SIZES.map(key => el('option', { value: key, text: SIZE_WORDS()[key], selected: key === now.size })))
      size.addEventListener('change', () => put(at, { ...now, size: size.value }))
      return [what, size]
    }
    return row(name, addsText(held, book.energyName) || t`${SKILL_KINDS()[kind]}，没有附加`, el('span', { class: 'game-adds' }, Array.from({ length: Math.min(MAX_ADDS, held.length + 1) }, (_, at) => picker(at)).flat()))
  }
  const showSkillAdds = () => {
    const names = [...new Set([...book.start.skills, ...Object.values(book.companions).flatMap(companion => Object.keys(companion.skills)), ...Object.keys(book.skillAdds ?? {})])]
    skillAdds.replaceChildren(...(names.length ? [el('p', { class: 'hint', text: t`附加效果：每个技能最多两条。附加越多，这一招本身越轻（每一点少半成）；小幅、中幅、大幅各算 1、2、3 点，最多 3 点，超出的会被削掉。「反噬」是代价，能退回一半点数。` }), ...names.map(addsRow)] : []))
  }
  afterSave = () => {
    showSkillAdds()
    showSkillArt()
  }
  showSkillAdds()
  showSkillArt()
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
      row(t`等级`, t`入队时的等级，空着就和你一样。比开局的等级每高一级，入队时带 2 点属性，在行囊的「队伍」里加。`, level),
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
    await openGameRules(card, { ...deps, scrollTop: main.scrollTop })
    dialog.close()
  }
  // 题材包: what one would set is shown first, each part to take or leave.
  const packBox = el('div')
  const packParts = id => {
    const theme = THEMES()[id]
    const list = words => words.join(t`、`)
    const parts = []
    const named = Object.entries(theme.words ?? {}).filter(([key, word]) => word !== WORD_LABELS()[key]).map(([key, word]) => `${WORD_LABELS()[key]} → ${word}`)
    parts.push({ key: 'words', on: true, label: t`叫法`, text: list([theme.energyName ? t`气力 → ${theme.energyName}` : t`气力用默认的`, ...named]) + t`。这张卡现在的叫法会被换掉。`, change: () => ({ energyName: theme.energyName, words: theme.words ?? {} }) })
    if (Object.keys(theme.skills).length) parts.push({ key: 'skills', on: true, label: t`开局技能`, text: list(Object.keys(theme.skills)) + t`。只影响新故事。`, change: () => ({ skills: { ...book.skills, ...theme.skills }, start: { ...book.start, skills: Object.keys(theme.skills) } }) })
    if (theme.level && theme.level !== book.level) parts.push({ key: 'level', on: true, label: t`规则`, text: t`改成「轻度」：检定、背包、任务，没有战斗。`, change: () => ({ level: theme.level }) })
    if (theme.sanity && !book.sanity) parts.push({ key: 'sanity', on: true, label: t`理智`, text: t`打开。`, change: () => ({ sanity: true }) })
    // 玩法模块: a pack turns on what it has, and turns off only what the pack this card had before turned on. A table
    // of types or a chain of 形态 comes only where the card has none.
    const was = THEMES()[book.theme] ?? {}
    const addsTypes = theme.types && !Object.keys(book.types ?? {}).length
    const addsForms = Object.entries(theme.forms ?? {}).filter(([owner]) => !book.forms?.[owner])
    const leads = theme.lead === 'command' ? book.lead !== 'command' : was.lead === 'command' && book.lead === 'command'
    const tames = theme.tame ? !book.tame : was.tame === true && book.tame === true
    const modules = [
      leads ? (theme.lead === 'command' ? t`谁上场改成「只指挥」` : t`谁上场改回「亲自上场」`) : '',
      tames ? (theme.tame ? t`打开收服` : t`关掉收服`) : '',
      addsTypes ? t`加一组类型（${list(Object.keys(theme.types))}，可以再改）` : '',
      addsForms.length ? t`给你自己加一串形态（${list(addsForms[0][1].map(form => form.name))}，战斗里临时变）` : '',
    ].filter(Boolean)
    if (book.level === 'full' && modules.length) parts.push({ key: 'modules', on: true, label: t`玩法模块`, text: list(modules) + t`。`, change: () => ({ ...(leads ? { lead: theme.lead === 'command' ? 'command' : 'self' } : {}), ...(tames ? { tame: theme.tame === true } : {}), ...(addsTypes ? { types: theme.types } : {}), ...(addsForms.length ? { forms: { ...(book.forms ?? {}), ...Object.fromEntries(addsForms) } } : {}) }) })
    // 成长: how it leans. The level only ever goes up with a pack; of the rest a pack sets what it has, and takes back
    // only what the pack before it set.
    const levels = ['off', 'standard', 'rich']
    const now = book.growth?.level ?? 'off'
    const level = levels.indexOf(theme.growth?.level ?? 'off') > levels.indexOf(now) ? theme.growth.level : now
    const wants = theme.growth ?? {}
    const had = was.growth ?? {}
    const held = book.growth ?? {}
    const lean = { ...(level !== now ? { level } : {}) }
    const leans = [level !== now ? t`成长开到「${level === 'rich' ? t`丰富` : t`标准`}」` : '']
    const noPoints = held.points === false
    if (wants.points === false && !noPoints) { Object.assign(lean, { points: false, levelPoints: 0 }); leans.push(t`升级不给属性点，只靠历练`) } else if (had.points === false && wants.points !== false && noPoints) { Object.assign(lean, { points: true }); leans.push(t`升级重新给属性点`) }
    if (wants.power && !held.power) { lean.power = true; leans.push(t`显示战力`) } else if (had.power && !wants.power && held.power) { lean.power = false; leans.push(t`不再显示战力`) }
    if (wants.rankSkills && !held.rankSkills) { lean.rankSkills = true; leans.push(t`突破时技能各升一阶`) } else if (had.rankSkills && !wants.rankSkills && held.rankSkills) { lean.rankSkills = false; leans.push(t`突破时技能不再升阶`) }
    if (wants.bondPoints && !held.bondPoints) { lean.bondPoints = wants.bondPoints; leans.push(t`同伴的羁绊每升一档给 ${wants.bondPoints} 点属性`) } else if (had.bondPoints && !wants.bondPoints && held.bondPoints === had.bondPoints) { lean.bondPoints = 0; leans.push(t`羁绊升档不再给属性点`) }
    const said = leans.filter(Boolean)
    if (book.level === 'full' && said.length && (level !== 'off')) parts.push({ key: 'growth', on: true, label: t`成长侧重`, text: list(said) + t`。`, change: () => ({ growth: { ...held, level, ...lean } }) })
    return parts
  }
  const showPack = id => {
    const theme = THEMES()[id]
    const parts = packParts(id)
    const boxes = parts.map(part => el('input', { type: 'checkbox', checked: part.on, 'aria-label': part.label }))
    // The look is the app's, not the card's: left unticked.
    const look = theme.look ? el('input', { type: 'checkbox', 'aria-label': t`战斗外观` }) : null
    const lookNames = { plain: t`简约`, ink: t`古风`, console: t`怀旧游戏机`, bold: t`撞色` }
    const take = async () => {
      const change = Object.assign({ theme: id }, ...parts.filter((_, i) => boxes[i].checked).map(part => part.change()))
      if (look?.checked) (await import('/game-look.js')).setLook({ look: theme.look })
      save(change).then(again).catch(failed)
    }
    packBox.replaceChildren(el('div', { class: 'game-proposal game-pack' }, [
      el('p', { class: 'hint' }, [el('b', { text: t`「${theme.label}」题材包` }), ' ', t`会改下面这些，不想要的去掉勾。规则本身不变，套用以后每一样都还能在这个窗口里改。`]),
      ...parts.map((part, i) => el('label', { class: 'hint game-pack-part' }, [boxes[i], el('span', {}, [el('b', { text: part.label }), ` ${part.text}`])])),
      look ? el('label', { class: 'hint game-pack-part' }, [look, el('span', {}, [el('b', { text: t`战斗外观` }), ' ', t`换成「${lookNames[theme.look]}」。外观是整个应用的设置，所有卡一起换。`])]) : null,
      el('div', { class: 'row end' }, [
        el('button', { type: 'button', class: 'btn small', text: t`算了`, onclick: () => { themeSelect.value = book.theme || 'plain'; packBox.replaceChildren() } }),
        el('button', { type: 'button', class: 'btn small primary', text: t`套用`, onclick: take }),
      ]),
    ]))
  }
  const themeSelect = el('select', { 'aria-label': t`题材` }, Object.entries(THEMES()).map(([id, theme]) => el('option', { value: id, text: theme.label, selected: id === (book.theme || 'plain') })))
  themeSelect.addEventListener('change', () => showPack(themeSelect.value))
  // The helper's proposal: shown, and kept only if taken.
  const proposal = el('div')
  /**
   * 题材包 beside a helper's layout of the card: what the pack has that neither the layout nor the card says.
   * `sure`: names and how growth leans, filled in unless the player says no. `maybe`: 玩法模块 the pack has and the
   * helper did not give this card, which it may have left out on purpose: only if the player says yes.
   */
  const packFill = (theme, found, growth) => {
    const words = Object.fromEntries(Object.entries(theme.words ?? {}).filter(([key, word]) => !found.words?.[key] && !book.words?.[key] && word !== WORD_LABELS()[key]))
    const energy = !found.energyName && !book.energyName && theme.energyName ? theme.energyName : ''
    const wants = theme.growth ?? {}
    const held = growth ?? {}
    const levels = ['off', 'standard', 'rich']
    const lean = {}
    const leans = []
    if (levels.indexOf(wants.level ?? 'off') > levels.indexOf(held.level ?? 'off')) { lean.level = wants.level; leans.push(t`成长开到「${wants.level === 'rich' ? t`丰富` : t`标准`}」`) }
    if (wants.points === false && held.points !== false && held.levelPoints === undefined) { Object.assign(lean, { points: false, levelPoints: 0 }); leans.push(t`升级不给属性点，只靠历练`) }
    if (wants.power && !held.power) { lean.power = true; leans.push(t`显示战力`) }
    if (wants.rankSkills && !held.rankSkills) { lean.rankSkills = true; leans.push(t`突破时技能各升一阶`) }
    if (wants.bondPoints && !held.bondPoints) { lean.bondPoints = wants.bondPoints; leans.push(t`同伴的羁绊每升一档给 ${wants.bondPoints} 点属性`) }
    const sure = [energy ? t`气力 → ${energy}` : '', ...Object.entries(words).map(([key, word]) => `${WORD_LABELS()[key]} → ${word}`), ...leans].filter(Boolean)
    const more = {}
    const maybe = []
    if (theme.lead === 'command' && found.lead !== 'command' && book.lead !== 'command') { more.lead = 'command'; maybe.push(t`谁上场改成「只指挥」`) }
    if (theme.tame === true && !found.tame && !book.tame) { more.tame = true; maybe.push(t`打开收服`) }
    if (theme.types && !found.types && !Object.keys(book.types ?? {}).length) { more.types = theme.types; maybe.push(t`加一组类型（${Object.keys(theme.types).join(t`、`)}，可以再改）`) }
    const forms = Object.entries(theme.forms ?? {}).filter(([owner]) => !found.forms?.[owner] && !book.forms?.[owner])
    if (forms.length) { more.forms = { ...(book.forms ?? {}), ...(found.forms ?? {}), ...Object.fromEntries(forms) }; maybe.push(t`给你自己加一串形态（${forms[0][1].map(form => form.name).join(t`、`)}，战斗里临时变）`) }
    if (theme.level && theme.level !== book.level) { more.level = theme.level; maybe.push(t`规则改成「轻度」，没有战斗`) }
    return { words, energy, lean, sure, more, maybe }
  }
  // `themeId`: the pack to fill in from, the helper's own pick until the player picks another.
  const showProposal = (found, themeId = found.theme) => {
    const theme = THEMES()[themeId] ?? THEMES().plain
    // 天赋 the card has already stay; a card that had no growth set takes what the helper's layout comes with.
    const perks = [...(book.perks ?? []), ...(found.perks ?? []).filter(perk => !(book.perks ?? []).some(own => own.name === perk.name))].slice(0, MAX_PERKS)
    const growth = perks.length ? { ...book.growth, level: 'rich' } : book.growth ?? found.growth
    const fill = packFill(theme, found, growth)
    const fillBox = fill.sure.length ? el('input', { type: 'checkbox', checked: true, 'aria-label': t`题材包补上的` }) : null
    const moreBox = fill.maybe.length ? el('input', { type: 'checkbox', 'aria-label': t`题材包里还有的` }) : null
    const take = () => {
      const filled = fillBox?.checked
      save({
        ...found,
        theme: themeId,
        energyName: found.energyName || (filled ? fill.energy : '') || book.energyName,
        growth: filled && growth ? { ...growth, ...fill.lean } : growth,
        perks,
        foes: { ...found.foes, ...book.foes },
        skills: { ...book.skills, ...found.skills },
        skillAdds: { ...(found.skillAdds ?? {}), ...(book.skillAdds ?? {}) },
        items: { ...book.items, ...found.items },
        bindings: { ...book.bindings, ...found.bindings },
        companions: { ...(found.companions ?? {}), ...book.companions },
        words: { ...(filled ? fill.words : {}), ...(found.words ?? {}), ...book.words },
        ...(moreBox?.checked ? fill.more : {}),
      }).then(again).catch(failed)
    }
    const pick = el('select', { 'aria-label': t`题材包` }, Object.entries(THEMES()).map(([id, one]) => el('option', { value: id, text: one.label, selected: id === themeId })))
    pick.addEventListener('change', () => showProposal(found, pick.value))
    const attributes = ATTRIBUTES.map(item => `${item.name} ${found.attributes[item.id]}`).join(t`、`)
    const lines = [
      [t`气力的叫法`, found.energyName],
      [t`叫法`, Object.entries(found.words ?? {}).map(([key, word]) => `${WORD_LABELS()[key]} → ${word}`).join(t`、`)],
      [t`属性`, attributes],
      [t`技能`, found.start.skills.map(name => (found.skillAdds?.[name] ? t`${name}（${addsText(found.skillAdds[name], found.energyName || book.energyName)}）` : name)).join(t`、`)],
      [t`开局物品`, found.start.things.map(thing => `${thing.count > 1 ? `${thing.name} ×${thing.count}` : thing.name}${found.items?.[thing.name]?.type === 'gear' ? t`（${gearText({ ...book, items: found.items }, thing.name)}）` : ''}`).join(t`、`)],
      [t`常见敌人`, Object.entries(found.foes).map(([name, foe]) => (foe.adds?.length ? t`${name}（${foeAddsLine(foe.adds)}）` : name)).join(t`、`)],
      [t`同伴`, Object.keys(found.companions ?? {}).join(t`、`)],
      [t`等级阶梯`, (found.ranks ?? []).join(t`、`)],
      [found.words?.form || book.words?.form || t`形态`, Object.entries(found.forms ?? {}).map(([owner, chain]) => t`${ownerLabel(owner)}：${chain.map(form => (form.temp && !form.at ? t`${form.name}（战斗里临时）` : form.name)).join(' → ')}`).join(t`；`)],
      [t`谁上场`, found.lead === 'command' ? t`只指挥` : ''],
      [t`收服`, found.tame ? t`开` : ''],
      [t`类型克制`, Object.entries(found.types ?? {}).map(([type, beats]) => (beats.length ? t`${type}克${beats.join(t`、`)}` : type)).join(t`，`) + (found.selfType ? t`；你自己是${found.selfType}` : '')],
      [found.words?.perk || book.words?.perk || t`天赋`, (found.perks ?? []).map(perk => t`${perk.name}（${perkShown(book, { ...perk, own: true }).effects}）`).join(t`、`)],
      [t`理智`, found.sanity ? t`开` : ''],
      [t`绑定变量`, Object.entries(found.bindings).map(([field, path]) => `${BINDING_WORDS(found.energyName || book.energyName).find(([key]) => key === field)[1]} → ${path}`).join(t`、`)],
    ].filter(([, text]) => text)
    proposal.replaceChildren(el('div', { class: 'game-proposal' }, [
      el('p', { class: 'hint' }, [el('b', { text: t`题材包` }), ' ', pick, ' ', themeId === found.theme ? t`辅助模型选的，可以换成别的。` : t`辅助模型选的是「${(THEMES()[found.theme] ?? THEMES().plain).label}」。`]),
      ...lines.map(([label, text]) => el('p', { class: 'hint' }, [el('b', { text: label }), ` ${text}`])),
      fillBox ? el('label', { class: 'hint game-pack-part' }, [fillBox, el('span', {}, [el('b', { text: t`题材包补上的` }), ' ', t`辅助模型没写、这张卡也没设的，用「${theme.label}」题材包的：${fill.sure.join(t`、`)}。`])]) : null,
      moreBox ? el('label', { class: 'hint game-pack-part' }, [moreBox, el('span', {}, [el('b', { text: t`题材包里还有的` }), ' ', t`辅助模型没给这张卡写这些，可能是这个世界没有。要的话勾上：${fill.maybe.join(t`、`)}。`])]) : null,
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
  const levelChoice = choice(t`规则`, book.level, [['off', t`关`], ['light', t`轻度`], ['full', t`完整`]], level => ({ level, ...(level === 'full' && book.level !== 'full' && !book.growth ? { growth: { level: 'standard' } } : {}) }))
  // 成长: how much a level brings, and the 天赋 that are this card's own.
  const growthLevel = book.growth?.level ?? 'off'
  const growthChoice = el('select', { 'aria-label': t`成长` }, [['off', t`关`], ['standard', t`标准`], ['rich', t`丰富`]].map(([key, text]) => el('option', { value: key, text, selected: key === growthLevel })))
  growthChoice.addEventListener('change', () => save({ growth: { ...book.growth, level: growthChoice.value } }).then(again).catch(failed))
  const perksBox = el('div')
  const savePerks = perks => save({ perks }).then(showPerks, failed)
  function perkBox(perk, at) {
    const list = book.perks ?? []
    const put = change => savePerks(list.map((item, i) => (i === at ? { ...item, ...change } : item)))
    const name = el('input', { type: 'text', maxlength: 24, value: perk.name, 'aria-label': t`名字` })
    name.addEventListener('change', () => (name.value.trim() ? put({ name: name.value.trim() }) : showPerks()))
    const note = el('input', { type: 'text', maxlength: 80, value: perk.note, 'aria-label': t`说明`, placeholder: t`一句话说它是什么` })
    note.addEventListener('change', () => put({ note: note.value.trim() }))
    const big = el('input', { type: 'checkbox', checked: perk.big === true, 'aria-label': t`突破时才能选` })
    big.addEventListener('change', () => put({ big: big.checked }))
    // 技能: a 天赋 may teach one, which takes some of its points.
    const taught = el('input', { type: 'text', maxlength: 40, value: perk.skill ?? '', 'aria-label': t`教会的技能`, placeholder: t`不教技能就空着` })
    const taughtKind = el('select', { 'aria-label': t`教会的技能的效果`, hidden: !perk.skill }, Object.entries(SKILL_KINDS()).map(([kind, text]) => el('option', { value: kind, text, selected: kind === (book.skills[perk.skill] ?? perk.skillKind ?? skillKindOf(perk.skill ?? '')) })))
    taught.addEventListener('change', () => put(taught.value.trim() ? { skill: taught.value.trim(), skillKind: book.skills[taught.value.trim()] ?? skillKindOf(taught.value.trim()) } : { skill: '', skillKind: '', ...(perk.effects.length ? {} : { effects: [{ id: 'attack', size: 'small' }] }) }))
    taughtKind.addEventListener('change', () => save({ skills: { ...book.skills, [perk.skill]: taughtKind.value }, perks: list.map((item, i) => (i === at ? { ...item, skillKind: taughtKind.value } : item)) }).then(showPerks, failed))
    // Two effects at most here, each picked from the rules' table; what comes to more than the budget is cut back when kept.
    const effectRow = slot => {
      const effect = perk.effects[slot]
      const which = el('select', { 'aria-label': t`效果 ${slot + 1}` }, [slot || perk.skill ? ['', t`没有`] : null, ...EFFECT_IDS.map(id => [id, EFFECT_NAMES(wordsOf(book))[id]])].filter(Boolean).map(([id, text]) => el('option', { value: id, text, selected: id === (effect?.id ?? '') })))
      const size = el('select', { 'aria-label': t`强度`, hidden: !effect || !EFFECTS[effect.id].sizes }, SIZES.map(key => el('option', { value: key, text: SIZE_WORDS()[key], selected: key === effect?.size })))
      const on = el('select', { 'aria-label': t`哪一项属性`, hidden: effect?.id !== 'check' }, ATTRIBUTES.map(item => el('option', { value: item.id, text: book.words?.[item.id] || WORD_LABELS()[item.id], selected: item.id === effect?.on })))
      const minus = el('input', { type: 'checkbox', checked: effect?.minus === true, 'aria-label': t`作为代价` })
      const changed = () => {
        const effects = perk.effects.slice()
        if (which.value) effects[slot] = { id: which.value, size: size.value || 'medium', ...(which.value === 'check' ? { on: on.value || 'body' } : {}), ...(minus.checked ? { minus: true } : {}) }
        else effects.splice(slot, 1)
        put({ effects })
      }
      for (const control of [which, size, on, minus]) control.addEventListener('change', changed)
      return el('div', { class: 'growth-effect-row' }, [which, size, on, el('label', { class: 'hint', hidden: !effect || !EFFECTS[effect.id].sizes }, [minus, ' ', t`作为代价`])])
    }
    return el('details', { class: 'game-companion' }, [
      el('summary', {}, [el('b', { text: perk.name }), el('span', { class: 'hint', text: (perk.big ? t`突破时选 · ` : '') + perkShown(book, { ...perk, own: true }).effects })]),
      row(t`名字`, '', name),
      row(t`说明`, '', note),
      row(t`突破时才能选`, t`勾上就是大${book.words?.perk || t`天赋`}：跨进下一个大等级时三选一，效果最多 ${BIG_BUDGET} 点。没填等级阶梯的卡用不上。`, big),
      row(t`教会一个技能`, t`选了它就学会这个技能，算 ${PERK_SKILL_COST} 点，下面的效果相应少 ${PERK_SKILL_COST} 点。`, el('span', { class: 'game-adds' }, [taught, taughtKind])),
      row(t`带来的效果`, t`小幅算 1 点，中幅 2 点，大幅 3 点，先手和不屈各 2 点，加起来最多 ${PERK_BUDGET} 点，超出的会被削掉。勾「作为代价」变成坏处，退回一半点数。`, el('div', {}, [effectRow(0), effectRow(1)])),
      el('div', { class: 'row end' }, [el('button', { type: 'button', class: 'btn small', text: t`删除`, onclick: () => savePerks(list.filter((_, i) => i !== at)) })]),
    ])
  }
  function showPerks() {
    const list = book.perks ?? []
    const name = el('input', { type: 'text', maxlength: 24, placeholder: t`名字`, 'aria-label': t`新的${book.words?.perk || t`天赋`}` })
    const add = () => {
      const said = name.value.trim()
      if (!said || list.some(perk => perk.name === said) || list.length >= MAX_PERKS) return
      savePerks(cleanPerks([...list, { name: said, note: '', effects: [{ id: 'attack', size: 'small' }] }]))
    }
    name.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      add()
    })
    perksBox.replaceChildren(...list.map(perkBox), el('div', { class: 'bag-add' }, [name, el('button', { type: 'button', class: 'btn small', text: t`加一个`, onclick: add })]))
  }
  showPerks()
  // 装备: the things this card knows as gear, whoever has them. One the story gives by the same name is this one.
  const gearBox = el('div')
  function showGear() {
    const names = Object.keys(book.items).filter(name => book.items[name].type === 'gear')
    const putItems = items => save({ items }).then(showGear, failed)
    const name = el('input', { type: 'text', maxlength: 40, placeholder: t`装备的名字`, 'aria-label': t`新的装备` })
    const add = () => {
      const said = name.value.trim()
      if (!said || book.items[said]?.type === 'gear') return
      putItems({ ...book.items, [said]: { type: 'gear', slot: slotByName(said), rarity: 'common', effects: [] } })
    }
    name.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      add()
    })
    gearBox.replaceChildren(
      ...names.map(item => el('div', { class: 'game-foe' }, [
        row(item, gearText(book, item), el('button', { type: 'button', class: 'btn small', text: t`删除`, 'aria-label': t`删除${item}`, onclick: () => putItems(Object.fromEntries(Object.entries(book.items).filter(([key]) => key !== item))) })),
        el('div', { class: 'cp-row' }, [el('span', { class: 'game-adds' }, gearPickers({ el, name: item, set: book.items[item], book, put: change => putItems({ ...book.items, [item]: { ...book.items[item], ...change } }) }))]),
      ])),
      el('div', { class: 'bag-add' }, [name, el('button', { type: 'button', class: 'btn small', text: t`加一件`, onclick: add })]),
    )
  }
  showGear()
  // 形态: who of the party changes into what. A chain to each, the first of it how they start.
  const formsBox = el('div')
  const saveForms = forms => save({ forms }).then(showForms, failed)
  const ownerLabel = owner => (owner === PLAYER_FORMS ? t`玩家自己` : !book.companions[owner] && book.foes[owner] ? t`${owner}（收服以后）` : owner)
  function formBox(owner, chain, at) {
    const form = chain[at]
    const forms = book.forms ?? {}
    const put = change => saveForms({ ...forms, [owner]: chain.map((item, i) => (i === at ? { ...item, ...change } : item)) })
    const whose = t`${ownerLabel(owner)}的${form.name}`
    const energy = book.energyName || t`气力`
    const text = (value, label, placeholder, max, change) => {
      const input = el('input', { type: 'text', maxlength: max, value, 'aria-label': label, placeholder })
      input.addEventListener('change', () => change(input.value.trim()))
      return input
    }
    const name = text(form.name, t`${whose}的名字`, t`名字`, 24, said => (said && !chain.some((item, i) => i !== at && item.name === said) ? put({ name: said }) : showForms()))
    const stage = text(form.stage ?? '', t`${whose}的阶段`, t`阶段名，可不填`, 12, said => put({ stage: said }))
    const needs = form.at ?? {}
    const level = el('input', { type: 'number', min: 0, max: 99, value: needs.level ?? '', 'aria-label': t`${whose}要到几级`, placeholder: t`等级` })
    level.addEventListener('change', () => put({ at: { ...needs, level: Math.round(Number(level.value)) || undefined } }))
    const item = text(needs.item ?? '', t`${whose}要带着什么`, t`要带着的道具`, 40, said => put({ at: { ...needs, item: said || undefined } }))
    const bond = el('select', { 'aria-label': t`${whose}要的羁绊` }, [[0, t`不看羁绊`], ...BOND_AT.map((_, i) => [i + 1, t`羁绊${[t`一档`, t`二档`, t`三档`][i]}`])].map(([value, label]) => el('option', { value: String(value), text: label, selected: value === (needs.bond ?? 0) })))
    bond.addEventListener('change', () => put({ at: { ...needs, bond: Number(bond.value) || undefined } }))
    const temp = el('input', { type: 'checkbox', checked: form.temp === true, 'aria-label': t`${whose}可以在战斗里临时变` })
    temp.addEventListener('change', () => put({ temp: temp.checked, ...(temp.checked ? {} : { drain: false }) }))
    const drain = el('input', { type: 'checkbox', checked: form.drain === true, 'aria-label': t`${whose}靠${energy}撑着` })
    drain.addEventListener('change', () => put({ drain: drain.checked }))
    const skills = form.skills ?? {}
    const skillRows = Object.entries(skills).map(([skill, kind]) => {
      const pick = el('select', { 'aria-label': t`${skill}的效果` }, Object.entries(SKILL_KINDS()).map(([key, label]) => el('option', { value: key, text: label, selected: key === (book.skills[skill] ?? (kind || skillKindOf(skill))) })))
      pick.addEventListener('change', () => save({ skills: { ...book.skills, [skill]: pick.value }, forms: { ...forms, [owner]: chain.map((one, i) => (i === at ? { ...one, skills: { ...skills, [skill]: pick.value } } : one)) } }).then(showForms, failed))
      return el('span', { class: 'game-adds' }, [el('span', { text: skill }), pick, el('button', { type: 'button', class: 'btn small', text: '×', 'aria-label': t`去掉${skill}`, onclick: () => put({ skills: Object.fromEntries(Object.entries(skills).filter(([key]) => key !== skill)) }) })])
    })
    const newSkill = text('', t`${whose}才会的新技能`, t`加一个技能`, 40, said => (said && !skills[said] ? put({ skills: { ...skills, [said]: book.skills[said] ?? skillKindOf(said) } }) : null))
    // A row with several inputs: its title (and hint) on a line of their own above them, or the window's width squeezes
    // the title to a character a line.
    const stacked = node => { node.classList.add('cp-stack'); return node }
    return el('div', { class: 'game-form' }, [
      stacked(row(at ? t`第 ${at + 1} 个` : t`最初的样子`, '', el('span', { class: 'game-adds' }, [name, stage, chain.length > 2 ? el('button', { type: 'button', class: 'btn small', text: t`删除`, 'aria-label': t`删除${whose}`, onclick: () => saveForms({ ...forms, [owner]: chain.filter((_, i) => i !== at) }) }) : null]))),
      at ? stacked(row(t`变成它的条件`, t`填了几样就都要满足，到了以后在行囊里点。都不填就只能由剧情给。`, el('span', { class: 'game-adds' }, [level, item, owner === PLAYER_FORMS ? null : bond]))) : null,
      stacked(row(t`加成`, t`处在这个形态时才有，最多 ${formBudget(at)} 点。`, el('span', { class: 'game-adds' }, effectPickers({ el, name: whose, effects: form.effects, words: wordsOf(book), put: effects => put({ effects }) })))),
      stacked(row(t`这个形态才会的技能`, '', el('div', { class: 'game-form-skills' }, [...skillRows, Object.keys(skills).length < 3 ? newSkill : null]))),
      at ? row(t`战斗里临时变`, t`勾上后，处在前一个形态的人可以在战斗里花 ${Math.round(SHIFT_COST * 100)}% ${energy}变成它，打完变回去。`, temp) : null,
      at && form.temp ? row(t`${energy}耗尽就变回去`, t`勾上后，变了以后从下一回合起每回合耗 ${Math.round(SHIFT_UPKEEP * 100)}% ${energy}，不够了就在这场战斗里变回原样。适合「变身撑不了多久」的设定。`, drain) : null,
    ])
  }
  function showForms() {
    const forms = book.forms ?? {}
    // 收服: a foe that can be taken along may have a chain too, for when it is.
    const free = [...new Set([PLAYER_FORMS, ...Object.keys(book.companions), ...(book.tame ? Object.keys(book.foes) : [])])].filter(owner => !forms[owner])
    // A chain being worked on stays open while each change to it is kept.
    const open = new Set([...formsBox.querySelectorAll('details[open]')].map(node => node.dataset.owner))
    const who = el('select', { 'aria-label': t`给谁加形态` }, free.map(owner => el('option', { value: owner, text: ownerLabel(owner) })))
    const add = () => saveForms({ ...forms, [who.value]: [{ name: who.value === PLAYER_FORMS ? t`原本的样子` : who.value, effects: [] }, { name: t`新形态`, effects: [{ id: 'attack', size: 'medium' }] }] })
    formsBox.replaceChildren(
      ...Object.entries(forms).map(([owner, chain]) => el('details', { class: 'game-companion', 'data-owner': owner, ...(open.has(owner) ? { open: '' } : {}) }, [
        el('summary', {}, [el('b', { text: ownerLabel(owner) }), el('span', { class: 'hint', text: chain.map(formName).join(' → ') })]),
        ...chain.map((_, at) => formBox(owner, chain, at)),
        el('div', { class: 'row end' }, [
          chain.length < MAX_FORMS ? el('button', { type: 'button', class: 'btn small', text: t`再加一个形态`, onclick: () => saveForms({ ...forms, [owner]: [...chain, { name: t`新形态 ${chain.length + 1}`, effects: [] }] }) }) : null,
          el('button', { type: 'button', class: 'btn small', text: t`删掉这一串`, 'aria-label': t`删掉${ownerLabel(owner)}的形态`, onclick: () => saveForms(Object.fromEntries(Object.entries(forms).filter(([key]) => key !== owner))) }),
        ]),
      ])),
      ...(free.length ? [el('div', { class: 'bag-add' }, [who, el('button', { type: 'button', class: 'btn small', text: t`加一串形态`, onclick: add })])] : []),
    )
  }
  showForms()
  // 里程碑 → 奖励: a row to each kind of step, and in it what that step brings on this card.
  function milesRows() {
    const perk = book.words?.perk || t`天赋`
    const life = book.words?.life || t`生命`
    const energy = book.energyName || t`气力`
    const rich = growthLevel === 'rich'
    const put = change => ({ growth: { ...book.growth, ...change } })
    const gift = (label, control) => el('label', { class: 'hint game-gift' }, [label, ' ', control])
    const count = (label, value, most, change) => gift(label, choice(label, String(value), Array.from({ length: most + 1 }, (_, i) => [String(i), i ? t`${i} 点` : t`不给`]), said => put(change(Number(said)))))
    const tick = (label, value, change) => {
      const box = el('input', { type: 'checkbox', checked: value, 'aria-label': label })
      box.addEventListener('change', () => save(put(change(box.checked))).catch(failed))
      return el('label', { class: 'hint game-gift' }, [box, ' ', label])
    }
    const every = perkEveryOf(book)
    const everyPick = choice(t`每隔几级`, String(every), Array.from({ length: PERK_EVERY_RANGE[1] - PERK_EVERY_RANGE[0] + 1 }, (_, i) => [String(PERK_EVERY_RANGE[0] + i), t`每 ${PERK_EVERY_RANGE[0] + i} 级`]), value => put({ perkEvery: Number(value) }))
    const gifts = list => el('span', { class: 'game-adds game-gifts' }, list.filter(Boolean))
    return [
      el('p', { class: 'hint', text: t`里程碑和奖励：成长路上的每一种时刻各给什么。给得越多，人物比敌人强得越快。${life}和${energy}的上限随等级涨、技能越用越强、检定成功记历练，这三样是固定的。` }),
      row(t`每升一级`, t`不给属性点时属性只靠历练涨，适合「用过才会成长」的故事。`, gifts([count(t`属性点`, levelPointsOf(book), LEVEL_POINTS_MOST, value => ({ points: value > 0, levelPoints: value }))])),
      row(t`每隔几级`, rich ? t`到了就三选一一个${perk}，这一样固定给。` : t`「丰富」的成长在这时三选一一个${perk}。`, gifts([everyPick, count(t`再给属性点`, everyGives(book).points, LEVEL_POINTS_MOST, value => ({ everyPoints: value })), tick(t`${life}和${energy}回满`, everyGives(book).restore, value => ({ everyRestore: value }))])),
      book.ranks.length ? row(t`突破`, t`跨进等级阶梯的下一个大等级时。`, gifts([
        tick(t`${life}和${energy}回满`, rankRestores(book), value => ({ rankRestore: value })),
        rich ? tick(t`选一个大${perk}`, book.growth?.rankBig !== false, value => ({ rankBig: value })) : null,
        count(t`属性点`, book.growth?.rankPoints ?? 0, RANK_POINTS_MOST, value => ({ rankPoints: value })),
        tick(t`技能各升一阶`, book.growth?.rankSkills === true, value => ({ rankSkills: value })),
      ])) : el('p', { class: 'hint', text: t`填了等级阶梯以后，这里会多一行「突破」。` }),
      row(t`羁绊每升一档`, t`同伴和你并肩打赢 ${BOND_AT.join(t`、`)} 场时各升一档，固定带来减伤、伤害、替你挡下。`, gifts([count(t`那个同伴的属性点`, bondPointsOf(book), BOND_POINTS_MOST, value => ({ bondPoints: value }))])),
    ]
  }
  const growthSettings = [
    row(t`成长节奏`, t`升一级要多少经验。快：平时的六成。慢：平时的一倍半。只管升级快慢，不改敌人强弱；正在玩的对话从下一次得到经验起按新的算。`, choice(t`成长节奏`, book.pace ?? 'normal', [['fast', t`快`], ['normal', t`适中`], ['slow', t`慢`]], pace => ({ pace }))),
    row(t`成长`, t`升级带来什么。关：只有属性点，和以前一样。标准：${book.words?.life || t`生命`}和${book.energyName || t`气力`}上限随等级涨，技能越用越强。丰富：再加每 ${perkEveryOf(book)} 级三选一的${book.words?.perk || t`天赋`}。正在玩的对话下一轮就按新的算。`, growthChoice),
    growthLevel !== 'off' ? row(t`战力`, t`在行囊的角色页显示一个战力数字：把属性和成长折成一个数，常人 1 级是 100。只是参考。`, choice(t`战力`, book.growth?.power ? 'on' : 'off', [['off', t`不显示`], ['on', t`显示`]], value => ({ growth: { ...book.growth, power: value === 'on' } }))) : null,
    growthLevel === 'rich' ? row(t`同伴的${book.words?.perk || t`天赋`}`, t`自动：到了级数由程序按同伴擅长的属性选。手动：在行囊的「队伍」里你来选。`, choice(t`同伴的天赋`, book.growth?.companions === 'manual' ? 'manual' : 'auto', [['auto', t`自动`], ['manual', t`手动`]], value => ({ growth: { ...book.growth, ...(value === 'manual' ? { companions: 'manual' } : { companions: undefined }) } }))) : null,
    ...(growthLevel !== 'off' ? milesRows() : []),
    growthLevel === 'rich' ? el('p', { class: 'hint', text: t`这张卡自己的${book.words?.perk || t`天赋`}：选的时候优先出现，另外还有通用的 24 个。可以让「辅助模型配置」按这张卡的世界观来写。` }) : null,
    growthLevel === 'rich' ? perksBox : null,
    growthLevel !== 'off' ? el('p', { class: 'hint', text: t`这张卡的装备：故事里得到同名的东西时，就按这里写的算。部位、稀有度和效果都能改。这里只是让这张卡认识它；要让玩家手里有，用「读卡配置」写进开局物品，或在行囊的物品页添加。` }) : null,
    growthLevel !== 'off' ? gearBox : null,
    growthLevel !== 'off' ? el('p', { class: 'hint', text: t`这张卡的${book.words?.form || t`形态`}：会变身、觉醒、合体、进化的人或伙伴，各有一串形态，每个形态有自己的加成和技能，换了形态就换一套。可以是变了就一直是（条件到了在行囊里点，或由剧情给），也可以只在战斗里临时变、打完变回去。修为、境界这种只升不降的不在这里，填在上面的「等级阶梯」。可以让「读卡配置」按这张卡来写。` }) : null,
    growthLevel !== 'off' ? formsBox : null,
  ]
  function ranksInput() {
    const input = el('input', { type: 'text', value: book.ranks.join(t`、`), 'aria-label': t`等级阶梯`, placeholder: t`炼气、筑基、金丹` })
    input.addEventListener('change', () => save({ ranks: input.value.split(/[、，,\s]+/).filter(Boolean) }).then(again).catch(failed))
    return input
  }
  // 类型克制: the card's types, what each beats, and what is of which type.
  const typesBox = el('div')
  function showTypes() {
    const types = book.types ?? {}
    const names = Object.keys(types)
    const list = el('input', { type: 'text', value: names.join(t`、`), 'aria-label': t`类型`, placeholder: t`火、水、草` })
    list.addEventListener('change', () => {
      const said = [...new Set(list.value.split(/[、，,\s]+/).map(name => name.trim().slice(0, 8)).filter(Boolean))].slice(0, 8)
      save({ types: Object.fromEntries(said.map(name => [name, (types[name] ?? []).filter(beaten => said.includes(beaten))])) }).then(showTypes, failed)
    })
    const beats = name => el('span', { class: 'game-adds' }, names.filter(other => other !== name).map(other => {
      const box = el('input', { type: 'checkbox', checked: types[name].includes(other), 'aria-label': t`${name}克制${other}` })
      box.addEventListener('change', () => save({ types: { ...types, [name]: box.checked ? [...types[name], other] : types[name].filter(beaten => beaten !== other) } }).then(showTypes, failed))
      return el('label', { class: 'hint' }, [box, ' ', other])
    }))
    const pickType = (label, value, put) => {
      const select = el('select', { 'aria-label': label }, [['', t`无`], ...names.map(name => [name, name])].map(([key, text]) => el('option', { value: key, text, selected: key === (value ?? '') })))
      select.addEventListener('change', () => put(select.value).then(showTypes, failed))
      return select
    }
    const skills = [...new Set([...book.start.skills, ...Object.values(book.companions).flatMap(companion => Object.keys(companion.skills)), ...Object.values(book.forms ?? {}).flatMap(chain => chain.flatMap(form => Object.keys(form.skills ?? {})))])]
    const group = (title, rows) => (rows.length ? [el('p', { class: 'hint', text: title }), ...rows] : [])
    typesBox.replaceChildren(
      row(t`类型克制`, t`这个世界的东西分哪几种类型（元素、五行、疫苗病毒数据），用逗号分开，最多 8 种。填了两种以上才生效。克制时伤害 ×1.5，被克 ×0.8；敌人打你和同伴时是 ×1.1 和 ×0.9。`, list),
      ...names.map(name => row(t`${name}克制`, '', beats(name))),
      ...(names.length > 1 ? [
        ...group(t`技能的类型（不选就跟着使用者）`, skills.map(skill => row(skill, '', pickType(t`${skill}的类型`, book.skillTypes?.[skill], type => save({ skillTypes: { ...(book.skillTypes ?? {}), [skill]: type } }))))),
        ...group(t`你自己的类型（不选就没有类型，谁也不克、也不被克）`, [row(t`你自己`, '', pickType(t`你自己的类型`, book.selfType, type => save({ selfType: type })))]),
        ...group(t`同伴的类型`, Object.keys(book.companions).map(name => row(name, '', pickType(t`${name}的类型`, book.companions[name].type, type => save({ companions: { ...book.companions, [name]: { ...book.companions[name], type } } }))))),
        ...group(t`形态的类型（不选就和原来一样）`, Object.entries(book.forms ?? {}).flatMap(([owner, chain]) => chain.slice(1).map((form, i) => row(formName(form), '', pickType(t`${form.name}的类型`, form.type, type => save({ forms: { ...book.forms, [owner]: chain.map((item, at) => (at === i + 1 ? { ...item, type } : item)) } })))))),
        ...group(t`敌人的类型（没见过的敌人第一次遇到时由辅助模型填）`, Object.keys(book.foes).map(name => row(name, '', pickType(t`${name}的类型`, book.foes[name].type, type => save({ foes: { ...book.foes, [name]: { ...book.foes[name], type } } }))))),
      ] : []),
    )
  }
  showTypes()
  // 分区: the window in parts, each folded or open as this person left it (kept on this device), and a list of them to
  // jump by, the part in view marked: beside the parts on a wide screen, a row of tabs along the top on a narrow one.
  const fights = () => levelChoice.value === 'full'
  const PARTS = [
    { key: 'basics', title: t`基本`, about: t`规则档位、检定难度、剧情暂停、理智`, children: [
      row(t`规则`, t`轻度：检定、背包、任务和地图。完整：再加战斗和等级。`, levelChoice),
      ownFights ? el('p', { class: 'hint warn', text: t`这张卡好像自带战斗界面。开「完整」后两套可能同时出现，可以只开「轻度」。` }) : null,
      row(t`检定难度`, t`检定的难度整体调低或调高，战斗的在「战斗设置」里单独设。`, choice(t`检定难度`, book.difficulty, [['easy', t`宽松`], ['normal', t`标准`], ['hard', t`严苛`]], difficulty => ({ difficulty }))),
      row(t`剧情暂停`, t`让模型在有风险的地方停下来等你掷骰。导入的预设有自己的输出格式，可能和这个冲突，所以默认不开，只有选项上的检定。`, choice(t`剧情暂停`, book.pause === null ? 'auto' : book.pause ? 'on' : 'off', [['auto', t`自动`], ['on', t`开`], ['off', t`关`]], value => ({ pause: value === 'auto' ? null : value === 'on' }))),
      row(t`理智`, t`恐怖题材用：目睹恐怖时理智下降，很难恢复，低了影响心智，归零时发疯。`, choice(t`理智`, book.sanity ? 'on' : 'off', [['off', t`关`], ['on', t`开`]], value => ({ sanity: value === 'on' }))),
    ] },
    { key: 'setup', title: t`快速配置`, about: t`题材包，或让辅助模型读卡来配`, children: [
      row(t`题材包`, t`按故事的种类套一组设置：叫法、开局技能、玩法模块、成长侧重和战斗外观。选了以后先列出它会改什么，你挑着套用。`, themeSelect),
      packBox,
      row(t`辅助模型配置`, t`让辅助模型读这张卡，选一个题材包，再按这张卡写出叫法、属性、技能、物品、常见敌人、同伴、等级阶梯、天赋、形态和变量绑定；它没写的由题材包补上。你看过再采用。`, askHelper),
      proposal,
    ] },
    { key: 'words', title: t`叫法`, about: t`界面和规则里怎么称呼`, children: [
      el('p', { class: 'hint', text: t`这张卡怎么叫这些东西，界面和发给模型的规则一起换。只换名字，数值和存档不变；空着就用默认的叫法。` }),
      wordsBox,
    ] },
    { key: 'start', title: t`开局`, about: t`开局技能、属性，试打一场`, children: [
      row(t`开局技能`, t`战斗里能用的技能，用逗号分开。效果先按名字猜，下面可以改。空着就给强击和横扫。`, skillsInput()),
      skillKinds,
      skillAdds,
      el('h4', { class: 'gr-sub', text: t`开局属性` }),
      el('p', { class: 'hint' }, [t`10 是常人。只影响新故事，已经开始的故事保持原样。`, ' ', spare]),
      ...ATTRIBUTES.map(attribute),
      row(t`试打一场`, t`用这张卡的属性打一场，看看战斗怎么玩。什么都不会保存。`, el('span', { class: 'battle-trial' }, [trial, el('button', { type: 'button', class: 'btn small', text: t`开始`, onclick: () => tryFight().catch(failed) })])),
    ] },
    { key: 'fight', full: true, title: t`战斗设置`, about: t`难度、频率、等级阶梯`, children: [
      row(t`战斗难度`, t`敌人的生命和伤害。宽松时更好打，严苛时敌人更耐打、打得更疼。`, choice(t`战斗难度`, book.fightDifficulty, [['easy', t`宽松`], ['normal', t`标准`], ['hard', t`严苛`]], fightDifficulty => ({ fightDifficulty }))),
      row(t`战斗频率`, t`模型多久安排一次打斗。少：只在剧情需要时；多：隔一两轮就有战斗选项。`, choice(t`战斗频率`, book.fightRate, [['rare', t`少`], ['normal', t`适中`], ['often', t`多`]], fightRate => ({ fightRate }))),
      row(t`等级阶梯`, t`这个世界的等级，从低到高，用逗号分开。填了以后敌人按等级算差距；不填时由模型写敌人比你强多少。`, ranksInput()),
      book.ranks.length ? row(t`阶梯跨度`, t`大：差一级就很难打，比如修仙的境界。小：差几级才打不过，比如段位、军衔。`, choice(t`阶梯跨度`, book.rankSpan, [['wide', t`跨度大`], ['narrow', t`跨度小`]], rankSpan => ({ rankSpan }))) : null,
      book.ranks.length ? row(t`开局等级`, t`玩家从哪一级开始，只影响新故事。绑定了「等级（文字）」的卡按变量来。`, choice(t`开局等级`, book.start.rank || book.ranks[0], book.ranks.map(rank => [rank, rank]), rank => ({ start: { ...book.start, rank } }))) : null,
    ] },
    { key: 'growth', full: true, title: t`成长`, about: t`节奏、里程碑、天赋、装备、形态`, children: growthSettings },
    { key: 'modules', full: true, title: t`玩法模块`, about: t`谁上场、收服、类型克制`, children: [
      el('p', { class: 'hint', text: t`按题材开的几样玩法，不开就和以前一样。可以让「读卡配置」按这张卡来定。` }),
      row(t`谁上场`, t`亲自上场：你和同伴一起打。只指挥：你不动手也不挨打，给同伴鼓劲、递道具、喊撤退，同伴都倒下才算输；身边没有同伴时还是你自己打。适合驯兽师、召唤师、指挥官。`, choice(t`谁上场`, book.lead === 'command' ? 'command' : 'self', [['self', t`亲自上场`], ['command', t`只指挥`]], lead => ({ lead }))),
      row(t`收服`, t`打赢以后可以试着把一个打倒的敌人收为同伴，首领除外。成不成看你的${book.words?.charm || t`魅力`}，只有一次机会。`, choice(t`收服`, book.tame ? 'on' : 'off', [['off', t`关`], ['on', t`开`]], value => ({ tame: value === 'on' }))),
      typesBox,
    ] },
    { key: 'party', full: true, title: t`队伍名册`, about: t`一起打架的同伴`, children: [
      el('p', { class: 'hint', text: t`和你一起打架的人：各有各的属性和技能，在行囊的「队伍」里安排谁上场。故事里写到有人入队时，名册里没有的人按常人加进来。` }),
      roster,
    ] },
    { key: 'foes', title: t`敌人图鉴`, about: t`遇到过的敌人：立绘和招式效果`, children: [bestiary] },
    { key: 'cutin', title: t`技能特写`, about: t`给技能配图，战斗里放技能时全屏特写`, children: [skillArt] },
    { key: 'links', title: t`绑定变量`, about: t`把卡的变量当作生命、背包来用`, children: [
      el('p', { class: 'hint', text: t`这张卡已有的变量可以当作生命、背包这些来用：故事里归卡管，用物品时由规则写回。` }),
      paths.length ? el('div', { class: 'row' }, [guess]) : el('p', { class: 'hint', text: t`打开这张卡的对话后才能选变量。` }),
      paths.length ? links : null,
    ] },
  ]
  const folded = readFolded()
  const uid = Math.random().toString(36).slice(2, 8)
  const parts = new Map(PARTS.map(part => {
    const id = `gr-${uid}-${part.key}`
    const shut = folded.has(part.key)
    const body = el('div', { class: 'gr-body', id: `${id}-body`, hidden: shut }, part.children)
    const head = el('button', { type: 'button', class: 'gr-head', id: `${id}-head`, 'aria-expanded': String(!shut), 'aria-controls': body.id, onclick: () => fold(part.key, !folded.has(part.key)) }, [
      el('span', { class: 'gr-title', text: part.title }),
      el('span', { class: 'gr-about', text: part.about }),
      el('span', { class: 'gr-chevron', 'aria-hidden': 'true' }),
    ])
    const section = el('section', { class: `gr-sec${shut ? ' folded' : ''}`, id, 'aria-labelledby': head.id }, [el('h3', { class: 'gr-h' }, [head]), body])
    const tab = el('button', { type: 'button', class: 'gr-tab', text: part.title, 'aria-controls': id, onclick: () => jump(part.key) })
    return [part.key, { part, section, head, body, tab }]
  }))
  const shown = () => [...parts.values()].filter(({ section }) => !section.hidden)
  const allButton = el('button', { type: 'button', class: 'btn small gr-all' })
  const showAll = () => { allButton.textContent = shown().every(({ part }) => folded.has(part.key)) ? t`全部展开` : t`全部收起` }
  function fold(key, shut) {
    const { section, head, body } = parts.get(key)
    if (shut) folded.add(key)
    else folded.delete(key)
    body.hidden = shut
    head.setAttribute('aria-expanded', String(!shut))
    section.classList.toggle('folded', shut)
    keepFolded(folded)
    showAll()
    requestAnimationFrame(spy)
  }
  allButton.addEventListener('click', () => {
    const shut = !shown().every(({ part }) => folded.has(part.key))
    for (const { part } of shown()) fold(part.key, shut)
  })
  const tabs = el('div', { class: 'gr-tabs' }, [...parts.values()].map(({ tab }) => tab))
  const nav = el('nav', { class: 'gr-nav', 'aria-label': t`游戏规则的分类` }, [tabs, allButton])
  const main = el('div', { class: 'gr-main' }, [...parts.values()].map(({ section }) => section))
  // Only the full rules have fights: their parts, and the tabs to them, come and go with it.
  const showFights = () => {
    for (const { part, section, tab } of parts.values()) if (part.full) section.hidden = tab.hidden = !fights()
    showAll()
    spy()
  }
  levelChoice.addEventListener('change', showFights)
  // The part in view: the last whose top has passed the top of the list, or the last of all at the very bottom. One
  // just jumped to stays marked until the list is scrolled by hand (it may sit too low to reach the top).
  let chosen = ''
  let marked = ''
  const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
  function mark(key) {
    if (key === marked) return
    marked = key
    for (const [one, { tab }] of parts) {
      if (one === key) tab.setAttribute('aria-current', 'location')
      else tab.removeAttribute('aria-current')
    }
    const tab = parts.get(key)?.tab
    if (tab && tabs.scrollWidth > tabs.clientWidth) tabs.scrollTo({ left: tab.offsetLeft - (tabs.clientWidth - tab.offsetWidth) / 2, behavior: smooth() })
  }
  function spy() {
    const list = shown()
    if (!list.length) return
    if (chosen && !parts.get(chosen).section.hidden) return mark(chosen)
    const line = main.scrollTop + 12
    let now = list[0].part.key
    for (const { part, section } of list) if (section.offsetTop <= line) now = part.key
    if (main.scrollTop > 0 && main.scrollTop + main.clientHeight >= main.scrollHeight - 4) now = list.at(-1).part.key
    mark(now)
  }
  function jump(key) {
    const { section, head } = parts.get(key)
    if (folded.has(key)) fold(key, false)
    chosen = key
    mark(key)
    main.scrollTo({ top: section.offsetTop - 4, behavior: smooth() })
    head.focus({ preventScroll: true })
  }
  let spying = 0
  main.addEventListener('scroll', () => { if (!spying) spying = requestAnimationFrame(() => { spying = 0; spy() }) }, { passive: true })
  for (const kind of ['wheel', 'touchstart', 'pointerdown', 'keydown']) main.addEventListener(kind, () => { chosen = '' }, { passive: true })
  const dialog = el('dialog', { class: 'dialog card-permissions game-rules', 'aria-label': t`游戏规则` }, [
    el('form', { method: 'dialog', class: 'cp-form gr-form' }, [
      el('div', { class: 'gr-top' }, [
        el('button', { class: 'btn small primary dialog-x', value: 'close', text: t`完成` }),
        el('h2', { text: t`「${card.name}」的游戏规则` }),
        el('p', { class: 'hint', text: t`打开后，成败、物品和数值由程序计算，模型只按结果写故事。只对这张卡生效，随时可以关掉，已有的对话不受影响。` }),
      ]),
      nav,
      main,
    ]),
  ])
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  showFights()
  // Opened again after a change to many settings at once: where it was.
  if (deps.scrollTop) main.scrollTop = deps.scrollTop
  spy()
}

// Which parts of the window are folded: this person's own, kept on this device (and nothing lost if it cannot be).
const FOLDED_KEY = 'game-rules-folded'
function readFolded() {
  try {
    const list = JSON.parse(localStorage.getItem(FOLDED_KEY) || '[]')
    return new Set(Array.isArray(list) ? list.filter(key => typeof key === 'string') : [])
  } catch {
    return new Set()
  }
}
function keepFolded(folded) {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]))
  } catch {}
}
