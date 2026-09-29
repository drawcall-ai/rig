/**
 * The CLI end to end on the Fox sample: text and JSON voxel output, skinning
 * to a file, and usage errors.
 *
 *   pnpm --filter @drawcall/skinning test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const fox = fileURLToPath(new URL('./fixtures/fox.glb', import.meta.url))

function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

{
  const { code, stdout } = run('help')
  assert.equal(code, 0)
  assert.match(stdout, /skinning voxel/)
  assert.match(stdout, /skinning skin/)
}

{
  const { code, stdout } = run('voxel', fox, '--resolution', '32')
  assert.equal(code, 0)
  assert.match(stdout, /^mesh: 1728 vertices/)
  for (const heading of ['front view', 'side view', 'top view']) assert.match(stdout, new RegExp(heading))
}

{
  // Slices replace the projections; four legs plus the tail cross y=15
  const { code, stdout } = run('voxel', fox, '--resolution', '32', '--slice', 'y=15,60', '--slice', 'x=0')
  assert.equal(code, 0)
  assert.doesNotMatch(stdout, /front view/)
  assert.match(stdout, /slice y=\S+ \(the cell layer containing y=15\): 5 regions/)
  assert.match(stdout, /slice y=\S+ .*: \d+ regions/)
  assert.match(stdout, /slice x=/)
  assert.match(stdout, /  E: \d+ cells, center x=/)
}

{
  const { code, stdout } = run('voxel', fox, '--resolution', '32', '--json')
  assert.equal(code, 0)
  const json = JSON.parse(stdout)
  const [dimX, dimY, dimZ] = json.dimensions
  assert.equal(Math.max(dimX, dimY, dimZ), 32)
  const bits = Buffer.from(json.occupancy, 'base64')
  let filled = 0
  for (const byte of bits) for (let b = 0; b < 8; b++) filled += (byte >> b) & 1
  assert.equal(filled, json.filled)
}

{
  const dir = mkdtempSync(join(tmpdir(), 'skinning-cli-'))
  const out = join(dir, 'fox.glb')
  const skeleton = JSON.stringify({
    bones: [
      { name: 'body', position: [0, 40, -30], tail: [0, 40, 20] },
      { name: 'head', parent: 'body', position: [0, 55, 30], tail: [0, 60, 55] },
    ],
  })
  const { code, stdout } = run('skin', fox, '--skeleton', skeleton, '--out', out, '--resolution', '64')
  assert.equal(code, 0, stdout)
  assert.ok(existsSync(out))
  assert.match(stdout, /^wrote /)
  assert.match(stdout, /head\s+\d+/)
  rmSync(dir, { recursive: true })
}

{
  const missing = run('skin', fox)
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /--skeleton/)
  const unknownParent = run('skin', fox, '--skeleton', '{"bones":[{"name":"a","parent":"b","position":[0,0,0]}]}')
  assert.equal(unknownParent.code, 1)
  assert.match(unknownParent.stderr, /unknown parent "b"/)
  const badSlice = run('voxel', fox, '--slice', 'w=1')
  assert.equal(badSlice.code, 1)
  assert.match(badSlice.stderr, /--slice expects/)
}

console.log('cli.test.ts passed')
