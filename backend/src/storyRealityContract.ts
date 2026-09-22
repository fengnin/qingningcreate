import type { StorySeed } from '../../shared/story-contract.js'

/**
 * The baseline every story-generation stage shares. Stage-specific prompts add
 * their own checks, but cannot weaken these constraints.
 */
export const storyRealityContractInstruction = `共享事实与现实性合同：关键障碍、规则、时限、资源、权限，以及会决定目标是否可达的结果，只能来自用户或已确认事实、当前行动的直接正常结果，或针对该信息的正常询问、查询、观察。不能为了制造冲突凭空补出机构故障、例外规则、特殊权限、精确结果或新的硬限制。默认现实遵守普通常识和已知社会/机构规则；未知不代表存在例外。选项必须有可信的行动路径，或通过正常方式取得会改变下一步判断的信息；预期会被拒绝的不合理请求不是有效选择。`

/**
 * The stricter form used by model reviewers. It calls out the transition gap
 * where an option can otherwise turn a casual observation into a locked fact.
 */
export const storyRealityContractReviewInstruction = `按共享事实与现实性合同审查：关键内容若没有来源，或只靠“到了现场”“顺手看见”就新增一个会堵死已确认方案的规则、设备故障、时限、资源或权限限制，必须判不通过。只有行动直接造成的正常结果，或针对该信息进行正常询问、查询、检查后得到的答复，才能成为新的关键事实；普通画面细节不得在后续承担关键因果。合理询问可以失败，但不能预设例外，也不能把对不合理请求的预期拒绝包装成有效信息。`

export function formatStoryRealityContractContext(seed: Pick<StorySeed, 'worldMode'>): string {
  const worldRule = seed.worldMode === 'realistic-default'
    ? '遵守普通人的常识、常见社会规范及已知机构和交易规则；未知不是例外许可，不能假定存在特殊权限、反常交换方式或未说明的制度通道。'
    : '遵守用户已经明确给出的世界规则；未知信息不能被当作额外规则、特殊权限或例外的依据。'

  return `- 共享事实与现实性合同：${worldRule} 关键障碍、规则、时限、资源、权限及决定目标可达性的结果，必须有用户/已确认事实、行动直接正常结果，或正常查询、询问、检查所得答复作为来源；不能把对不合理请求的预期拒绝当作有信息价值的尝试。`
}
