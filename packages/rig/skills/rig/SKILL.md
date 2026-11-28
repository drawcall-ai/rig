---
name: rig
description: Rig glTF/GLB models and procedural three.js objects for animation with @drawcall/rig, as a cached rig load in a Vite app's source, including faces driven by ARKit blendshapes (eyes, teeth, tongue). Use when asked to rig, skin, add a skeleton or armature, make a mesh animatable, add facial rigging or blendshapes, or skin a model at runtime in a three.js app from a serialized skeleton. Not for modeling or animating an already suitable rig.
---

# Rigging a model

Deliver a literal `new CachedRigLoader().loadAsync({ ... })` in the app's source, holding the serialized skeleton and an inline function that creates the model, together with the model files it loads. Rig computes the weights; the cache plugin computes them during development and builds so browsers only read them.

```sh
npm install @drawcall/rig three @drawcall/cache
```

## Inspect before defining joints

Load the model with rig's `ModelLoader`, which reads in Node as in browsers, and measure it in a Node script or in the running app. Render views with [vitexec](https://github.com/drawcall-ai/vitexec/blob/main/packages/vitexec/skills/vitexec/SKILL.md) scripts in the app's page: a script imports what it inspects by root path, such as `import { character } from '/src/character.ts'`, and renders it with its own renderer and cameras before taking the screenshot. Use orthographic side, front, and top views to identify anatomy and facing direction. Focus on small articulated regions before choosing their controls; full-body views can hide fingers or wing rays.

The creature's own left is `up × forward`: facing +z, left is +x; facing +x, left is -z. Naming sides from the camera's left silently swaps the rig.

Generated models often arrive at an arbitrary size and facing, with a million triangles or more: check bounds and triangle count first, and give the model the size, facing and simplification the app needs in the load's `object` function, since the skeleton is measured on what it returns. Size, facing and grounding can be the returned object's transform, such as `scene.rotation.y` and `scene.scale`; simplification must change the geometry. Use `THREE.Box3` for bounds, `pieces()` for connected geometry, and batched `section()` samples for interior limb coordinates. When sections merge a feature with its surroundings, use `pick()` sweeps across it: thickness peaks help distinguish wing rods from membranes. Batch nearby samples rather than voxelizing per point. When samples miss a supposed rod, sweep nearby positions before guessing depth or raising resolution. Mirror joint positions only after checking the opposite side; posed models can have different curves and depth.

## Author the load

```ts
// src/character.ts — coordinates below illustrate the pattern; measure your model.
import { CachedRigLoader } from '@drawcall/rig'

export const character = () => new CachedRigLoader().loadAsync({
  object: async (loader) => (await loader.loadAsync('models/character.glb')).scene,
  skeleton: [
    { name: 'Hips', position: [0, 0.9, 0] },
    { name: 'Spine', parent: 'Hips', position: [0, 1.1, 0] },
    { name: 'Head', parent: 'Spine', position: [0, 1.5, 0] },
    { name: 'Head_End', parent: 'Head', position: [0, 1.7, 0] },
    // Add all measured limb chains, each with an end joint.
  ],
  resolution: 128,
})
```

`rig.object` is the created model, its meshes bound to the new skeleton; add it to the scene and call `rig.dispose()` when removing it. Each load creates and rigs a fresh object, so iterating on the skeleton always starts from the original model rather than compounding the previous result's deformation. For an object that exists only at runtime, use `skin()` directly, which computes on every call: pass a skeleton list when joints are data, or build bones with `bone()` when joints are built in code.

Add the `cache()` plugin from `@drawcall/cache/vite`, which computes the weights and face rig of each load in the app's source in Node during development and builds; a load it cannot see recomputes in every browser session. So write one literal load per model, as above: the skeleton and resolution as JSON, and the `object` function inline. Load model files with its argument, a `ModelLoader`, rather than importing `@drawcall/rig` in it: in a production build that import can wait forever on an app that awaits the rig at its top level. Results are keyed by the geometry and transforms the function creates, the skeleton, the resolution and the face options, so changing the function without changing those keeps them. Give the loader the model's path below `public/` without a leading slash, which also resolves under a Vite `base` for pages at the app's root; under a base, browsers also need the cache's URL: `` new CachedRigLoader({ cachePath: `${import.meta.env.BASE_URL}_cache/` }) ``. Follow the installed cache skill at `node_modules/@drawcall/cache/skills/cache/SKILL.md` for the plugin and deployment. Outside Vite, a Node script computes and saves weights directly.

