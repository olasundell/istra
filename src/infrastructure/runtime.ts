import { IstraService } from '../application/istra-service.js'
import { openIstraDatabase } from './sqlite/database.js'
import { SqliteIstraRepository } from './sqlite/repository.js'

export async function createRuntime(options: { dataDir?: string; databasePath?: string } = {}) {
  const database = await openIstraDatabase(options)
  const repository = new SqliteIstraRepository(database.db)
  const service = new IstraService(repository, database.backupManager)
  return { ...database, repository, service, close: () => database.db.close() }
}
