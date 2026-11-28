import { BufferGeometry, Material, Mesh, Line, Points, Skeleton, SkinnedMesh, Texture, type Object3D } from 'three'

/** Owns both replaced source resources and the generated rig. */
export class Resources {
  private readonly geometries = new Set<BufferGeometry>()
  private readonly materials = new Set<Material>()
  private readonly textures = new Set<Texture>()
  private readonly skeletons = new Set<Skeleton>()
  private disposed = false

  collect(scene: Object3D): void {
    scene.traverse((object) => {
      if (object instanceof SkinnedMesh) this.skeletons.add(object.skeleton)
      if (!(object instanceof Mesh || object instanceof Line || object instanceof Points)) return
      this.geometries.add(object.geometry)
      // the shadow pass's depth materials, which copyRenderState() carries over, are the object's too
      const materials = [object.material, object.customDepthMaterial, object.customDistanceMaterial].flat()
      for (const material of materials) {
        if (!material) continue
        this.materials.add(material)
        for (const value of Object.values(material)) if (value instanceof Texture) this.textures.add(value)
      }
    })
  }

  fail(error: unknown): never {
    try { this.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Resource disposal failed after an error') }
    throw error
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const errors: unknown[] = []
    for (const resource of [...this.geometries, ...this.materials, ...this.textures, ...this.skeletons]) {
      try { resource.dispose() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Resource disposal failed')
  }
}
