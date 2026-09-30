/**
 * @drawcall/rig: tools for rigging any glTF with three.js in a Node script.
 *
 *   import * as THREE from 'three'
 *   import { bone, load, section, parts, skin, render, save } from '@drawcall/rig'
 *
 *   const scene = await load('model.glb')
 *   await render(scene, { out: 'shots/model.png' })             // what is it, which way does it face?
 *   section(scene, 'y', [0.2, 0.5])                             // limb centers at those heights
 *   const hips = bone('Hips', [0, 0.9, 0])                      // plain THREE.Bones, placed in world space
 *   bone('LeftUpLeg', [0.1, 0.85, 0], hips)
 *   const report = skin(scene, hips)                            // weights; warnings name the fix
 *   await render(scene, { out: 'shots/w.png', weights: 'Hips' })
 *   await save(scene, 'rigged.glb')
 *
 * In a browser, import the three.js core from '@drawcall/rig/three' (bone, section, parts, skin).
 */

export { bone, parts, section, skin } from './three.js'
export type { Axis, BoneOptions, BoneReport, Part, SkinOptions, SkinReport, SliceRegion, SliceResult } from './three.js'
export { load, render, save, type RenderOptions } from './node.js'
