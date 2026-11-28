/** Opens each eye: removes the skin over the eyeball, seats the lid rim on the ball and sews a socket behind it. */

import * as THREE from 'three'
import type { Eye } from './anatomy.js'
import type { Surface } from './surface.js'

/**
 * How far the ball's front sits behind the skin at the opening's center: a painted eye bulges, and a ball seated on
 * it pokes out sideways at the outer corner, where the face recedes.
 */
const RECESS = 0.0038

/** Seats the eyeball behind the skin at the opening's center. */
export function placeEye(s: Surface, eye: Eye): void {
  eye.center.set(s.front(eye.y, eye.z).point.x - RECESS - eye.radius, eye.y, eye.z)
}

/** Half width of the opening at lateral z: the outer half is narrower. */
function halfWidth(eye: Eye, z: number): number {
  return (z - eye.z) * Math.sign(eye.z) > 0 ? eye.outerHalfWidth : eye.innerHalfWidth
}

/** Cuts the opening and returns its rim vertices, in loop order. Only skin is cut: triangles of `socketMaterial` (the mouth cavity) stay. */
export function cutEye(s: Surface, eye: Eye, socketMaterial: number): number[] {
  const c = eye.center
  const inside = (t: number) => {
    const p = s.point(s.triangles[t]).add(s.point(s.triangles[t + 1])).add(s.point(s.triangles[t + 2])).divideScalar(3)
    return p.x > c.x && ((p.y - eye.y) / eye.halfHeight) ** 2 + ((p.z - eye.z) / halfWidth(eye, p.z)) ** 2 < 1
  }
  const kept: number[] = [], removed: number[] = [], keptMaterials: number[] = []
  for (let t = 0; t < s.triangles.length; t += 3) {
    const tri = s.triangles.slice(t, t + 3)
    if (s.materials[t / 3] !== socketMaterial && inside(t)) removed.push(...tri)
    else { kept.push(...tri); keptMaterials.push(s.materials[t / 3]) }
  }
  if (!removed.length) throw new Error(`face: no skin inside the eye opening at template z=${eye.z.toFixed(4)}; check the eye landmarks`)
  // rim: edges of removed faces whose reverse survives in kept faces, followed in topological space
  const T = s.topo
  const keptEdges = new Set<string>()
  for (let t = 0; t < kept.length; t += 3) for (let k = 0; k < 3; k++) keptEdges.add(`${T[kept[t + k]]}_${T[kept[t + (k + 1) % 3]]}`)
  const next = new Map<number, number>(), vertexOf = new Map<number, number>()
  for (let t = 0; t < removed.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = removed[t + k], b = removed[t + (k + 1) % 3]
    if (!keptEdges.has(`${T[b]}_${T[a]}`)) continue
    next.set(T[a], T[b])
    vertexOf.set(T[a], a)
    vertexOf.set(T[b], b)
  }
  const start = next.keys().next().value
  if (start === undefined) throw new Error('face: the eye opening has no rim')
  const loop: number[] = []
  for (let v: number | undefined = start; v !== undefined && loop.length <= next.size; v = next.get(v)) {
    loop.push(v)
    if (next.get(v) === start) break
  }
  if (loop.length !== next.size) throw new Error(`face: the eye opening at template z=${eye.z.toFixed(4)} has ${next.size} rim vertices but a loop of ${loop.length}; the skin there must be closed (eyes painted on, not modeled as holes)`)
  seat(s, eye, new Set(loop))
  const rim = loop.map((t) => vertexOf.get(t) ?? t)
  s.triangles = kept
  s.materials = keptMaterials
  sewSocket(s, eye, rim, socketMaterial)
  return rim
}

/** Moves the rim onto the ball and pushes skin inside the ball out to just above it. */
function seat(s: Surface, eye: Eye, rimTopo: Set<number>): void {
  const c = eye.center
  const rimRadius = eye.radius + 0.00036, skinRadius = eye.radius + 0.00127
  for (let v = 0; v < s.count; v++) {
    const p = s.point(v)
    if (rimTopo.has(s.topo[v])) {
      // whole triangles were cut, leaving long points at the corners: pull rim points back inside the intended
      // opening (lids keep their height: the clamp ellipse is taller than the opening), then onto the ball
      const dy = p.y - eye.y, dz = p.z - eye.z
      const q = Math.hypot(dy / (eye.halfHeight * 1.8), dz / halfWidth(eye, p.z))
      if (q > 1) { p.y = eye.y + dy / q; p.z = eye.z + dz / q }
      s.setPoint(v, p.sub(c).setLength(rimRadius).add(c))
    } else if (p.distanceTo(c) < skinRadius && p.x > c.x - eye.radius * 0.5) s.setPoint(v, p.sub(c).setLength(skinRadius).add(c))
  }
}

/** Rim -> ring around the ball's equator -> cap behind it, facing the ball. */
function sewSocket(s: Surface, eye: Eye, rim: number[], material: number): void {
  const c = eye.center
  const ring = rim.map((r) => {
    const p = s.point(r)
    const dy = p.y - c.y, dz = p.z - c.z
    const l = Math.hypot(dy, dz) || 1
    return s.add(new THREE.Vector3(c.x - 0.00363, c.y + (dy / l) * eye.radius * 1.02, c.z + (dz / l) * eye.radius * 1.02), r)
  })
  const cap = s.add(new THREE.Vector3(c.x - eye.radius * 1.1, c.y, c.z), rim[0])
  const socket: number[] = []
  for (let i = 0; i < rim.length; i++) {
    const j = (i + 1) % rim.length
    socket.push(rim[i], ring[i], ring[j], rim[i], ring[j], rim[j], ring[i], cap, ring[j])
  }
  const facing = s.facing(socket, 6, c)
  s.triangles.push(...facing)
  for (let t = 0; t < facing.length; t += 3) s.materials.push(material)
}