Joints, pieces and face landmarks are measured on the model as `object` returns it, its own transform included. `rig.object` keeps the transform `object` set, so place it after loading by wrapping it in a group, or compose with that transform rather than overwrite it.

## Choose a skeleton the solver can use

For smooth deformation, a segment runs from its joint to its first child. List the continuation child before branches (Hips → Spine before legs). End each deforming chain with a tip joint: a hand without a child has no segment to attract smooth weights.

For smooth weighting, place joints inside the solid, centered in limb cross-sections; rigid pivots can sit in gaps between components. All serialized positions are in world space, including children; do not subtract parent positions. Name a humanoid's bones for what will drive them: a runtime that animates the skeleton may require its own names, so check its documentation, while Mixamo names (`Hips`, `Spine`, `LeftArm`, …) suit retargeting Mixamo clips. Newly generated bones do not make source animation clips compatible. Other creatures benefit from clear anatomical names.

Choose controls from intended movement and visible anatomy, rather than connectivity or material. One connected metal hand can span the wrist, palm, and fingers; treating it as one rigid piece loses those articulations. Preserve useful controls when balancing warning count against iteration speed.

Use `pieces` assignments for rigid components such as eyes, armor, and props, pinned to the joint that moves them. Fully rigid assemblies can assign every piece and avoid the voxel solve. Components spanning articulations need deforming segments. A short torso bone can hold a fused jacket or belly away from a moving limb.

A joint separates the parent's weight region from the child's. If a shoulder cap stays behind when the arm rises, moving the arm joint toward the body can bring that region onto the arm's segment. On curved anatomy, interior endpoints can still put a straight segment outside the solid; follow measured curvature with intermediate joints before increasing resolution. More bones alone do not improve the result: a segment needs enough geometry and voxel resolution to influence it.

## Rig a face

A load with `face: { head, landmarks }` rigs the face before skinning: it opens the mouth into a cavity, puts eyeballs in sockets, adds teeth and a tongue, and bakes the ARKit blendshapes, transferred from a human reference head, where the face moves. The face mesh keeps the triangles no shape moves; the moving ones go to a separate mesh beside it, and the meshes the face rig adds are named in the doc of `RigRequest.face`. You place surface landmarks; their doc comments on `FaceLandmarks` say where each goes. It suits a face whose eyes are painted on closed skin and whose lips meet, on one mesh without morph targets. The face may come already skinned, as auto-rigged models do; place the landmarks on it as its bones currently pose it, which is what the load measures. A head with eye holes or separate eyeball meshes is not supported; say so rather than forcing it. The skeleton needs the head bone named in `head`, containing the skull and with a child such as a head-top tip ending its segment; the eye and teeth bones are added under it (`FACE_BONES`), so the skeleton must not use those names itself. Skeleton `pieces` still index the model as the load's function creates it, before the face rig adds its meshes.

Place landmarks from evidence, not from proportions. Render an orthographic front view of the head at a size where an eye spans dozens of pixels, read where features sit in the coordinates the skeleton uses, then take each point's depth from a `THREE.Raycaster` cast along the face's backward direction onto the face mesh: the first hit is the visible skin. `pick()` measures in voxels, millimeters too coarse for an eye a centimeter wide. Eyes and lip lines are easiest to place on the texture, so render with original materials; where a moustache or beard sculpted into the mesh hides the mouth corners, follow the lip groove to its end with ray profiles. Draw the placed points as small markers over front and side views and correct any that float off the skin or sit on the wrong feature: a mouth corner placed on the cheek or a lid point on the brow distorts every shape around it. Left and right are the character's own (`up × forward`); swapping them throws.

```ts
// in the load, next to skeleton and resolution — illustrative values for a head facing +x
face: {
  head: 'Head',
  landmarks: {
    eyeInnerLeft: [0.048, 0.42, -0.0106], eyeInnerRight: [0.048, 0.42, 0.0106],
    // ...every landmark of FaceLandmarks
    hairline: [0.055, 0.4335, 0],
  },
},
```

