/**
 * @drawcall/rig: tools for rigging any glTF with three.js in a Node script.
 *
 *   import * as THREE from 'three'
 *   import { load, section, parts, skin, render, save } from '@drawcall/rig'
 *
 *   const scene = await load('model.glb')
 *   await render(scene, { out: 'shots/model.png' })             // what is it, which way does it face?
 *   section(scene, 'y', [0.2, 0.5])                             // limb centers at those heights
 *   const hips = Object.assign(new THREE.Bone(), { name: 'Hips' }) // plain THREE.Bones
 *   hips.position.set(0, 0.9, 0)                                // world position (hips is a root)
 *   const leg = Object.assign(new THREE.Bone(), { name: 'LeftUpLeg' })
 *   leg.position.set(0.1, 0.85, 0)                              // world position...
 *   hips.attach(leg)                                            // ...kept when parenting
 *   // a bone's segment runs to its first child; leaf bones (e.g. LeftFoot_End) only mark ends
 *   const report = skin(scene, hips)                            // weights; warnings name the fix
 *   await render(scene, { out: 'shots/w.png', weights: 'Hips' })
 *   await save(scene, 'rigged.glb')
 *
 * In a browser, import the three.js core from '@drawcall/rig/three' (section, parts, skin).
 */

export { parts, section, skin } from './three.js'
export type { Axis, BoneReport, Part, SkinOptions, SkinReport, SliceRegion, SliceResult } from './three.js'
export { load, render, save, type RenderOptions } from './node.js'
