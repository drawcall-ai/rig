/**
 * Vendored CPU reference — voxelization.
 *
 * Source: /Users/bela/Documents/drawcall.ai/character/packages/rigged/src/voxel-volume.ts
 * Adaptations (behavior-preserving):
 * - Takes raw positions/indices instead of a THREE.Mesh (caller pre-applies matrixWorld).
 * - THREE.Triangle.intersectsBox replaced by a faithful port of three r170
 *   Box3.intersectsTriangle (identical SAT axis order and comparisons).
 * - Nested boolean[][][] proxies dropped; only the flat arrays are exposed.
 */

export interface VoxelVolume {
  /** Bounding box min corner in world space */
  min: [number, number, number]
  /** The size of each cubic cell */
  cellSize: number
  /** The number of cells in each dimension [x, y, z] */
  dimensions: [number, number, number]
  /** Flat grid: 1 where a triangle touches the cell */
  isSurfaceFlat: Uint8Array
  /** Flat grid: 1 where the cell is on or inside the surface */
  isInsideFlat: Uint8Array
  /** Flat indices of inside voxels */
  insideIndices: Uint32Array
}

export interface VoxelVolumeOptions {
  /** Number of cells along the longest axis (default: 256) */
  resolution?: number
}

export function computeVoxelVolume(
  positions: Float32Array,
  indices: Uint32Array,
  options: VoxelVolumeOptions = {},
): VoxelVolume {
  const { resolution = 256 } = options

  const bounds = computeBounds(positions)
  const size = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ]
  const maxDimension = Math.max(size[0], size[1], size[2])
  const cellSize = maxDimension / resolution
  const dimensions: [number, number, number] = [
    Math.ceil(size[0] / cellSize),
    Math.ceil(size[1] / cellSize),
    Math.ceil(size[2] / cellSize),
  ]

  const isSurfaceFlat = computeSurfaceVoxelsFast(bounds.min, dimensions, cellSize, positions, indices)
  const isInsideFlat = findInteriorVoxelsFast(isSurfaceFlat, dimensions)

  const totalVoxels = dimensions[0] * dimensions[1] * dimensions[2]
  const insideList: number[] = []
  for (let i = 0; i < totalVoxels; i++) {
    if (isInsideFlat[i]) insideList.push(i)
  }

  return {
    min: bounds.min,
    cellSize,
    dimensions,
    isSurfaceFlat,
    isInsideFlat,
    insideIndices: new Uint32Array(insideList),
  }
}

function computeBounds(positions: Float32Array): {
  min: [number, number, number]
  max: [number, number, number]
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]
      if (v < min[a]) min[a] = v
      if (v > max[a]) max[a] = v
    }
  }
  return { min, max }
}

/**
 * Find voxels that intersect mesh triangles by iterating triangles.
 * Direct vertex containment check (fast) before triangle-box intersection (slow).
 */
