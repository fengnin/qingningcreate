import { useRef, useState } from 'react'
import { StoryApiError } from './storyApi'
import type {
  GenerationStatus,
  StoryConflictCoreContextPrefill,
  StoryConflictCoreSystemDraft,
} from './types'

export interface StoryStageRequest {
  stageStatus: GenerationStatus
  stageError: string | undefined
  stageErrorCode: string | undefined
  stageErrorContextPrefill: StoryConflictCoreContextPrefill | undefined
  stageErrorSystemDraftPrefill: StoryConflictCoreSystemDraft | undefined
  clearStageFeedback: () => void
  runStageRequest: <Result>(
    request: () => Promise<Result>,
    applyResult: (result: Result) => void,
  ) => Promise<void>
}

interface StageErrorDetails {
  message: string
  code: string | undefined
  conflictCoreContextPrefill: StoryConflictCoreContextPrefill | undefined
  systemDraftPrefill: StoryConflictCoreSystemDraft | undefined
}

export function useStoryStageRequest(): StoryStageRequest {
  const [stageStatus, setStageStatus] = useState<GenerationStatus>('idle')
  // React state updates are asynchronous; a ref closes the same-tick gap in
  // which a double click could otherwise start two writes with one revision.
  const requestInFlightRef = useRef(false)
  const [stageError, setStageError] = useState<string>()
  const [stageErrorCode, setStageErrorCode] = useState<string>()
  const [stageErrorContextPrefill, setStageErrorContextPrefill] = useState<StoryConflictCoreContextPrefill>()
  const [stageErrorSystemDraftPrefill, setStageErrorSystemDraftPrefill] = useState<StoryConflictCoreSystemDraft>()

  const clearStageErrors = () => {
    setStageError(undefined)
    setStageErrorCode(undefined)
    setStageErrorContextPrefill(undefined)
    setStageErrorSystemDraftPrefill(undefined)
  }

  const clearStageFeedback = () => {
    setStageStatus('idle')
    clearStageErrors()
  }

  const runStageRequest = async <Result>(
    request: () => Promise<Result>,
    applyResult: (result: Result) => void,
  ) => {
    if (requestInFlightRef.current) return
    requestInFlightRef.current = true
    setStageStatus('loading')
    clearStageErrors()

    try {
      applyResult(await request())
      clearStageFeedback()
    } catch (error) {
      const details = getStageErrorDetails(error)
      setStageStatus('error')
      setStageError(details.message)
      setStageErrorCode(details.code)
      setStageErrorContextPrefill(details.conflictCoreContextPrefill)
      setStageErrorSystemDraftPrefill(details.systemDraftPrefill)
    } finally {
      requestInFlightRef.current = false
    }
  }

  return {
    stageStatus,
    stageError,
    stageErrorCode,
    stageErrorContextPrefill,
    stageErrorSystemDraftPrefill,
    clearStageFeedback,
    runStageRequest,
  }
}

function getStageErrorDetails(error: unknown): StageErrorDetails {
  if (error instanceof StoryApiError) {
    return {
      message: error.message,
      code: error.code,
      conflictCoreContextPrefill: error.conflictCoreContextPrefill,
      systemDraftPrefill: error.systemDraftPrefill,
    }
  }

  return {
    message: '生成没有完成，请稍后重试。',
    code: undefined,
    conflictCoreContextPrefill: undefined,
    systemDraftPrefill: undefined,
  }
}
