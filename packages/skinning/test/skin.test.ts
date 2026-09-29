/**
 * skin() on real documents: a transformed, shared capsule mesh (world-space
 * baking, instancing, mirroring) and the already-skinned, textured Fox sample
 * (skin replacement). Outputs must pass the Khronos glTF validator.
 *
 *   pnpm --filter @drawcall/skinning test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Document, WebIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { validateBytes } from 'gltf-validator'
import { skin, type Skeleton } from '../src/index.js'
import { readScene } from '../src/scene.js'
import { makeCapsule } from './capsule.js'

const io = new WebIO().registerExtensions(ALL_EXTENSIONS)

async function roundTrip(document: Document): Promise<Document> {
  const bytes = await io.writeBinary(document)
  const { issues } = await validateBytes(bytes)
  const errors = issues.messages.filter((message) => message.severity === 0)
  assert.equal(issues.numErrors, 0, `validator errors: ${JSON.stringify(errors.slice(0, 5), null, 2)}`)
  return io.readBinary(bytes)
}

function checkWeights(document: Document): void {
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const weights = primitive.getAttribute('WEIGHTS_0')
      assert.ok(weights, 'every primitive is skinned')
      const w = [0, 0, 0, 0]
      for (let i = 0; i < weights.getCount(); i++) {
        weights.getElement(i, w)
        assert.ok(Math.abs(w[0] + w[1] + w[2] + w[3] - 1) < 1e-4, `vertex ${i} weights sum to ${w}`)
      }
    }
  }
}

// Capsule: y in [-1, 1], instanced twice under transformed parents, once mirrored
{
  const document = new Document()
  const buffer = document.createBuffer()
  const capsule = makeCapsule()
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(capsule.positions).setBuffer(buffer))
    .setIndices(document.createAccessor().setType('SCALAR').setArray(capsule.indices).setBuffer(buffer))
  const mesh = document.createMesh('capsule').addPrimitive(primitive)
  const parent = document.createNode('parent').setTranslation([0, 2, 0]).setScale([2, 2, 2])
  const left = document.createNode('left').setMesh(mesh).setTranslation([-1, 0, 0])
  const right = document.createNode('right').setMesh(mesh).setTranslation([1, 0, 0]).setScale([-1, 1, 1])
  parent.addChild(left).addChild(right)
  document.createScene().addChild(parent)
  const worldBefore = readScene(document).positions

  // World capsules span y 0..4 at x = -2 and x = 2
  const skeleton: Skeleton = {
    bones: [
      { name: 'root', position: [0, 0, 0], deform: false },
      { name: 'leftLow', parent: 'root', position: [-2, 0.3, 0] },
      { name: 'leftHigh', parent: 'leftLow', position: [-2, 2, 0], tail: [-2, 3.7, 0] },
      { name: 'rightLow', parent: 'root', position: [2, 0.3, 0] },
      { name: 'rightHigh', parent: 'rightLow', position: [2, 2, 0], tail: [2, 3.7, 0] },
    ],
  }
  // Pieces: the scene is two separate capsules, so a bone can own one of them outright
  const copy = async () => io.readBinary(await io.writeBinary(document))
  const pinned = skin(await copy(), { bones: [...skeleton.bones, { name: 'prop', parent: 'root', position: [2, 2, 0], pieces: [1] }] }, { resolution: 64 })
  assert.equal(pinned.bones.find((bone) => bone.name === 'prop')?.vertices, capsule.positions.length / 3, 'prop owns one whole capsule')
  const another = await copy()
  assert.throws(() => skin(another, { bones: [...skeleton.bones, { name: 'prop', position: [0, 0, 0], pieces: [5] }] }), /names piece 5/)

  const report = skin(document, skeleton, { resolution: 64 })
  assert.deepEqual(report.warnings, [])
  assert.equal(report.meshes, 2)
  const byName = new Map(report.bones.map((bone) => [bone.name, bone]))
  assert.equal(byName.get('root')?.vertices, 0)
  for (const name of ['leftLow', 'leftHigh', 'rightLow', 'rightHigh']) {
    const bone = byName.get(name)
    assert.ok(bone?.min && bone.max && bone.vertices > 500, `${name} drives ${bone?.vertices} vertices`)
    assert.equal(Math.sign(bone.min[0]), name.startsWith('left') ? -1 : 1, `${name} stays on its capsule`)
    if (name.endsWith('Low')) assert.ok(bone.max[1] < 2.6, `${name} reaches up to y=${bone.max[1]}`)
    else assert.ok(bone.min[1] > 1.4, `${name} reaches down to y=${bone.min[1]}`)
  }

  const result = await roundTrip(document)
  checkWeights(result)
  const root = result.getRoot()
  assert.equal(root.listSkins().length, 1)
  assert.equal(root.listSkins()[0].listJoints().length, 5)
  assert.equal(root.listMeshes().length, 2, 'the instanced mesh becomes one skinned mesh per node')
  // Bind pose = input pose: vertices baked to world, unchanged in place
  const worldAfter = readScene(result).positions
  assert.equal(worldAfter.length, worldBefore.length)
  for (let i = 0; i < worldAfter.length; i++) assert.ok(Math.abs(worldAfter[i] - worldBefore[i]) < 1e-5)
  console.log('capsule ok:', report.vertices, 'vertices,', report.grid.insideVoxels, 'solid voxels')
}

// Fox: already skinned + textured + animated; the old skin is replaced
{
  const document = await io.readBinary(readFileSync(new URL('./fixtures/fox.glb', import.meta.url)))
  const worldBefore = readScene(document).positions
  const skeleton: Skeleton = {
    bones: [
      { name: 'hips', position: [0, 40, -25] },
      { name: 'chest', parent: 'hips', position: [0, 40, 15] },
      { name: 'head', parent: 'chest', position: [0, 60, 35], tail: [0, 60, 60] },
      { name: 'tail', parent: 'hips', position: [0, 35, -45], tail: [0, 15, -80] },
      { name: 'frontLeft', parent: 'chest', position: [6, 30, 18], tail: [6, 2, 18] },
      { name: 'frontRight', parent: 'chest', position: [-6, 30, 18], tail: [-6, 2, 18] },
      { name: 'backLeft', parent: 'hips', position: [6, 30, -36], tail: [6, 2, -36] },
      { name: 'backRight', parent: 'hips', position: [-6, 30, -36], tail: [-6, 2, -36] },
    ],
  }
  const report = skin(document, skeleton)
  assert.deepEqual(report.warnings, [])
  for (const bone of report.bones) assert.ok(bone.vertices > 0, `${bone.name} drives no vertices`)

  const result = await roundTrip(document)
  checkWeights(result)
  const skins = result.getRoot().listSkins()
  assert.equal(skins.length, 1, 'the original skin is removed')
  assert.deepEqual(
    skins[0].listJoints().map((joint) => joint.getName()),
    skeleton.bones.map((bone) => bone.name),
  )
  assert.ok(result.getRoot().listTextures().length > 0, 'textures survive')
  // The replaced armature is gone and every new joint name is unique, so engines find bones by name
  const nodeNames = result.getRoot().listNodes().map((node) => node.getName())
  for (const bone of skeleton.bones) assert.equal(nodeNames.filter((n) => n === bone.name).length, 1, `one node named ${bone.name}`)
  assert.ok(!nodeNames.some((n) => n.startsWith('b_')), `old Fox joints remain: ${nodeNames.filter((n) => n.startsWith('b_'))}`)
  // The original bind pose is kept as the new rest pose
  const worldAfter = readScene(result).positions
  let maxDiff = 0
  for (let i = 0; i < worldAfter.length; i++) maxDiff = Math.max(maxDiff, Math.abs(worldAfter[i] - worldBefore[i]))
  assert.ok(maxDiff < 1e-3, `rest pose moved by ${maxDiff}`)
  console.log('fox ok:', report.vertices, 'vertices,', report.bones.length, 'bones')
}

console.log('skin.test.ts passed')
