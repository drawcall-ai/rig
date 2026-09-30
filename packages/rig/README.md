# @drawcall/rig

Rig any glTF from a Node script with [three.js](https://threejs.org). The skeleton is made of real `THREE.Bone`s, posing is `bone.rotation`, and animation is `AnimationClip`. This package adds what three.js lacks: measuring the mesh, automatic skin weights, headless check renders, and saving the result without touching the original materials.

It's built so an AI agent can rig a model it has never seen by writing a script. It also works for people.

```ts
import * as THREE from 'three'
import { bone, load, parts, render, save, section, skin } from '@drawcall/rig'

const scene = await load('model.glb')
await render(scene, { out: 'shots/model.png' })            // gridded views: what is it, which way does it face?
console.log(section(scene, 'y', [0.2, 0.5]))                // solid regions at those heights, with world centers
console.log(parts(scene))                                   // separate mesh pieces (props, armor, glasses)

// Plain THREE.Bones at world positions (bone() = new THREE.Bone + position + parent.attach)
const hips = bone('Hips', [0, 0.9, 0])
const leg = bone('LeftUpLeg', [0.1, 0.85, 0], hips)
bone('LeftFoot_End', [0.1, 0.05, 0.1], bone('LeftFoot', [0.1, 0.1, 0], bone('LeftLeg', [0.1, 0.5, 0], leg)))

const report = await skin(scene, hips)                            // automatic weights; warnings name the fix
console.log(report.warnings)

await render(scene, {                                       // a range-of-motion sheet: each pose from the bind pose
  out: 'shots/rom.png',
  views: ['+x', 'persp'],
  poses: [{ title: 'leg forward', rotations: { LeftUpLeg: [-0.8, 0, 0] } }, { title: 'knee', rotations: { LeftLeg: [0.9, 0, 0] } }],
})
await render(scene, { out: 'shots/w.png', weights: 'LeftUpLeg', focus: 'LeftUpLeg' })
await save(scene, 'rigged.glb')
```

## API

| function | returns |
| --- | --- |
| `load(path)` | The glTF as a three.js scene. |
| `bone(name, worldPosition, parent?)` | A `THREE.Bone` whose joint sits at `worldPosition`, attached under `parent`. It's the same as `new THREE.Bone()` plus `position.set` plus `parent.attach`. |
| `section(scene, axis, values, resolution = 128)` | For each plane `axis = value`: its separate solid regions, largest first, with world `[x, y, z]` `center`, `min` and `max`. A region's center is a joint position, including depth. |
| `parts(scene)` | Separate mesh pieces, with the `index`, bounds and mesh name. |
| `await skin(scene, rootBone, { resolution })` | Binds every mesh to the bone tree and replaces each with a `THREE.SkinnedMesh` baked to world space, so the bind pose is the model as loaded. It removes any previous armature. The report lists per-bone `vertices`, `weighted`, `inside`, region and `warnings`. When a bone gets no vertices of its own, the warning suggests where to move its joint. |
| `render(scene, options)` | Writes one PNG. `views` is any of `+x -x +y -y +z -z` (orthographic, with a labeled world grid) or `persp`. Other options: `poses` (one row per pose, each from the bind pose), `labels`, `weights: 'Bone'` (heatmap, blue 0 to red 1), `focus: 'Bone'` (zoom), `xray`, `bones`. Without `poses`, it shows the current pose (`bone.rotation`). |
| `save(scene, path)` | Writes the rig, in its bind pose, into the source file: exactly the vertices `skin()` baked. Materials, textures and extensions are kept as they were. |

Skeleton conventions, as in Mixamo and most exporters:

- A bone's segment runs from its joint to its first child. Weights gather around that segment.
- A leaf bone (for example `LeftFoot_End`) only marks where a chain ends and gets no weights.
- `bone.userData.pieces = [i]` binds those `parts()` pieces (props, armor, eyes) 100% to the bone, which then drives only them.

Rendering uses [node-webgl](https://github.com/RenaudRohlinger/node-webgl), which is real WebGL 2 with no browser. In a browser, import the three.js core from `@drawcall/rig/three` (`section`, `parts`, `skin`).

## How the weights work

1. **Voxelize.** Triangles mark surface cells; cells enclosed on all six axes are filled.
2. **Assign.** A geodesic BFS through the solid runs from every bone segment. Each voxel goes to the nearest bone, and voxels off a bone's ends are penalized.
3. **Smooth.** The weights are blurred (sparse top-4) until they converge.
4. **Sample.** Each vertex takes the weights of its nearest solid voxel.

Distances run through the volume, so touching parts (the two legs, an arm and the torso) barely share weight, and `skin` warns when they do. Raising `resolution` from 128 to 256 cuts the remaining leak about 20×.
