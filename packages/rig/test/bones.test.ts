import assert from 'node:assert/strict'
import * as THREE from 'three'
import { bones, type SkeletonBone } from '../src/index.js'

// A child listed before its parent still lands under it, at its absolute position, with its own copy of pieces
{
  const skeleton = [
    { name: 'spine', parent: 'hips', position: [0, 1.15, 0.1] },
    { name: 'head', parent: 'spine', position: [0, 1.6, 0.2], pieces: [2] },
    { name: 'hips', position: [0, 1.1, -0.5] },
  ] as const
  const { root, byName } = bones(skeleton)
  assert.equal(root, byName.hips)
  assert.deepEqual(Object.keys(byName).sort(), ['head', 'hips', 'spine'])
  assert.ok(byName.spine.parent === byName.hips && byName.head.parent === byName.spine, 'linked by parent name')
  for (const entry of skeleton) {
    assert.ok(byName[entry.name].getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(...entry.position)) < 1e-12, `${entry.name} at its position`)
  }
  assert.deepEqual(byName.head.userData.pieces, [2])
  assert.notEqual(byName.head.userData.pieces, skeleton[1].pieces, 'pieces copied')
  assert.throws(() => bones([...skeleton, { name: 'tail', position: [0, 1, -1] }]), /exactly one root, got 2/)
}

// Names are types: a parent must name a bone of the same skeleton, and byName has exactly its bones
{
  const { byName } = bones([
    { name: 'hips', position: [0, 1, 0] },
    { name: 'spine', parent: 'hips', position: [0, 1.2, 0] },
  ])
  byName.spine.rotation.x = 0.1
  // @ts-expect-error: no bone "tail" in this skeleton
  assert.equal(byName.tail, undefined)
  assert.throws(() => bones([
    { name: 'hips', position: [0, 1, 0] },
    // @ts-expect-error: parent typo
    { name: 'spine', parent: 'hip', position: [0, 1.2, 0] },
  ]), /unknown parent "hip"/)
  const serialized: SkeletonBone[] = [{ name: 'a', position: [0, 0, 0] }, { name: 'b', parent: 'a', position: [0, 1, 0] }]
  const { byName: loose } = bones(serialized)
  assert.ok(loose.b, 'a skeleton typed SkeletonBone[] keys byName by string')
}

console.log('bones.test.ts passed')
