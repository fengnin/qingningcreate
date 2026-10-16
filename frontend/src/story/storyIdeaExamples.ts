const lastStoryIdeaExampleStorageKey = 'qingning-story-last-example'

export const storyIdeaExamples = [
  '青柠想和朋友去游乐园玩，但朋友第一次去，害怕最刺激的项目。',
  '青柠想在家里给朋友准备一场寻宝生日惊喜。',
  '哥哥想和妹妹一起表演魔术，可妹妹一紧张就会说出机关。',
  '阿禾想悄悄离开演出后台，却不想被熟人拉住聊天。',
  '女儿想帮父亲搬家，两人却对要不要留下旧钢琴意见不同。',
  '两个室友想亲手给朋友做生日蛋糕，烤箱却在这时坏了。',
  '小雨想在爷爷搬走前，学会骑车陪他绕湖一圈。',
  '青柠要去接很久没见的朋友，出门前想了好多话。',
  '阿南想向朋友道歉，却发现朋友已经不再提那件事了。',
  '小提琴手想独自练完试音乐段，隔壁却总在同一个地方拉错。',
  '青柠想独自画完一幅画，不愿让朋友帮忙。',
  '叶子想把写了很久的信寄给一位已经不再联系的朋友。',
  '阿岚想修好爷爷的旧收音机，让他再听一次熟悉的节目。',
  '小璇想把借来的书还回去，却发现里面夹着一张写给自己的纸条。',
  '学徒想把借来的灯笼送还朋友，灯光却照出一串看不见主人的脚印。',
  '渡鸦信使想在月落前把信送过冰河，每用一根羽毛铺路，飞行就更困难。',
  '维修员想救出轨道站里被困的同伴，备用电池却只够开门或维持供暖。',
  '调查员想找回剧院失窃的道具，但几个熟悉的人都隐瞒了当晚的一件小事。',
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
