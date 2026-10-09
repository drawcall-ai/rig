/**
 * Looping motions for the example rigs, written against bone names. Bones bind with identity
 * rotation, so a rotation about a world axis is enough; each helper derives that axis from the
 * bone's own direction (joint to first child) and the direction the creature faces.
 */

import * as THREE from 'three'

/** Sets every animated bone for time t (seconds). */
export type Motion = (t: number) => void

type Bones = Map<string, THREE.Bone>

const UP = new THREE.Vector3(0, 1, 0)
const DEG = Math.PI / 180

/** World direction from a bone's joint to its first child (or away from its parent), at bind. */
function direction(bone: THREE.Bone): THREE.Vector3 {
  const from = bone.getWorldPosition(new THREE.Vector3())
  const child = bone.children.find((c) => c instanceof THREE.Bone)
  if (child) return child.getWorldPosition(new THREE.Vector3()).sub(from).normalize()
  return bone.parent ? from.sub(bone.parent.getWorldPosition(new THREE.Vector3())).normalize() : UP.clone()
}

/** Rotations about a fixed axis per bone, computed once at bind. */
function rotor(bones: Bones, axisOf: (bone: THREE.Bone) => THREE.Vector3) {
  const axes = new Map([...bones].map(([name, bone]) => [name, axisOf(bone).normalize()]))
  return (name: string, degrees: number) => {
    const bone = bones.get(name)
    const axis = axes.get(name)
    if (bone && axis && axis.lengthSq() > 0) bone.quaternion.setFromAxisAngle(axis, degrees * DEG)
  }
}

/** Humanoid walk on Mixamo names: legs and arms swing forward and back, knees and elbows bend. */
export function walk(bones: Bones, forward: THREE.Vector3): Motion {
  // Rotating about (forward x bone) by -angle moves the bone's end forward
  const swing = rotor(bones, (bone) => new THREE.Vector3().crossVectors(forward, direction(bone)).negate())
  const turn = rotor(bones, () => UP.clone())
  const hips = bones.get('Hips')
  const rest = hips?.position.clone()
  return (t) => {
    const p = 2 * Math.PI * t * 1.1
    for (const [side, s] of [['Left', 1], ['Right', -1]] as const) {
      swing(`${side}UpLeg`, 25 * s * Math.sin(p))
      swing(`${side}Leg`, -45 * Math.max(0, -s * Math.cos(p)))
      swing(`${side}Foot`, 15 * s * Math.sin(p))
      swing(`${side}Arm`, -18 * s * Math.sin(p))
      swing(`${side}ForeArm`, 20)
    }
    turn('Spine1', 5 * Math.sin(p))
    turn('Head', -4 * Math.sin(p))
    if (hips && rest) hips.position.set(rest.x, rest.y + Math.abs(Math.cos(p)) * 0.02 * rest.y, rest.z)
  }
}

/** Bird flight: wing segments rise and fall with a lag toward the tips, the tail and head follow. */
export function flap(bones: Bones, forward: THREE.Vector3): Motion {
  // Rotating about (bone x up) by +angle lifts the bone's end
  const raise = rotor(bones, (bone) => new THREE.Vector3().crossVectors(direction(bone), UP))
  const pitch = rotor(bones, () => new THREE.Vector3().crossVectors(UP, forward))
  const names = [...bones.keys()]
  const wings = (side: string) => names.filter((n) => n.startsWith(side) && /Wing/.test(n) && !/End$/.test(n))
  // One Tail bone (a bird) or a chain Tail1, Tail2, ... (a dragon), each following the last with a lag
  const tail = names.filter((n) => /^Tail\d*$/.test(n))
  return (t) => {
    const p = 2 * Math.PI * t * 1.4
    for (const side of ['Left', 'Right']) {
      wings(side).forEach((name, i) => raise(name, (32 - i * 6) * Math.sin(p - i * 0.6)))
    }
    tail.forEach((name, i) => pitch(name, (6 / Math.sqrt(tail.length)) * Math.sin(p + 1 - i * 0.4)))
    pitch('Neck', -4 * Math.sin(p))
    pitch('Head', 4 * Math.sin(p))
  }
}

/** Fish swim: a sideways wave that grows toward the tail, pectoral fins paddle. */
export function swim(bones: Bones): Motion {
  const yaw = rotor(bones, () => UP.clone())
  const raise = rotor(bones, (bone) => new THREE.Vector3().crossVectors(direction(bone), UP))
  const body = ['Spine1', 'Spine2', 'Spine3', 'Tail1', 'Tail2', 'CaudalFin']
  return (t) => {
    const p = 2 * Math.PI * t * 1.3
    body.forEach((name, i) => yaw(name, (3 + i * 3) * Math.sin(p - i * 0.7)))
    yaw('Head', -4 * Math.sin(p + 0.7))
    raise('LeftPectoralFin', 20 * Math.sin(p * 2))
    raise('RightPectoralFin', 20 * Math.sin(p * 2))
  }
}

/** Hands opening and closing into fists on Mixamo finger names (LeftHandIndex1..3, ...), palms facing the body. */
export function grip(bones: Bones, forward: THREE.Vector3): Motion {
  // The creature's left lies along up x forward; each finger curls toward its palm, i.e. toward the body
  const left = new THREE.Vector3().crossVectors(UP, forward).normalize()
  const curl = rotor(bones, (bone) => {
    const palm = bone.name.startsWith('Left') ? left.clone().negate() : left.clone()
    return new THREE.Vector3().crossVectors(direction(bone), palm)
  })
  return (t) => {
    const closed = 0.5 - 0.5 * Math.cos(2 * Math.PI * t * 0.4)
    for (const side of ['Left', 'Right']) {
      for (const finger of ['Index', 'Middle', 'Ring', 'Pinky']) {
        ;[85, 95, 65].forEach((degrees, i) => curl(`${side}Hand${finger}${i + 1}`, degrees * closed))
      }
      ;[25, 30, 30].forEach((degrees, i) => curl(`${side}HandThumb${i + 1}`, degrees * closed))
    }
  }
}
