import { CacheEntry, type Dependency } from 'vitecache'
import { computeWeights } from './worker.js'
import { decode, encode } from './codec.js'

/** Compatible with GLTSScene.source and getGLTSSource(); dependencies are read after the model loads. */
export interface RigSource {
  readonly url: string
  readonly dependencyUrls: readonly string[]
}

export function cachedWeights(source: RigSource, request: RequestInit): typeof computeWeights {
  const urls = [...new Set([source.url, ...source.dependencyUrls])].sort()
  return async (positions, indices, skeleton, resolution) => {
    const files = await Promise.all(urls.map(async (url, index): Promise<[string, Dependency]> => [
      `source:${index}`, await dependency(url, request),
    ]))
    const entry = new CacheEntry({
      version: 'rig-weights@1',
      dependencies: {
        ...Object.fromEntries(files),
        rig: { package: '@drawcall/rig' },
        three: { package: 'three' },
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

async function dependency(input: string, request: RequestInit): Promise<Dependency> {
  const location = globalThis.location
  const url = new URL(input, location?.href)
  if (url.protocol === 'file:' || url.origin === location?.origin) {
    return { url: url.href }
  }
  // Vitecache resolves project files only. Remote assets use their content as input.
  const response = await fetch(url, { ...request, cache: 'no-cache' })
  if (!response.ok) throw new Error(`RigLoader cache dependency failed: ${url.href} (HTTP ${response.status})`)
  return { value: { url: url.href, hash: await digest(await response.arrayBuffer()) } }
}

async function digest(bytes: BufferSource): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
