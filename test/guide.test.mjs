// 剧情向导 (plans/21): the 剧情方案 a guide writes read back, the <剧情向导> block a taken plan sends, and the player's
// actions on it (server/guide-text.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changeGuide, cleanPlan, guidanceText, guideBlock, guideOn, guideView, MAX_PLANS, planOf, STRENGTHS, strengthOf, talkLines, withStrength } from '../server/guide-text.mjs'

test('plans: one block each, read with their parts; the reply keeps the rest', () => {
  const reply = `林雪还在气你没来。可以这样：

<剧情方案>
目标：让林雪主动提起看海之约
起头：她翻出那张旧车票；广播里放起那首歌
注意：别一轮演完；不要让她直接说「我在等你」
</剧情方案>

<剧情方案>
目标：雨夜里两人被困邮局
起头：
- 邮局的门锁坏了
- 停电
</剧情方案>

挑一个吧。`
  const { text, plans } = planOf(reply)
  assert.equal(text, '林雪还在气你没来。可以这样：\n\n挑一个吧。')
  assert.deepEqual(plans, [
    { goal: '让林雪主动提起看海之约', start: ['她翻出那张旧车票', '广播里放起那首歌'], notes: ['别一轮演完', '不要让她直接说「我在等你」'] },
    { goal: '雨夜里两人被困邮局', start: ['邮局的门锁坏了', '停电'], notes: [] },
  ])
})

test('plans: full-width brackets, a missing closing tag, bold names, a first line without a name, too many', () => {
  const loose = planOf('＜剧情方案＞\n**目标:** 找到失踪的猫\n**要注意：** 别让警察出场\n＜/剧情方案＞\n<剧情方案>\n她决定离开小镇\n起头：收拾行李')
  assert.deepEqual(loose.plans, [
    { goal: '找到失踪的猫', start: [], notes: ['别让警察出场'] },
    { goal: '她决定离开小镇', start: ['收拾行李'], notes: [] },
  ])
  assert.equal(loose.text, '')
  const many = planOf(Array.from({ length: 5 }, (_, i) => `<剧情方案>\n目标：第${i}个\n</剧情方案>`).join('\n'))
  assert.equal(many.plans.length, MAX_PLANS)
  assert.deepEqual(planOf('没有方案的回答').plans, [])
  assert.deepEqual(planOf('<剧情方案>\n起头：只有起头\n</剧情方案>').plans, [], 'a plan with no goal is dropped')
})

test('a plan is cut to size and needs a goal', () => {
  assert.equal(cleanPlan({ goal: '  ' }), null)
  const long = cleanPlan({ goal: '长'.repeat(500), start: Array(9).fill('一步'), notes: ['', '  注意  '] })
  assert.equal(long.goal.length, 160)
  assert.equal(long.start.length, 4)
  assert.deepEqual(long.notes, ['注意'])
})

test('the guidance differs between strengths only in its 节奏 line; written over, the line is still swapped', () => {
  const plan = { goal: '让林雪主动提起看海之约', start: ['旧车票'], notes: ['别一轮演完'] }
  const lines = strength => guidanceText(plan, strength).split('\n')
  const [hint, steady] = [lines('hint'), lines('steady')]
  assert.equal(hint.length, steady.length)
  assert.deepEqual(hint.filter((line, i) => line !== steady[i]), [STRENGTHS.hint])
  assert.equal(strengthOf(guidanceText(plan, 'soon')), 'soon')
  const edited = `${guidanceText(plan, 'hint').replace('旧车票', '一张明信片')}`
  assert.equal(strengthOf(withStrength(edited, 'soon')), 'soon')
  assert.match(withStrength(edited, 'soon'), /一张明信片/)
  assert.equal(withStrength('只写了目标', 'hint'), `只写了目标\n${STRENGTHS.hint}`)
})

const path = ids => ids.map((id, i) => ({ id, role: i % 2 ? 'user' : 'assistant' }))

test('the block: on the branch it was taken on, counting its turns; none on a branch from before it or with no plan', () => {
  const guide = changeGuide(null, { action: 'adopt', plan: { goal: '去看海' }, strength: 'hint' }, { anchor: 'u2', sinceTurn: 2 })
  const here = path(['root', 'u1', 'a1', 'u2', 'a2'])
  assert.deepEqual(guideOn(guide.active, here), { turn: 1 })
  assert.deepEqual(guideOn(guide.active, path(['root', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3'])), { turn: 2 })
  const block = guideBlock(guide.active, here)
  assert.match(block, /^<剧情向导>\n目标：去看海\n节奏：只铺垫/)
  assert.match(block, /这是这个方向的第 1 轮。/)
  assert.match(block, /玩家的行动永远优先/)
  assert.match(block, /\n<\/剧情向导>$/)
  assert.equal(guideBlock(guide.active, path(['root', 'u1', 'a1'])), '', 'a branch from before the plan was taken')
  assert.equal(guideBlock(null, here), '')
  assert.equal(guideView(guide, path(['root', 'u1', 'a1'])).on, false)
  assert.equal(guideView(guide, here).turns, 0)
  assert.equal(guideView(guide, path(['root', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3'])).turns, 1)
})

test('actions: adopt replaces (the old one counted as stopped), strength, edit and back, done and stop', () => {
  let guide = changeGuide(undefined, { action: 'adopt', plan: { goal: '一' } }, { at: 't1' })
  assert.equal(guide.active.strength, 'steady')
  guide = changeGuide(guide, { action: 'adopt', plan: { goal: '二' }, strength: 'soon' }, { at: 't2' })
  assert.deepEqual(guide.done, [{ goal: '一', how: 'stop', at: 't2' }])
  const before = guide
  guide = changeGuide(guide, { action: 'strength', strength: 'hint' })
  assert.equal(before.active.strength, 'soon', 'the guide given is left as it was')
  assert.equal(guide.active.strength, 'hint')
  guide = changeGuide(guide, { action: 'edit', text: `${guidanceText(guide.active.plan, 'hint')}\n多写雨声` })
  assert.match(guide.active.edited, /多写雨声/)
  guide = changeGuide(guide, { action: 'strength', strength: 'soon' })
  assert.equal(strengthOf(guide.active.edited), 'soon')
  assert.equal(guideView(guide, path(['root'])).strength, 'soon')
  guide = changeGuide(guide, { action: 'edit', text: '' })
  assert.equal(guide.active.edited, undefined)
  guide = changeGuide(guide, { action: 'done' }, { at: 't3' })
  assert.equal(guide.active, undefined)
  assert.deepEqual(guide.done.at(-1), { goal: '二', how: 'done', at: 't3' })
  assert.throws(() => changeGuide(guide, { action: 'stop' }), /现在没有在引导/)
  assert.throws(() => changeGuide(guide, { action: 'adopt', plan: { goal: '' } }), /没有目标/)
})

test('the talk so far, as the in-story request reads it', () => {
  const lines = talkLines([
    { note: '开始引导：去看海' },
    { user: { text: '她为什么生气？' }, assistant: { text: '因为你没来。', plans: [{ goal: '道歉' }] } },
  ])
  assert.equal(lines, '（开始引导：去看海）\n\n玩家：她为什么生气？\n\n向导：因为你没来。\n（提了 1 个方案：道歉）')
})
