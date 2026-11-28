/** The cheek mass's shape, shared by the face rig's `cheekBulge` shapes and the wrinkles' dome. */
export const CHEEK_MASS = {
  /** Half extents above and below the apex and to the sides. */
  size: { up: 0.01544, down: 0.02907, wide: 0.02362 },
  /**
   * Where the mass ends: nothing within `midline` of the face's midline; along the nasolabial line an edge from
   * `crisp[0]` to `crisp[1]` lateral of it, widened by `soften` where the fold fades out from `below` under to `above`
   * over the nose wing.
   */
  edge: { midline: 0.00727, crisp: [-0.00055, 0.00291], soften: [-0.00218, 0.00636], below: 0.00182, above: 0.00727 },
} as const
