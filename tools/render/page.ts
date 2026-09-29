/**
 * Render page driven by tools/render.ts: shows a GLB (skinned or not), its
 * skeleton, a pose or keyframe clip, and on axis views an orthographic camera
 * with a world-coordinate grid, so positions can be read off the image.
 * Shots can be returned one by one or tiled into one labeled contact sheet.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { keyframeClip, type KeyframeAnimation } from '../../examples/browser/src/keyframes.js'

export interface Shot {
  /** '+x' = camera on the +x side looking toward -x; also -x, +y, -y, +z, -z, or 'persp' (3/4 view). */
  view: string
  /** Time in the keyframe clip, seconds. */
  t?: number
  /** Static pose: bone -> [x, y, z] Euler XYZ degrees relative to the bind pose (overrides the clip). */
  pose?: Record<string, [number, number, number]>
  xray?: boolean
  labels?: boolean
  /** Draw the skeleton (default true). */
  bones?: boolean
  /** Color vertices by their weight on this bone: blue 0 -> red 1. */
  weights?: string
  /** Caption drawn in the corner (used on contact sheets). */
  title?: string
  /** Zoom: frame this world-space sphere instead of the whole model. */
  focus?: { center: [number, number, number]; radius: number }
}

const params = new URLSearchParams(location.search)
const SIZE = Number(params.get('size') ?? 900)
const view = document.getElementById('view') as HTMLElement
view.style.width = view.style.height = `${SIZE}px`

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setSize(SIZE, SIZE)
const labels = document.createElement('canvas')
labels.width = labels.height = SIZE
labels.style.position = 'absolute'
labels.style.inset = '0'
view.append(renderer.domElement, labels)
const ink = labels.getContext('2d') as CanvasRenderingContext2D

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x2a2d31)
scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2.2), new THREE.DirectionalLight(0xffffff, 1.2))

const gltf = await new GLTFLoader().loadAsync(params.get('model') as string)
const root = gltf.scene
scene.add(root)
const animationUrl = params.get('animation')
const mixer = new THREE.AnimationMixer(root)
if (animationUrl) {
  const animation = (await (await fetch(animationUrl)).json()) as KeyframeAnimation
  // Play once and hold the last frame, so t = duration shows the final key instead of wrapping to 0
  const action = mixer.clipAction(keyframeClip(root, animation))
  action.setLoop(THREE.LoopOnce, 1)
  action.clampWhenFinished = true
  action.play()
}

const box = new THREE.Box3().setFromObject(root)
const modelCenter = box.getCenter(new THREE.Vector3())
const extent = box.getSize(new THREE.Vector3())
const radius = extent.length() / 2

const bones: THREE.Bone[] = []
root.traverse((object) => object instanceof THREE.Bone && bones.push(object))
const byName = new Map(bones.map((bone) => [bone.name, bone]))
const helper = new THREE.SkeletonHelper(root)
scene.add(helper)
// Markers live in world space (not under the bones) so scaled source armatures can't inflate them
const marker = new THREE.SphereGeometry(1)
const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false })
const markers = bones.map(() => {
  const sphere = new THREE.Mesh(marker, markerMaterial)
  sphere.renderOrder = 2
  scene.add(sphere)
  return sphere
})

const meshes: THREE.Mesh[] = []
root.traverse((object) => object instanceof THREE.Mesh && !markers.includes(object) && meshes.push(object))
const originalMaterial = new Map(meshes.map((mesh) => [mesh, mesh.material]))
const materials = meshes.flatMap((mesh) => [mesh.material].flat())
const heat = new THREE.MeshBasicMaterial({ vertexColors: true })

const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -radius * 10, radius * 10)
const persp = new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 100)
let grid: THREE.LineSegments | undefined

