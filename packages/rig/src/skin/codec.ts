import type { Vec3 } from '../vec3.js'
import type { BoneReport, SkinReport, SkinSolution } from './weights.js'

export function encode(solution: SkinSolution): Uint8Array {
  const { skinIndices, skinWeights, report } = solution
  const json = new TextEncoder().encode(JSON.stringify(report))
  const bytes = new Uint8Array(4 + skinIndices.byteLength + skinWeights.byteLength + json.byteLength)
  new DataView(bytes.buffer).setUint32(0, skinIndices.length, true)
  bytes.set(new Uint8Array(skinIndices.buffer, skinIndices.byteOffset, skinIndices.byteLength), 4)
  bytes.set(new Uint8Array(skinWeights.buffer, skinWeights.byteOffset, skinWeights.byteLength), 4 + skinIndices.byteLength)
  bytes.set(json, 4 + skinIndices.byteLength + skinWeights.byteLength)
  return bytes
}

export function decode(bytes: Uint8Array, vertices: number): SkinSolution {
  const count = vertices * 4
  if (bytes.byteLength < 4 + count * 6 || new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) !== count) {
    throw new Error('Invalid rig cache weight buffers')
  }
  const skinIndices = new Uint16Array(Uint8Array.from(bytes.subarray(4, 4 + count * 2)).buffer)
  const skinWeights = new Float32Array(Uint8Array.from(bytes.subarray(4 + count * 2, 4 + count * 6)).buffer)
  const report: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(4 + count * 6)))
  if (!isReport(report)) throw new Error('Invalid rig cache report')
  return { skinIndices, skinWeights, report }
}

function isReport(value: unknown): value is SkinReport {
  return typeof value === 'object' && value !== null
    && 'closed' in value && typeof value.closed === 'boolean'
    && 'volume' in value && (value.volume === null || finite(value.volume))
    && 'warnings' in value && Array.isArray(value.warnings) && value.warnings.every((entry: unknown) => typeof entry === 'string')
    && 'bones' in value && Array.isArray(value.bones) && value.bones.every(isBone)
}

function isBone(value: unknown): value is BoneReport {
  return typeof value === 'object' && value !== null
    && 'name' in value && typeof value.name === 'string'
    && 'inside' in value && finite(value.inside)
    && 'vertices' in value && finite(value.vertices)
    && 'weighted' in value && finite(value.weighted)
    && 'min' in value && (value.min === null || vector(value.min))
    && 'max' in value && (value.max === null || vector(value.max))
}

function vector(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(finite)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
