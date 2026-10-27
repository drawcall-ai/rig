import { listen } from '#listen'
import { computeWeights } from '../weights.js'
import type { Job } from '../worker.js'

listen(
  ({ positions, indices, skeleton, resolution }: Job) => computeWeights(positions, indices, skeleton, resolution),
  (result) => [result.skinIndices.buffer, result.skinWeights.buffer],
)
