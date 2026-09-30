/**
 * Node-only: load a glTF as a three.js scene, render checks to PNG headlessly
 * (node-webgl: real WebGL 2, no browser), and save the rigged scene back into
 * the source file with materials, textures and extensions kept byte for byte.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { NodeIO, type Document } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { createCanvas as create2d, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import { createCanvas as createGL, installDOM } from '@onirenaud/node-webgl'
import draco3d from 'draco3dgltf'
import { MeshoptDecoder } from 'meshoptimizer'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { readScene, writeSkin, type BakedVertices, type RigJoint } from './gltf.js'
import { solveParallel } from './parallel.js'
import { useSolver } from './three.js'
import type { Vec3 } from './solve.js'

installDOM()
useSolver(solveParallel)

/** glTF association of a three.js mesh, set by load(): which source node/primitive it came from. */
interface Source {
  node: number
  primitive: number
}

/** Loads a .glb/.gltf as a three.js scene (the gltf.scene). Remembers the file for save(). */
export async function load(path: string): Promise<THREE.Group> {
  const file = resolve(path)
  const bytes = readFileSync(file)
  await MeshoptDecoder.ready
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), `${dirname(file)}/`)
  const associations = gltf.parser.associations as Map<THREE.Object3D, { nodes?: number; meshes?: number; primitives?: number }>
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    const primitive = associations.get(object)?.primitives ?? 0
    let owner: THREE.Object3D | null = object
    while (owner && associations.get(owner)?.nodes === undefined) owner = owner.parent
    const node = owner ? associations.get(owner)?.nodes : undefined
    if (node !== undefined) object.userData.gltf = { node, primitive } satisfies Source
  })
  gltf.scene.userData.source = file
  gltf.scene.updateMatrixWorld(true)
  return gltf.scene
}

/**
 * Writes the rig of a scene from load() + skin() as a glTF (.glb or .gltf): the source file with the new
 * joint tree (in its bind pose, whatever the current pose), skinned meshes and the old rig removed.
 */
export async function save(object: THREE.Object3D, path: string): Promise<void> {
  const source = object.userData.source as string | undefined
  if (!source) throw new Error('save() writes into the file load() read; this object did not come from load()')
  const skinned: THREE.SkinnedMesh[] = []
  object.traverse((node) => node instanceof THREE.SkinnedMesh && node.userData.gltf && skinned.push(node))
  const skeleton = skinned[0]?.skeleton
  if (!skeleton || skinned.some((mesh) => mesh.skeleton !== skeleton)) throw new Error('save() needs every mesh bound by one skin() call')

  const io = await createIO()
  const document = await io.read(source)
  const { parts } = readScene(document)
  const nodes = document.getRoot().listNodes()
  const byKey = new Map(skinned.map((mesh) => [`${(mesh.userData.gltf as Source).node}:${(mesh.userData.gltf as Source).primitive}`, mesh]))
  const total = parts.reduce((sum, part) => sum + part.count, 0)
  const skinIndices = new Uint16Array(total * 4)
  const skinWeights = new Float32Array(total * 4)
  // Write the vertices skin() baked, exactly as they were seen and checked, not a re-bake of the source
  const baked: (BakedVertices | undefined)[] = []
  for (const part of parts) {
    const key = `${nodes.indexOf(part.node)}:${part.node.getMesh()?.listPrimitives().indexOf(part.primitive)}`
    const mesh = byKey.get(key)
    if (!mesh) {
      // Primitives three.js does not load as meshes (points, lines) follow the root joint
      for (let v = 0; v < part.count; v++) skinWeights[(part.offset + v) * 4] = 1
      baked.push(undefined)
      continue
    }
    baked.push({ position: floats(mesh.geometry.getAttribute('position')), normal: mesh.geometry.getAttribute('normal') && floats(mesh.geometry.getAttribute('normal')) })
    const indices = mesh.geometry.getAttribute('skinIndex')
    const weights = mesh.geometry.getAttribute('skinWeight')
    if (indices.count !== part.count) throw new Error(`mesh "${mesh.name}" has ${indices.count} vertices, the source primitive ${part.count}`)
    for (let v = 0; v < part.count; v++) {
      for (let k = 0; k < 4; k++) {
        skinIndices[(part.offset + v) * 4 + k] = indices.getComponent(v, k)
        skinWeights[(part.offset + v) * 4 + k] = weights.getComponent(v, k)
      }
    }
  }

  // Bind pose from the inverse bind matrices, so a posed scene still saves its rest pose
  const bindWorld = skeleton.boneInverses.map((inverse) => inverse.clone().invert())
  const joints: RigJoint[] = skeleton.bones.map((bone, i) => {
    const parentIndex = skeleton.bones.indexOf(bone.parent as THREE.Bone)
    const local = parentIndex >= 0 ? bindWorld[parentIndex].clone().invert().multiply(bindWorld[i]) : bindWorld[i].clone()
    const translation = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    local.decompose(translation, rotation, scale)
    return {
      name: bone.name,
      parentIndex,
      translation: translation.toArray(),
      rotation: rotation.toArray() as [number, number, number, number],
      scale: scale.toArray(),
      inverseBind: skeleton.boneInverses[i].elements,
    }
  })
  writeSkin(document, joints, parts, skinIndices, skinWeights, baked)
  const out = resolve(path)
  mkdirSync(dirname(out), { recursive: true })
  await io.write(out, withoutCompression(document))
}

