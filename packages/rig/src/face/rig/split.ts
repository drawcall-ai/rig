/** Splitting the rigged face geometry by what its morph targets move. */

import * as THREE from 'three'

/** Per vertex, whether a morph target moves it or turns its normal. */
export function movedVertices(geometry: THREE.BufferGeometry): Uint8Array {
  const moved = new Uint8Array(geometry.getAttribute('position').count)
  const { position = [], normal = [] } = geometry.morphAttributes
  for (const target of [...position, ...normal]) {
    for (let v = 0; v < moved.length; v++) if (target.getX(v) || target.getY(v) || target.getZ(v)) moved[v] = 1
  }
  return moved
}

/** Removes the morph targets that move no vertex and turn no normal. */
export function dropStill(geometry: THREE.BufferGeometry): void {
  const { position, normal } = geometry.morphAttributes
  if (!position || !normal) return
  const kept = position.flatMap((_, i) => (zero(position[i]) && zero(normal[i]) ? [] : [i]))
  if (!kept.length) {
    geometry.morphAttributes = {}
    return
  }
  geometry.morphAttributes.position = kept.map((i) => position[i])
  geometry.morphAttributes.normal = kept.map((i) => normal[i])
}

const zero = (target: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
  for (let i = 0; i < target.array.length; i++) if (target.array[i]) return false
  return true
}

/**
 * The triangles of `geometry`'s groups that `keep` passes, given their material and vertices, groups kept, with only
 * the vertices they use and only the morph targets that move those.
 */
export function subset(geometry: THREE.BufferGeometry, keep: (material: number, triangle: number[]) => boolean): THREE.BufferGeometry {
  const index = geometry.getIndex()
  if (!index) throw new Error('face: the cut geometry has no index')
  const out = new THREE.BufferGeometry()
  const corners: number[] = []
  for (const { start, count, materialIndex = 0 } of geometry.groups) {
    const first = corners.length
    for (let t = start; t < start + count; t += 3) {
      const triangle = [index.getX(t), index.getX(t + 1), index.getX(t + 2)]
      if (keep(materialIndex, triangle)) corners.push(...triangle)
    }
    if (corners.length > first) out.addGroup(first, corners.length - first, materialIndex)
  }
  // in their order in `geometry`, so runs of them stay runs
  const used = [...new Set(corners)].sort((a, b) => a - b)
  const remap = new Int32Array(geometry.getAttribute('position').count)
  used.forEach((v, i) => { remap[v] = i })
  const triangles = corners.map((v) => remap[v])
  const pick = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const picked = new THREE.BufferAttribute(new Float32Array(used.length * attribute.itemSize), attribute.itemSize)
    picked.name = attribute.name
    used.forEach((v, i) => { for (let k = 0; k < attribute.itemSize; k++) picked.setComponent(i, k, attribute.getComponent(v, k)) })
    return picked
  }
  for (const [name, attribute] of Object.entries(geometry.attributes)) out.setAttribute(name, pick(attribute))
  const { position, normal } = geometry.morphAttributes
  if (position && normal) {
    out.morphAttributes.position = position.map(pick)
    out.morphAttributes.normal = normal.map(pick)
    out.morphTargetsRelative = geometry.morphTargetsRelative
    dropStill(out)
  }
  out.setIndex(triangles)
  return out
}
