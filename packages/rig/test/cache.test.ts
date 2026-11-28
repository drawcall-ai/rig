import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { Bone, BufferAttribute, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three'
import { CachedRigLoader, type ModelLoader, type RigRequest, type RigResult, type SkeletonBone } from '../dist/index.js'
import { digest, digestModel } from '../dist/digest.js'
import { makeCapsule } from './capsule.js'

// browsers on insecure origins lack crypto.subtle, and must key entries as Node warmed them
const view = new Float32Array([1, 2, 3, 4]).subarray(1, 3)
const native = await digest(view)
const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
assert.ok(crypto)
Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
try {
  assert.equal(await digest(view), native, 'the JavaScript hash matches crypto.subtle')
} finally {
  Object.defineProperty(globalThis, 'crypto', crypto)
}

// models a load treats differently key apart: one with morph targets (which the face rig refuses), one whose single
// material becomes an array (whose groups the face rig keeps)
{
  const model = (change: (mesh: Mesh) => void = () => {}) => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), 3))
    const mesh = new Mesh(geometry, new MeshBasicMaterial())
    change(mesh)
    return digestModel(new Group().add(mesh))
  }
  const plain = await model()
  assert.equal(await model(), plain, 'the same model keys alike')
  assert.notEqual(await model((mesh) => { mesh.geometry.morphAttributes.position = [mesh.geometry.getAttribute('position').clone()] }), plain, 'morph targets key apart')
  assert.notEqual(await model((mesh) => { mesh.material = [new MeshBasicMaterial()] }), plain, 'an array of one material keys apart')
}

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

function attribute(result: RigResult, name: string): number[][] {
  const values: number[][] = []
  result.object.traverse((entry) => {
    if (entry instanceof SkinnedMesh) values.push(Array.from(entry.geometry.getAttribute(name).array))
  })
  return values
}
const weights = (result: RigResult) => attribute(result, 'skinWeight')


try {
  process.chdir(directory)
  const file = join(models, 'model.glb')
  const data = await readFile(new URL('./fixtures/fox.glb', import.meta.url))
  await writeFile(file, data)
  const skeleton: SkeletonBone[] = [
    { name: 'body', position: [0, 10, 0] },
    { name: 'tip', parent: 'body', position: [0, 100, 0] },
  ]
  const fox = async (loader: ModelLoader) => (await loader.loadAsync(pathToFileURL(file).href)).scene
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
    object: async (loader) => (await loader.setPath(`${pathToFileURL(models).href}/`).loadAsync('model.glb')).scene,
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
  await assert.rejects(new CachedRigLoader().loadAsync({ object: () => capsule().children[0], skeleton: bones, resolution: 16 }), /object\(\) returned a Mesh; return a container/)
  const procedural = () => new CachedRigLoader().loadAsync({ object: capsule, skeleton: bones, resolution: 16 })
  await procedural().then((result) => result.dispose())
  await procedural().then((result) => result.dispose())
  assert.equal(jobs, 6, 'a procedural object reuses its weights')
  mesh.positions[0] += 0.01
  await procedural().then((result) => result.dispose())
  assert.equal(jobs, 7, 'a geometry change invalidates')

  // a skinned model turned by its container keys alike under trig rounded otherwise, as another engine rounds it
  const skinnedCapsule = () => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(mesh.positions.slice(), 3))
    geometry.setIndex(new BufferAttribute(mesh.indices.slice(), 1))
    const count = geometry.getAttribute('position').count
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(count * 4), 4))
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4))
    const skinned = new SkinnedMesh(geometry, new MeshBasicMaterial())
    const armature = new Bone()
    const group = new Group().add(skinned, armature)
    group.rotation.set(0.3, 0.7, 0)
    group.updateMatrixWorld(true)
    skinned.bind(new Skeleton([armature]))
    armature.rotation.z = 0.2
    return group
  }
  const turned = () => new CachedRigLoader().loadAsync({ object: skinnedCapsule, skeleton: bones, resolution: 16 })
  await turned().then((result) => result.dispose())
  assert.equal(jobs, 8)
  const [sin, cos] = [Math.sin, Math.cos]
  Math.sin = (x) => sin(x) * (1 - Number.EPSILON / 2)
  Math.cos = (x) => cos(x) * (1 - Number.EPSILON / 2)
  await turned().then((result) => result.dispose()).finally(() => { [Math.sin, Math.cos] = [sin, cos] })
  assert.equal(jobs, 8, 'a turned skinned model reuses its weights')

  console.log('rig cache hits, independent results, ownership and geometry/settings invalidation ok')
} finally {
  Worker.prototype.postMessage = post
  process.chdir(cwd)
  await Promise.all([rm(directory, { recursive: true, force: true }), rm(models, { recursive: true, force: true })])
}
