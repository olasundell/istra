import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export interface McpRuntimeInfo {
  bundleSha256: string | null
  startedAt: string
}

// Capture once at start-up: a running process must keep reporting its original
// bundle even if a plugin refresh subsequently replaces the file on disk.
export async function captureMcpRuntimeInfo(entrypoint: URL): Promise<McpRuntimeInfo> {
  const startedAt = new Date().toISOString()
  const bundle = await readFile(entrypoint)
  return Object.freeze({
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    startedAt,
  })
}
