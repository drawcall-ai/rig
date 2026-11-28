/** Rigs a head for speech and expression from landmarks placed on its skin: the computation a face cache miss loads, kept under face/rig/ so a hit loads none of it. */

import * as THREE from 'three'
import { FACE_BONES, FACE_REST, type FaceData, type FaceOptions } from '../contract.js'
import type { FaceEdit } from '../edit.js'
import { anatomy, type Anatomy } from './anatomy.js'
import { bakeFace, bakeRigid } from './bake.js'
import { cutEye, placeEye } from './eyes.js'
import { similarity } from './fit.js'
import { checkLandmarks, FITTED, templateLandmarks } from './landmarks.js'
import { cutMouth } from './mouth.js'
import { addTongueShapes, eyeball, mouthParts } from './parts.js'
import { faceShapes } from './shapes.js'
import { normals, restTissue } from './tissue.js'
import { Surface } from './surface.js'
import { template } from './template.js'
import { paintOverEyes } from './paint.js'
import { dropStill, movedVertices, subset } from './split.js'
import { transfer } from './transfer.js'

/**
 * What rigging the face of `object` changes, leaving it unchanged: the edit FaceEdit describes, from landmarks in world
 * space, as skeleton joints are given.
 */
export async function computeFace(object: THREE.Object3D, { landmarks, head }: FaceOptions): Promise<FaceEdit> {
  checkLandmarks(landmarks)
  const t = await template()
  object.updateWorldMatrix(true, true)
  const meshes: THREE.Mesh[] = []
  object.traverse((node) => { if (node instanceof THREE.Mesh) meshes.push(node) })
  // landmarks and the returned bones are in world space, as skeleton joints are; the edit is in the object's coordinates
  const mesh = faceMesh(meshes, new THREE.Vector3(...landmarks.noseTip))
  if (mesh.geometry.morphAttributes.position?.length) throw new Error(`face: mesh "${mesh.name}" already has morph targets`)
  const reference = templateLandmarks(t)
  const world = FITTED.map((name) => new THREE.Vector3(...landmarks[name]))
  // the jaw's depth varies most between stylized faces, so it would tilt the fit; the warp still matches it
  const fit = FITTED.flatMap((name, i) => (name.startsWith('jaw') ? [] : [i]))
  const worldToTemplate = similarity(fit.map((i) => world[i]), fit.map((i) => reference[i]))
  const templateToWorld = worldToTemplate.clone().invert()
  const modelToTemplate = worldToTemplate.clone().multiply(object.matrixWorld)
  const scale = Math.cbrt(modelToTemplate.determinant())
  const meshToModel = new THREE.Matrix4().copy(object.matrixWorld).invert().multiply(mesh.matrixWorld)
  const meshToTemplate = modelToTemplate.clone().multiply(meshToModel)
  const templateToMesh = meshToTemplate.clone().invert()
  const templateToModel = modelToTemplate.clone().invert()
  const a = anatomy(landmarks, worldToTemplate)

  const surface = new Surface(mesh.geometry, meshToTemplate)
  const materials = [mesh.material].flat()
  // while cutting, cavity and socket triangles carry the material index after the face's own
  const cavity = materials.length
  const mouth = cutMouth(surface, a, cavity)
  for (const eye of a.eyes) placeEye(surface, eye)
  // the face's material is the one over the eyes, which the eye cut keeps in place
  const material = surface.materialAt(a.eyes[0].y, a.eyes[0].z)
  const faceMaterial = materials[material]
  if (!faceMaterial) throw new Error(`face: mesh "${mesh.name}" has no material ${material} over the eyes`)
  const { irises, paint } = paintOverEyes(surface, a.eyes, faceMaterial)
  const rims = a.eyes.map((eye) => cutEye(surface, eye, cavity))
  const tissue = restTissue(surface, a, mouth, rims)
  const restNormals = normals(tissue, tissue.rest)
  const shapes = faceShapes(tissue, transfer(t, tissue), tissue.rest, restNormals)

  const geometry = surface.geometry(templateToMesh)
  bakeFace(geometry, shapes, tissue, restNormals, templateToMesh)
  const moved = movedVertices(geometry)
  const touches = (triangle: number[]) => triangle.some((v) => moved[v])
  const own = (g: THREE.BufferGeometry) => {
    // a single material draws the whole geometry, which groups would split
    if (!Array.isArray(mesh.material)) g.clearGroups()
    return g
  }
  const still = own(subset(geometry, (m, triangle) => m !== cavity && !touches(triangle)))
  geometry.setAttribute(FACE_REST, new THREE.BufferAttribute(tissue.rest, 3))
  const moving = own(subset(geometry, (m, triangle) => m !== cavity && touches(triangle)))
  geometry.deleteAttribute(FACE_REST)
  const interior = subset(geometry, (m) => m === cavity)
  interior.clearGroups()

  const parts = mouthParts(a)
  for (const g of [parts.upperTeeth, parts.lowerTeeth, parts.tongue]) g.applyMatrix4(templateToModel)
  // only the shapes that move the jaw move what it carries
  const jawShapes = Object.entries(shapes).flatMap(([name, shape]): [string, THREE.Matrix4][] => (shape.jaw.equals(IDENTITY) ? [] : [[name, templateToModel.clone().multiply(shape.jaw).multiply(modelToTemplate)]]))
  bakeRigid(parts.lowerTeeth, jawShapes)
  bakeRigid(parts.tongue, jawShapes)
  addTongueShapes(parts.tongue, parts.tongueCenter.applyMatrix4(templateToModel), parts.tongueLength / scale, templateToModel)
  for (const g of [parts.lowerTeeth, parts.tongue]) dropStill(g)
  const baked = [...new Set([moving, interior, parts.lowerTeeth, parts.tongue].flatMap((g) => (g.morphAttributes.position ?? []).map((target) => target.name)))]
  moving.userData.face = faceData(a, baked)

  const position = (p: THREE.Vector3) => p.clone().applyMatrix4(templateToWorld).toArray()
  // FACE_BONES' eye frame: +Z forward, +Y up, +X the face's left, which in template space is a quarter turn about y
  const eye = new THREE.Quaternion()
  templateToWorld.decompose(new THREE.Vector3(), eye, new THREE.Vector3())
  const eyeRotation = eye.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)).toArray()
  return {
    mesh: meshes.indexOf(mesh),
    material,
    paint,
    still,
    moving,
    cavity: interior,
    eyes: a.eyes.map((eye, i) => {
      const ball = eyeball(eye.radius)
      ball.translate(eye.center.x, eye.center.y, eye.center.z)
      ball.applyMatrix4(templateToModel)
      // iris and pupil keep a human size whatever the ball radius
      return { geometry: ball, iris: irises[i], irisRadius: 0.00738 / eye.radius, pupilRadius: 0.00283 / eye.radius }
    }),
    upperTeeth: parts.upperTeeth,
    lowerTeeth: parts.lowerTeeth,
    tongue: parts.tongue,
    bones: [
      { name: FACE_BONES.leftEye, parent: head, position: position(a.eyes[0].center), rotation: eyeRotation },
      { name: FACE_BONES.rightEye, parent: head, position: position(a.eyes[1].center), rotation: eyeRotation },
      { name: FACE_BONES.teeth, parent: head, position: position(a.mouth.center) },
    ],
    shapes: baked,
    deviation: Object.fromEntries(FITTED.map((name, i) => [name, Math.round(world[i].clone().applyMatrix4(worldToTemplate).distanceTo(reference[i]) * 1000)])),
  }
}

