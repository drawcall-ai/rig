/**
 * Cross-sections of a voxel volume: the separate solid regions where a plane
 * cuts the model, with world-space centers and extents (joint positions).
 */

import type * as THREE from 'three'
import { gather } from './soup.js'
import { checkResolution, computeVoxelVolume, isInside, type VoxelVolume } from './voxelize.js'

export type Axis = 'x' | 'y' | 'z'

export const AXES: Axis[] = ['x', 'y', 'z']
/** In-plane axes per cut axis. */
const SCREEN: Record<Axis, [Axis, Axis]> = { x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y'] }

export interface Region {
  /** Solid cells in the region (area = cells * cellSize^2). */
  cells: number
  /** World-space [x, y, z] centroid and bounds; the cut axis holds the cut layer's `value`. Usable as a joint position. */
  center: [number, number, number]
  min: [number, number, number]
  max: [number, number, number]
}

export interface Section {
  axis: Axis
  /** World coordinate of the cell layer actually cut (the one containing the requested value), or the requested value when the plane lies outside the volume. */
  value: number
  /** Separate solid regions, largest first; empty when the plane misses the solid. */
  regions: Region[]
}

/** A cutting plane, given by its one axis: { y: 0.5 } is the plane y = 0.5. */
export type Plane = { x: number } | { y: number } | { z: number }

/**
 * The solid regions where each plane cuts the scene, e.g. section(scene, [{ y: 0.3 }, { y: 0.6 }]): one
 * result per plane, in order, from one voxelization. A result is { axis, value, regions }: value = the voxel
 * layer actually cut (the requested value when the plane lies outside the model's bounds), regions = the
 * separate solids, largest first, empty when the plane misses. Each region has world [x, y, z] center (its
 * centroid), min and max (the cut axis at the cut layer) and cells; at knee height one region per leg.
 * Measures the scene in its current pose. Resolution = voxels along the longest axis (default 128).
 */
export function section(object: THREE.Object3D, planes: Plane[], resolution = 128): Section[] {
  const cuts = planesOf(planes)
  checkResolution(resolution, 'section(scene, [{ y: 0.5 }], 256)')
  const soup = gather(object)
  const volume = computeVoxelVolume(soup.positions, soup.indices, { resolution })
  return cuts.map(([axis, value]) => cut(volume, axis, value))
}

/** Each plane's axis and value; throws unless `planes` is a non-empty list and each names exactly one of x, y, z with a number. */
function planesOf(planes: Plane[]): [Axis, number][] {
  if (!Array.isArray(planes) || planes.length === 0) {
    throw new Error(`section takes a non-empty list of planes, each named by its axis, e.g. section(scene, [{ y: 0.3 }, { y: 0.6 }]); got ${JSON.stringify(planes)}`)
  }
  return planes.map((plane: unknown, i) => {
    const entries = typeof plane === 'object' && plane !== null ? Object.entries(plane) : []
    const axis = AXES.find((a) => a === entries[0]?.[0])
    const value: unknown = entries[0]?.[1]
    if (entries.length === 1 && axis && typeof value === 'number' && Number.isFinite(value)) return [axis, value]
    throw new Error(`section: plane ${i} must name exactly one axis, e.g. { y: 0.5 }; got ${JSON.stringify(plane)}`)
  })
}

/** Connected solid regions (8-connected) of the cell layer containing axis = value; none outside the volume. */
function cut(volume: VoxelVolume, axis: Axis, value: number): Section {
  const a = AXES.indexOf(axis)
  const [h, v] = SCREEN[axis]
  const index = Math.floor((value - volume.min[a]) / volume.cellSize)
  if (index < 0 || index >= volume.dimensions[a]) return { axis, value, regions: [] }
  const hi = AXES.indexOf(h)
  const vi = AXES.indexOf(v)
  const width = volume.dimensions[hi]
  const height = volume.dimensions[vi]
  const cell = [0, 0, 0]
  cell[a] = index
  const solid = (x: number, y: number): boolean => {
    cell[hi] = x
    cell[vi] = y
    return isInside(volume, cell)
  }

  const seen = new Uint8Array(width * height)
  const lists: number[][] = []
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !solid(start % width, Math.floor(start / width))) continue
    const cells = [start]
    seen[start] = 1
    for (let i = 0; i < cells.length; i++) {
      const cx = cells[i] % width
      const cy = Math.floor(cells[i] / width)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const n = ny * width + nx
          if (seen[n] || !solid(nx, ny)) continue
          seen[n] = 1
          cells.push(n)
        }
      }
    }
    lists.push(cells)
  }
  const world = (axis: number, cellIndex: number): number => volume.min[axis] + (cellIndex + 0.5) * volume.cellSize
  const point = (hValue: number, vValue: number): [number, number, number] => {
    const p: [number, number, number] = [0, 0, 0]
    p[a] = world(a, index)
    p[hi] = hValue
    p[vi] = vValue
    return p
  }
  const regions = lists.map((cells): Region => {
    let sumH = 0, sumV = 0
    let minH = Infinity, maxH = -Infinity, minV = Infinity, maxV = -Infinity
    for (const c of cells) {
      const x = c % width
      const y = Math.floor(c / width)
      sumH += x
      sumV += y
      minH = Math.min(minH, x); maxH = Math.max(maxH, x)
      minV = Math.min(minV, y); maxV = Math.max(maxV, y)
    }
    const n = cells.length
    return {
      cells: n,
      center: point(world(hi, sumH / n), world(vi, sumV / n)),
      min: point(world(hi, minH), world(vi, minV)),
      max: point(world(hi, maxH), world(vi, maxV)),
    }
  })
  return { axis, value: world(a, index), regions: regions.sort((p, q) => q.cells - p.cells) }
}
