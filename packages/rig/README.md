# @drawcall/rig

Rig any glTF from a Node script with [three.js](https://threejs.org). The skeleton is made of real `THREE.Bone`s, posing is `bone.rotation`, and animation is `AnimationClip`. This package adds what three.js lacks: measuring the mesh, automatic skin weights, headless check renders, and saving the result without touching the original materials.

It's built so an AI agent can rig a model it has never seen by writing a script. It also works for people.

```ts
import * as THREE from 'three'
import { load, parts, render, save, section, skin } from '@drawcall/rig'

const scene = await load('model.glb')
await render(scene, { out: 'shots/model.png' })            // gridded views: what is it, which way does it face?
console.log(section(scene, 'y', [0.2, 0.5]))                // solid regions at those heights, with world centers
console.log(parts(scene))                                   // separate mesh pieces (props, armor, glasses)

const hips = new THREE.Bone()
hips.name = 'Hips'
hips.position.set(0, 0.9, 0)
const leg = new THREE.Bone()
leg.name = 'LeftUpLeg'
leg.position.set(0.1, -0.05, 0)
hips.add(leg)                                               // ...the rest of the skeleton

const report = skin(scene, hips)                            // automatic weights; warnings name the fix
console.log(report.warnings)

leg.rotation.x = -0.8                                       // pose, then look
await render(scene, { out: 'shots/pose.png', views: ['persp'] })
await render(scene, { out: 'shots/w.png', weights: 'LeftUpLeg', focus: 'LeftUpLeg' })
hips.parent?.traverse((node) => node instanceof THREE.SkinnedMesh && node.skeleton.pose())  // back to bind pose
await save(scene, 'rigged.glb')
```

## API

| function | returns |
| --- | --- |
| `load(path)` | The glTF as a three.js scene. |
| `section(scene, axis, values, resolution = 128)` | For each plane `axis = value`: its separate solid regions, largest first, with world `center`, `min` and `max` on the two in-plane axes. This is how you find joint positions, including depth. |
| `parts(scene)` | Separate mesh pieces, with the `index`, bounds and mesh name. |
| `skin(scene, rootBone, { resolution })` | Binds every mesh to the bone tree and replaces each with a `THREE.SkinnedMesh` baked to world space, so the bind pose is the model as loaded. It removes any previous armature. The report lists per-bone `vertices`, `weighted`, `inside`, region and `warnings`. |
| `render(scene, options)` | Writes one PNG showing the current pose. `views` is any of `+x -x +y -y +z -z` (orthographic, with a labeled world grid) or `persp`. Other options: `labels`, `weights: 'Bone'` (heatmap, blue 0 to red 1), `focus: 'Bone'` (zoom), `xray`, `bones`. |
| `save(scene, path)` | Writes the rig, in its bind pose, into the source file. Materials, textures and extensions are kept as they were. |

Per-bone options go in `bone.userData`:

| option | effect |
| --- | --- |
| `tail: [x, y, z]` | World-space end of the bone. The default is its first child; a leaf extends its parent. |
| `deform: false` | The bone is animated but attracts no weights. |
| `pieces: [i]` | Binds those `parts()` pieces 100% to this bone. |

Rendering uses [node-webgl](https://github.com/RenaudRohlinger/node-webgl), which is real WebGL 2 with no browser. In a browser, import the three.js core from `@drawcall/rig/three` (`section`, `parts`, `skin`).

## How the weights work

1. **Voxelize.** Triangles mark surface cells; cells enclosed on all six axes are filled.
2. **Assign.** A geodesic BFS through the solid runs from every bone segment. Each voxel goes to the nearest bone, and voxels off a bone's ends are penalized.
3. **Smooth.** The weights are blurred (sparse top-4) until they converge.
4. **Sample.** Each vertex takes the weights of its nearest solid voxel.

Distances run through the volume, so touching parts (the two legs, an arm and the torso) barely share weight, and `skin` warns when they do. Raising `resolution` from 128 to 256 cuts the remaining leak about 20×.
