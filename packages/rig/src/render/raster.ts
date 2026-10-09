/**
 * A small CPU renderer for check images: depth-buffered triangles and lines of a three.js scene, so render()
 * needs no GPU, driver or native graphics library and draws the same pixels on every machine. three.js does
 * the scene work (matrices, skinning, morphs); this only fills pixels. Lighting is plain diffuse from the
 * scene's ambient, hemisphere and directional lights; textures are sampled bilinearly; supersampled 2x2.
 */

import * as THREE from 'three'

/** Samples per pixel along each axis. */
const SS = 2
/** Floats per clipped vertex: clip x y z w, world normal xyz, uv, color rgb. */
const STRIDE = 12

interface Lights {
  ambient: THREE.Color
  hemi: { sky: THREE.Color; ground: THREE.Color; up: THREE.Vector3 }[]
  directional: { color: THREE.Color; toward: THREE.Vector3 }[]
}

interface Target {
  width: number
  /** Linear rgb per sample. */
  color: Float32Array
  /** NDC z per sample. */
  depth: Float32Array
}

/** Renders the scene as three.js's WebGLRenderer would, roughly, into `size`×`size` sRGB RGBA pixels. */
export function rasterize(scene: THREE.Scene, camera: THREE.Camera, size: number): Uint8ClampedArray<ArrayBuffer> {
  scene.updateMatrixWorld()
  if (!camera.parent) camera.updateMatrixWorld()
  const width = size * SS
  const target: Target = { width, color: new Float32Array(width * width * 3), depth: new Float32Array(width * width).fill(Infinity) }
  const background = scene.background instanceof THREE.Color ? scene.background : new THREE.Color(0, 0, 0)
  for (let i = 0; i < width * width; i++) target.color.set([background.r, background.g, background.b], i * 3)

  const lights: Lights = { ambient: new THREE.Color(0, 0, 0), hemi: [], directional: [] }
  const drawn: (THREE.Mesh | THREE.Line)[] = []
  scene.traverseVisible((node) => {
    if (node instanceof THREE.AmbientLight) lights.ambient.add(node.color.clone().multiplyScalar(node.intensity))
    else if (node instanceof THREE.HemisphereLight)
      lights.hemi.push({
        sky: node.color.clone().multiplyScalar(node.intensity),
        ground: node.groundColor.clone().multiplyScalar(node.intensity),
        up: node.getWorldPosition(new THREE.Vector3()).normalize(),
      })
    else if (node instanceof THREE.DirectionalLight)
      lights.directional.push({
        color: node.color.clone().multiplyScalar(node.intensity),
        toward: node.getWorldPosition(new THREE.Vector3()).sub(node.target.getWorldPosition(new THREE.Vector3())).normalize(),
      })
    else if (node instanceof THREE.Mesh || node instanceof THREE.Line) drawn.push(node)
  })
  // Like three.js: opaque before transparent, then by renderOrder; the rest keeps scene order
  const order = (node: THREE.Object3D) => (materials(node).some((m) => m.transparent) ? 1e9 : 0) + node.renderOrder
  drawn.sort((a, b) => order(a) - order(b))

  const viewProjection = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse)
  for (const node of drawn) {
    if (node instanceof THREE.Mesh) drawMesh(target, node, viewProjection, lights)
    else drawLines(target, node, viewProjection)
  }
  return resolve(target, size)
}

function materials(node: THREE.Object3D): THREE.Material[] {
  if (!(node instanceof THREE.Mesh || node instanceof THREE.Line)) return []
  return Array.isArray(node.material) ? node.material : [node.material]
}

/** World positions of every vertex in the current pose (skinning and morphs applied, as the GPU would). */
function worldPositions(node: THREE.Mesh | THREE.Line): Float32Array {
  const position = node.geometry.getAttribute('position')
  const out = new Float32Array(position.count * 3)
  const v = new THREE.Vector3()
  const posed = node instanceof THREE.Mesh && (node instanceof THREE.SkinnedMesh || node.morphTargetInfluences?.length)
  for (let i = 0; i < position.count; i++) {
    if (posed) (node as THREE.Mesh).getVertexPosition(i, v)
    else v.fromBufferAttribute(position, i)
    v.applyMatrix4(node.matrixWorld).toArray(out, i * 3)
  }
  return out
}

