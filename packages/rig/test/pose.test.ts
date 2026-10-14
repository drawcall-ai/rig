import assert from 'node:assert/strict'
import * as THREE from 'three'
import { clone } from 'three/addons/utils/SkeletonUtils.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { bone, pose, skin } from '../src/index.js'
import { readGLTF } from '../src/gltf/load.js'

function update(object: THREE.Object3D): void {
  object.updateWorldMatrix(true, false)
  object.updateMatrixWorld(true)
}

function vertices(object: THREE.Object3D): THREE.Vector3[] {
  update(object)
  const points: THREE.Vector3[] = []
  object.traverse((entry) => {
    if (!(entry instanceof THREE.Mesh)) return
    for (let index = 0; index < entry.geometry.getAttribute('position').count; index++) {
      points.push(entry.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(entry.matrixWorld))
    }
  })
  return points
}

function same(actual: THREE.Vector3[], expected: THREE.Vector3[], message: string, tolerance = 1e-5): void {
  assert.equal(actual.length, expected.length)
  actual.forEach((point, index) => assert.ok(point.distanceTo(expected[index]) < tolerance, `${message}: vertex ${index}: ${point.toArray()} != ${expected[index].toArray()}`))
}

function bones(object: THREE.Object3D): THREE.Bone[] {
  const result: THREE.Bone[] = []
  object.traverse((entry) => { if (entry instanceof THREE.Bone) result.push(entry) })
  return result
}

const host = new THREE.Group()
host.position.set(10, 2, -3)
host.rotation.set(0.1, 0.4, 0)
host.scale.setScalar(2)
const model = new THREE.Group().add(
  new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()),
  new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 2, 0), new THREE.MeshBasicMaterial()),
)
model.position.set(1, 2, 0)
model.rotation.z = 0.2
model.scale.setScalar(1.2)
host.add(model)
update(model)
const initial = vertices(model)
const modelLocal = initial.map((point) => model.worldToLocal(point.clone()))
const root = bone('Root', model.localToWorld(new THREE.Vector3()).toArray())
root.userData.pieces = [0]
const arm = bone('Arm', model.localToWorld(new THREE.Vector3(0, 1, 0)).toArray(), root)
arm.userData.pieces = [1]
const expectedJoints = [root, arm].map((entry) => entry.getWorldPosition(new THREE.Vector3()))
await skin(model, root)
same(vertices(model), initial, 'transformed root keeps its world-space geometry')
same([root, arm].map((entry) => entry.getWorldPosition(new THREE.Vector3())), expectedJoints, 'world-space joints are attached in place')
const localJoints = expectedJoints.map((point) => model.worldToLocal(point.clone()))
pose(model, { rotations: { Arm: [0.3, 0.2, 0] } })
pose(model, {})
same(vertices(model), initial, 'reset keeps transformed root placement')

const copy = clone(model)
const copyHost = new THREE.Group()
copyHost.position.set(-4, 3, 2)
copyHost.rotation.set(0.2, -0.5, 0.1)
copyHost.scale.setScalar(0.8)
copyHost.add(copy)
copy.position.set(3, 1, 2)
copy.rotation.set(0.3, 0.6, -0.2)
copy.scale.set(1.1, 0.8, 1.3)
update(copy)
const expectedCopy = modelLocal.map((point) => copy.localToWorld(point.clone()))
pose(copy, { rotations: { Arm: [0.4, 0, 0.2] } })
pose(copy, {})
same(vertices(copy), expectedCopy, 'translated, rotated and scaled clone resets in its host frame')
same(bones(copy).map((entry) => entry.getWorldPosition(new THREE.Vector3())), localJoints.map((point) => copy.localToWorld(point.clone())), 'clone joints retain placement')
const target = copy.localToWorld(new THREE.Vector3(3, 2, 1))
pose(copy, { targets: { Root: target.toArray() } })
const copyRoot = copy.getObjectByName('Root')
const copyArm = copy.getObjectByName('Arm')
assert.ok(copyRoot && copyArm)
const joint = copyRoot.getWorldPosition(new THREE.Vector3())
assert.ok(copyArm.getWorldPosition(new THREE.Vector3()).sub(joint).angleTo(target.clone().sub(joint)) < 1e-6, 'targets account for nonuniform host scale')
pose(copy, {})
same(vertices(model), initial, 'clone posing leaves source unchanged')

