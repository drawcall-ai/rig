import * as THREE from 'three'

/**
 * Temporarily display skin weights with unlit vertex colors. Omit `bone` to show each vertex's
 * strongest bone, or name a bone for its blue-to-red heatmap. Returns a function that restores
 * the original materials and vertex colors and disposes the diagnostic materials.
 * Apply only to skinned meshes owned by this asset, and restore before exporting it.
 */
export function weights(object: THREE.Object3D, bone?: string): () => void {
  const meshes: THREE.SkinnedMesh[] = []
  object.traverse((node) => {
    if (node instanceof THREE.SkinnedMesh) meshes.push(node)
  })
  if (meshes.length === 0) throw new Error('weights() needs a skinned model')
  const palette = [...new Set(meshes.flatMap((mesh) => mesh.skeleton.bones))]
  const selected = bone === undefined ? undefined : palette.find((entry) => entry.name === bone)
  if (bone !== undefined && !selected) throw new Error(`weights names unknown bone "${bone}"`)

  const undo = meshes.map((mesh) => {
    const originalGeometry = mesh.geometry
    const geometry = originalGeometry.clone()
    const originalMaterial = mesh.material
    const ids = geometry.getAttribute('skinIndex')
    const values = geometry.getAttribute('skinWeight')
    const colors = new Float32Array(ids.count * 3)
    const selectedIndex = selected ? mesh.skeleton.bones.indexOf(selected) : -1
    const color = new THREE.Color()
    for (let vertex = 0; vertex < ids.count; vertex++) {
      if (selected) {
        let value = 0
        for (let slot = 0; slot < 4; slot++) {
          if (ids.getComponent(vertex, slot) === selectedIndex) value += values.getComponent(vertex, slot)
        }
        color.setHSL(0.66 * (1 - value), 0.9, value > 0 ? 0.5 : 0.18)
      } else {
        let strongest = 0
        for (let slot = 1; slot < 4; slot++) {
          if (values.getComponent(vertex, slot) > values.getComponent(vertex, strongest)) strongest = slot
        }
        const index = palette.indexOf(mesh.skeleton.bones[ids.getComponent(vertex, strongest)])
        color.setHSL((index * 0.618034) % 1, 1, 0.3 + 0.3 * values.getComponent(vertex, strongest))
      }
      color.toArray(colors, vertex * 3)
    }
    const material = new THREE.MeshBasicMaterial({ vertexColors: true })
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    mesh.geometry = geometry
    mesh.material = material
    return () => {
      mesh.material = originalMaterial
      mesh.geometry = originalGeometry
      geometry.dispose()
      material.dispose()
    }
  })
  let restored = false
  return () => {
    if (restored) return
    restored = true
    for (const restore of undo) restore()
  }
}
