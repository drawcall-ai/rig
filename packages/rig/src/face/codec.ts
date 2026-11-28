/**
 * FaceEdit as bytes, as CachedRigLoader stores it. Geometry is exact, except morph deltas: those keep only the vertices
 * they move, quantized to 16 bits per component with a scale per target, about a micrometer on a human head.
 * Vertices that equal one of the face mesh's own, as most of the rigged face mesh does, are stored as references to it.
 * Arrays are compressed losslessly with meshopt's codecs.
 */

import * as THREE from 'three'
import type { SkeletonBone } from '../skin/skeleton.js'
import type { Vec3 } from '../vec3.js'
import { meshAt, type FaceEdit } from './edit.js'
import { isFaceData } from './contract.js'
import type { Paint } from './texture.js'
import { Reader, Writer } from './bytes.js'
import { EXPLICIT, explicit, floats, runsOf, sourcesOf, triangleSources, vertexSources } from './sources.js'

/** `edit` as bytes; `base` is the face mesh's geometry before rigging. */
export async function encodeFace(edit: FaceEdit, base: THREE.BufferGeometry): Promise<Uint8Array<ArrayBuffer>> {
  const w = await Writer.create()
  w.u32(edit.mesh)
  w.u32(base.getAttribute('position').count)
  w.u32(edit.material)
  w.u32(edit.paint.length)
  for (const { x, y, width, height, data } of edit.paint) {
    w.u32(x); w.u32(y); w.u32(width); w.u32(height)
    w.vertices(data, 4)
  }
  for (const g of [edit.still, edit.moving, edit.cavity]) writeGeometry(w, g, base)
  w.u32(edit.eyes.length)
  for (const { geometry, iris, irisRadius, pupilRadius } of edit.eyes) {
    writeGeometry(w, geometry)
    for (const x of [iris.r, iris.g, iris.b, irisRadius, pupilRadius]) w.f64(x)
  }
  for (const g of [edit.upperTeeth, edit.lowerTeeth, edit.tongue]) writeGeometry(w, g)
  w.u32(edit.bones.length)
  for (const { name, parent, position, rotation, pieces } of edit.bones) {
    w.string(name)
    w.string(parent ?? '')
    for (const x of position) w.f64(x)
    w.u32(rotation ? 1 : 0)
    for (const x of rotation ?? []) w.f64(x)
    w.array(Int32Array.from(pieces ?? [-1]))
  }
  w.string(JSON.stringify(edit.shapes))
  w.string(JSON.stringify(edit.deviation))
  return w.finish()
}

/** The FaceEdit `bytes` hold, for the object they were encoded for, whose face mesh supplies its own vertices. */
export async function decodeFace(bytes: Uint8Array, object: THREE.Object3D): Promise<FaceEdit> {
  const r = await Reader.create(bytes)
  const mesh = r.u32()
  const base = meshAt(object, mesh).geometry
  const count = r.u32()
  if (base.getAttribute('position').count !== count) throw new Error(`face: the cached face rig is for a face mesh of ${count} vertices, but mesh ${mesh} has ${base.getAttribute('position').count}`)
  const material = r.u32()
  const paint = Array.from({ length: r.u32() }, (): Paint => {
    const [x, y, width, height] = [r.u32(), r.u32(), r.u32(), r.u32()]
    const data = new Uint8ClampedArray(width * height * 4)
    r.vertices(data, 4)
    return { x, y, width, height, data }
  })
  const [still, moving, cavity] = [0, 1, 2].map(() => readGeometry(r, base))
  const eyes = Array.from({ length: r.u32() }, () => {
    const geometry = readGeometry(r)
    const [red, green, blue, irisRadius, pupilRadius] = [r.f64(), r.f64(), r.f64(), r.f64(), r.f64()]
    return { geometry, iris: new THREE.Color(red, green, blue), irisRadius, pupilRadius }
  })
  const [upperTeeth, lowerTeeth, tongue] = [0, 1, 2].map(() => readGeometry(r))
  const bones = Array.from({ length: r.u32() }, (): SkeletonBone => {
    const name = r.string(), parent = r.string()
    const position: Vec3 = [r.f64(), r.f64(), r.f64()]
    const rotation = r.u32() ? [r.f64(), r.f64(), r.f64(), r.f64()] as const : undefined
    const pieces = Array.from(r.array())
    const bone: SkeletonBone = { name, position, ...parent && { parent }, ...rotation && { rotation } }
    return pieces[0] === -1 ? bone : { ...bone, pieces }
  })
  const shapes: unknown = JSON.parse(r.string())
  const deviation: unknown = JSON.parse(r.string())
  if (!Array.isArray(shapes) || !shapes.every((name) => typeof name === 'string')) throw new Error('face: invalid cached shape names')
  if (typeof deviation !== 'object' || deviation === null || !Object.values(deviation).every((x) => typeof x === 'number')) throw new Error('face: invalid cached deviations')
  r.end()
  return { mesh, material, paint, still, moving, cavity, eyes, upperTeeth, lowerTeeth, tongue, bones, shapes, deviation: { ...deviation } }
}

