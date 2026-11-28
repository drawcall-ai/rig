/** A triangle mesh being cut: positions in template space, the other vertex attributes carried along. */

import * as THREE from 'three'
import { weld } from '../../measure/topology.js'

export class Surface {
  /** Template-space positions. */
  positions: number[]
  /** Every other vertex attribute, interpolated across cuts. */
  attributes: Map<string, { itemSize: number; data: number[] }>
  /** Topological vertex id: equal for one surface point split by seams, distinct across cuts. */
  topo: number[]
  triangles: number[]
  /** Material index per triangle. */
  materials: number[]
  private nextTopo: number

  /** `toTemplate` takes the geometry's own coordinates to template space. */
  constructor(geometry: THREE.BufferGeometry, toTemplate: THREE.Matrix4) {
    const position = geometry.getAttribute('position')
    const v = new THREE.Vector3()
    this.positions = []
    for (let i = 0; i < position.count; i++) this.positions.push(...v.fromBufferAttribute(position, i).applyMatrix4(toTemplate).toArray())
    this.attributes = new Map()
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      if (name === 'position') continue
      const data: number[] = []
      for (let i = 0; i < attribute.count; i++) for (let k = 0; k < attribute.itemSize; k++) data.push(attribute.getComponent(i, k))
      this.attributes.set(name, { itemSize: attribute.itemSize, data })
    }
    const index = geometry.getIndex()
    this.triangles = index ? Array.from(index.array) : Array.from({ length: position.count }, (_, i) => i)
    this.materials = new Array<number>(this.triangles.length / 3).fill(0)
    for (const group of geometry.groups) for (let t = group.start; t < group.start + group.count; t += 3) this.materials[t / 3] = group.materialIndex ?? 0
    this.topo = Array.from(weld(this.positions))
    this.nextTopo = position.count
  }

  get count(): number {
    return this.positions.length / 3
  }

  point(v: number): THREE.Vector3 {
    return new THREE.Vector3(this.positions[v * 3], this.positions[v * 3 + 1], this.positions[v * 3 + 2])
  }

  setPoint(v: number, p: THREE.Vector3): void {
    this.positions[v * 3] = p.x
    this.positions[v * 3 + 1] = p.y
    this.positions[v * 3 + 2] = p.z
  }

  newTopo(): number {
    return this.nextTopo++
  }

  /** A vertex between a and b at t, with topological id `topo`. */
  interpolate(a: number, b: number, t: number, topo: number): number {
    const p = this.point(a).lerp(this.point(b), t)
    this.positions.push(p.x, p.y, p.z)
    for (const { itemSize, data } of this.attributes.values()) {
      for (let k = 0; k < itemSize; k++) data.push(data[a * itemSize + k] + (data[b * itemSize + k] - data[a * itemSize + k]) * t)
    }
    this.topo.push(topo)
    return this.count - 1
  }

  /** A vertex at `p` with its own topological id, other attributes copied from `like`. */
  add(p: THREE.Vector3, like: number): number {
    this.positions.push(p.x, p.y, p.z)
    for (const { itemSize, data } of this.attributes.values()) for (let k = 0; k < itemSize; k++) data.push(data[like * itemSize + k])
    this.topo.push(this.newTopo())
    return this.count - 1
  }

  /** The triangles, all flipped unless the one starting at `probe` faces toward `target`. */
  facing(triangles: number[], probe: number, target: THREE.Vector3): number[] {
    const a = this.point(triangles[probe]), b = this.point(triangles[probe + 1]), c = this.point(triangles[probe + 2])
    if (b.clone().sub(a).cross(c.clone().sub(a)).dot(target.clone().sub(a)) > 0) return triangles
    const out = triangles.slice()
    for (let t = 0; t < out.length; t += 3) [out[t + 1], out[t + 2]] = [out[t + 2], out[t + 1]]
    return out
  }

  /** The first hit of a ray along -x through (y, z) in template space, with its uv when the surface has one. */
  front(y: number, z: number): THREE.Intersection {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    const uv = this.attributes.get('uv')
    if (uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv.data, 2))
    geometry.setIndex(this.triangles)
    const hit = new THREE.Raycaster(new THREE.Vector3(10, y, z), new THREE.Vector3(-1, 0, 0)).intersectObject(new THREE.Mesh(geometry), false)[0]
    if (!hit) throw new Error(`face: no skin in front of template point y=${y.toFixed(4)} z=${z.toFixed(4)}`)
    return hit
  }

  /** The material index of the triangle that front(y, z) hits. */
  materialAt(y: number, z: number): number {
    const { faceIndex } = this.front(y, z)
    if (faceIndex == null) throw new Error('face: the ray hit no triangle')
    return this.materials[faceIndex]
  }

  /** The cut geometry in its own coordinates (`fromTemplate`), triangles grouped by material. */
  geometry(fromTemplate: THREE.Matrix4): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    const p = new Float32Array(this.positions.length)
    for (let v = 0; v < this.count; v++) this.point(v).applyMatrix4(fromTemplate).toArray(p, v * 3)
    geometry.setAttribute('position', new THREE.BufferAttribute(p, 3))
    for (const [name, { itemSize, data }] of this.attributes) geometry.setAttribute(name, new THREE.BufferAttribute(Float32Array.from(data), itemSize))
    const order = this.materials.map((m, t) => [m, t]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const index: number[] = []
    for (const [m, t] of order) {
      const last = geometry.groups.at(-1)
      if (!last || last.materialIndex !== m) geometry.addGroup(index.length, 0, m)
      geometry.groups[geometry.groups.length - 1].count += 3
      index.push(this.triangles[t * 3], this.triangles[t * 3 + 1], this.triangles[t * 3 + 2])
    }
    geometry.setIndex(index)
    return geometry
  }
}
