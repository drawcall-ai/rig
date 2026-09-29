# Rig

`@drawcall/rig` provides tools for rigging any glTF from a Node script with three.js: measure the mesh, build `THREE.Bone`s, compute skin weights, render checks headlessly, and save. It's designed so AI agents can rig models they have never seen. The usage docs are in [packages/rig](packages/rig/README.md).

## Layout

- `packages/rig/` contains `@drawcall/rig`:
  - `src/three.ts` holds the three.js core: `section`, `parts` and `skin`. It runs in Node and the browser.
  - `src/node.ts` holds `load`, `render` (headless WebGL 2 via node-webgl) and `save` (glTF Transform, keeping source materials).
  - `src/weights.ts` turns a skeleton and a triangle soup into weights and a report with warnings.
  - `src/solve.ts` and `src/voxelize.ts` are the weight kernels. `test/parity.test.ts` checks them against the original CPU implementation vendored in `test/reference/`.
- `examples/node/` rigs a horse in a script (`pnpm rig`).
- `examples/browser/` skins the same horse in the browser and plays a gallop (`pnpm dev`).

## Development

Requires Node 22+ and pnpm 10+.

```sh
pnpm install
pnpm typecheck
pnpm test       # kernel parity, then the API end to end (glTF-validated)
pnpm --filter @drawcall/rig bench
```

Pushing a tag runs the tests and publishes `@drawcall/rig` to npm, versioned by GitVersion.
