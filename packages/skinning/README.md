# @drawcall/skinning

Automatic skin weights for any glTF. Give it a mesh and a list of bones, and it writes the mesh back out skinned to those bones. Runs on the CPU in Node and in the browser, with no GPU or native dependencies.

The CLI is built so an AI agent can rig a model it has never seen. `voxel` shows the agent the shape as text, the agent writes a skeleton JSON, and `skin` reports where each bone landed.

```sh
npx @drawcall/skinning voxel horse.glb                        # shape, bounds, orientation
npx @drawcall/skinning voxel horse.glb --slice y=10,45,135    # limb centers per height
npx @drawcall/skinning skin horse.glb --skeleton skeleton.json  # -> horse.skinned.glb
```

`skinning help` is the full manual, written for agents. Point an agent at it and it has everything it needs.

## CLI

### `skinning voxel <model> [--resolution 64] [--slice y=10,40] [--json]`

Prints the vertex count, world bounds, and front/side/top projections of the solid voxel volume, with world-coordinate rulers. With `--slice`, it prints cross-sections instead. Each separate solid region in a slice is lettered and listed with its world-space center and extent. Those centers are where limb joints go:

```
slice y=28.5: 3 regions (x to the right, z up)
  A: 9 cells, center x=9.3 z=127.3, x 4.2..14.3, z 122.3..132.4
  B: 7 cells, center x=-9.4 z=41.7, x -15.9..-5.8, z 36.7..46.8
  C: 6 cells, center x=6.8 z=-119.4, x 4.2..9.3, z -124.5..-114.4
```

`--json` prints the volume as bit-packed occupancy for programs.

### `skinning skin <model> --skeleton <file|json> [--out file] [--resolution 128] [--blur 100] [--json]`

Skins every mesh in the scene and prints a per-bone report, followed by warnings:

| column | meaning |
| --- | --- |
| `main` | vertices whose largest weight is this bone |
| `weighted` | vertices with at least 10% weight on it |
| `inside` | share of the bone segment inside the mesh; only that part attracts weights |
| `region` | world bounds of its main vertices |

Warnings flag the common mistakes: a bone outside the mesh, a leaf whose default tail overshoots, and a bone that owns no vertices.

Skeleton format, in the model's world space and units:

```json
{
  "bones": [
    { "name": "hips", "position": [0, 110, -90] },
    { "name": "spine", "parent": "hips", "position": [0, 118, 5] },
    { "name": "head", "parent": "spine", "position": [2, 166, 108], "tail": [3, 122, 128] }
  ]
}
```

Each deforming bone is the segment from `position` to `tail`. By default, `tail` is the bone's first child's position; for a leaf, it is the joint extended by half of its parent bone. `"deform": false` keeps a joint out of the weighting. The output joints have identity rotations, so the bind pose is the model as given.

## Library

```ts
import { NodeIO } from '@gltf-transform/core' // WebIO in the browser
import { skin, voxelize, formatVolume } from '@drawcall/skinning'

const io = new NodeIO()
const document = await io.read('horse.glb')
console.log(formatVolume(voxelize(document, { resolution: 48 }), [{ axis: 'y', value: 30 }]))
const report = skin(document, skeleton) // mutates the document
await io.write('horse.skinned.glb', document)
```

The library works on [glTF Transform](https://gltf-transform.dev) documents, so reading and writing files is up to you. The CLI adds Draco and Meshopt decoding. The array-level kernels `computeVoxelVolume` and `solveSkinWeights` are exported too.

What `skin` does to the document:

- Every mesh node in the default scene is baked into world space, including the current pose of an already-skinned mesh.
- Each baked mesh gets `JOINTS_0`/`WEIGHTS_0` and is bound to a new joint tree at the scene root.
- The original nodes keep their children but lose their mesh. Morph weight animations are retargeted to the new nodes, and old skins are removed.

## How it works

1. **Voxelize.** Triangles mark the surface cells, and cells enclosed on all six axes are filled.
2. **Assign.** A geodesic BFS through the solid volume runs from every bone segment. Each voxel goes to the nearest bone, with voxels off a bone's ends penalized.
3. **Smooth.** The weights are blurred (sparse top-4) until they converge.
4. **Sample.** Each vertex takes the weights of its nearest solid voxel.

Because the distances run through the volume rather than straight through space, a leg never grabs the other leg.
