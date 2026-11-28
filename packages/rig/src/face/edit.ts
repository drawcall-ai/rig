/**
 * A face rig as data, and how it is applied: computeFace() computes it once, CachedRigLoader stores it and applies it
 * on each load without the rigging code.
 */

import * as THREE from 'three'
import { pieceMeshes } from '../measure/pieces.js'
import { copyRenderState } from '../render.js'
import type { SkeletonBone } from '../skin/skeleton.js'
import { FACE_MATERIAL, type FaceResult } from './contract.js'
import { eyeTexture, repainted, type Paint } from './texture.js'

/** An eyeball and its iris: radii as fractions of the ball's. */
export interface EyePart {
  geometry: THREE.BufferGeometry
  iris: THREE.Color
  irisRadius: number
  pupilRadius: number
}

/**
 * A rigged face, in the parts applyFace() installs. It leaves the face mesh with the triangles no shape moves and no
 * morph targets, and adds under it a `Face` mesh, the moving triangles with the face mesh's materials, morph targets
 * (FaceData.shapes) and `userData.face`, and a `Cavity` mesh lining the opened mouth and the eye sockets; and under the
 * object `EyeLeft`, `EyeRight`, `TeethUpper`, `TeethLower` and `Tongue`. Each renders as the face mesh was set to
 * (copyRenderState()); skinning later moves every mesh directly under the object.
 */
export interface FaceEdit {
  /** The face mesh, by its index among the meshes under the object in traversal order. */
  mesh: number
  /** The face's material, which FACE_MATERIAL marks: its index among the face mesh's materials. */
  material: number
  /** Rectangles of the face material's map repainted over eyes drawn on it. */
  paint: Paint[]
  /** The face mesh's geometry once rigged: the triangles no shape moves, without morph targets. */
  still: THREE.BufferGeometry
  /** The triangles a shape moves, in the face mesh's coordinates: the face's morph targets, rest positions and data. */
  moving: THREE.BufferGeometry
  /** The mouth and eye sockets' lining, in the face mesh's coordinates. */
  cavity: THREE.BufferGeometry
  /** Left, then right; these and the mouth parts in the object's coordinates. */
  eyes: EyePart[]
  upperTeeth: THREE.BufferGeometry
  lowerTeeth: THREE.BufferGeometry
  tongue: THREE.BufferGeometry
  /**
   * FaceResult's bones, in world space: the left eye's, the right eye's, the teeth's. Without pieces, applyFace()
   * measures the model it leaves for them; CachedRigLoader stores them measured.
   */
  bones: SkeletonBone[]
  shapes: string[]
  deviation: Record<string, number>
}

/**
 * Applies `edit` to the unskinned object it was computed for and returns the bones to skin it with. Eyes painted on the
 * face are painted over in a new map, which takes the old map's place throughout the object. The old map is disposed
 * but its image left open, as THREE.Cache may hand the same ImageBitmap to other loads.
 */
export function applyFace(object: THREE.Object3D, edit: FaceEdit): FaceResult {
  const mesh = meshAt(object, edit.mesh)
  const materials = [mesh.material].flat()
  const material = materials[edit.material]
  if (!material) throw new Error(`face: mesh "${mesh.name}" has no material ${edit.material} for the face`)
  material.userData[FACE_MATERIAL] = true
  if (edit.paint.length) {
    if (!('map' in material) || !(material.map instanceof THREE.Texture)) throw new Error(`face: the face material of "${mesh.name}" has no map to repaint`)
    const map = material.map
    replaceTexture(object, map, repainted(map, edit.paint))
    map.dispose()
  }
  mesh.geometry = edit.still
  // children in the face's coordinates, like its morph deltas; skinning binds them with the face they touch
  const moving = new THREE.Mesh(edit.moving, mesh.material)
  moving.name = 'Face'
  const cavity = new THREE.Mesh(edit.cavity, new THREE.MeshStandardMaterial({ color: 0x2c0c0e, roughness: 0.8 }))
  cavity.name = 'Cavity'
  mesh.add(moving, cavity)
  // the added parts render as the face mesh was set to, shadows and layers included
  for (const part of [moving, cavity]) copyRenderState(part, mesh)

  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const part = new THREE.Mesh(geometry, material)
    part.name = name
    copyRenderState(part, mesh)
    object.add(part)
    return part
  }
  const [leftEye, rightEye] = edit.eyes.map(({ geometry, iris, irisRadius, pupilRadius }, i) => add(i ? 'EyeRight' : 'EyeLeft', geometry, new THREE.MeshStandardMaterial({ map: eyeTexture(iris, irisRadius, pupilRadius), roughness: 0.2 })))
  const enamel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 })
  const upperTeeth = add('TeethUpper', edit.upperTeeth, enamel)
  const lowerTeeth = add('TeethLower', edit.lowerTeeth, enamel)
  const tongue = add('Tongue', edit.tongue, new THREE.MeshStandardMaterial({ color: 0x8c3f48, vertexColors: true, roughness: 0.45 }))

  const result = { shapes: edit.shapes, deviation: edit.deviation }
  if (edit.bones.every((bone) => bone.pieces)) return { ...result, bones: edit.bones }
  // by identity: the model may have meshes of its own with these names
  const owners = pieceMeshes(object)
  const piecesOf = (...parts: THREE.Mesh[]) => owners.flatMap((m, i) => (parts.includes(m) ? [i] : []))
  const pieces = [piecesOf(leftEye), piecesOf(rightEye), piecesOf(upperTeeth, lowerTeeth, tongue)]
  return { ...result, bones: edit.bones.map((bone, i) => ({ ...bone, pieces: pieces[i] })) }
}

/** Puts `to` in every slot of the materials under `object` that holds `from`. */
function replaceTexture(object: THREE.Object3D, from: THREE.Texture, to: THREE.Texture): void {
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    for (const material of [node.material].flat()) for (const [slot, value] of Object.entries(material)) {
      if (value !== from) continue
      Reflect.set(material, slot, to)
      material.needsUpdate = true
    }
  })
}

/** The mesh at `index` among the meshes under `object` in traversal order, as FaceEdit.mesh counts. */
export function meshAt(object: THREE.Object3D, index: number): THREE.Mesh {
  const meshes: THREE.Mesh[] = []
  object.traverse((node) => { if (node instanceof THREE.Mesh) meshes.push(node) })
  const mesh = meshes[index]
  if (!mesh) throw new Error(`face: the object has no mesh ${index}`)
  return mesh
}
