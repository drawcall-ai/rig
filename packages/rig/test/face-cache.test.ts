import './offline.js'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Bone, Box3, BufferGeometry, Float32BufferAttribute, Group, Mesh, type Object3D, MeshDepthMaterial, MeshStandardMaterial, Quaternion, Skeleton, SkinnedMesh, SphereGeometry, Uint16BufferAttribute, Vector3 } from 'three'
import { CachedRigLoader, pieces, type RigResult } from '../dist/index.js'
import { ALL } from '../dist/face/rig/landmarks.js'
import { closedHead, rigFace } from './head.js'

// CachedRigLoader's face rig: keyed by the model going into it, stored as data, and applied alike on every hit
const directory = await mkdtemp(join(tmpdir(), 'rig-face-cache-'))
const cwd = process.cwd()
const post = Worker.prototype.postMessage
let jobs = 0
Worker.prototype.postMessage = function (...args) {
  const message: unknown = args[0]
  if (typeof message === 'object' && message !== null && 'positions' in message && message.positions instanceof Float32Array) jobs++
  return post.apply(this, args)
}

/** The positions of every skinned mesh of `result`. */
function positions(result: RigResult): number[][] {
  const values: number[][] = []
  result.object.traverse((entry) => {
    if (entry instanceof SkinnedMesh) values.push(Array.from(entry.geometry.getAttribute('position').array))
  })
  return values
}

/** Asserts LeftEye rests in the face's frame for a face turned by `turn` from looking along +z: +Z forward, +X its left. */
function assertEyeFrame(result: RigResult, turn: Quaternion): void {
  const eye = result.skeleton.getBoneByName('LeftEye')
  assert.ok(eye)
  const rotation = eye.getWorldQuaternion(new Quaternion())
  const axis = (x: number, y: number, z: number) => new Vector3(x, y, z).applyQuaternion(rotation).dot(new Vector3(x, y, z).applyQuaternion(turn))
  assert.ok(axis(0, 0, 1) > 0.999, 'LeftEye +Z looks forward')
  assert.ok(axis(1, 0, 0) > 0.999, "LeftEye +X points to the character's left")
}

