import { AppError, requestQwenJson } from './qwen.js'
import { preparationExplanationContext, preparationMaterialAuthorityGuidance } from './storyPreparationContext.js'
import { preparationOutputSchemas } from './storyOutputSchemas.js'
import type { ProvisionalCurve } from '../../shared/story-contract.js'
import type { StoryPreparation, StoryPreparationStoryDirection } from '../../shared/story-preparation.js'

export const storyDirectionSelectionGuidance = 'futureDesign.selectedStoryDirection 是作者明确选定的本版关键走向。必须承接它，不得自行改成另一条分支。它是未来创作安排，不是已发生事实，也不自动锁死成败或远期结局；在此方向内补充必要过程。后续明确的作者编辑和指令优先于旧方向。'

export async function suggestPreparationStoryDirections(curve: ProvisionalCurve, preparation: StoryPreparation): Promise<{ directions: StoryPreparationStoryDirection[] }> {
  const candidate = preparation.candidates.find(c => preparation.acceptedCandidateIds.includes(c.id))!
  const context = { ...preparationExplanationContext(preparation, candidate), brief: curve.brief }
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await requestQwenJson({
        systemPrompt: '将作者选中的困境整理为待作者选择的故事走向，不生成完整骨架。严格输出 JSON {directions:[{id,title,choice,consequence}]}，1至2项，id为path-1、path-2，title最多24字，choice和consequence各最多120字。读最新action、futureChoice、possibleResult和采用的解释，围绕最影响故事意义的同一个关键取舍整理分支；choice写人物会倾向怎么选，consequence写可能承担的代价或变化，不保证成功失败，不提前设计全篇结局，不把普通手段细节列成关键方向。卡片已有两条分支时忠实整理，不擅自新增第三种方案。作者已明确选择时只返回该方向，不能为了凑两项重新开放已定选择。保留已有行动与后续关键取舍的因果，不把“眼前的选择”和“故事将推向”混成不相干的选项。不得改变作者已定条件或决定明确保留的未知。不给新人物起具体名字。所有选项尚未采用，不得默认替作者选择。\n' + preparationMaterialAuthorityGuidance,
        userPrompt: JSON.stringify({ ...context, ...(failure ? { repair: '上次格式不合法，请返回完整且简洁的走向选项。' } : {}) }),
        temperature: 0.2, maxTokens: 1000, diagnosticStage: 'preparation-story-directions',
        outputSchema: preparationOutputSchemas.storyDirections,
      }) as { directions?: StoryPreparationStoryDirection[] }
      if (!Array.isArray(raw?.directions) || !raw.directions.length || raw.directions.length > 2) throw new Error('directions')
      const directions = raw.directions.map((d, i) => {
        if (!d || d.id !== `path-${i + 1}` || ![d.title, d.choice, d.consequence].every(v => typeof v === 'string' && v.trim())
          || d.title.length > 24 || d.choice.length > 120 || d.consequence.length > 120) throw new Error('direction')
        return { id: d.id, title: d.title.trim(), choice: d.choice.trim(), consequence: d.consequence.trim() }
      })
      if (new Set(directions.map(d => d.choice)).size !== directions.length) throw new Error('duplicate')
      return { directions }
    } catch (error) {
      if (error instanceof AppError && !['QWEN_OUTPUT_SCHEMA_FAILED'].includes(error.code)) throw error
      failure = error
    }
  }
  throw new AppError('这次未能整理出故事走向，请再试一次；卡片和编辑仍保留。', 502, 'STORY_PREPARATION_INVALID_OUTPUT')
}
