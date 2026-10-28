import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { DataTexture, LoaderUtils, type LoadingManager } from 'three'
import type { GLTFLoader, GLTFParser } from 'three/addons/loaders/GLTFLoader.js'
import type { LoadedGLTF } from '../loader.js'

/** Read local and remote glTF resources without installing browser globals. */
export async function readGLTF(loader: GLTFLoader, input: string | URL, onProgress?: (event: ProgressEvent) => void): Promise<LoadedGLTF> {
  const inputURL = String(input)
  const resolved = isAbsolute(inputURL) || /^[a-z][a-z\d+.-]*:/i.test(inputURL) ? inputURL : LoaderUtils.resolveURL(inputURL, loader.path)
  const url = loader.manager.resolveURL(resolved)
  const source = canonicalURL(url)
  const data = await bytes(source, loader.requestHeader, loader.withCredentials)
  onProgress?.(new ReadProgress(data.byteLength))
  const base = loader.resourcePath ? canonicalURL(loader.resourcePath).href : new URL('.', source).href
  loader.register((parser) => resources(parser, loader.withCredentials))
  return { ...await loader.parseAsync(data, base), data }
}

function canonicalURL(input: string): URL {
  return !isAbsolute(input) && /^[a-z][a-z\d+.-]*:/i.test(input) ? new URL(input) : pathToFileURL(resolve(input))
}

async function bytes(url: URL, headers: Record<string, string>, credentials: boolean): Promise<ArrayBuffer> {
  if (url.protocol === 'file:') {
    const data = await readFile(url)
    return Uint8Array.from(data).buffer
  }
  const response = await fetch(url, { headers, credentials: credentials ? 'include' : 'same-origin' })
  if (!response.ok) throw new Error(`RigLoader: ${response.status} ${response.statusText} loading ${url}`)
  return response.arrayBuffer()
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('RigLoader: invalid glTF resource definition')
  return Object.fromEntries(Object.entries(value))
}

function resource(parser: GLTFParser, kind: string, index: number): Record<string, unknown> {
  const json: unknown = parser.json
  const list = record(json)[kind]
  if (!Array.isArray(list)) throw new Error(`RigLoader: missing glTF ${kind}`)
  return record(list[index])
}

function resources(parser: GLTFParser, credentials: boolean): { name: string } {
  const original = parser.loadBuffer.bind(parser)
  parser.loadBuffer = (index) => {
    const uri = resource(parser, 'buffers', index).uri
    if (uri === undefined) return original(index)
    if (typeof uri !== 'string') throw new Error('RigLoader: buffer uri must be a string')
    return readResource(parser, uri, credentials)
  }
  const cache = new Map<number, Promise<DataTexture>>()
  parser.loadImageSource = (index) => {
    let pending = cache.get(index)
    if (!pending) {
      pending = image(parser, index, credentials)
      cache.set(index, pending)
    }
    return pending.then((texture) => texture.clone())
  }
  return { name: 'rig_node_resources' }
}

async function readResource(parser: GLTFParser, uri: string, credentials: boolean): Promise<ArrayBuffer> {
  const manager: LoadingManager = parser.options.manager
  const url = manager.resolveURL(new URL(uri, parser.options.path).href)
  manager.itemStart(url)
  try {
    return await bytes(canonicalURL(url), parser.options.requestHeader, credentials)
  } catch (error) {
    manager.itemError(url)
    throw error
  } finally {
    manager.itemEnd(url)
  }
}

async function image(parser: GLTFParser, index: number, credentials: boolean): Promise<DataTexture> {
  const source = resource(parser, 'images', index)
  let data: ArrayBuffer
  if (typeof source.bufferView === 'number') {
    const dependency: unknown = await parser.getDependency('bufferView', source.bufferView)
    if (!(dependency instanceof ArrayBuffer)) throw new Error(`RigLoader: image ${index} bufferView is not binary data`)
    data = dependency
  } else if (typeof source.uri === 'string') data = await readResource(parser, source.uri, credentials)
  else throw new Error(`RigLoader: image ${index} has neither a uri nor a bufferView`)
  const decoded = await loadImage(Buffer.from(data))
  const context = createCanvas(decoded.width, decoded.height).getContext('2d')
  context.drawImage(decoded, 0, 0)
  const texture = new DataTexture(context.getImageData(0, 0, decoded.width, decoded.height).data, decoded.width, decoded.height)
  if (typeof source.mimeType === 'string') texture.userData.mimeType = source.mimeType
  texture.needsUpdate = true
  return texture
}

class ReadProgress extends Event implements ProgressEvent {
  readonly lengthComputable = true
  readonly loaded: number
  readonly total: number

  constructor(size: number) {
    super('progress')
    this.loaded = size
    this.total = size
  }
}
