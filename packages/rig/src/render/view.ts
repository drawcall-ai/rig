/** A view: one picture's camera, pose and display, checked and with its bone names resolved. */

import * as THREE from 'three'
import type { Sphere } from './camera.js'
import type { Pose } from './pose.js'

/**
 * '+x' = camera on the +x side looking toward -x, also -x, +y (top), -y, +z, -z: orthographic with a
 * labeled world grid; 'persp' = 3/4 view.
 */
export type Camera = '+x' | '-x' | '+y' | '-y' | '+z' | '-z' | 'persp'

/** Starts from the bind pose (a scene that is not skinned yet is shown as it is), then applies its rotations and targets. */
export interface View extends Pose {
  camera: Camera
  /** Caption, written before the camera name. */
  title?: string
  /** Draw the skeleton (default true); 'names' also writes each bone's name. */
  bones?: boolean | 'names'
  /** Color skinned meshes by weight: a bone name for its heatmap (blue 0 -> red 1), or true for each vertex in its strongest bone's color, darker where that weight is lower. */
  weights?: string | true
  /** Zoom on a bone (by name) or a world-space sphere. */
  focus?: string | Sphere
  /** Show only the geometry this bone and its descendants own (their strongest weight), zoomed to it unless `focus` is set. */
  isolate?: string
}

/** A view with its bone names resolved. */
export interface Shot {
  view: View
  weights?: THREE.Bone | true
  focus?: THREE.Bone | Sphere
  isolate?: THREE.Bone
}

const CAMERAS: Camera[] = ['+x', '-x', '+y', '-y', '+z', '-z', 'persp']
const VIEW_KEYS = ['camera', 'title', 'rotations', 'targets', 'bones', 'weights', 'focus', 'isolate']

/**
 * Checks a view and resolves its bone names against `bones` (every bone under the scene) and `palette`
 * (the bones of its skeletons), so a typo fails before anything is drawn or measured.
 */
export function resolve(view: View, bones: THREE.Bone[], palette: THREE.Bone[]): Shot {
  for (const key of Object.keys(view)) if (!VIEW_KEYS.includes(key)) throw new Error(`view: unknown key "${key}" (keys: ${VIEW_KEYS.join(', ')})`)
  if (!CAMERAS.includes(view.camera)) throw new Error(`view: unknown camera "${view.camera}" (cameras: ${CAMERAS.join(', ')})`)
  const named = (name: string, what: string) => {
    const bone = bones.find((b) => b.name === name)
    if (!bone) throw new Error(`${what} names unknown bone "${name}"`)
    return bone
  }
  if (view.weights !== undefined && palette.length === 0) throw new Error('weights needs a skinned scene; call skin() first')
  const weights = typeof view.weights === 'string' ? named(view.weights, 'weights') : view.weights
  if (weights instanceof THREE.Bone && !palette.includes(weights)) throw new Error(`weights names "${weights.name}", which is in no skeleton`)
  return {
    view,
    weights,
    focus: typeof view.focus === 'string' ? named(view.focus, 'focus') : view.focus,
    isolate: view.isolate === undefined ? undefined : named(view.isolate, 'isolate'),
  }
}
