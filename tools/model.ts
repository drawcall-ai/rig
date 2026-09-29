/** Shared by the tools: read a model (Draco/Meshopt too) and its world-space geometry. */

import { pathToFileURL } from 'node:url'
import { NodeIO, type Document } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import draco3d from 'draco3dgltf'
import { MeshoptDecoder } from 'meshoptimizer'
import { readScene, type SceneGeometry } from '../packages/skinning/src/scene.js'

export interface Model {
  document: Document
  scene: SceneGeometry
  min: [number, number, number]
  max: [number, number, number]
}

export async function createIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder,
  })
}

export async function loadModel(path: string): Promise<Model> {
  const document = await (await createIO()).read(path)
  const scene = readScene(document)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < scene.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], scene.positions[i + a])
      max[a] = Math.max(max[a], scene.positions[i + a])
    }
  }
  return { document, scene, min, max }
}

/** True when the module is the script being run (tools double as CLIs). */
export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && url === pathToFileURL(process.argv[1]).href
}

export const fmt = (n: number): string => (Math.abs(n) < 5e-4 ? '0' : n.toFixed(3))
export const vec = (v: ArrayLike<number>): string => `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}]`

export function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}
