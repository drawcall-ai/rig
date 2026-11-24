# @drawcall/rig

Three.js rigging runtime for browsers and Node.js. Rig a glTF model or procedural object from a serialized skeleton with cached skin weights, or measure and skin an existing Three.js object.

```ts
import { CachedRigLoader } from '@drawcall/rig'

const rig = await new CachedRigLoader().loadAsync({
  object: async () => {
    const { ModelLoader } = await import('@drawcall/rig')
    return (await new ModelLoader().loadAsync('character.glb')).scene
  },
  skeleton: [
    { name: 'Root', position: [0, 0, 0] },
    { name: 'Tip_End', parent: 'Root', position: [0, 1, 0] },
  ],
  resolution: 128,
})
scene.add(rig.object)
console.log(rig.report)
```

Install `@drawcall/rig three @drawcall/cache`. Add the `cache()` Vite plugin from `@drawcall/cache/vite` so apps compute weights for the loads in their source during development and builds, instead of in the browser. Use the packaged [rig skill](skills/rig/SKILL.md) for the measurement, skeleton, and deformation workflow. Skills ship with their packages under `skills/`.

Skinning uses WebAssembly in workers. To enable parallel computation in browsers, serve over HTTPS (or localhost) with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Pages without shared-memory support use the same solver in one worker. Node.js enables parallel computation automatically.

If you use a Content-Security-Policy, permit the worker URLs in `worker-src` and allow WebAssembly compilation with `'wasm-unsafe-eval'` in any `script-src` policy applied to the workers. See [CSP and WebAssembly](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src#unsafe_webassembly_execution).
