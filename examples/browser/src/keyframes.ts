/**
 * A looping animation as plain JSON, so skeletons made with the CLI can be
 * animated without code. Angles are degrees, Euler XYZ, relative to the bind
 * pose (joints bind with identity rotation); translations are offsets from the
 * joint's bind position. Keys are [time, x, y, z], times in seconds.
 *
 *   { "duration": 0.6,
 *     "rotation": { "thigh": [[0, -20, 0, 0], [0.3, 25, 0, 0], [0.6, -20, 0, 0]] },
 *     "translation": { "hips": [[0, 0, 0, 0], [0.15, 0, 4, 0], [0.3, 0, 0, 0]] } }
 */

import * as THREE from 'three'

export type Keys = [number, number, number, number][]

export interface KeyframeAnimation {
  duration: number
  rotation?: Record<string, Keys>
  translation?: Record<string, Keys>
}

export function keyframeClip(root: THREE.Object3D, animation: KeyframeAnimation): THREE.AnimationClip {
  const bone = (name: string): THREE.Object3D => {
    const object = root.getObjectByName(name)
    if (!object) throw new Error(`animation targets unknown bone "${name}"`)
    return object
  }
  const tracks: THREE.KeyframeTrack[] = []
  for (const [name, keys] of Object.entries(animation.rotation ?? {})) {
    bone(name)
    const q = new THREE.Quaternion()
    const euler = new THREE.Euler()
    const d = THREE.MathUtils.degToRad
    const values = keys.flatMap(([, x, y, z]) => q.setFromEuler(euler.set(d(x), d(y), d(z))).toArray())
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, keys.map(([t]) => t), values))
  }
  for (const [name, keys] of Object.entries(animation.translation ?? {})) {
    const { x, y, z } = bone(name).position
    const values = keys.flatMap(([, dx, dy, dz]) => [x + dx, y + dy, z + dz])
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, keys.map(([t]) => t), values))
  }
  return new THREE.AnimationClip('keyframes', animation.duration, tracks)
}
