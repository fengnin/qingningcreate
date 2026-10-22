import assert from 'node:assert/strict'
import test from 'node:test'
import { repeatsStoryBeatText } from './storyBeatText.js'

test('presentation prefixes, punctuation and whitespace cannot disguise a duplicated beat', () => {
  const opening = '青柠和朋友刚进游乐园大门，朋友望见云霄飞车就攥紧她的手腕。'
  for (const prefix of ['', '提案：', ' 暂定: ', '提案：暂定：']) {
    assert.equal(repeatsStoryBeatText(`${prefix}${opening.replace('，', '，\n')}`, [opening]), true)
  }
  assert.equal(repeatsStoryBeatText('青柠和朋友商量后改走旋转木马的路线。', [opening]), false)
  assert.equal(repeatsStoryBeatText(`${opening}青柠于是先带朋友去休息。`, [opening]), false,
    'shared context with additional development is not an identical beat')
})
