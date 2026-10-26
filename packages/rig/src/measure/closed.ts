import { weld } from './pieces.js'

/** Vertices this close, relative to the mesh's extent, are one: procedural seams can differ by rounding. */
const WELD_TOLERANCE = 1e-6

/**
 * Whether a triangle soup is watertight: after merging coincident vertices, every edge is shared by
 * exactly two triangles. Degenerate triangles cover no surface and are skipped. Solids touching along
 * an edge (four triangles there) count as open.
 */
export function isClosed(positions: Float32Array, indices: Uint32Array): boolean {
  const vertex = weld(positions, extent(positions) * WELD_TOLERANCE)
  const count = vertex.length
  const edges = new Map<number, number>()
  for (let t = 0; t < indices.length; t += 3) {
    const a = vertex[indices[t]], b = vertex[indices[t + 1]], c = vertex[indices[t + 2]]
    if (a === b || b === c || c === a) continue
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(from, to) * count + Math.max(from, to)
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  return edges.size > 0 && [...edges.values()].every((uses) => uses === 2)
}

/** The longest side of the bounding box. */
function extent(positions: Float32Array): number {
  let longest = 0
  for (let a = 0; a < 3; a++) {
    let min = Infinity, max = -Infinity
    for (let i = a; i < positions.length; i += 3) {
      min = Math.min(min, positions[i])
      max = Math.max(max, positions[i])
    }
    longest = Math.max(longest, max - min)
  }
  return longest
}
