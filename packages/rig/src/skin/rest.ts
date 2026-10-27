import { Matrix4, Quaternion, Vector3, type Bone } from 'three'

/** Local bind matrices travel with cloned bones and glTF extras, independently of host placement. */
export function saveRest(bone: Bone): void {
  bone.updateMatrix()
  bone.userData.rigBindMatrix = bone.matrix.toArray()
}

export function restMatrix(bone: Bone): Matrix4 | undefined {
  const value: unknown = bone.userData.rigBindMatrix
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length !== 16 || !value.every((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))) {
    throw new Error(`bone "${bone.name}" has invalid rigBindMatrix; expected 16 finite matrix elements`)
  }
  const matrix = new Matrix4().fromArray(value)
  assertTRS(matrix, `bone "${bone.name}" has invalid rigBindMatrix`)
  return matrix
}

/** Three.js bone position/quaternion/scale cannot represent a sheared local matrix. */
export function assertTRS(matrix: Matrix4, context: string): void {
  const elements = matrix.elements
  const determinant = matrix.determinant()
  const affine = close(elements[3], 0) && close(elements[7], 0) && close(elements[11], 0) && close(elements[15], 1)
  if (!elements.every(Number.isFinite) || !affine || !Number.isFinite(determinant) || determinant === 0) {
    throw new Error(`${context}; expected an invertible affine local transform without shear`)
  }
  const position = new Vector3()
  const quaternion = new Quaternion()
  const scale = new Vector3()
  matrix.decompose(position, quaternion, scale)
  const recomposed = new Matrix4().compose(position, quaternion, scale)
  // Exported transforms accumulate small errors through hierarchies; compare each basis at its own scale.
  const scales = [scale.x, scale.y, scale.z, 1]
  if (!elements.every((value, index) => Math.abs(value - recomposed.elements[index]) <= 1e-5 * Math.abs(scales[Math.floor(index / 4)]))) {
    throw new Error(`${context}; expected an invertible affine local transform without shear`)
  }
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-8 * Math.max(1, Math.abs(left), Math.abs(right))
}
