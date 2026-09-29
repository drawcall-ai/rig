# Skinning

Automatic skin weights for glTF on the CPU, in Node and the browser. It ships as a CLI that AI agents can use to rig models they have never seen. The usage docs are in [packages/skinning](packages/skinning/README.md).

## Layout

- `packages/skinning/` contains `@drawcall/skinning`, the library and the `skinning` CLI:
  - `src/solve.ts` is the weight solver. `test/parity.test.ts` checks it against the original CPU implementation vendored in `test/reference/`.
  - `src/voxelize.ts` is the voxelizer.
  - `src/skin.ts` and `src/scene.ts` handle glTF documents.
  - `src/views.ts` renders the text views.
  - `src/cli.ts` is the CLI.
- `examples/node/` rigs a horse with the CLI (`pnpm skin`) or the API (`pnpm api`).
- `examples/browser/` skins the same horse in the browser and renders it with three.js (`pnpm dev`). A "bend every joint" slider lets you eyeball the weights; `?model=<url>` views an already-skinned GLB.

## Development

Requires Node 22+ and pnpm 10+.

```sh
pnpm install
pnpm build      # dist/ for the CLI bin
pnpm typecheck
pnpm test       # solver parity, skin on real documents (glTF-validated), CLI
pnpm --filter @drawcall/skinning bench
```

Pushing a tag runs the tests and publishes `@drawcall/skinning` to npm, versioned by GitVersion.
