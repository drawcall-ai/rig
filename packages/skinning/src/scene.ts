/**
 * Scene geometry in world space: every primitive of every mesh node in the
 * default scene, with node transforms (or, for already-skinned meshes, the
 * current skin pose) baked into the vertices.
 */

import { Primitive, type Accessor, type Document, type Node } from '@gltf-transform/core'

export type Mat4 = ArrayLike<number>

export interface ScenePart {
  node: Node
  primitive: Primitive
  /** First vertex of this part in SceneGeometry.positions. */
  offset: number
  count: number
  /** Per-vertex world matrix (column-major, 16 floats per vertex). */
  matrices: Float32Array
}

export interface SceneGeometry {
  /** World-space xyz of every vertex of every part, concatenated. */
  positions: Float32Array<ArrayBuffer>
  /** Triangles indexing into positions (points/lines contribute none). */
  indices: Uint32Array<ArrayBuffer>
  parts: ScenePart[]
}

export function readScene(document: Document): SceneGeometry {
  const root = document.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  if (!scene) throw new Error('glTF has no scene')

  const parts: ScenePart[] = []
  let vertexCount = 0
  scene.traverse((node) => {
    const mesh = node.getMesh()
    if (!mesh) return
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION')
      if (!position) continue
      const count = position.getCount()
      parts.push({ node, primitive, offset: vertexCount, count, matrices: vertexMatrices(node, primitive, count) })
      vertexCount += count
    }
  })
  if (parts.length === 0) throw new Error('glTF scene contains no mesh with POSITION data')

  const positions = new Float32Array(vertexCount * 3)
  const indices: number[] = []
  const point = [0, 0, 0]
  for (const part of parts) {
    const accessor = part.primitive.getAttribute('POSITION') as Accessor
    for (let i = 0; i < part.count; i++) {
      accessor.getElement(i, point)
      transformPoint(positions, (part.offset + i) * 3, part.matrices, i * 16, point)
    }
    for (const index of triangleIndices(part.primitive, part.count)) indices.push(part.offset + index)
  }
  return { positions, indices: new Uint32Array(indices), parts }
}

/** Node world matrix per vertex, or the blended joint matrices for a skinned mesh. */
function vertexMatrices(node: Node, primitive: Primitive, count: number): Float32Array {
  const matrices = new Float32Array(count * 16)
  const skin = node.getSkin()
  const joints = primitive.getAttribute('JOINTS_0')
  const weights = primitive.getAttribute('WEIGHTS_0')
  if (!skin || !joints || !weights) {
    const world = node.getWorldMatrix()
    for (let i = 0; i < count; i++) matrices.set(world, i * 16)
    return matrices
  }

  // glTF skinning ignores the mesh node's own transform: world = sum(w * joint * ibm)
  const ibms = skin.getInverseBindMatrices()
  const jointMatrices = skin.listJoints().map((joint, j) => {
    const ibm = ibms ? ibms.getElement(j, new Array(16)) : identity()
    return multiply(joint.getWorldMatrix(), ibm)
  })
  const jointIds = [0, 0, 0, 0]
  const jointWeights = [0, 0, 0, 0]
  for (let i = 0; i < count; i++) {
    joints.getElement(i, jointIds)
    weights.getElement(i, jointWeights)
    for (let k = 0; k < 4; k++) {
      if (jointWeights[k] === 0) continue
      const m = jointMatrices[jointIds[k]]
      for (let e = 0; e < 16; e++) matrices[i * 16 + e] += m[e] * jointWeights[k]
    }
  }
  return matrices
}

/** Triangle list for TRIANGLES / TRIANGLE_STRIP / TRIANGLE_FAN; empty otherwise. */
function triangleIndices(primitive: Primitive, count: number): number[] {
  const accessor = primitive.getIndices()
  const source = accessor
    ? Array.from({ length: accessor.getCount() }, (_, i) => accessor.getScalar(i))
    : Array.from({ length: count }, (_, i) => i)
  const mode = primitive.getMode()
  if (mode === Primitive.Mode.TRIANGLES) return source
  const triangles: number[] = []
  if (mode === Primitive.Mode.TRIANGLE_STRIP) {
    for (let i = 0; i + 2 < source.length; i++) {
      if (i % 2 === 0) triangles.push(source[i], source[i + 1], source[i + 2])
      else triangles.push(source[i + 1], source[i], source[i + 2])
    }
  } else if (mode === Primitive.Mode.TRIANGLE_FAN) {
    for (let i = 1; i + 1 < source.length; i++) triangles.push(source[0], source[i], source[i + 1])
  }
  return triangles
}

export function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/** Column-major a * b. */
export function multiply(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3]
    }
  }
  return out
}

export function transformPoint(out: Float32Array, o: number, m: Mat4, mo: number, p: ArrayLike<number>): void {
  const [x, y, z] = [p[0], p[1], p[2]]
  out[o] = m[mo] * x + m[mo + 4] * y + m[mo + 8] * z + m[mo + 12]
  out[o + 1] = m[mo + 1] * x + m[mo + 5] * y + m[mo + 9] * z + m[mo + 13]
  out[o + 2] = m[mo + 2] * x + m[mo + 6] * y + m[mo + 10] * z + m[mo + 14]
}

/** Linear part only (directions, tangents, morph position deltas). */
export function transformVector(out: Float32Array, o: number, m: Mat4, mo: number, v: ArrayLike<number>): void {
  const [x, y, z] = [v[0], v[1], v[2]]
  out[o] = m[mo] * x + m[mo + 4] * y + m[mo + 8] * z
  out[o + 1] = m[mo + 1] * x + m[mo + 5] * y + m[mo + 9] * z
  out[o + 2] = m[mo + 2] * x + m[mo + 6] * y + m[mo + 10] * z
}

/** Inverse-transpose of the linear part, for normals (not renormalized). */
export function transformNormal(out: Float32Array, o: number, m: Mat4, mo: number, n: ArrayLike<number>): void {
  const a = m[mo], b = m[mo + 1], c = m[mo + 2]
  const d = m[mo + 4], e = m[mo + 5], f = m[mo + 6]
  const g = m[mo + 8], h = m[mo + 9], i = m[mo + 10]
  // Cofactor matrix = det * inverse-transpose
  const c00 = e * i - f * h, c01 = f * g - d * i, c02 = d * h - e * g
  const c10 = c * h - b * i, c11 = a * i - c * g, c12 = b * g - a * h
  const c20 = b * f - c * e, c21 = c * d - a * f, c22 = a * e - b * d
  const det = a * c00 + d * c10 + g * c20
  const inv = det === 0 ? 0 : 1 / det
  const [x, y, z] = [n[0], n[1], n[2]]
  out[o] = inv * (c00 * x + c10 * y + c20 * z)
  out[o + 1] = inv * (c01 * x + c11 * y + c21 * z)
  out[o + 2] = inv * (c02 * x + c12 * y + c22 * z)
}

export function determinant3(m: Mat4, mo: number): number {
  const a = m[mo], b = m[mo + 1], c = m[mo + 2]
  const d = m[mo + 4], e = m[mo + 5], f = m[mo + 6]
  const g = m[mo + 8], h = m[mo + 9], i = m[mo + 10]
  return a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e)
}
