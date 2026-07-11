import { IstraService } from '../application/istra-service.js'
import type { IstraRepository, OperationalRepository, StorageStatus } from '../application/ports.js'
import { postgresDataProtection, sqliteDataProtection } from './data-protection.js'
import { openPostgresDatabase } from './postgres/database.js'
import { PostgresIstraRepository } from './postgres/repository.js'
import { PostgresOperationalRepository } from './postgres/operational-repository.js'
import { openIstraDatabase } from './sqlite/database.js'
import { migrations as sqliteMigrations } from './sqlite/migrations.js'
import { SqliteOperationalRepository } from './sqlite/operational-repository.js'
import { SqliteIstraRepository } from './sqlite/repository.js'
import { resolveStorageConfig, type StorageConfigOptions } from './storage-config.js'

export interface IstraRuntime {
  backend: 'sqlite' | 'postgresql'
  repository: IstraRepository
  operationalRepository: OperationalRepository
  service: IstraService
  healthCheck(): Promise<void>
  storageStatus(): Promise<StorageStatus>
  close(): Promise<void>
}

export async function createRuntime(options: StorageConfigOptions = {}): Promise<IstraRuntime> {
  const config = await resolveStorageConfig(options)

  if (config.backend === 'postgresql') {
    const database = await openPostgresDatabase({
      connectionString: config.databaseUrl!,
      max: config.poolMax,
      applicationName: 'istra',
    })
    const repository = new PostgresIstraRepository(database.executor)
    const operationalRepository = new PostgresOperationalRepository(database.executor)
    const protection = postgresDataProtection()
    const healthCheck = async () => {
      const health = await database.healthCheck()
      if (!health.ready) throw new Error('PostgreSQL is not ready')
    }
    const storageStatus = async (): Promise<StorageStatus> => {
      const health = await database.healthCheck()
      return {
        backend: 'postgresql', target: database.target, schemaVersion: health.schemaVersion, ready: health.ready,
        automaticBackups: false, importSupported: false,
      }
    }
    const service = new IstraService(repository, protection, operationalRepository, storageStatus)
    return {
      backend: 'postgresql', repository, operationalRepository, service, healthCheck, storageStatus,
      close: () => database.close(),
    }
  }

  const database = await openIstraDatabase({
    dataDir: config.dataDir,
    databasePath: config.databasePath,
    backupDir: config.backupDir,
  })
  const repository = new SqliteIstraRepository(database.db)
  const operationalRepository = new SqliteOperationalRepository(database.db)
  const protection = sqliteDataProtection(database.backupManager)
  const healthCheck = async () => { database.db.prepare('SELECT 1').get() }
  const storageStatus = async (): Promise<StorageStatus> => {
    let ready = true
    try { await healthCheck() } catch { ready = false }
    return {
      backend: 'sqlite', target: database.paths.databasePath, schemaVersion: sqliteMigrations.at(-1)?.version ?? 0, ready,
      automaticBackups: true, importSupported: true,
    }
  }
  const service = new IstraService(repository, protection, operationalRepository, storageStatus)
  return {
    backend: 'sqlite', repository, operationalRepository, service, healthCheck, storageStatus,
    close: async () => database.db.close(),
  }
}
