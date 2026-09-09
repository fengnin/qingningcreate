import { useState } from 'react'
import { StoryApiError } from './storyApi'
import type { GenerationStatus } from './types'

export interface StoryStageRequest {
  stageStatus: GenerationStatus
  stageError: string | undefined
  clearStageFeedback: () => void
  runStageRequest: <Result>(
    request: () => Promise<Result>,
    applyResult: (result: Result) => void,
  ) => Promise<void>
}

export function useStoryStageRequest(): StoryStageRequest {
  const [stageStatus, setStageStatus] = useState<GenerationStatus>('idle')
  const [stageError, setStageError] = useState<string>()

  const clearStageFeedback = () => {
    setStageStatus('idle')
    setStageError(undefined)
  }

  const runStageRequest = async <Result>(
    request: () => Promise<Result>,
    applyResult: (result: Result) => void,
  ) => {
    setStageStatus('loading')
    setStageError(undefined)

    try {
      applyResult(await request())
      clearStageFeedback()
    } catch (error) {
      setStageStatus('error')
      setStageError(getStageErrorMessage(error))
    }
  }

  return { stageStatus, stageError, clearStageFeedback, runStageRequest }
}

function getStageErrorMessage(error: unknown): string {
  return error instanceof StoryApiError ? error.message : '生成没有完成，请稍后重试。'
}
