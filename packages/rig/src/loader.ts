import type { Object3D, Skeleton } from 'three'
import { boneTree } from './bone.js'
import { bind } from './skin/bind.js'
import { cachedWeights } from './skin/cache.js'
import type { SkeletonBone } from './skin/skeleton.js'
import type { SkinReport } from './skin/weights.js'
import { Resources } from './resources.js'
import { checkResolution } from './measure/voxelize.js'

export interface RigRequest {
  /**
   * Creates the model to rig, a container such as a glTF scene, unscaled at the origin. Write it inline in the load:
   * vitecache warms it from its source in Node, so it may use only globals, its own declarations and what it imports
   * dynamically.
   */
  object: () => Object3D | Promise<Object3D>
  /** Serialized bones in model space. List children in segment order: the first child ends its parent's segment. */
  skeleton: readonly SkeletonBone[]
  /** Voxels along the longest model axis. */
  resolution?: number
}

export interface RigResult {
  /** The created object, its meshes replaced by skinned meshes bound to the new skeleton. */
  object: Object3D
  skeleton: Skeleton
  report: SkinReport
  /** Releases the created object's GPU resources and the rig's. Safe to call more than once. */
  dispose(): void
}

export interface CacheOptions {
  /** The URL browsers read cached weights from, including any Vite base, such as `/app/_vitecache/`. Defaults to `/_vitecache/`. */
  cachePath?: string
}

/**
 * Creates a model and rigs it, reusing cached weights for unchanged geometry, skeleton and resolution. The vitecache
 * plugin warms each literal `new CachedRigLoader().loadAsync({ ... })` in Node, so browsers read the weights.
 */
export class CachedRigLoader {
  private readonly cachePath: string | undefined

  constructor({ cachePath }: CacheOptions = {}) {
    this.cachePath = cachePath
  }

  async loadAsync({ object: create, skeleton, resolution = 128 }: RigRequest): Promise<RigResult> {
    checkResolution(resolution, 'CachedRigLoader resolution')
    const root = boneTree(skeleton)
    const object = await create()
    const resources = new Resources()
    resources.collect(object)
    try {
      const { report, skeleton: bound } = await bind(object, root, resolution, cachedWeights(this.cachePath))
      resources.collect(object)
      return { object, skeleton: bound, report, dispose: () => resources.dispose() }
    } catch (error) {
      resources.collect(object)
      return resources.fail(error)
    }
  }
}
