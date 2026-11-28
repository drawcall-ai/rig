/** Reads the face material's map for the eyes: the painted iris colors, and the map repainted over eyes drawn on it. */

import * as THREE from 'three'
import type { Eye } from './anatomy.js'
import type { Surface } from './surface.js'
import { pixels, type Paint, type Pixels } from '../texture.js'

/** The map's average color in a 5×5 pixel patch at a uv. */
function sample(map: THREE.Texture, image: Pixels, uv: THREE.Vector2): THREE.Color {
  const at = uv.clone()
  map.transformUv(at)
  const x0 = Math.floor(at.x * image.width) - 2, y0 = Math.floor(at.y * image.height) - 2
  let r = 0, g = 0, b = 0, n = 0
  for (let y = y0; y < y0 + 5; y++) for (let x = x0; x < x0 + 5; x++) {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue
    const i = (y * image.width + x) * 4
    r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; n++
  }
  return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace)
}

/** How much a pixel looks like painted sclera (bright, unsaturated) or iris (bluish). */
function painted(d: Uint8ClampedArray, i: number): number {
  const r = d[i], g = d[i + 1], b = d[i + 2], max = Math.max(r, g, b), min = Math.min(r, g, b)
  const sclera = clamp01((min - 120) / 50) * clamp01((60 - (max - min)) / 30)
  return Math.max(sclera, clamp01((b - r + 10) / 30))
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/**
 * The painted iris color: of samples across the opening, the most saturated one that is neither skin (reddish), the
 * pupil (dark) nor sclera (unsaturated); a single fixed point can land on the pupil or a highlight.
 */
function iris(s: Surface, eye: Eye, map: THREE.Texture, image: Pixels): THREE.Color {
  let best: THREE.Color | undefined, bestSaturation = 0.08
  const hsl = { h: 0, s: 0, l: 0 }
  for (const dz of [0, -0.0015, 0.0015, -0.0027, 0.0027, -0.004, 0.004]) for (const dy of [0, -0.0012, 0.0012]) {
    const hit = s.front(eye.y + dy, eye.z + dz)
    if (!hit.uv) throw new Error('face: no uv where the iris is painted')
    const color = sample(map, image, hit.uv)
    color.getHSL(hsl, THREE.SRGBColorSpace)
    const reddish = color.r > color.b * 1.25 && color.r > color.g
    if (!reddish && hsl.l > 0.12 && hsl.l < 0.85 && hsl.s * Math.min(1, hsl.l * 4) > bestSaturation) {
      best = color
      bestSaturation = hsl.s * Math.min(1, hsl.l * 4)
    }
  }
  return best ?? new THREE.Color(0x5a3a22)
}

/**
 * Iris colors sampled from eyes painted on the face, one per eye (brown without a map), and the painted sclera and iris
 * on the skin around each opening repainted with its surrounding skin tone, so no white wedges show where skin stays at
 * the corners: the rectangles to lay over `material`'s map, that of a basic, Lambert, Phong, toon or standard material,
 * which is left unchanged.
 */
export function paintOverEyes(s: Surface, eyes: Eye[], material: THREE.Material): { irises: THREE.Color[]; paint: Paint[] } {
  const mapped = material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhongMaterial || material instanceof THREE.MeshLambertMaterial
    || material instanceof THREE.MeshToonMaterial || material instanceof THREE.MeshBasicMaterial
  const map = mapped ? material.map : null
  const uv = s.attributes.get('uv')
  if (!mapped || !map || !uv) return { irises: eyes.map(() => new THREE.Color(0x5a3a22)), paint: [] }
  const image = pixels(map)
  const irises = eyes.map((eye) => iris(s, eye, map, image))
  const { data, width: W } = image
  const touched = new Set<number>()
  for (const eye of eyes) {
    const reach = 1.9 * Math.max(eye.innerHalfWidth, eye.outerHalfWidth)
    const near = (v: number) => {
      const p = s.point(v)
      return p.x >= eye.center.x && ((p.y - eye.y) / (eye.halfHeight * 2.4)) ** 2 + ((p.z - eye.z) / reach) ** 2 <= 1
    }
    const { x0, y0, width: mw, height: mh, covered } = footprint(s, uv.data, map, image, near)
    let sr = 0, sg = 0, sb = 0, n = 0
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      if (!covered[y * mw + x]) continue
      const i = ((y + y0) * W + x + x0) * 4
      if (painted(data, i) === 0 && data[i] > data[i + 2] + 25 && data[i] > 90) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++ }
    }
    // no skin-colored pixels near the eye: nothing painted to cover with skin
    if (!n) continue
    sr = sr / n * 0.85; sg = sg / n * 0.85; sb = sb / n * 0.85
    const mask = new Float32Array(mw * mh)
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (covered[y * mw + x]) mask[y * mw + x] = painted(data, ((y + y0) * W + x + x0) * 4)
    // feather the mask by a small max-blur before repainting
    const R = 2
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      if (!covered[y * mw + x]) continue
      let m = 0
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const yy = y + dy, xx = x + dx
        if (yy >= 0 && xx >= 0 && yy < mh && xx < mw) m = Math.max(m, mask[yy * mw + xx] * (1 - Math.hypot(dx, dy) / (R + 1)))
      }
      if (!m) continue
      const i = ((y + y0) * W + x + x0) * 4
      data[i] += (sr - data[i]) * m; data[i + 1] += (sg - data[i + 1]) * m; data[i + 2] += (sb - data[i + 2]) * m
      touched.add(Math.floor((y + y0) / TILE) * Math.ceil(W / TILE) + Math.floor((x + x0) / TILE))
    }
  }
  return { irises, paint: patches(image, touched) }
}

