/**
 * Synthetic capsule mesh + bone chain for tests: a Y-axis capsule (cylinder with
 * hemispherical caps) built from latitude rings, ~2k vertices.
 */

import type { BoneLine } from './reference/bone-assignment.js'

export interface CapsuleMesh {
  positions: Float32Array
  indices: Uint32Array
}

export interface CapsuleOptions {
  radius?: number
  /** Half-length of the cylindrical section */
  halfLength?: number
  radialSegments?: number
  capRings?: number
  bodyRings?: number
}

export function makeCapsule(options: CapsuleOptions = {}): CapsuleMesh {
  const { radius = 0.3, halfLength = 0.7, radialSegments = 36, capRings = 10, bodyRings = 34 } = options

  // Profile from top pole to bottom pole: (y, ringRadius) pairs.
  const profile: Array<[number, number]> = []
  for (let i = 1; i <= capRings; i++) {
    const theta = (i / capRings) * (Math.PI / 2)
    profile.push([halfLength + radius * Math.cos(theta), radius * Math.sin(theta)])
  }
  for (let i = 1; i < bodyRings; i++) {
    profile.push([halfLength - (i / bodyRings) * 2 * halfLength, radius])
  }
  for (let i = 0; i < capRings; i++) {
    const theta = Math.PI / 2 + (i / capRings) * (Math.PI / 2)
    profile.push([-halfLength + radius * Math.cos(theta), radius * Math.sin(theta)])
  }

  const positions: number[] = []
  const indices: number[] = []

  const topPole = 0
  positions.push(0, halfLength + radius, 0)
  for (const [y, r] of profile) {
    for (let s = 0; s < radialSegments; s++) {
      const phi = (s / radialSegments) * 2 * Math.PI
      positions.push(r * Math.cos(phi), y, r * Math.sin(phi))
    }
  }
  const bottomPole = positions.length / 3
  positions.push(0, -(halfLength + radius), 0)

  const ringStart = (ring: number): number => 1 + ring * radialSegments

  for (let s = 0; s < radialSegments; s++) {
    const next = (s + 1) % radialSegments
    indices.push(topPole, ringStart(0) + next, ringStart(0) + s)
  }
  for (let ring = 0; ring < profile.length - 1; ring++) {
    for (let s = 0; s < radialSegments; s++) {
      const next = (s + 1) % radialSegments
      const a = ringStart(ring) + s
      const b = ringStart(ring) + next
      const c = ringStart(ring + 1) + s
      const d = ringStart(ring + 1) + next
      indices.push(a, b, c, b, d, c)
    }
  }
  const lastRing = profile.length - 1
  for (let s = 0; s < radialSegments; s++) {
    const next = (s + 1) % radialSegments
    indices.push(bottomPole, ringStart(lastRing) + s, ringStart(lastRing) + next)
  }

  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

/** A 4-bone chain along the capsule axis; the last one terminal to cover that branch. */
export function makeCapsuleBones(): BoneLine[] {
  return [
    { boneIndex: 0, isTerminal: false, start: [0, -0.95, 0], end: [0, -0.35, 0] },
    { boneIndex: 1, isTerminal: false, start: [0, -0.35, 0], end: [0, 0.0, 0] },
    { boneIndex: 2, isTerminal: false, start: [0, 0.0, 0], end: [0, 0.35, 0] },
    { boneIndex: 3, isTerminal: true, start: [0, 0.35, 0], end: [0, 0.95, 0] },
  ]
}
