import { readFile } from 'node:fs/promises'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { FaceLandmarks, FaceOptions, FaceResult } from '../dist/index.js'
import { applyFace } from '../dist/face/edit.js'

export interface Head {
  geometry: THREE.BufferGeometry
  /** The face rig's landmarks, sampled on the surface. */
  landmarks: FaceLandmarks
}

/**
 * The reference head (facing +z, meters, the character's left at +x) as the face rig expects a character's head: its
 * eyeballs dropped and the skin closed over each eye opening, as if the eyes were painted on.
 */
export async function closedHead(): Promise<Head> {
  const data = await readFile(new URL('../assets/face.glb', import.meta.url))
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(data).buffer, '')
  let source: THREE.Mesh | undefined
  gltf.scene.traverse((node) => { if (node instanceof THREE.Mesh) source = node })
  if (!source) throw new Error('no mesh in the reference head')
  const position = source.geometry.getAttribute('position')
  const index = source.geometry.getIndex()
  if (!index) throw new Error('the reference head has no index')
  const p = (v: number) => new THREE.Vector3().fromBufferAttribute(position, v)
  const triangles: number[] = []
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)]
    const center = p(a).add(p(b)).add(p(c)).divideScalar(3)
    // the eyeballs and the lid skin folding in behind them
    if (center.z > 0.03 && ((Math.abs(center.x) - 0.032) / 0.017) ** 2 + ((center.y - 1.692) / 0.009) ** 2 < 1) continue
    triangles.push(a, b, c)
  }
  const points = Array.from({ length: position.count }, (_, v) => p(v))
  for (const loop of openLoops(triangles)) {
    const center = loop.reduce((sum, v) => sum.add(points[v]), new THREE.Vector3()).divideScalar(loop.length)
    if (center.z < 0.03 || center.y < 1.66) continue
    // concentric rings, so the eye cut finds a disk of small triangles rather than slivers meeting at one point
    let outer = loop
    for (const k of [0.75, 0.5, 0.25]) {
      const inner = loop.map((v) => points.push(points[v].clone().lerp(center, 1 - k)) - 1)
      outer.forEach((v, i) => {
        const j = (i + 1) % outer.length
        triangles.push(outer[j], v, inner[i], outer[j], inner[i], inner[j])
      })
      outer = inner
    }
    const hub = points.push(center) - 1
    outer.forEach((v, i) => triangles.push(outer[(i + 1) % outer.length], v, hub))
  }
  const geometry = new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap((v) => v.toArray()), 3))
    .setIndex(triangles)
  return { geometry, landmarks: landmarks(geometry) }
}

/** Landmarks at the template's front-view (y, lateral z) positions; lateral template z is -x here. */
function landmarks(geometry: THREE.BufferGeometry): Head['landmarks'] {
  const ray = new THREE.Raycaster()
  const surface = new THREE.Mesh(geometry)
  const at = (y: number, z: number): [number, number, number] => {
    ray.set(new THREE.Vector3(-z, y, 1), new THREE.Vector3(0, 0, -1))
    const hit = ray.intersectObject(surface)[0]
    if (!hit) throw new Error(`no surface at ${y} ${z}`)
    return [hit.point.x, hit.point.y, hit.point.z]
  }
  return {
    eyeInnerLeft: at(1.690, -0.0195), eyeInnerRight: at(1.690, 0.0195), eyeOuterLeft: at(1.692, -0.0455), eyeOuterRight: at(1.692, 0.0455),
    lidUpperLeft: at(1.6975, -0.032), lidUpperRight: at(1.6975, 0.032), lidLowerLeft: at(1.6865, -0.032), lidLowerRight: at(1.6865, 0.032),
    browInnerLeft: at(1.707, -0.014), browInnerRight: at(1.707, 0.014), browMidLeft: at(1.711, -0.032), browMidRight: at(1.711, 0.032),
    browOuterLeft: at(1.707, -0.05), browOuterRight: at(1.707, 0.05),
    noseWingLeft: at(1.652, -0.0175), noseWingRight: at(1.652, 0.0175), cheekLeft: at(1.672, -0.048), cheekRight: at(1.672, 0.048),
    jawLeft: at(1.598, -0.052), jawRight: at(1.598, 0.052), mouthCornerLeft: at(1.628, -0.0255), mouthCornerRight: at(1.628, 0.0255),
    mouthCenter: at(1.629, 0), lowerLip: at(1.618, 0), chin: at(1.592, 0), noseTip: at(1.6625, 0), subnasale: at(1.6455, 0),
    noseBridge: at(1.686, 0), glabella: at(1.704, 0), hairline: at(1.75, 0),
  }
}

/** Boundary loops, each in the order of its triangles' edges. */
function openLoops(triangles: number[]): number[][] {
  const edges = new Set<string>()
  for (let t = 0; t < triangles.length; t += 3) for (let k = 0; k < 3; k++) edges.add(`${triangles[t + k]},${triangles[t + (k + 1) % 3]}`)
  const next = new Map<number, number>()
  for (const edge of edges) {
    const [a, b] = edge.split(',').map(Number)
    if (!edges.has(`${b},${a}`)) next.set(a, b)
  }
  const loops: number[][] = [], seen = new Set<number>()
  for (const start of next.keys()) {
    if (seen.has(start)) continue
    const loop: number[] = []
    for (let v: number | undefined = start; v !== undefined && !seen.has(v); v = next.get(v)) { seen.add(v); loop.push(v) }
    loops.push(loop)
  }
  return loops
}

/** Rigs the face of `object` as CachedRigLoader does on a miss, without the cache. Imports the rigging code only when called. */
export async function rigFace(object: THREE.Object3D, options: FaceOptions): Promise<FaceResult> {
  const { computeFace } = await import('../dist/face/rig/index.js')
  return applyFace(object, await computeFace(object, options))
}
