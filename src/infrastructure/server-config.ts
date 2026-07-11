import { z } from 'zod'

const serverEnvironmentSchema = z.object({
  ISTRA_HOST: z.enum(['127.0.0.1', 'localhost', '::1', '0.0.0.0']).default('127.0.0.1'),
  ISTRA_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.string().regex(/^\d+$/, 'PORT must be an integer').default('4317'),
})

export interface ServerConfig {
  host: string
  logLevel: string
  port: number
}

export function readServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = serverEnvironmentSchema.parse(environment)
  const port = Number(parsed.PORT)
  if (port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535')
  return { host: parsed.ISTRA_HOST, logLevel: parsed.ISTRA_LOG_LEVEL, port }
}
