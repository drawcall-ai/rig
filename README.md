# @drawcall/rig

Three.js rigging runtime for browsers and Node.js: measure a model and compute skin weights from a serialized skeleton.

Keep the rigged asset's editable source in a `.glts` file. [GLTS](https://github.com/drawcall-ai/glts) handles asset execution, rendering, and GLB export.

Install `@drawcall/rig @drawcall/glts three`. See the [package README](packages/rig/README.md) for usage and the [rig skill](packages/rig/skills/rig/SKILL.md) for the rigging workflow. The skill ships inside the npm package at `skills/rig/SKILL.md`.

Development: `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test`.
