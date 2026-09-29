/**
 * Skins a GLB entirely in the browser and shows the result with three.js: the
 * skeleton as lines plus joint markers, and a gallop when the skeleton is the
 * example horse's. Without the gallop, "Bend every joint" rotates all
 * non-root joints about x to eyeball the weights.
 *
 * URL parameters (for screenshots):
 *   model=<url>   skin this GLB instead of the horse
 *   skinned=<url> view an already-skinned GLB as is
 *   t=<seconds>   freeze the gallop at this time
 *   view=side|front|top|quarter   camera direction (default side)
 *   xray=1        see-through mesh
 *   bend=<deg>    preset the bend slider (stops the gallop)
 *   skeleton=<url>   skin with this skeleton JSON instead of the example's
 *   animation=<url>  play this keyframe JSON (see keyframes.ts) instead of the gallop
 */

import { WebIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { skin, type Skeleton } from '@drawcall/skinning'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { gallop } from './gallop.js'
import { keyframeClip, type KeyframeAnimation } from './keyframes.js'
import horseUrl from '../../node/horse.glb?url'
import horseSkeleton from '../../node/horse.skeleton.json'

const io = new WebIO().registerExtensions(ALL_EXTENSIONS)
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const skeletonInput = element<HTMLTextAreaElement>('skeleton')
const bendInput = element<HTMLInputElement>('bend')
const animateInput = element<HTMLInputElement>('animate')
const xrayInput = element<HTMLInputElement>('xray')
const reportOutput = element<HTMLPreElement>('report')
const view = element<HTMLElement>('view')

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(devicePixelRatio)
view.append(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x2a2d31)
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.5))
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1e5)
const controls = new OrbitControls(camera, renderer.domElement)

const params = new URLSearchParams(location.search)
const frozenTime = params.has('t') ? Number(params.get('t')) : undefined
const VIEWS: Record<string, [number, number, number]> = {
  side: [1.3, 0.2, 0],
  front: [0, 0.2, 1.3],
  top: [0.01, 1.4, 0],
  quarter: [0.95, 0.45, 0.95],
}
const viewDirection = VIEWS[params.get('view') ?? 'side'] ?? VIEWS.side

let model = new THREE.Group()
let bones: THREE.Bone[] = []
let mixer: THREE.AnimationMixer | undefined
let modelBytes = new Uint8Array(await (await fetch(params.get('model') ?? horseUrl)).arrayBuffer())
const fetchJson = async (url: string): Promise<unknown> => (await fetch(url)).json()
const skeletonUrl = params.get('skeleton')
const animationUrl = params.get('animation')
const animation = animationUrl ? ((await fetchJson(animationUrl)) as KeyframeAnimation) : undefined
skeletonInput.value = JSON.stringify(skeletonUrl ? await fetchJson(skeletonUrl) : horseSkeleton, null, 2)

async function show(glb: Uint8Array): Promise<void> {
  const gltf = await new GLTFLoader().parseAsync(glb.slice().buffer, '')
  scene.remove(model)
  model = new THREE.Group().add(gltf.scene)
  model.add(new THREE.SkeletonHelper(gltf.scene))
  scene.add(model)
  const box = new THREE.Box3().setFromObject(gltf.scene)
  const size = box.getSize(new THREE.Vector3()).length()
  const center = box.getCenter(new THREE.Vector3())

  // Joint markers, drawn on top of the mesh like the skeleton lines
  const marker = new THREE.SphereGeometry(size * 0.006)
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false })
  bones = []
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Bone)) return
    const sphere = new THREE.Mesh(marker, markerMaterial)
    sphere.renderOrder = 1
    object.add(sphere)
    if (object.parent instanceof THREE.Bone) bones.push(object)
  })
  gltf.scene.traverse((object) => object instanceof THREE.SkinnedMesh && object.material instanceof THREE.Material && (object.material.userData.skinned = true))
  xray()

  const clip = animation ? keyframeClip(gltf.scene, animation) : gallop(gltf.scene)
  mixer = clip ? new THREE.AnimationMixer(gltf.scene) : undefined
  if (clip && mixer) mixer.clipAction(clip).play()
  animateInput.disabled = !clip
  animate()

  camera.position.copy(center).add(new THREE.Vector3(...viewDirection).multiplyScalar(size))
  controls.target.copy(center)
  controls.update()
}

function animate(): void {
  const playing = mixer !== undefined && animateInput.checked
  bendInput.disabled = playing
  if (playing) return
  mixer?.setTime(0)
  const angle = THREE.MathUtils.degToRad(Number(bendInput.value))
  for (const bone of bones) bone.rotation.set(angle, 0, 0)
}

function xray(): void {
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.material.userData.skinned) return
    object.material.transparent = xrayInput.checked
    object.material.opacity = xrayInput.checked ? 0.35 : 1
    object.material.depthWrite = !xrayInput.checked
  })
}

async function skinModel(): Promise<void> {
  const document = await io.readBinary(modelBytes)
  const start = performance.now()
  const report = skin(document, JSON.parse(skeletonInput.value) as Skeleton)
  const ms = performance.now() - start
  reportOutput.textContent =
    `${report.vertices} vertices skinned in ${ms.toFixed(0)} ms\n\n` +
    report.bones.map((bone) => `${bone.name}: ${bone.vertices} vertices`).join('\n') +
    (report.warnings.length ? `\n\n${report.warnings.map((w) => `warning: ${w}`).join('\n')}` : '')
  await show(await io.writeBinary(document))
}

element<HTMLInputElement>('file').addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) modelBytes = new Uint8Array(await file.arrayBuffer())
})
element<HTMLButtonElement>('skin').addEventListener('click', () =>
  skinModel().catch((error: Error) => (reportOutput.textContent = `error: ${error.message}`)),
)
bendInput.addEventListener('input', animate)
animateInput.addEventListener('change', animate)
xrayInput.addEventListener('change', xray)

function resize(): void {
  renderer.setSize(view.clientWidth, view.clientHeight)
  camera.aspect = view.clientWidth / view.clientHeight
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()
const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta()
  if (mixer && animateInput.checked) {
    if (frozenTime === undefined) mixer.update(dt)
    else mixer.setTime(frozenTime)
  }
  renderer.render(scene, camera)
})

bendInput.value = params.get('bend') ?? '0'
if (params.has('bend')) animateInput.checked = false
xrayInput.checked = params.get('xray') === '1'
const skinnedUrl = params.get('skinned')
if (skinnedUrl) await show(new Uint8Array(await (await fetch(skinnedUrl)).arrayBuffer()))
else await skinModel()
document.body.dataset.ready = 'true'
