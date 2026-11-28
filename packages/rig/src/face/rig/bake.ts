/** Morph targets baked onto meshes the face rig builds: the face's transferred shapes and rigid jaw motions. */

import * as THREE from 'three'
import type { Shape } from './shapes.js'
import { normals, type Tissue } from './tissue.js'

/** Morph targets on the face: deltas and normal deltas in the mesh's coordinates; moved and new vertices get seam-free normals. */
export function bakeFace(geometry: THREE.BufferGeometry, shapes: Record<string, Shape>, tissue: Tissue, restNormals: Float32Array, templateToMesh: THREE.Matrix4): void {
  const linear = new THREE.Matrix3().setFromMatrix4(templateToMesh)
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(templateToMesh)
  const count = tissue.rest.length / 3
  const original = geometry.getAttribute('normal')
  const moved = new Uint8Array(count)
  for (const { delta } of Object.values(shapes)) for (let v = 0; v < count; v++) if (delta[v * 3] || delta[v * 3 + 1] || delta[v * 3 + 2]) moved[v] = 1
  const toMesh = (n: Float32Array) => {
    const out = new Float32Array(n.length), v = new THREE.Vector3()
    for (let i = 0; i < count; i++) v.fromArray(n, i * 3).applyMatrix3(normalMatrix).normalize().toArray(out, i * 3)
    return out
  }
  const rest = toMesh(restNormals)
  const base = new Float32Array(count * 3)
  const cut = tissue.mouth.cavityStart
  for (let v = 0; v < count; v++) for (let k = 0; k < 3; k++) {
    base[v * 3 + k] = original && !moved[v] && v < cut ? original.getComponent(v, k) : rest[v * 3 + k]
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(base, 3))
  const positions: THREE.BufferAttribute[] = [], deltas: THREE.BufferAttribute[] = []
  const v = new THREE.Vector3()
  for (const [name, { delta }] of Object.entries(shapes)) {
    const d = new Float32Array(delta.length)
    for (let i = 0; i < count; i++) v.fromArray(delta, i * 3).applyMatrix3(linear).toArray(d, i * 3)
    const posed = toMesh(normals(tissue, tissue.rest.map((x, i) => x + delta[i])))
    const position = new THREE.BufferAttribute(d, 3)
    position.name = name
    positions.push(position)
    const normal = new THREE.BufferAttribute(posed.map((x, i) => x - rest[i]), 3)
    normal.name = name
    deltas.push(normal)
  }
  geometry.morphAttributes.position = positions
  geometry.morphAttributes.normal = deltas
  geometry.morphTargetsRelative = true
}

/** One morph target per shape moving the geometry rigidly by that shape's matrix. */
export function bakeRigid(g: THREE.BufferGeometry, motions: [string, THREE.Matrix4][]): void {
  const p = g.getAttribute('position'), n = g.getAttribute('normal')
  const v = new THREE.Vector3(), w = new THREE.Vector3()
  g.morphAttributes.position = motions.map(([name, m]) => {
    const d = new Float32Array(p.count * 3)
    for (let i = 0; i < p.count; i++) v.fromBufferAttribute(p, i).applyMatrix4(m).sub(w.fromBufferAttribute(p, i)).toArray(d, i * 3)
    const a = new THREE.BufferAttribute(d, 3)
    a.name = name
    return a
  })
  g.morphAttributes.normal = motions.map(([name, m]) => {
    const r = new THREE.Matrix3().setFromMatrix4(m)
    const d = new Float32Array(n.count * 3)
    for (let i = 0; i < n.count; i++) v.fromBufferAttribute(n, i).applyMatrix3(r).sub(w.fromBufferAttribute(n, i)).toArray(d, i * 3)
    const a = new THREE.BufferAttribute(d, 3)
    a.name = name
    return a
  })
  g.morphTargetsRelative = true
}
