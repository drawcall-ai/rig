/** Worker side of solveParallel: blur passes over a range of voxels in shared memory. */

import { parentPort } from 'node:worker_threads'
import { blurPass, type BlurGrid, type WeightBuffers } from './solve.js'

type Message =
  | { type: 'setup'; grid: BlurGrid; a: WeightBuffers; b: WeightBuffers }
  | { type: 'pass'; fromA: boolean; start: number; end: number }

let state: { grid: BlurGrid; a: WeightBuffers; b: WeightBuffers } | undefined

parentPort?.on('message', (message: Message) => {
  if (message.type === 'setup') {
    state = message
    parentPort?.postMessage(0)
    return
  }
  if (!state) throw new Error('blur worker got a pass before setup')
  const { grid, a, b } = state
  const change = message.fromA ? blurPass(grid, a, b, message.start, message.end) : blurPass(grid, b, a, message.start, message.end)
  parentPort?.postMessage(change)
})
