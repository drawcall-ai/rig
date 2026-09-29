/**
 * Rig the horse in a Node script: load, measure, build three.js bones, skin,
 * render a check image and save.
 *
 *   pnpm rig
 */

import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { load, render, save, section, skin } from '@drawcall/rig'

const scene = await load('horse.glb')

// Cross-section through the legs: one region per leg, with its world center
for (const region of section(scene, 'y', [30])[0]?.regions ?? []) console.log('leg at', region.center)

// The skeleton: plain THREE.Bones, here built from joint world positions
const skeleton = JSON.parse(readFileSync('horse.skeleton.json', 'utf8')) as { bones: JointSpec[] }
const root = buildBones(skeleton.bones)

const report = skin(scene, root)
for (const bone of report.bones) console.log(`${bone.name}: ${bone.vertices} vertices`)
for (const warning of report.warnings) console.warn(`warning: ${warning}`)

// Check a pose, then save (the file keeps the bind pose)
scene.getObjectByName('frontL_upper')?.rotation.set(-0.8, 0, 0)
console.log('wrote', await render(scene, { out: 'horse.check.png', views: ['+x', 'persp'] }))
await save(scene, 'horse.skinned.glb')
console.log('wrote horse.skinned.glb')

interface JointSpec {
  name: string
  parent?: string
  position: [number, number, number]
  tail?: [number, number, number]
  deform?: boolean
}

/** Bones from world-space joint positions (identity rotations); returns the root. */
function buildBones(specs: JointSpec[]): THREE.Bone {
  const bones = new Map(specs.map((spec) => [spec.name, Object.assign(new THREE.Bone(), { name: spec.name })]))
  for (const spec of specs) {
    const bone = bones.get(spec.name) as THREE.Bone
    const parent = spec.parent ? specs.find((s) => s.name === spec.parent) : undefined
    bone.position.set(...spec.position)
    if (parent) bone.position.sub(new THREE.Vector3(...parent.position))
    if (spec.parent) bones.get(spec.parent)?.add(bone)
    Object.assign(bone.userData, { tail: spec.tail, deform: spec.deform })
  }
  return bones.get(specs.find((spec) => !spec.parent)?.name ?? '') as THREE.Bone
}
