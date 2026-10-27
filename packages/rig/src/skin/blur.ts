import { createBlurWorker, parallelism } from '#worker'
import type { PreparedSolve, WeightBuffers } from './solve.js'
import type { WorkerHandle } from './worker.js'
import { prepare } from './wasm/prepare.js'
import { run, type Task } from './wasm/run.js'

export async function blur(prepared: PreparedSolve, cap: number): Promise<WeightBuffers> {
  if (cap === 0 || prepared.grid.insideIndices.length === 0) return prepared.initial
  // Small volumes cannot amortize worker startup. Bound the team to avoid oversubscription.
  const count = typeof SharedArrayBuffer === 'undefined' ? 1
    : Math.min(4, parallelism(), Math.max(1, Math.ceil(prepared.grid.insideIndices.length / 16384)))
  const work = await prepare(prepared, count, cap)
  if (count === 1) return work.result(await run(work.tasks[0]))

  const workers: WorkerHandle<Task>[] = []
  try {
    const iterations = await Promise.all(work.tasks.map((task) => new Promise<number>((resolve, reject) => {
      const worker = createBlurWorker({ result: resolve, error: reject })
      workers.push(worker)
      worker.postMessage(task, [])
    })))
    if (iterations.some((value) => value !== iterations[0])) throw new Error('WASM workers diverged')
    return work.result(iterations[0])
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
}
