import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { CylinderGeometry, DataTexture, LoadingManager, MeshStandardMaterial, SkinnedMesh } from 'three'
import { RigLoader, type RigRequest, type SkeletonBone } from '../src/node.js'

const directory = await mkdtemp(join(tmpdir(), 'rig-loader-'))
try {
  // External buffers and textures exercise the standalone Node path, without glts browser globals.
  const geometry = new CylinderGeometry(0.5, 0.5, 2, 12, 8).toNonIndexed()
  const positions = Float32Array.from(geometry.getAttribute('position').array)
  await writeFile(join(directory, 'mesh.bin'), new Uint8Array(positions.buffer))
  await writeFile(join(directory, 'texture.png'), createCanvas(2, 2).toBuffer('image/png'))
  await writeFile(join(directory, 'model.gltf'), JSON.stringify({
    asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }], images: [{ uri: 'texture.png' }],
    buffers: [{ uri: 'mesh.bin', byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-0.5, -1, -0.5], max: [0.5, 1, 0.5] }],
  }))
  const skeleton: SkeletonBone[] = [
    { name: 'lower', position: [0, -0.9, 0] },
    { name: 'upper', parent: 'lower', position: [0, 0, 0] },
    { name: 'end', parent: 'upper', position: [0, 0.9, 0] },
  ]
  let errors = 0
  let progress = 0
  const manager = new LoadingManager()
  manager.onError = () => errors++
  const loader = new RigLoader(manager).setPath(`${directory}/`)
  const [first, second] = await Promise.all([
    loader.loadAsync({ url: 'model.gltf', skeleton, resolution: 64 }, () => progress++),
    loader.loadAsync({ url: pathToFileURL(join(directory, 'model.gltf')), skeleton, resolution: 64 }),
  ])
  assert.equal(errors, 0)
  assert.equal(progress, 1)
  assert.notEqual(first.skeleton, second.skeleton)
  assert.notEqual(first.skeleton.bones[0], second.skeleton.bones[0])
  assert.deepEqual(first.report, second.report, 'concurrent worker solves stay independent')
  assert.deepEqual(first.animations, [])
  const root = first.skeleton.getBoneByName('lower')
  assert.ok(root)
  const secondRoot = second.skeleton.getBoneByName('lower')
  assert.ok(secondRoot)
  root.rotation.z = 0.3
  assert.ok(secondRoot.rotation.z === 0)
  let disposals = 0
  first.scene.traverse((object) => {
    if (!(object instanceof SkinnedMesh)) return
    assert.equal(object.skeleton, first.skeleton, 'result exposes the actual bound skeleton')
    assert.ok(object.material instanceof MeshStandardMaterial)
    assert.ok(object.material.map instanceof DataTexture)
    object.geometry.addEventListener('dispose', () => disposals++)
    object.material.map.addEventListener('dispose', () => disposals++)
  })
  first.dispose()
  const disposed = disposals
  assert.ok(disposed >= 2)
  first.dispose()
  assert.equal(disposals, disposed, 'disposal is idempotent')
  second.dispose()
  const absolute = await new RigLoader().setPath('missing-directory/').loadAsync({ url: join(directory, 'model.gltf'), skeleton, resolution: 16 })
  absolute.dispose()

  await assert.rejects(loader.loadAsync({ url: 'missing.glb', skeleton, resolution: 16 }), /ENOENT/)
  assert.equal(errors, 1)
  const changingURL = pathToFileURL(join(directory, 'model.gltf'))
  const changing: RigRequest = { url: changingURL, skeleton, resolution: 16 }
  const loading = loader.loadAsync(changing)
  changingURL.pathname = '/does-not-exist.gltf'
  changing.resolution = 0
  const snapshot = await loading
  snapshot.dispose()

  const originalFetch = globalThis.fetch
  const credentials: (RequestCredentials | undefined)[] = []
  globalThis.fetch = async (input, options) => {
    credentials.push(options?.credentials)
    const url = new URL(String(input))
    return new Response(await readFile(join(directory, url.pathname.slice(1))))
  }
  try {
    const remote = await new RigLoader().setWithCredentials(true).loadAsync({ url: 'https://rig.test/model.gltf', skeleton, resolution: 16 })
    remote.dispose()
    assert.equal(credentials.length, 3)
    assert.ok(credentials.every((value) => value === 'include'), 'credentials propagate to model, buffer and texture')
  } finally {
    globalThis.fetch = originalFetch
  }

  const originalModel = await readFile(join(directory, 'model.gltf'), 'utf8')
  await writeFile(join(directory, 'missing-texture.gltf'), originalModel.replace('texture.png', 'missing.png'))
  await assert.rejects(loader.loadAsync({ url: 'missing-texture.gltf', skeleton, resolution: 16 }), /source textures failed/)
  await writeFile(join(directory, 'corrupt.png'), 'not an image')
  await writeFile(join(directory, 'corrupt-texture.gltf'), originalModel.replace('texture.png', 'corrupt.png'))
  await assert.rejects(loader.loadAsync({ url: 'corrupt-texture.gltf', skeleton, resolution: 16 }), /source textures failed/)

  const fox = await new RigLoader().loadAsync({
    url: new URL('./fixtures/fox.glb', import.meta.url),
    skeleton: [{ name: 'body', position: [0, 10, 0] }, { name: 'tip', parent: 'body', position: [0, 100, 0] }],
    resolution: 16,
  })
  let textured = false
  fox.scene.traverse((object) => {
    if (object instanceof SkinnedMesh && object.material instanceof MeshStandardMaterial && object.material.map instanceof DataTexture) textured = true
  })
  assert.ok(textured, 'embedded GLB texture loads without browser globals')
  fox.dispose()
  geometry.dispose()
  console.log('RigLoader Node resources, concurrent rigs, ownership and failures ok')
} finally {
  await rm(directory, { recursive: true, force: true })
}
