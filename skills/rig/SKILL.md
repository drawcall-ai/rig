---
name: rig
description: Rig any 3D model (glTF/GLB) for animation by writing three.js scripts with @drawcall/rig — humanoids, animals, birds, fish, robots, creatures with props or armor. Use when asked to rig, skin, add a skeleton or armature to, or make a mesh animatable. Not for animating a model that already has the rig you want, or for modeling.
---

# Rigging a model with @drawcall/rig

You rig by writing a TypeScript script: load the model, measure it, build a skeleton out of plain `THREE.Bone`s, compute skin weights, check the deformation in rendered images, and save. Re-run the whole script after each change; the package docs in `node_modules/@drawcall/rig/README.md` list every option.

```sh
npm i @drawcall/rig three && npm i -D tsx   # scripts: ESM ("type": "module"), run with npx tsx rig.ts
```

```ts
import { bone, load, parts, render, save, section, skin } from '@drawcall/rig'

const scene = await load('model.glb')
await render(scene, { out: 'shots/model.png' })          // what it is, which way it faces
console.log(section(scene, 'y', [0.3, 0.6]), parts(scene)) // limb centers per height; separate pieces
const hips = bone('Hips', [0, 0.95, 0])                    // joints in world space, parent attached
// ... the rest of the skeleton, every chain ending in a *_End bone
const report = await skin(scene, hips)                     // fix every warning, then check visually
await render(scene, { out: 'shots/rom.png', views: ['+x', 'persp'], poses: [/* one per major joint */] })
await save(scene, 'rigged.glb')
```

## Find orientation before anything else

Render first and decide what the creature is and which world axis its face points to. Models often face +x or -z rather than glTF's +z. The creature's own left is `up × forward`: facing +z, left is +x; facing +x, left is -z. Getting this wrong silently swaps every Left/Right name.

## Measure with section, not with images

Images identify parts and judge deformation, but they can't give depth, and perspective misleads by about 20%. Take joint positions from `section()` region centers, which are world `[x, y, z]` inside the solid: cut at knee height and each leg is one region, and its center is the knee joint. The orthographic axis views have a world grid for rough reading.

## Skeleton rules the weights depend on

- A bone's segment runs from its joint to its first child, and weights gather around that segment, so add the continuation child first (Hips → Spine before the legs).
- Leaf bones get no weights. End every chain with an end bone at the tip (`HeadTop_End`, `LeftHand_End`, `Tail_End`); without it the last real bone deforms nothing.
- Joints belong inside the mesh, centered in the limb's cross-section. A segment outside the solid attracts nothing.
- Humanoids: use Mixamo names (Hips, Spine, Spine1, Spine2, Neck, Head, LeftShoulder, LeftArm, LeftForeArm, LeftHand, LeftUpLeg, LeftLeg, LeftFoot, LeftToeBase, and Right*) so standard animations bind. Other creatures: clear anatomical names.
- Separate rigid pieces (eyes, armor plates, props) listed by `parts()`: set `b.userData.pieces = [index]` so they move without stretching; such a bone drives only its pieces. An accessory fused into the body mesh (a backpack, a vest) is not a separate piece: give it a normal bone, so neighbouring bones stop pulling it.

## Treat warnings as the checklist

`skin()` explains each warning and names the fix. Two are specific to this solver:

- "the main influence of no vertex": common on low-poly meshes, where no vertex ring lies between two joints. Move the joint to the suggested position.
- "crossed a gap between touching parts": weight leaked onto a part that touches the bone (arm onto torso, leg onto leg, tail onto legs). Move the joints apart, or skin at `resolution: 256` (about 6× slower than the default 128, and it removes most such leaks). Separate pieces can also be bound with `pieces`.

Iterate at 128, which takes seconds, and finish at 256 when parts touch. Fingers and other thin parts may need 512 or more. That takes minutes per run, long enough for a tool call to time out, so use it only for the final run and run it in the background.

## Judge the deformation, don't assume it

No warnings doesn't mean a good rig. Render a `poses` sheet, one row per major joint bent about 45°, plus one natural motion for the creature (walk, swim, flap). When something stretches or drags, render `weights: 'BoneName'` with `focus: 'BoneName'` to see where that bone's weight really goes.

Rotations are radians, and bones made with `bone()` have world-aligned axes, so the bend direction follows the right-hand rule. For example, a limb hanging along -y swings its end toward -z under a positive x rotation, which is backward for a creature facing +z. Check the sign on one joint before posing everything, and use `columns` to keep a long `poses` sheet readable. `save()` always writes the bind pose, whatever pose was last rendered.
