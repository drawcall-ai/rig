# rigkit

`rigkit` is the tool set AI agents use to rig an arbitrary glTF. Agents write a short TypeScript script against one module, `rigkit.ts`, and run it with `tsx`. The example at the top of `rigkit.ts` is the manual.

## The shape

| | call | what it answers |
| --- | --- | --- |
| **see** | `m.look({ view, pose, weights, focus, sheet, xray, labels })` | What is it, and which way does it face? Where are the joints? How does a pose deform, and where does a bone's weight go? Axis views are orthographic with a labeled world grid; `weights` draws a heatmap and `focus` zooms. |
| **measure** | `m.slice(axis, values)` | Where exactly is the mesh solid? Returns separate regions with world centers, which gives joint positions, including depth. |
| | `m.parts()` | Which separate mesh pieces are there (props, armor, glasses)? |
| **bind** | `m.skin(skeleton, { resolution })` | Writes the skinned glTF and returns a per-bone report whose warnings name the problem and the fix. That includes weight that crossed a gap between touching parts. |
| **check** | `m.rom()`, `m.walk()` | One contact sheet with every bone bent in turn. For humanoids, a standard walk cycle driving the rig. |
| **write faster** | `m.humanoid(landmarks, facing)`, `chain`, `mirror` | Humanoids: 7 landmarks give 22 Mixamo-named bones, so standard animations bind. Also joint chains and the mirrored side. |

The skeleton is plain data: `{ name, parent, position, tail?, deform?, pieces? }`. `pieces` binds whole mesh pieces 100% to a bone.

## Why this shape

It comes from four rounds of agent experiments: 16 agents on 7 models (a stylized fox, a realistic human, a soldier, a hard-surface robot, a horse, a parrot and a stork), plus a survey of industry tools (Mixamo, AccuRIG, Maya Quick Rig, Rigify, Meshy, Tripo) and papers (Pinocchio, RigNet, UniRig, Geodesic Voxel Binding and a 2026 follow-up, and agentic riggers).

- **Images are required, but only for seeing.** An agent with no images rigged the fox's backpack as a belly and put its spine inside the pack. Perspective renders misled measurements by about 20%, so coordinates come from `slice` and the orthographic grid.
- **Measuring must be numeric and exact.** Every agent used `slice` region centers for joints. Agents without it rebuilt it by skinning grids of up to 250 probe bones, and took 2.4× longer (20 vs 8.5 min).
- **A script API beats a CLI.** It was the fastest set (5.0 vs 5.7–6.3 min), and every agent in rounds 2 and 3 preferred scripts. Looping over measurements and mirroring sides removed left/right mistakes.
- **Visual QA beats scores.** The weight heatmap and `rom` found every deformation problem. A numeric stretch score was gamed by the one agent that had it, and an automatic curve skeleton was too noisy to use.
- **Warnings must name the fix.** Weight bleed between touching parts cost agents 2–4 rounds per model until `skin` reported it by bone pair.
- **Bind accessories explicitly.** Letting weights decide ownership ("rigid") bound the fox's whole fused body to its backpack. Explicit `pieces` indices are deterministic.
- **Standard names matter.** `humanoid()` rated 5/5 on the soldier, and standard animations only bind when names are exact. So `skin` removes a replaced armature and renames any other node whose name collides with a new bone.
- **Dropped after testing:** voxel ASCII projections (never used for placement), auto-skeleton `sketch`, numeric `check`, single-ray `probe` (replaced by `slice`), `symmetry` (redundant with the bounds), public `snap` (still used inside `humanoid`), and the `rigid` heuristic.

## Known limits

- **Voxel resolution:** the solver bridges gaps between touching limbs at resolution 128. On the human, the other leg's weight averages 0.6% (22% at the worst vertex); at 256 it drops to 0.03% for about 3× the time.
- **Fingers:** fingers thinner than a voxel get no weight.
- **Adaptive resolution:** a future solver option would pick the resolution from the thinnest limb.
- **Renderer dependency:** `look`, `rom` and `walk` need Chrome, driven through Playwright.
