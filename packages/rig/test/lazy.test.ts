import './offline.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three'
import { makeCapsule } from './capsule.js'

// Run with `--warm`, this file only warms the face load below in the working directory, as the cache plugin would.
const warming = process.argv.includes('--warm')

// body-only loads must not load the face code, and face loads that hit the cache must not load the rigging code
const resolved: string[] = []
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context)
    resolved.push(result.url)
    return result
  },
})
const { CachedRigLoader } = await import('../dist/index.js')
const faceLoad = async () => {
  // imported here, after the body-only load, as head.ts imports the face runtime
  const { geometry, landmarks } = await (await import('./head.js')).closedHead()
  return new CachedRigLoader().loadAsync({
    object: () => new Group().add(new Mesh(geometry, new MeshBasicMaterial())),
    skeleton: [{ name: 'Head', position: [0, 1.55, 0] }, { name: 'Top', parent: 'Head', position: [0, 1.8, 0] }],
    resolution: 16,
    face: { landmarks, head: 'Head' },
  })
}
const faceModules = (urls: string[]) => [...new Set(urls.filter((url) => url.includes('/dist/face/')).map((url) => url.slice(url.indexOf('/dist/face/') + 11)))].sort()

if (warming) {
  await faceLoad().then((result) => result.dispose())
} else {
  const directory = await mkdtemp(join(tmpdir(), 'rig-lazy-'))
  const cwd = process.cwd()
  try {
    process.chdir(directory)
    const mesh = makeCapsule()
    const body = await new CachedRigLoader().loadAsync({
      object: () => {
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
        geometry.setIndex(new BufferAttribute(mesh.indices, 1))
        return new Group().add(new Mesh(geometry, new MeshBasicMaterial()))
      },
      skeleton: [{ name: 'body', position: [0, -0.9, 0] }, { name: 'tip', parent: 'body', position: [0, 0.9, 0] }],
      resolution: 16,
    })
    body.dispose()
    assert.deepEqual(faceModules(resolved), ['contract.js', 'wrinkles.js'], 'a body-only load imports only the face contract and wrinkles()')

    execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--warm'], { cwd: directory, stdio: 'inherit' })
    resolved.length = 0
    const face = await faceLoad()
    assert.ok(face.face?.shapes.includes('jawOpen'))
    face.dispose()
    const loaded = faceModules(resolved)
    assert.ok(loaded.includes('cache.js'), 'the face load ran')
    assert.deepEqual(loaded.filter((path) => path.startsWith('rig/')), [], 'a face load that hits the cache imports none of the rigging code')
    assert.ok(!resolved.some((url) => url.includes('meshoptimizer') && url.includes('encoder')), 'nor the encoder that stores it')
  } finally {
    process.chdir(cwd)
    await rm(directory, { recursive: true, force: true })
  }
  console.log('lazy face loading ok')
}
