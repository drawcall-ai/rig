/**
 * Plain-text views of a voxel volume, meant to be read by people and LLMs:
 * three axis projections, or cross-section slices whose connected regions are
 * lettered and listed with world-space centers and extents.
 */

import type { VoxelVolume } from './voxelize.js'

export type Axis = 'x' | 'y' | 'z'

export interface Slice {
  axis: Axis
  /** World coordinate of the cutting plane. */
  value: number
}

const AXES: Axis[] = ['x', 'y', 'z']
/** Screen axes (horizontal, vertical) per view axis, shared by projections and slices. */
const SCREEN: Record<Axis, [Axis, Axis]> = { x: ['z', 'y'], y: ['x', 'z'], z: ['x', 'y'] }
const REGION_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

interface Plane {
  title: string
  /** Horizontal (left -> right) and vertical (bottom -> top) axes. */
  h: Axis
  v: Axis
  /** Character drawn for the cell at (h, v) grid indices. */
  cell: (h: number, v: number) => string
  /** Drawn cell range [hMin, hMax, vMin, vMax], inclusive; default: the whole grid. */
  crop?: [number, number, number, number]
}

/** Header plus the three projections, or only the slices when any are given. */
export function formatVolume(volume: VoxelVolume, slices: Slice[] = []): string {
  const [dimX, dimY, dimZ] = volume.dimensions
  const lines = [
    `bounds: min ${vec(volume.min, volume.cellSize)}  max ${vec(volume.max, volume.cellSize)}  (mesh, world space, +y up)`,
    `grid: ${dimX} x ${dimY} x ${dimZ} cells of ${fmt(volume.cellSize, volume.cellSize)}, ${volume.insideIndices.length} filled (# = solid cell)`,
    '',
  ]
  if (slices.length === 0) {
    lines.push(...drawPlane(volume, projection(volume, 'front', 'z')))
    lines.push(...drawPlane(volume, projection(volume, 'side', 'x')))
    lines.push(...drawPlane(volume, projection(volume, 'top', 'y')))
  }
  for (const slice of slices) lines.push(...drawSlice(volume, slice))
  return lines.join('\n')
}

function projection(volume: VoxelVolume, name: string, depth: Axis): Plane {
  const [h, v] = SCREEN[depth]
  const d = AXES.indexOf(depth)
  const hits = new Uint8Array(volume.dimensions[AXES.indexOf(h)] * volume.dimensions[AXES.indexOf(v)])
  const width = volume.dimensions[AXES.indexOf(h)]
  const cell = [0, 0, 0]
  forEachInside(volume, (x, y, z) => {
    cell[0] = x
    cell[1] = y
    cell[2] = z
    hits[cell[AXES.indexOf(v)] * width + cell[AXES.indexOf(h)]] = 1
  })
  return {
    title: `${name} view: projected along ${depth} (${h} to the right, ${v} up), depth ${fmtRange(volume, d)}`,
    h,
    v,
    cell: (hi, vi) => (hits[vi * width + hi] === 1 ? '#' : '.'),
  }
}

