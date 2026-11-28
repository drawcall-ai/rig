/** The surface as a graph of welded vertices, and harmonic fields over it: fixed values at seeds, smooth in between. */

import type * as THREE from 'three'

export interface SurfaceGraph {
  /** Node of each vertex: vertices with one topological id share a node. */
  node: Int32Array
  adj: number[][]
}

/** Edges between topological ids, so seams join and cuts (distinct ids) separate. */
export function surfaceGraph(geometry: THREE.BufferGeometry, topo: Int32Array): SurfaceGraph {
  const ids = new Map<number, number>()
  const node = new Int32Array(topo.length)
  for (let v = 0; v < topo.length; v++) {
    let n = ids.get(topo[v])
    if (n === undefined) ids.set(topo[v], (n = ids.size))
    node[v] = n
  }
  const sets: Set<number>[] = Array.from({ length: ids.size }, () => new Set())
  const index = geometry.getIndex()
  if (!index) throw new Error('face: surfaceGraph needs an indexed geometry')
  for (let t = 0; t < index.count; t += 3) for (let k = 0; k < 3; k++) {
    const a = node[index.getX(t + k)], b = node[index.getX(t + (k + 1) % 3)]
    if (a !== b) { sets[a].add(b); sets[b].add(a) }
  }
  return { node, adj: sets.map((s) => [...s]) }
}

/** Solves Δw = 0 on the active free nodes by Gauss-Seidel; `fixed` maps node -> value, unreached nodes keep `initial`. */
export function harmonic(adj: number[][], fixed: Map<number, number>, active: Uint8Array, iterations: number, initial = 0): Float32Array {
  const w = new Float32Array(adj.length).fill(initial)
  for (const [n, value] of fixed) w[n] = value
  const free = [...adj.keys()].filter((n) => active[n] && !fixed.has(n))
  for (let it = 0; it < iterations; it++) {
    let change = 0
    for (const n of free) {
      let sum = 0, count = 0
      for (const m of adj[n]) if (active[m]) { sum += w[m]; count++ }
      if (!count) continue
      const next = sum / count
      change = Math.max(change, Math.abs(next - w[n]))
      w[n] = next
    }
    if (change < 1e-6) break
  }
  return w
}

/** A harmonic field per vertex (inactive vertices 0). */
export function vertexField(graph: SurfaceGraph, fixed: Map<number, number>, active: Uint8Array, iterations: number): Float32Array {
  const h = harmonic(graph.adj, fixed, active, iterations)
  return Float32Array.from(graph.node, (n) => (active[n] ? h[n] : 0))
}
