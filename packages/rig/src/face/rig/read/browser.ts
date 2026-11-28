/** The bytes of a packaged asset, fetched next to the module. */
export async function read(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`face: ${response.status} ${response.statusText} loading ${url.href}`)
  return response.arrayBuffer()
}