/** A vec3 attribute as a tightly packed Float32Array (attributes may be interleaved). */
function floats(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(attribute.count * 3)
  for (let i = 0; i < attribute.count; i++) {
    out[i * 3] = attribute.getX(i)
    out[i * 3 + 1] = attribute.getY(i)
    out[i * 3 + 2] = attribute.getZ(i)
  }
  return out
}

async function createIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder,
  })
}

/** Geometry was decoded on read; write it back uncompressed instead of needing encoders. */
function withoutCompression(document: Document): Document {
  for (const extension of document.getRoot().listExtensionsUsed()) {
    const name = extension.extensionName
    if (name === 'KHR_draco_mesh_compression' || name === 'EXT_meshopt_compression') extension.dispose()
  }
  return document
}

export interface RenderOptions {
  /** PNG path to write. */
  out: string
  /**
   * Views, tiled into one image: '+x' = camera on the +x side looking toward -x, also -x, +y (top), -y, +z,
   * -z: orthographic with a labeled world grid; 'persp' = 3/4 view. Default ['+x', '+z', '+y', 'persp'].
   */
  views?: string[]
  /** Pixels per view (default 600). */
  size?: number
  /** Draw the skeleton (default: when the scene has bones). */
  bones?: boolean
  /** Write bone names next to the joints. */
  labels?: boolean
  /** Color the skinned meshes by this bone's weights: blue 0 -> red 1. */
  weights?: string
  /** Zoom on a bone (by name) or a world-space sphere. */
  focus?: string | { center: Vec3; radius: number }
  /** See-through meshes. */
  xray?: boolean
  /** Caption drawn above the views. */
  title?: string
  /**
   * A sheet of poses, one row each (all views per row): every pose starts from the bind pose and sets
   * the listed bones' rotations (radians, Euler XYZ); the scene returns to the bind pose afterwards.
   * E.g. a range-of-motion check: [{ title: 'arm up', rotations: { LeftArm: [0, 0, 1.2] } }, ...].
   */
  poses?: { title?: string; rotations: Record<string, [number, number, number]> }[]
}

let renderer: THREE.WebGLRenderer | undefined
let rendererSize = 0

/**
 * Renders the object's current state (pose it first with bone.rotation) into one PNG, all views side by
 * side. Returns the path.
 */
