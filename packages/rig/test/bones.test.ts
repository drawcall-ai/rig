import assert from 'node:assert/strict'
import * as THREE from 'three'
import { bones } from '../src/index.js'

// A child listed before its parent still lands under it, at its absolute position, with its own copy of pieces
{
  const skeleton = [
    { name: 'spine', parent: 'hips', position: [0, 1.15, 0.1] },
    { name: 'head', parent: 'spine', position: [0, 1.6, 0.2], pieces: [2] },
    { name: 'hips', position: [0, 1.1, -0.5] },
  ] as const
  const root = bones(skeleton)
  const named = (name: string) => {
    const found = root.getObjectByName(name)
    assert.ok(found instanceof THREE.Bone, `bone "${name}"`)
    return found
  }
  assert.equal(root.name, 'hips')
  assert.ok(named('spine').parent === root && named('head').parent === named('spine'), 'linked by parent name')
  for (const entry of skeleton) {
    const position = named(entry.name).getWorldPosition(new THREE.Vector3())
    assert.ok(position.distanceTo(new THREE.Vector3(...entry.position)) < 1e-12, `${entry.name} at its position`)
  }
  assert.deepEqual(named('head').userData.pieces, [2])
  assert.notEqual(named('head').userData.pieces, skeleton[1].pieces, 'pieces copied')
}

// A skeleton is one tree
{
  assert.throws(() => bones([
    { name: 'hips', position: [0, 1, 0] },
    { name: 'spine', parent: 'hips', position: [0, 1.2, 0] },
    { name: 'tail', position: [0, 1, -1] },
  ]), /exactly one root, got 2/)
  assert.throws(() => bones([
    { name: 'a', parent: 'b', position: [0, 0, 0] },
    { name: 'b', parent: 'a', position: [0, 1, 0] },
  ]), /cycle/)
}

// A misspelled parent fails to type-check. The @ts-expect-error line is enforced by `pnpm typecheck`.
{
  assert.throws(() => bones([
    { name: 'hips', position: [0, 1, 0] },
    // @ts-expect-error: parent typo
    { name: 'spine', parent: 'hip', position: [0, 1.2, 0] },
  ]), /unknown parent "hip"/)
}

console.log('bones.test.ts passed')
