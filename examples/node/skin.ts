/**
 * The library from Node, without the CLI: read, voxelize, skin, write.
 *
 *   pnpm api
 */

import { readFileSync } from 'node:fs'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { formatVolume, skin, voxelize, type Skeleton } from '@drawcall/skinning'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const document = await io.read('horse.glb')

// Cross-section through the legs: each lettered region is one leg, with its center
console.log(formatVolume(voxelize(document, { resolution: 48 }), [{ axis: 'y', value: 30 }]))

const skeleton = JSON.parse(readFileSync('horse.skeleton.json', 'utf8')) as Skeleton
const report = skin(document, skeleton)
for (const bone of report.bones) console.log(`${bone.name}: ${bone.vertices} vertices`)
for (const warning of report.warnings) console.warn(`warning: ${warning}`)

await io.write('horse.skinned.glb', document)
console.log('wrote horse.skinned.glb')
