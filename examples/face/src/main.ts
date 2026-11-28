/**
 * Jean Phil's face controls: the rig loader rigs the face, and this page poses it by hand: ARKit blendshape weights,
 * the gaze as the eight standard eyeLook weights, and the head.
 */

import { wrinkles } from '@drawcall/rig'
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { jeanPhil } from './jean-phil.js'
import { Panel, type Section, type Slider } from './panel.js'
import { Poser } from './poser.js'
import { addGazeSection } from './gaze.js'

function element(selector: string): HTMLElement {
  const found = document.querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`index.html lacks ${selector}`)
  return found
}
function input(selector: string): HTMLInputElement {
  const found = element(selector)
  if (!(found instanceof HTMLInputElement)) throw new Error(`index.html's ${selector} is not an input`)
  return found
}
const view = element('#view'), status = element('#status')
const search = input('#search'), mirror = input('#mirror')

const renderer = new THREE.WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
view.prepend(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1d1f21)
const key = new THREE.DirectionalLight(0xffffff, 1.6)
key.position.set(1, 1.2, 0.8)
scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2.2), key)
const camera = new THREE.PerspectiveCamera(22, 1, 0.01, 10)
camera.position.set(0.48, 0.418, 0.1)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0.04, 0.397, 0)
controls.enableDamping = true
controls.update()
/** Renders on demand: once per frame something asks, and again while the orbit controls' damping still moves the camera. */
let frame = 0
function requestRender(): void {
  if (!frame) frame = requestAnimationFrame(renderFrame)
}
function renderFrame(): void {
  frame = 0
  const moving = controls.update()
  renderer.render(scene, camera)
  if (moving) requestRender()
}

// the rig loads while the renderer starts
const loading = jeanPhil().then(async (rig) => {
  await wrinkles(rig.object)
  return rig
}).catch((error: unknown) => {
  status.textContent = `error: ${error instanceof Error ? error.message : String(error)}`
  throw error
})
const [, rig] = await Promise.all([renderer.init(), loading])
scene.add(rig.object)
status.remove()
// rendering starts once the renderer is ready, and the observer's first call sizes it
controls.addEventListener('change', requestRender)
new ResizeObserver(() => {
  renderer.setSize(view.clientWidth, view.clientHeight)
  camera.aspect = view.clientWidth / view.clientHeight
  camera.updateProjectionMatrix()
  requestRender()
}).observe(view)

const poser = new Poser(rig.object, 'Neck')
/** The ARKit shapes the face carries. */
const shapes = new Set(poser.shapes)
/** ARKit weights by name: the shapes and the eyeLook weights the gaze pad writes. */
const weights = new Map<string, number>()

/** Head degrees. */
const pose = { nod: 0, turn: 0, tilt: 0 }
const DEG = Math.PI / 180

function apply(): void {
  // the view looks at the face, so its right is the face's left
  poser.update(Object.fromEntries(weights), { nod: pose.nod * DEG, turn: pose.turn * DEG, tilt: -pose.tilt * DEG })
  requestRender()
}

// ---- the panel

const panel = new Panel(element('#controls'), apply)

const REGIONS = [['brow', 'Brows'], ['eye', 'Eyes'], ['cheek', 'Cheeks'], ['nose', 'Nose'], ['jaw', 'Jaw'], ['mouth', 'Mouth'], ['tongue', 'Tongue']] as const
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())

/**
 * One control per shape or left/right pair, by base name: a pair of sides (mouthSmileLeft/Right) mirrors, a pair of
 * directions (jawLeft/Right, mouthLeft/Right, named by their region alone) is one sideways slider.
 */
interface Control { label: string; region: string; names: string[]; sideways: boolean }
const controlsByBase = new Map<string, Control>()
for (const name of [...shapes].sort()) {
  const base = name.replace(/(Left|Right)$/, '')
  const [prefix, region] = REGIONS.find(([p]) => base.startsWith(p)) ?? ['', 'Other']
  const sideways = base === prefix
  const control = controlsByBase.get(base) ?? { label: sideways ? 'Sideways' : words(base.slice(prefix.length)), region, names: [], sideways }
  control.names.push(name)
  controlsByBase.set(base, control)
}
const shapeControls = [...controlsByBase.values()]

// head, then gaze
const headSection = panel.section('Head', () => [pose.nod, pose.turn, pose.tilt].filter(Boolean).length, () => Object.assign(pose, { nod: 0, turn: 0, tilt: 0 }))
for (const [field, label, limit] of [['nod', 'Nod', 25], ['turn', 'Turn', 35], ['tilt', 'Tilt', 20]] as const) {
  const s = panel.slider(label, `Head ${label.toLowerCase()} (degrees)`, () => pose[field], (v) => { pose[field] = v }, [-limit, limit, 1])
  s.row.dataset.filter = `head ${field}`
  headSection.rows.append(s.row)
  panel.onUpdate(s.refresh)
}
addGazeSection(panel, weights)

// shapes by region; mirrored pairs show one slider driving both sides
const shapeSections = new Map<string, Section>()
for (const region of new Set(shapeControls.map((c) => c.region))) {
  const own = shapeControls.filter((c) => c.region === region)
  const names = own.flatMap((c) => c.names)
  shapeSections.set(region, panel.section(region, () => names.filter((n) => weights.get(n)).length, () => { for (const n of names) weights.delete(n) }))
}
const shapeRefreshers: (() => void)[] = []
panel.onUpdate(() => { for (const r of shapeRefreshers) r() })

