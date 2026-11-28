import { Mesh, type Object3D, type Skeleton } from 'three'
import { boneTree } from './bone.js'
import { bind } from './skin/bind.js'
import { cachedWeights } from './skin/cache.js'
import { digestModel } from './digest.js'
import type { SkeletonBone } from './skin/skeleton.js'
import type { SkinReport } from './skin/weights.js'
import { Resources } from './resources.js'
import { checkResolution } from './measure/voxelize.js'
import { ModelLoader } from '#model'
import { FACE_BONES, type FaceOptions, type FaceResult } from './face/contract.js'

export interface RigRequest {
  /**
   * Creates the model to rig, a container such as a glTF scene, loading files with `loader`. Skeleton and face landmarks
   * are measured on it as placed, so a transform it sets, such as one turning, scaling or grounding the model, needs
   * no baking into the geometry. Write it inline in the load: the cache plugin warms it from its source in Node, so it
   * may use only its arguments, globals, its own declarations and what it imports dynamically.
   */
  object: (loader: ModelLoader) => Object3D | Promise<Object3D>
  /**
   * Serialized bones in world space, as the created object places the model. List children in segment order:
   * the first child ends its parent's segment. Pieces index pieces() of the model as `object` creates it, also when
   * `face` adds meshes.
   */
  skeleton: readonly SkeletonBone[]
  /** Voxels along the longest model axis. */
  resolution?: number
  /**
   * Rigs the face before skinning: moves the face's moving triangles into a `Face` mesh with the morph targets
   * (FaceData.shapes), lines the mouth and eye sockets with a `Cavity` mesh, adds `EyeLeft`, `EyeRight`, `TeethUpper`,
   * `TeethLower` and `Tongue` meshes, and adds the eye and teeth bones (FACE_BONES) under `head`, which needs a child
   * ending its segment. Like every skinned mesh of the result, these sit directly under the object, beside the face mesh.
   */
  face?: FaceOptions
}

export interface RigResult {
  /** The created object, its meshes replaced by skinned meshes bound to the new skeleton. */
  object: Object3D
  skeleton: Skeleton
  report: SkinReport
  /** The face rig's bones, shapes and landmark deviations, when the request has `face`. */
  face?: FaceResult
  /** Releases the created object's GPU resources and the rig's, including materials installed since, such as by wrinkles(). Safe to call more than once. */
  dispose(): void
}

export interface CacheOptions {
  /** The URL browsers read cached rigs from, including any Vite base, such as `/app/_cache/`. Defaults to `/_cache/`. */
  cachePath?: string
}

/**
 * Creates a model and rigs it, reusing the cached face rig for unchanged geometry and face options, and cached weights for
 * unchanged rigged geometry, skeleton and resolution. The cache plugin warms each literal
 * `new CachedRigLoader().loadAsync({ ... })` in Node, so browsers read both and run neither the face rigging nor the solver.
 */
export class CachedRigLoader {
  private readonly cachePath: string | undefined

  constructor({ cachePath }: CacheOptions = {}) {
    this.cachePath = cachePath
  }

  async loadAsync({ object: create, skeleton, resolution = 128, face: faceOptions }: RigRequest): Promise<RigResult> {
    checkResolution(resolution, 'CachedRigLoader resolution')
    // validates the requested skeleton before the costly create and face rig; the bound tree below adds the face bones
    boneTree(skeleton)
    if (faceOptions) checkFaceBones(skeleton, faceOptions.head)
    const object = await create(new ModelLoader())
    if (object instanceof Mesh) throw new Error('CachedRigLoader object() returned a Mesh; return a container such as a Group or Scene holding it')
    const resources = new Resources()
    try {
      // the model as created, before the face rig unskins it into poses each engine rounds its own way
      const model = await digestModel(object)
      // Loaded only for requests with a face, so body-only apps never load or fetch face code or its reference head.
      // Bundlers may still copy the reference head into a body-only build's assets, which nothing then requests.
      const rigged = faceOptions && await (await import('./face/cache.js')).cachedFace(object, skeleton, faceOptions, model, this.cachePath)
      // collected after the face rig, which releases the texture it repaints
      resources.collect(object)
      // the geometry bind() measures follows from the model and the face rig's edit
      const solve = cachedWeights(this.cachePath, { model, face: rigged?.edit ?? null })
      const { report, skeleton: bound } = await bind(object, boneTree(rigged?.skeleton ?? skeleton), resolution, solve)
      resources.collect(object)
      const dispose = () => {
        // collected again for what replaced resources after loading, such as the material wrinkles() installs
        resources.collect(object)
        resources.dispose()
      }
      return { object, skeleton: bound, report, face: rigged?.face, dispose }
    } catch (error) {
      resources.collect(object)
      return resources.fail(error)
    }
  }
}

/** Throws unless the face rig can hang its bones under `head`: the head is a bone, has a child ending its segment, and no bone already uses a FACE_BONES name. */
function checkFaceBones(skeleton: readonly SkeletonBone[], head: string): void {
  const names = new Set(skeleton.map((bone) => bone.name))
  if (!names.has(head)) throw new Error(`CachedRigLoader face.head "${head}" is not a bone of the skeleton`)
  // the face bones follow the requested ones, so a childless head would end its segment at LeftEye
  if (!skeleton.some((bone) => bone.parent === head)) throw new Error(`CachedRigLoader face.head "${head}" needs a child bone ending its segment, such as a head-top tip`)
  const taken = Object.values(FACE_BONES).filter((name) => names.has(name))
  if (taken.length) throw new Error(`CachedRigLoader skeleton already has ${taken.join(', ')}, which the face rig adds; rename or remove them`)
}
