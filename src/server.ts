import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildHttpApp } from './adapters/http/app.js'
import { createRuntime } from './infrastructure/runtime.js'

const runtime = await createRuntime()
const candidateStaticDir = resolve(process.env.ISTRA_STATIC_DIR ?? 'dist-web')
const staticDir = await stat(candidateStaticDir).then((entry) => entry.isDirectory() ? candidateStaticDir : undefined, () => undefined)
const app = await buildHttpApp({ service: runtime.service, staticDir, logger: true })
const port = Number(process.env.PORT ?? 4317)

const close = async () => {
  await app.close()
  runtime.close()
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())

await app.listen({ host: '127.0.0.1', port })
