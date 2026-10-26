/** Weight caching: a solve's result keyed by everything that determines it. */

import manifest from '../../package.json' with { type: 'json' }
import type { SkeletonBone } from './skeleton.js'
import { computeWeights, type SkinSolution } from './weights.js'

/** Where skin() keeps solved weights between calls; a Map satisfies it, and a persistent store can too. */
export interface SkinCache {
  get(key: string): SkinSolution | undefined
  set(key: string, value: SkinSolution): void
}

/**
 * computeWeights through `cache`. A hit returns exactly what the solve would; the report is copied so the
 * caller cannot edit the cached one.
 */
export async function cachedWeights(
  cache: SkinCache,
  positions: Float32Array<ArrayBuffer>,
  indices: Uint32Array<ArrayBuffer>,
  skeleton: readonly SkeletonBone[],
  resolution: number,
): Promise<SkinSolution> {
  const key = await cacheKey(positions, indices, skeleton, resolution)
  const hit = cache.get(key)
  if (hit) check(hit, positions.length / 3)
  const solution = hit ?? await computeWeights(positions, indices, skeleton, resolution)
  if (!hit) cache.set(key, solution)
  return { ...solution, report: structuredClone(solution.report) }
}

/** A persistent store can hand back anything; JSON, for one, turns typed arrays into plain objects. */
function check({ skinIndices, skinWeights }: SkinSolution, vertices: number): void {
  const intact = skinIndices instanceof Uint16Array && skinWeights instanceof Float32Array
    && skinIndices.length === vertices * 4 && skinWeights.length === vertices * 4
  if (!intact) throw new Error('the skin cache returned a broken entry; store values with structured clone (IndexedDB), not JSON')
}

/**
 * SHA-256 (hex) of the solve's whole input: rig's version, the resolution, the skeleton in weight-slot
 * order and the world-space triangle soup. A collision would silently bind wrong weights, so this uses a
 * cryptographic hash rather than a short one; WebCrypto has it natively in Node and secure browser contexts.
 */
async function cacheKey(
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
