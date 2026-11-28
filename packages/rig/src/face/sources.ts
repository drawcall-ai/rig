/**
 * Where a geometry's vertices and triangles come from in a base geometry, so the face codec stores references to the
 * face mesh's own elements instead of copies; EXPLICIT marks an element stored as it is.
 */

import type * as THREE from 'three'

/** Every component of an attribute as float32, as computeFace() reads the face mesh's own attributes. */
export function floats(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(attribute.count * attribute.itemSize)
  for (let v = 0; v < attribute.count; v++) for (let k = 0; k < attribute.itemSize; k++) out[v * attribute.itemSize + k] = attribute.getComponent(v, k)
  return out
}

/** Marks a vertex or triangle stored explicitly rather than referring to the base geometry's. */
export const EXPLICIT = -1

/** Runs of `sources` as (start, length) pairs: consecutive base elements from `start`, or EXPLICIT elements. */
export function runsOf(sources: Int32Array): Int32Array {
  const runs: number[] = []
  for (const source of sources) {
    const last = runs.length - 2
    const continues = last >= 0 && (source === EXPLICIT ? runs[last] === EXPLICIT : runs[last] !== EXPLICIT && runs[last] + runs[last + 1] === source)
    if (continues) runs[last + 1]++
    else runs.push(source, 1)
  }
  return Int32Array.from(runs)
}

/** Per element, its base element or EXPLICIT, from runsOf(). */
export function sourcesOf(runs: Int32Array): Int32Array {
  const sources: number[] = []
  for (let i = 0; i < runs.length; i += 2) for (let k = 0; k < runs[i + 1]; k++) sources.push(runs[i] === EXPLICIT ? EXPLICIT : runs[i] + k)
  return Int32Array.from(sources)
}

/**
 * Per vertex of `g`, the first vertex of `base` equal to it in every attribute both have, or EXPLICIT; all EXPLICIT
 * without a base or a shared position.
 */
export function vertexSources(g: THREE.BufferGeometry, base: THREE.BufferGeometry | undefined): Int32Array {
  const count = g.getAttribute('position').count
  const sources = new Int32Array(count).fill(EXPLICIT)
  const names = Object.keys(g.attributes).filter((name) => base?.getAttribute(name))
  if (!base || !names.includes('position')) return sources
  const theirs = names.map((name) => floats(base.getAttribute(name))), ours = names.map((name) => floats(g.getAttribute(name)))
  const sizes = names.map((name) => g.getAttribute(name).itemSize)
  const key = (arrays: Float32Array[], v: number) => arrays.map((a, i) => a.subarray(v * sizes[i], (v + 1) * sizes[i]).join(',')).join(';')
  const lookup = new Map<string, number>()
  for (let v = base.getAttribute('position').count - 1; v >= 0; v--) lookup.set(key(theirs, v), v)
  for (let v = 0; v < count; v++) sources[v] = lookup.get(key(ours, v)) ?? EXPLICIT
  return sources
}

/** Per triangle of `index`, the triangle of `base` with the same corners, in the same order, by `vertices`, or EXPLICIT. */
export function triangleSources(index: ArrayLike<number>, vertices: Int32Array, base: THREE.BufferGeometry | undefined): Int32Array {
  const sources = new Int32Array(index.length / 3).fill(EXPLICIT)
  const theirs = base?.getIndex()
  if (!theirs) return sources
  const lookup = new Map<string, number>()
  for (let t = theirs.count / 3 - 1; t >= 0; t--) lookup.set(`${theirs.getX(3 * t)},${theirs.getX(3 * t + 1)},${theirs.getX(3 * t + 2)}`, t)
  for (let t = 0; t < sources.length; t++) {
    const corners = [0, 1, 2].map((k) => vertices[index[3 * t + k]])
    if (!corners.includes(EXPLICIT)) sources[t] = lookup.get(corners.join(',')) ?? EXPLICIT
  }
  return sources
}

/** Picks the elements of `itemSize` components of `values` that `sources` marks EXPLICIT. */
export function explicit(values: ArrayLike<number>, itemSize: number, sources: Int32Array): number[] {
  const out: number[] = []
  sources.forEach((source, i) => { if (source === EXPLICIT) for (let k = 0; k < itemSize; k++) out.push(values[i * itemSize + k]) })
  return out
}
