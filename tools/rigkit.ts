/**
 * rigkit: rig any glTF with a short TypeScript script.
 *
 * Core (always):
 *   look   render images: gridded orthographic views, skeleton, a pose or clip, one bone's weights, contact sheets
 *   slice  where the mesh is solid: cross-section regions with world centers
 *   skin   bind a skeleton (writes skinned.glb) and get a per-bone report
 *   chain / mirror   write skeletons compactly
 *   parts     separate mesh pieces (props, armor, glasses) to bind 100% with a bone's `pieces`
 * QA:
 *   rom       range-of-motion contact sheet: every bone bent in turn
 *   walk      walk-cycle sheet for humanoid() rigs: standard animation drives it
 * Humanoids:
 *   humanoid  Mixamo-style fitting: 7 landmarks -> 22 standard-named bones, depth auto-centered
 *
 *   import { open, chain, mirror } from '<repo>/tools/rigkit.ts'
 *   const m = await open('model.glb')
 *   await m.look({ out: 'shots/model' })                          // what is it, which way does it face?
 *   console.log(m.slice('y', [-0.4, -0.3, 0]))                    // limb centers at those heights
 *   const left = chain('leg_L', 'hips', [[0.1, -0.2, 0], [0.1, -0.5, 0], [0.1, -0.9, 0.05]])
 *   const skeleton = { bones: [{ name: 'hips', position: [0, -0.2, 0] }, ...left, ...mirror(left, 'x')] }
 *   const report = await m.skin(skeleton)                         // writes skinned.glb
 *   await m.look({ out: 'shots/pose', pose: { leg_L1: [-60, 0, 0] }, view: ['persp'] })
 *   await m.look({ out: 'shots/w', weights: 'leg_L1', view: ['+z'] })
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as THREE from 'three'
import {
  computeVoxelVolume,
  skin,
  sliceRegions,
  type Skeleton,
  type SkeletonBone,
  type SkinReport,
  type SliceResult,
  type VoxelVolume,
} from '../packages/skinning/src/index.js'
import { meshParts } from '../packages/skinning/src/scene.js'
import { createIO, loadModel } from './model.js'
import { openPage, render, type Joint } from './render.js'
import type { Shot } from './render/page.js'

type Axis = 'x' | 'y' | 'z'
type Vec3 = [number, number, number]
/** Direction the model faces: its front points toward this world axis. */
export type Facing = '+x' | '-x' | '+z' | '-z'

export interface LookOptions {
  /** Output path prefix; files are <out>-<view>[-t<t>][-w-<bone>].png, or <out>-sheet.png with sheet. */
  out: string
  /** '+x' = camera on the +x side looking toward -x (orthographic, with a world grid); also -x, +y, -y, +z, -z, 'persp'. Default +x, +z, +y, persp. */
  view?: string[]
  /**
   * Static pose: bone -> [xDeg, yDeg, zDeg] Euler XYZ rotation relative to the bind pose. Joints bind with
   * identity rotation, so the axes are world axes: a positive angle turns counterclockwise when looking
   * from the positive end of that axis toward the origin (right-hand rule).
   */
  pose?: Record<string, Vec3>
  /** Keyframe clip JSON path: {"duration", "rotation": {"bone": [[t, xDeg, yDeg, zDeg]...]}, "translation"?: {...}}. */
  animation?: string
  /** Times in the clip to render (seconds). */
  t?: number[]
  /** See-through mesh. */
  xray?: boolean
  /** Name the joints. */
  labels?: boolean
  /** Draw the skeleton (default true once skinned). */
  bones?: boolean
  /** Color by this bone's weights: blue 0 -> red 1. */
  weights?: string
  /** Tile all views/times into one labeled image (<out>-sheet.png). */
  sheet?: boolean
  /** Zoom on a bone (by name) or a world-space sphere {center, radius}. */
  focus?: string | { center: Vec3; radius: number }
}

