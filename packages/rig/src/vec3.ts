/** World-space points and the point-to-segment math the solve and its warnings measure with. */

export type Vec3 = readonly [number, number, number]

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
}

/**
 * Where the point at `offset` in `positions` projects onto the line a -> b: 0 at a, 1 at b, unclamped
 * (0 for a zero-length segment).
 */
export function segmentParameter(positions: Float32Array, offset: number, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
  const len2 = abx * abx + aby * aby + abz * abz
  if (!(len2 > 0)) return 0
  return ((positions[offset] - a[0]) * abx + (positions[offset + 1] - a[1]) * aby + (positions[offset + 2] - a[2]) * abz) / len2
}

/** Squared distance from the point at `offset` in `positions` to the point at `t` along a -> b. */
export function distanceSqAt(positions: Float32Array, offset: number, a: Vec3, b: Vec3, t: number): number {
  const dx = positions[offset] - a[0] - (b[0] - a[0]) * t
  const dy = positions[offset + 1] - a[1] - (b[1] - a[1]) * t
  const dz = positions[offset + 2] - a[2] - (b[2] - a[2]) * t
  return dx * dx + dy * dy + dz * dz
}

/** Squared distance from the point at `offset` in `positions` to the segment a -> b. */
export function segmentDistanceSq(positions: Float32Array, offset: number, a: Vec3, b: Vec3): number {
  const t = Math.max(0, Math.min(1, segmentParameter(positions, offset, a, b)))
  return distanceSqAt(positions, offset, a, b, t)
}
