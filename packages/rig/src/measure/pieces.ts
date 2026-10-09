/**
 * Separate mesh pieces of a triangle soup: vertices connected through
 * triangles, with coincident vertices merged so UV and normal seams don't
 * split a piece.
 */

import type * as THREE from 'three'
import type { Vec3 } from '../vec3.js'
import { gather } from './soup.js'

export interface Piece {
  /** Index to use in bone.userData.pieces. */
  index: number
  /** Name of the mesh the piece belongs to. */
  mesh: string
  vertices: number
  min: Vec3
  max: Vec3
  /** Mean of the vertex positions. */
  center: Vec3
}

/** Separate mesh pieces (props, armor, eyes, glasses), largest first, in world space. */
export function pieces(object: THREE.Object3D): Piece[] {
  const soup = gather(object)
  return meshPieces(soup.positions, soup.indices).map(({ vertices, min, max, center }, index) => {
    const mesh = soup.meshes[soup.offsets.findLastIndex((offset) => offset <= vertices[0])]
    return { index, mesh: mesh.name, vertices: vertices.length, min, max, center }
  })
}

export interface MeshPiece {
  /** Vertex indices into the soup's positions. */
  vertices: number[]
  min: Vec3
  max: Vec3
  /** Mean of the vertex positions. */
  center: Vec3
}

/** Largest first; indices into this list name pieces in `SkeletonBone.pieces`. */
export function meshPieces(positions: Float32Array, indices: Uint32Array): MeshPiece[] {
  const root = connect(positions, indices)
  const grouped = new Map<number, { vertices: number[]; min: number[]; max: number[]; sum: number[] }>()
  for (let v = 0; v < root.length; v++) {
    let piece = grouped.get(root[v])
    if (!piece) {
      piece = { vertices: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], sum: [0, 0, 0] }
      grouped.set(root[v], piece)
    }
    piece.vertices.push(v)
    for (let a = 0; a < 3; a++) {
      const p = positions[v * 3 + a]
      piece.min[a] = Math.min(piece.min[a], p)
      piece.max[a] = Math.max(piece.max[a], p)
      piece.sum[a] += p
    }
  }
  const pieces = [...grouped.values()].map(({ vertices, min, max, sum }): MeshPiece => ({
    vertices,
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
    center: [sum[0] / vertices.length, sum[1] / vertices.length, sum[2] / vertices.length],
  }))
  // Ties broken by position so the order is stable across runs
  return pieces.sort((p, q) => q.vertices.length - p.vertices.length || p.min[0] - q.min[0] || p.min[1] - q.min[1] || p.min[2] - q.min[2])
}

/** Union-find over triangles and coincident positions: one root vertex per vertex, shared within a piece. */
function connect(positions: Float32Array, indices: Uint32Array): Int32Array {
  const count = positions.length / 3
  const parent = new Int32Array(count).map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b)
  }
  const byPosition = new Map<string, number>()
  for (let v = 0; v < count; v++) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`
    const first = byPosition.get(key)
    if (first === undefined) byPosition.set(key, v)
    else union(v, first)
  }
  for (let t = 0; t < indices.length; t += 3) {
    union(indices[t], indices[t + 1])
    union(indices[t], indices[t + 2])
  }
  return parent.map((_, v) => find(v))
}
