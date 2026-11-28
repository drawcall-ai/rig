/** Teeth, tongue and eyeballs built from primitives in template space, sized for a human head and placed at the mouth and eyes, and the tongue's own shapes. */

import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Anatomy } from './anatomy.js'

interface MouthParts {
  upperTeeth: THREE.BufferGeometry
  lowerTeeth: THREE.BufferGeometry
  tongue: THREE.BufferGeometry
  /** Tongue center and half length, front to back. */
  tongueCenter: THREE.Vector3
  tongueLength: number
}

export function mouthParts({ mouth }: Anatomy): MouthParts {
  const { center } = mouth
  const w = (mouth.right - mouth.left) / 2
  // the upper incisor edges sit below the lip line, overlapping the lower ones, so parted lips show them
  const upperTeeth = teethRow(center.x - 0.0077, 0.852 * w, 1.185 * w, center.y + 0.0085, center.y - 0.003, true)
  const lowerTeeth = teethRow(center.x - 0.0105, 0.815 * w, 1.11 * w, center.y - 0.0128, center.y - 0.005, false)
  upperTeeth.translate(0, 0, center.z)
  lowerTeeth.translate(0, 0, center.z)
  // the tongue's top sits below the lower incisor edges
  const tongueCenter = new THREE.Vector3(center.x - 0.0305, center.y - 0.0112, center.z)
  const tongueLength = 0.02
  const tongue = new THREE.SphereGeometry(1, 24, 12)
  tongue.scale(tongueLength, 0.0051, 0.0154)
  // darker deeper in the mouth and underneath (vertex colors), like the teeth
  const p = tongue.getAttribute('position')
  const shade = new Float32Array(p.count * 3)
  for (let k = 0; k < p.count; k++) shade.fill(Math.max(0.25, 0.5 + 0.5 * p.getX(k)) * (p.getY(k) < 0 ? 0.6 : 1), k * 3, k * 3 + 3)
  tongue.setAttribute('color', new THREE.BufferAttribute(shade, 3))
  tongue.translate(tongueCenter.x, tongueCenter.y, tongueCenter.z)
  return { upperTeeth, lowerTeeth, tongue, tongueCenter, tongueLength }
}

/** A sphere looking +x whose front is planar-mapped across the uv square, for an iris texture; the hidden back maps to one corner. */
export function eyeball(radius: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(radius, 48, 32)
  const p = g.getAttribute('position'), uv = g.getAttribute('uv')
  for (let i = 0; i < p.count; i++) {
    if (p.getX(i) < 0) uv.setXY(i, 0.02, 0.02)
    else uv.setXY(i, 0.5 + p.getZ(i) / radius / 2, 0.5 + p.getY(i) / radius / 2)
  }
  return g
}

/**
 * A closed slab along the arch x = front - bend s², z = halfWidth s (s in -1..1), from y0 to y1, `thickness` deep: four
 * sides shaded smoothly along the arch and creased at its edges, and two end caps.
 */
function arch(front: number, bend: number, halfWidth: number, y0: number, y1: number, thickness: number, segments = 16): THREE.BufferGeometry {
  const ring: THREE.Vector3[][] = []
  for (let i = 0; i <= segments; i++) {
    const s = -1 + (2 * i) / segments
    const c = new THREE.Vector3(front - bend * s * s, 0, halfWidth * s)
    const tangent = new THREE.Vector3(-2 * bend * s, 0, halfWidth).normalize()
    const inner = c.clone().addScaledVector(new THREE.Vector3(tangent.z, 0, -tangent.x), -thickness)
    ring.push([new THREE.Vector3(c.x, y1, c.z), new THREE.Vector3(c.x, y0, c.z), new THREE.Vector3(inner.x, y0, inner.z), new THREE.Vector3(inner.x, y1, inner.z)])
  }
  const sides: THREE.BufferGeometry[] = []
  for (let k = 0; k < 4; k++) {
    const positions = ring.flatMap((corners) => [...corners[k].toArray(), ...corners[(k + 1) % 4].toArray()])
    const index: number[] = []
    for (let i = 0; i < segments; i++) index.push(2 * i, 2 * i + 1, 2 * i + 3, 2 * i, 2 * i + 3, 2 * i + 2)
    sides.push(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)).setIndex(index))
  }
  // the caps wind opposite ways, both facing out of the slab
  for (const corners of [[...ring[0]].reverse(), ring[segments]]) {
    sides.push(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap((c) => c.toArray()), 3)).setIndex([0, 1, 2, 0, 2, 3]))
  }
  const slab = merge(sides)
  outward(slab)
  slab.computeVertexNormals()
  return slab
}

