/**
 * Node-only: save the rigged scene back into the source file load() read, with
 * materials, textures and extensions kept byte for byte.
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { NodeIO, type Document } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import draco3d from 'draco3dgltf'
import { MeshoptDecoder } from 'meshoptimizer'
import * as THREE from 'three'
import { readParts, writeSkin, type BakedVertices, type RigJoint } from './document.js'
import { sourceOf, type Source } from './load.js'

/**
 * Writes the rig of a scene from load() + skin() as a glTF (.glb or .gltf): the source file with the new
 * joint tree (in its bind pose, whatever the current pose), skinned meshes and the old rig removed.
 */
export async function save(object: THREE.Object3D, path: string): Promise<void> {
  const file: unknown = object.userData.source
  if (typeof file !== 'string') throw new Error('save() writes into the file load() read; this object did not come from load()')
  const skinned: { mesh: THREE.SkinnedMesh; source: Source }[] = []
  object.traverse((node) => {
    if (!(node instanceof THREE.SkinnedMesh)) return
    const source = sourceOf(node)
    if (source) skinned.push({ mesh: node, source })
  })
  const skeleton = skinned[0]?.mesh.skeleton
  if (!skeleton || skinned.some(({ mesh }) => mesh.skeleton !== skeleton)) throw new Error('save() needs every mesh bound by one skin() call')

  const io = await createIO()
  const document = await io.read(file)
  const parts = readParts(document)
  const nodes = document.getRoot().listNodes()
  const byKey = new Map(skinned.map(({ mesh, source }) => [`${source.node}:${source.primitive}`, mesh]))
  const total = parts.reduce((sum, part) => sum + part.count, 0)
  const skinIndices = new Uint16Array(total * 4)
  const skinWeights = new Float32Array(total * 4)
  // Write the vertices skin() baked, exactly as they were seen and checked, not a re-bake of the source
  const baked: (BakedVertices | undefined)[] = []
  for (const part of parts) {
    const key = `${nodes.indexOf(part.node)}:${part.node.getMesh()?.listPrimitives().indexOf(part.primitive)}`
    const mesh = byKey.get(key)
    if (!mesh) {
      // Primitives three.js does not load as meshes (points, lines) follow the root joint
      for (let v = 0; v < part.count; v++) skinWeights[(part.offset + v) * 4] = 1
      baked.push(undefined)
      continue
    }
    baked.push({ position: floats(mesh.geometry.getAttribute('position')), normal: mesh.geometry.getAttribute('normal') && floats(mesh.geometry.getAttribute('normal')) })
    const indices = mesh.geometry.getAttribute('skinIndex')
    const weights = mesh.geometry.getAttribute('skinWeight')
    if (indices.count !== part.count) throw new Error(`mesh "${mesh.name}" has ${indices.count} vertices, the source primitive ${part.count}`)
    for (let v = 0; v < part.count; v++) {
      for (let k = 0; k < 4; k++) {
        skinIndices[(part.offset + v) * 4 + k] = indices.getComponent(v, k)
        skinWeights[(part.offset + v) * 4 + k] = weights.getComponent(v, k)
      }
    }
  }

  // Bind pose from the inverse bind matrices, so a posed scene still saves its rest pose
  const bindWorld = skeleton.boneInverses.map((inverse) => inverse.clone().invert())
  const joints: RigJoint[] = skeleton.bones.map((bone, i) => {
    const parentIndex = skeleton.bones.findIndex((other) => other === bone.parent)
    const local = parentIndex >= 0 ? bindWorld[parentIndex].clone().invert().multiply(bindWorld[i]) : bindWorld[i].clone()
    const translation = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    local.decompose(translation, rotation, scale)
    return {
      name: bone.name,
      parentIndex,
      translation: translation.toArray(),
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
      scale: scale.toArray(),
      inverseBind: skeleton.boneInverses[i].elements,
    }
  })
  writeSkin(document, joints, parts, skinIndices, skinWeights, baked)
  const out = resolve(path)
  mkdirSync(dirname(out), { recursive: true })
  await io.write(out, withoutCompression(document))
}

/** A vec3 attribute as a tightly packed Float32Array (attributes may be interleaved). */
function floats(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(attribute.count * 3)
  for (let i = 0; i < attribute.count; i++) {
    out[i * 3] = attribute.getX(i)
    out[i * 3 + 1] = attribute.getY(i)
    out[i * 3 + 2] = attribute.getZ(i)
  }
  return out
}

async function createIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder,
  })
}

/** Geometry was decoded on read; write it back uncompressed instead of needing encoders. */
function withoutCompression(document: Document): Document {
  for (const extension of document.getRoot().listExtensionsUsed()) {
    const name = extension.extensionName
    if (name === 'KHR_draco_mesh_compression' || name === 'EXT_meshopt_compression') extension.dispose()
  }
  return document
}
