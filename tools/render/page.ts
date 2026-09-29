/**
 * Render page driven by tools/render.ts: shows a GLB (skinned or not), its
 * skeleton, an optional keyframe pose, and on axis views an orthographic
 * camera with a world-coordinate grid, so positions can be read off the image.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { keyframeClip, type KeyframeAnimation } from '../../examples/browser/src/keyframes.js'

export interface Shot {
  /** '+x' = camera on the +x side looking toward -x; also -x, +y, -y, +z, -z, or 'persp' (3/4 view). */
  view: string
  t: number
  xray: boolean
  labels: boolean
  /** Draw the skeleton (default true). */
  bones?: boolean
  /** Color vertices by their weight on this bone: blue 0 -> red 1. */
  weights?: string
}

const SIZE = Number(new URLSearchParams(location.search).get('size') ?? 900)
const params = new URLSearchParams(location.search)
const view = document.getElementById('view') as HTMLElement
const overlay = document.getElementById('overlay') as HTMLElement
view.style.width = view.style.height = `${SIZE}px`

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setSize(SIZE, SIZE)
view.prepend(renderer.domElement)
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
const center = box.getCenter(new THREE.Vector3())
const extent = box.getSize(new THREE.Vector3())
const radius = extent.length() / 2

const bones: THREE.Bone[] = []
root.traverse((object) => object instanceof THREE.Bone && bones.push(object))
const helper = new THREE.SkeletonHelper(root)
;(helper.material as THREE.LineBasicMaterial).linewidth = 2
scene.add(helper)
const marker = new THREE.SphereGeometry(radius * 0.008)
const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false })
for (const bone of bones) {
  const sphere = new THREE.Mesh(marker, markerMaterial)
  sphere.renderOrder = 2
  bone.add(sphere)
}
const materials: THREE.Material[] = []
const meshes: THREE.Mesh[] = []
root.traverse((object) => {
  if (!(object instanceof THREE.Mesh) || object.parent instanceof THREE.Bone) return
  meshes.push(object)
  materials.push(...[object.material].flat())
})
const originalMaterial = new Map(meshes.map((mesh) => [mesh, mesh.material]))
const heat = new THREE.MeshBasicMaterial({ vertexColors: true })

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

const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -radius * 10, radius * 10)
const persp = new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 100)
let grid: THREE.LineSegments | undefined

function shoot(shot: Shot): void {
  mixer.setTime(shot.t)
  root.updateMatrixWorld(true)
  paintWeights(shot.weights)
  helper.visible = shot.bones !== false
  for (const bone of bones) bone.children.forEach((child) => child instanceof THREE.Mesh && (child.visible = shot.bones !== false))
  for (const material of materials) {
    material.transparent = shot.xray
    material.opacity = shot.xray ? 0.3 : 1
    material.depthWrite = !shot.xray
  }
  overlay.replaceChildren()
  if (grid) scene.remove(grid)

  let camera: THREE.Camera
  if (shot.view === 'persp') {
    persp.position.copy(center).add(new THREE.Vector3(1, 0.6, 1).normalize().multiplyScalar(radius * 3.4))
    persp.lookAt(center)
    camera = persp
  } else {
    const match = /^([+-])([xyz])$/.exec(shot.view)
    if (!match) throw new Error(`unknown view "${shot.view}"`)
    const axis = 'xyz'.indexOf(match[2])
    const dir = new THREE.Vector3().setComponent(axis, match[1] === '+' ? 1 : -1)
    ortho.up.set(0, axis === 1 ? 0 : 1, axis === 1 ? -dir.y : 0)
    ortho.position.copy(center).addScaledVector(dir, radius * 2)
    ortho.lookAt(center)
    const half = radius * 1.08
    Object.assign(ortho, { left: -half, right: half, top: half, bottom: -half })
    ortho.updateProjectionMatrix()
    ortho.updateMatrixWorld()
    camera = ortho
    drawGrid(ortho, half)
  }
  camera.updateMatrixWorld()
  renderer.render(scene, camera)
  if (shot.labels && shot.bones !== false) {
    for (const bone of bones) label(bone.getWorldPosition(new THREE.Vector3()), bone.name, 'bone', camera)
  }
}

/** Grid lines behind the model at round world coordinates, labeled on the image edges. */
function drawGrid(camera: THREE.OrthographicCamera, half: number): void {
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
    label(at(x, center.getComponent(v) - half), `${'xyz'[h]}=${round(x, step)}`, 'axis', camera, [0, -16])
  }
  for (let y = lo(v); y <= center.getComponent(v) + half; y += step) {
    points.push(at(center.getComponent(h) - half, y), at(center.getComponent(h) + half, y))
    label(at(center.getComponent(h) - half, y), `${'xyz'[v]}=${round(y, step)}`, 'axis', camera, [4, -7])
  }
  grid = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0x4a5058 }),
  )
  scene.add(grid)
}

function label(world: THREE.Vector3, text: string, kind: string, camera: THREE.Camera, offset = [0, 0]): void {
  const p = world.clone().project(camera)
  const span = document.createElement('span')
  span.className = kind
  span.textContent = text
  span.style.left = `${Math.min(SIZE - 60, Math.max(0, ((p.x + 1) / 2) * SIZE + offset[0]))}px`
  span.style.top = `${Math.min(SIZE - 14, Math.max(0, ((1 - p.y) / 2) * SIZE + offset[1]))}px`
  overlay.append(span)
}

function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw
}
const round = (n: number, step: number): string => n.toFixed(Math.max(0, -Math.floor(Math.log10(step))))

Object.assign(window, { shoot })
document.body.dataset.ready = 'true'
