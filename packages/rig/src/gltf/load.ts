/** Node-only: load a glTF as a three.js scene that remembers its source for save(). */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { MeshoptDecoder } from 'meshoptimizer'
import * as THREE from 'three'
import { GLTFLoader, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js'

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
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).register(decodeImages)
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

/**
 * A GLTFLoader plugin that decodes images in Node: three.js decodes them with browser APIs (Image, Blob URLs).
 * Each image becomes a DataTexture of its RGBA pixels, which render() samples.
 */
function decodeImages(parser: GLTFParser): { name: string } {
  const cache = new Map<number, Promise<THREE.Texture>>()
  parser.loadImageSource = (index) => {
    const cached = cache.get(index)
    if (cached) return cached.then((texture) => texture.clone())
    const promise = decode(parser, index)
    cache.set(index, promise)
    return promise
  }
  return { name: 'rig_decode_images' }
}

async function decode(parser: GLTFParser, index: number): Promise<THREE.Texture> {
  const source: { uri?: string; bufferView?: number; mimeType?: string } = parser.json.images[index]
  let bytes: Buffer
  if (source.bufferView !== undefined) bytes = Buffer.from(await parser.getDependency('bufferView', source.bufferView))
  else if (source.uri?.startsWith('data:')) bytes = Buffer.from(source.uri.slice(source.uri.indexOf(',') + 1), 'base64')
  else if (source.uri) bytes = readFileSync(resolve(parser.options.path, decodeURIComponent(source.uri)))
  else throw new Error(`load: image ${index} has neither a uri nor a bufferView`)
  const image = await loadImage(bytes)
  const context = createCanvas(image.width, image.height).getContext('2d')
  context.drawImage(image, 0, 0)
  const texture = new THREE.DataTexture(context.getImageData(0, 0, image.width, image.height).data, image.width, image.height)
  texture.userData.mimeType = source.mimeType
  texture.needsUpdate = true
  return texture
}
