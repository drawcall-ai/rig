import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GLTSLoader } from '@drawcall/glts'
import { Bone, LoadingManager, MeshBasicMaterial, SkeletonHelper, SkinnedMesh } from 'three'
import * as rig from '../dist/node.js'

const directory = await mkdtemp(join(tmpdir(), 'rig-glts-'))
const loader = new GLTSLoader(new LoadingManager(), { modules: { '@drawcall/rig': rig } })
try {
  const model = new URL('./fixtures/fox.glb', import.meta.url).href
  const file = join(directory, 'fox.glts')
  await writeFile(file, `
import { isPreview, loadingManager, onDispose, scene } from '@drawcall/glts'
import { RigLoader, weights } from '@drawcall/rig'
import { SkeletonHelper } from 'three'
const rig = await new RigLoader(loadingManager).loadAsync({
  url: ${JSON.stringify(model)},
  skeleton: [
    { name: 'Body', position: [0, 40, 0] },
    { name: 'Body_End', parent: 'Body', position: [0, 60, 20] },
  ],
  resolution: 32,
})
scene.add(rig.scene)
onDispose(() => rig.dispose())
if (isPreview) {
  onDispose(weights(rig.scene))
  const helper = new SkeletonHelper(rig.scene)
  for (const material of [helper.material].flat()) material.depthTest = false
  helper.renderOrder = 1
  scene.add(helper)
  onDispose(() => helper.dispose())
}
`)
  const url = pathToFileURL(file)
  const [first, second] = await Promise.all([loader.loadAsync(url), loader.loadAsync(url)])
  const left = first.getObjectByName('Body')
  const right = second.getObjectByName('Body')
  assert.ok(left instanceof Bone && right instanceof Bone)
  assert.notEqual(left, right, 'each GLTS execution owns its bones')
  left.rotation.x = 0.4
  assert.ok(right.rotation.x === 0)
  let disposed = 0
  first.traverse((object) => {
    if (object instanceof SkinnedMesh) object.geometry.addEventListener('dispose', () => disposed++)
  })
  first.dispose()
  assert.ok(disposed > 0, 'GLTS disposal releases the generated rig')
  const count = disposed
  first.dispose()
  assert.equal(disposed, count)
  second.update(0.1)
  second.dispose()
  const previewLoader = new GLTSLoader(new LoadingManager(), { isPreview: true, modules: { '@drawcall/rig': rig } })
  try {
    const preview = await previewLoader.loadAsync(url)
    let helpers = 0
    let painted = 0
    let diagnosticDisposals = 0
    preview.traverse((object) => {
      if (object instanceof SkeletonHelper) {
        helpers++
        for (const material of [object.material].flat()) assert.equal(material.depthTest, false)
        object.geometry.addEventListener('dispose', () => diagnosticDisposals++)
      }
      if (object instanceof SkinnedMesh) {
        assert.ok(object.material instanceof MeshBasicMaterial)
        assert.ok(object.geometry.getAttribute('color'))
        painted++
        object.geometry.addEventListener('dispose', () => diagnosticDisposals++)
      }
    })
    assert.equal(helpers, 1)
    assert.ok(painted > 0)
    preview.dispose()
    assert.equal(diagnosticDisposals, helpers + painted, 'preview cleanup releases diagnostic geometry')
    const production = await loader.loadAsync(url)
    production.traverse((object) => {
      assert.ok(!(object instanceof SkeletonHelper), 'export mode has no bone overlay')
      if (object instanceof SkinnedMesh) assert.ok(!(object.material instanceof MeshBasicMaterial), 'export retains original materials')
    })
    production.dispose()
  } finally {
    previewLoader.dispose()
  }
  console.log('GLTS assets own independent rigs and preview-only diagnostics in Node')
} finally {
  loader.dispose()
  await rm(directory, { recursive: true, force: true })
}