function drawSlice(volume: VoxelVolume, slice: Slice): string[] {
  const a = AXES.indexOf(slice.axis)
  const [h, v] = SCREEN[slice.axis]
  const index = Math.floor((slice.value - volume.min[a]) / volume.cellSize)
  if (index < 0 || index >= volume.dimensions[a]) {
    return [`slice ${slice.axis}=${slice.value}: outside the volume ${fmtRange(volume, a)}`, '']
  }
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

  // 8-connected regions, largest first
  const region = new Int32Array(width * height).fill(-1)
  const regions: { cells: number[] }[] = []
  for (let start = 0; start < width * height; start++) {
    if (region[start] >= 0 || !isInside(start % width, Math.floor(start / width))) continue
    const cells = [start]
    region[start] = regions.length
    for (let i = 0; i < cells.length; i++) {
      const cx = cells[i] % width
      const cy = Math.floor(cells[i] / width)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const n = ny * width + nx
          if (region[n] >= 0 || !isInside(nx, ny)) continue
          region[n] = regions.length
          cells.push(n)
        }
      }
    }
    regions.push({ cells })
  }
  const order = regions.map((_, i) => i).sort((p, q) => regions[q].cells.length - regions[p].cells.length)
  const labelOf = new Map(order.map((r, rank): [number, string] => [r, REGION_LABELS[rank] ?? '#']))

  const planeValue = fmt(volume.min[a] + (index + 0.5) * volume.cellSize, volume.cellSize)
  const snapped = planeValue === fmt(slice.value, volume.cellSize) ? '' : ` (the cell layer containing ${slice.axis}=${slice.value})`
  const lines = [`slice ${slice.axis}=${planeValue}${snapped}: ${regions.length} regions (${h} to the right, ${v} up)`]
  const crop: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity]
  const world = (axis: number, cellIndex: number): string =>
    fmt(volume.min[axis] + (cellIndex + 0.5) * volume.cellSize, volume.cellSize)
  for (const r of order.slice(0, REGION_LABELS.length)) {
    const cells = regions[r].cells
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
    crop[0] = Math.min(crop[0], minH); crop[1] = Math.max(crop[1], maxH)
    crop[2] = Math.min(crop[2], minV); crop[3] = Math.max(crop[3], maxV)
    lines.push(
      `  ${labelOf.get(r)}: ${cells.length} cells, center ${h}=${world(hi, sumH / cells.length)} ` +
        `${v}=${world(vi, sumV / cells.length)}, ${h} ${world(hi, minH)}..${world(hi, maxH)}, ` +
        `${v} ${world(vi, minV)}..${world(vi, maxV)}`,
    )
  }
  if (regions.length === 0) return [...lines, '']

  // Draw only the solid part of the slice, with a one-cell margin
  lines.push(
    ...drawPlane(volume, {
      title: '',
      h,
      v,
      cell: (x, y) => (region[y * width + x] >= 0 ? (labelOf.get(region[y * width + x]) ?? '#') : '.'),
      crop: [Math.max(0, crop[0] - 1), Math.min(width - 1, crop[1] + 1), Math.max(0, crop[2] - 1), Math.min(height - 1, crop[3] + 1)],
    }).slice(1),
  )
  return lines
}

/** Rows top (high v) to bottom, each labeled with its world coordinate; a ruler every 10 columns. */
function drawPlane(volume: VoxelVolume, plane: Plane): string[] {
  const hi = AXES.indexOf(plane.h)
  const vi = AXES.indexOf(plane.v)
  const [h0, h1, v0, v1] = plane.crop ?? [0, volume.dimensions[hi] - 1, 0, volume.dimensions[vi] - 1]
  const width = h1 - h0 + 1
  const coord = (axis: number, index: number): string => fmt(volume.min[axis] + (index + 0.5) * volume.cellSize, volume.cellSize)
  const margin = Math.max(coord(vi, v0).length, coord(vi, v1).length, plane.v.length) + 3

  const ruler = Array.from({ length: margin + width + 12 }, () => ' ')
  const ticks = Array.from({ length: margin + width }, () => ' ')
  for (let x = 0; x < width; x += 10) {
    const text = coord(hi, h0 + x)
    for (let k = 0; k < text.length; k++) ruler[margin + x + k] = text[k]
    ticks[margin + x] = '|'
  }
  const lines = [plane.title, `${plane.h}:`.padStart(margin - 1) + ruler.join('').slice(margin - 1).trimEnd(), ticks.join('').trimEnd()]
  for (let y = v1; y >= v0; y--) {
    let row = ''
    for (let x = h0; x <= h1; x++) row += plane.cell(x, y)
    lines.push(`${coord(vi, y).padStart(margin - 3)} | ${row}`)
  }
  lines.push('')
  return lines
}

function forEachInside(volume: VoxelVolume, visit: (x: number, y: number, z: number) => void): void {
  const [, dimY, dimZ] = volume.dimensions
  for (const index of volume.insideIndices) {
    const x = Math.floor(index / (dimY * dimZ))
    const rem = index - x * dimY * dimZ
    visit(x, Math.floor(rem / dimZ), rem % dimZ)
  }
}

function fmtRange(volume: VoxelVolume, axis: number): string {
  const lo = volume.min[axis]
  const hi = lo + volume.dimensions[axis] * volume.cellSize
  return `${AXES[axis]} ${fmt(lo, volume.cellSize)}..${fmt(hi, volume.cellSize)}`
}

function vec(v: ArrayLike<number>, cellSize: number): string {
  return `[${fmt(v[0], cellSize)}, ${fmt(v[1], cellSize)}, ${fmt(v[2], cellSize)}]`
}

/** Enough decimals to resolve a tenth of a cell. */
function fmt(value: number, cellSize: number): string {
  const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(cellSize)) + 1))
  return value.toFixed(decimals)
}