/** Flips every triangle of a closed mesh whose signed volume is negative. */
function outward(g: THREE.BufferGeometry): void {
  const p = g.getAttribute('position'), index = g.getIndex()
  if (!index) throw new Error('face: outward() needs an indexed mesh')
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  let volume = 0
  for (let t = 0; t < index.count; t += 3) {
    a.fromBufferAttribute(p, index.getX(t)); b.fromBufferAttribute(p, index.getX(t + 1)); c.fromBufferAttribute(p, index.getX(t + 2))
    volume += a.dot(b.cross(c))
  }
  if (volume >= 0) return
  for (let t = 0; t < index.count; t += 3) {
    const second = index.getX(t + 1)
    index.setX(t + 1, index.getX(t + 2))
    index.setX(t + 2, second)
  }
}

/** Tooth widths from the midline outward: incisors, lateral, canine, premolars, molar, in arch-parameter units. */
const WIDTHS = [1, 0.8, 0.85, 0.75, 0.75, 0.9]

/** One row of rounded teeth along the arch, hanging from `root` toward `tip`, on a gum strip, darker deeper in the mouth (vertex colors). */
function teethRow(front: number, bend: number, halfWidth: number, root: number, tip: number, upper: boolean): THREE.BufferGeometry {
  const total = WIDTHS.reduce((a, b) => a + b, 0)
  const curve = (s: number) => new THREE.Vector3(front - bend * s * s, 0, halfWidth * s)
  const parts: THREE.BufferGeometry[] = []
  for (const side of [-1, 1]) {
    let s0 = 0
    WIDTHS.forEach((width, i) => {
      const s1 = s0 + width / total
      const mid = side * (s0 + s1) / 2
      const c = curve(mid)
      const tangent = curve(mid + 0.01).sub(curve(mid - 0.01)).normalize()
      const length = Math.abs(tip - root) * (i < 3 ? 1 : 0.8 - 0.05 * (i - 3))
      const depth = 0.00218 + 0.00073 * i
      const tooth = new THREE.BoxGeometry(depth, length, curve(side * s1).distanceTo(curve(side * s0)) * 0.97, 2, 3, 2)
      roundBox(tooth, i < 3 ? 0.6 : 0.75)
      tooth.rotateY(Math.atan2(-tangent.x, tangent.z))
      tooth.translate(c.x - depth / 2, upper ? root - length / 2 : root + length / 2, c.z)
      tooth.deleteAttribute('normal')
      tooth.deleteAttribute('uv')
      // weld the box's split faces for smooth shading per tooth
      const welded = mergeVertices(tooth, 1e-7)
      welded.computeVertexNormals()
      parts.push(welded)
      s0 = s1
    })
  }
  const toothCount = parts.reduce((a, g) => a + g.getAttribute('position').count, 0)
  parts.push(arch(front + 0.00073, bend, halfWidth * 1.02, upper ? root - 0.00109 : root - 0.00436, upper ? root + 0.00436 : root + 0.00109, 0.00727))
  const merged = merge(parts)
  // enamel ivory, gum pink; both darker deeper in the mouth and toward the roots
  const p = merged.getAttribute('position')
  const color = new Float32Array(p.count * 3)
  for (let k = 0; k < p.count; k++) {
    const depthShade = Math.max(0.25, Math.min(1, 1 - (front - p.getX(k)) / 0.01635))
    const rootShade = 1 - 0.35 * Math.max(0, Math.min(1, (upper ? p.getY(k) - (root - 0.00273) : root + 0.00273 - p.getY(k)) / 0.00273))
    const base = k >= toothCount ? [0.5, 0.24, 0.26] : [0.62, 0.58, 0.52]
    for (let c = 0; c < 3; c++) color[k * 3 + c] = base[c] * depthShade * rootShade
  }
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3))
  return merged
}

