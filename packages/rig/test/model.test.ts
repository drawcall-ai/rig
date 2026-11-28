import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { CylinderGeometry, DataTexture, LoadingManager, Mesh, MeshStandardMaterial } from 'three'
import { ModelLoader } from '../dist/index.js'

const directory = await mkdtemp(join(tmpdir(), 'rig-model-'))
const cwd = process.cwd()
try {
  process.chdir(directory)
  // External buffers and textures exercise the Node reader, which has no browser globals.
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
  let errors = 0
  let progress = 0
  const manager = new LoadingManager()
  manager.onError = () => errors++
  const models = new ModelLoader(manager).setPath(`${pathToFileURL(directory).href}/`)
  const [first, second] = await Promise.all([
    models.loadAsync('model.gltf', () => progress++),
    new ModelLoader().loadAsync(pathToFileURL(join(directory, 'model.gltf')).href),
  ])
  assert.equal(errors, 0)
  assert.equal(progress, 1)
  for (const { scene } of [first, second]) {
    const mesh = scene.getObjectByProperty('type', 'Mesh')
    assert.ok(mesh instanceof Mesh && mesh.material instanceof MeshStandardMaterial && mesh.material.map instanceof DataTexture, 'external buffers and textures load')
  }

  await mkdir(join(directory, 'public', 'models'), { recursive: true })
  for (const name of ['model.gltf', 'mesh.bin', 'texture.png']) await copyFile(join(directory, name), join(directory, 'public', 'models', name))
  for (const path of ['/models/model.gltf', 'models/model.gltf']) {
    const served = await new ModelLoader().loadAsync(path)
    assert.ok(served.scene.getObjectByProperty('type', 'Mesh'), `${path} and its relative resources read from public/`)
  }

  let modifications = 0
  const aliased = new LoadingManager().setURLModifier((url) => {
    modifications++
    return url.replace('alias.gltf', 'model.gltf')
  })
  await new ModelLoader(aliased).loadAsync('/models/alias.gltf')
  assert.equal(modifications, 3, 'the loading manager resolves the model and each resource once')

  await assert.rejects(models.loadAsync('missing.glb'), /ENOENT/)
  assert.equal(errors, 1)

  const originalFetch = globalThis.fetch
  const credentials: (RequestCredentials | undefined)[] = []
  globalThis.fetch = async (input, options) => {
    credentials.push(options?.credentials)
    const url = new URL(String(input))
    return new Response(await readFile(join(directory, url.pathname.slice(1))))
  }
  try {
    await new ModelLoader().setWithCredentials(true).loadAsync('https://rig.test/model.gltf')
    assert.equal(credentials.length, 3)
    assert.ok(credentials.every((value) => value === 'include'), 'credentials propagate to model, buffer and texture')
  } finally {
    globalThis.fetch = originalFetch
  }

  const originalModel = await readFile(join(directory, 'model.gltf'), 'utf8')
  await writeFile(join(directory, 'missing-texture.gltf'), originalModel.replace('texture.png', 'missing.png'))
  await assert.rejects(models.loadAsync('missing-texture.gltf'), /source textures failed/)
  await writeFile(join(directory, 'corrupt.png'), 'not an image')
  await writeFile(join(directory, 'corrupt-texture.gltf'), originalModel.replace('texture.png', 'corrupt.png'))
  await assert.rejects(models.loadAsync('corrupt-texture.gltf'), /source textures failed/)

  const fox = await new ModelLoader().loadAsync(new URL('./fixtures/fox.glb', import.meta.url).href)
  let textured = false
  fox.scene.traverse((object) => {
    if (object instanceof Mesh && object.material instanceof MeshStandardMaterial && object.material.map instanceof DataTexture) textured = true
  })
  assert.ok(textured, 'embedded GLB texture loads without browser globals')
  geometry.dispose()
  console.log('ModelLoader Node resources, public paths and failures ok')
} finally {
  process.chdir(cwd)
  await rm(directory, { recursive: true, force: true })
}
