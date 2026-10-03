export const STORY_DESIGN_SECTION_RULES = Object.freeze([
  Object.freeze({ key: 'conflictCoreBeatIds', label: '冲突核心', minimum: 2 }),
  Object.freeze({ key: 'predicamentBeatIds', label: '具体困境', minimum: 2 }),
  Object.freeze({ key: 'storyEndBeatIds', label: '故事两端', minimum: 3 }),
  Object.freeze({ key: 'middleDevelopmentBeatIds', label: '中间发展', minimum: 2 }),
])

export function getMissingStoryDesignSectionLabels(design, activeBeatIds) {
  if (!design) return STORY_DESIGN_SECTION_RULES.map(({ label }) => label)

  return STORY_DESIGN_SECTION_RULES
    .filter(({ key, minimum }) => {
      const beatIds = Array.isArray(design[key]) ? design[key] : []
      return beatIds.filter((beatId) => activeBeatIds.has(beatId)).length < minimum
    })
    .map(({ label }) => label)
}
