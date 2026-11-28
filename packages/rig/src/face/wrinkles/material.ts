/**
 * A face mesh is far too coarse for expression folds, so they are shading: grooves placed around the face's features in
 * rest-pose template space (so they stay on the face while it moves), deepened by the current morph weights, bending
 * the normal and darkening the groove.
 */

import * as THREE from 'three'
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu'
import { abs, atan, attribute, clamp, dFdx, dFdy, exp, float, fract, length, materialColor, materialNormal, modelScale, positionView, pow, select, sin, smoothstep, step, uniform, vec2 } from 'three/tsl'
import { CHEEK_MASS } from '../mass.js'
import { FACE_REST, type FaceData } from '../contract.js'

type F = Node<'float'>
const f = (x: number | F): F => (typeof x === 'number' ? float(x) : x)

/** A soft valley with slightly raised shoulders, like skin folding. */
const groove = (d: F, width: number | F) => {
  const x = d.mul(d).div(f(width).mul(width))
  return exp(x.negate()).sub(exp(x.mul(-0.2)).mul(0.25))
}
const band = (x: F, a: number | F, b: number | F, soft: number) => smoothstep(f(a).sub(soft), f(a).add(soft), x).mul(float(1).sub(smoothstep(f(b).sub(soft), f(b).add(soft), x)))

/**
 * Template meters per unit of `geometry`'s coordinates: its rest attribute and positions differ by a similarity, whose
 * scale is the ratio of their spreads about their centroids, so it holds wherever skinning baked the face.
 */
function templateScale(geometry: THREE.BufferGeometry): number {
  const spread = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const center = new THREE.Vector3(), v = new THREE.Vector3()
    for (let i = 0; i < attribute.count; i++) center.add(v.fromBufferAttribute(attribute, i))
    center.divideScalar(attribute.count)
    let sum = 0
    for (let i = 0; i < attribute.count; i++) sum += v.fromBufferAttribute(attribute, i).distanceToSquared(center)
    return sum
  }
  return Math.sqrt(spread(geometry.getAttribute(FACE_REST)) / spread(geometry.getAttribute('position')))
}

