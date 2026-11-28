import assert from 'node:assert/strict'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CachedRigLoader, isFaceData, wrinkles, type FaceLandmarks, type SkeletonBone } from '../dist/index.js'
import { ALL, checkLandmarks } from '../dist/face/rig/landmarks.js'
import { closedHead, rigFace } from './head.js'

const { geometry, landmarks } = await closedHead()
const head = (g = geometry.clone()) => new THREE.Group().add(new THREE.Mesh(g, new THREE.MeshStandardMaterial()))
const rig = (l: FaceLandmarks, object = head()) => rigFace(object, { landmarks: l, head: 'Head' })

// landmarks arrive as untyped data (an agent's JSON), so the face rig validates them at runtime
const { hairline: _, ...missing } = landmarks
assert.throws(() => checkLandmarks(missing), /missing landmarks hairline/)
assert.throws(() => checkLandmarks({ ...landmarks, nose: [0, 0, 0] }), /unknown landmarks nose/)
assert.throws(() => checkLandmarks({ ...landmarks, hairline: [0, Number.NaN, 0] }), /landmark hairline must be finite/)
// Left is the character's own left; the viewer's left mirrors the fit
const swapped = { ...landmarks }
for (const name of ALL) {
  const mirror = ALL.find((other) => other === name.replace(/Left$|Right$/, (side) => (side === 'Left' ? 'Right' : 'Left')))
  if (mirror) swapped[name] = landmarks[mirror]
}
await assert.rejects(rig(swapped), /Left and Right are swapped/)
const morphed = geometry.clone()
morphed.morphAttributes.position = [morphed.getAttribute('position').clone()]
await assert.rejects(rig(landmarks, head(morphed)), /already has morph targets/)
// the loader rejects bones the face rig cannot add before creating the model
const load = (extra: SkeletonBone[], headBone = 'Head') => new CachedRigLoader().loadAsync({
  object: () => { throw new Error('created') },
  skeleton: [{ name: 'Head', position: [0, 0, 0] }, { name: 'HeadEnd', parent: 'Head', position: [0, 1, 0] }, ...extra],
  face: { landmarks, head: headBone },
})
await assert.rejects(load([], 'Neck'), /face.head "Neck" is not a bone/)
await assert.rejects(load([], 'HeadEnd'), /face.head "HeadEnd" needs a child bone/)
await assert.rejects(load([{ name: 'LeftEye', parent: 'Head', position: [0, 0.5, 0], pieces: [] }]), /already has LeftEye, which the face rig adds/)