function shoot(shot: Shot): void {
  mixer.setTime(shot.t ?? 0)
  if (shot.pose) {
    for (const bone of bones) bone.quaternion.identity()
    for (const [name, [x, y, z]] of Object.entries(shot.pose)) {
      const bone = byName.get(name)
      if (!bone) throw new Error(`pose names unknown bone "${name}"`)
      bone.rotation.set(THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z))
    }
  }
  root.updateMatrixWorld(true)
  paintWeights(shot.weights)
  for (const material of materials) {
    material.transparent = !!shot.xray
    material.opacity = shot.xray ? 0.3 : 1
    material.depthWrite = !shot.xray
  }
  const showBones = shot.bones !== false
  helper.visible = showBones
  const center = shot.focus ? new THREE.Vector3(...shot.focus.center) : modelCenter
  const markerSize = (shot.focus ? shot.focus.radius : radius) * 0.012
  markers.forEach((m, i) => {
    m.visible = showBones
    bones[i].getWorldPosition(m.position)
    m.scale.setScalar(markerSize)
  })
  ink.clearRect(0, 0, SIZE, SIZE)
  if (grid) scene.remove(grid)

  let camera: THREE.Camera
  if (shot.view === 'persp') {
    persp.position.copy(center).add(new THREE.Vector3(1, 0.6, 1).normalize().multiplyScalar((shot.focus?.radius ?? radius) * 3))
    persp.lookAt(center)
    persp.updateMatrixWorld()
    camera = persp
  } else {
    const match = /^([+-])([xyz])$/.exec(shot.view)
    if (!match) throw new Error(`unknown view "${shot.view}"`)
    const axis = 'xyz'.indexOf(match[2])
    const dir = new THREE.Vector3().setComponent(axis, match[1] === '+' ? 1 : -1)
    ortho.up.set(0, axis === 1 ? 0 : 1, axis === 1 ? -dir.y : 0)
    ortho.position.copy(center).addScaledVector(dir, radius * 2)
    ortho.lookAt(center)
    // Fit the model's extent across the two screen axes (or the focus sphere), with a small margin
    const across = [0, 1, 2].filter((a) => a !== axis).map((a) => extent.getComponent(a))
    const half = shot.focus ? shot.focus.radius : (Math.max(...across) / 2) * 1.12
    Object.assign(ortho, { left: -half, right: half, top: half, bottom: -half })
    ortho.updateProjectionMatrix()
    ortho.updateMatrixWorld()
    camera = ortho
    drawGrid(ortho, half, center)
  }
  renderer.render(scene, camera)
  if (shot.labels && showBones) {
    for (const bone of bones) label(bone.getWorldPosition(new THREE.Vector3()), bone.name, '#ffd23f', camera, [6, 4])
  }
  if (shot.title) {
    ink.font = 'bold 22px ui-monospace, monospace'
    ink.fillStyle = '#ffffff'
    ink.fillText(shot.title, 12, 30)
  }
}

