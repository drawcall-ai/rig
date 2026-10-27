import type { PreparedSolve, WeightBuffers } from '../solve.js'
import { shared, single } from './bytes.js'
import type { Task } from './run.js'

const PAGE = 65536
const modules = new Map<boolean, Promise<WebAssembly.Module>>()

function compile(parallel: boolean): Promise<WebAssembly.Module> {
  let module = modules.get(parallel)
  if (!module) {
    module = WebAssembly.compile(Uint8Array.from(atob(parallel ? shared : single), (char) => char.charCodeAt(0)))
    modules.set(parallel, module)
  }
  return module
}

export async function prepare(prepared: PreparedSolve, workers: number, cap: number) {
  if (!Number.isInteger(workers) || workers < 1) throw new RangeError('Rig worker count must be a positive integer')
  if (!Number.isInteger(cap) || cap < 0) throw new RangeError('Rig blur iterations must be a nonnegative integer')
  const { grid, initial } = prepared
  const arrays = [grid.isInsideFlat, grid.insideIndices, grid.flatToLocal, initial.bones, initial.weights, initial.count]
  // The linker reserves two pages for the kernel's static data and initial stack.
  let size = 2 * PAGE
  const reserve = (bytes: number): number => {
    size = Math.ceil(size / 8) * 8
    const offset = size
    size += bytes
    return offset
  }
  const offsets = arrays.map((array) => reserve(array.byteLength))
  const [inside, indices, map, bones, weights, count] = offsets
  const first = { bones, weights, count }
  // Fresh WASM memory already zeros the destination buffers.
  const second = {
    bones: reserve(initial.bones.byteLength),
    weights: reserve(initial.weights.byteLength),
    count: reserve(initial.count.byteLength),
  }
  const control = Math.ceil(size / 8) * 8
  const stacks = Math.ceil((control + 16 + workers * 8) / 16) * 16
  const pages = Math.ceil((stacks + workers * PAGE) / PAGE)
  const module = await compile(workers > 1)
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: workers > 1 })
  const heap = new Uint8Array(memory.buffer)
  arrays.forEach((array, index) => heap.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offsets[index]))
  const insideCount = grid.insideIndices.length
  const tasks: Task[] = Array.from({ length: workers }, (_, index) => ({
    module, memory, dimensions: grid.dimensions, insideCount, inside, indices, map,
    a: first, b: second, stack: stacks + (index + 1) * PAGE, control, index, workers, cap,
  }))
  return {
    tasks,
    result(iterations: number): WeightBuffers {
      const final = iterations % 2 === 0 ? first : second
      return {
        bones: new Uint8Array(memory.buffer, final.bones, insideCount * 4),
        weights: new Float32Array(memory.buffer, final.weights, insideCount * 4),
        count: new Uint8Array(memory.buffer, final.count, insideCount),
      }
    },
  }
}