function clipPositions(world: Float32Array, viewProjection: THREE.Matrix4): Float32Array {
  const out = new Float32Array((world.length / 3) * 4)
  const v = new THREE.Vector4()
  for (let i = 0; i < world.length / 3; i++) v.set(world[i * 3], world[i * 3 + 1], world[i * 3 + 2], 1).applyMatrix4(viewProjection).toArray(out, i * 4)
  return out
}

function drawMesh(target: Target, mesh: THREE.Mesh, viewProjection: THREE.Matrix4, lights: Lights): void {
  const geometry = mesh.geometry
  const world = worldPositions(mesh)
  const clip = clipPositions(world, viewProjection)
  const index = geometry.getIndex()
  const count = index ? index.count : world.length / 3
  const corner = (t: number) => (index ? index.getX(t) : t)

  // Smooth normals from the posed triangles: no normal skinning needed, and split (flat) vertices stay flat
  const normals = new Float32Array(world.length)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let t = 0; t + 2 < count; t += 3) {
    const [i, j, k] = [corner(t), corner(t + 1), corner(t + 2)]
    a.fromArray(world, i * 3)
    b.fromArray(world, j * 3).sub(a)
    c.fromArray(world, k * 3).sub(a)
    b.cross(c) // area-weighted
    for (const v of [i, j, k]) for (let d = 0; d < 3; d++) normals[v * 3 + d] += b.getComponent(d)
  }

  const flip = mesh.matrixWorld.determinant() < 0
  const ranges = Array.isArray(mesh.material)
    ? geometry.groups.map((g) => ({ start: g.start, count: g.count, material: (mesh.material as THREE.Material[])[g.materialIndex ?? 0] }))
    : [{ start: 0, count, material: mesh.material }]
  const drawStart = geometry.drawRange.start
  const drawEnd = Math.min(count, drawStart + geometry.drawRange.count)
  for (const range of ranges) {
    const material = range.material
    if (!material?.visible) continue
    const shade = shader(material, geometry, lights)
    const start = Math.max(range.start, drawStart)
    const end = Math.min(range.start + range.count, drawEnd)
    for (let t = start; t + 2 < end; t += 3) {
      const ids = [corner(t), corner(t + 1), corner(t + 2)]
      const polygon: number[][] = ids.map((v) => vertex(v, clip, normals, shade))
      drawTriangle(target, nearClip(polygon), material, shade, flip)
    }
  }
}

/** One vertex's clip position and attributes, in STRIDE layout. */
function vertex(v: number, clip: Float32Array, normals: Float32Array, shade: Shader): number[] {
  const out = new Array<number>(STRIDE).fill(0)
  for (let d = 0; d < 4; d++) out[d] = clip[v * 4 + d]
  for (let d = 0; d < 3; d++) out[4 + d] = normals[v * 3 + d]
  if (shade.uv) {
    out[7] = shade.uv.getX(v)
    out[8] = shade.uv.getY(v)
  }
  if (shade.color) for (let d = 0; d < 3; d++) out[9 + d] = shade.color.getComponent(v, d)
  return out
}

/** Clips a polygon to the near plane (z > -w), so triangles reaching behind the camera keep their visible part. */
function nearClip(polygon: number[][]): number[][] {
  const inside = (p: number[]) => p[2] + p[3] > 1e-9
  if (polygon.every(inside)) return polygon
  const out: number[][] = []
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]
    const q = polygon[(i + 1) % polygon.length]
    if (inside(p)) out.push(p)
    if (inside(p) !== inside(q)) {
      const s = (p[2] + p[3]) / (p[2] + p[3] - q[2] - q[3])
      out.push(p.map((value, k) => value + (q[k] - value) * s))
    }
  }
  return out
}

interface Shader {
  base: THREE.Color
  opacity: number
  lit: boolean
  emissive: THREE.Color
  map?: Sampler
  uv?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
  color?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
  lights: Lights
}

