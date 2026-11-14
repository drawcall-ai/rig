import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial, SkinnedMesh } from 'three'
import { CachedRigLoader, ModelLoader, type RigRequest, type RigResult, type SkeletonBone } from '../dist/node.js'
import { makeCapsule } from './capsule.js'

const directory = await mkdtemp(join(tmpdir(), 'rig-cache-'))
const models = await mkdtemp(join(tmpdir(), 'rig-models-'))
const cwd = process.cwd()
const post = Worker.prototype.postMessage
let jobs = 0
Worker.prototype.postMessage = function (...args) {
  const message: unknown = args[0]
  if (typeof message === 'object' && message !== null && 'positions' in message && message.positions instanceof Float32Array) jobs++
  return post.apply(this, args)
}

function weights(result: RigResult): number[][] {
  const values: number[][] = []
  result.object.traverse((entry) => {
    if (entry instanceof SkinnedMesh) values.push(Array.from(entry.geometry.getAttribute('skinWeight').array))
  })
  return values
}

try {
  process.chdir(directory)
  const file = join(models, 'model.glb')
  const data = await readFile(new URL('./fixtures/fox.glb', import.meta.url))
  await writeFile(file, data)
  const skeleton: SkeletonBone[] = [
    { name: 'body', position: [0, 10, 0] },
    { name: 'tip', parent: 'body', position: [0, 100, 0] },
  ]
  const fox = async () => (await new ModelLoader().loadAsync(pathToFileURL(file).href)).scene
  const run = (resolution = 16) => new CachedRigLoader().loadAsync({ object: fox, skeleton, resolution })
  const [first, second] = await Promise.all([run(64), run(64)])
  assert.equal(jobs, 2, 'concurrent misses each compute')
  assert.deepEqual(first.report, second.report, 'concurrent worker solves stay independent')
  const [bone, other] = [first, second].map((result) => result.skeleton.getBoneByName('body'))
  assert.ok(bone && other)
  const rest = other.rotation.z
  bone.rotation.z += 0.3
  assert.equal(other.rotation.z, rest, 'each result owns its bones')
  first.object.traverse((object) => {
    if (object instanceof SkinnedMesh) assert.equal(object.skeleton, first.skeleton, 'the result exposes the bound skeleton')
  })
  let disposals = 0
  first.object.traverse((object) => {
    if (object instanceof SkinnedMesh) object.geometry.addEventListener('dispose', () => disposals++)
  })
  first.dispose()
  const disposed = disposals
  assert.ok(disposed > 0)
  first.dispose()
  assert.equal(disposals, disposed, 'disposal is idempotent')
  assert.ok(weights(second).length, 'disposing one result leaves another usable')
  second.dispose()

  const computed = await run()
  assert.equal(jobs, 3)
  const reused = await new CachedRigLoader().loadAsync({
    object: async () => (await new ModelLoader().setPath(`${pathToFileURL(models).href}/`).loadAsync('model.glb')).scene,
    skeleton,
    resolution: 16,
  })
  assert.equal(jobs, 3, 'the same geometry reuses weights however the object is created')
  assert.deepEqual(reused.report, computed.report)
  assert.deepEqual(weights(reused), weights(computed), 'binary weights round-trip exactly')
  computed.dispose()
  reused.dispose()

  const request: RigRequest = { object: fox, skeleton, resolution: 16 }
  const loading = new CachedRigLoader().loadAsync(request)
  request.resolution = 0
  await loading.then((result) => result.dispose())
  assert.equal(jobs, 3, 'the request is read when the load starts')

  const changed = Uint8Array.from(data)
  const offset = data.indexOf('"copyright"')
  assert.ok(offset > 0)
  changed.set(new TextEncoder().encode('"generator"'), offset)
  await writeFile(file, changed)
  await run().then((result) => result.dispose())
  assert.equal(jobs, 3, 'a metadata-only GLB edit keeps weights, which depend only on geometry')
  await run(24).then((result) => result.dispose())
  assert.equal(jobs, 4, 'resolution is part of the computation')
  skeleton[1] = { ...skeleton[1], position: [0, 90, 0] }
  await run().then((result) => result.dispose())
  assert.equal(jobs, 5, 'joint positions are part of the computation')

  const mesh = makeCapsule()
  const bones: SkeletonBone[] = [{ name: 'body', position: [0, -0.9, 0] }, { name: 'tip', parent: 'body', position: [0, 0.9, 0] }]
  const capsule = () => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(mesh.positions.slice(), 3))
    geometry.setIndex(new BufferAttribute(mesh.indices.slice(), 1))
    return new Group().add(new Mesh(geometry, new MeshBasicMaterial()))
  }
  const procedural = () => new CachedRigLoader().loadAsync({ object: capsule, skeleton: bones, resolution: 16 })
  await procedural().then((result) => result.dispose())
  await procedural().then((result) => result.dispose())
  assert.equal(jobs, 6, 'a procedural object reuses its weights')
  mesh.positions[0] += 0.01
  await procedural().then((result) => result.dispose())
  assert.equal(jobs, 7, 'a geometry change invalidates')
  console.log('rig cache hits, independent results, ownership and geometry/settings invalidation ok')
} finally {
  Worker.prototype.postMessage = post
  process.chdir(cwd)
  await Promise.all([rm(directory, { recursive: true, force: true }), rm(models, { recursive: true, force: true })])
}
