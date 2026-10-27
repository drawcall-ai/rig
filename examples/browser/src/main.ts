/** Loads rigged .glts assets and plays a motion for each creature.
 * URL parameters: tab=<name>, t=<seconds>, xray=1, bones=0, weights=ownership|<bone name>.
 */

import { GLTSLoader, type GLTSScene } from '@drawcall/glts'
import * as rig from '@drawcall/rig'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { gallop } from './gallop.js'
import { flap, grip, swim, walk, type Motion } from './motions.js'

interface Tab {
  name: string
  url: string
  /** Optional local model; hide the tab when the file is absent. */
  model?: string
  motion: (bones: Map<string, THREE.Bone>, root: THREE.Object3D) => Motion
}

const forward = (x: number, z: number) => new THREE.Vector3(x, 0, z)
const tabs: Tab[] = [
  { name: 'Horse', url: '/rigs/horse.glts', motion: (_, root) => gallop(root) },
  { name: 'Parrot', url: '/rigs/parrot.glts', motion: (b) => flap(b, forward(0, 1)) },
  { name: 'Stork', url: '/rigs/stork.glts', motion: (b) => flap(b, forward(0, 1)) },
  { name: 'Fish', url: '/rigs/fish.glts', motion: (b) => swim(b) },
  { name: 'Soldier', url: '/rigs/soldier.glts', motion: (b) => walk(b, forward(0, -1)) },
  { name: 'Robot', url: '/rigs/robot.glts', motion: (b) => walk(b, forward(0, 1)) },
  { name: 'Fox', url: '/rigs/fox.glts', model: '/model.glb', motion: (b) => walk(b, forward(1, 0)) },
  { name: 'Dragon', url: '/rigs/dragon.glts', model: '/dragon.glb', motion: (b) => flap(b, forward(0, 1)) },
  {
    name: 'Jean Phil', url: '/rigs/jean-phil.glts', model: '/jean-phil.glb',
    motion: (b) => {
      const legs = walk(b, forward(1, 0))
      const hands = grip(b, forward(1, 0))
      return (t) => {
        legs(t)
        hands(t)
      }
    },
  },
]

function element(id: string): HTMLElement {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing #${id}`)
  return found
}

function checkbox(id: string): HTMLInputElement {
  const found = element(id)
  if (!(found instanceof HTMLInputElement)) throw new Error(`#${id} is not an input`)
  return found
}

function select(id: string): HTMLSelectElement {
  const found = element(id)
  if (!(found instanceof HTMLSelectElement)) throw new Error(`#${id} is not a select`)
  return found
}

const manager = new THREE.LoadingManager()
const loader = new GLTSLoader(manager, { isPreview: true, modules: { '@drawcall/rig': rig } })
const view = element('view')
const status = element('status')
const play = checkbox('play')
const showBones = checkbox('bones')
const xray = checkbox('xray')
const paint = select('weights')
const params = new URLSearchParams(location.search)
const frozen = params.has('t') ? Number(params.get('t')) : undefined
xray.checked = params.get('xray') === '1'
showBones.checked = params.get('bones') !== '0'

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(devicePixelRatio)
view.append(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x2a2d31)
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1e5)
const controls = new OrbitControls(camera, renderer.domElement)

let current: {
  model: GLTSScene
  helpers: THREE.SkeletonHelper[]
  helper?: THREE.SkeletonHelper
  restoreWeights?: () => void
  motion: Motion
} | undefined
const materials = new WeakMap<THREE.Material, { transparent: boolean; opacity: number; depthWrite: boolean }>()
let loading = 0

async function open(tab: Tab): Promise<void> {
  const ticket = ++loading
  for (const button of element('tabs').children) button.setAttribute('aria-selected', String(button.textContent === tab.name))
  status.textContent = `loading ${tab.name}…`
  const start = performance.now()
  const model = await loader.loadAsync(tab.url)
  if (ticket !== loading) {
    model.dispose()
    return
  }
  const bones = new Map<string, THREE.Bone>()
  model.traverse((node) => {
    if (node instanceof THREE.Bone) bones.set(node.name, node)
  })
  if (current) {
    current.restoreWeights?.()
    scene.remove(current.model)
    if (current.helper) {
      scene.remove(current.helper)
      current.helper.dispose()
    }
    current.model.dispose()
  }
  const helpers: THREE.SkeletonHelper[] = []
  model.traverse((node) => {
    if (node instanceof THREE.SkeletonHelper) helpers.push(node)
  })
  const helper = helpers.length ? undefined : new THREE.SkeletonHelper(model)
  if (helper) {
    helpers.push(helper)
    scene.add(helper)
  }
  for (const overlay of helpers) {
    overlay.renderOrder = 1
    for (const material of [overlay.material].flat()) material.depthTest = false
  }
  scene.add(model)
  current = { model, helpers, helper, motion: tab.motion(bones, model) }
  paint.replaceChildren(new Option('Original materials', 'original'), new Option('Bone ownership', 'ownership'))
  const group = document.createElement('optgroup')
  group.label = 'Bone heatmap (blue → red)'
  for (const name of bones.keys()) group.append(new Option(name, `bone:${name}`))
  paint.append(group)
  paint.disabled = bones.size === 0
  const requested = params.get('weights')
  if (requested === 'ownership') paint.value = requested
  else if (requested && bones.has(requested)) paint.value = `bone:${requested}`
  applyWeights()
  frame(model)
  status.textContent = `${tab.name}: ${bones.size} bones, loaded and rigged in ${((performance.now() - start) / 1000).toFixed(1)} s`
  document.body.dataset.ready = tab.name
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
  for (const helper of current.helpers) helper.visible = showBones.checked
  current.model.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    for (const material of [node.material].flat()) {
      let original = materials.get(material)
      if (!original) {
        original = { transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite }
        materials.set(material, original)
      }
      material.transparent = xray.checked || original.transparent
      material.opacity = xray.checked ? original.opacity * 0.35 : original.opacity
      material.depthWrite = xray.checked ? false : original.depthWrite
      material.needsUpdate = true
    }
  })
}
function applyWeights(): void {
  if (!current) return
  current.restoreWeights?.()
  current.restoreWeights = paint.value === 'original' ? undefined : rig.weights(current.model, paint.value === 'ownership' ? undefined : paint.value.slice(5))
  applyToggles()
}
paint.addEventListener('change', applyWeights)
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
  current?.model.update(dt)
  current?.motion(frozen ?? time)
  renderer.render(scene, camera)
})

// Local tabs need their model in examples/browser/public; the dev server answers a missing file with index.html
const exists = (url: string) => fetch(url, { method: 'HEAD' }).then((r) => r.ok && r.headers.get('content-type') !== 'text/html').catch(() => false)
const available = (await Promise.all(tabs.map(async (tab) => (!tab.model || (await exists(tab.model)) ? tab : undefined)))).filter((tab) => tab !== undefined)
for (const tab of available) {
  const button = document.createElement('button')
  button.textContent = tab.name
  button.setAttribute('role', 'tab')
  button.addEventListener('click', () => void open(tab).catch((error: Error) => (status.textContent = `error: ${error.message}`)))
  element('tabs').append(button)
}
const first = available.find((tab) => tab.name.toLowerCase() === params.get('tab')?.toLowerCase()) ?? available[0]
if (!first) throw new Error('No rigs available')
await open(first).catch((error: Error) => (status.textContent = `error: ${error.message}`))