function shader(material: THREE.Material, geometry: THREE.BufferGeometry, lights: Lights): Shader {
  const m = material as THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null; emissive?: THREE.Color; emissiveIntensity?: number }
  const map = m.map ? sampler(m.map) : undefined
  const channel = m.map?.channel ? `uv${m.map.channel}` : 'uv'
  return {
    base: m.color?.clone() ?? new THREE.Color(1, 1, 1),
    opacity: material.opacity,
    lit: !(material instanceof THREE.MeshBasicMaterial || material instanceof THREE.LineBasicMaterial),
    emissive: m.emissive ? m.emissive.clone().multiplyScalar(m.emissiveIntensity ?? 1) : new THREE.Color(0, 0, 0),
    map,
    uv: map ? geometry.getAttribute(channel) : undefined,
    color: material.vertexColors ? geometry.getAttribute('color') : undefined,
    lights,
  }
}

const srgbToLinear = (c: number) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4))
const linearToSrgb = (c: number) => (c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055)
const toLinear = new Float32Array(256).map((_, i) => srgbToLinear(i / 255))

interface Sampler {
  /** Texels per sample along each axis is 2^level; set per triangle. */
  level: number
  /** Texel area per unit of uv area, to pick `level` from a triangle's uv and screen areas. */
  texels: number
  sample(u: number, v: number, out: Float32Array): void
}

/** One mip level: RGBA bytes, as decoded. */
interface Mip {
  data: ArrayLike<number>
  width: number
  height: number
}

const mipChains = new WeakMap<object, Mip[]>()

/** The image's mip chain, each level the 2×2 box average of the one before, as a GPU would build it. */
function mips(image: Mip): Mip[] {
  const cached = mipChains.get(image)
  if (cached) return cached
  const chain: Mip[] = [image]
  for (let top = image; top.width > 1 || top.height > 1; top = chain[chain.length - 1]) {
    const width = Math.max(1, top.width >> 1), height = Math.max(1, top.height >> 1)
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      const r0 = Math.min(top.height - 1, y * 2) * top.width, r1 = Math.min(top.height - 1, y * 2 + 1) * top.width
      for (let x = 0; x < width; x++) {
        const c0 = Math.min(top.width - 1, x * 2), c1 = Math.min(top.width - 1, x * 2 + 1)
        for (let k = 0; k < 4; k++)
          data[(y * width + x) * 4 + k] = (top.data[(r0 + c0) * 4 + k] + top.data[(r0 + c1) * 4 + k] + top.data[(r1 + c0) * 4 + k] + top.data[(r1 + c1) * 4 + k] + 2) >> 2
      }
    }
    chain.push({ data, width, height })
  }
  mipChains.set(image, chain)
  return chain
}

/** Mipmapped bilinear lookups in a decoded texture (`image.data` RGBA, as load() and DataTexture store them). */
function sampler(texture: THREE.Texture): Sampler | undefined {
  const image = texture.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined
  if (!image?.data || !image.width || !image.height) return undefined
  const chain = mips(image as Mip)
  const decode = texture.colorSpace === THREE.SRGBColorSpace ? (value: number, k: number) => (k < 3 ? toLinear[value] : value / 255) : (value: number) => value / 255
  if (texture.matrixAutoUpdate) texture.updateMatrix()
  const e = texture.matrix.elements
  const wrap = (i: number, n: number, mode: THREE.Wrapping) => {
    if (mode === THREE.ClampToEdgeWrapping) return Math.min(n - 1, Math.max(0, i))
    if (mode === THREE.MirroredRepeatWrapping) {
      const m = ((i % (2 * n)) + 2 * n) % (2 * n)
      return m < n ? m : 2 * n - 1 - m
    }
    return ((i % n) + n) % n
  }
  return {
    level: 0,
    texels: image.width * image.height * Math.abs(e[0] * e[4] - e[1] * e[3]),
    sample(u, v, out) {
      const { data, width, height } = chain[Math.min(chain.length - 1, Math.max(0, Math.round(this.level)))]
      const tu = e[0] * u + e[3] * v + e[6]
      let tv = e[1] * u + e[4] * v + e[7]
      if (texture.flipY) tv = 1 - tv
      const x = tu * width - 0.5
      const y = tv * height - 0.5
      const x0 = Math.floor(x), y0 = Math.floor(y)
      const fx = x - x0, fy = y - y0
      const xa = wrap(x0, width, texture.wrapS), xb = wrap(x0 + 1, width, texture.wrapS)
      const ya = wrap(y0, height, texture.wrapT) * width, yb = wrap(y0 + 1, height, texture.wrapT) * width
      for (let k = 0; k < 4; k++)
        out[k] =
          (decode(data[(ya + xa) * 4 + k], k) * (1 - fx) + decode(data[(ya + xb) * 4 + k], k) * fx) * (1 - fy) +
          (decode(data[(yb + xa) * 4 + k], k) * (1 - fx) + decode(data[(yb + xb) * 4 + k], k) * fx) * fy
    },
  }
}

