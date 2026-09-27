const lastStoryIdeaExampleStorageKey = 'qingning-story-last-example'

export const storyIdeaExamples = [
  '毕业前最后一晚，林夏在社团仓库整理器材时发现一台借来的相机。相机必须在明早归还，里面存着她和已经断联的朋友拍下的一段视频。她答应过不再打扰对方，却想在离校前决定，要不要把视频发给她。',
  '演出前夜，许棠在借来的录音笔里找到和断联搭档录的歌。录音笔必须在明早归还，她答应不再联系，却想在开演前决定要不要把歌发给他。',
  '搬家前夜，顾言在借来的旧书里发现断联朋友留下的便笺。旧书必须在明早归还，他答应不再联系，却想在搬家前决定要不要把便笺寄给她。',
  '毕业展布置前，沈乔在借来的投影仪里看到和前队友剪的短片。投影仪今晚要归还，她答应不再改动作品，却想在展出前决定要不要删掉自己的名字。',
  '比赛提交前，程遥在借来的相机里发现同伴拍下的一张照片。相机明早要归还，她答应不替对方做决定，却想在截止前决定要不要用它参赛。',
  '火车开走前，闻溪在借来的行李箱夹层里找到断联姐姐留下的钥匙。行李箱今晚要归还，她答应不再追问，却想在上车前决定要不要带走它。',
  '外婆出院前，黎安在借来的相册里找到母亲年轻时的一张照片。相册明早要还回去，母亲说暂时别提往事，她却想在探望前决定要不要带上它。',
  '开店前夜，苏禾在借来的收银本里发现前合伙人留下的账页。收银本明早要归还，她答应不再替对方收尾，却想在开门前决定要不要核对它。',
  '雨停前，江禾在借来的雨伞夹层里发现同学写给别人的信。雨伞今晚要归还，她答应只负责归还，却想在对方来取前决定要不要提醒他。',
  '婚礼彩排前，安澜在借来的礼服口袋里找到断联朋友的耳环。礼服明早要还，她答应不再联系，却想在仪式前决定要不要送回去。',
  '录取通知寄出前，林舟在借来的电脑里看到和父亲共同写的申请信。电脑今晚要还，他答应不擅自改动，却想在截止前决定要不要删掉一段话。',
  '停电前，白栀在借来的手电筒里找到邻居托她保管的门卡。手电筒今晚要还，她答应不替对方开门，却想在天黑前决定要不要送过去。',
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

export function getInitialStoryIdeaExample(): string {
  const lastExample = readLastStoryIdeaExample()
  const availableExamples = storyIdeaExamples.filter((example) => example !== lastExample)

  return availableExamples[Math.floor(Math.random() * availableExamples.length)] ?? storyIdeaExamples[0]
}

export function rememberStoryIdeaExample(example: string): void {
  writeLastStoryIdeaExample(example)
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
