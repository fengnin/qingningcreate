import assert from 'node:assert/strict'
import test from 'node:test'
import { hasProposalProtocolLeak } from './storyProposalProse.js'

test('protocol leaks are rejected across narrative locations without banning author terminology', () => {
  for (const prose of ['父亲的罗盘（m0/m1隐含物）', '依据 m2 她还没出发', '结果见 sourceFacts', 'lastAuthorConfirmedResult 表明仍然发软']) {
    assert.equal(hasProposalProtocolLeak(prose, ['哥哥想送出旧船，妹妹想留下。']), true)
  }
  assert.equal(hasProposalProtocolLeak('她把模型 m2 放回盒中。', ['她有一台模型 m2。']), false)
  assert.equal(hasProposalProtocolLeak('她请哥哥一起驾驶旧船去救搁浅的小船。', []), false)
})
