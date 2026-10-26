/** Whether a triangle soup encloses a solid, and how much. */

import { weld } from './soup.js'

/** Vertices this close, relative to the mesh's extent, are one: procedural seams can differ by rounding. */
const WELD_TOLERANCE = 1e-6

export interface Solid {
  /** Every edge a -> b is used once, and b -> a once: watertight and consistently wound. */
  closed: boolean
  /** Enclosed volume, exact for the triangles (divergence theorem); null when not closed. */
  volume: number | null
}

/**
 * Welds coincident vertices, skips degenerate triangles (they cover no surface), then checks the directed
 * edges and sums the signed tetrahedra. Inside-out parts subtract from the volume.
 */
export function solid(positions: Float32Array, indices: Uint32Array): Solid {
  const vertex = weld(positions, extent(positions) * WELD_TOLERANCE)
  const count = vertex.length
  const edges = new Map<number, number>()
  let sixfold = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = vertex[indices[t]], b = vertex[indices[t + 1]], c = vertex[indices[t + 2]]
    if (a === b || b === c || c === a) continue
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = from * count + to
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
    sixfold += tetrahedron(positions, a * 3, b * 3, c * 3)
  }
  const closed = edges.size > 0 && [...edges].every(([key, uses]) => {
    const reverse = (key % count) * count + Math.floor(key / count)
    return uses === 1 && edges.get(reverse) === 1
  })
  return { closed, volume: closed ? Math.abs(sixfold) / 6 : null }
}

/** a · (b × c): six times the signed volume of the tetrahedron (origin, a, b, c). */
function tetrahedron(p: Float32Array, a: number, b: number, c: number): number {
  const crossX = p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]
  const crossY = p[b + 2] * p[c] - p[b] * p[c + 2]
  const crossZ = p[b] * p[c + 1] - p[b + 1] * p[c]
  return p[a] * crossX + p[a + 1] * crossY + p[a + 2] * crossZ
}

/** The longest side of the bounding box. */
function extent(positions: Float32Array): number {
  let longest = 0
  for (let axis = 0; axis < 3; axis++) {
    let min = Infinity, max = -Infinity
    for (let i = axis; i < positions.length; i += 3) {
      min = Math.min(min, positions[i])
      max = Math.max(max, positions[i])
    }
    longest = Math.max(longest, max - min)
  }
  return longest
}