/** Pulls a box's vertices toward its inscribed ellipsoid by `amount`. */
function roundBox(box: THREE.BoxGeometry, amount: number): void {
  const { width, height, depth } = box.parameters
  const p = box.getAttribute('position'), v = new THREE.Vector3(), e = new THREE.Vector3()
  for (let k = 0; k < p.count; k++) {
    v.fromBufferAttribute(p, k)
    e.set(2 * v.x / width, 2 * v.y / height, 2 * v.z / depth)
    const round = v.clone().multiplyScalar(Math.max(Math.abs(e.x), Math.abs(e.y), Math.abs(e.z)) / (e.length() || 1))
    v.lerp(round, amount)
    p.setXYZ(k, v.x, v.y, v.z)
  }
}

/** Concatenates indexed geometries' positions, normals when they all have them, and indices. */
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const count = list.reduce((a, g) => a + g.getAttribute('position').count, 0)
  const withNormals = list.every((g) => g.getAttribute('normal'))
  const pos = new Float32Array(count * 3), normal = new Float32Array(count * 3)
  const index: number[] = []
  let offset = 0
  for (const g of list) {
    const gi = g.getIndex()
    if (!gi) throw new Error('face: merge() needs indexed geometries')
    pos.set(g.getAttribute('position').array, offset * 3)
    if (withNormals) normal.set(g.getAttribute('normal').array, offset * 3)
    for (let i = 0; i < gi.count; i++) index.push(gi.getX(i) + offset)
    offset += g.getAttribute('position').count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  if (withNormals) out.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  out.setIndex(index)
  return out
}

/** tongueUp: the tip up behind the upper teeth (l, t, d, n); tongueOut: the tip out between the teeth (th). */
export function addTongueShapes(g: THREE.BufferGeometry, center: THREE.Vector3, length: number, templateToModel: THREE.Matrix4): void {
  const forward = new THREE.Vector3(1, 0, 0).transformDirection(templateToModel)
  const up = new THREE.Vector3(0, 1, 0).transformDirection(templateToModel)
  const k = length / 0.02
  /** 0 at the back of the tongue to 1 at its tip. */
  const tip = (p: THREE.Vector3) => Math.max(0, Math.min(1, (p.clone().sub(center).dot(forward) + 0.545 * length) / (1.545 * length)))
  const shapes: Record<string, (p: THREE.Vector3) => THREE.Vector3> = {
    tongueUp: (p) => {
      const u = tip(p) ** 2
      const side = p.clone().sub(center).projectOnPlane(forward).projectOnPlane(up)
      return p.clone().addScaledVector(up, 0.02089 * k * u).addScaledVector(forward, -0.00145 * k * u).addScaledVector(side, -0.3 * u)
    },
    tongueOut: (p) => {
      const u = tip(p)
      const side = p.clone().sub(center).projectOnPlane(forward).projectOnPlane(up)
      return p.clone().addScaledVector(forward, 0.01544 * k * u ** 1.5).addScaledVector(up, 0.00872 * k * u ** 1.2).addScaledVector(side, -0.2 * u)
    },
  }
  const p = g.getAttribute('position')
  const positions = g.morphAttributes.position ?? [], deltas = g.morphAttributes.normal ?? []
  for (const [name, move] of Object.entries(shapes)) {
    const moved = g.clone()
    moved.morphAttributes = {}
    const mp = moved.getAttribute('position')
    const v = new THREE.Vector3()
    for (let i = 0; i < p.count; i++) {
      const q = move(v.fromBufferAttribute(p, i))
      mp.setXYZ(i, q.x, q.y, q.z)
    }
    moved.computeVertexNormals()
    const d = new THREE.BufferAttribute(Float32Array.from(mp.array, (x, i) => x - p.array[i]), 3)
    d.name = name
    const nd = new THREE.BufferAttribute(Float32Array.from(moved.getAttribute('normal').array, (x, i) => x - g.getAttribute('normal').array[i]), 3)
    nd.name = name
    positions.push(d)
    deltas.push(nd)
  }
  g.morphAttributes.position = positions
  g.morphAttributes.normal = deltas
}
