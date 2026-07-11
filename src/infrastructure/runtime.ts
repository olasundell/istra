import { IstraService } from '../application/istra-service.js'
import { openIstraDatabase } from './sqlite/database.js'
import { SqliteIstraRepository } from './sqlite/repository.js'
import { SqliteOperationalRepository } from './sqlite/operational-repository.js'

export async function createRuntime(options: { dataDir?: string; databasePath?: string; backupDir?: string } = {}) {
  const database = await openIstraDatabase(options)
  const repository = new SqliteIstraRepository(database.db)
  const operationalRepository = new SqliteOperationalRepository(database.db)
  const service = new IstraService(repository, database.backupManager, operationalRepository)
  return { ...database, repository, operationalRepository, service, close: () => database.db.close() }
}
