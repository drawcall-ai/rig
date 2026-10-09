---
name: rig
description: Rig any 3D model (glTF/GLB) for animation by writing three.js scripts with @drawcall/rig — humanoids, animals, birds, fish, robots, creatures with props or armor. Use when asked to rig, skin, add a skeleton or armature to, or make a mesh animatable. Not for animating a model that already has the rig you want, or for modeling.
---

# Rigging a model with @drawcall/rig

You rig by writing a TypeScript script: load the model, measure it, build a skeleton out of plain `THREE.Bone`s, compute skin weights, check the deformation in rendered images, and save. Re-run the whole script from `load()` after each change rather than patching a scene in place: `skin()` replaces the meshes and the armature, so a second pass on the same scene builds on the first one's output. The package docs in `node_modules/@drawcall/rig/README.md` list every option.

```sh
npm i @drawcall/rig three && npm i -D tsx   # scripts: ESM ("type": "module"), run with npx tsx rig.ts
```

```ts
import { bone, load, pick, pieces, render, save, section, skin, type View } from '@drawcall/rig'

const scene = await load('model.glb')
await render(scene, { out: 'shots/model.png' })          // what it is, which way it faces
console.log(JSON.stringify(section(scene, [{ y: 0.3 }, { y: 0.6 }])), pieces(scene)) // limb centers per height; separate pieces
console.log(JSON.stringify(pick(scene, { camera: '+x' }, [{ y: 0.9, z: 0.05 }, { y: 0.9, z: 0.1 }]))) // the solid under each grid point of the +x view
const hips = bone('Hips', [0, 0.95, 0])                    // joints in world space, parent attached
// ... the rest of the skeleton, every chain ending in a *_End bone
console.log((await skin(scene, hips)).warnings)            // read every warning, then check visually
const poses: Omit<View, 'camera'>[] = [{ title: 'left knee', rotations: { LeftLeg: [0.8, 0, 0] } } /* , one per major joint */]
await render(scene, { out: 'shots/rom.png', views: poses.map((pose) => [{ ...pose, camera: '+x' }, { ...pose, camera: '+x', bones: false }]) })
await render(scene, { out: 'shots/owners.png', views: [[{ camera: '+x', weights: true, bones: 'names' }]] }) // which bone owns what
await save(scene, 'rigged.glb')
```

## Find orientation before anything else

Render first and decide what the creature is and which world axis its face points to. Models often face +x or -z rather than glTF's +z. The creature's own left is `up × forward`: facing +z, left is +x; facing +x, left is -z. Getting this wrong silently swaps every Left/Right name.

## Measure with section and pick, not with images

Images identify body parts and judge deformation, but they can't give depth, and perspective distorts distances. Take joint positions from `section()` region centers, which are world `[x, y, z]` inside the solid: cut at knee height and each leg is one region, and its center is the knee joint. For a feature a cut can't single out, such as a wing's finger rods, which a section merges with the membrane between them, read its position off an orthographic view's grid and `pick` from the same view at that point: `pick` returns every span along the line, nearest first; the middle of the one you want is the joint position, and its thickness tells a rod from the membrane. A single guessed point misses thin rods in a sheet; pick a row of points across the sheet from a view facing the sheet (such as from above a wing) in one call, and take the thickness peaks. Spans come in whole voxels, so raise the resolution for thin parts. Adding the root bone to the scene before `skin()` (`scene.add(hips)`) lets `render` show the planned joints over the mesh, a cheap check before the solve.

## Skeleton rules the weights depend on

- A bone's segment runs from its joint to its first child, and weights gather around that segment, so add the continuation child first (Hips → Spine before the legs).
- Leaf bones get no weights. End every chain with an end bone at the tip (`HeadTop_End`, `LeftHand_End`, `Tail_End`); without it the last real bone deforms nothing.
- Joints belong inside the mesh, centered in the limb's cross-section. A segment outside the solid attracts nothing.
- Humanoids: use Mixamo names (Hips, Spine, Spine1, Spine2, Neck, Head, LeftShoulder, LeftArm, LeftForeArm, LeftHand, LeftUpLeg, LeftLeg, LeftFoot, LeftToeBase, and Right*) so retargeting tools can map them; the bones are world-aligned in the model's rest pose, so existing clips still need retargeting rather than playing directly. Other creatures: clear anatomical names.
- Separate rigid pieces (eyes, armor plates, props) listed by `pieces()`: set `b.userData.pieces = [index]` so they move without stretching; such a bone drives only its pieces. An accessory fused into the body mesh (a backpack, a vest) is not a separate piece: give it a normal bone, so neighbouring bones stop pulling it.
- Along a chain, the joint decides where one bone's weights end and the next one's begin. An area that stays behind when a limb moves (a shoulder cap left flat while the arm rises) belongs to the parent; moving the child's joint toward the body puts that area along the child's segment.
- A bone that animation never moves still holds weight. A short extra bone under the torso can keep an area that is fused to a limb (a jacket side under the arm, a belly under a leg) with the torso; retargeting ignores bones it doesn't know.

## Treat warnings as the checklist

`skin()` reports one warning per cause, with what the solver found and where; it doesn't prescribe the fix. Three are specific to this solver:

- "the main influence of no vertex": a low-poly limb where no ring of vertices lies between the bone's joint and its child's. The joint position it gives would put a ring between them.
- "get no vertices of their own at resolution N", with sizes in voxels: those body parts (fingers, ears, small toes) are only a few voxels thick or long on this grid, so the solver can't separate their bones. A higher resolution or fewer, longer bones both resolve it.
- "crossed between touching parts": the bone holds weight on a touching body part that belongs to another bone (arm onto torso, leg onto leg, tail onto legs). Moving the joints apart, a higher resolution, or binding separate pieces with `pieces` each reduce it. Between the finger bones of one membrane (wings, webbed feet), shared weight is expected; judge it in a pose render.

Resolution is voxels along the model's longest axis, and each doubling costs about 8×. Time the first `skin()` at the default 128: if it takes well under a second, 256 still runs in seconds. Iterate at the highest resolution that stays fast, and raise it where a warning points at small body parts or leaks. A run at 512 or more can take long enough for a tool call to time out; running it in the background avoids that.

## Judge the deformation, don't assume it

No warnings doesn't mean a good rig. `render` takes rows of views, and each view sets its own camera, pose and display, so one sheet can compare them side by side. Render one row per major joint bent about 45°, plus one natural motion for the creature (walk, swim, flap), and include a view with the bones hidden (`bones: false`): a flattened cap or a pulled-out side is easy to miss under the skeleton. When something stretches or drags, `weights: true` colors each vertex by its strongest bone, showing every boundary at once, and `weights: 'BoneName'` shows one bone's falloff. `isolate: 'BoneName'` hides everything else, which helps with hands, feet and anything else the body hides.

A view can point a bone's segment at a world point with `targets`, read off the grid, `section()` or `pick()` like a joint position; this avoids guessing rotation signs and mirrors by flipping one coordinate. `rotations` are Euler XYZ in radians in the bone's bind frame, and bones made with `bone()` have world-aligned axes in the bind pose, so the bend direction follows the right-hand rule: a limb hanging along -y swings its end toward -z under a positive x rotation, which is backward for a creature facing +z. Twist around a bone's own segment needs a rotation. `save()` always writes the bind pose, whatever pose was last rendered. While only the poses change, a script that loads the saved rig and renders from it skips re-skinning, which saves the most at high resolution.
