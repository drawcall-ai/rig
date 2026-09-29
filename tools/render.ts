/**
 * render: PNG images of a model (skinned or not) with its skeleton, from exact
 * axis-aligned orthographic views with a world-coordinate grid, optionally
 * posed by a keyframe animation. One call renders every view x time combination.
 *
 *   npx tsx tools/render.ts model.glb --out shots/a [--view +x,+z,+y,persp] [--t 0,0.25]
 *     [--animation run.json] [--xray] [--labels] [--no-bones] [--weights <bone>] [--size 900]
 *
 * Views: +x means the camera sits on the +x side looking toward -x (also -x, +y
 * (top), -y, +z, -z); persp is a 3/4 perspective view for judging shape.
 * Writes <out>-<view>[-t<t>].png and prints the paths.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { fail, isMain } from './model.js'
import type { Shot } from './render/page.js'

export interface RenderOptions {
  out: string
  views: string[]
  times: number[]
  animation?: string
  pose?: Shot['pose']
  /** Zoom on a bone (by name) or a world-space sphere. */
  focus?: string | Shot['focus']
  xray?: boolean
  labels?: boolean
  /** Draw the skeleton (default true). */
  bones?: boolean
  /** Color vertices by their weight on this bone (blue 0 -> red 1). */
  weights?: string
  /** Tile every shot into one image <out>-sheet.png instead of one file per shot. */
  sheet?: boolean
  size?: number
}

/** A headless page with the model loaded; call its methods, then close(). */
export async function openPage(model: string, options: { animation?: string; size?: number } = {}) {
  const size = options.size ?? 900
  const server = await createServer({
    root: fileURLToPath(new URL('./render', import.meta.url)),
    logLevel: 'silent',
    server: { port: 0, fs: { strict: false } },
  })
  await server.listen()
  const address = server.httpServer?.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const close = async () => {
    await browser.close()
    await server.close()
  }
  try {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const query = new URLSearchParams({ model: `/@fs${resolve(model)}`, size: String(size) })
    if (options.animation) query.set('animation', `/@fs${resolve(options.animation)}`)
    await page.goto(`http://localhost:${port}/?${query}`)
    await page.waitForSelector('body[data-ready=true]', { timeout: 60000 }).catch(() => {
      throw new Error(`page failed to load: ${errors.join('; ') || 'timeout'}`)
    })
    type Api = { grab(s: Shot): string; sheet(s: Shot[], cols: number, cell: number): string; joints(): Joint[] }
    return {
      grab: async (shot: Shot, file: string) =>
        save(await page.evaluate((s) => (window as unknown as Api).grab(s), shot), file),
      sheet: async (shots: Shot[], file: string, cols = Math.min(4, shots.length), cell = 450) =>
        save(await page.evaluate(([s, c, n]) => (window as unknown as Api).sheet(s, c, n), [shots, cols, cell] as const), file),
      joints: () => page.evaluate(() => (window as unknown as Api).joints()),
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

export interface Joint {
  name: string
  position: number[]
  child?: string
  parent?: string
}

/** A sphere around a bone: centered on its segment, radius 1.5x its length. */
async function boneFocus(page: Awaited<ReturnType<typeof openPage>>, name: string): Promise<Shot['focus']> {
  const joints = await page.joints()
  const joint = joints.find((j) => j.name === name)
  if (!joint) throw new Error(`focus names unknown bone "${name}"`)
  const other = joints.find((j) => j.name === joint.child) ?? joints.find((j) => j.name === joint.parent) ?? joint
  const center = joint.position.map((p, i) => (p + other.position[i]) / 2) as [number, number, number]
  const length = Math.hypot(...joint.position.map((p, i) => p - other.position[i]))
  const all = joints.map((j) => j.position[1])
  return { center, radius: Math.max(length * 1.5, (Math.max(...all) - Math.min(...all)) * 0.08) }
}

function save(dataUrl: string, file: string): string {
  mkdirSync(dirname(resolve(file)), { recursive: true })
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))
  return file
}

export async function render(model: string, options: RenderOptions): Promise<string[]> {
  const page = await openPage(model, { animation: options.animation, size: options.size })
  try {
    const focus = typeof options.focus === 'string' ? await boneFocus(page, options.focus) : options.focus
    const shots = options.times.flatMap((t) =>
      options.views.map((view): Shot => ({
        view,
        t,
        pose: options.pose,
        focus,
        xray: options.xray,
        labels: options.labels,
        bones: options.bones,
        weights: options.weights,
        title: options.sheet ? `${view}${options.times.length > 1 ? ` t=${t}` : ''}` : undefined,
      })),
    )
    if (options.sheet) return [await page.sheet(shots, `${options.out}${options.weights ? `-w-${options.weights}` : ''}-sheet.png`)]
    const files: string[] = []
    for (const shot of shots) {
      const tag = `${shot.view.replace('+', 'p').replace('-', 'n')}${options.times.length > 1 || options.animation ? `-t${shot.t}` : ''}${options.weights ? `-w-${options.weights}` : ''}`
      files.push(await page.grab(shot, `${options.out}-${tag}.png`))
    }
    return files
  } finally {
    await page.close()
  }
}

if (isMain(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      view: { type: 'string' },
      t: { type: 'string' },
      animation: { type: 'string' },
      xray: { type: 'boolean' },
      labels: { type: 'boolean' },
      'no-bones': { type: 'boolean' },
      sheet: { type: 'boolean' },
      weights: { type: 'string' },
      size: { type: 'string' },
    },
  })
  const [model] = positionals
  if (!model || !values.out) {
    fail('usage: render <model.glb> --out <prefix> [--view +x,+z,+y,persp] [--t 0,0.25] [--animation clip.json] [--xray] [--labels] [--size 900]')
  }
  const files = await render(model, {
    out: values.out,
    views: (values.view ?? '+x,+z,+y,persp').split(','),
    times: (values.t ?? '0').split(',').map(Number),
    animation: values.animation,
    xray: values.xray,
    labels: values.labels,
    bones: !values['no-bones'],
    weights: values.weights,
    sheet: values.sheet,
    size: values.size ? Number(values.size) : undefined,
  })
  for (const file of files) console.log(file)
}
