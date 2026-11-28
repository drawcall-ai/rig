import { readFile } from 'node:fs/promises'

/** The bytes of a packaged asset, read from the installed package. */
export async function read(url: URL): Promise<ArrayBuffer> {
  return Uint8Array.from(await readFile(url)).buffer
}
