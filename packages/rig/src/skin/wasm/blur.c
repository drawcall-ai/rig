/* Sparse top-four diffusion. Preserve Number arithmetic and Float32 stores exactly. */
#include <stdint.h>
#include <math.h>

static const float kernel[4] = {0.0f, 4.0f / 56.0f, 2.0f / 56.0f, 1.0f / 56.0f};

double blur(
    uint32_t dim_x, uint32_t dim_y, uint32_t dim_z,
    const uint8_t *inside, const uint32_t *indices, const uint32_t *flat_to_local,
    const uint8_t *src_bones, const float *src_weights, const uint8_t *src_count,
    uint8_t *dst_bones, float *dst_weights, uint8_t *dst_count,
    uint32_t begin, uint32_t end) {
  float sum[256] = {0};
  uint8_t seen[256] = {0};
  uint8_t list[256];
  uint32_t dim_yz = dim_y * dim_z;
  double max_change = 0;
  for (uint32_t local = begin; local < end; local++) {
    uint32_t idx = indices[local];
    int32_t x = idx / dim_yz;
    uint32_t rem = idx - x * dim_yz;
    int32_t y = rem / dim_z;
    int32_t z = rem - y * dim_z;
    uint32_t num_seen = 0;
    double total_w = 0;
    for (int32_t dx = -1; dx <= 1; dx++) {
      int32_t nx = x + dx;
      if (nx < 0 || nx >= dim_x) continue;
      for (int32_t dy = -1; dy <= 1; dy++) {
        int32_t ny = y + dy;
        if (ny < 0 || ny >= dim_y) continue;
        for (int32_t dz = -1; dz <= 1; dz++) {
          int32_t nz = z + dz;
          if (nz < 0 || nz >= dim_z) continue;
          uint32_t neighbor = nx * dim_yz + ny * dim_z + nz;
          if (!inside[neighbor]) continue;
          int32_t manhattan = (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy) + (dz < 0 ? -dz : dz);
          double kw = kernel[manhattan];
          total_w += kw;
          uint32_t neighbor_local = flat_to_local[neighbor];
          uint32_t neighbor_count = src_count[neighbor_local];
          uint32_t neighbor_base = neighbor_local * 4;
          for (uint32_t i = 0; i < neighbor_count; i++) {
            uint32_t bone = src_bones[neighbor_base + i];
            if (!seen[bone]) {
              seen[bone] = 1;
              list[num_seen++] = bone;
            }
            /* JS multiplies/adds as Number, then rounds the Float32Array store. */
            sum[bone] = (float)((double)sum[bone] + (double)src_weights[neighbor_base + i] * kw);
          }
        }
      }
    }
    uint32_t out_base = local * 4;
    uint32_t source_count = src_count[local];
    uint32_t out_count = 0;
    if (total_w > 0) {
      double inv = 1.0 / total_w;
      uint32_t k_max = num_seen < 4 ? num_seen : 4;
      for (uint32_t k = 0; k < k_max; k++) {
        uint32_t max_index = k;
        for (uint32_t j = k + 1; j < num_seen; j++) {
          if (sum[list[j]] > sum[list[max_index]]) max_index = j;
        }
        if (max_index != k) {
          uint8_t tmp = list[k];
          list[k] = list[max_index];
          list[max_index] = tmp;
        }
        uint32_t bone = list[k];
        double new_w = sum[bone] * inv;
        if (new_w > 0.001) {
          dst_bones[out_base + out_count] = bone;
          dst_weights[out_base + out_count] = (float)new_w;
          double old_w = out_count < source_count && src_bones[out_base + out_count] == bone
              ? src_weights[out_base + out_count] : 0;
          double change = fabs(new_w - old_w);
          if (change > max_change) max_change = change;
          out_count++;
        }
      }
    }
    dst_count[local] = out_count;
    for (uint32_t i = 0; i < num_seen; i++) {
      sum[list[i]] = 0;
      seen[list[i]] = 0;
    }
  }
  return max_change;
}
