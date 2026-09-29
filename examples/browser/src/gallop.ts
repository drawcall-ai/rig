/**
 * Procedural gallop for the example horse skeleton (examples/node/horse.skeleton.json).
 * Joints have identity bind rotations and the horse faces +z, so rotating a
 * joint about +x swings its bone backward: every channel is a pitch angle.
 *
 * The bind pose is mid-gallop (legs in different phases), so legs are keyed in
 * absolute segment angles (degrees from straight down, + = lower end backward)
 * and converted to joint rotations against each bone's bind angle. The body's
 * height and pitch are then solved so planted hooves stand on the bind-pose ground.
 */

import * as THREE from 'three'

const DURATION = 0.6
const SAMPLES = 60
/** Share of the stride each hoof is on the ground. */
const STANCE = 0.35

/** Stride time at which each hoof lands (transverse gallop, left lead). */
const LEGS = {
  hindR: 0,
  hindL: 0.12,
  frontR: 0.3,
  frontL: 0.42,
}

/**
 * Leg keys: [phase, ...absolute segment angles], phase 0 = hoof lands,
 * STANCE = hoof leaves the ground. Segments from the body down to the hoof.
 */
const FRONT = {
  bones: ['upper', 'forearm', 'cannon', 'hoof'],
  keys: [
    [0, -5, -15, -15, -35],
    [0.17, 5, 0, 0, -50],
    [0.35, 12, 15, 18, 10],
    [0.5, 12, 8, 95, 125],
    [0.68, -10, -45, 45, 75],
    [0.84, -20, -70, -40, -25],
  ],
}
const HIND = {
  bones: ['thigh', 'shin', 'cannon', 'hoof'],
  keys: [
    [0, -5, 25, -12, -25],
    [0.17, 15, 45, 10, -35],
    [0.35, 30, 40, 30, 15],
    [0.42, 28, 70, 20, 90],
    [0.51, 16, 70, -20, 55],
    [0.62, -2, 60, -42, -10],
    [0.76, -18, 50, -40, -20],
    [0.9, -15, 32, -25, -25],
  ],
}

/** Neck, head and tail swing, as functions of stride time 0..1 (the body pitch is solved). */
const wave = (amplitude: number, peak: number) => (t: number) => amplitude * Math.cos(2 * Math.PI * (t - peak))
const BODY: Record<string, (t: number) => number> = {
  neck1: wave(5, 0.6),
  neck2: wave(-3, 0.6),
  head: wave(-4, 0.65),
  tail1: (t) => -10 + wave(6, 0.7)(t),
  tail2: wave(8, 0.8),
  tail3: wave(8, 0.9),
}
/** Extra rise of the body while all four hooves are off the ground. */
const SUSPENSION = 8

/** Stride phase of a leg at stride time t: 0 = hoof lands. */
const phaseOf = (lands: number, t: number): number => (((t - lands) % 1) + 1) % 1

/** Periodic cubic Hermite through the keys' column, at phase p in 0..1. */
function sample(keys: number[][], column: number, p: number): number {
  const n = keys.length
  let i = n - 1
  while (keys[i][0] > p) i--
  const phase = (k: number) => keys[((k % n) + n) % n][0] + Math.floor(k / n)
  const value = (k: number) => keys[((k % n) + n) % n][column]
  const span = phase(i + 1) - phase(i)
  const s = (p - phase(i)) / span
  // Tangents scaled by the neighboring spans so uneven key spacing stays smooth
  const m1 = ((value(i + 1) - value(i - 1)) / (phase(i + 1) - phase(i - 1))) * span
  const m2 = ((value(i + 2) - value(i)) / (phase(i + 2) - phase(i))) * span
  const s2 = s * s
  const s3 = s2 * s
  return (2 * s3 - 3 * s2 + 1) * value(i) + (s3 - 2 * s2 + s) * m1 + (-2 * s3 + 3 * s2) * value(i + 1) + (s3 - s2) * m2
}

/** Bind angle of the segment from a bone to its first child bone, degrees from straight down. */
function bindAngle(bone: THREE.Object3D): number {
  const child = bone.children.find((object) => object instanceof THREE.Bone) as THREE.Object3D
  const d = child.position
  return THREE.MathUtils.radToDeg(Math.atan2(-d.z, -d.y))
}

/** Joint pitch in degrees per bone at stride time t in 0..1, with the body pitched by hipsPitch. */
function pose(root: THREE.Object3D, t: number, hipsPitch: number): Map<string, number> {
  const pitch = new Map<string, number>([['hips', hipsPitch]])
  for (const [name, channel] of Object.entries(BODY)) pitch.set(name, channel(t))
  // Keep the head roughly level while the body rocks
  pitch.set('neck1', pitch.get('neck1')! - 0.5 * hipsPitch)
  for (const [leg, lands] of Object.entries(LEGS)) {
    const { bones, keys } = leg.startsWith('front') ? FRONT : HIND
    const p = phaseOf(lands, t)
    let parent = hipsPitch
    bones.forEach((segment, i) => {
      const name = `${leg}_${segment}`
      const total = sample(keys, i + 1, p) - bindAngle(root.getObjectByName(name) as THREE.Object3D)
      pitch.set(name, total - parent)
      parent = total
    })
  }
  return pitch
}

