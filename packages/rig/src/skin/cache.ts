/** Weight caching: a solve's result keyed by everything that determines it. */

import manifest from '../../package.json' with { type: 'json' }
import type { SkeletonBone } from './skeleton.js'
import type { SkinWeights } from './weights.js'

/** Where skin() keeps solved weights between calls; a Map satisfies it, and a persistent store can too. */
export interface SkinCache {
  get(key: string): SkinWeights | undefined
  set(key: string, value: SkinWeights): void
}

/**
 * SHA-256 (hex) of the solve's whole input: rig's version, the resolution, the skeleton in weight-slot
 * order and the world-space triangle soup. A collision would silently bind wrong weights, so this uses a
 * cryptographic hash rather than a short one; WebCrypto has it natively in Node and secure browser contexts.
 */
export async function cacheKey(
  positions: Float32Array<ArrayBuffer>,
  indices: Uint32Array<ArrayBuffer>,
  skeleton: readonly SkeletonBone[],
  resolution: number,
): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('skin() cache needs crypto.subtle, available in Node and secure (https or localhost) pages')
  const header = JSON.stringify({ version: manifest.version, resolution, skeleton, vertices: positions.length, indices: indices.length })
  const text = new TextEncoder().encode(header)
  const input = new Uint8Array(text.byteLength + positions.byteLength + indices.byteLength)
  input.set(text)
  input.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), text.byteLength)
  input.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), text.byteLength + positions.byteLength)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
