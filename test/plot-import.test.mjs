// 导入 Twine / Ink 的结构 (plans/22 十三·2, web/shared/plot-import.js): passages and knots become scenes, their links the
// ways on, one with none an ending; what the start never reaches is left out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromInk, fromTwee, fromTwineHtml, plotFromFile } from '../web/shared/plot-import.js'
import { plotProblems } from '../web/shared/plot.js'

const TWEE = `:: StoryTitle
雨夜的邮局

:: StoryData
{ "ifid": "X", "start": "开门" }

:: 样式 [stylesheet]
body { color: red }

:: 开门 [start] {"position":"100,100"}
雨下了一整夜。<<set $love to 0>>她没有抬头。
[[走过去->柜台]]
[[离开]]

:: 柜台
她在整理信件。
[[问她->谈话]] [[谈话<-再等等]] [[帮忙|整理]]

:: 谈话
你们说上了话。

:: 整理
信很多。

:: 离开
你走进雨里。

:: 孤岛
没有人来这里。
`

test('Twee: passages in, links read in all their ways, specials and unreached ones out, no links an ending', () => {
  const plot = fromTwee(TWEE)
  assert.equal(plot.name, '雨夜的邮局')
  assert.equal(plot.source, 'imported')
  assert.deepEqual(plot.scenes.map(scene => scene.title), ['开门', '柜台', '离开', '谈话', '整理'])
  const [door, desk] = plot.scenes
  assert.equal(door.what, '雨下了一整夜。 她没有抬头。')
  assert.deepEqual(door.exits.map(exit => [exit.to, exit.when]), [['s2', '走过去'], ['s3', '']])
  assert.deepEqual(desk.exits.map(exit => [plot.scenes.find(scene => scene.id === exit.to).title, exit.hint]), [['谈话', '问她'], ['整理', '帮忙']])
  assert.ok(plot.scenes.slice(2).every(scene => scene.ending?.kind === 'normal'))
  assert.equal(plotProblems(plot).blocking.length, 0)
})

test('Twine 2 HTML: the passages and where it starts, entities read', () => {
  const html = `<tw-storydata name="雨夜" startnode="2" format="Harlowe"><style>x</style>
<tw-passagedata pid="1" name="尾声" tags="">完。</tw-passagedata>
<tw-passagedata pid="2" name="开头" tags="">&quot;你好&quot; [[去尾声-&gt;尾声]]</tw-passagedata>
</tw-storydata>`
  const plot = fromTwineHtml(html)
  assert.equal(plot.name, '雨夜')
  assert.deepEqual(plot.scenes.map(scene => scene.title), ['开头', '尾声'])
  assert.equal(plot.scenes[0].what, '"你好"')
  assert.equal(plot.scenes[0].exits[0].when, '去尾声')
})

test('Ink: knots and stitches, choices and diverts the ways on, END an ending', () => {
  const ink = `VAR love = 0
雨下了一整夜。
-> post_office

=== post_office ===
邮局里只有她。
* [走过去] -> desk
+ 离开 -> leave
= desk
她抬起头。{love > 0: 她笑了。}
-> talk

=== talk ===
你们说上了话。
-> END

=== leave ===
// 一条注释
你走进雨里。
-> DONE
`
  const plot = fromInk(ink)
  assert.deepEqual(plot.scenes.map(scene => scene.title), ['开始', 'post_office', 'post_office.desk', 'leave', 'talk'])
  const office = plot.scenes[1]
  assert.deepEqual(office.exits.map(exit => [plot.scenes.find(scene => scene.id === exit.to).title, exit.when]), [['post_office.desk', '走过去'], ['leave', '离开']])
  assert.equal(plot.scenes[2].what, '她抬起头。')
  assert.ok(plot.scenes.find(scene => scene.title === 'talk').ending)
  assert.ok(!plot.scenes.find(scene => scene.title === 'leave').what.includes('注释'))
  assert.equal(plotProblems(plot).blocking.length, 0)
})

test('a file is read by its name and what is in it; one that is none of these is null', () => {
  assert.equal(plotFromFile('a.twee', TWEE).scenes.length, 5)
  assert.equal(plotFromFile('story.txt', TWEE).scenes.length, 5)
  assert.equal(plotFromFile('x.ink', '=== a ===\n你好\n-> END').scenes.length, 1)
  assert.equal(plotFromFile('notes.txt', '随便写写'), null)
  assert.equal(fromTwee(''), null)
})

test('no more than the plot holds: 60 scenes, 4 ways on each', () => {
  const many = Array.from({ length: 70 }, (_, i) => `:: p${i}\n${Array.from({ length: 6 }, (_, j) => `[[p${i * 6 + j + 1}]]`).join(' ')}`).join('\n')
  const plot = fromTwee(many)
  assert.equal(plot.scenes.length, 60)
  assert.ok(plot.scenes.every(scene => scene.exits.length <= 4))
})
