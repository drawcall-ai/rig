/**
 * Cross-sections of a voxel volume: the separate solid regions where a plane
 * cuts the model, with world-space centers and extents (joint positions).
 */

import type { VoxelVolume } from './voxelize.js'

export type Axis = 'x' | 'y' | 'z'

export interface Slice {
  axis: Axis
  /** World coordinate of the cutting plane. */
  value: number
}

const AXES: Axis[] = ['x', 'y', 'z']
/** In-plane axes per cut axis. */
const SCREEN: Record<Axis, [Axis, Axis]> = { x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y'] }

export interface SliceRegion {
  /** Solid cells in the region (area = cells * cellSize^2). */
  cells: number
  /** World-space [x, y, z] center and bounds; the cut axis holds the plane's value. Usable as a joint position. */
  center: [number, number, number]
  min: [number, number, number]
  max: [number, number, number]
}

export interface SliceResult {
  axis: Axis
  /** World coordinate of the cell layer actually cut (the one containing the requested value). */
  value: number
  /** Separate solid regions, largest first. */
  regions: SliceRegion[]
}

/** Connected solid regions (8-connected) of one cell layer of the volume; null outside the volume. */
export function sliceRegions(volume: VoxelVolume, slice: Slice): SliceResult | null {
  return sliceGrid(volume, slice)?.result ?? null
}

function sliceGrid(volume: VoxelVolume, slice: Slice) {
  const a = AXES.indexOf(slice.axis)
  const [h, v] = SCREEN[slice.axis]
  const index = Math.floor((slice.value - volume.min[a]) / volume.cellSize)
  if (index < 0 || index >= volume.dimensions[a]) return null
  const hi = AXES.indexOf(h)
  const vi = AXES.indexOf(v)
  const width = volume.dimensions[hi]
  const height = volume.dimensions[vi]
  const cell = [0, 0, 0]
  cell[a] = index
  const isInside = (x: number, y: number): boolean => {
    cell[hi] = x
    cell[vi] = y
    return volume.isInsideFlat[cell[0] * volume.dimensions[1] * volume.dimensions[2] + cell[1] * volume.dimensions[2] + cell[2]] === 1
  }

  const found = new Int32Array(width * height).fill(-1)
  const lists: number[][] = []
  for (let start = 0; start < width * height; start++) {
    if (found[start] >= 0 || !isInside(start % width, Math.floor(start / width))) continue
    const cells = [start]
    found[start] = lists.length
    for (let i = 0; i < cells.length; i++) {
      const cx = cells[i] % width
      const cy = Math.floor(cells[i] / width)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const n = ny * width + nx
          if (found[n] >= 0 || !isInside(nx, ny)) continue
          found[n] = lists.length
          cells.push(n)
        }
      }
    }
    lists.push(cells)
  }
  // Rank regions largest first; `rank` maps each cell to its region's rank
  const order = lists.map((_, i) => i).sort((p, q) => lists[q].length - lists[p].length)
  const rankOf = new Int32Array(lists.length)
  order.forEach((r, rank) => (rankOf[r] = rank))
  const rank = found.map((r) => (r >= 0 ? rankOf[r] : -1))

  const world = (axis: number, cellIndex: number): number => volume.min[axis] + (cellIndex + 0.5) * volume.cellSize
  const point = (hValue: number, vValue: number): [number, number, number] => {
    const p: [number, number, number] = [0, 0, 0]
    p[a] = world(a, index)
    p[hi] = hValue
    p[vi] = vValue
    return p
  }
  const crop: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity]
  const regions = order.map((r): SliceRegion => {
    let sumH = 0, sumV = 0
    let minH = Infinity, maxH = -Infinity, minV = Infinity, maxV = -Infinity
    for (const c of lists[r]) {
      const x = c % width
      const y = Math.floor(c / width)
      sumH += x
      sumV += y
      minH = Math.min(minH, x); maxH = Math.max(maxH, x)
      minV = Math.min(minV, y); maxV = Math.max(maxV, y)
    }
    crop[0] = Math.min(crop[0], minH); crop[1] = Math.max(crop[1], maxH)
    crop[2] = Math.min(crop[2], minV); crop[3] = Math.max(crop[3], maxV)
    const n = lists[r].length
    return {
      cells: n,
      center: point(world(hi, sumH / n), world(vi, sumV / n)),
      min: point(world(hi, minH), world(vi, minV)),
      max: point(world(hi, maxH), world(vi, maxV)),
    }
  })
  const result: SliceResult = { axis: slice.axis, value: world(a, index), regions }
  return { result, h, v, width, height, rank, crop }
}

