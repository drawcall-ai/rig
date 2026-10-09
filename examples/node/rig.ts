/**
 * Rig the horse in a Node script: load, measure, build three.js bones, skin,
 * render a check image and save.
 *
 *   pnpm rig
 */

import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { bone, load, render, save, section, skin, type View } from '@drawcall/rig'

const scene = await load('horse.glb')

// Cross-section through the legs: one region per leg, with its world center
for (const region of section(scene, [{ y: 30 }])[0].regions) console.log('leg at', region.center)

// The skeleton: plain THREE.Bones, here built from joint world positions
const skeleton = JSON.parse(readFileSync('horse.skeleton.json', 'utf8')) as { bones: JointSpec[] }
const root = buildBones(skeleton.bones)

const report = await skin(scene, root)
for (const bone of report.bones) console.log(`${bone.name}: ${bone.vertices} vertices`)
for (const warning of report.warnings) console.warn(`warning: ${warning}`)

// Check a pose (each view starts from the bind pose), then save
const pose = { rotations: { frontL_upper: [-0.8, 0, 0] } } satisfies Omit<View, 'camera'>
console.log('wrote', await render(scene, { out: 'horse.check.png', views: [[{ ...pose, camera: '+x' }, { ...pose, camera: 'persp' }]] }))
await save(scene, 'horse.skinned.glb')
console.log('wrote horse.skinned.glb')

interface JointSpec {
  name: string
  parent?: string
  position: [number, number, number]
  tail?: [number, number, number]
}

/** Bones from world-space joint positions (identity rotations); returns the root. */
function buildBones(specs: JointSpec[]): THREE.Bone {
  const made = new Map<string, THREE.Bone>()
  // Parents first; a spec's tail becomes an end bone, the convention skin() uses to end a chain
  const place = (spec: JointSpec): THREE.Bone => {
    const existing = made.get(spec.name)
    if (existing) return existing
    const parentSpec = specs.find((s) => s.name === spec.parent)
    const b = bone(spec.name, spec.position, parentSpec && place(parentSpec))
    if (spec.tail) bone(`${spec.name}_end`, spec.tail, b)
    made.set(spec.name, b)
    return b
  }
  specs.forEach(place)
  return made.get(specs.find((spec) => !spec.parent)?.name ?? '') as THREE.Bone
}
