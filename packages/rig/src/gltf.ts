/**
 * glTF side of save(): reads the source file's geometry in world space and
 * writes a rig into it (new joint tree, baked vertices, JOINTS_0/WEIGHTS_0),
 * keeping materials, textures and extensions exactly as they were.
 */

import {
  Primitive,
  PropertyType,
  type Accessor,
  type Buffer,
  type Document,
  type Mesh,
  type Node,
  type Root,
  type Skin,
} from '@gltf-transform/core'
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


export interface RigJoint {
  name: string
  /** Index of the parent joint, -1 for a root. */
  parentIndex: number
  /** Bind-pose local transform relative to the parent joint. */
  translation: [number, number, number]
  rotation: [number, number, number, number]
  scale: [number, number, number]
  /** Column-major inverse of the joint's bind-pose world matrix. */
  inverseBind: ArrayLike<number>
}

/**
 * Binds every part to one new skin: a joint tree at the scene root, each mesh
 * node replaced by a skinned node at the scene root with world-baked vertices,
 * the replaced rig removed. skinIndices/skinWeights are per vertex in `parts` order.
 */
export function writeSkin(
  document: Document,
  rigJoints: RigJoint[],
  parts: ScenePart[],
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
  /** Per part, world-space vertices to write instead of re-baking the source (the bind pose the caller saw). */
  baked: (BakedVertices | undefined)[] = [],
): void {
  const root = document.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  const buffer = root.listBuffers()[0] ?? document.createBuffer()

  const joints = rigJoints.map((joint) =>
    document.createNode(joint.name).setTranslation(joint.translation).setRotation(joint.rotation).setScale(joint.scale),
  )
  const inverseBindMatrices = new Float32Array(rigJoints.length * 16)
  rigJoints.forEach((joint, i) => {
    if (joint.parentIndex >= 0) joints[joint.parentIndex].addChild(joints[i])
    else scene.addChild(joints[i])
    inverseBindMatrices.set(Array.from(joint.inverseBind), i * 16)
  })
  const skin = document
    .createSkin('skeleton')
    .setSkeleton(joints[rigJoints.findIndex((joint) => joint.parentIndex < 0)])
    .setInverseBindMatrices(document.createAccessor().setType('MAT4').setArray(inverseBindMatrices).setBuffer(buffer))
  for (const joint of joints) skin.addJoint(joint)

  const oldMeshes = new Set<Mesh>()
  const oldSkins = new Set<Skin>(root.listSkins().filter((other) => other !== skin))
  const oldJoints = new Set<Node>([...oldSkins].flatMap((other) => other.listJoints()))
  const skinnedNodes = new Map<Node, Node>()
  for (const [p, part] of parts.entries()) {
    let skinned = skinnedNodes.get(part.node)
    if (!skinned) {
      const mesh = part.node.getMesh() as Mesh
      const weights = mesh.getWeights()
      skinned = document
        .createNode(part.node.getName())
        .setMesh(document.createMesh(mesh.getName()).setWeights(weights))
        .setSkin(skin)
      if (part.node.getWeights().length > 0) skinned.setWeights(part.node.getWeights())
      scene.addChild(skinned)
      skinnedNodes.set(part.node, skinned)
      oldMeshes.add(mesh)
    }
    ;(skinned.getMesh() as Mesh).addPrimitive(bakePrimitive(document, buffer, part, skinIndices, skinWeights, baked[p]))
  }

  for (const [original, skinned] of skinnedNodes) {
    original.setMesh(null).setSkin(null)
    // Morph target animations drive the node that now carries the mesh
    for (const animation of root.listAnimations()) {
      for (const channel of animation.listChannels()) {
        if (channel.getTargetNode() === original && channel.getTargetPath() === 'weights') channel.setTargetNode(skinned)
      }
    }
  }
  for (const mesh of oldMeshes) disposeMeshIfUnused(mesh)
  for (const oldSkin of oldSkins) {
    if (oldSkin.listParents().some((parent) => parent.propertyType === PropertyType.NODE)) continue
    const ibm = oldSkin.getInverseBindMatrices()
    oldSkin.dispose()
    if (ibm) disposeIfUnused(ibm)
  }
  removeOldRig(root, oldJoints, new Set(joints))
}

/**
 * The replaced skins' joints are a dead armature now: remove the ones without
 * meshes below them, with their animation channels, and rename any other node
 * whose name collides with a new joint so the new names stay exact (engines
 * look bones up by name).
 */
function removeOldRig(root: Root, oldJoints: Set<Node>, newJoints: Set<Node>): void {
  const holdsMesh = (node: Node): boolean => !!node.getMesh() || node.listChildren().some(holdsMesh)
  const removed = new Set([...oldJoints].filter((joint) => !holdsMesh(joint)))
  for (const animation of root.listAnimations()) {
    for (const channel of animation.listChannels()) {
      const target = channel.getTargetNode()
      if (!target || !removed.has(target)) continue
      const sampler = channel.getSampler()
      channel.dispose()
      if (sampler && !sampler.listParents().some((p) => p.propertyType === PropertyType.ANIMATION_CHANNEL)) sampler.dispose()
    }
    if (animation.listChannels().length === 0) animation.dispose()
  }
  for (const node of removed) node.dispose()
  const names = new Set([...newJoints].map((joint) => joint.getName()))
  for (const node of root.listNodes()) {
    if (!newJoints.has(node) && names.has(node.getName())) node.setName(`${node.getName()}_source`)
  }
}

