import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/components/PreparationExplanation.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react'] })
const componentModule = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), componentModule, componentModule.exports)
const { PreparationExplanation, explanationMatches, currentExplanationNeeds } = componentModule.exports
const wording = { action: '原行动', possibleResult: '原结果', futureChoice: '原取舍' }
const candidate = { id: 'c0', ...wording, materialIds: [], preconditionIds: [], resultBasisIds: [], unknownIds: [],
  causalBridge: { method: '原办法', change: '原变化', methodBasisIds: [], changeBasisIds: [] } }
const render = (current, explanation) => renderToStaticMarkup(React.createElement(PreparationExplanation, {
  candidate, wording: current, explanation, disabled: false, storyId: 's0', revision: 1, curveId: 'curve0', onChange() {},
}))

test('editing any card field marks its explanation stale while keeping old text inspectable and offering author control', () => {
  for (const field of Object.keys(wording)) {
    const edited = { ...wording, [field]: '新内容' }
    assert.equal(explanationMatches(wording, edited), false)
    const html = render(edited)
    for (const label of ['内容已修改，解释待核对', '原办法', '原变化', '我已核对，沿用解释', '编辑解释', '重新推演这张卡']) {
      assert.ok(html.includes(label), `${field}: missing ${label}`)
    }
  }
})

test('adopted author explanations and unresolved issues render with access to the prior explanation', () => {
  const explanation = { wording, method: '作者新办法', change: '作者新变化', issues: ['保留的疑问'], source: 'author' }
  const html = render(wording, explanation)
  for (const label of ['已由你采用', '作者新办法', '作者新变化', '保留的疑问', '查看此前解释', '原办法']) assert.ok(html.includes(label))
  assert.equal(explanationMatches({ ...wording, futureChoice: '' }, { action: wording.action, possibleResult: wording.possibleResult }), true)
  assert.equal(explanationMatches(wording, { ...wording, action: ` ${wording.action}` }), false)
})

test('writing notes display separately from issues and explanation edits remove stale anchors', () => {
  const expansionNeeds = [{ kind: 'action-detail', anchors: [{ field: 'method', quote: '人物具体行动' }] }]
  const explanation = { wording, method: '人物具体行动', change: '引出取舍', issues: [], source: 'system', expansionNeeds }
  const html = render(wording, explanation)
  assert.ok(html.includes('留到正文展开'))
  assert.ok(html.includes('关键行动'))
  assert.ok(!html.includes('待作者判断'))
  assert.deepEqual(currentExplanationNeeds(explanation), expansionNeeds)
  assert.deepEqual(currentExplanationNeeds({ ...explanation, method: '已经换办法' }), [])
})

test('important character, emotion and payoff effects display as writing notes rather than author problems', () => {
  for (const [kind, label] of [['character-detail', '人物变化'], ['emotional-beat', '情绪效果'], ['payoff', '反差与呼应']]) {
    const note = { kind, anchors: [{ field: 'action', quote: wording.action }] }
    const explanation = { wording, method: '已有办法', change: '已有变化', issues: [], source: 'system', expansionNeeds: [note] }
    const html = render(wording, explanation)
    assert.ok(html.includes(label))
    assert.ok(html.includes('普通细节在正文自然补足'))
    assert.ok(!html.includes('待作者判断'))
    assert.deepEqual(currentExplanationNeeds(explanation), [note])
    assert.deepEqual(currentExplanationNeeds({ ...explanation, wording: { ...wording, action: '改成新设计' } }), [])
  }
})