/** Fill the undefined entries of a periodic series by linear interpolation. */
function fill(values: (number | undefined)[]): number[] {
  const n = values.length
  const known = values.flatMap((value, i) => (value === undefined ? [] : [i]))
  return values.map((value, i) => {
    if (value !== undefined) return value
    const a = known.filter((k) => k < i).at(-1) ?? known.at(-1)! - n
    const b = known.find((k) => k > i) ?? known[0] + n
    const s = (i - a) / (b - a)
    return (1 - s) * values[(a + n) % n]! + s * values[b % n]!
  })
}

/** Periodic [1 2 1] smoothing, applied `passes` times. */
function smooth(values: number[], passes: number): number[] {
  const n = values.length
  for (let pass = 0; pass < passes; pass++) {
    values = values.map((value, i) => (values[(i - 1 + n) % n] + 2 * value + values[(i + 1) % n]) / 4)
  }
  return values
}

/** The gallop clip, or null when the model lacks the example skeleton's bones. */
export function gallop(root: THREE.Object3D): THREE.AnimationClip | null {
  const legs = Object.entries(LEGS)
  const hips = root.getObjectByName('hips')
  const toes = legs.map(([leg]) => root.getObjectByName(`${leg}_toe`))
  if (!hips || toes.some((toe) => !toe)) return null
  const x = new THREE.Vector3(1, 0, 0)
  const world = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3())
  const apply = (pitch: Map<string, number>) => {
    for (const [name, angle] of pitch) {
      root.getObjectByName(name)!.quaternion.setFromAxisAngle(x, THREE.MathUtils.degToRad(angle))
    }
    root.updateMatrixWorld(true)
  }

  root.updateMatrixWorld(true)
  const ground = Math.min(...toes.map((toe) => world(toe!).y))
  // Lever arms from the hips pivot to the shoulders and hip joints
  const reach = (girdle: string, bone: string) =>
    legs
      .filter(([leg]) => leg.startsWith(girdle))
      .reduce((sum, [leg]) => sum + world(root.getObjectByName(`${leg}_${bone}`)!).z - world(hips).z, 0) / 2
  const frontArm = reach('front', 'upper')
  const hindArm = reach('hind', 'thigh')

  // How far each girdle must drop so its lowest planted hoof meets the ground
  const n = SAMPLES
  const times = Array.from({ length: n }, (_, i) => i / n)
  const needs = times.map((t) => {
    apply(pose(root, t, 0))
    const need = (girdle: string) => {
      const planted = legs.flatMap(([leg, lands], i) =>
        leg.startsWith(girdle) && phaseOf(lands, t) < STANCE ? [world(toes[i]!).y] : [],
      )
      return planted.length ? ground - Math.min(...planted) : undefined
    }
    return { front: need('front'), hind: need('hind') }
  })
  const airborne = needs.map((need) => need.front === undefined && need.hind === undefined)
  const front = fill(needs.map((need) => need.front))
  const hind = fill(needs.map((need) => need.hind))
  // Pitch the body about the hips so both girdles meet their need, then lift it
  const sine = smooth(times.map((_, i) => (hind[i] - front[i]) / (frontArm - hindArm)), 2)
  const rise = smooth(airborne.map((air) => (air ? SUSPENSION : 0)), 4)
  const lift = smooth(times.map((_, i) => hind[i] + hindArm * sine[i]), 2).map((h, i) => h + rise[i])
  const pitches = sine.map((s) => THREE.MathUtils.radToDeg(Math.asin(s)))
  const poses = times.map((t, i) => pose(root, t, pitches[i]))
  for (const name of poses[0].keys()) root.getObjectByName(name)!.quaternion.identity()
  root.updateMatrixWorld(true)

  // Close the loop with a copy of the first key
  const keyTimes = [...times, 1].map((t) => t * DURATION)
  poses.push(poses[0])
  lift.push(lift[0])
  const q = new THREE.Quaternion()
  const tracks: THREE.KeyframeTrack[] = []
  for (const name of poses[0].keys()) {
    const values = poses.flatMap((pitch) => q.setFromAxisAngle(x, THREE.MathUtils.degToRad(pitch.get(name)!)).toArray())
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, keyTimes, values))
  }
  const scale = hips.parent ? hips.parent.getWorldScale(new THREE.Vector3()).y : 1
  const bob = lift.flatMap((h) => [hips.position.x, hips.position.y + h / scale, hips.position.z])
  tracks.push(new THREE.VectorKeyframeTrack('hips.position', keyTimes, bob))
  return new THREE.AnimationClip('gallop', DURATION, tracks)
}
