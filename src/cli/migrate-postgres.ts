import type { ExportBundle, IstraRepository, OperationalRepository } from '../application/ports.js'
import { canonicalJson } from '../domain/canonical-json.js'
import type { SearchFilters, SearchResult } from '../domain/contracts.js'
import { openPostgresDatabase } from '../infrastructure/postgres/database.js'
import { PostgresOperationalRepository } from '../infrastructure/postgres/operational-repository.js'
import { PostgresIstraRepository } from '../infrastructure/postgres/repository.js'
import { openIstraDatabase } from '../infrastructure/sqlite/database.js'
import { SqliteOperationalRepository } from '../infrastructure/sqlite/operational-repository.js'
import { SqliteIstraRepository } from '../infrastructure/sqlite/repository.js'
import { resolveStorageConfig, writeStorageFile } from '../infrastructure/storage-config.js'

interface SearchProbe {
  query: string
  filters: SearchFilters
}

function searchKeys(results: SearchResult[]): string[] {
  return [...new Set(results.map((result) => `${result.type}:${result.id}`))].sort()
}

async function combinedSearch(
  repository: IstraRepository,
  operational: OperationalRepository,
  query: string,
  filters: SearchFilters,
): Promise<string[]> {
  const [core, operationalResults] = await Promise.all([
    repository.search(query, 200, filters),
    operational.search(query, 200, filters),
  ])
  return searchKeys([...core, ...operationalResults])
}

function representativeSearchProbes(bundle: ExportBundle): SearchProbe[] {
  const candidates: Array<{ table: string; type: SearchResult['type']; columns: string[] }> = [
    { table: 'projects', type: 'project', columns: ['title', 'description', 'intent'] },
    { table: 'phases', type: 'phase', columns: ['name', 'description'] },
    { table: 'work_items', type: 'work_item', columns: ['title', 'description'] },
    { table: 'requirements', type: 'requirement', columns: ['title', 'description', 'stable_key'] },
    { table: 'runs', type: 'run', columns: ['command', 'stdout_excerpt', 'stderr_excerpt'] },
    { table: 'evidence', type: 'evidence', columns: ['summary'] },
  ]
  const probes: SearchProbe[] = []
  for (const candidate of candidates) {
    for (const row of bundle.tables[candidate.table] ?? []) {
      const text = candidate.columns
        .map((column) => row[column])
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
      const query = text.match(/[A-Za-z][A-Za-z0-9_]{3,}/)?.[0]
      const projectId = candidate.type === 'project' ? row.id : row.project_id
      if (!query || typeof projectId !== 'string') continue
      probes.push({ query, filters: { projectId, entityTypes: [candidate.type] } })
      break
    }
  }
  return probes
}

