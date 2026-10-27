import type { Callbacks, Job, WorkerHandle } from '../worker.js'
import type { SkinSolution } from '../weights.js'

export function createWorker(callbacks: Callbacks): WorkerHandle {
  const worker = new Worker(new URL('./run.js', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<SkinSolution>) => callbacks.result(event.data)
  worker.onerror = (event) => callbacks.error(new Error(event.message))
  worker.onmessageerror = () => callbacks.error(new Error('Could not deserialize rig worker result'))
  return worker
}

export function listen(compute: (job: Job) => SkinSolution): void {
  globalThis.addEventListener('message', (event: MessageEvent<Job>) => {
    const result = compute(event.data)
    globalThis.postMessage(result, { transfer: [result.skinIndices.buffer, result.skinWeights.buffer] })
  })
}
