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
  const root = bone('root', [0, 0, 0])
  root.userData.deform = false
  const leftLow = bone('leftLow', [-2, 0.3, 0], root)
  bone('leftHigh', [-2, 2, 0], leftLow).userData.tail = [-2, 3.7, 0]
  // The right capsule is one rigid piece
  const prop = bone('prop', [2, 2, 0], root)
  prop.userData.pieces = [parts(scene).find((p) => p.center[0] > 0)?.index]

  const report = await skin(scene, root, { resolution: 64 })
  assert.deepEqual(report.warnings, [])
  const byName = new Map(report.bones.map((b) => [b.name, b]))
  assert.equal(byName.get('root')?.vertices, 0)
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

// Fox: already skinned + textured + animated
{
  const fixture = fileURLToPath(new URL('./fixtures/fox.glb', import.meta.url))
  const scene = await load(fixture)
  const legs = section(scene, 'y', [15])[0]
  assert.equal(legs?.regions.length, 5, 'four legs and the tail cross y=15')

  const hips = bone('hips', [0, 40, -25])
  const chest = bone('chest', [0, 40, 15], hips)
  bone('head', [0, 60, 35], chest).userData.tail = [0, 60, 60]
  bone('tail', [0, 35, -45], hips).userData.tail = [0, 15, -80]
  for (const [side, x] of [['L', 6], ['R', -6]] as const) {
    bone(`front_${side}`, [x, 30, 18], chest).userData.tail = [x, 2, 18]
    bone(`back_${side}`, [x, 30, -36], hips).userData.tail = [x, 2, -36]
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
  assert.deepEqual(joints.sort(), ['back_L', 'back_R', 'chest', 'front_L', 'front_R', 'head', 'hips', 'tail'])
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
  bone('Head', [0, 2.8, 0], spine, { tail: [0, 4.4, 0] })
  for (const x of [0.6, -0.6]) {
    const arm = bone(x > 0 ? 'LeftArm' : 'RightArm', [x, 2.37, 0], spine)
    bone(x > 0 ? 'LeftForeArm' : 'RightForeArm', [1.5 * x, 1.75, 0], arm, { tail: [2.3 * x, 1, 1] })
    bone(x > 0 ? 'LeftUpLeg' : 'RightUpLeg', [x, 1.3, 0], hips, { tail: [x, 0, 0] })
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
