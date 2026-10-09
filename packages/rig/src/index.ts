/**
 * @drawcall/rig: tools for rigging any glTF with three.js in a Node script.
 *
 *   import { bone, load, pick, pieces, render, save, section, skin } from '@drawcall/rig'
 *
 *   const scene = await load('model.glb')
 *   await render(scene, { out: 'shots/model.png' })             // what is it, which way does it face?
 *   console.log(JSON.stringify(section(scene, [{ y: 0.3 }, { y: 0.6 }]))) // solid regions per plane; centers are joints
 *   console.log(JSON.stringify(pick(scene, { camera: '+x' }, [{ y: 1.4, z: 0.1 }, { y: 1.4, z: 0.2 }]))) // the solid under each grid point, nearest first
 *   console.log(pieces(scene))                                  // separate mesh pieces (props, armor, eyes)
 *   const hips = bone('Hips', [0, 0.9, 0])                      // plain THREE.Bones at world positions
 *   bone('Spine', [0, 1.05, 0], hips)                           // added before the legs, so the Hips segment runs up the body
 *   const upLeg = bone('LeftUpLeg', [0.1, 0.85, 0], hips)
 *   const leg = bone('LeftLeg', [0.1, 0.5, 0], upLeg)
 *   bone('LeftFoot_End', [0.1, 0.05, 0.1], bone('LeftFoot', [0.1, 0.1, 0], leg))
 *   // a bone's segment runs to its first child; leaf bones (..._End) only mark where chains end
 *   console.log((await skin(scene, hips)).warnings)             // weights; warnings describe what the solver found
 *   await render(scene, { out: 'shots/w.png', views: [[{ camera: '+x', weights: true }]] })  // every bone's weights
 *   await save(scene, 'rigged.glb')                             // the source file with the rig, in its bind pose
 *
 * In a browser, import the three.js core from '@drawcall/rig/three' (bone, section, pieces, skin). pick
 * needs no Node itself, but its points are read off a render image, so it is exported next to render, here.
 */

import { solveParallel } from './skin/parallel.js'
import { useSolver } from './skin/weights.js'

// In Node, skin() spreads the blur passes over worker threads
useSolver(solveParallel)

export { bone, pieces, section, skin } from './three.js'
export type { Axis, BoneReport, Piece, Plane, Region, Section, SkinReport } from './three.js'
export { load } from './gltf/load.js'
export { save } from './gltf/save.js'
export { pick, type Point, type Span } from './measure/pick.js'
export { render, type RenderOptions } from './render/sheet.js'
export type { Camera, View } from './render/view.js'
export type { Pose } from './render/pose.js'
