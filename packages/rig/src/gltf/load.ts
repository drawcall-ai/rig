/** Node-only: load a glTF as a three.js scene that remembers its source for save(). */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { MeshoptDecoder } from 'meshoptimizer'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/** glTF association of a three.js mesh, set by load() in userData.gltf: which source node/primitive it came from. */
export interface Source {
  node: number
  primitive: number
}

export function sourceOf(mesh: THREE.Mesh): Source | undefined {
  const value: unknown = mesh.userData.gltf
  if (typeof value !== 'object' || value === null || !('node' in value) || !('primitive' in value)) return undefined
  const { node, primitive } = value
  return typeof node === 'number' && typeof primitive === 'number' ? { node, primitive } : undefined
}

/** Loads a .glb/.gltf as a three.js scene (the gltf.scene). Remembers the file for save(). */
export async function load(path: string): Promise<THREE.Group> {
  const file = resolve(path)
  const bytes = readFileSync(file)
  await MeshoptDecoder.ready
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), `${dirname(file)}/`)
  const associations = gltf.parser.associations
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    const primitive = associations.get(object)?.primitives ?? 0
    let owner: THREE.Object3D | null = object
    while (owner && associations.get(owner)?.nodes === undefined) owner = owner.parent
    const node = owner ? associations.get(owner)?.nodes : undefined
    if (node !== undefined) object.userData.gltf = { node, primitive } satisfies Source
  })
  gltf.scene.userData.source = file
  gltf.scene.updateMatrixWorld(true)
  return gltf.scene
}
