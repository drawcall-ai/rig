/**
 * Imported first by every test that loads through the cache: points the cache service at a port fetch refuses, so no
 * test reaches the network. The cache warns once that the service is unreachable and computes locally.
 */
process.env.DRAWCALL_CACHE_URL = 'http://127.0.0.1:1'
