import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DataTexture, LoaderUtils, type LoadingManager } from 'three'
import { publicURL } from '@drawcall/cache'
import type { GLTF, GLTFParser } from 'three/addons/loaders/GLTFLoader.js'
import { ModelLoader as BaseLoader } from './loader.js'

/** Reads `file:` URLs, remote URLs and public files without browser globals. */
export class ModelLoader extends BaseLoader {
  constructor(manager?: LoadingManager) {
    super(manager)
    this.register((parser) => resources(parser, this.withCredentials))
  }

  override load(url: string, onLoad: (gltf: GLTF) => void, onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void): void {
    // As GLTFLoader does: the manager modifies the requested URL, while resources resolve against the unmodified one.
    const location = this.manager.resolveURL(this.path + url)
    const base = this.resourcePath || (this.path ? LoaderUtils.resolveURL(LoaderUtils.extractUrlBase(url), this.path) : LoaderUtils.extractUrlBase(url))
    this.manager.itemStart(location)
    read(location, this.requestHeader, this.withCredentials)
      .then((data) => {
        onProgress?.(new ReadProgress(data.byteLength))
        return this.parseAsync(data, base)
      })
      .then(onLoad, (error: unknown) => {
        this.manager.itemError(location)
        if (onError) onError(error)
        else console.error(error)
      })
      .finally(() => this.manager.itemEnd(location))
  }
}

/**
 * A path such as `/models/fox.glb` or `models/fox.glb` names a file below publicDir, as a page at the app's root
 * requests it; an absolute Windows path names that file.
 */
function fetchable(location: string): URL {
  if (isAbsolute(location) && !location.startsWith('/')) return pathToFileURL(location)
  if (/^[a-z][a-z\d+.-]*:/i.test(location)) return new URL(location)
  return new URL(publicURL(location.startsWith('/') ? location : `/${location}`))
}

async function read(location: string, headers: Record<string, string>, credentials: boolean): Promise<ArrayBuffer> {
  const url = fetchable(location)
  if (url.protocol === 'file:') {
    const data = await readFile(url)
    return Uint8Array.from(data).buffer
  }
  const response = await fetch(url, { headers, credentials: credentials ? 'include' : 'same-origin' })
  if (!response.ok) throw new Error(`ModelLoader: ${response.status} ${response.statusText} loading ${location}`)
  return response.arrayBuffer()
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('ModelLoader: invalid glTF resource definition')
  return Object.fromEntries(Object.entries(value))
}

function resource(parser: GLTFParser, kind: string, index: number): Record<string, unknown> {
  const json: unknown = parser.json
  const list = record(json)[kind]
  if (!Array.isArray(list)) throw new Error(`ModelLoader: missing glTF ${kind}`)
  return record(list[index])
}

function resources(parser: GLTFParser, credentials: boolean): { name: string } {
  const original = parser.loadBuffer.bind(parser)
  parser.loadBuffer = (index) => {
    const uri = resource(parser, 'buffers', index).uri
    if (uri === undefined) return original(index)
    if (typeof uri !== 'string') throw new Error('ModelLoader: buffer uri must be a string')
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
  const location = manager.resolveURL(LoaderUtils.resolveURL(uri, parser.options.path))
  manager.itemStart(location)
  try {
    return await read(location, parser.options.requestHeader, credentials)
  } catch (error) {
    manager.itemError(location)
    throw error
  } finally {
    manager.itemEnd(location)
  }
}

async function image(parser: GLTFParser, index: number, credentials: boolean): Promise<DataTexture> {
  const source = resource(parser, 'images', index)
  let data: ArrayBuffer
  if (typeof source.bufferView === 'number') {
    const dependency: unknown = await parser.getDependency('bufferView', source.bufferView)
    if (!(dependency instanceof ArrayBuffer)) throw new Error(`ModelLoader: image ${index} bufferView is not binary data`)
    data = dependency
  } else if (typeof source.uri === 'string') data = await readResource(parser, source.uri, credentials)
  else throw new Error(`ModelLoader: image ${index} has neither a uri nor a bufferView`)
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
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
