export interface CharacterInfo {
  id: string
  name: string
}

export type WorkerRequestMap = {
  initAssets: {
    basePath: string
  }
  getAvailableCharacters: undefined
  generateTextBoxImage: {
    character: string
    text: string
    backgroundIndex?: number
    emotionIndex?: number
  }
}

export type WorkerResponseMap = {
  initAssets: {
    characters: CharacterInfo[]
  }
  getAvailableCharacters: CharacterInfo[]
  generateTextBoxImage: Buffer | Uint8Array
}

export type WorkerRequestType = keyof WorkerRequestMap

export type WorkerRequest<T extends WorkerRequestType = WorkerRequestType> = {
  [K in WorkerRequestType]: {
    id: number
    type: K
  } & (WorkerRequestMap[K] extends undefined
    ? Record<string, never>
    : {
        payload: WorkerRequestMap[K]
      })
}[T]

export type WorkerRequestWithoutId<
  T extends WorkerRequestType = WorkerRequestType
> = Omit<WorkerRequest<T>, 'id'>

export type WorkerResponse<T extends WorkerRequestType = WorkerRequestType> = {
  [K in WorkerRequestType]:
    | {
        id: number
        ok: true
        result: WorkerResponseMap[K]
      }
    | {
        id: number
        ok: false
        error: {
          message: string
          stack?: string
        }
      }
}[T]

export type WorkerLogMessage = {
  type: 'log'
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}
