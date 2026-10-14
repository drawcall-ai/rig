# @drawcall/rig

Three.js rigging runtime for browsers and Node.js. Load a glTF model with a serialized skeleton to compute skin weights, or measure and skin an existing Three.js object.

Keep the rig definition in an editable [GLTS](https://github.com/drawcall-ai/glts) asset. GLTS handles execution, rendering, and GLB export.

```ts
// character.glts
import { loadingManager, onDispose, scene } from '@drawcall/glts'
import { RigLoader } from '@drawcall/rig'

const rig = await new RigLoader(loadingManager).loadAsync({
  url: new URL('./character.glb', import.meta.url),
  skeleton: [
    { name: 'Root', position: [0, 0, 0] },
    { name: 'Tip_End', parent: 'Root', position: [0, 1, 0] },
  ],
  resolution: 128,
})
scene.add(rig.scene)
onDispose(() => rig.dispose())
console.log(rig.report)
```

Install `@drawcall/rig @drawcall/glts three`. Use the packaged [rig skill](skills/rig/SKILL.md) for the measurement, skeleton, and deformation workflow, and the [glts skill](https://github.com/drawcall-ai/glts/blob/main/packages/glts/skills/glts/SKILL.md) for rendering and export. Skills ship with their packages under `skills/`.

```sh
npx @drawcall/glts render character.glts -o preview.png
npx @drawcall/glts export character.glts -o character.rigged.glb
```
