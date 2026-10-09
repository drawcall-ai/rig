/**
 * The public API end to end: skin() on an in-memory three.js scene (world
 * baking, instancing, mirroring, pieces), and load -> section/pieces -> skin ->
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
import { bone, load, pick, pieces, render, save, section, skin, type View } from '../src/index.js'
import { pose } from '../src/render/pose.js'
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

  assert.equal(pieces(scene).length, 2, 'two separate capsules')
  const leftLow = bone('leftLow', [-2, 0.3, 0])
  const leftHigh = bone('leftHigh', [-2, 2, 0], leftLow)
  bone('leftHigh_end', [-2, 3.7, 0], leftHigh)
  // The right capsule is one rigid piece
  const prop = bone('prop', [2, 2, 0], leftLow)
  prop.userData.pieces = [pieces(scene).find((p) => p.center[0] > 0)?.index]

  const report = await skin(scene, leftLow, 64)
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
  console.log('capsule scene ok')
}

// Low-poly tube with vertex rings at y = 0..4: flat caps (the top one on the bounding plane) must fill the
// solid, and a joint with no ring before the next one gets a suggested position that fixes it
{
  const tube = () => {
    const geometry = new THREE.CylinderGeometry(0.3, 0.3, 4, 8, 4)
    geometry.translate(0, 2, 0)
    return new THREE.Group().add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))
  }
  const [cut, above] = section(tube(), [{ y: 2 }, { y: 5 }], 64)
  const [inside] = cut.regions
  assert.ok(cut.axis === 'y' && Math.abs(cut.value - 2) < 0.1, `cut at the layer containing y = 2: ${cut.value}`)
  assert.ok(inside && inside.cells > 60, `tube interior is filled (${inside?.cells} cells)`)
  assert.deepEqual(above, { axis: 'y', value: 5, regions: [] }, 'a plane above the tube misses: no regions, the requested value')
  const [, across] = section(tube(), [{ y: 2 }, { x: 0 }], 64)
  assert.ok(across.axis === 'x' && across.regions.length === 1, 'planes may mix axes')
  assert.throws(() => section(tube(), [{ y: 2 }, { x: 0, y: 2 } as never]), /section: plane 1 must name exactly one axis, e\.g\. \{ y: 0\.5 \}/)
  assert.throws(() => section(tube(), [null as never]), /section: plane 0 must name exactly one axis/)
  assert.throws(() => section(tube(), { y: 2 } as never), /section takes a non-empty list of planes/)
  assert.throws(() => section(tube(), []), /section takes a non-empty list of planes/)

  const rig = (midY: number) => {
    const root = bone('root', [0, 0.05, 0])
    bone('end', [0, 3.95, 0], bone('top', [0, 1.3, 0], bone('mid', [0, midY, 0], root)))
    return root
  }
  const stuck = await skin(tube(), rig(1.1), 64)
  const hint = stuck.warnings.find((w) => w.startsWith('bone "mid"'))?.match(/between its joint and "top"'s.*With its joint at about \[([^\]]+)\]/)
  assert.ok(hint, `warning suggests a position: ${stuck.warnings}`)
  const suggested = Number(hint[1].split(',')[1])
  const fixed = await skin(tube(), rig(suggested), 64)
  assert.deepEqual(fixed.warnings, [], 'following the suggestion clears the warning')
  // On a coarse grid a bone without vertices and without a ring gap gets the grouped warning with sizes in voxels
  const coarse = await skin(tube(), rig(1.1), 16)
  assert.ok(
    coarse.warnings.some((w) => /^"root" get no vertices of their own at resolution 16 .*: their parts are about \d+ voxels thick/.test(w)),
    `grouped warning: ${coarse.warnings}`,
  )

  await assert.rejects(skin(tube(), rig(1.1), { resolution: 64 } as never), /resolution must be a positive integer, e.g. skin\(scene, root, 256\)/)
  assert.throws(() => section(tube(), [{ y: 2 }], 0.5), /resolution must be a positive integer/)

  // Removing an old armature keeps what hangs off it: a marker, and the new root attached under an old bone
  const rerigged = tube()
  const oldBone = new THREE.Bone()
  oldBone.position.set(0, 1, 0)
  const marker = new THREE.Object3D()
  marker.position.set(0, 1, 0)
  oldBone.add(marker)
  rerigged.add(oldBone)
  rerigged.updateMatrixWorld(true)
  const newRoot = rig(suggested)
  oldBone.attach(newRoot)
  await skin(rerigged, newRoot, 64)
  assert.equal(oldBone.parent, null, 'old bone removed')
  assert.ok(marker.parent === rerigged && newRoot.parent === rerigged, 'its other children kept')
  assert.ok(marker.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(0, 2, 0)) < 1e-9, 'in place')

  // Not skinned yet: no bind pose, so views show the scene as it is, and posing or weights throw
  const plain = await render(tube(), { out: join(dir, 'tube.png'), views: [[{ camera: '+x' }]] })
  assert.ok(statSync(plain).size > 5_000, 'an unskinned scene renders as it is')
  const holder = new THREE.Group()
  const first = tube()
  holder.add(first, new THREE.Group())
  await render(first, { out: join(dir, 'x.png'), views: [[{ camera: '+x' }]] })
  assert.equal(holder.children[0], first, 'render puts the object back at its index')
  await assert.rejects(render(tube(), { out: join(dir, 'x.png'), views: [[{ camera: '+x', rotations: {} }]] }), /posing needs a skinned scene/)
  await assert.rejects(render(tube(), { out: join(dir, 'x.png'), views: [[{ camera: '+x', weights: true }]] }), /weights needs a skinned scene/)

  // Rotations apply on top of a bone's bind rotation (here turned about its own segment), under a scaled
  // armature node: the bind pose puts every joint back where it was bound
  const turned = tube()
  const root = rig(suggested)
  const top = root.getObjectByName('top')
  assert.ok(top)
  top.rotation.set(0, 0.5, 0)
  const armature = new THREE.Group()
  armature.scale.setScalar(2)
  turned.add(armature)
  turned.updateMatrixWorld(true)
  armature.attach(root)
  await skin(turned, root, 64)
  const joints = () => ['root', 'mid', 'top', 'end'].map((name) => turned.getObjectByName(name)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(NaN))
  const bound = joints()
  pose(turned, {})
  joints().forEach((joint, i) => assert.ok(joint.distanceTo(bound[i]) < 1e-6, `joint ${i} at its bind position`))
  const bind = top.quaternion.clone()
  pose(turned, { rotations: { top: [0.3, 0, 0] } })
  const expected = bind.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, 0)))
  assert.ok(top.quaternion.angleTo(expected) < 1e-6, 'rotation in the bind frame')
  console.log('tube ok: suggested y', suggested)
}

// Two boxes stacked along y with a gap: a pick crosses both, nearest the camera first, with their thickness
{
  const box = (y: number, height: number) => new THREE.Mesh(new THREE.BoxGeometry(1, height, 1).translate(0, y, 0), new THREE.MeshBasicMaterial())
  const scene = new THREE.Group().add(box(0.5, 1), box(2.75, 0.5))
  const near = (a: readonly number[], b: number[], what: string) => assert.ok(a.every((n, i) => Math.abs(n - b[i]) < 0.1), `${what}: ${a} vs ${b}`)
  const [down] = pick(scene, { camera: '+y' }, [{ x: 0.1, z: -0.2 }], 64)
  assert.equal(down.length, 2, 'two spans from above')
  near(down[0].enter, [0.1, 3, -0.2], 'enters the top box at its top')
  near(down[0].exit, [0.1, 2.5, -0.2], 'leaves it at its bottom')
  near(down[1].center, [0.1, 0.5, -0.2], 'the lower box second')
  near([down[0].thickness, down[1].thickness], [0.5, 1], 'thickness')
  const [up] = pick(scene, { camera: '-y' }, [{ x: 0.1, z: -0.2 }], 64)
  near(up[0].enter, [0.1, 0, -0.2], 'from below the lower box comes first')
  // One list per point, in order: the gap between the boxes, then the top box, then beside them
  const [gap, top, beside] = pick(scene, { camera: '+x' }, [{ y: 1.5, z: 0 }, { y: 2.75, z: 0 }, { y: 2.75, z: 5 }], 64)
  assert.deepEqual([gap.length, top.length, beside.length], [0, 1, 0], 'results follow the points')
  // Offsets on both grid axes, each outside the box on the other axis, so swapping them misses
  const [side] = pick(scene, { camera: '+z' }, [{ x: 0.3, y: 2.6 }], 64)
  assert.equal(side.length, 1, 'from +z: the top box only')
  near(side[0].enter, [0.3, 2.6, 0.5], 'enters it at its +z face')
  const [back] = pick(scene, { camera: '-x' }, [{ y: 0.7, z: 0.2 }], 64)
  assert.equal(back.length, 1, 'from -x: the lower box only')
  near(back[0].enter, [-0.5, 0.7, 0.2], 'enters it at its -x face')
  assert.throws(() => pick(scene, { camera: '+y' }, [{ x: 0, z: 0 }, { x: 0, y: 0 }]), /pick: point 1: camera \+y looks along y; give x and z/)
  assert.throws(() => pick(scene, { camera: '-z' }, [{ x: 0 } as never]), /point 0: camera -z looks along z; give x and y/)
  assert.throws(() => pick(scene, { camera: '+y' }, { x: 0, z: 0 } as never), /pick takes a non-empty list of points, e\.g\. pick\(scene, \{ camera: '\+y' \}, \[\{ x: 0\.1, z: 0\.2 \}\]\)/)
  assert.throws(() => pick(scene, { camera: '+y' }, []), /pick takes a non-empty list of points/)
  assert.throws(() => pick(scene, { camera: '+x' }, [null as never]), /pick: point 0: camera \+x looks along x; give y and z, e\.g\. \{ y: 0\.1, z: 0\.2 \}; got null/)
  assert.throws(() => pick(scene, { camera: 'persp' }, [{ x: 0, y: 0 }]), /'persp' has no grid/)
  assert.throws(() => pick(scene, { camera: '+y', isolate: 'any' } as never, [{ x: 0, z: 0 }]), /the view takes only camera, got isolate/)
  assert.throws(() => pick(scene, { camera: '+y', rotations: {} } as never, [{ x: 0, z: 0 }]), /the view takes only camera, got rotations/)
  assert.throws(() => pick(scene, { camera: '-z' }, [{ x: 0, y: 0 }], 0), /resolution must be a positive integer, e\.g\. pick\(scene, \{ camera: '-z' \}, \[\{ x: 0\.1, y: 0\.2 \}\], 256\)/)

  // A sweep of many points gathers the scene once, not once per point: the scene is walked as often for 500
  // points as for one, and every point gets the spans a single pick gives it
  let walks = 0
  const traverse = scene.traverse.bind(scene)
  scene.traverse = (callback) => {
    walks++
    traverse(callback)
  }
  const row = Array.from({ length: 500 }, (_, i) => ({ x: -0.6 + (1.2 * i) / 499, z: 0 }))
  pick(scene, { camera: '+y' }, [row[0]], 64)
  const once = walks
  walks = 0
  const sweep = pick(scene, { camera: '+y' }, row, 64)
  assert.equal(walks, once, `500 points walk the scene ${walks} times, one point ${once}`)
  assert.equal(sweep.length, 500, 'one result per point')
  assert.deepEqual(sweep[250], pick(scene, { camera: '+y' }, [row[250]], 64)[0], 'the same spans as a single pick')
  assert.ok(sweep[0].length === 0 && sweep[250].length === 2, 'the row runs from beside the boxes across both')
  walks = 0
  section(scene, Array.from({ length: 500 }, (_, i) => ({ y: (3 * i) / 499 })), 64)
  const planes = walks
  walks = 0
  section(scene, [{ y: 1 }], 64)
  assert.equal(planes, walks, '500 planes gather the scene once, as one does')
  console.log('pick ok')
}

// Fox: already skinned + textured + animated
{
  const fixture = fileURLToPath(new URL('./fixtures/fox.glb', import.meta.url))
  const scene = await load(fixture)
  const [legs] = section(scene, [{ y: 15 }])
  assert.equal(legs.regions.length, 5, 'four legs and the tail cross y=15')

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

  // Every view starts from the bind pose: a view without a pose renders the same with the scene moved or not.
  // Afterwards each bone's full local transform is as it was.
  const plain = [[{ camera: 'persp', weights: 'front_L', bones: 'names' }]] satisfies View[][]
  const bind = readFileSync(await render(scene, { out: join(dir, 'bind.png'), views: plain }))
  const front = scene.getObjectByName('front_L')
  const hipsBone = scene.getObjectByName('hips')
  assert.ok(front && hipsBone)
  front.rotation.set(0, 0, 1)
  hipsBone.position.x += 5
  hipsBone.scale.setScalar(1.5)
  const moved = await render(scene, { out: join(dir, 'fox.png'), views: plain })
  assert.ok(statSync(moved).size > 10_000, 'rendered a PNG')
  assert.ok(readFileSync(moved).equals(bind), 'a view without a pose renders the bind pose')
  assert.equal(front.rotation.z, 1, 'rotation restored')
  assert.ok(Math.abs(hipsBone.position.x - 5) < 1e-9 && hipsBone.scale.x === 1.5, 'position and scale restored')
  hipsBone.position.x -= 5
  hipsBone.scale.setScalar(1)
  const owners = await render(scene, { out: join(dir, 'owners.png'), views: [[{ camera: '+x', weights: true, isolate: 'chest' }]] })
  assert.ok(statSync(owners).size > 5_000, 'rendered the isolated ownership map')
  const sheet = await render(scene, {
    out: join(dir, 'rom.png'),
    views: [[{ camera: '+x', title: 'rest' }], [{ camera: '+x', title: 'head down', rotations: { head: [0.8, 0, 0] }, focus: 'head' }]],
  })
  assert.ok(statSync(sheet).size > 10_000)
  assert.ok(Math.abs(scene.getObjectByName('head')?.rotation.x ?? 1) < 1e-6, 'head as before')
  await assert.rejects(render(scene, { out: join(dir, 'x.png'), xray: true } as never), /unknown option "xray"/)
  await assert.rejects(render(scene, { out: join(dir, 'x.png'), views: [[{ camera: '+x', pose: {} }]] } as never), /unknown key "pose"/)
  await assert.rejects(render(scene, { out: join(dir, 'x.png'), views: [[{ camera: 'side' }]] } as never), /unknown camera "side"/)
  await assert.rejects(render(scene, { out: join(dir, 'x.png'), views: [[{ camera: '+x', focus: 'nose' }]] }), /focus names unknown bone "nose"/)

  // A pick measures the current pose: both front legs at rest, the raised one forward once posed
  const [across] = pick(scene, { camera: '+x' }, [{ y: 15, z: 18 }])
  assert.equal(across.length, 2, `both front legs: ${JSON.stringify(across)}`)
  assert.ok(across[0].center[0] > 0 && across[1].center[0] < 0, 'front_L (+x) first, seen from +x')
  assert.equal(pick(scene, { camera: '+x' }, [{ y: 28, z: 35 }])[0].length, 0, 'nothing in front of the chest at rest')
  pose(scene, { targets: { front_L: [6, 30, 60] } })
  scene.updateMatrixWorld(true)
  const [left, forward] = pick(scene, { camera: '+x' }, [{ y: 15, z: 18 }, { y: 28, z: 35 }])
  assert.ok(left.length === 1 && left[0].center[0] < 0, `the raised leg left its place, front_R stays: ${JSON.stringify(left)}`)
  assert.ok(forward.length === 1 && forward[0].center[0] > 0, `the raised leg lies forward: ${JSON.stringify(forward)}`)
  pose(scene, {})
  scene.updateMatrixWorld(true)

  // A target turns the bone so its segment points at the world point, after its parents moved
  const at = (name: string) => scene.getObjectByName(name)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(NaN)
  const target = new THREE.Vector3(30, 40, 40)
  pose(scene, { rotations: { chest: [0, 0.3, 0] }, targets: { front_L: target.toArray() } })
  scene.updateMatrixWorld(true)
  const pointing = at('front_L_end').sub(at('front_L')).normalize()
  assert.ok(pointing.angleTo(target.clone().sub(at('front_L'))) < 1e-4, 'front_L points at its target after its parent turned')
  assert.throws(() => pose(scene, { rotations: { nose: [0, 0, 0] } }), /pose names unknown bone "nose"/)
  // Saved from a pose: the file holds the bind pose
  front.rotation.set(0, 0, 1)
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
  const saved = again.getObjectByName('front_L')
  assert.ok(saved && saved.rotation.z === 0, 'saved in the bind pose')
  console.log('fox ok:', joints.length, 'joints')
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
