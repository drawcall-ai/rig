import { CacheEntry } from 'vitecache'
import { computeWeights } from './worker.js'
import { decode, encode } from './codec.js'

export function cachedWeights(data: ArrayBuffer): typeof computeWeights {
  return async (positions, indices, skeleton, resolution) => {
    const entry = new CacheEntry({
      // Bump when solver behavior or the encoded result format changes.
      version: 'rig-weights@1',
      dependencies: {
        model: { value: await digest(data) },
        positions: { value: await digest(positions) },
        indices: { value: await digest(indices) },
        resolution: { value: resolution },
        skeleton: { value: skeleton.map((bone) => ({
          name: bone.name,
          parent: bone.parent ?? null,
          position: bone.position,
          pieces: bone.pieces ?? null,
        })) },
      },
    })
    const bytes = await entry.load()
    if (bytes) return decode(bytes, positions.length / 3)
    const result = await computeWeights(positions, indices, skeleton, resolution)
    await entry.save(encode(result))
    return result
  }
}

async function digest(bytes: BufferSource): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