export interface HumanoidLandmarks {
  /** Bottom of the chin / jaw line, centered. */
  chin: Vec3
  /** Crotch: where the legs split. */
  groin: Vec3
  /** The character's own left side; the right side is mirrored unless given (asymmetric poses). */
  shoulder_L: Vec3
  elbow_L: Vec3
  wrist_L: Vec3
  knee_L: Vec3
  ankle_L: Vec3
  shoulder_R?: Vec3
  elbow_R?: Vec3
  wrist_R?: Vec3
  knee_R?: Vec3
  ankle_R?: Vec3
}

export async function open(path: string, options: { skinned?: string } = {}) {
  const model = await loadModel(path)
  const { positions, indices } = model.scene
  const skinnedPath = resolve(options.skinned ?? 'skinned.glb')
  // look() shows the skinned result once skin() ran; before that the raw model, or for an already-rigged
  // input its bind geometry without the old rig (what slice and skin measure)
  let current: string | undefined
  let preview = path
  if (model.document.getRoot().listSkins().length > 0) {
    const io = await createIO()
    const document = await io.read(path)
    skin(document, { bones: [{ name: 'root', position: model.min }] }, { resolution: 16, blurIterations: 0 })
    preview = resolve(`${skinnedPath.replace(/\.glb$/, '')}.source.glb`)
    await write(preview, document)
  }
  let voxels: VoxelVolume | undefined
  const volume = (): VoxelVolume => (voxels ??= computeVoxelVolume(positions, indices, { resolution: 128 }))
  const size = Math.max(...model.max.map((m, a) => m - model.min[a]))

  /** Solid runs of cells along an axis through a point: [from, to] world intervals. */
  const column = (point: Vec3, axis: Axis): [number, number][] => {
    const v = volume()
    const a = 'xyz'.indexOf(axis)
    const cell = point.map((p, i) => Math.floor((p - v.min[i]) / v.cellSize))
    const [, dy, dz] = v.dimensions
    const runs: [number, number][] = []
    let start = -1
    for (let i = 0; i <= v.dimensions[a]; i++) {
      cell[a] = i
      const inside =
        i < v.dimensions[a] &&
        cell.every((c, k) => c >= 0 && c < v.dimensions[k]) &&
        v.isInsideFlat[cell[0] * dy * dz + cell[1] * dz + cell[2]] === 1
      if (inside && start < 0) start = i
      if (!inside && start >= 0) {
        runs.push([v.min[a] + start * v.cellSize, v.min[a] + i * v.cellSize])
        start = -1
      }
    }
    return runs
  }

  /** Moves the point to the middle of the solid it is in (or the nearest solid) along `axis`; null if none. */
  const snap = (point: Vec3, axis: Axis): { point: Vec3; from: number; to: number } | null => {
    const a = 'xyz'.indexOf(axis)
    const runs = column(point, axis)
    if (runs.length === 0) return null
    const distance = ([from, to]: [number, number]) => (point[a] < from ? from - point[a] : point[a] > to ? point[a] - to : 0)
    const [from, to] = runs.reduce((best, run) => (distance(run) < distance(best) ? run : best))
    const snapped = [...point] as Vec3
    snapped[a] = (from + to) / 2
    return { point: snapped, from, to }
  }

  const m = {
    min: model.min,
    max: model.max,
    vertices: positions.length / 3,

    /** Renders the skinned model once skin() has run, else the raw model. Returns the PNG paths. */
    look: (options: LookOptions): Promise<string[]> =>
      render(current ?? preview, {
        out: options.out,
        views: options.view ?? ['+x', '+z', '+y', 'persp'],
        times: options.t ?? [0],
        animation: options.animation,
        pose: options.pose,
        xray: options.xray,
        labels: options.labels,
        weights: options.weights,
        sheet: options.sheet,
        focus: options.focus,
        bones: options.bones ?? (current !== undefined),
      }),

    /**
     * Solid regions where the plane axis=value cuts the model, largest first: {axis, value, regions:
     * [{cells, center, min, max}]} where center/min/max are objects keyed by the two in-plane axes, e.g.
     * {x, z} for a y slice. `value` is the cell layer actually cut (snapped to the 1/128 voxel grid);
     * null when the plane misses the model.
     */
    slice: (axis: Axis, values: number[]): (SliceResult | null)[] =>
      values.map((value) => sliceRegions(volume(), { axis, value })),

    /**
     * Skins the model, writes it (default ./skinned.glb, or `out`) and returns the report; later look/rom/walk
     * calls show this result. resolution: voxels along the longest axis (default 128; 256 removes most
     * weight bleed between touching parts at ~3x the time).
     */
    skin: async (skeleton: Skeleton, options: { out?: string; resolution?: number } = {}): Promise<SkinReport> => {
      const io = await createIO()
      const document = await io.read(path)
      const report = skin(document, skeleton, { resolution: options.resolution })
      const out = options.out ? resolve(options.out) : skinnedPath
      await write(out, document)
      current = out
      return report
    },

    /**
     * Separate mesh pieces, largest first. Bind props, armor, glasses 100% to a bone with
     * `{ name, parent, position, pieces: [index, ...] }` (the index is the position in this list).
     */
    parts: (): { index: number; vertices: number; center: Vec3; min: Vec3; max: Vec3 }[] =>
      meshParts(positions, indices).map((part, index) => ({
        index,
        vertices: part.vertices.length,
        min: part.min,
        max: part.max,
        center: part.min.map((lo, a) => (lo + part.max[a]) / 2) as Vec3,
      })),

    /**
     * Range-of-motion QA: one contact sheet with every non-root bone bent by `angle` (default 45°) in turn,
     * about the axis that makes the bend visible from the view. Returns the sheet path.
     */
    rom: async (options: { out: string; view?: string; angle?: number }): Promise<string> => {
      if (!current) throw new Error('rom() needs a skinned model: call skin() first')
      const page = await openPage(current)
      try {
        const joints = await page.joints()
        const view = options.view ?? 'persp'
        const toCamera = view === 'persp' ? new THREE.Vector3(1, 0.6, 1).normalize() : axisVector(view)
        const shots = joints
          .filter((joint) => joint.parent)
          .map((joint): Shot => ({ view, pose: { [joint.name]: bendEuler(joint, joints, toCamera, options.angle ?? 45) }, title: joint.name }))
        return await page.sheet(shots, `${options.out}-rom.png`, 5, 360)
      } finally {
        await page.close()
      }
    },

    /**
     * Mixamo-style humanoid: from 7 landmarks (left side; the right is mirrored across the groin's side
     * coordinate unless *_R landmarks are given) builds a standard skeleton with Mixamo bone names (Hips, Spine, Spine1, Spine2, Neck,
     * Head, LeftShoulder, LeftArm, LeftForeArm, LeftHand, LeftUpLeg, LeftLeg, LeftFoot, LeftToeBase, and
     * Right*), every joint centered in the solid along the facing (depth) axis. Returns the skeleton plus
     * notes about problems.
     */
    humanoid: (landmarks: HumanoidLandmarks, facing: Facing): { skeleton: Skeleton; notes: string[] } => {
      const forward = axisVector(facing)
      const up = new THREE.Vector3(0, 1, 0)
      const left = new THREE.Vector3().crossVectors(up, forward)
      const L = (p: Vec3) => new THREE.Vector3(...p)
      const depthAxis = facing[1] as Axis
      const depth = 'xyz'.indexOf(depthAxis)
      const sideAxis: Axis = depthAxis === 'z' ? 'x' : 'z'
      const side = 'xyz'.indexOf(sideAxis)
      const middle = landmarks.groin[side]
      const notes: string[] = []
      const place = (name: string, p: THREE.Vector3): Vec3 => {
        const snapped = snap(p.toArray() as Vec3, depthAxis)
        if (snapped) return snapped.point
        notes.push(`${name} at ${fmt(p)} has no solid along ${depthAxis}; kept as given`)
        return p.toArray() as Vec3
      }
      const centered = (p: THREE.Vector3) => p.setComponent(side, middle)
      const lerp = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t)
      const chin = L(landmarks.chin)
      const groin = L(landmarks.groin)
      const shoulder = L(landmarks.shoulder_L)
      const elbow = L(landmarks.elbow_L)
      const wrist = L(landmarks.wrist_L)
      const knee = L(landmarks.knee_L)
      const ankle = L(landmarks.ankle_L)
      const height = chin.y - groin.y

      const hips = centered(groin.clone().addScaledVector(up, 0.1 * height))
      const neck = centered(shoulder.clone().setY(shoulder.y + 0.3 * (chin.y - shoulder.y)))
      const head = centered(chin.clone())
      // Top of the head: the highest solid straight above the chin
      const topRun = column(head.toArray() as Vec3, 'y').at(-1)
      const headTop = head.clone().setY(topRun ? topRun[1] - size * 0.01 : head.y + 0.25 * height)
      // Toe: walk forward from the ankle just above the floor until the foot ends
      const toeY = model.min[1] + 0.3 * (ankle.y - model.min[1])
      const ankleDepth = ankle.getComponent(depth)
      const footRun = column(ankle.clone().setY(toeY).toArray() as Vec3, depthAxis).find(
        ([from, to]) => ankleDepth >= from - size * 0.05 && ankleDepth <= to + size * 0.05,
      )
      const tipDepth = footRun ? (forward.getComponent(depth) > 0 ? footRun[1] : footRun[0]) : ankleDepth
      const toeTip = ankle.clone().setY(toeY).setComponent(depth, tipDepth)
      const upLeg = knee.clone().setY(groin.y + 0.02 * height).setComponent(side, middle + 0.8 * (knee.getComponent(side) - middle))

      const leftBones: SkeletonBone[] = [
        { name: 'LeftShoulder', parent: 'Spine2', position: place('LeftShoulder', lerp(neck, shoulder, 0.4).setY(shoulder.y)) },
        { name: 'LeftArm', parent: 'LeftShoulder', position: place('LeftArm', shoulder) },
        { name: 'LeftForeArm', parent: 'LeftArm', position: place('LeftForeArm', elbow) },
        { name: 'LeftHand', parent: 'LeftForeArm', position: place('LeftHand', wrist), tail: wrist.clone().lerp(elbow, -0.45).toArray() as Vec3 },
        { name: 'LeftUpLeg', parent: 'Hips', position: place('LeftUpLeg', upLeg) },
        { name: 'LeftLeg', parent: 'LeftUpLeg', position: place('LeftLeg', knee) },
        { name: 'LeftFoot', parent: 'LeftLeg', position: place('LeftFoot', ankle) },
        {
          name: 'LeftToeBase',
          parent: 'LeftFoot',
          position: place('LeftToeBase', lerp(ankle.clone().setY(toeY), toeTip, 0.6)),
          tail: toeTip.toArray() as Vec3,
        },
      ]
      const bones: SkeletonBone[] = [
        { name: 'Hips', position: place('Hips', hips) },
        { name: 'Spine', parent: 'Hips', position: place('Spine', lerp(hips, neck, 0.25)) },
        { name: 'Spine1', parent: 'Spine', position: place('Spine1', lerp(hips, neck, 0.5)) },
        { name: 'Spine2', parent: 'Spine1', position: place('Spine2', lerp(hips, neck, 0.75)) },
        { name: 'Neck', parent: 'Spine2', position: place('Neck', neck) },
        { name: 'Head', parent: 'Neck', position: place('Head', lerp(neck, head, 0.7)), tail: place('HeadTop', headTop) },
        ...leftBones,
        ...mirror(leftBones, sideAxis, middle, 'Left', 'Right').map((bone) => {
          const given = rightLandmark(landmarks, bone.name)
          return given ? { ...bone, position: place(bone.name, L(given)) } : bone
        }),
      ]
      if (left.getComponent(side) * (shoulder.getComponent(side) - middle) < 0) {
        notes.push(`shoulder_L is on the wrong side: a model facing ${facing} has its own left toward ${fmt(left)}`)
      }
      return { skeleton: { bones }, notes }
    },

    /** Walk-cycle contact sheet (8 frames) for a humanoid() rig: checks the rig drives standard animation. */
    walk: async (options: { out: string; facing: Facing; view?: string }): Promise<string> => {
      if (!current) throw new Error('walk() needs a skinned model: call skin() first')
      const page = await openPage(current)
      try {
        const joints = await page.joints()
        const forward = axisVector(options.facing)
        const byName = new Map(joints.map((j) => [j.name, j]))
        const swing = (name: string, degrees: number): [string, Vec3][] => {
          const joint = byName.get(name)
          if (!joint) return []
          // Rotating about (forward x bone) by -angle moves the bone's end forward
          const axis = new THREE.Vector3().crossVectors(forward, boneDirection(joint, joints)).normalize()
          return [[name, eulerDegrees(axis, -degrees)]]
        }
        const shots = Array.from({ length: 8 }, (_, i): Shot => {
          const phase = (i / 8) * 2 * Math.PI
          const pose = Object.fromEntries([
            ...swing('LeftUpLeg', 25 * Math.sin(phase)),
            ...swing('RightUpLeg', -25 * Math.sin(phase)),
            ...swing('LeftLeg', -45 * Math.max(0, -Math.cos(phase))),
            ...swing('RightLeg', -45 * Math.max(0, Math.cos(phase))),
            ...swing('LeftArm', -20 * Math.sin(phase)),
            ...swing('RightArm', 20 * Math.sin(phase)),
            ...swing('LeftForeArm', 15),
            ...swing('RightForeArm', 15),
          ])
          return { view: options.view ?? 'persp', pose, title: `walk ${i + 1}/8` }
        })
        return await page.sheet(shots, `${options.out}-walk.png`, 4, 400)
      } finally {
        await page.close()
      }
    },
  }
  return m
}

