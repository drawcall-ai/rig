/**
 * Separate mesh pieces of a triangle soup: vertices connected through
 * triangles, with coincident vertices merged so UV and normal seams don't
 * split a piece.
 */

import type * as THREE from 'three'
import type { Vec3 } from '../vec3.js'
import { gather } from './soup.js'
import { meshPieces } from './topology.js'

export interface Piece {
  /** Index to use in bone.userData.pieces. */
  index: number
  /** Name of one mesh contributing to this connected component. */
  mesh: string
  vertices: number
  min: Vec3
  max: Vec3
  /** Mean of the vertex positions. */
  center: Vec3
}

/**
 * Connected geometry components, largest first, in world space. Coincident vertices join components
 * across UV seams and mesh boundaries. A component can span several articulations; connectivity
 * alone does not imply rigidity.
 */
export function pieces(object: THREE.Object3D): Piece[] {
  const soup = gather(object)
  return meshPieces(soup.positions, soup.indices).map(({ vertices, min, max, center }, index) => {
    const mesh = soup.meshes[soup.offsets.findLastIndex((offset) => offset <= vertices[0])]
    return { index, mesh: mesh.name, vertices: vertices.length, min, max, center }
  })
}
