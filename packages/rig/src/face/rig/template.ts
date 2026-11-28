/**
 * The reference head: the FLAME-topology head of LAM-Audio2Expression (Apache-2.0) in meters, carrying the ARKit
 * blendshapes the face rig transfers. Template space is the file's space turned to face +x with y up, the head's left at -z. Every
 * face rigging step runs in template space, so its distances are those of a human head.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { read } from '#read'
import { meshPieces } from '../../measure/topology.js'
import { harmonic, surfaceGraph } from './graph.js'

export interface Template {
  positions: Float32Array
  /** ARKit name -> per-vertex deltas. */
  targets: Record<string, Float32Array>
  /** The head surface without the eyeballs, for rays and closest points. */
  head: THREE.Mesh
  /** The head surface's triangles. */
  faces: Uint32Array
  /** Per vertex near the mouth: 1 on the upper lip side, 0 on the lower. */
  lipSide: Float32Array
}

/** The reference head's file, which computeFace() reads. */
export const TEMPLATE = new URL('../../../assets/face.glb', import.meta.url)

let loading: Promise<Template> | undefined

export function template(): Promise<Template> {
  // a failed load is forgotten, so the next call retries
  loading ??= load().catch((error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}

/** (x, y, z) facing +z -> facing +x with the left at -z. */
function turn(source: ArrayLike<number>): Float32Array {
  const out = new Float32Array(source.length)
  for (let i = 0; i < source.length; i += 3) {
    out[i] = source[i + 2]
    out[i + 1] = source[i + 1]
    out[i + 2] = -source[i]
  }
  return out
}

async function load(): Promise<Template> {
  const gltf = await new GLTFLoader().parseAsync(await read(TEMPLATE), '')
  let source: THREE.Mesh | undefined
  gltf.scene.traverse((node) => { if (node instanceof THREE.Mesh) source = node })
  if (!source?.morphTargetDictionary) throw new Error('face: the face template has no morph targets')
  const geometry = source.geometry
  const positions = turn(geometry.getAttribute('position').array)
  const morphs = geometry.morphAttributes.position
  if (!morphs) throw new Error('face: the face template has no position morphs')
  const targets: Record<string, Float32Array> = {}
  for (const [name, i] of Object.entries(source.morphTargetDictionary)) {
    const delta = turn(morphs[i].array)
    if (!geometry.morphTargetsRelative) for (let k = 0; k < delta.length; k++) delta[k] -= positions[k]
    targets[name] = delta
  }
  const index = geometry.getIndex()
  if (!index) throw new Error('face: the face template has no index')
  const faces = headFaces(positions, Uint32Array.from(index.array))
  const head = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3)).setIndex(new THREE.BufferAttribute(faces, 1)))
  return { positions, targets, head, faces, lipSide: lipSide(head.geometry, faces) }
}

/** The triangles of the largest connected piece: the head without its eyeballs. */
function headFaces(positions: Float32Array, index: Uint32Array): Uint32Array {
  const head = new Set(meshPieces(positions, index)[0].vertices)
  const kept: number[] = []
  for (let t = 0; t < index.length; t += 3) if (head.has(index[t])) kept.push(index[t], index[t + 1], index[t + 2])
  return Uint32Array.from(kept)
}

