import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildHttpApp } from './adapters/http/app.js'
import { createRuntime } from './infrastructure/runtime.js'
import { createReadinessWatchdog } from './infrastructure/readiness-watchdog.js'
import { readServerConfig } from './infrastructure/server-config.js'
import { shutdownProcess, type ShutdownReason } from './infrastructure/shutdown.js'

const config = readServerConfig()
const runtime = await createRuntime()
const candidateStaticDir = resolve(process.env.ISTRA_STATIC_DIR ?? 'dist-web')
const staticDir = await stat(candidateStaticDir).then((entry) => entry.isDirectory() ? candidateStaticDir : undefined, () => undefined)
const readinessCheck = createReadinessWatchdog(
  () => runtime.healthCheck(),
  {
    failureThreshold: config.readinessFailureExitThreshold,
    intervalMillis: 10_000,
    onFailureThreshold: (_error, consecutiveFailures) => {
      app.log.fatal({ consecutiveFailures }, 'PostgreSQL readiness failed repeatedly; restarting Istra')
      setImmediate(() => void close('readiness_failure'))
    },
  },
)
const app = await buildHttpApp({
  service: runtime.service,
  staticDir,
  logger: { level: config.logLevel },
  readinessCheck: () => runtime.healthCheck(),
})

let shutdown: Promise<void> | undefined
function close(signal: ShutdownReason) {
  if (shutdown) return shutdown
  readinessCheck.stop()
  app.log.info({ signal }, 'Shutting down Istra')
  shutdown = shutdownProcess({
    reason: signal,
    timeoutMillis: 10_000,
    closeApp: () => app.close(),
    closeRuntime: () => runtime.close(),
    onClean: () => app.log.info({ signal }, 'Istra stopped cleanly'),
    onError: (error) => app.log.error(error, 'Failed to shut down Istra cleanly'),
    onTimeout: () => {
      app.log.fatal({ signal }, 'Timed out while shutting down Istra')
    },
    exit: (code) => process.exit(code),
  })
  return shutdown
}
process.once('SIGINT', () => void close('SIGINT'))
process.once('SIGTERM', () => void close('SIGTERM'))

await app.listen({ host: config.host, port: config.port })
readinessCheck.start()