// The metadata is glTF extras, so an exported rig retains its rest pose independently of host placement.
class BlobReader {
  result: ArrayBuffer | null = null
  onloadend?: () => void
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((result) => { this.result = result; this.onloadend?.() })
  }
}
const fileReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader')
let binary: ArrayBuffer
try {
  Object.defineProperty(globalThis, 'FileReader', { value: BlobReader, configurable: true })
  const output = await new GLTFExporter().parseAsync(model, { binary: true })
  assert.ok(output instanceof ArrayBuffer)
  binary = output
} finally {
  if (fileReader) Object.defineProperty(globalThis, 'FileReader', fileReader)
  else Reflect.deleteProperty(globalThis, 'FileReader')
}
const roundtrip = (await new GLTFLoader().parseAsync(binary, '')).scene
const roundtripRest = vertices(roundtrip)
const roundtripLocal = roundtripRest.map((point) => roundtrip.worldToLocal(point.clone()))
roundtrip.position.set(7, 1, -2)
roundtrip.rotation.set(0.3, 0.2, 0.1)
roundtrip.scale.setScalar(1.4)
pose(roundtrip, { rotations: { Arm: [0.4, 0.2, 0] } })
pose(roundtrip, {})
same(vertices(roundtrip), roundtripLocal.map((point) => roundtrip.localToWorld(point.clone())), 'GLB roundtrip retains local rest matrices')

// Native glTF has no rig metadata; inverse binds are interpreted beneath the loader's identity scene root.
const native = (await readGLTF(new GLTFLoader(), new URL('./fixtures/fox.glb', import.meta.url))).scene
const nativeRest = vertices(native)
native.position.set(3, 4, -2)
native.rotation.set(0.1, 0.5, 0.2)
native.scale.setScalar(1.5)
pose(native, {})
same(vertices(native), nativeRest.map((point) => native.localToWorld(point.clone())), 'native glTF reset preserves new placement', 1e-3)
const nativeClone = clone(native)
nativeClone.position.set(-5, 2, 1)
pose(nativeClone, {})
same(vertices(nativeClone), nativeRest.map((point) => nativeClone.localToWorld(point.clone())), 'native rest metadata survives later clones', 1e-3)

const invalid = bones(copy)[0]
assert.ok(invalid)
invalid.userData.rigBindMatrix = [1, 2, 3]
assert.throws(() => pose(copy, {}), /invalid rigBindMatrix/)
invalid.userData.rigBindMatrix = new Array(16).fill(0)
assert.throws(() => pose(copy, {}), /invertible affine local transform/)
invalid.userData.rigBindMatrix = new THREE.Matrix4().set(1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1).toArray()
assert.throws(() => pose(copy, {}), /without shear/)

const sheared = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
sheared.rotation.z = Math.PI / 4
sheared.scale.set(2, 1, 1)
const unparented = bone('Root', [0, 0, 0])
unparented.userData.pieces = [0]
const child = bone('Child', [0, 1, 0], unparented)
child.userData.pieces = []
const beforeAttach = [unparented, child].map((entry) => entry.getWorldPosition(new THREE.Vector3()))
await assert.rejects(skin(sheared, unparented), /bake nonuniform scale before skin/)
assert.equal(unparented.parent, null, 'unsupported attachment fails before reparenting')
same([unparented, child].map((entry) => entry.getWorldPosition(new THREE.Vector3())), beforeAttach, 'unsupported attachment leaves joints unchanged')
assert.equal(sheared.children.length, 1, 'unsupported attachment leaves the model unchanged')
// Replacing an old armature also reparents retained children; reject shear before replacing any mesh.
const rerigged = new THREE.Group()
const originalMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
const oldBone = new THREE.Bone()
oldBone.rotation.z = Math.PI / 4
oldBone.scale.set(2, 1, 1)
rerigged.add(originalMesh, oldBone)
const replacement = bone('Root', [0, 0, 0])
replacement.rotation.z = Math.PI / 4
replacement.userData.pieces = [0]
oldBone.add(replacement)
const replacementChild = bone('Child', [0, 1, 0])
replacementChild.userData.pieces = []
replacement.add(replacementChild)
update(rerigged)
const originalJoints = [replacement, replacementChild].map((entry) => entry.getWorldPosition(new THREE.Vector3()))
await assert.rejects(skin(rerigged, replacement), /bake nonuniform scale before skin/)
assert.equal(replacement.parent, oldBone, 'unsupported rerig attachment preserves armature parenting')
assert.equal(originalMesh.parent, rerigged, 'unsupported rerig leaves original mesh in place')
assert.ok(!(originalMesh instanceof THREE.SkinnedMesh))
same([replacement, replacementChild].map((entry) => entry.getWorldPosition(new THREE.Vector3())), originalJoints, 'unsupported rerig leaves joints unchanged')
await assert.rejects(skin(replacement, replacement), /container separate from the root bone/)
console.log('pose preserves transformed roots, independent clones, native glTF and GLB roundtrips')
