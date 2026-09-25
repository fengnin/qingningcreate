import { useState } from 'react'
import { StoryApiError } from './storyApi'
import type { GenerationStatus, StoryConflictCoreContextPrefill } from './types'

export interface StoryStageRequest {
  stageStatus: GenerationStatus
  stageError: string | undefined
  stageErrorCode: string | undefined
  stageErrorContextPrefill: StoryConflictCoreContextPrefill | undefined
  clearStageFeedback: () => void
  runStageRequest: <Result>(
    request: () => Promise<Result>,
    applyResult: (result: Result) => void,
  ) => Promise<void>
}

export function useStoryStageRequest(): StoryStageRequest {
  const [stageStatus, setStageStatus] = useState<GenerationStatus>('idle')
  const [stageError, setStageError] = useState<string>()
  const [stageErrorCode, setStageErrorCode] = useState<string>()
  const [stageErrorContextPrefill, setStageErrorContextPrefill] = useState<StoryConflictCoreContextPrefill>()

  const clearStageFeedback = () => {
    setStageStatus('idle')
    setStageError(undefined)
    setStageErrorCode(undefined)
    setStageErrorContextPrefill(undefined)
  }

  const runStageRequest = async <Result>(
    request: () => Promise<Result>,
    applyResult: (result: Result) => void,
  ) => {
    setStageStatus('loading')
    setStageError(undefined)
    setStageErrorCode(undefined)
    setStageErrorContextPrefill(undefined)

    try {
      applyResult(await request())
      clearStageFeedback()
    } catch (error) {
      setStageStatus('error')
      setStageError(getStageErrorMessage(error))
      setStageErrorCode(getStageErrorCode(error))
      setStageErrorContextPrefill(getStageErrorContextPrefill(error))
    }
  }

  return {
    stageStatus,
    stageError,
    stageErrorCode,
    stageErrorContextPrefill,
    clearStageFeedback,
    runStageRequest,
  }
}

function getStageErrorMessage(error: unknown): string {
  return error instanceof StoryApiError ? error.message : '生成没有完成，请稍后重试。'
}

function getStageErrorCode(error: unknown): string | undefined {
  return error instanceof StoryApiError ? error.code : undefined
}

function getStageErrorContextPrefill(error: unknown): StoryConflictCoreContextPrefill | undefined {
  return error instanceof StoryApiError ? error.conflictCoreContextPrefill : undefined
}
