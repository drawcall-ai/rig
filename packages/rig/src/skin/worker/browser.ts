import type { Callbacks, Job, Reply, WorkerHandle } from '../worker.js'
import type { SkinSolution } from '../weights.js'
import type { Task } from '../wasm/run.js'

export const parallelism = () => navigator.hardwareConcurrency || 1

export function createWorker(callbacks: Callbacks<SkinSolution>): WorkerHandle<Job> {
  return connect(new Worker(new URL('./run.js', import.meta.url), { type: 'module' }), callbacks)
}

export function createBlurWorker(callbacks: Callbacks<number>): WorkerHandle<Task> {
  return connect(new Worker(new URL('./blur.js', import.meta.url), { type: 'module' }), callbacks)
}

function connect<T>(worker: Worker, callbacks: Callbacks<T>): Worker {
  worker.onmessage = (event: MessageEvent<Reply<T>>) => {
    if ('error' in event.data) callbacks.error(event.data.error)
    else callbacks.result(event.data.result)
  }
  worker.onerror = (event) => callbacks.error(new Error(event.message))
  worker.onmessageerror = () => callbacks.error(new Error('Could not deserialize rig worker result'))
  return worker
}
