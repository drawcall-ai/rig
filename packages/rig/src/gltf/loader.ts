import type { LoadingManager } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'meshoptimizer'
import { requireTextures } from './textures.js'

/**
 * A GLTFLoader for models to rig: decodes meshopt compression and fails when a texture does not load, since a rig
 * must keep its source appearance. The Node build reads without browser globals, and reads a path such as
 * `/model.glb` or `model.glb` below the vitecache plugin's publicDir, or else `public/` in the working directory, as a
 * page at the app's root requests it. A relative path also works below a Vite base, since browsers resolve it
 * against the page.
 */
export class ModelLoader extends GLTFLoader {
  constructor(manager?: LoadingManager) {
    super(manager)
    this.setMeshoptDecoder(MeshoptDecoder).register(requireTextures)
  }
}
