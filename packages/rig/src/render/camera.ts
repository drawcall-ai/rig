/** Where a view's camera looks from and how far it reaches, plus the labeled world grid of orthographic views. */

import * as THREE from 'three'
import type { Vec3 } from '../vec3.js'
import type { Camera } from './view.js'

export interface Sphere {
  center: Vec3
  radius: number
}

/** A grid label at view pixel (x, y), its text's baseline start. */
export interface Label {
  x: number
  y: number
  text: string
}

/** Least free pixels between neighbouring bottom labels. */
const GAP = 14
/** Top rows kept free of left labels, for the caption. */
const CAPTION = 34
/** Bottom rows kept free of left labels, for the bottom labels. */
const BOTTOM = 22

/** The sphere a focus zooms on: given, or a bone's segment (to its first child bone, else from its parent bone). */
export function sphere(focus: THREE.Bone | Sphere, radius: number): Sphere {
  if (!(focus instanceof THREE.Bone)) return focus
  const start = focus.getWorldPosition(new THREE.Vector3())
  const next = focus.children.find((c) => c instanceof THREE.Bone) ?? (focus.parent instanceof THREE.Bone ? focus.parent : undefined)
  const end = next ? next.getWorldPosition(new THREE.Vector3()) : start
  return { center: start.clone().lerp(end, 0.5).toArray(), radius: Math.max(start.distanceTo(end) * 1.5, radius * 0.08) }
}

/**
 * A camera on `name`'s side of `center` that shows `reach` around it, or, when the reach covers the box, the
 * whole box from the side, or every point of `positions` (world xyz triples) in 'persp'.
 */
export function frame(name: Camera, center: THREE.Vector3, reach: number, box: THREE.Box3, positions: ArrayLike<number>): THREE.Camera {
  const extent = box.getSize(new THREE.Vector3())
  const radius = extent.length() / 2
  if (name === 'persp') {
    const fov = 35
    const camera = new THREE.PerspectiveCamera(fov, 1, reach / 100, reach * 100)
    const dir = new THREE.Vector3(1, 0.6, 1).normalize()
    camera.position.copy(center).add(dir)
    camera.lookAt(center)
    camera.updateMatrixWorld()
    const half = THREE.MathUtils.degToRad(fov / 2)
    // Far enough that the whole sphere fits the field of view, or, when the reach covers the box, every
    // point: the silhouette from this side, so a wide model (spread wings) isn't framed by the box's diagonal
    let distance = reach / Math.sin(half)
    if (reach >= radius) {
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
      const p = new THREE.Vector3()
      distance = 0
      for (let i = 0; i < positions.length; i += 3) {
        p.set(positions[i], positions[i + 1], positions[i + 2]).sub(center)
        const across = Math.max(Math.abs(p.dot(right)), Math.abs(p.dot(up))) * 1.1
        distance = Math.max(distance, p.dot(dir) + across / Math.tan(half))
      }
    }
    camera.position.copy(center).addScaledVector(dir, distance)
    camera.updateMatrixWorld()
    return camera
  }
  const axis = 'xyz'.indexOf(name[1])
  const dir = new THREE.Vector3().setComponent(axis, name[0] === '+' ? 1 : -1)
  const across = [0, 1, 2].filter((a) => a !== axis).map((a) => extent.getComponent(a))
  const half = reach < radius ? reach : (Math.max(...across) / 2) * 1.12
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, -radius * 10, radius * 10)
  camera.up.set(0, axis === 1 ? 0 : 1, axis === 1 ? -dir.y : 0)
  camera.position.copy(center).addScaledVector(dir, radius * 2)
  camera.lookAt(center)
  camera.updateMatrixWorld()
  return camera
}

/**
 * Grid lines behind the model at round world coordinates, labeled along the bottom and left edges of a
 * `size`-pixel view. The step is the finest that keeps the bottom labels (measured by `width`) apart;
 * labels that would not fit inside the view are left out.
 */
export function grid(camera: THREE.OrthographicCamera, center: THREE.Vector3, radius: number, size: number, width: (text: string) => number) {
  const half = camera.right
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
  const dominant = (v: THREE.Vector3) => [0, 1, 2].reduce((best, a) => (Math.abs(v.getComponent(a)) > Math.abs(v.getComponent(best)) ? a : best), 0)
  const h = dominant(right)
  const v = dominant(up)
  // Multiples of the step inside the view along an axis; integer multiples, so 0 is never "-0.00"
  const ticks = (a: number, step: number) => {
    const values: number[] = []
    for (let i = Math.ceil((center.getComponent(a) - half) / step); i * step <= center.getComponent(a) + half; i++) values.push(i * step)
    return values
  }
  const name = (a: number, value: number, decimals: number) => `${'xyz'[a]}=${value.toFixed(decimals)}`
  const pixel = size / (half * 2)
  // The widest label is at one of the ends: the most digits, or a minus sign
  const widest = (step: number, decimals: number) => {
    const xs = ticks(h, step)
    return xs.length ? Math.max(width(name(h, xs[0], decimals)), width(name(h, xs[xs.length - 1], decimals))) : 0
  }
  const { step, decimals, line } = gridStep((step, decimals) => step * pixel >= widest(step, decimals) + GAP, half * 2)

  const behind = center.clone().addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2), -radius * 1.5)
  const at = (hv: number, vv: number) => behind.clone().setComponent(h, hv).setComponent(v, vv)
  const screen = (world: THREE.Vector3) => {
    const p = world.clone().project(camera)
    return { x: ((p.x + 1) / 2) * size, y: ((1 - p.y) / 2) * size }
  }
  const points: THREE.Vector3[] = []
  const labels: Label[] = []
  for (const x of ticks(h, line)) points.push(at(x, center.getComponent(v) - half), at(x, center.getComponent(v) + half))
  for (const y of ticks(v, line)) points.push(at(center.getComponent(h) - half, y), at(center.getComponent(h) + half, y))
  for (const x of ticks(h, step)) {
    const text = name(h, x, decimals)
    const left = screen(at(x, center.getComponent(v))).x + 2
    if (left + width(text) <= size - 2) labels.push({ x: left, y: size - 4, text })
  }
  for (const y of ticks(v, step)) {
    const baseline = screen(at(center.getComponent(h), y)).y - 4
    if (baseline >= CAPTION && baseline <= size - BOTTOM) labels.push({ x: 2, y: baseline, text: name(v, y, decimals) })
  }
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x4a5058 }))
  return { lines, labels }
}

/**
 * The smallest round step (1, 2 or 5 times a power of ten) that `fits`, with the decimals that tell its
 * multiples apart and the step of the unlabeled lines between them (a divisor: 1 -> 0.5, 2 -> 1, 5 -> 1).
 */
function gridStep(fits: (step: number, decimals: number) => boolean, span: number): { step: number; decimals: number; line: number } {
  for (let exponent = Math.floor(Math.log10(span)) - 3; ; exponent++) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** exponent
      const decimals = Math.max(0, -exponent)
      if (fits(step, decimals)) return { step, decimals, line: step / (m === 5 ? 5 : 2) }
    }
  }
}