function writeGeometry(w: Writer, g: THREE.BufferGeometry, base?: THREE.BufferGeometry): void {
  const count = g.getAttribute('position').count
  const vertices = vertexSources(g, base)
  w.u32(count)
  w.array(runsOf(vertices))
  const names = Object.keys(g.attributes)
  w.u32(names.length)
  for (const name of names) {
    const attribute = g.getAttribute(name)
    if (!(attribute.array instanceof Float32Array)) throw new Error(`face: cannot store attribute "${name}" of ${attribute.array.constructor.name}`)
    const referenced = base?.getAttribute(name) !== undefined
    w.string(name)
    w.u32(attribute.itemSize)
    w.u32(referenced ? 1 : 0)
    w.vertices(referenced ? Float32Array.from(explicit(attribute.array, attribute.itemSize, vertices)) : attribute.array, attribute.itemSize * 4)
  }
  const index = g.getIndex()
  if (!index) throw new Error('face: cannot store a geometry without an index')
  const triangles = triangleSources(index.array, vertices, base)
  w.array(runsOf(triangles))
  w.triangles(Uint32Array.from(explicit(index.array, 3, triangles)))
  w.u32(g.groups.length)
  for (const { start, count: length, materialIndex = 0 } of g.groups) { w.u32(start); w.u32(length); w.u32(materialIndex) }
  const { position = [], normal = [] } = g.morphAttributes
  w.u32(position.length)
  position.forEach((target, t) => {
    const deltas = [target.array, normal[t].array]
    const moved: number[] = []
    for (let v = 0; v < count; v++) if (deltas.some((d) => d[v * 3] || d[v * 3 + 1] || d[v * 3 + 2])) moved.push(v)
    w.string(target.name)
    w.sequence(Uint32Array.from(moved))
    // position then normal delta per moved vertex
    const quantized = new Int16Array(moved.length * 6)
    deltas.forEach((d, kind) => {
      let max = 0
      for (const v of moved) for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(d[v * 3 + k]))
      const scale = max / 32767
      w.f64(scale)
      moved.forEach((v, i) => { for (let k = 0; k < 3; k++) quantized[i * 6 + kind * 3 + k] = scale ? Math.round(d[v * 3 + k] / scale) : 0 })
    })
    w.vertices(quantized, 12)
  })
  const face: unknown = g.userData.face
  w.string(face === undefined ? '' : JSON.stringify(face))
}

function readGeometry(r: Reader, base?: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const count = r.u32()
  const vertices = sourcesOf(r.array())
  if (vertices.length !== count) throw new Error('face: invalid cached vertex runs')
  const explicitVertices = vertices.filter((source) => source === EXPLICIT).length
  const attributes = r.u32()
  for (let a = 0; a < attributes; a++) {
    const name = r.string()
    const size = r.u32()
    const referenced = r.u32() === 1
    const values = new Float32Array((referenced ? explicitVertices : count) * size)
    r.vertices(values, size * 4)
    if (!referenced) {
      g.setAttribute(name, new THREE.BufferAttribute(values, size))
      continue
    }
    const from = base?.getAttribute(name)
    if (!from) throw new Error(`face: the cached face rig refers to attribute "${name}" the face mesh lacks`)
    const theirs = floats(from)
    const out = new Float32Array(count * size)
    let n = 0
    vertices.forEach((source, v) => {
      if (source === EXPLICIT) out.set(values.subarray(n * size, ++n * size), v * size)
      else out.set(theirs.subarray(source * size, (source + 1) * size), v * size)
    })
    g.setAttribute(name, new THREE.BufferAttribute(out, size))
  }
  const triangles = sourcesOf(r.array())
  const own = r.triangles()
  const index = count > 0x10000 ? new Uint32Array(triangles.length * 3) : new Uint16Array(triangles.length * 3)
  // base vertex -> vertex here, for the base's triangles
  const local = new Int32Array(base?.getAttribute('position').count ?? 0).fill(EXPLICIT)
  vertices.forEach((source, v) => { if (source !== EXPLICIT) local[source] = v })
  const theirs = base?.getIndex()
  let n = 0
  triangles.forEach((source, t) => {
    for (let k = 0; k < 3; k++) {
      const v = source === EXPLICIT ? own[n++] : local[theirs?.getX(3 * source + k) ?? EXPLICIT]
      if (v === undefined || v < 0) throw new Error('face: invalid cached triangles')
      index[3 * t + k] = v
    }
  })
  g.setIndex(new THREE.BufferAttribute(index, 1))
  const groups = r.u32()
  for (let i = 0; i < groups; i++) g.addGroup(r.u32(), r.u32(), r.u32())
  const targets = Array.from({ length: r.u32() }, () => {
    const name = r.string()
    const moved = r.sequence()
    const scales = [r.f64(), r.f64()]
    const quantized = new Int16Array(moved.length * 6)
    r.vertices(quantized, 12)
    return scales.map((scale, kind) => {
      const dense = new Float32Array(count * 3)
      moved.forEach((v, i) => { for (let k = 0; k < 3; k++) dense[v * 3 + k] = quantized[i * 6 + kind * 3 + k] * scale })
      const delta = new THREE.BufferAttribute(dense, 3)
      delta.name = name
      return delta
    })
  })
  if (targets.length) {
    g.morphAttributes.position = targets.map(([position]) => position)
    g.morphAttributes.normal = targets.map(([, normal]) => normal)
    g.morphTargetsRelative = true
  }
  const face = r.string()
  if (face) {
    const data: unknown = JSON.parse(face)
    if (!isFaceData(data)) throw new Error('face: invalid cached face data')
    g.userData.face = data
  }
  return g
}
