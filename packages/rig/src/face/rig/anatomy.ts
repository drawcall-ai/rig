/**
 * The face's features in template space, derived from its landmarks. Positions follow the landmarks; sizes are those of
 * a human head (template meters). The left side lies at -z.
 */

import * as THREE from 'three'
import type { FaceLandmarks, Landmark, Paired } from './landmarks.js'

export interface Eye {
  /** Center of the opening on the front view. */
  y: number; z: number
  halfHeight: number
  /** Half widths toward the nose and toward the outer corner. */
  innerHalfWidth: number; outerHalfWidth: number
  /** Eyeball radius; its center is filled in once the skin in front is known. */
  radius: number
  center: THREE.Vector3
}

export interface Anatomy {
  mouth: {
    center: THREE.Vector3
    /** Lateral z of the left (-z) and right corner. */
    left: number; right: number
    /** The lip line's height at z. */
    line: (z: number) => number
  }
  /** Left, then right. */
  eyes: [Eye, Eye]
  /** Height of the eye openings' centers, averaged over both eyes. */
  eyeY: number
  /** Landmark points in template space. */
  point: (name: Landmark) => THREE.Vector3
  /** A paired landmark mirrored to the right (+z) and averaged over both sides. */
  mirrored: (name: Paired) => { y: number; z: number }
  /** Height of the hairline at lateral z: nothing above it moves. */
  hairline: (z: number) => number
  /** The cheek mass, mirrored to |z|: its apex, and the nasolabial line from below the nose wing to beside the mouth corner [z0, y0, z1, y1]. */
  cheek: { y: number; z: number; fold: [number, number, number, number] }
}

/** A human eyeball radius. */
const EYEBALL = 0.0124

/** `toTemplate` takes world space, where landmarks are given, to template space. */
export function anatomy(landmarks: FaceLandmarks, toTemplate: THREE.Matrix4): Anatomy {
  const point = (name: Landmark) => new THREE.Vector3(...landmarks[name]).applyMatrix4(toTemplate)
  const center = point('mouthCenter'), left = point('mouthCornerLeft'), right = point('mouthCornerRight')
  const line = parabola([left.z, left.y], [center.z, center.y], [right.z, right.y])
  const eye = (side: 'Left' | 'Right'): Eye => {
    const inner = point(`eyeInner${side}`), outer = point(`eyeOuter${side}`), upper = point(`lidUpper${side}`), lower = point(`lidLower${side}`)
    const z = (inner.z + outer.z) / 2
    // a coarse mesh cuts whole triangles, so the cut ellipse sits inside the visible corners, most at the outer one where the face turns away
    const innerHalfWidth = Math.abs(inner.z - z) * 0.93, outerHalfWidth = Math.abs(outer.z - z) * 0.68
    const radius = Math.max(EYEBALL, 1.05 * innerHalfWidth)
    return { y: (upper.y + lower.y) / 2, z, halfHeight: (upper.y - lower.y) / 2 * 1.04, innerHalfWidth, outerHalfWidth, radius, center: new THREE.Vector3() }
  }
  const hair = point('hairline')
  const mirrored = (name: Paired) => {
    const l = point(`${name}Left`), r = point(`${name}Right`)
    return { y: (l.y + r.y) / 2, z: (r.z - l.z) / 2 }
  }
  const cheek = mirrored('cheek'), wing = mirrored('noseWing'), corner = mirrored('mouthCorner')
  const eyes: [Eye, Eye] = [eye('Left'), eye('Right')]
  return {
    mouth: { center, left: left.z, right: right.z, line },
    eyes,
    eyeY: (eyes[0].y + eyes[1].y) / 2,
    point,
    mirrored,
    hairline: (z) => hair.y + 0.0073 * ((z - hair.z) / 0.0545) ** 2,
    cheek: { y: cheek.y - 0.0023, z: cheek.z - 0.0099, fold: [wing.z + 0.0037, wing.y - 0.0011, corner.z + 0.0118, corner.y - 0.0051] },
  }
}

/** The quadratic y(z) through three points. */
function parabola([z0, y0]: [number, number], [z1, y1]: [number, number], [z2, y2]: [number, number]): (z: number) => number {
  return (z) => y0 * ((z - z1) * (z - z2)) / ((z0 - z1) * (z0 - z2)) + y1 * ((z - z0) * (z - z2)) / ((z1 - z0) * (z1 - z2)) + y2 * ((z - z0) * (z - z1)) / ((z2 - z0) * (z2 - z1))
}