/** Per-vertex colors for one bone's weights, or the original materials when bone is undefined. */
function paintWeights(bone: string | undefined): void {
  for (const mesh of meshes) {
    if (!bone || !(mesh instanceof THREE.SkinnedMesh)) {
      mesh.material = originalMaterial.get(mesh) as THREE.Material
      continue
    }
    const index = mesh.skeleton.bones.findIndex((b) => b.name === bone)
    if (index < 0) throw new Error(`no bone named "${bone}"`)
    const ids = mesh.geometry.getAttribute('skinIndex')
    const ws = mesh.geometry.getAttribute('skinWeight')
    const colors = new Float32Array(ids.count * 3)
    const color = new THREE.Color()
    for (let v = 0; v < ids.count; v++) {
      let w = 0
      for (let k = 0; k < 4; k++) if (ids.getComponent(v, k) === index) w += ws.getComponent(v, k)
      color.setHSL(0.66 * (1 - w), 0.9, w > 0 ? 0.5 : 0.18)
      colors.set([color.r, color.g, color.b], v * 3)
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    mesh.material = heat
  }
}

/** Grid lines behind the model at round world coordinates, labeled on the image edges. */
function drawGrid(camera: THREE.OrthographicCamera, half: number, center: THREE.Vector3): void {
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
  const dominant = (v: THREE.Vector3) => [0, 1, 2].reduce((best, a) => (Math.abs(v.getComponent(a)) > Math.abs(v.getComponent(best)) ? a : best), 0)
  const h = dominant(right)
  const v = dominant(up)
  const step = niceStep((half * 2) / 16)
  const behind = center.clone().addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2), -radius * 1.5)
  const points: THREE.Vector3[] = []
  const lo = (a: number) => Math.ceil((center.getComponent(a) - half) / step) * step
  const at = (hv: number, vv: number) => behind.clone().setComponent(h, hv).setComponent(v, vv)
  for (let x = lo(h); x <= center.getComponent(h) + half; x += step) {
    points.push(at(x, center.getComponent(v) - half), at(x, center.getComponent(v) + half))
    label(at(x, center.getComponent(v) - half), `${'xyz'[h]}=${round(x, step)}`, '#9aa4b1', camera, [2, -6])
  }
  for (let y = lo(v); y <= center.getComponent(v) + half; y += step) {
    points.push(at(center.getComponent(h) - half, y), at(center.getComponent(h) + half, y))
    label(at(center.getComponent(h) - half, y), `${'xyz'[v]}=${round(y, step)}`, '#9aa4b1', camera, [4, -4])
  }
  grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x4a5058 }))
  scene.add(grid)
}

function label(world: THREE.Vector3, text: string, color: string, camera: THREE.Camera, offset: [number, number]): void {
  const p = world.clone().project(camera)
  ink.font = '13px ui-monospace, monospace'
  const x = Math.min(SIZE - ink.measureText(text).width - 2, Math.max(2, ((p.x + 1) / 2) * SIZE + offset[0]))
  const y = Math.min(SIZE - 4, Math.max(14, ((1 - p.y) / 2) * SIZE + offset[1]))
  ink.lineWidth = 3
  ink.strokeStyle = '#000000'
  ink.strokeText(text, x, y)
  ink.fillStyle = color
  ink.fillText(text, x, y)
}

/** Renders one shot and returns it with labels as a PNG data URL. */
function grab(shot: Shot): string {
  shoot(shot)
  return compose().toDataURL('image/png')
}

/** Renders every shot and tiles them into one image, `cols` per row, each cell `cell` px. */
function sheet(shots: Shot[], cols: number, cell: number): string {
  const out = document.createElement('canvas')
  out.width = cols * cell
  out.height = Math.ceil(shots.length / cols) * cell
  const ctx = out.getContext('2d') as CanvasRenderingContext2D
  ctx.fillStyle = '#2a2d31'
  ctx.fillRect(0, 0, out.width, out.height)
  shots.forEach((shot, i) => {
    shoot(shot)
    ctx.drawImage(compose(), (i % cols) * cell, Math.floor(i / cols) * cell, cell, cell)
  })
  return out.toDataURL('image/png')
}

function compose(): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = out.height = SIZE
  const ctx = out.getContext('2d') as CanvasRenderingContext2D
  ctx.drawImage(renderer.domElement, 0, 0, SIZE, SIZE)
  ctx.drawImage(labels, 0, 0)
  return out
}

function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw
}
const round = (n: number, step: number): string => n.toFixed(Math.max(0, -Math.floor(Math.log10(step))))

/** Bind-pose joints (world positions, first child, parent) for range-of-motion shots. */
function joints(): { name: string; position: number[]; child?: string; parent?: string }[] {
  root.updateMatrixWorld(true)
  return bones.map((bone) => ({
    name: bone.name,
    position: bone.getWorldPosition(new THREE.Vector3()).toArray(),
    child: bone.children.find((c) => c instanceof THREE.Bone)?.name,
    parent: bone.parent instanceof THREE.Bone ? bone.parent.name : undefined,
  }))
}

Object.assign(window, { grab, sheet, joints })
document.body.dataset.ready = 'true'
