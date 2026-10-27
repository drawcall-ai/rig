import { listen } from '#worker'
import { computeWeights } from '../weights.js'

listen(({ positions, indices, skeleton, resolution }) => computeWeights(positions, indices, skeleton, resolution))
