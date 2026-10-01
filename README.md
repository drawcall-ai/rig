# @drawcall/rig

Rig any 3D model by writing a three.js script. The skeleton is plain `THREE.Bone`s. `@drawcall/rig` adds what three.js lacks for rigging:

- measuring the mesh
- automatic skin weights, with warnings that say what to fix
- headless check renders
- saving the rigged glTF

It's built so AI agents can rig models they have never seen, of any creature.

```ts
import { bone, load, render, save, section, skin } from '@drawcall/rig'

const scene = await load('model.glb')
section(scene, 'y', [0.5])                    // limb centers at y = 0.5 → joint positions
const hips = bone('Hips', [0, 0.95, 0])       // bones at world positions
bone('Spine', [0, 1.1, 0], hips)              // ...ending each chain with an *_End bone
const report = await skin(scene, hips)        // weights + warnings
await render(scene, { out: 'check.png', weights: 'Spine' })
await save(scene, 'rigged.glb')
```

How it works: the mesh is voxelized, each voxel takes the bone that is nearest when you walk through the solid (not through the air), the weights are smoothed, and each vertex samples its voxel. Touching parts such as two legs barely share weight.

- **Library:** `npm i @drawcall/rig three`. See [packages/rig](packages/rig/README.md) for the API.
- **Agent skill:** `npx skills add drawcall-ai/rig`. See [skills/rig](skills/rig/SKILL.md).
- **Development:** `pnpm install && pnpm test`.
