/**
 * Rigs made by AI agents with @drawcall/rig, one tab per creature. Each tab loads the original
 * model, rebuilds the agent's skeleton from world-space joints, skins it right here in the browser
 * and plays a fitting motion.
 *
 * URL parameters (for screenshots): tab=<name>, t=<seconds> (freeze the motion), xray=1, bones=0
 */

import { bone, skin } from '@drawcall/rig/three'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { gallop } from './gallop.js'
import { flap, swim, walk, type Motion } from './motions.js'
import horseUrl from '../../node/horse.glb?url'
import horse from '../../node/horse.skeleton.json'
import fish from './rigs/fish.json'
import fox from './rigs/fox.json'
import parrot from './rigs/parrot.json'
import robot from './rigs/robot.json'
import soldier from './rigs/soldier.json'
import stork from './rigs/stork.json'

interface Joint {
  name: string
  parent?: string
  position: number[]
  tail?: number[]
  pieces?: number[]
}

interface Tab {
  name: string
  url: string
  joints: Joint[]
  /** Builds the looping motion once the rig is bound. */
  motion: (bones: Map<string, THREE.Bone>, root: THREE.Object3D) => Motion
}

const THREEJS = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf'
const forward = (x: number, z: number) => new THREE.Vector3(x, 0, z)
const tabs: Tab[] = [
  { name: 'Horse', url: horseUrl, joints: horse.bones, motion: (_, root) => clipMotion(root, gallop(root)) },
  { name: 'Parrot', url: `${THREEJS}/Parrot.glb`, joints: parrot.bones, motion: (b) => flap(b, forward(0, 1)) },
  { name: 'Stork', url: `${THREEJS}/Stork.glb`, joints: stork.bones, motion: (b) => flap(b, forward(0, 1)) },
  {
    name: 'Fish',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/BarramundiFish/glTF-Binary/BarramundiFish.glb',
    joints: fish.bones,
    motion: (b) => swim(b),
  },
  { name: 'Soldier', url: `${THREEJS}/Soldier.glb`, joints: soldier.bones, motion: (b) => walk(b, forward(0, -1)) },
  { name: 'Robot', url: `${THREEJS}/RobotExpressive/RobotExpressive.glb`, joints: robot.bones, motion: (b) => walk(b, forward(0, 1)) },
  // Your own model, only when examples/browser/public/model.glb exists
  { name: 'Fox', url: '/model.glb', joints: fox.bones, motion: (b) => walk(b, forward(1, 0)) },
]

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const view = element<HTMLElement>('view')
const status = element<HTMLElement>('status')
const play = element<HTMLInputElement>('play')
const showBones = element<HTMLInputElement>('bones')
const xray = element<HTMLInputElement>('xray')
const params = new URLSearchParams(location.search)
const frozen = params.has('t') ? Number(params.get('t')) : undefined
xray.checked = params.get('xray') === '1'
showBones.checked = params.get('bones') !== '0'

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(devicePixelRatio)
view.append(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x2a2d31)
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.5), new THREE.DirectionalLight(0xffffff, 1))
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1e5)
const controls = new OrbitControls(camera, renderer.domElement)

let current: { model: THREE.Object3D; helper: THREE.SkeletonHelper; motion: Motion } | undefined
let loading = 0

