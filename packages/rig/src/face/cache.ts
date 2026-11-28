/** CachedRigLoader's face rig: the edit computeFace() makes, computed once, stored, and applied to each load's model. */

import { BufferAttribute, Mesh, SkinnedMesh, Vector3, type Object3D } from 'three'
import { CacheEntry } from '@drawcall/cache'
import { digest } from '../digest.js'
import { posed } from '../measure/soup.js'
import { copyRenderState } from '../render.js'
import type { SkeletonBone } from '../skin/skeleton.js'
import { decodeFace, encodeFace } from './codec.js'
import { applyFace, meshAt } from './edit.js'
import { followPieces } from './follow.js'
import type { FaceOptions, FaceResult } from './contract.js'

/**
 * Rigs the face of `object` and returns the skeleton to bind: the requested bones, their pieces
 * re-indexed from the model as created to the rigged model, and the face bones. The edit is keyed by `model`, the
 * digestModel() of `object` as created, alike in every engine, so browsers apply the edit Node computed rather than
 * rounding its math their own way; other inputs, such as the texture file it repaints, are inputs the cache plugin
 * records while warming. Only a miss loads the rigging code. Also returns `edit`, the digest of the stored edit, which
 * with `model` identifies the rigged geometry.
 */
export async function cachedFace(object: Object3D, skeleton: readonly SkeletonBone[], options: FaceOptions, model: string, cachePath: string | undefined): Promise<{ skeleton: SkeletonBone[]; face: FaceResult; edit: string }> {
  unskin(object)
  // a skeleton without rigid pieces spares measuring the model twice
  const follow = skeleton.some((bone) => bone.pieces?.length) ? followPieces(object) : undefined
  const entry = new CacheEntry({
    // Bump when the key or the encoded format changes; the rigging code and its reference head are inputs.
    version: 'rig-face@7',
    basePath: cachePath,
    dependencies: {
      model: { value: model },
      face: { value: { landmarks: { ...options.landmarks }, head: options.head } },
    },
  })
  const stored = await entry.load()
  // copied, as the cache's bytes may sit on a shared buffer, which digests do not take
  const { face, bytes } = stored ? { face: applyFace(object, await decodeFace(stored, object)), bytes: new Uint8Array(stored) } : await rigFace(object, options, entry)
  return { skeleton: [...follow ? follow(skeleton) : skeleton, ...face.bones], face, edit: await digest(bytes) }
}

/**
 * Computes the edit and applies it as a hit would read it, then saves it with its bones' pieces, which a hit then need
 * not measure, and returns the saved bytes.
 */
async function rigFace(object: Object3D, options: FaceOptions, entry: CacheEntry): Promise<{ face: FaceResult; bytes: Uint8Array<ArrayBuffer> }> {
  const [{ computeFace }, { TEMPLATE }] = await Promise.all([import('./rig/index.js'), import('./rig/template.js')])
  const edit = await computeFace(object, options)
  const base = meshAt(object, edit.mesh).geometry
  const read = await decodeFace(await encodeFace(edit, base), object)
  const face = applyFace(object, read)
  const bytes = await encodeFace({ ...read, bones: face.bones }, base)
  await entry.save(bytes, { dependencies: [{ path: TEMPLATE.href }] })
  return { face, bytes }
}

/**
 * Replaces each skinned mesh under `object` with a static mesh in its current pose, at its place in the tree so piece
 * indices keep their meaning: the face rig reshapes only unskinned meshes, and bind() drops the old armature either way.
 */
function unskin(object: Object3D): void {
  object.updateWorldMatrix(true, true)
  const skinned: SkinnedMesh[] = []
  object.traverse((node) => node instanceof SkinnedMesh && skinned.push(node))
  for (const mesh of skinned) {
    const parent = mesh.parent
    // CachedRigLoader refuses a bare mesh, so every mesh under the object has a parent
    if (!parent) throw new Error(`face: skinned mesh "${mesh.name}" has no parent`)
    const geometry = mesh.geometry.clone()
    geometry.deleteAttribute('skinIndex')
    geometry.deleteAttribute('skinWeight')
    const count = geometry.getAttribute('position').count
    const positions = new Float32Array(count * 3)
    const v = new Vector3()
    for (let i = 0; i < count; i++) posed(mesh, i, v).toArray(positions, i * 3)
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    const still = new Mesh(geometry, mesh.material)
    still.name = mesh.name
    still.userData = { ...mesh.userData }
    copyRenderState(still, mesh)
    still.position.copy(mesh.position)
    still.quaternion.copy(mesh.quaternion)
    still.scale.copy(mesh.scale)
    if (mesh.morphTargetInfluences) still.morphTargetInfluences = [...mesh.morphTargetInfluences]
    if (mesh.morphTargetDictionary) still.morphTargetDictionary = { ...mesh.morphTargetDictionary }
    for (const child of [...mesh.children]) still.add(child)
    parent.children[parent.children.indexOf(mesh)] = still
    still.parent = parent
    mesh.parent = null
  }
}