export async function render(object: THREE.Object3D, options: RenderOptions): Promise<string> {
  const size = options.size ?? 600
  const views = options.views ?? ['+x', '+z', '+y', 'persp']
  if (!renderer || rendererSize !== size) {
    renderer?.dispose()
    renderer = new THREE.WebGLRenderer({ canvas: createGL(size, size), antialias: true, preserveDrawingBuffer: true })
    renderer.setSize(size, size, false)
    rendererSize = size
  }
  object.updateMatrixWorld(true)
  const bones: THREE.Bone[] = []
  object.traverse((node) => node instanceof THREE.Bone && bones.push(node))
  const box = new THREE.Box3()
  object.traverse((node) => {
    if (node instanceof THREE.Mesh && !node.userData.rigHelper) box.expandByObject(node)
  })
  const extent = box.getSize(new THREE.Vector3())
  const radius = extent.length() / 2
  const focus = resolveFocus(options.focus, bones, radius)
  const center = focus ? new THREE.Vector3(...focus.center) : box.getCenter(new THREE.Vector3())

  // Stage: the object plus lights, skeleton lines and joint markers; restored afterwards
  const stage = new THREE.Scene()
  stage.background = new THREE.Color(0x2a2d31)
  stage.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2.2), new THREE.DirectionalLight(0xffffff, 1.2))
  const parent = object.parent
  stage.add(object)
  const showBones = options.bones ?? bones.length > 0
  const helpers: THREE.Object3D[] = []
  const markers: THREE.Mesh[] = []
  if (showBones && bones.length) {
    const lines = new THREE.SkeletonHelper(object)
    const marker = new THREE.SphereGeometry((focus?.radius ?? radius) * 0.012)
    const material = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false })
    lines.userData.rigHelper = true
    helpers.push(lines)
    for (const bone of bones) {
      const sphere = new THREE.Mesh(marker, material)
      sphere.renderOrder = 2
      sphere.userData.rigHelper = true
      markers.push(sphere)
      helpers.push(sphere)
    }
  }
  if (helpers.length) stage.add(...helpers)
  const restore = paint(object, options)

  const poses = options.poses ?? [undefined]
  const skeletons = new Set<THREE.Skeleton>()
  object.traverse((node) => node instanceof THREE.SkinnedMesh && skeletons.add(node.skeleton))
  const byName = new Map(bones.map((bone) => [bone.name, bone]))
  for (const pose of options.poses ?? []) {
    for (const name of Object.keys(pose.rotations)) if (!byName.has(name)) throw new Error(`pose names unknown bone "${name}"`)
  }
  const cells = poses.flatMap((pose) => views.map((view) => ({ pose, view })))
  const cols = options.poses ? views.length : Math.min(views.length, 4)
  const title = options.title ? 30 : 0
  const sheet = create2d(cols * size, Math.ceil(cells.length / cols) * size + title)
  const ctx = sheet.getContext('2d')
  ctx.fillStyle = '#2a2d31'
  ctx.fillRect(0, 0, sheet.width, sheet.height)
  try {
    for (const [i, { pose, view }] of cells.entries()) {
      if (pose) {
        for (const skeleton of skeletons) skeleton.pose()
        for (const [name, rotation] of Object.entries(pose.rotations)) byName.get(name)?.rotation.set(...rotation)
      }
      object.updateMatrixWorld(true)
      bones.forEach((bone, k) => markers[k] && bone.getWorldPosition(markers[k].position))
      const camera = frame(view, center, focus?.radius ?? radius, extent, radius)
      const grid = camera instanceof THREE.OrthographicCamera ? makeGrid(camera, center, radius) : undefined
      if (grid) stage.add(grid.lines)
      renderer.render(stage, camera)
      if (grid) stage.remove(grid.lines)
      const x = (i % cols) * size
      const y = Math.floor(i / cols) * size + title
      ctx.drawImage(await loadImage((renderer.domElement as unknown as { toBuffer(type: string): Buffer }).toBuffer('image/png')), x, y)
      const text = (world: THREE.Vector3, label: string, color: string, dx = 6, dy = 4) => {
        const p = world.clone().project(camera)
        write(ctx, label, color, x + clamp(((p.x + 1) / 2) * size + dx, 2, size - 60), y + clamp(((1 - p.y) / 2) * size + dy, 14, size - 4))
      }
      for (const [world, label] of grid?.labels ?? []) text(world, label, '#9aa4b1', 2, -4)
      if (options.labels && showBones) for (const bone of bones) text(bone.getWorldPosition(new THREE.Vector3()), bone.name, '#ffd23f')
      write(ctx, pose?.title ? `${pose.title} (${view})` : view, '#ffffff', x + 8, y + 18)
    }
    if (options.title) write(ctx, options.title, '#ffffff', 8, 21)
  } finally {
    if (options.poses) for (const skeleton of skeletons) skeleton.pose()
    restore()
    if (helpers.length) stage.remove(...helpers)
    if (parent) parent.add(object)
    else stage.remove(object)
  }
  const out = resolve(options.out)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, sheet.toBuffer('image/png'))
  return out
}

function resolveFocus(focus: RenderOptions['focus'], bones: THREE.Bone[], radius: number): { center: Vec3; radius: number } | undefined {
  if (focus === undefined) return undefined
  if (typeof focus !== 'string') return focus
  const bone = bones.find((b) => b.name === focus)
  if (!bone) throw new Error(`focus names unknown bone "${focus}"`)
  const start = bone.getWorldPosition(new THREE.Vector3())
  const next = bone.children.find((c) => c instanceof THREE.Bone) ?? bone.parent
  const end = next ? next.getWorldPosition(new THREE.Vector3()) : start
  return { center: start.clone().lerp(end, 0.5).toArray(), radius: Math.max(start.distanceTo(end) * 1.5, radius * 0.08) }
}