/** Patches are whole tiles of this many pixels square, clipped to the image. */
const TILE = 32

/** The repainted pixels as one rectangle per run of touched tiles along a row of tiles. */
function patches({ data, width: W, height: H }: Pixels, touched: Set<number>): Paint[] {
  const columns = Math.ceil(W / TILE)
  const runs: [number, number, number][] = []
  for (const tile of [...touched].sort((a, b) => a - b)) {
    const last = runs.at(-1)
    if (last && last[0] * columns + last[1] + last[2] === tile && Math.floor(tile / columns) === last[0]) last[2]++
    else runs.push([Math.floor(tile / columns), tile % columns, 1])
  }
  return runs.map(([row, column, length]) => {
    const x = column * TILE, y = row * TILE
    const width = Math.min(length * TILE, W - x), height = Math.min(TILE, H - y)
    const out = new Uint8ClampedArray(width * height * 4)
    for (let r = 0; r < height; r++) out.set(data.subarray(((y + r) * W + x) * 4, ((y + r) * W + x + width) * 4), r * width * 4)
    return { x, y, width, height, data: out }
  })
}

/**
 * The texture's pixels under the triangles with a vertex `near`, grown by a few pixels for the gutter around a uv
 * island: a mask over their bounding rectangle. The rectangle alone can span unrelated islands of the texture.
 */
function footprint(s: Surface, uv: number[], map: THREE.Texture, { width: W, height: H }: Pixels, near: (v: number) => boolean) {
  const at = new THREE.Vector2()
  const pixel = (v: number): [number, number] => {
    map.transformUv(at.set(uv[v * 2], uv[v * 2 + 1]))
    return [at.x * W - 0.5, at.y * H - 0.5]
  }
  const triangles: [number, number][][] = []
  for (let t = 0; t < s.triangles.length; t += 3) {
    const corners = [s.triangles[t], s.triangles[t + 1], s.triangles[t + 2]]
    if (corners.some(near)) triangles.push(corners.map(pixel))
  }
  if (!triangles.length) throw new Error('face: no map around an eye')
  const GROW = 3
  const xs = triangles.flat().map(([x]) => x), ys = triangles.flat().map(([, y]) => y)
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - GROW), y0 = Math.max(0, Math.floor(Math.min(...ys)) - GROW)
  const x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)) + GROW), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)) + GROW)
  const width = x1 - x0 + 1, height = y1 - y0 + 1
  const inside = new Uint8Array(width * height)
  for (const [[ax, ay], [bx, by], [cx, cy]] of triangles) {
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (!area) continue
    const fx0 = Math.max(x0, Math.floor(Math.min(ax, bx, cx))), fx1 = Math.min(x1, Math.ceil(Math.max(ax, bx, cx)))
    const fy0 = Math.max(y0, Math.floor(Math.min(ay, by, cy))), fy1 = Math.min(y1, Math.ceil(Math.max(ay, by, cy)))
    for (let y = fy0; y <= fy1; y++) for (let x = fx0; x <= fx1; x++) {
      const u = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area
      const v = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area
      if (u >= 0 && v >= 0 && u + v <= 1) inside[(y - y0) * width + x - x0] = 1
    }
  }
  const covered = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!inside[y * width + x]) continue
    for (let dy = Math.max(0, y - GROW); dy <= Math.min(height - 1, y + GROW); dy++) covered.fill(1, dy * width + Math.max(0, x - GROW), dy * width + Math.min(width, x + GROW + 1))
  }
  return { x0, y0, width, height, covered }
}