function computeSurfaceVoxelsFast(
  min: [number, number, number],
  [dimX, dimY, dimZ]: [number, number, number],
  cellSize: number,
  positions: Float32Array,
  indices: Uint32Array,
): Uint8Array {
  const [minX, minY, minZ] = min
  const invCellSize = 1 / cellSize

  const surfaceFlat = new Uint8Array(dimX * dimY * dimZ)
  const dimYZ = dimY * dimZ

  const numFaces = indices.length / 3

  for (let f = 0; f < numFaces; f++) {
    const i0 = indices[f * 3] * 3
    const i1 = indices[f * 3 + 1] * 3
    const i2 = indices[f * 3 + 2] * 3
    const v0x = positions[i0], v0y = positions[i0 + 1], v0z = positions[i0 + 2]
    const v1x = positions[i1], v1y = positions[i1 + 1], v1z = positions[i1 + 2]
    const v2x = positions[i2], v2y = positions[i2 + 1], v2z = positions[i2 + 2]

    const triMinX = Math.min(v0x, v1x, v2x)
    const triMinY = Math.min(v0y, v1y, v2y)
    const triMinZ = Math.min(v0z, v1z, v2z)
    const triMaxX = Math.max(v0x, v1x, v2x)
    const triMaxY = Math.max(v0y, v1y, v2y)
    const triMaxZ = Math.max(v0z, v1z, v2z)

    const minVoxelX = Math.max(0, Math.floor((triMinX - minX) * invCellSize))
    const minVoxelY = Math.max(0, Math.floor((triMinY - minY) * invCellSize))
    const minVoxelZ = Math.max(0, Math.floor((triMinZ - minZ) * invCellSize))
    const maxVoxelX = Math.min(dimX - 1, Math.floor((triMaxX - minX) * invCellSize))
    const maxVoxelY = Math.min(dimY - 1, Math.floor((triMaxY - minY) * invCellSize))
    const maxVoxelZ = Math.min(dimZ - 1, Math.floor((triMaxZ - minZ) * invCellSize))

    // Quick check: if triangle spans only 1 voxel in each dimension, just mark it
    if (minVoxelX === maxVoxelX && minVoxelY === maxVoxelY && minVoxelZ === maxVoxelZ) {
      surfaceFlat[minVoxelX * dimYZ + minVoxelY * dimZ + minVoxelZ] = 1
      continue
    }

    for (let x = minVoxelX; x <= maxVoxelX; x++) {
      const voxelMinX = minX + x * cellSize
      const voxelMaxX = voxelMinX + cellSize

      for (let y = minVoxelY; y <= maxVoxelY; y++) {
        const voxelMinY = minY + y * cellSize
        const voxelMaxY = voxelMinY + cellSize

        for (let z = minVoxelZ; z <= maxVoxelZ; z++) {
          const idx = x * dimYZ + y * dimZ + z
          if (surfaceFlat[idx]) continue // Already marked

          const voxelMinZ = minZ + z * cellSize
          const voxelMaxZ = voxelMinZ + cellSize

          // Fast check: does any vertex fall in this voxel?
          const v0InBox =
            v0x >= voxelMinX && v0x <= voxelMaxX &&
            v0y >= voxelMinY && v0y <= voxelMaxY &&
            v0z >= voxelMinZ && v0z <= voxelMaxZ
          const v1InBox =
            v1x >= voxelMinX && v1x <= voxelMaxX &&
            v1y >= voxelMinY && v1y <= voxelMaxY &&
            v1z >= voxelMinZ && v1z <= voxelMaxZ
          const v2InBox =
            v2x >= voxelMinX && v2x <= voxelMaxX &&
            v2y >= voxelMinY && v2y <= voxelMaxY &&
            v2z >= voxelMinZ && v2z <= voxelMaxZ

          if (v0InBox || v1InBox || v2InBox) {
            surfaceFlat[idx] = 1
          } else if (
            triangleIntersectsBox(
              v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z,
              voxelMinX, voxelMinY, voxelMinZ, voxelMaxX, voxelMaxY, voxelMaxZ,
            )
          ) {
            surfaceFlat[idx] = 1
          }
        }
      }
    }
  }

  return surfaceFlat
}

/**
 * Port of three r170 Box3.intersectsTriangle (SAT). Axis order and the strict `> r`
 * separating test match three exactly so results are bit-identical to the original.
 */
