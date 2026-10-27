import { Worker, parentPort } from 'node:worker_threads'
import type { Callbacks, Job, WorkerHandle } from '../worker.js'
import type { SkinSolution } from '../weights.js'

export function createWorker(callbacks: Callbacks): WorkerHandle {
  const worker = new Worker(new URL('./run.js', import.meta.url))
  const exit = (code: number) => fail(new Error(`Rig worker exited before completing (code ${code})`))
  const fail = (error: Error) => {
    worker.off('exit', exit)
    callbacks.error(error)
  }
  worker.once('message', (result: SkinSolution) => {
    worker.off('exit', exit)
    callbacks.result(result)
  })
  worker.once('error', fail)
  worker.once('messageerror', fail)
  worker.once('exit', exit)
  return worker
}

export function listen(compute: (job: Job) => SkinSolution): void {
  const port = parentPort
  if (!port) throw new Error('Rig worker requires a parent port')
  port.on('message', (job: Job) => {
    const result = compute(job)
    port.postMessage(result, [result.skinIndices.buffer, result.skinWeights.buffer])
  })
}
