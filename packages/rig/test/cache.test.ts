import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { cachedWeights } from '../dist/skin/cache.js'
import type { SkeletonBone } from '../dist/skin/skeleton.js'
import { makeCapsule } from './capsule.js'

const directory = await mkdtemp(fileURLToPath(new URL('../../../examples/browser/.rig-cache-', import.meta.url)))
const cwd = process.cwd()
const post = Worker.prototype.postMessage
let jobs = 0
Worker.prototype.postMessage = function (...args) {
  jobs++
  return post.apply(this, args)
}
try {
  process.chdir(directory)
  const script = join(directory, 'model.glts')
  const dependency = join(directory, 'model.bin')
  await writeFile(script, 'first script')
  await writeFile(dependency, 'first dependency')
  const source = { url: pathToFileURL(script).href, dependencyUrls: [pathToFileURL(dependency).href] }
  const mesh = makeCapsule()
  const skeleton: SkeletonBone[] = [
    { name: 'root', position: [0, -0.9, 0] },
    { name: 'tip', parent: 'root', position: [0, 0.9, 0] },
  ]
  const run = (resolution = 16) => cachedWeights(source, {})(mesh.positions.slice(), mesh.indices.slice(), skeleton, resolution)
  const first = await run()
  assert.equal(jobs, 1, 'a cold cache computes weights')
  const second = await run()
  assert.equal(jobs, 1, 'a warm cache does not start a solver worker')
  assert.deepEqual(second, first, 'binary weights and JSON reports round-trip exactly')
  second.skinWeights.fill(0)
  assert.deepEqual(await run(), first, 'each hit owns independent weight buffers')

  await writeFile(script, 'changed script')
  await run()
  assert.equal(jobs, 2, 'changing source contents invalidates the entry')
  await writeFile(dependency, 'changed dependency')
  await run()
  assert.equal(jobs, 3, 'changing a dependency invalidates the entry')
  await run(24)
  assert.equal(jobs, 4, 'resolution is part of the computation')
  skeleton[1] = { ...skeleton[1], position: [0, 0.8, 0] }
  await run()
  assert.equal(jobs, 5, 'joint positions are part of the computation')
  mesh.positions[0] += 0.01
  await run()
  assert.equal(jobs, 6, 'actual geometry is part of the computation')
  console.log('rig cache hits, ownership and source, dependency, settings and geometry invalidation ok')
} finally {
  Worker.prototype.postMessage = post
  process.chdir(cwd)
  await rm(directory, { recursive: true, force: true })
}
