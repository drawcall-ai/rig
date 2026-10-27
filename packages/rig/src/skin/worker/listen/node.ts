import { parentPort } from 'node:worker_threads'

export function listen<T, R>(compute: (job: T) => R | Promise<R>, transfer: (result: R) => ArrayBuffer[] = () => []): void {
  const port = parentPort
  if (!port) throw new Error('Rig worker requires a parent port')
  port.once('message', async (job: T) => {
    try {
      const result = await compute(job)
      port.postMessage({ result }, transfer(result))
    } catch (error) {
      port.postMessage({ error: error instanceof Error ? error : new Error(String(error)) })
    }
  })
}
