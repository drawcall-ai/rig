# @drawcall/rig

Rig any 3D model by writing a three.js script. The skeleton is plain `THREE.Bone`s. `@drawcall/rig` adds what three.js lacks for rigging:

- measuring the mesh
- automatic skin weights, with warnings that say what the solver found
- headless check renders
- saving the rigged glTF

It's built so AI agents can rig models they have never seen, of any creature.

```ts
import { bone, load, pick, render, save, section, skin } from '@drawcall/rig'

const scene = await load('model.glb')
console.log(JSON.stringify(section(scene, [{ y: 0.5 }])))         // limb centers at y = 0.5 → joint positions
console.log(JSON.stringify(pick(scene, { camera: '+x' }, [{ y: 1.5, z: 0.05 }]))) // depth and thickness under grid points of a view
const hips = bone('Hips', [0, 0.95, 0])                           // bones at world positions
bone('Head_End', [0, 1.7, 0], bone('Spine', [0, 1.1, 0], hips))   // each chain ends in an *_End bone
console.log((await skin(scene, hips)).warnings)                   // weights; warnings say what the solver found
await render(scene, { out: 'check.png', views: [[{ camera: '+x' }, { camera: '+x', weights: true }]] })   // mesh | each bone's weights
await save(scene, 'rigged.glb')
```

How it works: the mesh is voxelized, each voxel takes the bone that is nearest when you walk through the solid (not through the air), the weights are smoothed, and each vertex samples its voxel. Touching limbs such as two legs barely share weight.

- **Library:** `npm i @drawcall/rig three`. See [packages/rig](packages/rig/README.md) for the API.
- **Agent skill:** `npx skills add drawcall-ai/rig`. See [skills/rig](packages/rig/skills/rig/SKILL.md). The skill also ships inside the `@drawcall/rig` npm package at `skills/rig/SKILL.md`, so [skills-npm](https://github.com/antfu/skills-npm) links it automatically from `node_modules`, at the version you have installed.
- **Development:** `pnpm install && pnpm test`.
