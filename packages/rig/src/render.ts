import type { Object3D } from 'three'

/**
 * Gives `target` the render state `source` was given, such as by a load's `object` function: shadows and their custom
 * depth materials, visibility, culling, draw order and layers. For meshes made to take a mesh's place or to extend it.
 */
export function copyRenderState(target: Object3D, source: Object3D): void {
  target.castShadow = source.castShadow
  target.receiveShadow = source.receiveShadow
  target.customDepthMaterial = source.customDepthMaterial
  target.customDistanceMaterial = source.customDistanceMaterial
  target.visible = source.visible
  target.frustumCulled = source.frustumCulled
  target.renderOrder = source.renderOrder
  target.layers.mask = source.layers.mask
}
