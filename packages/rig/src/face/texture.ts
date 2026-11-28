/** Textures the face rig leaves: the face material's map with the eyes painted over, and the eyeballs' irises. Runs without a DOM. */

import * as THREE from 'three'

export interface Pixels { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }

/** A repainted rectangle of a texture's pixels, rows from the image's top as canvas image data holds them. */
export interface Paint extends Pixels { x: number; y: number }

/** RGBA pixels of a texture: a DataTexture's own data, or a browser image drawn to a canvas. */
export function pixels(texture: THREE.Texture): Pixels {
  const own = dataImage(texture.image)
  if (own) return own
  const context = canvas(texture.image).getContext('2d')
  if (!context) throw new Error('face: no 2D canvas to read the face texture')
  return { data: context.getImageData(0, 0, context.canvas.width, context.canvas.height).data, width: context.canvas.width, height: context.canvas.height }
}

/**
 * `map` with `paint` laid over it, in a new texture. A browser image is drawn to a canvas whose pixels become the new
 * image; DataTexture pixels are copied and patched.
 */
export function repainted(map: THREE.Texture, paint: readonly Paint[]): THREE.Texture {
  const own = dataImage(map.image)
  if (own) {
    for (const patch of paint) for (let row = 0; row < patch.height; row++) {
      own.data.set(patch.data.subarray(row * patch.width * 4, (row + 1) * patch.width * 4), ((patch.y + row) * own.width + patch.x) * 4)
    }
    return texture(own, map)
  }
  const surface = canvas(map.image)
  const context = surface.getContext('2d')
  if (!context) throw new Error('face: no 2D canvas to paint the face texture')
  for (const { data, width, height, x, y } of paint) context.putImageData(new ImageData(data, width, height), x, y)
  return texture(surface.transferToImageBitmap(), map)
}

/** An OffscreenCanvas holding a browser image. */
function canvas(image: unknown): OffscreenCanvas {
  const drawable = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap
    || typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement
    || typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement
  if (!drawable || typeof OffscreenCanvas === 'undefined') throw new Error('face: cannot read the face texture\'s pixels')
  const surface = new OffscreenCanvas(image.width, image.height)
  const context = surface.getContext('2d')
  if (!context) throw new Error('face: no 2D canvas to read the face texture')
  context.drawImage(image, 0, 0)
  return surface
}

/** The pixels of a DataTexture-style image `{ data, width, height }`, copied. */
function dataImage(image: unknown): Pixels | undefined {
  if (typeof image !== 'object' || image === null || !('data' in image) || !('width' in image) || !('height' in image)) return undefined
  const { data, width, height } = image
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || typeof width !== 'number' || typeof height !== 'number') return undefined
  if (data.length !== width * height * 4) throw new Error('face: the face texture is not 8-bit RGBA')
  return { data: Uint8ClampedArray.from(data), width, height }
}

/**
 * A texture holding `image` (pixels or a browser image), sampled and uv-transformed like `like`. Texture.copy would
 * also take `like`'s image, mipmaps and pixel format, which belong to the old pixels, so the sampling and uv transform
 * are copied field by field.
 */
function texture(image: Pixels | ImageBitmap, like?: THREE.Texture): THREE.Texture {
  const out = 'data' in image ? new THREE.DataTexture(image.data, image.width, image.height) : new THREE.Texture(image)
  if (like) {
    out.name = like.name
    out.userData = structuredClone(like.userData)
    out.offset.copy(like.offset)
    out.repeat.copy(like.repeat)
    out.center.copy(like.center)
    out.rotation = like.rotation
    out.matrixAutoUpdate = like.matrixAutoUpdate
    out.matrix.copy(like.matrix)
    out.colorSpace = like.colorSpace
    out.flipY = like.flipY
    out.wrapS = like.wrapS
    out.wrapT = like.wrapT
    out.anisotropy = like.anisotropy
    out.channel = like.channel
    out.magFilter = like.magFilter
    out.minFilter = like.minFilter
  } else {
    out.colorSpace = THREE.SRGBColorSpace
    out.magFilter = THREE.LinearFilter
    out.minFilter = THREE.LinearMipmapLinearFilter
  }
  out.generateMipmaps = true
  out.needsUpdate = true
  return out
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/**
 * An eyeball texture: sclera shaded under the upper lid and toward the corners, a fibrous iris of `iris` color with a
 * dark limbal ring and a pupil; radii as fractions of the ball radius.
 */
export function eyeTexture(iris: THREE.Color, irisRadius: number, pupilRadius: number): THREE.Texture {
  const size = 256
  const data = new Uint8ClampedArray(size * size * 4)
  const srgb = { r: 0, g: 0, b: 0 }
  iris.getRGB(srgb, THREE.SRGBColorSpace)
  const fibers = Array.from({ length: 96 }, (_, k) => Math.sin(k * 12.9898) * 43758.5453 % 1)
  const ease = (a: number, b: number, x: number) => clamp01((x - a) / (b - a))
  const mix = (c: number[], to: readonly number[], k: number) => { for (let i = 0; i < 3; i++) c[i] = c[i] * (1 - k) + to[i] * k }
  const c = [0, 0, 0]
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    // uv origin at the bottom: v grows upward, like the ball's y
    const u = (px + 0.5) / size * 2 - 1, v = (py + 0.5) / size * 2 - 1
    const r = Math.hypot(u, v)
    const top = (1 - v) / 2
    // sclera: off-white, shadowed under the upper lid, darker and pinker toward the corners
    c[0] = 0.87; c[1] = 0.83; c[2] = 0.78
    mix(c, LID, top < 0.36 ? 0.85 - (0.5 * top) / 0.36 : top < 0.5 ? 0.35 * (0.5 - top) / 0.14 : 0.15 * (top - 0.5) / 0.5)
    mix(c, CORNER, r < irisRadius * 1.04 ? 0 : 0.9 * ease(irisRadius * 1.04, 1, r) ** 0.7)
    if (r < irisRadius) {
      const t = ease(pupilRadius, irisRadius, r)
      const shade = t < 0.85 ? 1.6 - 0.6 * t / 0.85 : 1 - 0.6 * (t - 0.85) / 0.15
      const fiber = fibers[Math.floor(((Math.atan2(v, u) / Math.PI + 1) / 2) * fibers.length) % fibers.length]
      const streak = 1 + (fiber - 0.5) * 0.35 * Math.min(1, t * 2)
      const limbus = 1 - 0.75 * clamp01(1 - Math.abs(r - irisRadius * 0.97) / (0.03 * irisRadius))
      // the upper lid's shadow falls over the iris too
      const over = 1 - (top < 0.25 ? 0.55 : top < 0.45 ? 0.55 * (0.45 - top) / 0.2 : 0)
      const pupil = r < pupilRadius
      c[0] = (pupil ? 0.024 : Math.min(1, srgb.r * shade * streak) * limbus) * over
      c[1] = (pupil ? 0.024 : Math.min(1, srgb.g * shade * streak) * limbus) * over
      c[2] = (pupil ? 0.024 : Math.min(1, srgb.b * shade * streak) * limbus) * over
    }
    const i = (py * size + px) * 4
    data[i] = c[0] * 255; data[i + 1] = c[1] * 255; data[i + 2] = c[2] * 255; data[i + 3] = 255
  }
  return texture({ data, width: size, height: size })
}

const LID = [0.24, 0.14, 0.12] as const, CORNER = [0.3, 0.15, 0.13] as const
