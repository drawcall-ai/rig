/**
 * Node-only: render a scene to one PNG headlessly (node-webgl: real WebGL 2, no browser), as a grid of
 * views. Each view is complete on its own: camera, pose and what to show.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { createCanvas as create2d, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import { createCanvas as createGL, installDOM, type Canvas } from '@onirenaud/node-webgl'
import * as THREE from 'three'
import { gather } from '../measure/soup.js'
import { frame, grid, sphere } from './camera.js'
import { boneColor, isAncestorOrSelf, isolate, paint, skeletonBones } from './display.js'
import { pose, snapshot } from './pose.js'
import { resolve, type Shot, type View } from './view.js'

installDOM()

export interface RenderOptions {
  /** PNG path to write. */
  out: string
  /** Pixels per view (default 600). */
  size?: number
  /** Rows of views. Default: one row of '+x', '+z', '+y', 'persp'. */
  views?: View[][]
}

/** What every shot of one render draws with. */
interface Stage {
  scene: THREE.Scene
  object: THREE.Object3D
  /** Every bone under the object, parents first; markers[i] marks bones[i]'s joint. */
  bones: THREE.Bone[]
  markers: THREE.Mesh[]
  /** The bones of the object's skeletons, in the order `boneColor` indexes. */
  palette: THREE.Bone[]
  sheet: SKRSContext2D
  size: number
}

const OPTIONS = ['out', 'size', 'views']
const BACKGROUND = '#2a2d31'
const JOINT = '#ffd23f'
const FONT = '13px monospace'

let gl: { canvas: Canvas; renderer: THREE.WebGLRenderer } | undefined

/**
 * Renders a grid of views into one PNG and returns its path. The scene is left as it was. An object with a
 * parent renders as if it had none: the parent's transform is ignored.
 */
export async function render(object: THREE.Object3D, options: RenderOptions): Promise<string> {
  for (const key of Object.keys(options)) if (!OPTIONS.includes(key)) throw new Error(`render: unknown option "${key}" (options: ${OPTIONS.join(', ')})`)
  const size = options.size ?? 600
  const rows = options.views ?? [[{ camera: '+x' }, { camera: '+z' }, { camera: '+y' }, { camera: 'persp' }]]
  if (rows.length === 0 || rows.some((row) => row.length === 0)) throw new Error('render: views needs at least one row, and every row at least one view')
  const bones: THREE.Bone[] = []
  object.traverse((node) => node instanceof THREE.Bone && bones.push(node))
  const palette = skeletonBones(object)
  const shots = rows.map((row) => row.map((view) => resolve(view, bones, palette)))

  const png = create2d(Math.max(...rows.map((row) => row.length)) * size, rows.length * size)
  const sheet = png.getContext('2d')
  sheet.fillStyle = BACKGROUND
  sheet.fillRect(0, 0, png.width, png.height)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(BACKGROUND)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2.2), new THREE.DirectionalLight(0xffffff, 1.2))
  const ball = new THREE.SphereGeometry(1)
  const yellow = new THREE.MeshBasicMaterial({ color: JOINT, depthTest: false })
  const markers = bones.map(() => Object.assign(new THREE.Mesh(ball, yellow), { renderOrder: 2 }))
  if (markers.length) scene.add(...markers)
  const stage: Stage = { scene, object, bones, markers, palette, sheet, size }

  const restore = snapshot(object)
  const parent = object.parent
  const index = parent?.children.indexOf(object) ?? -1
  scene.add(object)
  try {
    for (const [r, row] of shots.entries()) for (const [c, shot] of row.entries()) await draw(stage, shot, c * size, r * size)
  } finally {
    restore()
    if (parent) {
      parent.add(object)
      parent.children.splice(index, 0, ...parent.children.splice(-1))
    } else scene.remove(object)
    object.updateMatrixWorld(true)
    ball.dispose()
    yellow.dispose()
  }
  const out = resolvePath(options.out)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, png.toBuffer('image/png'))
  return out
}