const texel = new Float32Array(4)
const rgb = new Float32Array(3)

/** The linear color and alpha of one sample: material color × vertex color × map, then lit. */
function shadePixel(shade: Shader, attributes: Float64Array, facing: number, out: Float32Array): number {
  let r = shade.base.r, g = shade.base.g, b = shade.base.b
  let alpha = shade.opacity
  if (shade.color) {
    r *= attributes[9]
    g *= attributes[10]
    b *= attributes[11]
  }
  if (shade.map) {
    shade.map.sample(attributes[7], attributes[8], texel)
    r *= texel[0]
    g *= texel[1]
    b *= texel[2]
    alpha *= texel[3]
  }
  if (shade.lit) {
    const length = Math.hypot(attributes[4], attributes[5], attributes[6]) || 1
    const nx = (attributes[4] / length) * facing, ny = (attributes[5] / length) * facing, nz = (attributes[6] / length) * facing
    const { ambient, hemi, directional } = shade.lights
    let lr = ambient.r, lg = ambient.g, lb = ambient.b
    for (const h of hemi) {
      const w = 0.5 * (nx * h.up.x + ny * h.up.y + nz * h.up.z) + 0.5
      lr += h.ground.r + (h.sky.r - h.ground.r) * w
      lg += h.ground.g + (h.sky.g - h.ground.g) * w
      lb += h.ground.b + (h.sky.b - h.ground.b) * w
    }
    for (const d of directional) {
      const w = Math.max(0, nx * d.toward.x + ny * d.toward.y + nz * d.toward.z)
      lr += d.color.r * w
      lg += d.color.g * w
      lb += d.color.b * w
    }
    // Lambert, as three.js: irradiance × albedo / π
    r = (r * lr) / Math.PI + shade.emissive.r
    g = (g * lg) / Math.PI + shade.emissive.g
    b = (b * lb) / Math.PI + shade.emissive.b
  }
  out[0] = r
  out[1] = g
  out[2] = b
  return alpha
}

function write(target: Target, material: THREE.Material, sample: number, z: number, color: Float32Array, alpha: number): void {
  if (z < -1 || z > 1) return
  if (material.depthTest && z >= target.depth[sample]) return
  if (alpha < material.alphaTest) return
  if (material.depthWrite) target.depth[sample] = z
  const a = material.transparent ? Math.min(1, Math.max(0, alpha)) : 1
  for (let k = 0; k < 3; k++) target.color[sample * 3 + k] = color[k] * a + target.color[sample * 3 + k] * (1 - a)
}

