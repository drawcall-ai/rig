/** What lies under points of an orthographic view, measured on the voxel solid along the camera's line of sight. */

import * as THREE from 'three'
import type { View } from '../render/view.js'
import type { Vec3 } from '../vec3.js'
import { AXES } from './section.js'
import { gather } from './soup.js'
import { cellAt, checkResolution, computeVoxelVolume, isInside } from './voxelize.js'

/** A point of an orthographic view's grid, by the two axes it labels: { x, z } for ±y, { z, y } for ±x, { x, y } for ±z. */
export type Point = { x: number; z: number } | { x: number; y: number } | { y: number; z: number }

/** One stretch of solid along the line of sight, world space. */
export interface Span {
  /** Where the line enters the solid, on the side nearer the camera. */
  enter: Vec3
  /** Where it leaves the solid again. */
  exit: Vec3
  /** Midway between enter and exit: inside the solid. */
  center: Vec3
  /** Distance from enter to exit. */
  thickness: number
}

/**
 * The solid under each point of an orthographic view, e.g. pick(scene, { camera: '+y' }, [{ x: 0.3, z: -0.1 }]):
 * one list per point, in order, of every span the line through that point along the camera's axis crosses,
 * nearest the camera first. All points share one voxelization, so a sweep of thousands costs about one call.
 * Measures the scene in its current pose, as section() and skin() do; the view takes only `camera`. Spans are
 * measured in whole voxels; resolution = voxels along the longest axis (default 128), as in section() and skin().
 */
export function pick(object: THREE.Object3D, view: Pick<View, 'camera'>, points: Point[], resolution = 128): Span[][] {
  const extra = Object.keys(view).filter((key) => key !== 'camera')
  if (extra.length) throw new Error(`pick: the view takes only camera, got ${extra.join(', ')}`)
  const { camera } = view
  if (camera === 'persp') throw new Error("pick: camera 'persp' has no grid to read a point from; use one of +x, -x, +y, -y, +z, -z")
  if (!['+x', '-x', '+y', '-y', '+z', '-z'].includes(camera)) throw new Error(`pick: unknown camera ${JSON.stringify(camera)}; use one of +x, -x, +y, -y, +z, -z`)
  const along = 'xyz'.indexOf(camera[1])
  const [u, v] = [0, 1, 2].filter((a) => a !== along)
  const example = `{ ${AXES[u]}: 0.1, ${AXES[v]}: 0.2 }`
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error(`pick takes a non-empty list of points, e.g. pick(scene, { camera: '${camera}' }, [${example}]); got ${JSON.stringify(points)}`)
  }
  const grid = points.map((point: unknown, i): [number, number] => {
    if (typeof point === 'object' && point !== null) {
      const given: Record<string, unknown> = { ...point }
      const [pu, pv] = [given[AXES[u]], given[AXES[v]]]
      if (Object.keys(given).length === 2 && typeof pu === 'number' && typeof pv === 'number' && Number.isFinite(pu) && Number.isFinite(pv)) return [pu, pv]
    }
    throw new Error(`pick: point ${i}: camera ${camera} looks along ${AXES[along]}; give ${AXES[u]} and ${AXES[v]}, e.g. ${example}; got ${JSON.stringify(point)}`)
  })
  checkResolution(resolution, `pick(scene, { camera: '${camera}' }, [${example}], 256)`)
  const soup = gather(object)
  const volume = computeVoxelVolume(soup.positions, soup.indices, { resolution })
  const face = (i: number) => volume.min[along] + i * volume.cellSize
  // A camera on the + side sees the highest run first and enters it at its high end
  const fromPlus = camera[0] === '+'

  return grid.map(([pu, pv]) => {
    // The world point at `depth` along the line
    const at = (depth: number): Vec3 => {
      const p = [0, 0, 0]
      p[along] = depth
      p[u] = pu
      p[v] = pv
      return [p[0], p[1], p[2]]
    }
    // Runs of solid cells [first, last] in the column under the point, in increasing coordinate
    const cell = cellAt(volume, at(0))
    const runs: [number, number][] = []
    for (let i = 0; i < volume.dimensions[along]; i++) {
      cell[along] = i
      if (!isInside(volume, cell)) continue
      const last = runs.at(-1)
      if (last && last[1] === i - 1) last[1] = i
      else runs.push([i, i])
    }
    const spans = runs.map(([first, last]): Span => {
      const [enter, exit] = fromPlus ? [face(last + 1), face(first)] : [face(first), face(last + 1)]
      return { enter: at(enter), exit: at(exit), center: at((enter + exit) / 2), thickness: (last - first + 1) * volume.cellSize }
    })
    return fromPlus ? spans.reverse() : spans
  })
}