function triangleIntersectsBox(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  boxMinX: number, boxMinY: number, boxMinZ: number,
  boxMaxX: number, boxMaxY: number, boxMaxZ: number,
): boolean {
  // compute box center and extents
  const centerX = (boxMinX + boxMaxX) * 0.5
  const centerY = (boxMinY + boxMaxY) * 0.5
  const centerZ = (boxMinZ + boxMaxZ) * 0.5
  const extX = boxMaxX - centerX
  const extY = boxMaxY - centerY
  const extZ = boxMaxZ - centerZ

  // translate triangle to aabb origin
  const v0x = ax - centerX, v0y = ay - centerY, v0z = az - centerZ
  const v1x = bx - centerX, v1y = by - centerY, v1z = bz - centerZ
  const v2x = cx - centerX, v2y = cy - centerY, v2z = cz - centerZ

  // compute edge vectors for triangle
  const f0x = v1x - v0x, f0y = v1y - v0y, f0z = v1z - v0z
  const f1x = v2x - v1x, f1y = v2y - v1y, f1z = v2z - v1z
  const f2x = v0x - v2x, f2y = v0y - v2y, f2z = v0z - v2z

  const sat = (tx: number, ty: number, tz: number): boolean => {
    const r = extX * Math.abs(tx) + extY * Math.abs(ty) + extZ * Math.abs(tz)
    const p0 = v0x * tx + v0y * ty + v0z * tz
    const p1 = v1x * tx + v1y * ty + v1z * tz
    const p2 = v2x * tx + v2y * ty + v2z * tz
    return Math.max(-Math.max(p0, p1, p2), Math.min(p0, Math.min(p1, p2))) <= r
  }

  // 9 cross-product axes (edge x aabb axes), same order as three
  if (!sat(0, -f0z, f0y)) return false
  if (!sat(0, -f1z, f1y)) return false
  if (!sat(0, -f2z, f2y)) return false
  if (!sat(f0z, 0, -f0x)) return false
  if (!sat(f1z, 0, -f1x)) return false
  if (!sat(f2z, 0, -f2x)) return false
  if (!sat(-f0y, f0x, 0)) return false
  if (!sat(-f1y, f1x, 0)) return false
  if (!sat(-f2y, f2x, 0)) return false

  // 3 face normals from the aabb
  if (!sat(1, 0, 0)) return false
  if (!sat(0, 1, 0)) return false
  if (!sat(0, 0, 1)) return false

  // triangle face normal
  const nx = f0y * f1z - f0z * f1y
  const ny = f0z * f1x - f0x * f1z
  const nz = f0x * f1y - f0y * f1x
  return sat(nx, ny, nz)
}

/**
 * Find interior voxels using scan-line approach: a voxel is inside when it has
 * surface in all 6 axis directions, or is itself a surface voxel.
 */
function findInteriorVoxelsFast(
  surfaceFlat: Uint8Array,
  [dimX, dimY, dimZ]: [number, number, number],
): Uint8Array {
  const totalVoxels = dimX * dimY * dimZ
  const dimYZ = dimY * dimZ

  const flags = new Uint8Array(totalVoxels)

  // Scan X direction
  for (let y = 0; y < dimY; y++) {
    for (let z = 0; z < dimZ; z++) {
      const yzOffset = y * dimZ + z
      let found = false
      for (let x = dimX - 1; x >= 0; x--) {
        const idx = x * dimYZ + yzOffset
        if (surfaceFlat[idx]) found = true
        if (found) flags[idx] |= 1
      }
      found = false
      for (let x = 0; x < dimX; x++) {
        const idx = x * dimYZ + yzOffset
        if (surfaceFlat[idx]) found = true
        if (found) flags[idx] |= 2
      }
    }
  }

  // Scan Y direction
  for (let x = 0; x < dimX; x++) {
    for (let z = 0; z < dimZ; z++) {
      const xOffset = x * dimYZ
      let found = false
      for (let y = dimY - 1; y >= 0; y--) {
        const idx = xOffset + y * dimZ + z
        if (surfaceFlat[idx]) found = true
        if (found) flags[idx] |= 4
      }
      found = false
      for (let y = 0; y < dimY; y++) {
        const idx = xOffset + y * dimZ + z
        if (surfaceFlat[idx]) found = true
        if (found) flags[idx] |= 8
      }
    }
  }

  // Scan Z direction
  for (let x = 0; x < dimX; x++) {
    for (let y = 0; y < dimY; y++) {
      const xyOffset = x * dimYZ + y * dimZ
      let found = false
      for (let z = dimZ - 1; z >= 0; z--) {
        const idx = xyOffset + z
        if (surfaceFlat[idx]) found = true
        if (found) flags[idx] |= 16
      }
      found = false
      for (let z = 0; z < dimZ; z++) {
        const idx = xyOffset + z
        if (surfaceFlat[idx]) found = true
        if (found) flags[idx] |= 32
      }
    }
  }

  const isInsideFlat = new Uint8Array(totalVoxels)
  for (let i = 0; i < totalVoxels; i++) {
    if (surfaceFlat[i] || flags[i] === 63) {
      isInsideFlat[i] = 1
    }
  }

  return isInsideFlat
}

export function isValidCell(x: number, y: number, z: number, dimensions: [number, number, number]): boolean {
  const [dimX, dimY, dimZ] = dimensions
  return x >= 0 && x < dimX && y >= 0 && y < dimY && z >= 0 && z < dimZ
}