function buildShapes(): void {
  shapeRefreshers.length = 0
  for (const [region, s] of shapeSections) {
    s.rows.replaceChildren()
    for (const control of shapeControls.filter((c) => c.region === region)) {
      const add = (item: Slider) => {
        item.row.dataset.filter = `${control.label} ${control.names.join(' ')}`.toLowerCase()
        s.rows.append(item.row)
        shapeRefreshers.push(item.refresh)
      }
      const [left, right] = control.names
      if (control.sideways && left && right) {
        // the view faces the face, so its right is the face's left
        add(panel.slider(control.label, `${right} ← → ${left}`, () => (weights.get(left) ?? 0) - (weights.get(right) ?? 0), (v) => {
          weights.set(left, Math.max(0, v))
          weights.set(right, Math.max(0, -v))
        }, [-1, 1, 0.01]))
      } else if (right && !mirror.checked) {
        const heading = document.createElement('div')
        heading.className = 'row'
        heading.append(Object.assign(document.createElement('span'), { textContent: control.label }))
        add({ row: heading, refresh: () => {} })
        for (const name of control.names) {
          const item = panel.slider(name.endsWith('Left') ? 'Left' : 'Right', name, () => weights.get(name) ?? 0, (v) => { weights.set(name, v) })
          item.row.classList.add('side')
          add(item)
        }
      } else {
        const names = control.names
        const average = () => names.reduce((sum, n) => sum + (weights.get(n) ?? 0), 0) / names.length
        add(panel.slider(control.label, names.join(' + '), average, (v) => { for (const n of names) weights.set(n, v) }))
      }
    }
  }
  filter()
  panel.update()
}

const filter = () => panel.filter(search.value.trim().toLowerCase())
search.addEventListener('input', filter)
mirror.addEventListener('change', buildShapes)
buildShapes()

// ---- presets, reset, copy

const PRESETS: Record<string, Record<string, number>> = {
  Neutral: {},
  Smile: { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, cheekSquintLeft: 0.5, cheekSquintRight: 0.5, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
  Surprise: { browInnerUp: 0.9, browOuterUpLeft: 0.8, browOuterUpRight: 0.8, eyeWideLeft: 0.7, eyeWideRight: 0.7, jawOpen: 0.35 },
  Anger: { browDownLeft: 0.9, browDownRight: 0.9, eyeSquintLeft: 0.4, eyeSquintRight: 0.4, noseSneerLeft: 0.5, noseSneerRight: 0.5, mouthPressLeft: 0.5, mouthPressRight: 0.5 },
  Sadness: { browInnerUp: 0.8, mouthFrownLeft: 0.6, mouthFrownRight: 0.6, mouthShrugLower: 0.3, eyeSquintLeft: 0.1, eyeSquintRight: 0.1 },
  Disgust: { noseSneerLeft: 0.8, noseSneerRight: 0.8, mouthUpperUpLeft: 0.5, mouthUpperUpRight: 0.5, browDownLeft: 0.4, browDownRight: 0.4, cheekSquintLeft: 0.3, cheekSquintRight: 0.3 },
  Fear: { browInnerUp: 0.9, browOuterUpLeft: 0.4, browOuterUpRight: 0.4, eyeWideLeft: 0.8, eyeWideRight: 0.8, mouthStretchLeft: 0.5, mouthStretchRight: 0.5, jawOpen: 0.1 },
}

/** Blends the shapes to `to` over 200 ms, leaving head and gaze as they are. */
function blendTo(to: Record<string, number>): void {
  const from = new Map(weights)
  const names = new Set([...from.keys(), ...Object.keys(to)].filter((n) => shapes.has(n)))
  const start = performance.now()
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / 200)
    const ease = k * k * (3 - 2 * k)
    for (const n of names) {
      const value = (from.get(n) ?? 0) + ((to[n] ?? 0) - (from.get(n) ?? 0)) * ease
      if (value) weights.set(n, value)
      else weights.delete(n)
    }
    panel.update()
    if (k < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
const presets = element('#presets')
for (const [label, shape] of Object.entries(PRESETS)) {
  const button = Object.assign(document.createElement('button'), { className: 'chip', textContent: label })
  button.addEventListener('click', () => blendTo(shape))
  presets.append(button)
}

element('#reset').addEventListener('click', () => {
  weights.clear()
  Object.assign(pose, { nod: 0, turn: 0, tilt: 0 })
  panel.update()
})

const toast = element('#toast')
let hideToast = 0
function showToast(text: string): void {
  toast.textContent = text
  toast.classList.add('show')
  clearTimeout(hideToast)
  hideToast = window.setTimeout(() => toast.classList.remove('show'), 1500)
}
element('#copy').addEventListener('click', () => {
  const rounded = (v: number) => Math.round(v * 100) / 100
  const shapesJson = Object.fromEntries([...weights].filter(([, v]) => v).map(([n, v]) => [n, rounded(v)]))
  const text = JSON.stringify({ shapes: shapesJson, head: { nod: pose.nod, turn: pose.turn, tilt: pose.tilt } }, null, 2)
  // pages opened insecurely, such as by LAN address, have no clipboard
  if (!navigator.clipboard) return showToast('Copying needs HTTPS or localhost')
  navigator.clipboard.writeText(text).then(
    () => showToast('Pose copied to the clipboard'),
    (error: unknown) => showToast(`Copying failed: ${error instanceof Error ? error.message : String(error)}`),
  )
})

panel.update()
