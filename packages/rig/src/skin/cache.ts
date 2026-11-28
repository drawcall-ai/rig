import { CacheEntry } from '@drawcall/cache'
import { rounded } from '../digest.js'
import { computeWeights } from './worker.js'
import { decode, encode } from './codec.js'

/**
 * A solve for bind() that reads the cache, keyed by what the solver gets: the geometry bind() measures, identified alike
 * in every engine by the digestModel() of the model as created and the digest of the face rig's edit, if any; the bones,
 * their joints rounded as digestModel() rounds transforms; and the resolution.
 */
export function cachedWeights(cachePath: string | undefined, geometry: { model: string; face: string | null }): typeof computeWeights {
  return async (positions, indices, bones, resolution) => {
    const entry = new CacheEntry({
      // Bump when the key or the encoded result format changes; the solver code is an input.
      version: 'rig-weights@6',
      basePath: cachePath,
      dependencies: {
        geometry: { value: { ...geometry } },
        resolution: { value: resolution },
        skeleton: { value: bones.map((bone) => ({
          name: bone.name,
          parent: bone.parent ?? null,
          position: rounded(bone.position),
          pieces: bone.pieces ?? null,
        })) },
      },
    })
    const bytes = await entry.load()
    if (bytes) return decode(bytes, positions.length / 3)
    const result = await computeWeights(positions, indices, bones, resolution)
    await entry.save(encode(result))
    return result
  }
}