// a face map placed by a uv transform (as glTF's KHR_texture_transform sets it) keeps it once the eyes are painted over
const mapped = geometry.clone()
const position = mapped.getAttribute('position')
mapped.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from({ length: position.count }, (_, v) => [position.getX(v) + 0.5, position.getY(v) - 1.2]).flat(), 2))
// skin flecked with painted white, so the skin around the eyes is repainted
const fleck = (i: number) => (((i >> 1) + (i >> 7)) % 2 ? [200, 120, 100, 255] : [230, 230, 230, 255])
const map = new THREE.DataTexture(Uint8Array.from(Array.from({ length: 64 * 64 }, (_, i) => fleck(i)).flat()), 64, 64)
map.offset.set(0.25, 0.5)
map.repeat.set(0.5, 0.5)
const object = new THREE.Group().add(new THREE.Mesh(mapped, new THREE.MeshStandardMaterial({ map })))
const result = await rig(landmarks, object)
assert.deepEqual(result.bones.map((b) => [b.name, b.parent]), [['LeftEye', 'Head'], ['RightEye', 'Head'], ['Teeth', 'Head']])
assert.ok(result.bones[0].position[0] > 0, 'the character\'s left eye sits on its left (+x)')
assert.ok(result.bones.every((b) => b.pieces?.length), 'every added bone owns pieces')
for (const name of ['jawOpen', 'eyeBlinkLeft', 'mouthSmileLeft_soft', 'cheekBulgeRight']) assert.ok(result.shapes.includes(name), name)
assert.deepEqual(object.children.map((c) => c.name), ['', 'EyeLeft', 'EyeRight', 'TeethUpper', 'TeethLower', 'Tongue'])
const [faceMesh, , , , lowerTeeth, tongue] = object.children
assert.ok(faceMesh instanceof THREE.Mesh && lowerTeeth instanceof THREE.Mesh && tongue instanceof THREE.Mesh)
assert.deepEqual(faceMesh.children.map((c) => c.name), ['Face', 'Cavity'])
const [moving, cavity] = faceMesh.children
assert.ok(moving instanceof THREE.Mesh && cavity instanceof THREE.Mesh)
const targets = (mesh: THREE.Mesh) => Object.keys(mesh.morphTargetDictionary ?? {})
assert.ok(!faceMesh.geometry.morphAttributes.position && targets(moving).includes('jawOpen'), 'only the moving part of the face morphs')
// the parts meet at vertices no shape moves, so nothing cracks open between them
const still = new Set(Array.from({ length: faceMesh.geometry.getAttribute('position').count }, (_, v) => new THREE.Vector3().fromBufferAttribute(faceMesh.geometry.getAttribute('position'), v).toArray().join()))
const deltas = (mesh: THREE.Mesh) => [...mesh.geometry.morphAttributes.position ?? [], ...mesh.geometry.morphAttributes.normal ?? []]
const shared = Array.from({ length: moving.geometry.getAttribute('position').count }, (_, v) => v).filter((v) => still.has(new THREE.Vector3().fromBufferAttribute(moving.geometry.getAttribute('position'), v).toArray().join()))
assert.ok(shared.length > 0, 'the moving part borders the still part')
assert.ok(shared.every((v) => deltas(moving).every((d) => !d.getX(v) && !d.getY(v) && !d.getZ(v))), 'no shape moves a vertex the still part shares')
for (const mesh of [moving, cavity, lowerTeeth, tongue]) {
  const geometry: THREE.BufferGeometry = mesh.geometry
  const { position = [], normal = [] } = geometry.morphAttributes
  assert.ok(position.every((d, i) => [d, normal[i]].some((n) => n.array.some((x) => x !== 0))), `${mesh.name} carries only shapes that move it`)
}
assert.deepEqual(new Set(result.shapes), new Set([moving, cavity, lowerTeeth, tongue].flatMap(targets)), 'the shapes are those baked anywhere')
assert.ok(lowerTeeth.morphTargetDictionary?.jawOpen !== undefined && tongue.morphTargetDictionary?.tongueOut !== undefined, 'jaw shapes move teeth and tongue')
assert.ok(lowerTeeth.morphTargetDictionary?.eyeBlinkLeft === undefined, 'shapes that leave the jaw leave the teeth')
assert.ok(moving.geometry.getAttribute('_facerest'), 'wrinkles read the rest positions, named as glTF keeps custom attributes')
assert.ok(cavity.morphTargetDictionary?.jawOpen !== undefined, 'the cavity opens with the jaw')
assert.ok(!cavity.geometry.getAttribute('_facerest') && !cavity.geometry.userData.face, 'wrinkles and drivers find only the face')
assert.ok(!Array.isArray(faceMesh.material) && moving.material === faceMesh.material, 'the face keeps its own material, so a GLB export keeps it one mesh')
assert.ok(faceMesh.material instanceof THREE.MeshStandardMaterial && faceMesh.material.map !== map)
assert.deepEqual([faceMesh.material.map?.offset.toArray(), faceMesh.material.map?.repeat.toArray()], [[0.25, 0.5], [0.5, 0.5]])
const data: unknown = moving.geometry.userData.face
assert.ok(isFaceData(data))
assert.ok(data.eyeY > data.cornerY && data.browY > data.eyeY, 'brows above eyes above the mouth')
assert.deepEqual(data.shapes, result.shapes)

