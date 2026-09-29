declare module 'gltf-validator' {
  interface Message {
    code: string
    message: string
    severity: number
    pointer?: string
  }
  export function validateBytes(
    data: Uint8Array,
    options?: { maxIssues?: number; ignoredIssues?: string[] },
  ): Promise<{ issues: { numErrors: number; numWarnings: number; messages: Message[] } }>
}
