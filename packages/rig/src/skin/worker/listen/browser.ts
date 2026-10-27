export function listen<T, R>(compute: (job: T) => R | Promise<R>, transfer: (result: R) => ArrayBuffer[] = () => []): void {
  globalThis.addEventListener('message', async (event: MessageEvent<T>) => {
    try {
      const result = await compute(event.data)
      globalThis.postMessage({ result }, { transfer: transfer(result) })
    } catch (error) {
      globalThis.postMessage({ error: error instanceof Error ? error : new Error(String(error)) })
    }
  }, { once: true })
}
