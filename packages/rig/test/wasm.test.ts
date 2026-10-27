import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { availableParallelism } from 'node:os'
import { Worker, type TransferListItem } from 'node:worker_threads'
import { blur } from '../src/skin/blur.js'
import type { PreparedSolve, WeightBuffers } from '../src/skin/solve.js'
import type { WorkerHandle } from '../src/skin/worker.js'
import { prepare } from '../src/skin/wasm/prepare.js'
import { run, type Task } from '../src/skin/wasm/run.js'
import { createBlurWorker } from '../dist/skin/worker/node.js'

function fixture(dimensions: [number, number, number] = [5, 4, 3]): PreparedSolve {
  const cells = dimensions[0] * dimensions[1] * dimensions[2]
  const isInsideFlat = Uint8Array.from({ length: cells }, (_, i) => Number(i % 7 !== 0))
  const insideIndices = Uint32Array.from(Array.from(isInsideFlat).flatMap((value, i) => value ? [i] : []))
  const flatToLocal = new Uint32Array(cells)
  insideIndices.forEach((flat, local) => { flatToLocal[flat] = local })
  const buffers = (): WeightBuffers => ({
    bones: new Uint8Array(insideIndices.length * 4),
    weights: new Float32Array(insideIndices.length * 4),
    count: new Uint8Array(insideIndices.length),
  })
  const a = buffers(), b = buffers()
  for (let local = 0; local < insideIndices.length; local++) {
    const count = local % 4 + 1
    a.count[local] = count
    for (let slot = 0; slot < count; slot++) {
      a.bones[local * 4 + slot] = (local * 17 + slot * 37) % 256
      a.weights[local * 4 + slot] = (slot + 1) / (count * (count + 1) / 2)
    }
  }
  return { grid: { dimensions, isInsideFlat, insideIndices, flatToLocal }, a, b }
}

function hash(weights: WeightBuffers): string {
  return createHash('sha256').update(weights.bones)
    .update(new Uint8Array(weights.weights.buffer, weights.weights.byteOffset, weights.weights.byteLength))
    .update(weights.count).digest('hex')
}

// Captured from the pre-WASM JavaScript kernel (07c8c98), including inactive slots.
const cases = [
  { cap: 0, iterations: 0, hash: 'a326fda63dc2985e6c0ad71c449fc997a2431a86a168813e4c511fe713766bcd' },
  { cap: 1, iterations: 1, hash: '19befd6d69d6a13cc9e7638ef559217461c598c7149836fa54fe6cdfadf04b06' },
  { cap: 12, iterations: 12, hash: '867d6ac41e3a325c6fe2a7487cafcb1be2f9705b47ecd536566712ce97ac0f18' },
  { cap: 100, iterations: 24, hash: '519b6d00a389dd173cf6e3e3fcd77a8242ae7ce5ee8627d34c63a9d69c179b35' },
]

for (const expected of cases) {
  for (const count of expected.cap === 100 ? [1, 2, 3, 4] : [1, 2]) {
    const work = await prepare(fixture(), count, expected.cap)
    const workers: WorkerHandle<Task>[] = []
    try {
      const iterations = count === 1 ? [await run(work.tasks[0])]
        : await Promise.all(work.tasks.map((task) => new Promise<number>((resolve, reject) => {
          const worker = createBlurWorker({ result: resolve, error: reject })
          workers.push(worker)
          worker.postMessage(task, [])
        })))
      assert.deepEqual(iterations, Array(count).fill(expected.iterations), `cap ${expected.cap}, ${count} workers: convergence`)
      assert.equal(hash(work.result(iterations[0])), expected.hash, `cap ${expected.cap}, ${count} workers: exact JS output`)
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()))
    }
  }
}

if (availableParallelism() > 1) {
  const post = Worker.prototype.postMessage
  const workers: Worker[] = []
  let waiting = false
  let poll: ReturnType<typeof setInterval> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    Worker.prototype.postMessage = function (this: Worker, value: unknown, transfer?: readonly TransferListItem[]) {
      workers.push(this)
      if (workers.length !== 1) return post.call(this, value, transfer)
      assert.ok(typeof value === 'object' && value !== null && 'memory' in value && value.memory instanceof WebAssembly.Memory)
      assert.ok('control' in value && typeof value.control === 'number')
      const state = new Int32Array(value.memory.buffer, value.control, 4)
      // Hold the first task until its peer is blocked at the barrier, then kill it.
      poll = setInterval(() => {
        if (Atomics.load(state, 0) !== 1) return
        waiting = true
        clearInterval(poll)
        void this.terminate()
      }, 5)
    }
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Parallel worker failure hung the solver')), 5000)
    })
    await assert.rejects(Promise.race([blur(fixture([20000, 1, 1]), 100), timeout]), /exited before completing/)
    assert.ok(waiting, 'a peer was waiting at the shared-memory barrier')
    assert.equal(workers.length, 2)
    assert.ok(workers.every((worker) => worker.threadId === -1), 'failure terminates every child before rejecting')
  } finally {
    Worker.prototype.postMessage = post
    clearInterval(poll)
    clearTimeout(deadline)
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
}

console.log('WASM exact JS parity, shared memory, convergence and blocked-peer cleanup ok')