const IDENTITY = new THREE.Matrix4()

/** The mesh with a vertex nearest the nose tip, in world space. */
function faceMesh(meshes: THREE.Mesh[], noseTip: THREE.Vector3): THREE.Mesh {
  let best: THREE.Mesh | undefined, bestDistance = Infinity
  const v = new THREE.Vector3()
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      const d = v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).distanceToSquared(noseTip)
      if (d < bestDistance) { bestDistance = d; best = mesh }
    }
  }
  if (!best) throw new Error('face: no mesh in the object')
  return best
}

function faceData(a: Anatomy, shapes: string[]): FaceData {
  const inner = a.mirrored('eyeInner'), outer = a.mirrored('eyeOuter'), wing = a.mirrored('noseWing'), corner = a.mirrored('mouthCorner')
  return {
    eyeY: a.eyeY, eyeZ: (inner.z + outer.z) / 2, eyeHalfWidth: (outer.z - inner.z) / 2,
    browY: a.mirrored('browInner').y, hairlineY: a.point('hairline').y, bridgeY: a.point('noseBridge').y,
    wingY: wing.y, wingZ: wing.z, cornerY: corner.y, cornerZ: corner.z,
    labiomentalY: a.point('lowerLip').y - 0.0037,
    cheek: a.cheek,
    shapes,
  }
}
