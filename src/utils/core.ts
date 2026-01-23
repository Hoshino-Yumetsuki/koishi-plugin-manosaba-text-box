import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Context, Logger } from 'koishi'
import type Config from '../config'
import type {
  CharacterInfo,
  WorkerLogMessage,
  WorkerRequestWithoutId,
  WorkerRequestType,
  WorkerResponse,
  WorkerResponseMap
} from '../types'

let workerPromise: Promise<Worker> | null = null
let activeLogger: Logger | null = null
let availableCharacters: CharacterInfo[] = []
let nextId = 1
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void
    reject: (err: Error) => void
  }
>()

function getWorkerLogger(ctx: Context): Logger {
  return ctx.logger('manosaba-text-box-worker')
}

function resolveWorkerPath(): { url: URL | string; type?: 'module' } {
  if (typeof __dirname !== 'undefined') {
    return {
      url: path.join(__dirname, 'core.worker.cjs')
    }
  }

  return {
    url: new URL('./core.worker.mjs', import.meta.url),
    type: 'module'
  }
}

function createWorker(): Worker {
  const workerPath = resolveWorkerPath()
  return new Worker(workerPath.url)
}

function handleWorkerMessage(message: WorkerResponse | WorkerLogMessage) {
  // Handle log messages from worker
  if (
    typeof message === 'object' &&
    message &&
    'type' in message &&
    message.type === 'log'
  ) {
    const logger = activeLogger
    if (!logger) {
      return
    }
    logger[message.level](message.message, message.meta)
    return
  }

  // Handle worker responses
  if (!message || typeof message !== 'object' || !('id' in message)) {
    return
  }

  const pendingRequest = pending.get(message.id)
  if (!pendingRequest) {
    return
  }
  pending.delete(message.id)

  if (message.ok) {
    pendingRequest.resolve(message.result)
    return
  }

  const err = new Error(message?.['error']?.['message'])
  err.stack = message?.['error']?.['stack']
  pendingRequest.reject(err)
}

async function ensureWorker(ctx: Context): Promise<Worker> {
  activeLogger = getWorkerLogger(ctx)

  if (workerPromise) {
    return workerPromise
  }

  workerPromise = new Promise((resolve, reject) => {
    try {
      const worker = createWorker()

      worker.on('message', handleWorkerMessage)
      worker.on('error', (err) => {
        activeLogger?.error('worker error', { err })
      })
      worker.on('exit', (code) => {
        if (code !== 0) {
          activeLogger?.error('worker exited unexpectedly', { code })
        }
        for (const { reject } of pending.values()) {
          reject(new Error('worker exited'))
        }
        pending.clear()
        workerPromise = null
      })

      resolve(worker)
    } catch (err) {
      workerPromise = null
      reject(err)
    }
  })

  return workerPromise
}

async function callWorker<T extends WorkerRequestType>(
  ctx: Context,
  request: WorkerRequestWithoutId<T>
): Promise<WorkerResponseMap[T]> {
  const worker = await ensureWorker(ctx)

  return new Promise<WorkerResponseMap[T]>((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    worker.postMessage({ ...request, id })
  })
}

/**
 * 获取所有可用的角色列表
 */
export function getAvailableCharacters(): CharacterInfo[] {
  return availableCharacters
}

export async function initAssets(ctx: Context, basePath: string) {
  const result = await callWorker<'initAssets'>(ctx, {
    type: 'initAssets',
    payload: { basePath }
  })

  availableCharacters = result.characters
}

/**
 * 生成完整的文本框图片
 */
export async function generateTextBoxImage(
  ctx: Context,
  character: string,
  text: string,
  _config: Config,
  backgroundIndex?: number,
  emotionIndex?: number
): Promise<Buffer> {
  const result = await callWorker<'generateTextBoxImage'>(ctx, {
    type: 'generateTextBoxImage',
    payload: {
      character,
      text,
      backgroundIndex,
      emotionIndex
    }
  })

  return Buffer.isBuffer(result) ? result : Buffer.from(result)
}
