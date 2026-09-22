import type {
  StoryApproachCostType,
  StoryApproachRequirementKind,
  StoryFact,
  StoryFactReference,
  StoryFactKind,
  StoryPredicamentApproach,
} from './story-contract.js'

export type PredicamentFactEvidence = Pick<StoryFact, 'statement' | 'mutability' | 'kind'>

export type PredicamentApproachEvidence = Pick<
  StoryPredicamentApproach,
  'cost' | 'costType' | 'requirements' | 'costBasis'
>

export const PREDICAMENT_CONTRACT_LIMITS: Readonly<{
  minimumCandidateCount: number
  maximumCandidateCount: number
  minimumFactCount: number
  maximumFactCount: number
  maximumFactReferences: number
  maximumFactExcerptLength: number
}>

export function isStoryFactKind(value: unknown): value is StoryFactKind

export function isStoryApproachRequirementKind(value: unknown): value is StoryApproachRequirementKind

export function isStoryApproachCostType(value: unknown): value is StoryApproachCostType

export function inferApproachCostType(
  cost: string,
  costBasis: StoryFactReference[],
  factsById: ReadonlyMap<string, PredicamentFactEvidence>,
): StoryApproachCostType

export function hasGroundedPredicamentAnchors(
  factsById: ReadonlyMap<string, PredicamentFactEvidence>,
  obstacleFactId: string,
  urgencyFactId: string,
): boolean

export function hasGroundedPredicamentApproach(
  approach: PredicamentApproachEvidence,
  factsById: ReadonlyMap<string, PredicamentFactEvidence>,
  obstacleFactId: string,
): boolean
