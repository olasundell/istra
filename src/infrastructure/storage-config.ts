import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'

export const StorageBackendSchema = z.enum(['sqlite', 'postgresql'])
export type StorageBackend = z.infer<typeof StorageBackendSchema>

const storageFileSchema = z.object({
  backend: StorageBackendSchema,
  databaseUrl: z.string().trim().min(1).optional(),
  poolMax: z.number().int().min(1).max(20).optional(),
}).strict().superRefine((value, context) => {
  if (value.backend === 'postgresql' && !value.databaseUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['databaseUrl'], message: 'databaseUrl is required for PostgreSQL' })
  }
})

export interface StorageFileConfig {
  backend: StorageBackend
  databaseUrl?: string
  poolMax?: number
}

export interface ResolvedStorageConfig {
  backend: StorageBackend
  databaseUrl?: string
  poolMax: number
  dataDir: string
  databasePath?: string
  backupDir?: string
  configPath: string
}

export interface StorageConfigOptions {
  backend?: StorageBackend
  databaseUrl?: string
  poolMax?: number
  dataDir?: string
  databasePath?: string
  backupDir?: string
  configPath?: string
  environment?: NodeJS.ProcessEnv
}

export function defaultIstraDataDir(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Istra')
  if (process.platform === 'win32') return join(environment.LOCALAPPDATA ?? homedir(), 'Istra')
  return join(environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'istra')
}

function parseDatabaseUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('ISTRA_DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('ISTRA_DATABASE_URL must use the postgres or postgresql scheme')
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('ISTRA_DATABASE_URL must include a host and database name')
  }
  return value
}

function parsePoolMax(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) throw new Error('ISTRA_POSTGRES_POOL_MAX must be an integer between 1 and 20')
  return parsed
}

export async function readStorageFile(configPath: string): Promise<StorageFileConfig | null> {
  const document = await readFile(configPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (document === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(document)
  } catch {
    throw new Error(`Istra storage configuration is not valid JSON: ${configPath}`)
  }
  const result = storageFileSchema.safeParse(parsed)
  if (!result.success) throw new Error(`Istra storage configuration is invalid: ${result.error.issues.map((issue) => issue.message).join('; ')}`)
  return result.data
}

export async function resolveStorageConfig(options: StorageConfigOptions = {}): Promise<ResolvedStorageConfig> {
  const environment = options.environment ?? process.env
  const dataDir = resolve(options.dataDir ?? environment.ISTRA_DATA_DIR ?? defaultIstraDataDir(environment))
  const configPath = resolve(options.configPath ?? environment.ISTRA_CONFIG_PATH ?? join(dataDir, 'config.json'))
  const stored = await readStorageFile(configPath)

  const explicitBackend = options.backend ?? (options.databaseUrl ? 'postgresql' : undefined)
  const environmentBackend = environment.ISTRA_STORAGE
    ? StorageBackendSchema.parse(environment.ISTRA_STORAGE)
    : environment.ISTRA_DATABASE_URL
      ? 'postgresql'
      : undefined
  const backend = explicitBackend ?? environmentBackend ?? stored?.backend ?? 'sqlite'
  const databaseUrl = options.databaseUrl ?? environment.ISTRA_DATABASE_URL ?? stored?.databaseUrl
  const poolMax = parsePoolMax(options.poolMax ?? environment.ISTRA_POSTGRES_POOL_MAX ?? stored?.poolMax) ?? 4

  if (backend === 'postgresql') {
    if (!databaseUrl) throw new Error('PostgreSQL storage requires ISTRA_DATABASE_URL or databaseUrl in the shared Istra config')
    return { backend, databaseUrl: parseDatabaseUrl(databaseUrl), poolMax, dataDir, configPath }
  }

  const databasePath = resolve(options.databasePath ?? join(dataDir, 'istra.sqlite3'))
  const backupDir = resolve(options.backupDir ?? environment.ISTRA_BACKUP_DIR ?? join(dirname(databasePath), 'backups'))
  return { backend, poolMax, dataDir: dirname(databasePath), databasePath, backupDir, configPath }
}

export async function writeStorageFile(configPath: string, value: StorageFileConfig): Promise<void> {
  const parsed = storageFileSchema.parse(value)
  const absolute = resolve(configPath)
  await mkdir(dirname(absolute), { recursive: true })
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, absolute)
  await chmod(absolute, 0o600)
}

export function redactDatabaseUrl(value: string): string {
  const parsed = new URL(value)
  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}
