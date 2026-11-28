/** skin(): binds a scene's meshes to a THREE.Bone tree with computed weights. */

import * as THREE from 'three'
import { gather, outward } from '../measure/soup.js'
import { checkResolution } from '../measure/voxelize.js'
import type { SkeletonBone } from './skeleton.js'
import { boneTree } from '../bone.js'
import type { SkinReport } from './weights.js'
import { computeWeights } from './worker.js'
import { assertTRS } from './rest.js'
import { copyRenderState } from '../render.js'

/**
 * Binds every mesh under a container `object` (such as a Scene or Group) to a skeleton: either the bone
 * tree under a root `THREE.Bone`, or the skeleton as data, built into bones as CachedRigLoader does (find a bound
 * bone afterwards with `object.getObjectByName`). Either way the bound bones are those very objects:
 * computes skin weights from a snapshot in a worker and replaces each mesh
 * with a THREE.SkinnedMesh at the scene root (vertices baked into that root's coordinates, preserving
 * the current world-space bind pose) and removes any previous armature; anything else hanging off that armature or off a
 * replaced mesh, such as an empty, a light or a socket, moves under `object` in place. Attaches an unparented `root` under
 * `object`, preserving its world-space joints. Resolution =
 * voxels along the longest axis (default 128), as in section(). Returns per-bone results and warnings that
 * describe what the solver found. Attachments requiring shear fail before reparenting; bake nonuniform
 * scale into the model first. Geometry and bind transforms are captured before the worker starts;
 * bone animation and model placement may continue while it runs.
 */
export async function skin<Name extends string>(
  object: THREE.Object3D,
  skeleton: THREE.Bone | readonly SkeletonBone<Name>[],
  resolution = 128,
): Promise<SkinReport> {
  const root = skeleton instanceof THREE.Bone ? skeleton : boneTree(skeleton)
  return (await bind(object, root, resolution)).report
}

/** Shares scene preparation and binding between direct skinning and the loader's cached solve. */
export async function bind(
  object: THREE.Object3D,
  root: THREE.Bone,
  resolution: number,
  solve = computeWeights,
): Promise<{ report: SkinReport; skeleton: THREE.Skeleton }> {
  if (object instanceof THREE.Mesh) throw new Error('skin() needs a container: add the mesh to a Group or Scene first')
  if (object === root) throw new Error('skin() needs a model container separate from the root bone; use a Group or Scene')
  checkResolution(resolution, 'skin(scene, root, 256)')
  object.updateWorldMatrix(true, false)
  object.updateMatrixWorld(true)
  root.updateWorldMatrix(true, true)
  const bones: THREE.Bone[] = []
  root.traverse((node) => node instanceof THREE.Bone && bones.push(node))
  const newBones = new Set<THREE.Object3D>(bones)
  const oldBones: THREE.Bone[] = []
  object.traverse((node) => node instanceof THREE.Bone && !newBones.has(node) && oldBones.push(node))
  const old = new Set<THREE.Object3D>(oldBones)
  const meshes: THREE.Mesh[] = []
  object.traverse((node) => node instanceof THREE.Mesh && meshes.push(node))
  // what hangs off the old armature or off a mesh being replaced without being part of either, such as an empty, a
  // light or a socket, stays in place under the root; meshes are skinned themselves
  const attachments = [...oldBones, ...meshes].flatMap((parent) => parent.children.filter((child) => !old.has(child) && !(child instanceof THREE.Mesh)))
  const bindMatrix = object.matrixWorld.clone()
  const worldToModel = bindMatrix.clone().invert()
  // Validate every planned attachment before changing the source scene or replacing geometry.
  const planned = root.parent ? attachments : [root, ...attachments]
  for (const child of planned) {
    const local = worldToModel.clone().multiply(child.matrixWorld)
    assertTRS(local, `skin(): attaching "${child.name}" would require shear; bake nonuniform scale before skin`)
  }
  if (!root.parent) object.attach(root)
  root.updateWorldMatrix(true, true)
  const soup = gather(object)
  const worldSkeleton = bones.map((bone) => toSkeletonBone(bone, root))
  const inverses = bones.map((bone) => bone.matrixWorld.clone().invert())
  const rest = bones.map((bone) => attachments.includes(bone)
    ? worldToModel.clone().multiply(bone.matrixWorld).toArray()
    : bone.matrix.toArray())
  const pending = new Set<THREE.BufferGeometry>()
  try {
    const prepared = soup.meshes.map((mesh, m) => {
      const geometry = mesh.geometry.clone()
      pending.add(geometry)
      const offset = soup.offsets[m]
      const count = geometry.getAttribute('position').count
      bakedGeometry(geometry, mesh, worldToModel, soup.positions.subarray(offset * 3, (offset + count) * 3))
      const bound = new THREE.SkinnedMesh(geometry, mesh.material)
      bound.name = mesh.name
      bound.userData = { ...mesh.userData }
      copyRenderState(bound, mesh)
      if (mesh.morphTargetInfluences) bound.morphTargetInfluences = [...mesh.morphTargetInfluences]
      if (mesh.morphTargetDictionary) bound.morphTargetDictionary = { ...mesh.morphTargetDictionary }
      return { mesh, bound, offset, count }
    })
    const { skinIndices, skinWeights, report } = await solve(soup.positions, soup.indices, worldSkeleton, resolution)
    // Animation can continue during the solve; reparent only transforms that still fit Three's TRS.
    object.updateWorldMatrix(true, true)
    const currentWorldToModel = object.matrixWorld.clone().invert()
    for (const child of attachments) {
      child.updateWorldMatrix(true, false)
      assertTRS(currentWorldToModel.clone().multiply(child.matrixWorld),
        `skin(): attaching "${child.name}" would require shear; bake nonuniform scale before skin`)
    }
    // attached while their parents still hang in the tree, so their world transforms are current
    for (const child of attachments) object.attach(child)
    const three = new THREE.Skeleton(bones, inverses)
    for (const { mesh, bound, offset, count } of prepared) {
      bound.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices.slice(offset * 4, (offset + count) * 4), 4))
      bound.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights.slice(offset * 4, (offset + count) * 4), 4))
      bound.bind(three, bindMatrix)
      mesh.removeFromParent()
      object.add(bound)
      pending.delete(bound.geometry)
      bound.updateMatrixWorld(true)
    }
    for (const bone of oldBones) bone.removeFromParent()
    const names = new Set(bones.map((bone) => bone.name))
    object.traverse((node) => {
      if (!newBones.has(node) && names.has(node.name)) node.name = `${node.name}_source`
    })
    bones.forEach((bone, index) => { bone.userData.rigBindMatrix = rest[index] })
    return { report, skeleton: three }
  } finally {
    for (const geometry of pending) geometry.dispose()
  }
}

