/**
 * How a shot displays the scene: weight colors and isolation. Each change returns a function that puts
 * the scene back as it was.
 */

import * as THREE from 'three'

export function isAncestorOrSelf(ancestor: THREE.Object3D, node: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = node; n; n = n.parent) if (n === ancestor) return true
  return false
}

/** The skin slot (0-3) holding a vertex's largest weight. */
function strongest(weights: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, vertex: number): number {
  let slot = 0
  for (let k = 1; k < 4; k++) if (weights.getComponent(vertex, k) > weights.getComponent(vertex, slot)) slot = k
  return slot
}

/**
 * Hides everything but the triangles whose vertices all have their strongest weight on `bone` or a
 * descendant. Returns their world bounds (current pose) and a function that shows everything again.
 */
export function isolate(object: THREE.Object3D, bone: THREE.Bone): { box: THREE.Box3; restore: () => void } {
  const box = new THREE.Box3()
  const undo: (() => void)[] = []
  const v = new THREE.Vector3()
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    if (!(node instanceof THREE.SkinnedMesh)) {
      const visible = node.visible
      node.visible = false
      undo.push(() => (node.visible = visible))
      return
    }
    const ids = node.geometry.getAttribute('skinIndex')
    const ws = node.geometry.getAttribute('skinWeight')
    const mine = node.skeleton.bones.map((b) => isAncestorOrSelf(bone, b))
    const keep = new Uint8Array(ids.count)
    for (let i = 0; i < ids.count; i++) {
      if (!mine[ids.getComponent(i, strongest(ws, i))]) continue
      keep[i] = 1
      box.expandByPoint(node.getVertexPosition(i, v).applyMatrix4(node.matrixWorld))
    }
    const index = node.geometry.getIndex()
    const count = index ? index.count : keep.length
    const triangles: number[] = []
    for (let t = 0; t < count; t += 3) {
      const corners = [t, t + 1, t + 2].map((c) => (index ? index.getX(c) : c))
      if (corners.every((c) => keep[c])) triangles.push(...corners)
    }
    node.geometry.setIndex(triangles)
    undo.push(() => node.geometry.setIndex(index))
  })
  return { box, restore: () => undo.forEach((fn) => fn()) }
}

/** Every bone of the scene's skeleton(s), in skeleton order: the order `boneColor` indexes. */
export function skeletonBones(object: THREE.Object3D): THREE.Bone[] {
  const bones = new Set<THREE.Bone>()
  object.traverse((node) => node instanceof THREE.SkinnedMesh && node.skeleton.bones.forEach((bone) => bones.add(bone)))
  return [...bones]
}

/**
 * A bone's color: neighbouring indices get far-apart hues (golden-ratio steps), at full saturation,
 * darker the less `weight` it holds.
 */
export function boneColor(index: number, weight = 1): THREE.Color {
  return new THREE.Color().setHSL((index * 0.618034) % 1, 1, 0.3 + 0.3 * weight)
}

/**
 * Colors the skinned meshes by weight: `bone`'s heatmap, or with `true` each vertex in the color of its
 * strongest bone (`palette` gives each bone its color index). Returns a function restoring the originals.
 */
export function paint(object: THREE.Object3D, weights: THREE.Bone | true, palette: THREE.Bone[]): () => void {
  const undo: (() => void)[] = []
  object.traverse((node) => {
    if (!(node instanceof THREE.SkinnedMesh)) return
    const colorIndex = node.skeleton.bones.map((bone) => palette.indexOf(bone))
    // -1 when the bone is in another skeleton: this mesh has no weight on it
    const index = weights === true ? -1 : node.skeleton.bones.indexOf(weights)
    const ids = node.geometry.getAttribute('skinIndex')
    const ws = node.geometry.getAttribute('skinWeight')
    const colors = new Float32Array(ids.count * 3)
    const color = new THREE.Color()
    for (let v = 0; v < ids.count; v++) {
      if (weights === true) {
        const slot = strongest(ws, v)
        color.copy(boneColor(colorIndex[ids.getComponent(v, slot)], ws.getComponent(v, slot)))
      } else {
        let w = 0
        for (let k = 0; k < 4; k++) if (ids.getComponent(v, k) === index) w += ws.getComponent(v, k)
        color.setHSL(0.66 * (1 - w), 0.9, w > 0 ? 0.5 : 0.18)
      }
      colors.set([color.r, color.g, color.b], v * 3)
    }
    // Keep the model's own vertex colors and material to put back afterwards
    const own = node.geometry.getAttribute('color')
    const material = node.material
    node.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    node.material = new THREE.MeshBasicMaterial({ vertexColors: true })
    undo.push(() => {
      node.material = material
      if (own) node.geometry.setAttribute('color', own)
      else node.geometry.deleteAttribute('color')
    })
  })
  return () => undo.forEach((fn) => fn())
}