/** Fills a convex clip-space polygon (a fan of triangles), perspective-correct, at sample centers. */
function drawTriangle(target: Target, polygon: number[][], material: THREE.Material, shade: Shader, flip: boolean): void {
  if (polygon.length < 3) return
  const w = target.width
  const screen = polygon.map((p) => [((p[0] / p[3] + 1) / 2) * w, ((1 - p[1] / p[3]) / 2) * w, p[2] / p[3], 1 / p[3]])
  const attributes = new Float64Array(STRIDE)
  for (let f = 1; f + 1 < polygon.length; f++) {
    const [s0, s1, s2] = [screen[0], screen[f], screen[f + 1]]
    const [p0, p1, p2] = [polygon[0], polygon[f], polygon[f + 1]]
    const area = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1])
    if (area === 0) continue
    // Counter-clockwise in NDC is clockwise in y-down screen space: area < 0 means front-facing
    const front = area < 0 !== flip
    if (material.side === THREE.FrontSide && !front) continue
    if (material.side === THREE.BackSide && front) continue
    const facing = front ? 1 : -1
    if (shade.map) {
      // Texels per sample, from the triangle's uv area against its screen area
      const uv = Math.abs((p1[7] - p0[7]) * (p2[8] - p0[8]) - (p2[7] - p0[7]) * (p1[8] - p0[8]))
      shade.map.level = 0.5 * Math.log2(Math.max(1e-12, (uv * shade.map.texels) / Math.abs(area)))
    }
    const minX = Math.max(0, Math.floor(Math.min(s0[0], s1[0], s2[0])))
    const maxX = Math.min(w - 1, Math.ceil(Math.max(s0[0], s1[0], s2[0])))
    const minY = Math.max(0, Math.floor(Math.min(s0[1], s1[1], s2[1])))
    const maxY = Math.min(w - 1, Math.ceil(Math.max(s0[1], s1[1], s2[1])))
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5
        let b0 = ((s1[0] - px) * (s2[1] - py) - (s2[0] - px) * (s1[1] - py)) / area
        let b1 = ((s2[0] - px) * (s0[1] - py) - (s0[0] - px) * (s2[1] - py)) / area
        let b2 = 1 - b0 - b1
        if (b0 < 0 || b1 < 0 || b2 < 0) continue
        const z = b0 * s0[2] + b1 * s1[2] + b2 * s2[2]
        // Perspective-correct weights for the attributes
        const q0 = b0 * s0[3], q1 = b1 * s1[3], q2 = b2 * s2[3]
        const q = q0 + q1 + q2
        b0 = q0 / q
        b1 = q1 / q
        b2 = q2 / q
        for (let k = 4; k < STRIDE; k++) attributes[k] = b0 * p0[k] + b1 * p1[k] + b2 * p2[k]
        const alpha = shadePixel(shade, attributes, facing, rgb)
        write(target, material, y * w + x, z, rgb, alpha)
      }
    }
  }
}

function drawLines(target: Target, line: THREE.Line, viewProjection: THREE.Matrix4): void {
  const material = Array.isArray(line.material) ? line.material[0] : line.material
  if (!material?.visible) return
  const clip = clipPositions(worldPositions(line), viewProjection)
  const shade = shader(material, line.geometry, { ambient: new THREE.Color(), hemi: [], directional: [] })
  const index = line.geometry.getIndex()
  const count = index ? index.count : clip.length / 4
  const corner = (i: number) => (index ? index.getX(i) : i)
  const step = line instanceof THREE.LineSegments ? 2 : 1
  const normals = new Float32Array(count * 3)
  const w = target.width
  for (let i = 0; i + 1 < count; i += step) {
    const ends = nearClip([vertex(corner(i), clip, normals, shade), vertex(corner(i + 1), clip, normals, shade)])
    if (ends.length < 2) continue
    const [p, q] = ends
    const a = [((p[0] / p[3] + 1) / 2) * w, ((1 - p[1] / p[3]) / 2) * w, p[2] / p[3]]
    const b = [((q[0] / q[3] + 1) / 2) * w, ((1 - q[1] / q[3]) / 2) * w, q[2] / q[3]]
    const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1
    const attributes = new Float64Array(STRIDE)
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      for (let k = 4; k < STRIDE; k++) attributes[k] = p[k] + (q[k] - p[k]) * t
      const alpha = shadePixel(shade, attributes, 1, rgb)
      // One pixel wide after downsampling: an SS×SS block of samples
      const cx = Math.floor(a[0] + (b[0] - a[0]) * t - SS / 2 + 0.5)
      const cy = Math.floor(a[1] + (b[1] - a[1]) * t - SS / 2 + 0.5)
      const z = a[2] + (b[2] - a[2]) * t
      for (let dy = 0; dy < SS; dy++)
        for (let dx = 0; dx < SS; dx++) {
          const x = cx + dx, y = cy + dy
          if (x >= 0 && y >= 0 && x < w && y < w) write(target, material, y * w + x, z, rgb, alpha)
        }
    }
  }
}

/** Averages each pixel's samples and encodes them as sRGB bytes. */
function resolve(target: Target, size: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0
      for (let dy = 0; dy < SS; dy++)
        for (let dx = 0; dx < SS; dx++) {
          const s = ((y * SS + dy) * target.width + x * SS + dx) * 3
          r += target.color[s]
          g += target.color[s + 1]
          b += target.color[s + 2]
        }
      const n = SS * SS
      out.set([linearToSrgb(r / n) * 255 + 0.5, linearToSrgb(g / n) * 255 + 0.5, linearToSrgb(b / n) * 255 + 0.5, 255], (y * size + x) * 4)
    }
  return out
}