try {
  process.chdir(directory)
  const { geometry, landmarks } = await closedHead()
  // smaller than the face rig's eyeballs, so its piece index shifts once it adds them
  const hat = new Mesh(new SphereGeometry(0.06, 32, 16).translate(0, 1.95, 0), new MeshStandardMaterial())
  hat.name = 'Hat'
  const depth = new MeshDepthMaterial()
  const hatted = () => {
    const head = new Mesh(geometry.clone(), new MeshStandardMaterial())
    head.castShadow = true
    head.layers.set(2)
    head.customDepthMaterial = depth
    return new Group().add(head, hat.clone())
  }
  const hatPiece = pieces(hatted()).find((piece) => piece.mesh === 'Hat')
  assert.ok(hatPiece)
  const faced = () => new CachedRigLoader().loadAsync({
    object: hatted,
    skeleton: [
      { name: 'Head', position: [0, 1.55, 0] },
      { name: 'Top', parent: 'Head', position: [0, 1.8, 0] },
      { name: 'HatBone', parent: 'Head', position: [0, 1.9, 0], pieces: [hatPiece.index] },
    ],
    resolution: 16,
    face: { landmarks, head: 'Head' },
  })
  const engine = await faced()
  assert.equal(jobs, 1)
  const bound = (mesh: string) => {
    const skinned = engine.object.getObjectByName(mesh)
    assert.ok(skinned instanceof SkinnedMesh)
    const index = skinned.geometry.getAttribute('skinIndex'), weight = skinned.geometry.getAttribute('skinWeight')
    return new Set(Array.from({ length: index.count }, (_, v) => (weight.getX(v) === 1 ? engine.skeleton.bones[index.getX(v)].name : 'blended')))
  }
  assert.deepEqual(bound('Hat'), new Set(['HatBone']), 'a piece index names the model as created, before the face rig adds bigger pieces')
  assert.deepEqual(bound('EyeLeft'), new Set(['LeftEye']))
  assert.deepEqual(bound('Tongue'), new Set(['Teeth']))
  // render state the load's function sets, shadow depth material included, survives skinning and reaches the parts the
  // face rig adds
  const shadowed: string[] = []
  engine.object.traverse((node) => { if (node instanceof Mesh && node.castShadow && node.layers.isEnabled(2) && node.customDepthMaterial === depth) shadowed.push(node.name) })
  assert.deepEqual(shadowed.sort(), ['', 'Cavity', 'EyeLeft', 'EyeRight', 'Face', 'TeethLower', 'TeethUpper', 'Tongue'])
  // skinning moves every mesh directly under the object, the face's parts beside the face mesh
  const skinnedChildren = engine.object.children.filter((child) => child instanceof SkinnedMesh).map((child) => child.name)
  assert.deepEqual(skinnedChildren.sort(), ['', 'Cavity', 'EyeLeft', 'EyeRight', 'Face', 'Hat', 'TeethLower', 'TeethUpper', 'Tongue'])
  // the stored face rig is data: perturbed math, as another engine might round it, does not reach the result
  const cos = Math.cos
  // an ulp toward zero
  Math.cos = (x) => cos(x) * (1 - Number.EPSILON / 2)
  const rounded = await faced().finally(() => { Math.cos = cos })
  assert.deepEqual(positions(rounded), positions(engine), 'a face load applies the stored face rig')
  assert.equal(jobs, 1, 'and so reuses the weights of the geometry it skins')
  // the face looks along +z with +x its left, so the eye bones rest unturned, computed or read from the cache
  for (const result of [engine, rounded]) assertEyeFrame(result, new Quaternion())
  // the stored rig matches the face rigged directly, its morph deltas within their quantization
  const direct = hatted()
  await rigFace(direct, { landmarks, head: 'Head' })
  const morphs = (object: Object3D) => {
    const found = object.getObjectByName('Face')
    assert.ok(found instanceof Mesh)
    const geometry: BufferGeometry = found.geometry
    const deltas = geometry.morphAttributes.position ?? []
    return new Map(Object.entries(found.morphTargetDictionary ?? {}).map(([name, i]) => [name, Array.from(deltas[i].array)]))
  }
  const [stored, fresh] = [morphs(rounded.object), morphs(direct)]
  assert.deepEqual([...stored.keys()], [...fresh.keys()])
  for (const [name, deltas] of fresh) {
    const max = Math.max(...deltas.map(Math.abs))
    const read = stored.get(name) ?? []
    assert.ok(deltas.every((x, i) => Math.abs(x - read[i]) <= max * 1e-4), `${name} round-trips`)
  }
  engine.dispose()
  rounded.dispose()

  // the same head in the same place, scaled by its container or by its mesh, rigs alike but stores its edit apart, as
  // the edit is in the meshes' coordinates; a turned container keys alike in an engine whose sin and cos round otherwise
  const container = new Group()
  container.rotation.y = Math.PI / 2
  container.scale.setScalar(2)
  container.updateMatrix()
  const place = (p: readonly number[]) => new Vector3(p[0], p[1], p[2]).applyMatrix4(container.matrix).toArray()
  const placedLandmarks = { ...landmarks }
  for (const name of ALL) placedLandmarks[name] = place(landmarks[name])
  const placed = (object: () => Object3D) => new CachedRigLoader().loadAsync({
    object,
    skeleton: [{ name: 'Head', position: place([0, 1.55, 0]) }, { name: 'Top', parent: 'Head', position: place([0, 1.8, 0]) }],
    resolution: 16,
    face: { landmarks: placedLandmarks, head: 'Head' },
  })
  const scaledGroup = () => {
    const group = new Group().add(new Mesh(geometry.clone(), new MeshStandardMaterial()))
    group.rotation.y = Math.PI / 2
    group.scale.setScalar(2)
    return group
  }
  const scaledMesh = () => {
    const mesh = new Mesh(geometry.clone(), new MeshStandardMaterial())
    mesh.scale.setScalar(2)
    const group = new Group().add(mesh)
    group.rotation.y = Math.PI / 2
    return group
  }
  const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)
  const byGroup = await placed(scaledGroup)
  assert.equal(jobs, 2)
  assertEyeFrame(byGroup, turn)
  const [sin, cosine] = [Math.sin, Math.cos]
  Math.sin = (x) => sin(x) * (1 - Number.EPSILON / 2)
  Math.cos = (x) => cosine(x) * (1 - Number.EPSILON / 2)
  const reread = await placed(scaledGroup).finally(() => { [Math.sin, Math.cos] = [sin, cosine] })
  assert.equal(jobs, 2, 'a turn rounded otherwise reuses the face rig and weights')
  const byMesh = await placed(scaledMesh)
  assert.equal(jobs, 3, 'the same world geometry split differently between transforms is rigged apart')
  assertEyeFrame(byMesh, turn)
  const eyeCenter = (result: RigResult) => {
    const eye = result.object.getObjectByName('EyeLeft')
    assert.ok(eye instanceof Mesh)
    eye.updateWorldMatrix(true, false)
    return new Box3().setFromObject(eye).getCenter(new Vector3())
  }
  assert.ok(eyeCenter(byMesh).distanceTo(eyeCenter(byGroup)) < 1e-4, 'and so its eye sits where the other split puts it')
  assert.ok(eyeCenter(reread).distanceTo(eyeCenter(byGroup)) < 1e-6, 'the reused rig puts the eye where it was')
  for (const result of [byGroup, reread, byMesh]) result.dispose()

  // an already-skinned head, as auto-rigged models come, rigs in the pose its bones hold
  const skinnedHatted = () => {
    const armature = new Bone()
    armature.name = 'Head'
    const head = new SkinnedMesh(geometry.clone().translate(0, -1, 0), new MeshStandardMaterial())
    head.receiveShadow = true
    const count = head.geometry.getAttribute('position').count
    head.geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(count * 4), 4))
    head.geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4))
    const group = new Group().add(head, hat.clone(), armature)
    head.bind(new Skeleton([armature]))
    armature.position.y = 1
    return group
  }
  const reskinned = await new CachedRigLoader().loadAsync({
    object: skinnedHatted,
    skeleton: [
      { name: 'Head', position: [0, 1.55, 0] },
      { name: 'Top', parent: 'Head', position: [0, 1.8, 0] },
      { name: 'HatBone', parent: 'Head', position: [0, 1.9, 0], pieces: [hatPiece.index] },
    ],
    resolution: 16,
    face: { landmarks, head: 'Head' },
  })
  assert.ok(reskinned.face?.shapes.includes('jawOpen'))
  assert.ok(reskinned.object.getObjectByName('Head_source') === undefined, 'the old armature is dropped')
  assert.ok(reskinned.object.getObjectByName('Face')?.receiveShadow, 'unskinning keeps render state')
  const reskinnedHat = reskinned.object.getObjectByName('Hat')
  assert.ok(reskinnedHat instanceof SkinnedMesh)
  const hatIndex = reskinnedHat.geometry.getAttribute('skinIndex')
  assert.equal(reskinned.skeleton.bones[hatIndex.getX(0)].name, 'HatBone', 'piece indices name the skinned model as created')
  reskinned.dispose()

  // stored entries are read strictly: a corrupt one fails the load rather than rigging from part of it
  const strict = await mkdtemp(join(tmpdir(), 'rig-face-strict-'))
  process.chdir(strict)
  await faced().then((result) => result.dispose())
  const cache = join(strict, 'public', '_cache')
  const files = (await readdir(cache)).filter((name) => name.endsWith('.entry')).map((name) => join(cache, name))
  assert.equal(files.length, 2)
  // an entry file is its header's length, the header as JSON, then the bytes; the face entry records the reference head
  // it was rigged with among its inputs
  const entries = await Promise.all(files.map(async (file) => {
    const content = await readFile(file)
    const start = 4 + content.readUInt32LE(0)
    return { file, content, start, face: content.subarray(4, start).toString().includes('face.glb') }
  }))
  const face = entries.find((entry) => entry.face), weights = entries.find((entry) => !entry.face)
  assert.ok(face && weights)
  await writeFile(face.file, Buffer.concat([face.content, Buffer.of(0)]))
  await assert.rejects(faced(), /the cached face rig has 1 bytes past its end/)
  await writeFile(face.file, face.content.subarray(0, face.content.length - 8))
  await assert.rejects(faced(), /the cached face rig is truncated/)
  await writeFile(face.file, face.content)
  const wrongCount = Buffer.from(weights.content)
  wrongCount.writeUInt32LE(wrongCount.readUInt32LE(weights.start) + 4, weights.start)
  await writeFile(weights.file, wrongCount)
  await assert.rejects(faced(), /Invalid rig cache weight buffers/, 'a weights entry for another vertex count fails')
  process.chdir(directory)
  await rm(strict, { recursive: true, force: true })
  console.log('face cache keys, engine stability, piece indices, render state and stored face rigs ok')
} finally {
  Worker.prototype.postMessage = post
  process.chdir(cwd)
  await rm(directory, { recursive: true, force: true })
}
