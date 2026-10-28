import { RigLoader as BaseLoader, type LoadedGLTF } from './loader.js'
import { readGLTF } from './gltf/load.js'

export * from './index.js'

/** Node.js loader: reads local files and remote URLs without browser globals. */
export class RigLoader extends BaseLoader {
  protected override read(url: string | URL, onProgress?: (event: ProgressEvent) => void): Promise<LoadedGLTF> {
    return readGLTF(this.createLoader(), url, onProgress)
  }
}
