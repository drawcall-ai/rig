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

import { resolve } from 'node:path'
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
  xray?: boolean
  labels?: boolean
  /** Draw the skeleton (default true). */
  bones?: boolean
  /** Color vertices by their weight on this bone (blue 0 -> red 1). */
  weights?: string
  size?: number
}

export async function render(model: string, options: RenderOptions): Promise<string[]> {
  const server = await createServer({
    root: fileURLToPath(new URL('./render', import.meta.url)),
    logLevel: 'silent',
    server: { port: 0, fs: { strict: false } },
  })
  await server.listen()
  const address = server.httpServer?.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const files: string[] = []
  try {
    const page = await browser.newPage({ viewport: { width: options.size ?? 900, height: options.size ?? 900 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const query = new URLSearchParams({ model: `/@fs${resolve(model)}`, size: String(options.size ?? 900) })
    if (options.animation) query.set('animation', `/@fs${resolve(options.animation)}`)
    await page.goto(`http://localhost:${port}/?${query}`)
    await page.waitForSelector('body[data-ready=true]', { timeout: 60000 }).catch(() => {
      throw new Error(`page failed to load: ${errors.join('; ') || 'timeout'}`)
    })
    for (const t of options.times) {
      for (const view of options.views) {
        const shot: Shot = {
          view,
          t,
          xray: options.xray ?? false,
          labels: options.labels ?? false,
          bones: options.bones,
          weights: options.weights,
        }
        await page.evaluate((s) => (window as unknown as { shoot: (s: Shot) => void }).shoot(s), shot)
        if (errors.length) throw new Error(errors.join('; '))
        const file = `${options.out}-${view.replace('+', 'p').replace('-', 'n')}${options.times.length > 1 || options.animation ? `-t${t}` : ''}${options.weights ? `-w-${options.weights}` : ''}.png`
        await page.locator('#view').screenshot({ path: file })
        files.push(file)
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  return files
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
    size: values.size ? Number(values.size) : undefined,
  })
  for (const file of files) console.log(file)
}
