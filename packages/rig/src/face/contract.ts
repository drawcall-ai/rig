/**
 * The face rig's contract with the layers that load, skin, drive and shade it: its options, the bones and data it leaves,
 * apart from the rigging code so they bundle without it.
 */

import type { SkeletonBone } from '../skin/skeleton.js'
import type { Anatomy } from './rig/anatomy.js'
import type { FaceLandmarks } from './rig/landmarks.js'

export interface FaceOptions {
  landmarks: FaceLandmarks
  /** The bone the eyes and teeth hang under. */
  head: string
}

/**
 * The bones the face rig adds under the head bone, so a skeleton with a face must not already use these names. The eye
 * bones rest in the face's frame, as glTF and VRM orient heads: local +Z looks forward, +Y is up and +X is the
 * character's left. A driver turns an eye by rotating it from rest about its local Y (positive toward the character's
 * left) and local X (positive downward), whatever the model's orientation.
 */
export const FACE_BONES = { leftEye: 'LeftEye', rightEye: 'RightEye', teeth: 'Teeth' } as const

/**
 * The face geometry's attribute holding rest-pose template-space positions, for shading that stays on the face as it moves. Lowercase
 * with a leading underscore, as glTF names custom attributes, so it keeps this name through a GLB export and reload.
 */
export const FACE_REST = '_facerest'

/**
 * The `userData` key the face rig sets on the face's material, the one over the eyes. A mark on the material rather than
 * an index into the mesh's materials, as it stays with the material when a GLB export and reload split the face into one
 * mesh per material.
 */
export const FACE_MATERIAL = 'faceMaterial'

export interface FaceResult {
  /** The bones the face rig added under the head (FACE_BONES): the eyes at the eyeball centers, and the teeth for teeth and tongue. */
  bones: SkeletonBone[]
  /** Every morph target the face rig baked: FaceData.shapes. */
  shapes: string[]
  /**
   * Per fitted landmark, how far (millimeters on a human-sized head) it lies from where the template's proportions
   * put it. Stylized faces differ by several millimeters, the jaw by tens; an outlier among its neighbors flags a
   * misplaced landmark.
   */
  deviation: Record<string, number>
}

/**
 * What the face rig leaves in the face geometry's `userData.face` for layers driving or shading it: template-space
 * positions of the features (all lateral values as |z|) and the shapes.
 */
export interface FaceData {
  eyeY: number; eyeZ: number; eyeHalfWidth: number
  browY: number; hairlineY: number; bridgeY: number
  wingY: number; wingZ: number
  cornerY: number; cornerZ: number
  /** The crease between lower lip and chin. */
  labiomentalY: number
  cheek: Anatomy['cheek']
  /**
   * Every morph target the face rig baked, on the `Face`, `Cavity`, `TeethLower` and `Tongue` meshes, each of which
   * carries those that move it; other morph targets are not the face's. They carry ARKit blendshape names: the jaw,
   * mouth, cheek, nose and brow shapes transferred from a reference head, the face's own `eyeBlink` and `eyeWide` lids
   * and `tongueOut`. Beyond ARKit: `cheekBulgeLeft/Right`, the cheek mass swelling; `tongueUp`; and `<name>_soft`, the
   * cheek part of the smile, stretch, upper-lip raise, sneer and dimple shapes. Weighted by a soft-tissue spring's lag
   * behind the full shape's weight (lagging minus current, so negative while the shape rises), `_soft` lets the cheek
   * trail the lips; plain ARKit drivers leave it at 0. Eye look directions are rotations of the eye bones (FACE_BONES),
   * not shapes.
   */
  shapes: string[]
}

const NUMBERS = ['eyeY', 'eyeZ', 'eyeHalfWidth', 'browY', 'hairlineY', 'bridgeY', 'wingY', 'wingZ', 'cornerY', 'cornerZ', 'labiomentalY'] as const satisfies readonly (keyof FaceData)[]

/** Whether `value`, such as a geometry's `userData.face`, has the shape of FaceData. */
export function isFaceData(value: unknown): value is FaceData {
  if (typeof value !== 'object' || value === null) return false
  const field = (key: keyof FaceData): unknown => Reflect.get(value, key)
  const cheek = field('cheek')
  return NUMBERS.every((key) => finite(field(key)))
    && strings(field('shapes'))
    && typeof cheek === 'object' && cheek !== null
    && 'y' in cheek && finite(cheek.y) && 'z' in cheek && finite(cheek.z) && 'fold' in cheek && numbers(cheek.fold, 4)
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const numbers = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every(finite)
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string')
