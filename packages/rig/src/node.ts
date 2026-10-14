import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { RigLoader as BaseLoader } from './loader.js'
import { readGLTF } from './gltf/load.js'
import { solveParallel } from './skin/parallel.js'
import { useSolver } from './skin/weights.js'

useSolver(solveParallel)

export * from './index.js'

/** Node.js loader: reads local files and remote URLs without browser globals. */
export class RigLoader extends BaseLoader {
  protected override read(url: string | URL, onProgress?: (event: ProgressEvent) => void): Promise<GLTF> {
    return readGLTF(this.createLoader(), url, onProgress)
  }
}
