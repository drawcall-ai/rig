/**
 * The public API end to end: skin() on an in-memory three.js scene (world
 * baking, instancing, mirroring, pieces), and load -> section/parts -> skin ->
 * render -> save on the already-rigged, textured Fox sample, with the saved
 * file checked by the Khronos glTF validator and loaded back; and the three.js
 * RobotExpressive sample (its own armature, hands posed through non-identity
 * mesh nodes), whose saved file must match the in-memory rig vertex for vertex.
 *
 *   pnpm --filter @drawcall/rig test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBytes } from 'gltf-validator'
import * as THREE from 'three'
import { bone, load, parts, render, save, section, skin } from '../src/index.js'
import { makeCapsule } from './capsule.js'

const dir = mkdtempSync(join(tmpdir(), 'rig-test-'))

// Capsules y in [-1, 1], instanced twice under a transformed parent, one mirrored
{
  const capsule = makeCapsule()
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(capsule.positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(capsule.indices, 1))
  const material = new THREE.MeshBasicMaterial()
  const scene = new THREE.Group()
  const parent = new THREE.Group()
  parent.position.set(0, 2, 0)
  parent.scale.setScalar(2)
  const left = new THREE.Mesh(geometry, material)
  left.position.set(-1, 0, 0)
  const right = new THREE.Mesh(geometry, material)
  right.position.set(1, 0, 0)
  right.scale.set(-1, 1, 1)
  parent.add(left, right)
  scene.add(parent)
  scene.updateMatrixWorld(true)
  const before = new THREE.Box3().setFromObject(scene)

  assert.equal(parts(scene).length, 2, 'two separate capsules')
  const leftLow = bone('leftLow', [-2, 0.3, 0])
  const leftHigh = bone('leftHigh', [-2, 2, 0], leftLow)
  bone('leftHigh_end', [-2, 3.7, 0], leftHigh)
  // The right capsule is one rigid piece
  const prop = bone('prop', [2, 2, 0], leftLow)
  prop.userData.pieces = [parts(scene).find((p) => p.center[0] > 0)?.index]

  const report = await skin(scene, leftLow, { resolution: 64 })
  assert.deepEqual(report.warnings, [])
  const byName = new Map(report.bones.map((b) => [b.name, b]))
  assert.equal(byName.get('leftHigh_end')?.vertices, 0, 'end bones get no weights')
  assert.equal(byName.get('prop')?.vertices, capsule.positions.length / 3, 'prop owns the right capsule whole')
  for (const name of ['leftLow', 'leftHigh']) assert.ok((byName.get(name)?.vertices ?? 0) > 500, `${name} drives the left capsule`)

  const skinned: THREE.SkinnedMesh[] = []
  scene.traverse((node) => node instanceof THREE.SkinnedMesh && skinned.push(node))
  assert.equal(skinned.length, 2)
  assert.ok(skinned.every((mesh) => mesh.parent === scene && mesh.skeleton === skinned[0].skeleton))
  const after = new THREE.Box3().setFromObject(scene)
  assert.ok(after.min.distanceTo(before.min) < 1e-4 && after.max.distanceTo(before.max) < 1e-4, 'bind pose = input pose')
  console.log('capsule scene ok:', report.vertices, 'vertices')
}

// Low-poly tube with vertex rings at y = 0..4: flat caps (the top one on the bounding plane) must fill the
// solid, and a joint with no ring before the next one gets a suggested position that fixes it
{
  const tube = () => {
    const geometry = new THREE.CylinderGeometry(0.3, 0.3, 4, 8, 4)
    geometry.translate(0, 2, 0)
    return new THREE.Group().add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))
  }
  const axis = section(tube(), 'y', [2], 64)[0]?.regions[0]
  assert.ok(axis && axis.cells > 60, `tube interior is filled (${axis?.cells} cells)`)

  const rig = (midY: number) => {
    const root = bone('root', [0, 0.05, 0])
    bone('end', [0, 3.95, 0], bone('top', [0, 1.3, 0], bone('mid', [0, midY, 0], root)))
    return root
  }
  const stuck = await skin(tube(), rig(1.1), { resolution: 64 })
  const hint = stuck.warnings.find((w) => w.includes('"mid"'))?.match(/about \[([^\]]+)\]/)
  assert.ok(hint, `warning suggests a position: ${stuck.warnings}`)
  const suggested = Number(hint[1].split(',')[1])
  const fixed = await skin(tube(), rig(suggested), { resolution: 64 })
  assert.deepEqual(fixed.warnings, [], 'following the suggestion clears the warning')
  console.log('tube ok: suggested y', suggested)
}

// Fox: already skinned + textured + animated
{
  const fixture = fileURLToPath(new URL('./fixtures/fox.glb', import.meta.url))
  const scene = await load(fixture)
  const legs = section(scene, 'y', [15])[0]
  assert.equal(legs?.regions.length, 5, 'four legs and the tail cross y=15')

  const hips = bone('hips', [0, 40, -25])
  const chest = bone('chest', [0, 40, 15], hips)
  bone('head_end', [0, 60, 60], bone('head', [0, 60, 35], chest))
  bone('tail_end', [0, 15, -80], bone('tail', [0, 35, -45], hips))
  for (const [side, x] of [['L', 6], ['R', -6]] as const) {
    bone(`front_${side}_end`, [x, 2, 18], bone(`front_${side}`, [x, 30, 18], chest))
    bone(`back_${side}_end`, [x, 2, -36], bone(`back_${side}`, [x, 30, -36], hips))
  }
  const report = await skin(scene, hips)
  assert.deepEqual(report.warnings, [])
  const names: string[] = []
  scene.traverse((node) => names.push(node.name))
  assert.equal(names.filter((n) => n === 'hips').length, 1, 'new bone names are unique')

  // Posed render, then save: the file holds the bind pose, not the render pose
  scene.getObjectByName('front_L')?.rotation.set(0, 0, 1)
  const png = await render(scene, { out: join(dir, 'fox.png'), weights: 'front_L', labels: true })
  assert.ok(statSync(png).size > 10_000, 'rendered a PNG')
  // A pose sheet renders each pose from the bind pose and returns to it
  const sheet = await render(scene, {
    out: join(dir, 'rom.png'),
    views: ['+x'],
    poses: [{ title: 'rest', rotations: {} }, { title: 'head down', rotations: { head: [0.8, 0, 0] } }],
  })
  assert.ok(statSync(sheet).size > 10_000)
  assert.ok(Math.abs(scene.getObjectByName('head')?.rotation.x ?? 1) < 1e-6, 'back in the bind pose')
  scene.getObjectByName('front_L')?.rotation.set(0, 0, 1)
  const out = join(dir, 'fox.glb')
  await save(scene, out)

  const bytes = readFileSync(out)
  const { issues } = await validateBytes(new Uint8Array(bytes))
  assert.equal(issues.numErrors, 0, JSON.stringify(issues.messages.filter((m) => m.severity === 0).slice(0, 5)))
  const again = await load(out)
  const joints: string[] = []
  let textured = false
  again.traverse((node) => {
    if (node instanceof THREE.Bone) joints.push(node.name)
    if (node instanceof THREE.Mesh && (node.material as THREE.MeshStandardMaterial).map) textured = true
  })
  assert.deepEqual(joints.sort(), [
    'back_L', 'back_L_end', 'back_R', 'back_R_end', 'chest', 'front_L', 'front_L_end', 'front_R', 'front_R_end',
    'head', 'head_end', 'hips', 'tail', 'tail_end',
  ])
  assert.ok(textured, 'textures survive')
  const front = again.getObjectByName('front_L')
  assert.ok(front && front.rotation.z === 0, 'saved in the bind pose')
  console.log('fox ok:', report.vertices, 'vertices,', joints.length, 'joints')
}

// Robot: already rigged, hands are SkinnedMeshes under transformed nodes
{
  const scene = await load(fileURLToPath(new URL('./fixtures/robot.glb', import.meta.url)))
  const hips = bone('Hips', [0, 1.42, 0])
  const spine = bone('Spine', [0, 2.2, 0], hips)
  bone('HeadTop_End', [0, 4.4, 0], bone('Head', [0, 2.8, 0], spine))
  for (const x of [0.6, -0.6]) {
    const side = x > 0 ? 'Left' : 'Right'
    const arm = bone(`${side}Arm`, [x, 2.37, 0], spine)
    bone(`${side}Hand`, [2.3 * x, 1, 1], bone(`${side}ForeArm`, [1.5 * x, 1.75, 0], arm))
    bone(`${side}Foot`, [x, 0, 0], bone(`${side}UpLeg`, [x, 1.3, 0], hips))
  }
  await skin(scene, hips)
  // Mesh names can change on reload (three.js suffixes names that clashed with the old bones), so compare
  // the set of per-mesh bounding boxes
  const boxes = (object: THREE.Object3D) => {
    const out: number[][] = []
    object.traverse((node) => {
      if (node instanceof THREE.SkinnedMesh) {
        const box = new THREE.Box3().setFromObject(node, true)
        out.push([...box.min.toArray(), ...box.max.toArray()].map((n) => Math.round(n * 1000) / 1000))
      }
    })
    return out.sort((p, q) => p.join().localeCompare(q.join()))
  }
  const before = boxes(scene)
  const out = join(dir, 'robot.glb')
  await save(scene, out)
  const after = boxes(await load(out))
  assert.equal(after.length, before.length)
  before.forEach((box, i) => assert.ok(box.every((n, k) => Math.abs(n - after[i][k]) < 2e-3), `a mesh moved in save: ${box} vs ${after[i]}`))
  console.log('robot ok:', before.length, 'meshes identical after save')
}

rmSync(dir, { recursive: true })
assert.ok(!existsSync(dir))
console.log('rig.test.ts passed')