/** A copy of the part's primitive with world-space vertex data and the new JOINTS_0/WEIGHTS_0. */
export interface BakedVertices {
  position: Float32Array
  normal?: Float32Array
}

function bakePrimitive(
  document: Document,
  buffer: Buffer,
  part: ScenePart,
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
  baked?: BakedVertices,
): Primitive {
  const primitive = part.primitive.clone()
  const { count, matrices } = part

  for (const semantic of primitive.listSemantics()) {
    if (semantic.startsWith('JOINTS_') || semantic.startsWith('WEIGHTS_')) primitive.setAttribute(semantic, null)
  }
  const bake = (accessor: Accessor | null, transform: typeof transformPoint, unit = false): Accessor | null => {
    if (!accessor) return null
    const out = new Float32Array(count * 3)
    const element: number[] = []
    for (let i = 0; i < count; i++) {
      transform(out, i * 3, matrices, i * 16, accessor.getElement(i, element))
      if (unit) normalize(out, i * 3)
    }
    return document.createAccessor().setType('VEC3').setArray(out).setBuffer(buffer)
  }
  const vec3 = (array: Float32Array) => document.createAccessor().setType('VEC3').setArray(array).setBuffer(buffer)
  primitive.setAttribute('POSITION', baked ? vec3(baked.position) : bake(primitive.getAttribute('POSITION'), transformPoint))
  primitive.setAttribute(
    'NORMAL',
    baked?.normal ? vec3(baked.normal) : bake(primitive.getAttribute('NORMAL'), transformNormal, true),
  )
  const tangent = primitive.getAttribute('TANGENT')
  if (tangent) {
    const out = new Float32Array(count * 4)
    const element: number[] = []
    for (let i = 0; i < count; i++) {
      tangent.getElement(i, element)
      transformVector(out, i * 4, matrices, i * 16, element)
      normalize(out, i * 4)
      out[i * 4 + 3] = element[3]
    }
    primitive.setAttribute('TANGENT', document.createAccessor().setType('VEC4').setArray(out).setBuffer(buffer))
  }
  for (const target of primitive.listTargets()) {
    const copy = target.clone()
    copy.setAttribute('POSITION', bake(target.getAttribute('POSITION'), transformVector))
    copy.setAttribute('NORMAL', bake(target.getAttribute('NORMAL'), transformNormal))
    copy.setAttribute('TANGENT', bake(target.getAttribute('TANGENT'), transformVector))
    primitive.removeTarget(target).addTarget(copy)
  }

  // A mirroring transform flips the winding once baked into the vertices
  const indices = primitive.getIndices()
  if (determinant3(matrices, 0) < 0 && indices) {
    const flipped = new Uint32Array(indices.getArray() ?? [])
    for (let i = 0; i + 2 < flipped.length; i += 3) [flipped[i + 1], flipped[i + 2]] = [flipped[i + 2], flipped[i + 1]]
    primitive.setIndices(document.createAccessor().setType('SCALAR').setArray(flipped).setBuffer(buffer))
  }

  const joints = new Uint16Array(count * 4)
  joints.set(skinIndices.subarray(part.offset * 4, (part.offset + count) * 4))
  const weights = skinWeights.slice(part.offset * 4, (part.offset + count) * 4)
  primitive.setAttribute('JOINTS_0', document.createAccessor().setType('VEC4').setArray(joints).setBuffer(buffer))
  primitive.setAttribute('WEIGHTS_0', document.createAccessor().setType('VEC4').setArray(weights).setBuffer(buffer))
  return primitive
}

function normalize(out: Float32Array, o: number): void {
  const len = Math.hypot(out[o], out[o + 1], out[o + 2])
  if (len > 0) for (let k = 0; k < 3; k++) out[o + k] /= len
}

function disposeMeshIfUnused(mesh: Mesh): void {
  if (mesh.listParents().some((parent) => parent.propertyType === PropertyType.NODE)) return
  const accessors = new Set<Accessor>()
  for (const primitive of mesh.listPrimitives()) {
    const indices = primitive.getIndices()
    if (indices) accessors.add(indices)
    for (const accessor of primitive.listAttributes()) accessors.add(accessor)
    for (const target of primitive.listTargets()) {
      for (const accessor of target.listAttributes()) accessors.add(accessor)
      target.dispose()
    }
    primitive.dispose()
  }
  mesh.dispose()
  for (const accessor of accessors) disposeIfUnused(accessor)
}

/** Unreferenced accessors would still be serialized. */
function disposeIfUnused(accessor: Accessor): void {
  if (!accessor.listParents().some((parent) => parent.propertyType !== PropertyType.ROOT)) accessor.dispose()
}
