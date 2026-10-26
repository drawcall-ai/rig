import { Loader, SkinnedMesh, type Skeleton, type AnimationClip, type Group } from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'meshoptimizer'
import { bones } from './bone.js'
import { skin } from './skin/bind.js'
import type { SkeletonBone } from './skin/skeleton.js'
import type { SkinReport } from './skin/weights.js'
import { Resources } from './resources.js'
import { requireTextures } from './gltf/textures.js'
import { checkResolution } from './measure/voxelize.js'

export interface RigRequest {
  url: string | URL
  /** Serialized bones in model space. List children in segment order: the first child ends its parent's segment. */
  skeleton: readonly SkeletonBone[]
  /** Voxels along the longest model axis. */
  resolution?: number
}

export interface RigResult {
  scene: Group
  skeleton: Skeleton
  report: SkinReport
  /** Source animation tracks target the replaced armature and are discarded. */
  animations: AnimationClip[]
  /** Releases source and generated GPU resources. Safe to call more than once. */
  dispose(): void
}

/** Loads a glTF and rigs a fresh scene from serialized skeleton input. */
export class RigLoader extends Loader<RigResult, RigRequest> {
  override load(request: RigRequest, onLoad: (result: RigResult) => void, onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void): void {
    const url = String(request.url)
    this.manager.itemStart(url)
    void this.rig(request, onProgress).then(onLoad).catch((error: unknown) => {
      this.manager.itemError(url)
      if (onError) onError(error)
      else console.error(error)
    }).finally(() => this.manager.itemEnd(url))
  }

  protected createLoader(): GLTFLoader {
    return new GLTFLoader(this.manager)
      .setMeshoptDecoder(MeshoptDecoder)
      .register(requireTextures)
      .setPath(this.path)
      .setResourcePath(this.resourcePath)
      .setCrossOrigin(this.crossOrigin)
      .setWithCredentials(this.withCredentials)
      .setRequestHeader(this.requestHeader)
  }

  protected async read(url: string | URL, onProgress?: (event: ProgressEvent) => void): Promise<GLTF> {
    const loader = this.createLoader()
    const input = String(url)
    if (/^[a-z][a-z\d+.-]*:/i.test(input) || input.startsWith('/')) loader.setPath('')
    return loader.loadAsync(input, onProgress)
  }

  private async rig(request: RigRequest, onProgress?: (event: ProgressEvent) => void): Promise<RigResult> {
    const url = String(request.url)
    const resolution = request.resolution ?? 128
    checkResolution(resolution, 'RigLoader resolution')
    const { root } = bones(request.skeleton)
    const source = await this.read(url, onProgress)
    const { scene } = source
    const resources = new Resources()
    source.scenes.forEach((entry) => resources.collect(entry))
    try {
      const report = await skin(scene, root, resolution)
      resources.collect(scene)
      let skeleton: Skeleton | undefined
      scene.traverse((entry) => {
        entry.animations = []
        if (entry instanceof SkinnedMesh) skeleton = entry.skeleton
      })
      if (!skeleton) throw new Error('RigLoader source contains no meshes to rig')
      return { scene, skeleton, report, animations: [], dispose: () => resources.dispose() }
    } catch (error) {
      resources.collect(scene)
      return resources.fail(error)
    }
  }
}
