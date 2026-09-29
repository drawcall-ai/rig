/**
 * @drawcall/rig: tools for rigging any glTF with three.js in a Node script.
 *
 *   import * as THREE from 'three'
 *   import { load, section, parts, skin, render, save } from '@drawcall/rig'
 *
 *   const scene = await load('model.glb')
 *   await render(scene, { out: 'shots/model.png' })             // what is it, which way does it face?
 *   section(scene, 'y', [0.2, 0.5])                             // limb centers at those heights
 *   const hips = new THREE.Bone()                               // the skeleton is plain three.js
 *   hips.name = 'Hips'
 *   hips.position.set(0, 0.9, 0)
 *   const report = skin(scene, hips)                            // weights; warnings name the fix
 *   await render(scene, { out: 'shots/w.png', weights: 'Hips' })
 *   await save(scene, 'rigged.glb')
 *
 * In a browser, import the three.js core from '@drawcall/rig/three' (section, parts, skin).
 */

export { parts, section, skin } from './three.js'
export type { Axis, BoneReport, Part, SkinOptions, SkinReport, SliceRegion, SliceResult } from './three.js'
export { load, render, save, type RenderOptions } from './node.js'
