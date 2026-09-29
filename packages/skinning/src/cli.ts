#!/usr/bin/env node
/**
 * skinning CLI (Node): `voxel` to inspect a model's shape, `skin` to bind it
 * to a skeleton. Help text doubles as the manual for AI agents.
 */

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { NodeIO, type Document } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import draco3d from 'draco3dgltf'
import { MeshoptDecoder } from 'meshoptimizer'
import { computeVoxelVolume, formatVolume, skin, type Axis, type Skeleton, type SkinReport, type Slice } from './index.js'
import { meshParts, readScene } from './scene.js'

const HELP = `skinning: automatic skin weights for any glTF/GLB (CPU only)

Usage:
  skinning voxel <model.glb|.gltf> [--resolution 64] [--slice <axis>=<values>]... [--json]
  skinning skin  <model.glb|.gltf> --skeleton <skeleton.json | inline JSON> [--out <file>] [options]

All coordinates are the model's world space in its own units (voxel prints the
bounds: a model may be 2 units tall or 200). +y is up.

voxel   Show the model's solid shape: vertex count, world bounds and front/side/top
        projections with world-coordinate rulers.
  --resolution <n>   cells along the longest axis (default 64, coarser than skin's
                     128 to keep the pictures readable)
  --slice <a>=<v>    only print cross-sections instead: x, y or z = v, or a list
                     like y=10,30,50; repeatable. Each slice lists its separate solid
                     regions (legs, arms, tail, ...) lettered A, B, ... with world
                     center and extent, then draws them. Use the centers to place joints.
  --json             machine-readable volume (bit-packed occupancy) instead of text

skin    Bind every mesh in the scene to the skeleton and write a skinned glTF.
  --skeleton <s>     skeleton JSON file path, or the JSON text itself
  --out <file>       output .glb or .gltf (default: <model>.skinned.glb)
  --resolution <n>   voxel cells along the longest axis (default 128; raise for thin parts)
  --blur <n>         weight smoothing passes (default 100; 0 = rigid, hard seams).
                     Keep the default: lowering it only to raise a small bone's
                     main count trades smooth joints for creases
  --json             print the report as JSON (adds each bone's resolved tail)

  The report lists per bone:
    main      vertices whose largest weight is this bone
    weighted  vertices with at least 10% weight on it (blending with neighbors)
    inside    share of its segment inside the mesh; only that part attracts weights
    region    world bounds of its main vertices: check each bone covers what you meant
  plus warnings. On low-poly meshes a bone whose segment has no vertex ring near it
  can get 0 main vertices: it still bends its children, but moving its joints so
  a ring of vertices falls between them gives it its own.

Skeleton JSON:
  {
    "bones": [
      { "name": "hips",  "position": [0, 1.0, 0] },
      { "name": "spine", "parent": "hips",  "position": [0, 1.2, 0] },
      { "name": "head",  "parent": "spine", "position": [0, 1.6, 0], "tail": [0, 1.8, 0] }
    ]
  }
  name       unique; becomes the joint node name
  position   joint pivot [x, y, z]; place it inside the mesh, centered in the limb
  parent     parent bone name; omit for the root. Any order. Names: letters, digits, _ or -.
  tail       end of the bone. Default: its first child's position; for a leaf, the
             joint extended by half its parent bone, which often overshoots the
             mesh, so give leaves (head, hooves, tail tips, fingers) a tail.
  deform     false = joint exists but attracts no weights (e.g. a root on the floor)
  pieces     [0, 3] = bind these separate mesh pieces 100% to this bone (glasses,
             armor, props); indices from the "pieces" list that voxel prints
  Each deforming bone pulls in the volume around its segment position->tail. Max 256
  bones. Joints get identity rotations: the bind pose is the model's pose as given.
  Naming sides: a model facing +z has its own left side at +x.

Workflow:
  1. skinning voxel model.glb                             shape, bounds, orientation
  2. skinning voxel model.glb --slice y=10,40,70 --slice x=0   limb centers
  3. write skeleton.json with joints at those centers
  4. skinning skin model.glb --skeleton skeleton.json
  5. check each bone's region and the warnings; adjust joints and rerun
`

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseCommandLine(argv)
  const [command, input, ...extra] = positionals
  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (command !== 'voxel' && command !== 'skin') throw new UsageError(`unknown command "${command}"`)
  if (input === undefined) throw new UsageError(`${command} needs a model path`)
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`)
  if (command === 'skin' && values.skeleton === undefined) throw new UsageError('skin needs --skeleton <file.json | JSON>')

  const io = await createIO()
  const document = await io.read(input)

  if (command === 'voxel') {
    const scene = readScene(document)
    const volume = computeVoxelVolume(scene.positions, scene.indices, {
      resolution: integer(values.resolution, 'resolution', 64, 1),
    })
    if (values.json) {
      const packed = new Uint8Array(Math.ceil(volume.isInsideFlat.length / 8))
      volume.isInsideFlat.forEach((inside, i) => inside && (packed[i >> 3] |= 1 << (i & 7)))
      const json = {
        min: volume.min,
        cellSize: volume.cellSize,
        dimensions: volume.dimensions,
        filled: volume.insideIndices.length,
        layout: 'cell (x, y, z) is bit i = x*dimY*dimZ + y*dimZ + z of occupancy, LSB first; cell center = min + (index + 0.5) * cellSize',
        occupancy: Buffer.from(packed).toString('base64'),
      }
      process.stdout.write(JSON.stringify(json) + '\n')
    } else {
      const meshNodes = new Set(scene.parts.map((part) => part.node)).size
      const pieces = meshParts(scene.positions, scene.indices)
      const round = (v: number[]) => `[${v.map((n) => n.toPrecision(3)).join(', ')}]`
      const pieceLines = pieces
        .slice(0, 40)
        .map((p, i) => `  piece ${i}: ${p.vertices.length} vertices, ${round(p.min)} .. ${round(p.max)}`)
      process.stdout.write(
        `mesh: ${scene.positions.length / 3} vertices, ${scene.indices.length / 3} triangles in ${meshNodes} mesh node(s), ` +
          `${pieces.length} separate piece(s)${pieces.length > 1 ? ' (largest first):\n' + pieceLines.join('\n') : ''}\n` +
          formatVolume(volume, (values.slice ?? []).flatMap(parseSlices)) +
          '\n',
      )
    }
    return
  }

  const report = skin(document, readSkeleton(values.skeleton as string), {
    resolution: integer(values.resolution, 'resolution', 128, 1),
    blurIterations: integer(values.blur, 'blur', 100, 0),
  })
  const out = values.out ?? input.replace(/\.(glb|gltf)$/i, '') + '.skinned.glb'
  await io.write(out, withoutCompression(document))
  process.stdout.write(values.json ? JSON.stringify({ out, ...report }, null, 2) + '\n' : formatReport(out, report))
}

class UsageError extends Error {}

function parseCommandLine(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        resolution: { type: 'string' },
        slice: { type: 'string', multiple: true },
        skeleton: { type: 'string' },
        out: { type: 'string' },
        blur: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
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

function readSkeleton(value: string): Skeleton {
  const text = value.trimStart().startsWith('{') || value.trimStart().startsWith('[') ? value : readFileSync(value, 'utf8')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new UsageError(`skeleton is not valid JSON: ${(error as Error).message}`)
  }
  return (Array.isArray(json) ? { bones: json } : json) as Skeleton
}

/** "y=0.5" or "y=0.2,0.4,0.6" */
function parseSlices(value: string): Slice[] {
  const match = /^([xyz])=(.+)$/i.exec(value.replace(/\s/g, ''))
  const values = match?.[2].split(',').map(Number) ?? []
  if (!match || values.some((n) => !Number.isFinite(n))) {
    throw new UsageError(`--slice expects <axis>=<value>[,<value>...] like y=0.5 or y=0.2,0.4, got "${value}"`)
  }
  return values.map((n) => ({ axis: match[1].toLowerCase() as Axis, value: n }))
}

function integer(value: string | undefined, name: string, fallback: number, min: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > 1024) {
    throw new UsageError(`--${name} must be an integer ${min}..1024, got "${value}"`)
  }
  return n
}

function formatReport(out: string, report: SkinReport): string {
  const [dimX, dimY, dimZ] = report.grid.dimensions
  const round = (v: readonly number[]): string => `[${v.map((n) => n.toFixed(3)).join(', ')}]`
  const nameWidth = Math.max(4, ...report.bones.map((bone) => bone.name.length))
  const lines = [
    `wrote ${out}`,
    `${report.meshes} mesh node(s), ${report.vertices} vertices, voxel grid ${dimX}x${dimY}x${dimZ} ` +
      `(cell ${report.grid.cellSize.toPrecision(3)}, ${report.grid.insideVoxels} solid)`,
    '',
    `${'bone'.padEnd(nameWidth)}  main  weighted  inside  region (min .. max)`,
  ]
  for (const bone of report.bones) {
    const columns = bone.deform
      ? `${String(bone.vertices).padStart(4)}  ${String(bone.weighted).padStart(8)}  ` +
        `${(Math.round(bone.inside * 100) + '%').padStart(6)}  ` +
        (bone.min && bone.max ? `${round(bone.min)} .. ${round(bone.max)}` : '-')
      : 'deform: false'
    lines.push(`${bone.name.padEnd(nameWidth)}  ${columns}`)
  }
  lines.push('')
  if (report.warnings.length === 0) lines.push('no warnings')
  for (const warning of report.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n') + '\n'
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`error: ${message}\n`)
  if (error instanceof UsageError) process.stderr.write('run "skinning help" for usage\n')
  process.exitCode = 1
})