async function write(file: string, document: Parameters<Awaited<ReturnType<typeof createIO>>['write']>[1]): Promise<void> {
  mkdirSync(dirname(file), { recursive: true })
  await (await createIO()).write(file, document)
}

/** The explicit right-side landmark for a mirrored bone, when the caller gave one. */
function rightLandmark(landmarks: HumanoidLandmarks, bone: string): Vec3 | undefined {
  const map: Record<string, keyof HumanoidLandmarks> = {
    RightArm: 'shoulder_R',
    RightForeArm: 'elbow_R',
    RightHand: 'wrist_R',
    RightLeg: 'knee_R',
    RightFoot: 'ankle_R',
  }
  return map[bone] ? landmarks[map[bone]] : undefined
}

function axisVector(view: string): THREE.Vector3 {
  const match = /^([+-])([xyz])$/.exec(view)
  if (!match) throw new Error(`expected an axis like +x or -z, got "${view}"`)
  return new THREE.Vector3().setComponent('xyz'.indexOf(match[2]), match[1] === '+' ? 1 : -1)
}

/** Direction of a bone: toward its first child, else away from its parent. */
function boneDirection(joint: Joint, joints: Joint[]): THREE.Vector3 {
  const at = (name?: string) => {
    const j = joints.find((k) => k.name === name)
    return j ? new THREE.Vector3(...j.position) : undefined
  }
  const self = new THREE.Vector3(...joint.position)
  const child = at(joint.child)
  const parent = at(joint.parent)
  const dir = child ? child.sub(self) : parent ? self.clone().sub(parent) : new THREE.Vector3(0, 1, 0)
  return dir.normalize()
}

/** Euler XYZ degrees bending the joint's bone by `angle` within the image plane (about the view direction). */
function bendEuler(joint: Joint, joints: Joint[], toCamera: THREE.Vector3, angle: number): Vec3 {
  const dir = boneDirection(joint, joints)
  // The view direction minus its component along the bone: rotating about it swings the bone sideways on screen
  let axis = toCamera.clone().addScaledVector(dir, -toCamera.dot(dir))
  if (axis.lengthSq() < 1e-6) axis = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0))
  return eulerDegrees(axis.normalize(), angle)
}

function eulerDegrees(axis: THREE.Vector3, degrees: number): Vec3 {
  const q = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees))
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ')
  return [e.x, e.y, e.z].map((r) => THREE.MathUtils.radToDeg(r)) as Vec3
}

const fmt = (p: THREE.Vector3) => `[${p.toArray().map((n) => n.toFixed(3)).join(', ')}]`

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
