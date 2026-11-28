import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { Mesh, SkinnedMesh, type Object3D } from 'three'

/**
 * Hex SHA-256 of the bytes `view` covers, by which cache entries key geometry. Hashed natively where crypto.subtle
 * exists, and in JavaScript on insecure origins, such as a dev server opened by LAN address, which lack it.
 */
export async function digest(view: ArrayBufferView<ArrayBuffer>): Promise<string> {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  const subtle = globalThis.crypto?.subtle
  return bytesToHex(subtle ? new Uint8Array(await subtle.digest('SHA-256', bytes)) : sha256(bytes))
}

/**
 * Digest of the model under `object` as a load creates it: the tree's shape, each node's transform (the object's own
 * world transform, its descendants' local ones) rounded by rounded(), and each mesh's material count, if an array, and
 * local geometry, for a skinned mesh with its bind matrix, bone inverses and bones' world transforms, also rounded,
 * which pose it. Local geometry keeps what a load reads from its files bit-exact, and rounding the transforms keeps the
 * key alike across engines, whose sin and cos, behind Euler rotations, round differently; a pose computed from them
 * would carry that difference.
 */
export async function digestModel(object: Object3D): Promise<string> {
  object.updateWorldMatrix(true, true)
  const parts: Uint8Array[] = []
  const add = (view: ArrayBufferView) => parts.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  object.traverse((node) => {
    add(Float64Array.from([node.children.length, ...rounded(node === object ? node.matrixWorld.elements : node.matrix.elements)]))
    if (!(node instanceof Mesh)) return
    // the face rig keeps a single material's groups apart from an array's, so the count keys too
    add(Uint32Array.of(Array.isArray(node.material) ? node.material.length : 0))
    addGeometry(node, add)
  })
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return digest(bytes)
}

/** `values` in units of 1e-9, as integers: well above the ulps engines differ by, well below what a model resolves. */
export function rounded(values: ArrayLike<number>): number[] {
  // + 0 turns -0 into 0, which hashes differently
  return Array.from(values, (value) => Math.round(value * 1e9) + 0)
}

/** The mesh's local positions, index, every other vertex attribute, morph targets and groups, and what poses a skinned mesh. */
function addGeometry(mesh: Mesh, add: (view: ArrayBufferView) => void): void {
  const g = mesh.geometry
  const position = g.getAttribute('position')
  add(Float32Array.from({ length: position.count * 3 }, (_, i) => position.getComponent(Math.floor(i / 3), i % 3)))
  if (mesh instanceof SkinnedMesh) {
    const { bones, boneInverses } = mesh.skeleton
    const matrices = [mesh.bindMatrix, ...boneInverses, ...bones.map((bone) => bone.matrixWorld)]
    add(Float64Array.from([mesh.bindMode === 'attached' ? 0 : 1, ...rounded(matrices.flatMap((m) => m.elements))]))
  }
  const index = g.getIndex()
  add(Uint32Array.from(index ? index.array : []))
  for (const name of Object.keys(g.attributes).sort()) {
    if (name === 'position') continue
    add(new TextEncoder().encode(name))
    add(g.getAttribute(name).array)
  }
  // a model with morph targets keys apart, as the face rig refuses one
  add(Uint8Array.of(g.morphTargetsRelative ? 1 : 0))
  for (const [name, targets = []] of Object.entries(g.morphAttributes).sort(([a], [b]) => (a < b ? -1 : 1))) {
    add(new TextEncoder().encode(name))
    for (const target of targets) {
      add(new TextEncoder().encode(target.name))
      add(target.array)
    }
  }
  add(Uint32Array.from(g.groups.flatMap(({ start, count, materialIndex = 0 }) => [start, count, materialIndex])))
}
