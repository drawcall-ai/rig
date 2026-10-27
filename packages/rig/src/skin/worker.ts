import { createWorker } from '#worker'
import type { SkeletonBone } from './skeleton.js'
import type { SkinSolution } from './weights.js'

export interface Job {
  positions: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
  skeleton: readonly SkeletonBone[]
  resolution: number
}

export interface Callbacks {
  result(value: SkinSolution): void
  error(error: Error): void
}

export interface WorkerHandle {
  postMessage(job: Job, transfer: ArrayBuffer[]): void
  terminate(): void | Promise<number>
}

/** Consumes the triangle buffers. Each job owns its worker, including on failure. */
export async function computeWeights(
  positions: Float32Array<ArrayBuffer>,
  indices: Uint32Array<ArrayBuffer>,
  skeleton: readonly SkeletonBone[],
  resolution: number,
): Promise<SkinSolution> {
  let worker: WorkerHandle | undefined
  try {
    return await new Promise<SkinSolution>((resolve, reject) => {
      worker = createWorker({ result: resolve, error: reject })
      worker.postMessage({ positions, indices, skeleton, resolution }, [positions.buffer, indices.buffer])
    })
  } finally {
    await worker?.terminate()
  }
}