Check `rig.face.deviation` first and re-place any landmark it flags, then check the shapes themselves on a close-up, mesh-only render: set one shape at a time to 1 on every mesh whose `morphTargetDictionary` has it (the face, cavity, lower teeth and tongue each carry the shapes that move them) and compare it with the neutral face. Check at least `jawOpen`, `mouthSmileLeft`, `mouthFunnel`, `eyeBlinkLeft`, `browInnerUp` and `noseSneerLeft`.

At rest the lips should meet with no gap or seam, and the eyes should look forward with the lids just over the iris. `jawOpen` should open the mouth cleanly onto teeth and tongue, `eyeBlink` should close the lids fully, and nothing above the hairline should move. A torn mouth corner or a lid that misses the eyeball points to the corresponding landmarks. Rigging a face takes seconds, so the cache plugin does it with the weights in Node, and browsers only apply the stored rig; after you change landmarks, the plugin rigs the face again before it serves the next load.

Expression wrinkles are an optional shading layer: `await wrinkles(rig.object)`, imported from `@drawcall/rig`, replaces the face's material with a node material whose creases follow the morph weights. It needs three's `WebGPURenderer` from `three/webgpu`, which it loads only when called; apps on `WebGLRenderer` leave it out and keep everything else.

To animate the face, use any ARKit-compatible driver (Live Link Face, MediaPipe, Audio2Face or hand-set values): the face's morph targets carry the ARKit blendshape names and sit on every mesh they move, and eye look directions are rotations of the eye bones rather than shapes. `FACE_BONES` documents the eye bones' axes, and `FaceData.shapes` (`userData.face` on the face geometry, checked by `isFaceData`) every baked shape.

## Iterate from evidence

Read the report alongside rendered deformations; neither alone proves quality. Begin at a moderate resolution and time the solve. Fix misplaced segments before increasing resolution; raise it when thin anatomy or touching parts remain unresolved. Doubling resolution costs about eight times the voxel work.

Use warnings to choose the next measurement or motion check. A suggested joint position is a candidate: confirm it stays inside the intended anatomy and rerun the bend. A control with no dominant vertices can still move weighted children; test that motion before shortening its chain or deleting it. Tiny deforming segments may need higher resolution or fewer, longer segments. Cross-weighting between separate fingers can drag a neighbor, while blending across a wing membrane can be necessary. Inspect individual bends to distinguish them; a lower warning count alone is not improvement.

Keep diagnostics in temporary vitexec scripts rather than in the app, so the app keeps the bind pose and original materials. Use rig's `pose()` for reproducible bends, `weights()` for weight paint, and native `THREE.SkeletonHelper` for the bone overlay. In a script that loaded `rig` and rendered it in its own `scene`, this shows bone ownership and joints together:

```ts
pose(rig.object, { rotations: { Head: [0.6, 0, 0] } })
const restore = weights(rig.object)
const helper = new THREE.SkeletonHelper(rig.object)
for (const material of [helper.material].flat()) material.depthTest = false
helper.renderOrder = 1
scene.add(helper)
```

Import `pose` and `weights` from `@drawcall/rig`. To isolate a joint's influence, replace the paint call with `weights(rig.object, 'Head')`; call `restore()` to return to the original materials.

Check each articulated region by rotating its own joint about 45° and confirming the intended geometry moves. Include small controls such as wrists, fingers, feet, and wing rays; a full-body pose can hide an ineffective joint. Use ownership paint to find competing regions, then a selected-bone heatmap to inspect the suspect influence. Judge the actual deformation in original-material, mesh-only views: overlays and paint can hide collapse or dragging. Also inspect a natural pose from several sides. Targets can avoid guessing bend signs.

Inspect the screenshots, adjust the skeleton in the load, and check again. When delivering a GLB, export `rig.object` in its bind pose with three's `GLTFExporter`, then reload the file and check its bind pose, original materials, and a representative joint bend; success in the app does not validate the exported rig. Deliver the load with its model files and disclose remaining deformation limits.
