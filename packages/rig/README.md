# @drawcall/rig

Rig any glTF from a Node script with [three.js](https://threejs.org). The skeleton is made of real `THREE.Bone`s, posing is `bone.rotation`, and animation is `AnimationClip`. This package adds what three.js lacks: measuring the mesh, automatic skin weights, headless check renders, and saving the rig into a copy of the source file.

It's built so an AI agent can rig a model it has never seen by writing a script. It also works for people.

```ts
import { bone, load, pick, pieces, render, save, section, skin, type View } from '@drawcall/rig'

const scene = await load('model.glb')
await render(scene, { out: 'shots/model.png' })            // default views: what is it, which way does it face?
console.log(JSON.stringify(section(scene, [{ y: 0.2 }, { y: 0.5 }]))) // solid regions per plane, with world centers
console.log(JSON.stringify(pick(scene, { camera: '+x' }, [{ y: 1.5, z: 0.05 }, { y: 1.5, z: 0.1 }]))) // the solid under each grid point of the +x view
console.log(pieces(scene))                                  // separate mesh pieces (props, armor, glasses)

// Plain THREE.Bones at world positions (bone() = new THREE.Bone + position.set + parent.attach)
const hips = bone('Hips', [0, 0.9, 0])
bone('Spine', [0, 1.05, 0], hips)                           // added first, so the Hips segment runs up the body
const upLeg = bone('LeftUpLeg', [0.1, 0.85, 0], hips)
const leg = bone('LeftLeg', [0.1, 0.5, 0], upLeg)
const foot = bone('LeftFoot', [0.1, 0.1, 0], leg)
bone('LeftFoot_End', [0.1, 0.05, 0.1], foot)

const report = await skin(scene, hips)                      // automatic weights; warnings say what the solver found
console.log(report.warnings)

const poses: Omit<View, 'camera'>[] = [                     // point a bone's segment at a world point, or rotate it
  { title: 'leg forward', targets: { LeftUpLeg: [0.1, 0.5, 0.35] } },
  { title: 'knee', rotations: { LeftLeg: [0.9, 0, 0] } },
]
await render(scene, {                                       // one row per pose: with the skeleton, mesh only, every bone's weights
  out: 'shots/rom.png',
  views: poses.map((pose) => [
    { ...pose, camera: '+x' },
    { ...pose, camera: '+x', bones: false },
    { ...pose, camera: 'persp', weights: true },
  ]),
})
await save(scene, 'rigged.glb')
```

## API

| function | returns |
| --- | --- |
| `load(path)` | The glTF as a three.js scene, remembering the file for `save()`. |
| `bone(name, worldPosition, parent?)` | A `THREE.Bone` whose joint sits at `worldPosition`, attached under `parent`. It's the same as `new THREE.Bone()` plus `position.set` plus `parent.attach`. |
| `section(scene, [{ y: 0.5 }, { x: 0 }], resolution = 128)` | Where each plane (named by one of `x`, `y`, `z`; planes may mix axes) cuts the model, one result per plane in order, all from one voxelization: `{ axis, value, regions }`, with `value` the voxel layer actually cut (the requested value when the plane lies outside the model's bounds). `regions` are the separate solids, largest first, each with world `[x, y, z]` `center` (the centroid), `min`, `max` and `cells`; a plane that misses the model gets `regions: []`. A region's center is a joint position, including depth. |
| `pick(scene, view, points, resolution = 128)` | What lies under points of an orthographic view (`view.camera` one of `+x -x +y -y +z -z`): each point gives the two axes the view's grid labels (`{ x, z }` for `±y`), and its result lists every solid span along the camera's axis, nearest the camera first, one list per point in order. All points share one voxelization, so a sweep of thousands costs about one call. Each span has world `enter`, `exit`, `center` and `thickness`. The view takes only `camera`; like `section` and `skin`, `pick` measures the current pose. Measured on the same voxel solid as `section` and `skin`, so a span's center is inside for the solver; positions and thickness come in whole voxels, so raise `resolution` for thin parts. |
| `pieces(scene)` | Separate mesh pieces, largest first: `index`, `mesh` name, `vertices`, `min`, `max` and `center` (the vertex centroid). |
| `await skin(scene, rootBone, resolution = 128)` | Binds every mesh to the bone tree and replaces each with a `THREE.SkinnedMesh` baked to world space, so the bind pose is the model as it is now. Adds `rootBone` to the scene if it has no parent, removes the previous armature, and renames old nodes whose names the new bones use to `*_source`. Returns `{ warnings, bones }`: one warning per cause, stating what the solver found and where; per bone its `name`, `inside` (share of the segment inside the mesh), `vertices` (whose largest weight is this bone), `weighted` (with at least 10% weight on it), and the world `min` and `max` of those `vertices`. |
| `render(scene, { out, size?, views? })` | Writes one PNG: `views` is rows of views (below); `size` is pixels per view (default 600). Default: one row of `+x`, `+z`, `+y`, `persp`. The scene is left exactly as it was. |
| `save(scene, path)` | Writes the file `load()` read, with the rig in its bind pose, to `path`: the vertices `skin()` baked, the new joints and skin, the old rig removed. Materials, textures and extensions are carried over; Draco- or meshopt-compressed geometry is written uncompressed. Needs a scene from `load()` whose meshes one `skin()` call bound. |

A view is one picture. Every view starts from the bind pose and then applies its own `rotations` and `targets`, parents first, so views don't affect each other. A scene that is not skinned yet renders as it is; `rotations`, `targets` or `weights` on it throw. Unknown keys, cameras and bone names throw. The framing follows the posed mesh.

| key | |
| --- | --- |
| `camera` | `+x -x +y -y +z -z` (orthographic from that side, with a labeled world grid) or `persp` (3/4 view). Required. |
| `title` | Caption. |
| `rotations` | Euler XYZ in radians per bone, in the bone's bind frame. |
| `targets` | A world point per bone: after its rotation, the bone turns so its segment points there. |
| `bones` | Draw the skeleton (default `true`); `'names'` also writes the bone names. |
| `weights` | A bone name: that bone's weights as a heatmap, blue 0 to red 1. `true`: each vertex in the color of its strongest bone, darker where that bone holds less of it, so all boundaries show at once. |
| `focus` | Zoom on a bone (by name) or a world sphere `{ center, radius }`. |
| `isolate` | A bone name: show only the geometry that bone and its descendants own (their strongest weight), zoomed to it unless `focus` is set. |

Skeleton conventions, as in Mixamo and most exporters:

- A bone's segment runs from its joint to its first child. Weights gather around that segment.
- A leaf bone (for example `LeftFoot_End`) only marks where a chain ends and gets no weights.
- `bone.userData.pieces = [i]` binds those `pieces()` (props, armor, eyes) 100% to the bone, which then drives only them.

Rendering runs on the CPU in plain JavaScript (depth-buffered, mipmapped textures, diffuse lighting from the scene's lights), so it needs no GPU, driver or browser and draws the same pixels on every OS and architecture. In a browser, import the three.js core from `@drawcall/rig/three` (`bone`, `section`, `pieces`, `skin`). `pick` is exported next to `render`, from the Node entry, since its points are read off render images.

## How the weights work

1. **Voxelize.** Triangles mark surface cells; cells enclosed on all six axes are filled.
2. **Assign.** A geodesic BFS through the solid runs from every bone segment. Each voxel goes to the nearest bone, and voxels off a bone's ends are penalized.
3. **Smooth.** The weights are blurred (sparse top-4) until they converge.
4. **Sample.** Each vertex takes the weights of its nearest solid voxel.

Distances run through the volume, so touching limbs (the two legs, an arm and the torso) barely share weight, and `skin` warns when they do. A higher `resolution` (voxels along the longest axis) separates thinner limbs and leaks less weight between touching ones; each doubling costs about 8× the voxels.