function frame(view: string, center: THREE.Vector3, reach: number, extent: THREE.Vector3, radius: number): THREE.Camera {
  if (view === 'persp') {
    const camera = new THREE.PerspectiveCamera(35, 1, reach / 100, reach * 100)
    camera.position.copy(center).add(new THREE.Vector3(1, 0.6, 1).normalize().multiplyScalar(reach * 3))
    camera.lookAt(center)
    camera.updateMatrixWorld()
    return camera
  }
  const match = /^([+-])([xyz])$/.exec(view)
  if (!match) throw new Error(`unknown view "${view}" (use +x, -x, +y, -y, +z, -z or persp)`)
  const axis = 'xyz'.indexOf(match[2])
  const dir = new THREE.Vector3().setComponent(axis, match[1] === '+' ? 1 : -1)
  const across = [0, 1, 2].filter((a) => a !== axis).map((a) => extent.getComponent(a))
  const half = reach < radius ? reach : (Math.max(...across) / 2) * 1.12
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, -radius * 10, radius * 10)
  camera.up.set(0, axis === 1 ? 0 : 1, axis === 1 ? -dir.y : 0)
  camera.position.copy(center).addScaledVector(dir, radius * 2)
  camera.lookAt(center)
  camera.updateMatrixWorld()
  return camera
}

/** Grid lines behind the model at round world coordinates, plus their edge labels. */
function makeGrid(camera: THREE.OrthographicCamera, center: THREE.Vector3, radius: number) {
  const half = camera.right
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
  const dominant = (v: THREE.Vector3) => [0, 1, 2].reduce((best, a) => (Math.abs(v.getComponent(a)) > Math.abs(v.getComponent(best)) ? a : best), 0)
  const h = dominant(right)
  const v = dominant(up)
  const raw = (half * 2) / 16
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  const behind = center.clone().addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2), -radius * 1.5)
  const at = (hv: number, vv: number) => behind.clone().setComponent(h, hv).setComponent(v, vv)
  const points: THREE.Vector3[] = []
  const labels: [THREE.Vector3, string][] = []
  const lo = (a: number) => Math.ceil((center.getComponent(a) - half) / step) * step
  // World coordinates of the screen's bottom and left edges (axes can run backwards on screen)
  const bottom = center.getComponent(v) - Math.sign(up.getComponent(v)) * half
  const leftEdge = center.getComponent(h) - Math.sign(right.getComponent(h)) * half
  for (let x = lo(h); x <= center.getComponent(h) + half; x += step) {
    points.push(at(x, center.getComponent(v) - half), at(x, center.getComponent(v) + half))
    labels.push([at(x, bottom), `${'xyz'[h]}=${x.toFixed(decimals)}`])
  }
  for (let y = lo(v); y <= center.getComponent(v) + half; y += step) {
    points.push(at(center.getComponent(h) - half, y), at(center.getComponent(h) + half, y))
    labels.push([at(leftEdge, y), `${'xyz'[v]}=${y.toFixed(decimals)}`])
  }
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x4a5058 }))
  return { lines, labels }
}

/** Heatmap / x-ray materials for the render; returns a function restoring the originals. */
function paint(object: THREE.Object3D, options: RenderOptions): () => void {
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  const restoreColors: (() => void)[] = []
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || node.userData.rigHelper) return
    originals.set(node, node.material)
    if (options.weights && node instanceof THREE.SkinnedMesh) {
      const index = node.skeleton.bones.findIndex((bone) => bone.name === options.weights)
      if (index < 0) throw new Error(`weights names unknown bone "${options.weights}"`)
      const ids = node.geometry.getAttribute('skinIndex')
      const ws = node.geometry.getAttribute('skinWeight')
      const colors = new Float32Array(ids.count * 3)
      const color = new THREE.Color()
      for (let v = 0; v < ids.count; v++) {
        let w = 0
        for (let k = 0; k < 4; k++) if (ids.getComponent(v, k) === index) w += ws.getComponent(v, k)
        color.setHSL(0.66 * (1 - w), 0.9, w > 0 ? 0.5 : 0.18)
        colors.set([color.r, color.g, color.b], v * 3)
      }
      // Keep the model's own vertex colors to put back afterwards
      const own = node.geometry.getAttribute('color')
      node.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      node.material = new THREE.MeshBasicMaterial({ vertexColors: true })
      restoreColors.push(() => (own ? node.geometry.setAttribute('color', own) : node.geometry.deleteAttribute('color')))
    } else if (options.xray) {
      // Keep a single material single: an array renders nothing on geometry without groups
      const seeThrough = (m: THREE.Material) => Object.assign(m.clone(), { transparent: true, opacity: 0.3, depthWrite: false })
      node.material = Array.isArray(node.material) ? node.material.map(seeThrough) : seeThrough(node.material)
    }
  })
  return () => {
    for (const [mesh, material] of originals) mesh.material = material
    for (const restore of restoreColors) restore()
  }
}

function write(ctx: SKRSContext2D, text: string, color: string, x: number, y: number): void {
  ctx.font = '13px monospace'
  ctx.lineWidth = 3
  ctx.strokeStyle = '#000000'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
