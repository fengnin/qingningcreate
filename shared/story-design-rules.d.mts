import type { StoryDesignRecord } from './story-contract.js'

export type StoryDesignSectionLabel = '冲突核心' | '具体困境' | '故事两端' | '中间发展'

export type StoryDesignSectionRule = Readonly<{
  key: keyof Pick<
    StoryDesignRecord,
    'conflictCoreBeatIds' | 'predicamentBeatIds' | 'storyEndBeatIds' | 'middleDevelopmentBeatIds'
  >
  label: StoryDesignSectionLabel
  minimum: number
}>

export const STORY_DESIGN_SECTION_RULES: readonly StoryDesignSectionRule[]

export function getMissingStoryDesignSectionLabels(
  design: Pick<StoryDesignRecord, 'conflictCoreBeatIds' | 'predicamentBeatIds' | 'storyEndBeatIds' | 'middleDevelopmentBeatIds'> | undefined,
  activeBeatIds: ReadonlySet<string>,
): StoryDesignSectionLabel[]
