import assert from 'node:assert/strict'
import * as THREE from 'three'
import { skin } from '../dist/index.js'
import { pose } from '../dist/pose.js'

class TrackedGeometry extends THREE.BufferGeometry {
  copies: THREE.BufferGeometry[] = []
  disposed = 0

  override clone(): this {
    const copy = super.clone()
    copy.addEventListener('dispose', () => { this.disposed++ })
    this.copies.push(copy)
    return copy
  }
}

// The solver and generated mesh must use the same pose even while the scene is animated or edited.
{
  const geometry = new TrackedGeometry().copy(new THREE.BoxGeometry())
  geometry.morphTargetsRelative = true
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(new Float32Array(24 * 3).fill(0.1), 3)]
  const material = new THREE.MeshBasicMaterial()
  const source = new THREE.Mesh(geometry, material)
  source.position.x = 1
  source.name = 'surface'
  source.userData.tag = 'kept'
  source.morphTargetInfluences = [0.25]
  const model = new THREE.Group().add(source)
  model.position.x = 10
  const old = new THREE.Bone()
  const root = new THREE.Bone()
  root.name = 'body'
  root.userData.pieces = [0]
  const marker = new THREE.Object3D()
  marker.position.y = 2
  old.add(root, marker)
  model.add(old)
  const initial = Array.from(geometry.getAttribute('position').array)

  const binding = skin(model, root)
  assert.equal(geometry.copies.length, 1, 'geometry prepared before yielding to the worker')
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([99, 99, 99], 3))
  source.position.x = 100
  source.morphTargetInfluences[0] = 0.75
  model.position.x += 7
  old.position.y = 1
  root.position.x = 2
  await binding

  const bound = model.getObjectByName('surface')
  assert.ok(bound instanceof THREE.SkinnedMesh)
  const positions = bound.geometry.getAttribute('position')
  assert.equal(positions.count, 24, 'vertex count comes from the snapshot')
  assert.equal(bound.geometry.getAttribute('skinWeight').count, positions.count)
  for (let i = 0; i < positions.count; i++) {
    assert.ok(Math.abs(positions.getX(i) - initial[i * 3] - 1) < 1e-6)
    assert.equal(positions.getY(i), initial[i * 3 + 1])
    assert.equal(positions.getZ(i), initial[i * 3 + 2])
  }
  assert.equal(bound.material, material)
  assert.equal(bound.userData.tag, 'kept')
  assert.deepEqual(bound.morphTargetInfluences, [0.25])
  assert.equal(bound.geometry.morphAttributes.position?.[0].count, 24)
  assert.equal(bound.skeleton.bones[0], root, 'the supplied bone is retained')
  assert.equal(bound.bindMatrix.elements[12], 10)
  assert.equal(bound.skeleton.boneInverses[0].elements[12], -10)
  assert.equal(root.parent, model)
  assert.equal(marker.parent, model)
  assert.equal(old.parent, null)
  assert.equal(marker.getWorldPosition(new THREE.Vector3()).y, 3, 'attachments retain their current world pose')
  model.updateMatrixWorld(true)
  const vertex = new THREE.Vector3().fromBufferAttribute(positions, 0)
  const posed = bound.applyBoneTransform(0, vertex.clone()).applyMatrix4(bound.matrixWorld)
  assert.ok(posed.distanceTo(vertex.clone().add(new THREE.Vector3(19, 1, 0))) < 1e-6, 'live bone and host motion apply to the captured bind pose')
  pose(model, {})
  const reset = bound.applyBoneTransform(0, vertex.clone()).applyMatrix4(bound.matrixWorld)
  assert.ok(reset.distanceTo(vertex.clone().add(new THREE.Vector3(17, 0, 0))) < 1e-6, 'rest metadata describes the captured pose in the final hierarchy')
  assert.equal(geometry.disposed, 0, 'committed geometry belongs to the model')
}

// An asynchronous solver rejection releases prepared clones without disposing source resources.
{
  const geometry = new TrackedGeometry().copy(new THREE.BoxGeometry())
  const material = new THREE.MeshBasicMaterial()
  const source = new THREE.Mesh(geometry, material)
  const model = new THREE.Group().add(source)
  const root = new THREE.Bone()
  root.name = 'unassigned'
  let sourceDisposals = 0
  geometry.addEventListener('dispose', () => { sourceDisposals++ })
  material.addEventListener('dispose', () => { sourceDisposals++ })
  await assert.rejects(skin(model, root), /no deforming bone or rigid piece assignments/)
  assert.equal(geometry.copies.length, 1)
  assert.equal(geometry.disposed, 1)
  assert.equal(sourceDisposals, 0)
  assert.equal(source.parent, model)
  assert.equal(root.userData.rigBindMatrix, undefined, 'failed binding does not write rest metadata')
}

console.log('bind-snapshot.test.ts passed')
