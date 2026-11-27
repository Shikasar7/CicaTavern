// 战斗立绘（卡的 CG 里「战败·名字」「胜利·名字」两种组）：战斗结束时挑哪几组放，以及它们不列给模型。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cgList, fightCgsFor, fightGroupKind } from '../web/shared/vn.js'
import { cgFormat } from '../server/prompt.mjs'

const pic = [{ file: 'a.webp' }]
const groups = [
  { name: '战败·维拉', pictures: pic },
  { name: '胜利·维拉', pictures: pic },
  { name: '胜利·赤练', aliases: ['蛇姬'], pictures: pic },
  { name: '战败·阿檀', pictures: pic },
  { name: '战败·空的', pictures: [] },
  { name: '维拉·初见', note: '第一次见面', pictures: pic },
]
const names = list => list.map(group => group.name)

test('won: those knocked down get their 战败 group, numbered foes too', () => {
  assert.deepEqual(names(fightCgsFor(groups, { down: ['白羽隼', '维拉甲'] })), ['战败·维拉'])
  assert.deepEqual(names(fightCgsFor(groups, { down: ['维拉 2'] })), ['战败·维拉'])
})

test('lost: foes still standing get their 胜利 group, by alias as well', () => {
  assert.deepEqual(names(fightCgsFor(groups, { standing: ['蛇姬', '赤鳞巨蟒'] })), ['胜利·赤练'])
})

test('a companion knocked down gets hers; each group once; an empty group never', () => {
  assert.deepEqual(names(fightCgsFor(groups, { down: ['阿檀', '阿檀', '空的'], standing: ['维拉'] })), ['战败·阿檀', '胜利·维拉'])
})

test('an ordinary group is not a fight group and is never picked for a fight', () => {
  assert.equal(fightGroupKind(groups[5]), '')
  assert.equal(fightGroupKind(groups[0]), 'down')
  assert.equal(fightGroupKind(groups[2]), 'up')
  assert.deepEqual(fightCgsFor(groups, { down: ['维拉·初见'] }), [])
})

test('the model is offered the story groups only', () => {
  assert.deepEqual(cgList(groups), ['维拉·初见（第一次见面）'])
  assert.match(cgFormat(cgList(groups)), /<CG>[\s\S]*维拉·初见[\s\S]*<\/CG>/)
  assert.doesNotMatch(cgFormat(cgList(groups)), /战败|胜利/)
})
