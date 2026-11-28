/**
 * Poses a rigged face by hand: its ARKit shapes by name on every mesh carrying them, the eyes from the eyeLook weights
 * with the lids following the gaze, and the head and neck. Any ARKit-compatible driver can stand in for it.
 */

import { FACE_BONES, isFaceData } from '@drawcall/rig'
import * as THREE from 'three/webgpu'

/** Radians: nod chin down, turn to the face's left, tilt toward its right shoulder. */
export interface HeadPose { nod: number; turn: number; tilt: number }

/** How far an eye turns at an eyeLook weight of 1, radians. */
const EYE_YAW = 0.5, EYE_PITCH = 0.35
/** The neck's share of the head motion. */
const NECK_SHARE = 0.4

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1)

export class Poser {
  /** The face's shapes, by ARKit name. */
  readonly shapes: string[] = []
  private readonly targets: { mesh: THREE.Mesh; shapes: [number, string][] }[] = []
  private readonly eyes: [THREE.Object3D, THREE.Quaternion][]
  private readonly turners: [(pose: HeadPose) => void, number][]

  /** Construct in the bind pose, which stays the rest. */
  constructor(object: THREE.Object3D, neck: string) {
    object.traverse((node) => {
      const data: unknown = node instanceof THREE.Mesh ? node.geometry.userData.face : undefined
      if (isFaceData(data) && !this.shapes.length) this.shapes.push(...data.shapes)
    })
    if (!this.shapes.length) throw new Error('no rigged face under this object')
    const names = new Set(this.shapes)
    object.traverse((node) => {
      if (!(node instanceof THREE.Mesh) || !node.morphTargetDictionary) return
      const shapes = Object.entries(node.morphTargetDictionary).flatMap(([name, i]): [number, string][] => (names.has(name) ? [[i, name]] : []))
      if (shapes.length) this.targets.push({ mesh: node, shapes })
    })
    const bone = (name: string) => {
      const found = object.getObjectByName(name)
      if (!found) throw new Error(`no bone "${name}"`)
      return found
    }
    // the eye bones rest in the face's frame (+Z forward, +Y up, +X the face's left), so they turn about their own axes
    this.eyes = [bone(FACE_BONES.leftEye), bone(FACE_BONES.rightEye)].map((eye) => [eye, eye.quaternion.clone()])
    const [leftEye] = this.eyes[0]
    if (!leftEye.parent) throw new Error('the eyes hang under no head bone')
    object.updateWorldMatrix(true, true)
    const face = leftEye.getWorldQuaternion(new THREE.Quaternion())
    this.turners = [[turner(bone(neck), face), NECK_SHARE], [turner(leftEye.parent, face), 1 - NECK_SHARE]]
  }

  /** Sets every shape to its weight in `weights` (missing ones to 0), the eyes from the eyeLook weights, and the head. */
  update(weights: Readonly<Record<string, number>>, head: HeadPose): void {
    const w = (name: string) => weights[name] ?? 0
    const blink: Record<string, number> = {}
    const q = new THREE.Quaternion()
    for (const [i, side] of (['Left', 'Right'] as const).entries()) {
      const [eye, rest] = this.eyes[i]
      // eyeLookOut turns an eye away from the nose: toward the face's left (+yaw) for the left eye
      const yaw = (side === 'Left' ? w('eyeLookOutLeft') - w('eyeLookInLeft') : w('eyeLookInRight') - w('eyeLookOutRight')) * EYE_YAW
      const pitch = (w(`eyeLookDown${side}`) - w(`eyeLookUp${side}`)) * EYE_PITCH
      eye.quaternion.copy(rest).multiply(q.setFromAxisAngle(Y, yaw)).multiply(q.setFromAxisAngle(X, pitch))
      // the lids follow the gaze, lowering with it and opening less far as it rises
      blink[`eyeBlink${side}`] = THREE.MathUtils.clamp(w(`eyeBlink${side}`) + THREE.MathUtils.clamp(pitch * 1.3, -0.2, 0.35), 0, 1)
    }
    for (const { mesh: { morphTargetInfluences: influences }, shapes } of this.targets) {
      if (influences) for (const [i, name] of shapes) influences[i] = blink[name] ?? w(name)
    }
    for (const [turn, share] of this.turners) turn({ nod: head.nod * share, turn: head.turn * share, tilt: head.tilt * share })
  }
}

/** Turns `bone` from its rest about the face's axes, the frame whose world rotation is `face`. */
function turner(bone: THREE.Object3D, face: THREE.Quaternion): (pose: HeadPose) => void {
  const rest = bone.quaternion.clone()
  // the face's axes in the bone's own frame
  const toBone = bone.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(face)
  const [left, up, forward] = [X, Y, Z].map((axis) => axis.clone().applyQuaternion(toBone))
  const q = new THREE.Quaternion()
  return ({ nod, turn, tilt }) => {
    bone.quaternion.copy(rest)
      .multiply(q.setFromAxisAngle(up, turn))
      .multiply(q.setFromAxisAngle(left, nod))
      .multiply(q.setFromAxisAngle(forward, tilt))
  }
}