async function open(tab: Tab): Promise<void> {
  const ticket = ++loading
  for (const button of element<HTMLElement>('tabs').children) button.setAttribute('aria-selected', String(button.textContent === tab.name))
  status.textContent = `loading ${tab.name}…`
  const response = await fetch(tab.url)
  if (!response.ok) throw new Error(`${tab.url}: ${response.status}`)
  const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), '')
  if (ticket !== loading) return
  status.textContent = `rigging ${tab.name}…`
  await new Promise(requestAnimationFrame)

  const bones = buildBones(tab.joints)
  const root = bones.get(tab.joints.find((joint) => !joint.parent)?.name ?? '') as THREE.Bone
  const start = performance.now()
  const report = await skin(gltf.scene, root, { resolution: 128 })
  const ms = performance.now() - start
  if (ticket !== loading) return

  if (current) scene.remove(current.model, current.helper)
  const helper = new THREE.SkeletonHelper(gltf.scene)
  scene.add(gltf.scene, helper)
  current = { model: gltf.scene, helper, motion: tab.motion(bones, gltf.scene) }
  applyToggles()
  frame(gltf.scene)
  // The agents finished most rigs at a higher resolution; the browser skins at 128 to stay quick
  const summary = `${tab.name}: ${tab.joints.length} bones, ${report.vertices} vertices skinned in ${(ms / 1000).toFixed(1)} s at resolution 128`
  status.replaceChildren(summary)
  if (report.warnings.length) {
    const details = document.createElement('details')
    details.append(Object.assign(document.createElement('summary'), { textContent: `${report.warnings.length} warnings` }))
    details.append(report.warnings.join('\n'))
    status.append(' · ', details)
  } else {
    status.append(' · no warnings')
  }
  document.body.dataset.ready = tab.name
}

/** Bones from world-space joints; an old-style tail becomes an end bone. */
function buildBones(joints: Joint[]): Map<string, THREE.Bone> {
  const made = new Map<string, THREE.Bone>()
  const place = (joint: Joint): THREE.Bone => {
    const existing = made.get(joint.name)
    if (existing) return existing
    const parentJoint = joints.find((j) => j.name === joint.parent)
    const b = bone(joint.name, joint.position as [number, number, number], parentJoint && place(parentJoint))
    if (joint.pieces) b.userData.pieces = joint.pieces
    made.set(joint.name, b)
    if (joint.tail) made.set(`${joint.name}_end`, bone(`${joint.name}_end`, joint.tail as [number, number, number], b))
    return b
  }
  joints.forEach(place)
  return made
}

function clipMotion(root: THREE.Object3D, clip: THREE.AnimationClip | null): Motion {
  if (!clip) return () => {}
  const mixer = new THREE.AnimationMixer(root)
  mixer.clipAction(clip).play()
  return (t) => mixer.setTime(t % clip.duration)
}

function frame(model: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3()).length()
  const center = box.getCenter(new THREE.Vector3())
  camera.position.copy(center).add(new THREE.Vector3(1, 0.45, 1).normalize().multiplyScalar(size * 1.4))
  camera.near = size / 100
  camera.far = size * 100
  camera.updateProjectionMatrix()
  controls.target.copy(center)
  controls.update()
}

function applyToggles(): void {
  if (!current) return
  current.helper.visible = showBones.checked
  current.model.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    for (const material of [node.material].flat()) {
      material.transparent = xray.checked
      material.opacity = xray.checked ? 0.35 : 1
      material.depthWrite = !xray.checked
    }
  })
}
showBones.addEventListener('change', applyToggles)
xray.addEventListener('change', applyToggles)

function resize(): void {
  renderer.setSize(view.clientWidth, view.clientHeight)
  camera.aspect = view.clientWidth / view.clientHeight
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()
const clock = new THREE.Clock()
let time = 0
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta()
  if (play.checked) time += dt
  current?.motion(frozen ?? time)
  renderer.render(scene, camera)
})

// The Fox tab needs a local model that isn't part of the repo
const local = await fetch('/model.glb', { method: 'HEAD' }).then((r) => r.ok && r.headers.get('content-type') !== 'text/html').catch(() => false)
const available = tabs.filter((tab) => tab.name !== 'Fox' || local)
for (const tab of available) {
  const button = document.createElement('button')
  button.textContent = tab.name
  button.setAttribute('role', 'tab')
  button.addEventListener('click', () => void open(tab).catch((error: Error) => (status.textContent = `error: ${error.message}`)))
  element<HTMLElement>('tabs').append(button)
}
const first = available.find((tab) => tab.name.toLowerCase() === params.get('tab')?.toLowerCase()) ?? available[0]
await open(first).catch((error: Error) => (status.textContent = `error: ${error.message}`))