// landmarks and bones are in world space, as skeleton joints are, so a model turned, scaled and moved by its own and its
// parent's transforms rigs as it is placed; a mesh of its own named like an added part is not taken for one
const placed = head()
placed.rotation.y = Math.PI / 2
placed.scale.setScalar(2)
placed.position.set(0.3, -1, 0)
const decoy = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01).translate(0, 3, 0), new THREE.MeshStandardMaterial())
decoy.name = 'EyeLeft'
placed.add(decoy)
new THREE.Group().translateZ(5).add(placed).updateMatrixWorld()
const toWorld = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(placed.matrixWorld).toArray()
const placedLandmarks = { ...landmarks }
for (const name of ALL) placedLandmarks[name] = toWorld(landmarks[name])
const placedResult = await rig(placedLandmarks, placed)
placedResult.bones.forEach((bone, i) => assert.ok(new THREE.Vector3(...bone.position).distanceTo(new THREE.Vector3(...toWorld(result.bones[i].position))) < 1e-6, `${bone.name} is placed with the model`))
assert.equal(placedResult.bones[0].pieces?.length, result.bones[0].pieces?.length, 'the eye owns only its eyeball')

// a GLB reload splits a face with materials [other, face] into one mesh per material; wrinkles() finds the face material by its mark
const parts = geometry.clone()
const index = parts.getIndex()
assert.ok(index)
const triangles = Array.from({ length: index.count / 3 }, (_, t) => [index.getX(3 * t), index.getX(3 * t + 1), index.getX(3 * t + 2)])
// the face's right half, so both materials are among the moving triangles
const right = (t: number[]) => t.every((v) => parts.getAttribute('position').getX(v) < 0)
const sorted = [...triangles.filter(right), ...triangles.filter((t) => !right(t))]
parts.setIndex(sorted.flat())
const split = triangles.filter(right).length * 3
parts.addGroup(0, split, 0)
parts.addGroup(split, index.count - split, 1)
const twoMaterials = new THREE.Group().add(new THREE.Mesh(parts, [new THREE.MeshStandardMaterial({ name: 'other' }), new THREE.MeshStandardMaterial({ name: 'face' })]))
await rigFace(twoMaterials, { landmarks, head: 'Head' })
class BlobReader {
  result: ArrayBuffer | null = null
  onloadend?: () => void
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((result) => { this.result = result; this.onloadend?.() })
  }
}
Object.defineProperty(globalThis, 'FileReader', { value: BlobReader, configurable: true })
// just the face: the eyes' textures need a canvas to export
const binary = await new GLTFExporter().parseAsync(twoMaterials.children[0], { binary: true })
assert.ok(binary instanceof ArrayBuffer)
const reloaded = (await new GLTFLoader().parseAsync(binary, '')).scene
const meshes: THREE.Mesh[] = []
reloaded.traverse((node) => { if (node instanceof THREE.Mesh && node.geometry.getAttribute('_facerest')) meshes.push(node) })
assert.equal(meshes.length, 2, 'one face mesh per material')
await wrinkles(reloaded)
assert.deepEqual(meshes.map((m) => [m.material].flat().map((material) => `${material.name} ${material.type}`)), [['other MeshStandardMaterial'], ['face MeshStandardNodeMaterial']], 'only the face material wrinkles')

// wrinkles() shades through the standard lighting model, so it refuses a face material outside it, either side
for (const material of [new THREE.MeshPhysicalMaterial(), new THREE.MeshBasicMaterial()]) {
  const other = new THREE.Group().add(new THREE.Mesh(geometry.clone(), material))
  await rigFace(other, { landmarks, head: 'Head' })
  await assert.rejects(wrinkles(other), new RegExp(`is a ${material.type}; wrinkles\\(\\) needs a MeshStandardMaterial`))
}

console.log('face: ok')