async function verifyLogicalParity(
  bundle: ExportBundle,
  sourceRepository: IstraRepository,
  sourceOperational: OperationalRepository,
  targetRepository: IstraRepository,
  targetOperational: OperationalRepository,
): Promise<{ projectCount: number; searchProbeCount: number }> {
  const [sourceProjects, targetProjects] = await Promise.all([
    sourceRepository.listProjects({ includeArchived: true }),
    targetRepository.listProjects({ includeArchived: true }),
  ])
  const sourceProjectIds = sourceProjects.map(({ id }) => id).sort()
  const targetProjectIds = targetProjects.map(({ id }) => id).sort()
  if (canonicalJson(sourceProjectIds) !== canonicalJson(targetProjectIds)) {
    throw new Error('PostgreSQL project verification did not match the SQLite source')
  }

  for (const projectId of sourceProjectIds) {
    const [sourceWork, targetWork, sourceRequirements, targetRequirements, sourceEvidence, targetEvidence] = await Promise.all([
      sourceRepository.listWorkItems(projectId),
      targetRepository.listWorkItems(projectId),
      sourceOperational.listRequirements(projectId),
      targetOperational.listRequirements(projectId),
      sourceOperational.listEvidence(projectId, true),
      targetOperational.listEvidence(projectId, true),
    ])
    if (
      sourceWork.length !== targetWork.length
      || sourceRequirements.length !== targetRequirements.length
      || sourceEvidence.length !== targetEvidence.length
    ) {
      throw new Error(`PostgreSQL entity-count verification failed for project ${projectId}`)
    }
  }

  const checkpointHeads = (rows: Array<Record<string, unknown>>) => rows
    .map((row) => ({ checkpointId: row.checkpoint_id, digest: row.digest }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  const targetBundle = await targetRepository.exportAll()
  if (canonicalJson(checkpointHeads(bundle.tables.checkpoint_snapshots ?? [])) !== canonicalJson(checkpointHeads(targetBundle.tables.checkpoint_snapshots ?? []))) {
    throw new Error('PostgreSQL checkpoint verification did not match the SQLite source')
  }

  const probes = representativeSearchProbes(bundle)
  for (const probe of probes) {
    const [sourceResults, targetResults] = await Promise.all([
      combinedSearch(sourceRepository, sourceOperational, probe.query, probe.filters),
      combinedSearch(targetRepository, targetOperational, probe.query, probe.filters),
    ])
    if (canonicalJson(sourceResults) !== canonicalJson(targetResults)) {
      throw new Error(`PostgreSQL filtered-search verification failed for ${probe.filters.entityTypes?.[0] ?? 'entity'} data`)
    }
  }
  return { projectCount: sourceProjectIds.length, searchProbeCount: probes.length }
}

const databaseUrl = process.env.ISTRA_DATABASE_URL
if (!databaseUrl) throw new Error('Set ISTRA_DATABASE_URL to the empty PostgreSQL target before running storage:migrate:postgres')

// The source is always opened explicitly as SQLite. ISTRA_DATABASE_URL must
// never redirect the source side of this one-way migration.
const sourceConfig = await resolveStorageConfig({ backend: 'sqlite' })
const source = await openIstraDatabase({
  dataDir: sourceConfig.dataDir,
  databasePath: sourceConfig.databasePath,
  backupDir: sourceConfig.backupDir,
})
const target = await openPostgresDatabase({
  connectionString: databaseUrl,
  max: sourceConfig.poolMax,
  applicationName: 'istra-storage-migration',
})

const sourceRepository = new SqliteIstraRepository(source.db)
const sourceOperational = new SqliteOperationalRepository(source.db)
const targetRepository = new PostgresIstraRepository(target.executor)
const targetOperational = new PostgresOperationalRepository(target.executor)
let imported = false
let activated = false

try {
  const sourceBundle = await sourceRepository.exportAll()
  await sourceRepository.validateImport(sourceBundle)
  const expected = canonicalJson(sourceBundle.tables)

  if (!await targetRepository.isEmpty()) throw new Error('PostgreSQL target is not empty; refusing to overwrite existing data')
  const backupSuffix = `postgres-cutover-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`
  await source.backupManager.create('pre-migration', backupSuffix)
  await targetRepository.importForMigration(sourceBundle)
  imported = true

  const copied = await targetRepository.exportAll()
  if (canonicalJson(copied.tables) !== expected) throw new Error('PostgreSQL verification did not match the SQLite source')
  const verification = await verifyLogicalParity(sourceBundle, sourceRepository, sourceOperational, targetRepository, targetOperational)

  await writeStorageFile(sourceConfig.configPath, {
    backend: 'postgresql',
    databaseUrl,
    poolMax: sourceConfig.poolMax,
  })
  activated = true

  const tableCount = Object.keys(sourceBundle.tables).length
  const rowCount = Object.values(sourceBundle.tables).reduce((total, rows) => total + rows.length, 0)
  console.log(`Migrated and verified ${rowCount} rows across ${tableCount} portable tables; shared storage is now PostgreSQL.`)
  console.log(`Verified ${verification.projectCount} projects and ${verification.searchProbeCount} representative filtered searches.`)
  console.log(`Target: ${target.target}`)
} catch (error) {
  if (imported && !activated) {
    try {
      await targetRepository.clearForFailedActivation()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'PostgreSQL migration failed and its imported rows could not be cleared')
    }
  }
  throw error
} finally {
  source.db.close()
  await target.close()
}
