interface Pointers {
  bones: number
  weights: number
  count: number
}

export interface Task {
  module: WebAssembly.Module
  memory: WebAssembly.Memory
  dimensions: readonly [number, number, number]
  insideCount: number
  inside: number
  indices: number
  map: number
  a: Pointers
  b: Pointers
  stack: number
  control: number
  index: number
  workers: number
  cap: number
}

export async function run(task: Task): Promise<number> {
  const { exports } = await WebAssembly.instantiate(task.module, { env: { memory: task.memory } })
  const { blur, __stack_pointer: stack } = exports
  if (typeof blur !== 'function' || !(stack instanceof WebAssembly.Global)) throw new Error('Invalid rig WASM kernel')
  // Each instance needs its own stack even though its data memory is shared.
  stack.value = task.stack
  const state = new Int32Array(task.memory.buffer, task.control, 4)
  const changes = new Float64Array(task.memory.buffer, task.control + 16, task.workers)
  const begin = Math.floor(task.insideCount * task.index / task.workers)
  const end = Math.floor(task.insideCount * (task.index + 1) / task.workers)
  let iterations = 0

  for (let iter = 0; iter < task.cap; iter++) {
    iterations = iter + 1
    const src = iter % 2 === 0 ? task.a : task.b
    const dst = iter % 2 === 0 ? task.b : task.a
    const change: unknown = blur(
      ...task.dimensions, task.inside, task.indices, task.map,
      src.bones, src.weights, src.count, dst.bones, dst.weights, dst.count, begin, end,
    )
    if (typeof change !== 'number' || !Number.isFinite(change)) throw new Error('Rig WASM produced an invalid change')
    if (task.workers === 1) {
      if (change < 0.001 && iter > 10) break
      continue
    }

    changes[task.index] = change
    if (Atomics.add(state, 0, 1) === task.workers - 1) {
      let maximum = 0
      for (const value of changes) maximum = Math.max(maximum, value)
      Atomics.store(state, 2, Number(maximum < 0.001 && iter > 10))
      Atomics.store(state, 0, 0)
      Atomics.add(state, 1, 1)
      Atomics.notify(state, 1)
    } else {
      while (Atomics.load(state, 1) === iter) Atomics.wait(state, 1, iter)
    }
    if (Atomics.load(state, 2)) break
  }
  return iterations
}
