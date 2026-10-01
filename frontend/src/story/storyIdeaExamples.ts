const lastStoryIdeaExampleStorageKey = 'qingning-story-last-example'

export const storyIdeaExamples = [
  '青柠想去游乐园玩',
  '阿南想向朋友道歉',
  '周岚要提交报告',
  '小满想参加学校比赛',
  '林夏准备离开这座城市',
  '阿禾想归还捡到的东西',
  '陈默想去看一场演出',
  '小雨想学会骑自行车',
  '安安准备第一次上台唱歌',
  '叶子想把一封信寄出去',
  '小海要找回丢失的钥匙',
  '阿宁想给家人做顿饭',
  '林舟想参加一次长跑',
  '许诺要把画送给老师',
  '小北想学会游泳',
  '江河想修好爷爷的收音机',
  '琪琪想在班会上发言',
  '周野要拒绝一次邀请',
  '小禾想找一个安静的地方',
  '阿川想把秘密说出来',
  '小陶想把旧照片保存下来',
  '阿远想赢一场比赛',
  '叶青想把房间换个样子',
  '小树想和新同学说话',
  '陈安要完成第一次演讲',
  '小希想去看一场日出',
  '小璇想把借来的书还回去',
  '顾言想学会做一道菜',
] as const

export function getNextStoryIdeaExample(currentIdea?: string): string {
  const current = currentIdea?.trim()
  const lastExample = readLastStoryIdeaExample()
  const freshExamples = storyIdeaExamples.filter((example) => example !== current && example !== lastExample)
  const availableExamples = freshExamples.length
    ? freshExamples
    : storyIdeaExamples.filter((example) => example !== current)
  const example = availableExamples[Math.floor(Math.random() * availableExamples.length)] ?? storyIdeaExamples[0]

  writeLastStoryIdeaExample(example)
  return example
}

function readLastStoryIdeaExample(): string | undefined {
  if (typeof window === 'undefined') return undefined

  try {
    return window.sessionStorage.getItem(lastStoryIdeaExampleStorageKey) ?? undefined
  } catch {
    return undefined
  }
}

function writeLastStoryIdeaExample(example: string): void {
  if (typeof window === 'undefined') return

  try {
    window.sessionStorage.setItem(lastStoryIdeaExampleStorageKey, example)
  } catch {
    // A blocked storage area should not prevent a user from writing a story.
  }
}
