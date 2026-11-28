/** Keeps the piece indices of a requested skeleton meaning the model as created while the face rig reshapes it. */

import type * as THREE from 'three'
import { gather, type Soup } from '../measure/soup.js'
import { meshPieces } from '../measure/topology.js'
import type { SkeletonBone } from '../skin/skeleton.js'

/** Origin of a vertex that the face rig added. */
const ADDED = -1

/**
 * Snapshots the pieces of `object` before the face rig and returns a function that re-indexes bones' `pieces` from that
 * snapshot to the pieces of `object` after it. The face rig keeps the geometry of every mesh but the face, so a piece
 * follows through the vertices of kept geometry, and through the rebuilt face mesh only when the piece held all of it. Fails
 * when a requested piece shares the face mesh with other pieces, or when the face rig joins it with another piece.
 */
export function followPieces(object: THREE.Object3D): (bones: readonly SkeletonBone[]) => SkeletonBone[] {
  const before = gather(object)
  const geometries = before.meshes.map((mesh) => mesh.geometry)
  const { owners, count } = pieceOwners(before)
  return (bones) => {
    const after = gather(object)
    // per vertex after the face rig, the piece before it that the vertex comes from
    const origins = new Int32Array(after.positions.length / 3).fill(ADDED)
    const split = new Map<number, string>()
    before.meshes.forEach((mesh, m) => {
      const a = after.meshes.indexOf(mesh)
      if (a < 0) throw new Error(`face rig removed mesh "${mesh.name}"`)
      const length = geometries[m].getAttribute('position').count
      const from = owners.subarray(before.offsets[m], before.offsets[m] + length)
      if (mesh.geometry === geometries[m]) {
        origins.set(from, after.offsets[a])
        return
      }
      const held = new Set(from)
      const rebuilt = mesh.geometry.getAttribute('position').count
      if (held.size === 1) origins.fill(from[0], after.offsets[a], after.offsets[a] + rebuilt)
      else for (const piece of held) split.set(piece, mesh.name)
    })
    const pieces = meshPieces(after.positions, after.indices)
    const sources = pieces.map(({ vertices }) => new Set(vertices.map((v) => origins[v]).filter((origin) => origin !== ADDED)))
    const follow = (index: number, bone: string): number[] => {
      if (index >= count) throw new Error(`bone "${bone}" names piece ${index}, but the model has ${count} pieces (0..${count - 1})`)
      const mesh = split.get(index)
      if (mesh !== undefined) throw new Error(`bone "${bone}" names piece ${index}, which shares mesh "${mesh}" with other pieces, and the face rig rebuilds that mesh's geometry; separate the piece into a mesh of its own`)
      const followed = sources.flatMap((source, p) => (source.has(index) ? [p] : []))
      for (const p of followed) {
        if (sources[p].size > 1) throw new Error(`bone "${bone}" names piece ${index}, which the face rig joins with pieces ${[...sources[p]].filter((s) => s !== index).join(', ')}`)
      }
      return followed
    }
    return bones.map((bone) => (bone.pieces ? { ...bone, pieces: bone.pieces.flatMap((index) => follow(index, bone.name)) } : bone))
  }
}

/** The piece of each vertex of the soup, and how many pieces it has. */
function pieceOwners(soup: Soup): { owners: Int32Array; count: number } {
  const owners = new Int32Array(soup.positions.length / 3)
  const pieces = meshPieces(soup.positions, soup.indices)
  pieces.forEach(({ vertices }, piece) => {
    for (const v of vertices) owners[v] = piece
  })
  return { owners, count: pieces.length }
}
