import type { GLTFLoaderPlugin, GLTFParser } from 'three/addons/loaders/GLTFLoader.js'
import { Resources } from '../resources.js'

/** GLTFLoader treats failed images as optional; a rig must preserve its source appearance. */
export function requireTextures(parser: GLTFParser): GLTFLoaderPlugin {
  const failures: Error[] = []
  const original = parser.loadTextureImage.bind(parser)
  parser.loadTextureImage = async (textureIndex, sourceIndex, loader) => {
    const texture = await original(textureIndex, sourceIndex, loader)
    if (!texture) failures.push(new Error(`RigLoader: failed to load texture ${textureIndex} (image ${sourceIndex})`))
    return texture
  }
  return {
    name: 'rig_require_textures',
    async afterRoot(result) {
      if (!failures.length) return
      const resources = new Resources()
      result.scenes.forEach((scene) => resources.collect(scene))
      resources.fail(new AggregateError(failures, 'RigLoader: source textures failed to load'))
    },
  }
}