/** Poses the scene for one shot, draws it into the sheet at (x, y) and puts the display back. */
async function draw(stage: Stage, shot: Shot, x: number, y: number): Promise<void> {
  const { scene, object, bones, markers, sheet, size } = stage
  const { view } = shot
  pose(object, view)
  object.updateMatrixWorld(true)
  // Measured through the bones, so the posed limbs stay in frame
  const { positions } = gather(object)
  const box = new THREE.Box3().setFromArray(positions)
  const radius = box.getSize(new THREE.Vector3()).length() / 2
  const undo: (() => void)[] = []
  try {
    if (shot.weights) undo.push(paint(object, shot.weights, stage.palette))
    let focus = shot.focus ? sphere(shot.focus, radius) : undefined
    if (shot.isolate) {
      const kept = isolate(object, shot.isolate)
      undo.push(kept.restore)
      if (kept.box.isEmpty()) throw new Error(`isolate: bone "${shot.isolate.name}" and its descendants own no geometry`)
      focus ??= { center: kept.box.getCenter(new THREE.Vector3()).toArray(), radius: (kept.box.getSize(new THREE.Vector3()).length() / 2) * 1.15 }
    }
    const reach = focus?.radius ?? radius
    const center = focus ? new THREE.Vector3(...focus.center) : box.getCenter(new THREE.Vector3())
    const isolated = shot.isolate
    const shown = view.bones === false ? [] : isolated ? bones.filter((bone) => isAncestorOrSelf(isolated, bone)) : bones
    bones.forEach((bone, i) => {
      markers[i].visible = shown.includes(bone)
      markers[i].scale.setScalar(reach * 0.012)
      bone.getWorldPosition(markers[i].position)
    })
    if (shown.length) {
      const lines = new THREE.SkeletonHelper(isolated ?? object)
      scene.add(lines)
      undo.push(() => {
        scene.remove(lines)
        lines.dispose()
      })
    }
    const camera = frame(view.camera, center, reach, box, positions)
    const width = (label: string) => {
      sheet.font = FONT
      return sheet.measureText(label).width
    }
    const ruler = camera instanceof THREE.OrthographicCamera ? grid(camera, center, radius, size, width) : undefined
    if (ruler) {
      scene.add(ruler.lines)
      undo.push(() => {
        scene.remove(ruler.lines)
        ruler.lines.geometry.dispose()
      })
    }
    const { renderer, canvas } = context(size)
    renderer.render(scene, camera)
    sheet.drawImage(await loadImage(canvas.toBuffer('image/png')), x, y)

    for (const label of ruler?.labels ?? []) write(sheet, label.text, '#9aa4b1', x + label.x, y + label.y)
    for (const bone of view.bones === 'names' ? shown : []) {
      const p = bone.getWorldPosition(new THREE.Vector3()).project(camera)
      // Joints outside the view get no name; pinned to the edge they would only clutter it
      if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue
      const index = stage.palette.indexOf(bone)
      // Bones outside every skeleton own no weights, so no color: they keep the joint color
      const color = shot.weights === true && index >= 0 ? `#${boneColor(index).getHexString()}` : JOINT
      write(sheet, bone.name, color, x + clamp(((p.x + 1) / 2) * size + 6, 2, size - 60), y + clamp(((1 - p.y) / 2) * size + 4, 14, size - 4))
    }
    write(sheet, caption(view), '#ffffff', x + 8, y + 18)
  } finally {
    for (const fn of undo.reverse()) fn()
  }
}

/** The WebGL canvas and renderer, kept across renders of the same size. */
function context(size: number): { canvas: Canvas; renderer: THREE.WebGLRenderer } {
  if (gl?.canvas.width === size) return gl
  gl?.renderer.dispose()
  const canvas = createGL(size, size)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setSize(size, size, false)
  gl = { canvas, renderer }
  return gl
}

/** "title (camera, weights LeftArm, isolate LeftHand, no bones)": what makes this view differ from a plain one. */
function caption(view: View): string {
  const details = [
    view.camera,
    view.weights === true ? 'weights' : view.weights ? `weights ${view.weights}` : '',
    view.isolate ? `isolate ${view.isolate}` : '',
    view.bones === false ? 'no bones' : '',
  ].filter(Boolean)
  return view.title ? `${view.title} (${details.join(', ')})` : details.join(', ')
}

function write(ctx: SKRSContext2D, text: string, color: string, x: number, y: number): void {
  ctx.font = FONT
  ctx.lineWidth = 3
  ctx.strokeStyle = '#000000'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
