/**
 * rigkit: rig any glTF with a short TypeScript script. Three abilities:
 *   look   render images (exact grids, skeleton, poses, one bone's weights)
 *   slice  measure where the mesh is solid (cross-section regions with centers)
 *   skin   bind a skeleton and get a per-bone report
 * plus helpers to write skeletons compactly (chain, mirror).
 *
 *   import { open, chain, mirror } from '<repo>/tools/rigkit.ts'
 *   const m = await open('model.glb')
 *   await m.look({ out: 'shots/model' })                         // what is it, which way does it face?
 *   console.log(m.slice('y', [-0.4, -0.3, 0]))                   // limb centers at those heights
 *   const left = chain('leg_L', 'hips', [[0.1, -0.2, 0], [0.1, -0.5, 0], [0.1, -0.9, 0.05]])
 *   const skeleton = { bones: [{ name: 'hips', position: [0, -0.2, 0] }, ...left, ...mirror(left, 'x')] }
 *   const report = await m.skin(skeleton)                        // writes skinned.glb next to the script
 *   await m.look({ out: 'shots/pose', pose: { leg_L1: [0, 0, 60] }, view: ['persp'] })
 *   await m.look({ out: 'shots/w', weights: 'leg_L1', view: ['+z'] })
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { computeVoxelVolume, skin, sliceRegions, type Skeleton, type SkeletonBone, type SkinReport, type SliceResult } from '../packages/skinning/src/index.js'
import { createIO, loadModel } from './model.js'
import { render } from './render.js'

type Axis = 'x' | 'y' | 'z'
type Vec3 = [number, number, number]

export interface LookOptions {
  /** Output path prefix; files are <out>-<view>[-t<t>][-w-<bone>].png. */
  out: string
  /** '+x' = camera on the +x side looking toward -x (orthographic, with a world grid); also -x, +y, -y, +z, -z, 'persp'. Default +x, +z, +y, persp. */
  view?: string[]
  /** Times in the animation to render (seconds). */
  t?: number[]
  /**
   * Static pose: bone -> [xDeg, yDeg, zDeg] Euler XYZ rotation relative to the bind pose. Joints bind with
   * identity rotation, so the axes are world axes: a positive angle turns counterclockwise when looking
   * from the positive end of that axis toward the origin (right-hand rule).
   */
  pose?: Record<string, Vec3>
  /** Keyframe clip JSON path: {"duration", "rotation": {"bone": [[t, xDeg, yDeg, zDeg]...]}, "translation"?: {...}}. */
  animation?: string
  /** See-through mesh. */
  xray?: boolean
  /** Name the joints. */
  labels?: boolean
  /** Draw the skeleton (default true once skinned). */
  bones?: boolean
  /** Color by this bone's weights: blue 0 -> red 1. */
  weights?: string
}

export async function open(path: string, options: { skinned?: string } = {}) {
  const model = await loadModel(path)
  const skinned = resolve(options.skinned ?? 'skinned.glb')
  let volume: ReturnType<typeof computeVoxelVolume> | undefined
  // An already-skinned model renders as is; otherwise look() shows the raw model until skin() runs
  let current = model.document.getRoot().listSkins().length > 0 ? path : undefined
  return {
    min: model.min,
    max: model.max,
    vertices: model.scene.positions.length / 3,

    /** Renders the skinned model once skin() has run, else the raw model. Returns the PNG paths. */
    look: (options: LookOptions): Promise<string[]> =>
      render(current ?? path, {
        out: options.out,
        views: options.view ?? ['+x', '+z', '+y', 'persp'],
        times: options.pose ? [0] : (options.t ?? [0]),
        animation: options.pose ? poseClip(options.pose) : options.animation,
        xray: options.xray,
        labels: options.labels,
        bones: options.bones,
        weights: options.weights,
      }),

    /** Solid regions where the plane axis=value cuts the model, largest first, with world centers and extents. */
    slice: (axis: Axis, values: number[]): (SliceResult | null)[] => {
      volume ??= computeVoxelVolume(model.scene.positions, model.scene.indices, { resolution: 128 })
      return values.map((value) => sliceRegions(volume!, { axis, value }))
    },

    /** Skins the model with the skeleton, writes it (default ./skinned.glb) and returns the report. */
    skin: async (skeleton: Skeleton): Promise<SkinReport> => {
      const io = await createIO()
      const document = await io.read(path)
      const report = skin(document, skeleton)
      await io.write(skinned, document)
      current = skinned
      return report
    },
  }
}

/** A one-frame clip file holding a static pose. */
function poseClip(pose: Record<string, Vec3>): string {
  const file = join(mkdtempSync(join(tmpdir(), 'rigkit-')), 'pose.json')
  const rotation = Object.fromEntries(Object.entries(pose).map(([bone, [x, y, z]]) => [bone, [[0, x, y, z]]]))
  writeFileSync(file, JSON.stringify({ duration: 0, rotation }))
  return file
}

/** Bones for a chain of joints named `${prefix}1..n`, each the child of the previous; the first hangs off `parent`. */
export function chain(prefix: string, parent: string | undefined, points: Vec3[], tail?: Vec3): SkeletonBone[] {
  return points.map((position, i) => ({
    name: `${prefix}${i + 1}`,
    parent: i === 0 ? parent : `${prefix}${i}`,
    position,
    ...(i === points.length - 1 && tail ? { tail } : {}),
  }))
}

/** Mirror copies of the bones whose names contain `from` (default '_L' -> '_R'), across the plane axis=center. */
export function mirror(bones: SkeletonBone[], axis: Axis, center = 0, from = '_L', to = '_R'): SkeletonBone[] {
  const a = 'xyz'.indexOf(axis)
  const flip = (p: readonly number[]): Vec3 => p.map((v, i) => (i === a ? 2 * center - v : v)) as Vec3
  return bones
    .filter((bone) => bone.name.includes(from))
    .map((bone) => ({
      ...bone,
      name: bone.name.replace(from, to),
      parent: bone.parent?.replace(from, to),
      position: flip(bone.position),
      ...(bone.tail ? { tail: flip(bone.tail) } : {}),
    }))
}