/** Upper (1) vs lower (0) lip side: harmonic from the two halves of the mouth hole, split at its corners. */
function lipSide(head: THREE.BufferGeometry, index: Uint32Array): Float32Array {
  const p = head.getAttribute('position').array
  const count = new Map<string, number>()
  for (let i = 0; i < index.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = index[i + k], b = index[i + (k + 1) % 3]
    const key = a < b ? `${a},${b}` : `${b},${a}`
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  // open edges below the eyes: the mouth hole (the neck opening lies far lower)
  const hole = new Set<number>()
  for (const [key, c] of count) if (c === 1) for (const v of key.split(',').map(Number)) if (p[v * 3 + 1] > 1.58) hole.add(v)
  const loop = [...hole]
  const left = loop.reduce((a, b) => (p[b * 3 + 2] < p[a * 3 + 2] ? b : a))
  const right = loop.reduce((a, b) => (p[b * 3 + 2] > p[a * 3 + 2] ? b : a))
  const chord = (z: number) => p[left * 3 + 1] + (p[right * 3 + 1] - p[left * 3 + 1]) * (z - p[left * 3 + 2]) / (p[right * 3 + 2] - p[left * 3 + 2])
  const { node, adj } = surfaceGraph(head, Int32Array.from({ length: p.length / 3 }, (_, i) => i))
  const active = new Uint8Array(adj.length)
  for (let v = 0; v < adj.length; v++) active[node[v]] = Math.hypot(p[v * 3] - 0.09, p[v * 3 + 1] - 1.627, p[v * 3 + 2]) < 0.06 ? 1 : 0
  const fixed = new Map<number, number>()
  for (const v of loop) fixed.set(node[v], p[v * 3 + 1] > chord(p[v * 3 + 2]) ? 1 : 0)
  return harmonic(adj, fixed, active, 3000, 0.5)
}

/** Template lip contact at lateral z: its lips interpenetrate slightly at rest, so the lip curves cross; the front-most crossing. */
function lipContact(t: Template, z: number): THREE.Vector3 | undefined {
  const p = t.positions
  const index = t.faces
  const segments: THREE.Vector3[][] = []
  for (let i = 0; i < index.length; i += 3) {
    const crossing: THREE.Vector3[] = []
    for (let e = 0; e < 3; e++) {
      const a = index[i + e], b = index[i + (e + 1) % 3]
      const sa = p[a * 3 + 2] - z, sb = p[b * 3 + 2] - z
      if ((sa < 0) === (sb < 0)) continue
      const k = sa / (sa - sb)
      const q = new THREE.Vector3(p[a * 3] + (p[b * 3] - p[a * 3]) * k, p[a * 3 + 1] + (p[b * 3 + 1] - p[a * 3 + 1]) * k, z)
      if (q.y > 1.612 && q.y < 1.642 && q.x > 0.06) crossing.push(q)
    }
    if (crossing.length === 2) segments.push(crossing)
  }
  if (!segments.length) return undefined
  const front = Math.max(...segments.flat().map((q) => q.x))
  const near = segments.filter((s) => s[0].x > front - 0.01 && s[1].x > front - 0.01)
  let best: THREE.Vector3 | undefined
  for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
    const [a, b] = near[i], [c, d] = near[j]
    const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
    if (Math.abs(den) < 1e-14) continue
    const u = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den
    const v = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den
    // shared endpoints are neighbors, not crossings
    if (u <= 1e-6 || u >= 1 - 1e-6 || v <= 1e-6 || v >= 1 - 1e-6) continue
    const q = new THREE.Vector3(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, z)
    if (!best || q.x > best.x) best = q
  }
  return best
}

/** Lateral sample positions along a lip line from the left corner (-1) to the right (1). */
export const LIP_SAMPLES = Array.from({ length: 13 }, (_, i) => -1 + i / 6)

/** The template's lip line at LIP_SAMPLES; near the corners, where no crossing exists, the nearest found point carried outward. */
export function templateLipLine(t: Template): THREE.Vector3[] {
  const samples = LIP_SAMPLES.map((u) => u * MOUTH_HALF_WIDTH)
  const found = samples.map((z) => lipContact(t, z))
  const ok = found.flatMap((q, i) => (q ? [{ q, i }] : []))
  if (ok.length < samples.length / 2) throw new Error(`face: template lip contact found in only ${ok.length} of ${samples.length} slices`)
  return found.map((q, i) => {
    if (q) return q
    const near = ok.reduce((a, b) => (Math.abs(b.i - i) < Math.abs(a.i - i) ? b : a))
    return new THREE.Vector3(near.q.x - 0.004 * Math.abs(i - near.i), near.q.y, samples[i])
  })
}

/** Half the template's mouth width: its corners sit at z = ±MOUTH_HALF_WIDTH. */
const MOUTH_HALF_WIDTH = 0.0255
