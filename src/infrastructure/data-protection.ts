import type { DataProtection } from '../application/ports.js'
import type { BackupManager } from './sqlite/database.js'

export function sqliteDataProtection(manager: BackupManager): DataProtection {
  return {
    backend: 'sqlite',
    automatic: true,
    importSupported: true,
    databasePath: manager.paths.databasePath,
    beforeWrite: () => manager.beforeWrite(),
    create: (kind, suffix) => manager.create(kind, suffix),
    list: () => manager.list(),
  }
}

export function postgresDataProtection(): DataProtection {
  return {
    backend: 'postgresql',
    automatic: false,
    importSupported: false,
    beforeWrite: async () => undefined,
    create: async () => { throw new Error('PostgreSQL backup and restore support is not configured') },
    list: async () => [],
  }
}
