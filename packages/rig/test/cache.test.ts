import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { LoadingManager, SkinnedMesh } from 'three'
import { RigLoader, type RigResult, type SkeletonBone } from '../dist/node.js'
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
  result.scene.traverse((entry) => {
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
  const loader = new RigLoader().setPath(`${models}/`)
  const run = (resolution = 16) => loader.loadAsync({ url: 'model.glb', skeleton, resolution })
  const first = await run()
  assert.equal(jobs, 1, 'a model outside the cache project computes without GLTS')
  const second = await new RigLoader().loadAsync({ url: pathToFileURL(file), skeleton, resolution: 16 })
  assert.equal(jobs, 1, 'identical bytes reuse weights through a different URL spelling')
  assert.deepEqual(second.report, first.report)
  assert.deepEqual(weights(second), weights(first), 'binary weights round-trip exactly')
  assert.notEqual(first.scene, second.scene)
  assert.notEqual(first.skeleton, second.skeleton)
  first.dispose()
  assert.ok(weights(second).length, 'disposing one result leaves another independently usable')
  second.dispose()

  const changed = Uint8Array.from(data)
  const offset = data.indexOf('"copyright"')
  assert.ok(offset > 0)
  changed.set(new TextEncoder().encode('"generator"'), offset)
  await writeFile(file, changed)
  const metadata = await run()
  assert.equal(jobs, 2, 'a metadata-only GLB edit invalidates its cached weights')
  assert.deepEqual(metadata.report, first.report, 'the edit changes source bytes without changing solver inputs')
  metadata.dispose()
  await writeFile(file, data)
  await run().then((result) => result.dispose())
  assert.equal(jobs, 2, 'restored source bytes reuse the original entry')
  await run(24).then((result) => result.dispose())
  assert.equal(jobs, 3, 'resolution is part of the computation')
  skeleton[1] = { ...skeleton[1], position: [0, 90, 0] }
  await run().then((result) => result.dispose())
  assert.equal(jobs, 4, 'joint positions are part of the computation')

  let modifications = 0
  const manager = new LoadingManager().setURLModifier((url) => {
    modifications++
    return url.replace('alias.glb', 'model.glb')
  })
  const alias = await new RigLoader(manager).setPath(`${models}/`).loadAsync({ url: 'alias.glb', skeleton, resolution: 16 })
  alias.dispose()
  assert.equal(modifications, 1, 'the loading manager resolves the main URL once')
  assert.equal(jobs, 4, 'a URL modifier shares the entry for the actual loaded bytes')

  const fetch = globalThis.fetch
  let reads = 0
  globalThis.fetch = async (_input, options) => {
    reads++
    assert.equal(options?.credentials, 'include')
    return new Response(data)
  }
  try {
    const remote = await new RigLoader().setWithCredentials(true).loadAsync({ url: 'https://rig.test/model.glb', skeleton, resolution: 16 })
    remote.dispose()
    assert.equal(reads, 1, 'source hashing reuses the bytes already fetched')
    assert.equal(jobs, 4, 'remote and local copies of the same model share weights')
  } finally {
    globalThis.fetch = fetch
  }

  const mesh = makeCapsule()
  await writeFile(join(models, 'mesh.bin'), new Uint8Array(mesh.positions.buffer))
  await writeFile(join(models, 'indices.bin'), new Uint8Array(mesh.indices.buffer))
  await writeFile(join(models, 'model.gltf'), JSON.stringify({
    asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ uri: 'mesh.bin', byteLength: mesh.positions.byteLength }, { uri: 'indices.bin', byteLength: mesh.indices.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: mesh.positions.byteLength }, { buffer: 1, byteLength: mesh.indices.byteLength }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: mesh.positions.length / 3, type: 'VEC3', min: [-0.5, -1, -0.5], max: [0.5, 1, 0.5] },
      { bufferView: 1, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' },
    ],
  }))
  const bones: SkeletonBone[] = [{ name: 'body', position: [0, -0.9, 0] }, { name: 'tip', parent: 'body', position: [0, 0.9, 0] }]
  const external = () => loader.loadAsync({ url: 'model.gltf', skeleton: bones, resolution: 16 })
  await external().then((result) => result.dispose())
  assert.equal(jobs, 5)
  mesh.positions[0] += 0.01
  await writeFile(join(models, 'mesh.bin'), new Uint8Array(mesh.positions.buffer))
  await external().then((result) => result.dispose())
  assert.equal(jobs, 6, 'external glTF geometry changes invalidate even when the main JSON is unchanged')
  console.log('URL rig cache hits, independent results, content/settings invalidation and single reads ok')
} finally {
  Worker.prototype.postMessage = post
  process.chdir(cwd)
  await Promise.all([rm(directory, { recursive: true, force: true }), rm(models, { recursive: true, force: true })])
}