/** The root gets no skeleton parent, even when attached under a bone of the old armature. */
function toSkeletonBone(bone: THREE.Bone, root: THREE.Bone): SkeletonBone {
  return {
    name: bone.name,
    parent: bone !== root && bone.parent instanceof THREE.Bone ? bone.parent.name : undefined,
    position: bone.getWorldPosition(new THREE.Vector3()).toArray(),
    pieces: piecesOf(bone),
  }
}

/** bone.userData.pieces, checked: set by the caller, so anything can be there. */
function piecesOf(bone: THREE.Bone): number[] | undefined {
  const value: unknown = bone.userData.pieces
  if (value === undefined) return undefined
  if (Array.isArray(value) && value.every((index): index is number => Number.isInteger(index) && index >= 0)) return value
  throw new Error(`bone "${bone.name}".userData.pieces must be an array of piece indices, got ${JSON.stringify(value)}`)
}

/** Positions, normals and morph deltas baked into the destination model root's coordinates. */
function bakedGeometry(geometry: THREE.BufferGeometry, mesh: THREE.Mesh, worldToModel: THREE.Matrix4, positions: Float32Array): void {
  geometry.deleteAttribute('skinIndex')
  geometry.deleteAttribute('skinWeight')
  const transform = new THREE.Matrix4().multiplyMatrices(worldToModel, mesh.matrixWorld)
  geometry.setAttribute('position', new THREE.BufferAttribute(transformed(positions, worldToModel.elements, true), 3))
  const linear = transform.elements
  const normalMatrix = new THREE.Matrix4().setFromMatrix3(new THREE.Matrix3().getNormalMatrix(transform)).elements
  const bake = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, matrix: number[], unit: boolean) => {
    const values = new Float32Array(attribute.count * 3)
    for (let i = 0; i < attribute.count; i++) for (let k = 0; k < 3; k++) values[i * 3 + k] = attribute.getComponent(i, k)
    const out = transformed(values, matrix, false)
    if (unit) for (let i = 0; i < out.length; i += 3) {
      const length = Math.sqrt(out[i] * out[i] + out[i + 1] * out[i + 1] + out[i + 2] * out[i + 2]) || 1
      out[i] /= length; out[i + 1] /= length; out[i + 2] /= length
    }
    return new THREE.BufferAttribute(out, 3)
  }
  const normal = geometry.getAttribute('normal')
  if (normal) geometry.setAttribute('normal', bake(normal, normalMatrix, true))
  const morphs = geometry.morphAttributes
  if (morphs.position) morphs.position = morphs.position.map((delta) => bake(delta, linear, false))
  if (morphs.normal) morphs.normal = morphs.normal.map((delta) => bake(delta, normalMatrix, false))
  // A mirroring transform flips the winding once baked
  const index = geometry.getIndex()
  if (index && transform.determinant() < 0) {
    const flipped = Array.from({ length: index.count }, (_, i) => index.getX(outward(i, true)))
    geometry.setIndex(flipped)
  }
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
}

/** `values` (xyz triples) times the column-major 4×4 `m`, with its translation when `points`. */
function transformed(values: ArrayLike<number>, m: number[], points: boolean): Float32Array {
  const out = new Float32Array(values.length)
  const w = points ? 1 : 0
  for (let i = 0; i < values.length; i += 3) {
    const x = values[i], y = values[i + 1], z = values[i + 2]
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12] * w
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w
  }
  return out
}
