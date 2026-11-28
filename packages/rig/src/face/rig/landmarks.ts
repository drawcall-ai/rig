/** The surface points an agent places on a face, and where each sits on the template head. */

import * as THREE from 'three'
import type { Vec3 } from '../../vec3.js'
import { templateLipLine, type Template } from './template.js'

/**
 * Points on the face surface in world space, as skeleton joints are given, Left and Right as the character's own sides
 * (left = up × forward).
 * Place them on the visible skin, as a ray from the front would hit it.
 */
export interface FaceLandmarks {
  /** Inner (nasal) and outer corners of the eye opening. */
  eyeInnerLeft: Vec3; eyeInnerRight: Vec3; eyeOuterLeft: Vec3; eyeOuterRight: Vec3
  /** Highest and lowest point of the eye opening's rim at its middle. */
  lidUpperLeft: Vec3; lidUpperRight: Vec3; lidLowerLeft: Vec3; lidLowerRight: Vec3
  /** Brow above the inner eye corner, above the eye's middle, and above the outer eye corner. */
  browInnerLeft: Vec3; browInnerRight: Vec3; browMidLeft: Vec3; browMidRight: Vec3; browOuterLeft: Vec3; browOuterRight: Vec3
  /** Outer edge of the nose wing, at its widest. */
  noseWingLeft: Vec3; noseWingRight: Vec3
  /** Cheekbone below the outer eye corner, between eye and nose-tip height. */
  cheekLeft: Vec3; cheekRight: Vec3
  /** Jawline at chin height, below the outer eye corner. */
  jawLeft: Vec3; jawRight: Vec3
  /** Where the lips meet at the mouth's corners. */
  mouthCornerLeft: Vec3; mouthCornerRight: Vec3
  /** Where the lips meet at the midline: with the corners, it defines the mouth cut. */
  mouthCenter: Vec3
  /** Most forward point of the lower lip, of the chin, and of the nose tip. */
  lowerLip: Vec3; chin: Vec3; noseTip: Vec3
  /** Where the nose meets the upper lip. */
  subnasale: Vec3
  /** Bridge of the nose, just below eye level. */
  noseBridge: Vec3
  /** Between the brows, at inner-brow height. */
  glabella: Vec3
  /**
   * Where the forehead skin ends at the midline: below any fringe hanging in front of it, or for a bald head where the
   * forehead turns into the scalp. Nothing above it moves.
   */
  hairline: Vec3
}

export type Landmark = keyof FaceLandmarks
/** A landmark name without its side, for the landmarks placed on both sides. */
export type Paired = { [K in Landmark]: K extends `${infer P}Left` ? P : never }[Landmark]

/** Front-view (y, z) on the template of each landmark the fit uses; paired ones for the left (-z) side. */
const PAIRED: [Paired, number, number][] = [
  ['eyeInner', 1.690, -0.0195], ['eyeOuter', 1.692, -0.0455], ['lidUpper', 1.6975, -0.032], ['lidLower', 1.6865, -0.032],
  ['browInner', 1.707, -0.014], ['browMid', 1.711, -0.032], ['browOuter', 1.707, -0.05],
  ['noseWing', 1.652, -0.0175], ['cheek', 1.672, -0.048], ['jaw', 1.598, -0.052],
]
const MIDLINE: [Landmark, number][] = [['noseTip', 1.6625], ['noseBridge', 1.686], ['subnasale', 1.6455], ['lowerLip', 1.618], ['chin', 1.592], ['glabella', 1.704]]

/** Landmarks matched to the template; the hairline is the character's own and only bounds what moves. */
export const FITTED: Landmark[] = [
  ...PAIRED.flatMap(([n]): Landmark[] => [`${n}Left`, `${n}Right`]),
  ...MIDLINE.map(([n]) => n),
  'mouthCornerLeft', 'mouthCornerRight', 'mouthCenter',
]

export const ALL: Landmark[] = [...FITTED, 'hairline']

/** The template's position of every fitted landmark, in FITTED order. */
export function templateLandmarks(t: Template): THREE.Vector3[] {
  const ray = new THREE.Raycaster()
  const front = (y: number, z: number) => {
    ray.set(new THREE.Vector3(1, y, z), new THREE.Vector3(-1, 0, 0))
    const hit = ray.intersectObject(t.head, false)[0]
    if (!hit) throw new Error(`face: no template surface in front of y=${y} z=${z}`)
    return hit.point
  }
  const line = templateLipLine(t)
  const [cornerLeft, center, cornerRight] = [line[0], line[(line.length - 1) / 2], line[line.length - 1]]
  return [
    ...PAIRED.flatMap(([, y, z]) => [front(y, z), front(y, -z)]),
    ...MIDLINE.map(([, y]) => front(y, 0)),
    cornerLeft, cornerRight, center,
  ]
}

/** Throws unless `landmarks`, such as an agent's JSON, has every landmark as a finite point and nothing unknown. */
export function checkLandmarks(landmarks: unknown): asserts landmarks is FaceLandmarks {
  if (typeof landmarks !== 'object' || landmarks === null || Array.isArray(landmarks)) throw new Error(`face: landmarks must be an object of named points, got ${JSON.stringify(landmarks)}`)
  const given: Record<string, unknown> = { ...landmarks }
  const names: readonly string[] = ALL
  const unknown = Object.keys(given).filter((name) => !names.includes(name))
  if (unknown.length) throw new Error(`face: unknown landmarks ${unknown.join(', ')}; the landmarks are ${ALL.join(', ')}`)
  const missing = ALL.filter((name) => !(name in given))
  if (missing.length) throw new Error(`face: missing landmarks ${missing.join(', ')}`)
  for (const name of ALL) {
    const p = given[name]
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) throw new Error(`face: landmark ${name} must be finite [x, y, z], got ${JSON.stringify(p)}`)
  }
}
