/**
 * Node-only: solveSkinWeights with the blur passes (about 90% of the time)
 * split across worker threads over shared memory. Each pass reads only the
 * previous pass's buffer, so the result is bit-identical to the single-thread solve.
 */

import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { blurPass, finishSolve, prepareSolve, type SolveInput, type SolveResult } from './solve.js'

let pool: Worker[] = []

function workers(count: number): Worker[] {
  if (pool.length === count) return pool
  for (const worker of pool) void worker.terminate()
  pool = Array.from({ length: count }, () => {
    const worker = new Worker(workerEntry())
    worker.unref()
    return worker
  })
  return pool
}

/**
 * Published code runs as .js. The source (tests, tsx scripts) is .ts, which a worker can only load after
 * registering tsx, so it starts from a tiny ES module that does that first.
 */
function workerEntry(): URL {
  const worker = new URL(import.meta.url.endsWith('.ts') ? './blur-worker.ts' : './blur-worker.js', import.meta.url)
  if (worker.pathname.endsWith('.js')) return worker
  const code = `const { register } = await import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))})
register()
await import(${JSON.stringify(worker.href)})`
  return new URL(`data:text/javascript,${encodeURIComponent(code)}`)
}

function ask(worker: Worker, message: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const done = (value: number) => {
      worker.off('error', fail)
      resolve(value)
    }
    const fail = (error: Error) => {
      worker.off('message', done)
      reject(error)
    }
    worker.once('message', done)
    worker.once('error', fail)
    worker.postMessage(message)
  })
}

export async function solveParallel(input: SolveInput, threads = availableParallelism()): Promise<SolveResult> {
  const prepared = prepareSolve(input, (bytes) => new SharedArrayBuffer(bytes))
  const { grid, a, b } = prepared
  const numInside = grid.insideIndices.length
  // Small grids are faster on one thread than with message round trips
  const count = Math.max(1, Math.min(threads, Math.floor(numInside / 20000)))
  let iterations = 0
  if (count === 1) {
    for (let iter = 0; iter < input.blurIterations; iter++) {
      iterations = iter + 1
      const change = iter % 2 === 0 ? blurPass(grid, a, b, 0, numInside) : blurPass(grid, b, a, 0, numInside)
      if (change < 0.001 && iter > 10) break
    }
    return finishSolve(input, prepared, iterations % 2 === 0 ? a : b)
  }

  const team = workers(count)
  for (const worker of team) worker.ref()
  try {
    await Promise.all(team.map((worker) => ask(worker, { type: 'setup', grid, a, b })))
    const size = Math.ceil(numInside / count)
    for (let iter = 0; iter < input.blurIterations; iter++) {
      iterations = iter + 1
      const changes = await Promise.all(
        team.map((worker, i) =>
          ask(worker, { type: 'pass', fromA: iter % 2 === 0, start: i * size, end: Math.min(numInside, (i + 1) * size) }),
        ),
      )
      // Early convergence: stop if the max weight change is tiny
      if (Math.max(...changes) < 0.001 && iter > 10) break
    }
  } finally {
    for (const worker of team) worker.unref()
  }
  return finishSolve(input, prepared, iterations % 2 === 0 ? a : b)
}
