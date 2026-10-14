---
name: rig
description: Rig glTF/GLB models for animation as editable .glts assets with @drawcall/rig. Use when asked to rig, skin, add a skeleton or armature, or make a mesh animatable. Pair with the glts skill for loading, rendering, and exporting. Not for modeling or animating an already suitable rig.
---

# Rigging a model

Deliver a `.glts` asset containing the model reference, serialized skeleton, and rigging request, together with its source model. Rig computes weights; glts executes the asset, renders checks, and exports GLB. Read the installed glts skill at `node_modules/@drawcall/glts/skills/glts/SKILL.md` for that workflow and resource lifecycle ([upstream skill](https://github.com/drawcall-ai/glts/blob/main/packages/glts/skills/glts/SKILL.md)).

```sh
npm install @drawcall/rig @drawcall/glts three
```

## Inspect before defining joints

Start with an inspection `.glts` using Three.js `GLTFLoader` with glts's `loadingManager`. Resolve the model URL against `import.meta.url`, add the model beneath `scene`, and supply preview lights. Render orthographic side, front, and top views to identify anatomy and facing direction. Focus on small articulated regions before choosing their controls; full-body views can hide fingers or wing rays.

The creature's own left is `up × forward`: facing +z, left is +x; facing +x, left is -z. Naming sides from the camera's left silently swaps the rig.

Use `THREE.Box3` for bounds, `pieces()` for connected geometry, and batched `section()` samples for interior limb coordinates. When sections merge a feature with its surroundings, use `pick()` sweeps across it: thickness peaks help distinguish wing rods from membranes. Batch nearby samples rather than voxelizing per point. When samples miss a supposed rod, sweep nearby positions before guessing depth or raising resolution. Mirror joint positions only after checking the opposite side; posed models can have different curves and depth.

## Author the asset

```ts
// character.glts — coordinates below illustrate the pattern; measure your model.
import * as THREE from 'three'
import { isPreview, loadingManager, onDispose, scene } from '@drawcall/glts'
import { RigLoader } from '@drawcall/rig'

const rig = await new RigLoader(loadingManager).loadAsync({
  url: new URL('./character.glb', import.meta.url),
  skeleton: [
    { name: 'Hips', position: [0, 0.9, 0] },
    { name: 'Spine', parent: 'Hips', position: [0, 1.1, 0] },
    { name: 'Head', parent: 'Spine', position: [0, 1.5, 0] },
    { name: 'Head_End', parent: 'Head', position: [0, 1.7, 0] },
    // Add all measured limb chains, each with an end joint.
  ],
  resolution: 128,
})
scene.add(rig.scene)
onDispose(() => rig.dispose())
console.log(JSON.stringify(rig.report))

if (isPreview) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.5))
  const light = new THREE.DirectionalLight(0xffffff, 2)
  light.position.set(2, 4, 3)
  scene.add(light)
}
```

For a procedural mesh already constructed in the asset, use `bone()` and `skin()` directly instead of loading it again. Rebuild from the original model on each iteration: re-skinning the previous result compounds its deformation.

## Choose a skeleton the solver can use

For smooth deformation, a segment runs from its joint to its first child. List the continuation child before branches (Hips → Spine before legs). End each deforming chain with a tip joint: a hand without a child has no segment to attract smooth weights.

For smooth weighting, place joints inside the solid, centered in limb cross-sections; rigid pivots can sit in gaps between components. All serialized positions use the same model coordinate system, including children; do not subtract parent positions. Give humanoids Mixamo anatomical names for later retargeting; newly generated bones do not make source animation clips compatible. Other creatures benefit from clear anatomical names.

Choose controls from intended movement and visible anatomy, rather than connectivity or material. One connected metal hand can span the wrist, palm, and fingers; treating it as one rigid piece loses those articulations. Preserve useful controls when balancing warning count against iteration speed.

Use `pieces` assignments for rigid components such as eyes, armor, and props, pinned to the joint that moves them. Fully rigid assemblies can assign every piece and avoid the voxel solve. Components spanning articulations need deforming segments. A short torso bone can hold a fused jacket or belly away from a moving limb.

A joint separates the parent's weight region from the child's. If a shoulder cap stays behind when the arm rises, moving the arm joint toward the body can bring that region onto the arm's segment. On curved anatomy, interior endpoints can still put a straight segment outside the solid; follow measured curvature with intermediate joints before increasing resolution. More bones alone do not improve the result: a segment needs enough geometry and voxel resolution to influence it.

## Iterate from evidence

Read the report alongside rendered deformations; neither alone proves quality. Begin at a moderate resolution and time the solve. Fix misplaced segments before increasing resolution; raise it when thin anatomy or touching parts remain unresolved. Doubling resolution costs about eight times the voxel work.

Use warnings to choose the next measurement or motion check. A suggested joint position is a candidate: confirm it stays inside the intended anatomy and rerun the bend. A control with no dominant vertices can still move weighted children; test that motion before shortening its chain or deleting it. Tiny deforming segments may need higher resolution or fewer, longer segments. Cross-weighting between separate fingers can drag a neighbor, while blending across a wing membrane can be necessary. Inspect individual bends to distinguish them; a lower warning count alone is not improvement.

Keep diagnostics in `isPreview` so export keeps the bind pose and original materials. Use rig's `pose()` for reproducible bends, `weights()` for weight paint, and native `THREE.SkeletonHelper` for the bone overlay. Add this to the preview block to see bone ownership and joints together:

```ts
pose(rig.scene, { rotations: { Head: [0.6, 0, 0] } })
const restore = weights(rig.scene)
onDispose(restore)
const helper = new THREE.SkeletonHelper(rig.scene)
for (const material of [helper.material].flat()) material.depthTest = false
helper.renderOrder = 1
scene.add(helper)
onDispose(() => helper.dispose())
```

Import `pose` and `weights` from `@drawcall/rig`. To isolate a joint's influence, replace the paint call with `weights(rig.scene, 'Head')`. Browser hosts need glts's preview mode (`isPreview: true`); its render command already enables it.

Check each articulated region by rotating its own joint about 45° and confirming the intended geometry moves. Include small controls such as wrists, fingers, feet, and wing rays; a full-body pose can hide an ineffective joint. Use ownership paint to find competing regions, then a selected-bone heatmap to inspect the suspect influence. Judge the actual deformation in original-material, mesh-only views: overlays and paint can hide collapse or dragging. Also inspect a natural pose from several sides. Targets can avoid guessing bend signs.

```sh
npx drawcall glts render character.glts -o check.png --views '[[{"camera":"+x"},{"camera":"+z"},{"camera":"persp"}]]'
npx drawcall glts export character.glts -o character.rigged.glb
```

Inspect the images, adjust the source skeleton, and rebuild from the original model. When delivering a GLB, reload it and check its bind pose, original materials, and a representative joint bend; success in the source preview does not validate the exported rig. Deliver the `.glts` with its referenced files and disclose remaining deformation limits. Follow the glts skill for export behavior and animation clips.
