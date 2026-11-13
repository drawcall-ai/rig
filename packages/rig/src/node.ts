import { CachedRigLoader as BaseLoader, type LoadedGLTF } from './loader.js'
import { readGLTF } from './gltf/load.js'

export * from './index.js'

/** Node.js loader: reads relative paths, `file:` URLs and remote URLs without browser globals; a root path reads from publicDir. */
export class CachedRigLoader extends BaseLoader {
  protected override read(url: string | URL, onProgress?: (event: ProgressEvent) => void): Promise<LoadedGLTF> {
    return readGLTF(this.createLoader(), url, onProgress)
  }
}
