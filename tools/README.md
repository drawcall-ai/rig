# rigkit (experimental)

The tool set AI agents rig with, distilled from two rounds of agent experiments.
Agents write a short TypeScript script against one module, `rigkit.ts`:

| ability | call | what it answers |
| --- | --- | --- |
| look | `m.look({ out, view, pose, animation, t, xray, labels, bones, weights })` | What is it, which way does it face, where are the joints, how does a pose deform, where does a bone's weight go (`weights: 'bone'` heatmap)? Axis views are orthographic with a world grid. |
| slice | `m.slice(axis, values)` | Where exactly is the mesh solid? Separate regions with world centers: joint positions and the depth images can't show. |
| skin | `m.skin(skeleton)` | Bind the skeleton (writes `skinned.glb`) and report per bone what it drives, plus warnings. |

Helpers: `chain` (a joint chain) and `mirror` (the other side). See the header of `rigkit.ts` for an example script.

`render.ts` is the renderer behind `look` (headless Chrome + a Vite page in `render/`), also usable as a CLI.

## Findings behind this shape

- Images are required: without them agents misread accessories as anatomy (a backpack rigged as a belly).
- Images can't give depth, and perspective misleads: exact coordinates come from `slice` and the gridded orthographic views.
- Weight heatmaps diagnose bleed in one image; numeric deformation scores and auto-skeletons were dropped (gameable / noisy).
- Scripts beat CLI calls: loops over measurements and `mirror` cut tool calls, and every agent preferred them.