/** A node material carrying `source`'s appearance plus the wrinkles, driven by `mesh`'s morph weights. */
export function wrinkled(source: THREE.MeshStandardMaterial, face: FaceData, mesh: THREE.Mesh): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial().copy(source)
  // NodeMaterial.copy() skips accessor properties, and alphaTest is one
  material.alphaTest = source.alphaTest

  const weight = (name: string) => {
    const i = mesh.morphTargetDictionary?.[name]
    return i === undefined ? 0 : mesh.morphTargetInfluences?.[i] ?? 0
  }
  const clampWeight = (x: number) => Math.max(0, Math.min(1.5, x))
  /** A per-side uniform (x left, y right) recomputed from the morph weights before each draw. */
  const sided = (f: (side: 'Left' | 'Right') => number) => uniform(new THREE.Vector2()).onObjectUpdate((_, u) => u.value.set(clampWeight(f('Left')), clampWeight(f('Right'))))
  const single = (f: () => number) => uniform(0).onObjectUpdate(() => clampWeight(f()))
  const foreInner = single(() => weight('browInnerUp'))
  const foreOuter = sided((s) => weight(`browOuterUp${s}`))
  const glabella = sided((s) => weight(`browDown${s}`) + 0.25 * weight(`noseSneer${s}`))
  const bunny = sided((s) => 1.5 * weight(`noseSneer${s}`))
  const crow = sided((s) => 0.9 * weight(`cheekSquint${s}`) + 0.5 * weight(`mouthSmile${s}`) + 0.4 * weight(`eyeSquint${s}`))
  const underEye = sided((s) => 0.8 * weight(`cheekSquint${s}`) + 0.4 * weight(`mouthSmile${s}`) + 0.3 * weight(`eyeSquint${s}`))
  const fold = sided((s) => 0.7 * weight(`mouthSmile${s}`) + 0.8 * weight(`noseSneer${s}`) + 0.3 * weight(`mouthUpperUp${s}`) + 0.3 * weight(`cheekSquint${s}`))
  const cheekSwell = sided((s) => CHEEK_MASS.swell.mouthSmile * weight(`mouthSmile${s}`) + CHEEK_MASS.swell.cheekSquint * weight(`cheekSquint${s}`))
  const mentalis = single(() => weight('mouthShrugLower') + 0.2 * (weight('mouthFrownLeft') + weight('mouthFrownRight')) + 0.15 * (weight('mouthPressLeft') + weight('mouthPressRight')))

  const p = attribute(FACE_REST, 'vec3')
  const left = p.z.lessThan(0)
  const pick = (u: Node<'vec2'>) => select(left, u.x, u.y)
  const az = abs(p.z)
  const front = smoothstep(0.0334, 0.0479, p.x)

  // forehead: two horizontal lines between brows and hairline, curving up to the sides (frontalis)
  const foreheadY = p.y.sub(pow(az.div(0.03633), 2).mul(0.00327))
  const foreK = foreInner.mul(float(1).sub(smoothstep(0.01817, 0.03997, az))).add(pick(foreOuter).mul(smoothstep(0.00727, 0.02907, az)))
  const foreLines = groove(foreheadY.sub(face.browY + 0.00581), 0.00109).add(groove(foreheadY.sub(face.browY + 0.01054), 0.00109).mul(0.8))
  const hairCurve = pow(az.div(0.0545), 2).mul(0.00727)
  const foreMask = band(az, -1, 0.04723, 0.00727).mul(float(1).sub(smoothstep(hairCurve.add(face.hairlineY - 0.00454), hairCurve.add(face.hairlineY), p.y)))
  let depth: F = foreK.mul(foreLines).mul(foreMask).mul(0.00082)

  // glabella: vertical furrows converging downward (corrugator) and a line at the nasion (procerus)
  const g = pick(glabella)
  const furrowZ = p.y.sub(face.eyeY).mul(0.22).add(0.00581)
  const furrow = groove(az.sub(furrowZ), 0.00145).mul(band(p.y, face.eyeY + 0.00091, face.browY + 0.00454, 0.00273))
  const procerus = groove(p.y.sub(face.eyeY + 0.00036), 0.00127).mul(band(az, -1, 0.00818, 0.00273))
  depth = depth.add(g.mul(furrow).mul(0.00091)).add(g.mul(0.5).add(pick(bunny)).mul(procerus).mul(0.00073))

  // nose: oblique lines on the sides of the bridge (nasalis, sneer)
  const noseU = p.y.sub(face.bridgeY).add(az.sub(0.00908).mul(0.7))
  const noseLines = groove(noseU, 0.00127).add(groove(noseU.sub(0.00345), 0.00127).mul(0.7))
  const noseMask = band(az, 0.00327, 0.01726, 0.00273).mul(band(p.y, face.bridgeY - 0.00908, face.bridgeY + 0.00636, 0.00273))
  depth = depth.add(pick(bunny).mul(noseLines).mul(noseMask).mul(0.00091))

  // crow's feet: radial lines from the outer eye corner (orbicularis)
  const q = vec2(az.sub(face.eyeZ + face.eyeHalfWidth + 0.00109), p.y.sub(face.eyeY))
  const r = length(q), angle = atan(q.y, q.x)
  const offset = fract(angle.div(0.42).add(0.5)).sub(0.5).mul(0.42)
  const crowLines = groove(r.mul(sin(offset)), r.mul(0.08).add(0.00082))
  const crowMask = band(r, 0.00218, 0.00945, 0.00218).mul(band(angle, -0.7, 0.55, 0.2)).mul(step(0, q.x.add(0.00145)))
  depth = depth.add(pick(crow).mul(crowLines).mul(crowMask).mul(0.00064))

  // lower lid crease, pushed up by the cheek
  const lidT = az.sub(face.eyeZ).div(0.01544)
  depth = depth.add(pick(underEye).mul(groove(p.y.sub(lidT.mul(lidT).mul(0.00327).add(face.eyeY - 0.00818)), 0.00127)).mul(band(lidT, -0.9, 1, 0.25)).mul(0.00091))

  // nasolabial fold: from the nose wing down past the mouth corner (smile, sneer, upper lip raise)
  const fa = vec2(face.wingZ + 0.00327, face.wingY - 0.00327), fb = vec2(face.cornerZ + 0.0055 + 0.00636, face.cornerY + 0.0036 - 0.00818)
  const fab = fb.sub(fa), fp = vec2(az, p.y)
  const foldT = clamp(fp.sub(fa).dot(fab).div(fab.dot(fab)), 0, 1)
  const foldDistance = length(fp.sub(fa.add(fab.mul(foldT))))
  depth = depth.add(pick(fold).mul(groove(foldDistance, foldT.mul(0.00073).add(0.00145))).mul(band(foldT, 0.02, 1, 0.08)).mul(float(1).sub(foldT.mul(0.4))).mul(0.00127))

  // labiomental crease under a pushed-up lower lip (mentalis)
  depth = depth.add(mentalis.mul(groove(p.y.sub(face.labiomentalY), 0.00109)).mul(band(az, -1, 0.0218, 0.00545)).mul(0.00091)).mul(front)

  // the bunched cheek mass, as height for its round shading
  const C = face.cheek
  const cdz = az.sub(C.z).div(CHEEK_MASS.size.wide)
  const cdy = p.y.sub(C.y).div(select(p.y.greaterThan(C.y), float(CHEEK_MASS.size.up), float(CHEEK_MASS.size.down)))
  const [az0, ay0, az1, ay1] = C.fold
  const besideFold = p.y.sub(ay0).mul(az1 - az0).sub(az.sub(az0).mul(ay1 - ay0)).div(Math.hypot(az1 - az0, ay1 - ay0))
  const { crisp, soften } = CHEEK_MASS.edge
  const soft = smoothstep(ay0 - CHEEK_MASS.edge.below, ay0 + CHEEK_MASS.edge.above, p.y)
  const mass = float(1).sub(smoothstep(0.3, 1, length(vec2(cdz, cdy)))).mul(smoothstep(soft.mul(soften[0]).add(crisp[0]), soft.mul(soften[1]).add(crisp[1]), besideFold)).mul(step(CHEEK_MASS.edge.midline, az))
  const cheekHeight = mass.mul(pick(cheekSwell)).mul(front).mul(0.00273)

  // surface-gradient bump (Mikkelsen) from screen-space derivatives of the height, in world units
  const height = cheekHeight.sub(depth.mul(1.6)).mul(modelScale.x).div(templateScale(mesh.geometry))
  const base = materialNormal
  const dpx = dFdx(positionView), dpy = dFdy(positionView)
  const r1 = dpy.cross(base), r2 = base.cross(dpx)
  const det = dpx.dot(r1)
  const gradient = r1.mul(dFdx(height)).add(r2.mul(dFdy(height))).mul(det.sign())
  material.normalNode = abs(det).mul(base).sub(gradient).normalize()
  material.colorNode = materialColor.mul(float(1).sub(clamp(depth.div(0.00291), -0.08, 0.35)))
  return material
}
