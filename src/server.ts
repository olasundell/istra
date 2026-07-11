import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildHttpApp } from './adapters/http/app.js'
import { createRuntime } from './infrastructure/runtime.js'
import { readServerConfig } from './infrastructure/server-config.js'

const config = readServerConfig()
const runtime = await createRuntime()
const candidateStaticDir = resolve(process.env.ISTRA_STATIC_DIR ?? 'dist-web')
const staticDir = await stat(candidateStaticDir).then((entry) => entry.isDirectory() ? candidateStaticDir : undefined, () => undefined)
const app = await buildHttpApp({
  service: runtime.service,
  staticDir,
  logger: { level: config.logLevel },
  readinessCheck: () => { runtime.db.prepare('SELECT 1').get() },
})

let shutdown: Promise<void> | undefined
const close = (signal: NodeJS.Signals) => {
  if (shutdown) return shutdown
  app.log.info({ signal }, 'Shutting down Istra')
  shutdown = (async () => {
    const deadline = setTimeout(() => {
      app.log.fatal({ signal }, 'Timed out while shutting down Istra')
      process.exit(1)
    }, 10_000)
    deadline.unref()
    try {
      await app.close()
      runtime.close()
      app.log.info({ signal }, 'Istra stopped cleanly')
    } finally {
      clearTimeout(deadline)
    }
  })().catch((error) => {
    app.log.error(error, 'Failed to shut down Istra cleanly')
    process.exitCode = 1
  })
  return shutdown
}
process.once('SIGINT', () => void close('SIGINT'))
process.once('SIGTERM', () => void close('SIGTERM'))

await app.listen({ host: config.host, port: config.port })
