import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { computeWeights as compute } from '../src/skin/weights.js'
import { computeWeights } from '../dist/skin/worker.js'
import { createWorker } from '../dist/skin/worker/node.js'
import type { SkeletonBone } from '../dist/skin/skeleton.js'
import { makeCapsule } from './capsule.js'

const mesh = makeCapsule()
const skeleton: SkeletonBone[] = [
  { name: 'root', position: [0, -0.9, 0] },
  { name: 'middle', parent: 'root', position: [0, 0, 0] },
  { name: 'tip', parent: 'middle', position: [0, 0.9, 0] },
]
const rigid: SkeletonBone[] = [{ name: 'body', position: [0, 0, 0], pieces: [0] }]
const expected = await compute(mesh.positions, mesh.indices, skeleton, 32)
const expectedRigid = await compute(mesh.positions, mesh.indices, rigid, 32)
const run = (bones = skeleton) => computeWeights(mesh.positions.slice(), mesh.indices.slice(), bones, 32)

const positions = mesh.positions.slice()
const indices = mesh.indices.slice()
let responsive = false
const timer = setTimeout(() => { responsive = true }, 0)
try {
  const pending = computeWeights(positions, indices, skeleton, 32)
  assert.equal(positions.byteLength, 0, 'positions transfer to the worker')
  assert.equal(indices.byteLength, 0, 'indices transfer to the worker')
  const [result, rigidResult] = await Promise.all([pending, run(rigid)])
  assert.ok(responsive, 'the caller can process timers during computation')
  assert.deepEqual(result, expected, 'worker weights and reports match the core exactly')
  assert.deepEqual(rigidResult, expectedRigid, 'concurrent jobs with different skeletons stay independent')
} finally {
  clearTimeout(timer)
}

await assert.rejects(run([]), /no deforming bone/)
assert.deepEqual(await run(), expected, 'a failed computation does not poison the next worker')

const post = Worker.prototype.postMessage
try {
  Worker.prototype.postMessage = function () { void this.terminate() }
  await assert.rejects(run(), /exited before completing/)
} finally {
  Worker.prototype.postMessage = post
}
assert.deepEqual(await run(), expected, 'an unexpected worker exit does not poison later jobs')

const errors: Error[] = []
let worker: ReturnType<typeof createWorker> | undefined
try {
  await new Promise((resolve, reject) => {
    worker = createWorker({ result: resolve, error: (error) => { errors.push(error); reject(error) } })
    worker.postMessage({ positions: mesh.positions.slice(), indices: mesh.indices.slice(), skeleton, resolution: 32 }, [])
  })
} finally {
  await worker?.terminate()
}
assert.deepEqual(errors, [], 'successful worker termination does not report a failure')
console.log('worker parity, transfers, responsiveness, concurrent jobs and failure recovery ok')
