import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import type { Callbacks, Job, Reply, WorkerHandle } from '../worker.js'
import type { SkinSolution } from '../weights.js'
import type { Task } from '../wasm/run.js'

export const parallelism = availableParallelism

export function createWorker(callbacks: Callbacks<SkinSolution>): WorkerHandle<Job> {
  return connect(new Worker(new URL('./run.js', import.meta.url)), callbacks)
}

export function createBlurWorker(callbacks: Callbacks<number>): WorkerHandle<Task> {
  return connect(new Worker(new URL('./blur.js', import.meta.url)), callbacks)
}

function connect<T>(worker: Worker, callbacks: Callbacks<T>): Worker {
  const exit = (code: number) => fail(new Error(`Rig worker exited before completing (code ${code})`))
  const fail = (error: Error) => {
    worker.off('exit', exit)
    callbacks.error(error)
  }
  worker.once('message', (reply: Reply<T>) => {
    worker.off('exit', exit)
    if ('error' in reply) callbacks.error(reply.error)
    else callbacks.result(reply.result)
  })
  worker.once('error', fail)
  worker.once('messageerror', fail)
  worker.once('exit', exit)
  return worker
}
