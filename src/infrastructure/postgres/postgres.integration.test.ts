import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, ValidationError } from '../../application/errors.js'
import type { Provenance } from '../../domain/contracts.js'
import { canonicalJson } from '../../domain/canonical-json.js'
import { openIstraDatabase } from '../sqlite/database.js'
import { SqliteOperationalRepository } from '../sqlite/operational-repository.js'
import { SqliteIstraRepository } from '../sqlite/repository.js'
import { latestPostgresSchemaVersion } from './migrations.js'
import { openPostgresDatabase, type PostgresDatabase } from './database.js'
import { PostgresOperationalRepository } from './operational-repository.js'
import { PostgresIstraRepository } from './repository.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const provenance: Provenance = { source: 'system', client: 'postgres-integration-test' }

interface Harness {
  schema: string
  database: PostgresDatabase
  repository: PostgresIstraRepository
  operational: PostgresOperationalRepository
}

function schemaConnectionString(connectionString: string, schema: string): string {
  const url = new URL(connectionString)
  url.searchParams.set('options', `-csearch_path=${schema}`)
  return url.toString()
}

function quoteSchema(schema: string): string {
  if (!/^istra_test_[a-f0-9]+$/.test(schema)) throw new Error('Unsafe PostgreSQL test schema name')
  return `"${schema}"`
}

describe.skipIf(!testDatabaseUrl)('PostgreSQL storage integration', () => {
  let admin: Pool
  let harness: Harness | undefined
  const schemas = new Set<string>()

  beforeAll(async () => {
    admin = new Pool({
      connectionString: testDatabaseUrl,
      max: 1,
      application_name: 'istra-postgres-integration-admin',
    })
    await admin.query('SELECT 1')
  }, 30_000)

  beforeEach(async () => {
    const schema = `istra_test_${randomUUID().replaceAll('-', '')}`
    schemas.add(schema)
    await admin.query(`CREATE SCHEMA ${quoteSchema(schema)}`)
    const database = await openPostgresDatabase({
      connectionString: schemaConnectionString(testDatabaseUrl!, schema),
      max: 6,
      applicationName: 'istra-postgres-integration',
    })
    harness = {
      schema,
      database,
      repository: new PostgresIstraRepository(database.executor),
      operational: new PostgresOperationalRepository(database.executor),
    }
  }, 30_000)

  afterEach(async () => {
    if (!harness) return
    const { database, schema } = harness
    harness = undefined
    await database.close()
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`)
    schemas.delete(schema)
  }, 30_000)

  afterAll(async () => {
    for (const schema of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`)
    }
    await admin.end()
  }, 30_000)

  it('applies the native schema, constraints and indexes', async () => {
    const { database, repository } = harness!
    expect(await database.schemaVersion()).toBe(latestPostgresSchemaVersion)
    await expect(database.healthCheck()).resolves.toEqual({ ready: true, schemaVersion: latestPostgresSchemaVersion })

    const columns = await database.executor.many(`
      SELECT table_name,column_name,udt_name
      FROM information_schema.columns
      WHERE table_schema=current_schema()
        AND (table_name,column_name) IN (
          ('projects','id'),
          ('projects','deadline'),
          ('projects','blockers_json'),
          ('acceptance_criteria','required'),
          ('search_index','search_vector')
        )
    `)
    const types = new Map(columns.map((row) => [`${String(row.table_name)}.${String(row.column_name)}`, String(row.udt_name)]))
    expect(types).toEqual(new Map([
      ['projects.id', 'uuid'],
      ['projects.deadline', 'timestamptz'],
      ['projects.blockers_json', 'jsonb'],
      ['acceptance_criteria.required', 'bool'],
      ['search_index.search_vector', 'tsvector'],
    ]))

    const searchIndex = await database.executor.one(`
      SELECT am.amname,pg_get_indexdef(index_class.oid) AS definition
      FROM pg_class index_class
      JOIN pg_index index_entry ON index_entry.indexrelid=index_class.oid
      JOIN pg_class table_class ON table_class.oid=index_entry.indrelid
      JOIN pg_namespace namespace ON namespace.oid=table_class.relnamespace
      JOIN pg_am am ON am.oid=index_class.relam
      WHERE namespace.nspname=current_schema()
        AND table_class.relname='search_index'
        AND index_class.relname='search_index_vector'
    `)
    expect(searchIndex.amname).toBe('gin')
    expect(String(searchIndex.definition)).toContain('(search_vector)')

    const expressionIndexes = await database.executor.many(`
      SELECT index_class.relname,pg_get_indexdef(index_class.oid) AS definition
      FROM pg_class index_class
      JOIN pg_index index_entry ON index_entry.indexrelid=index_class.oid
      JOIN pg_class table_class ON table_class.oid=index_entry.indrelid
      JOIN pg_namespace namespace ON namespace.oid=table_class.relnamespace
      WHERE namespace.nspname=current_schema()
        AND index_class.relname IN ('labels_name_nocase','requirements_project_stable_key')
      ORDER BY index_class.relname
    `)
    expect(expressionIndexes).toHaveLength(2)
    expect(expressionIndexes.every((row) => String(row.definition).includes('lower('))).toBe(true)

    const unindexedForeignKeys = await database.executor.many(`
      WITH foreign_keys AS (
        SELECT constraint_entry.conname,constraint_entry.conrelid,constraint_entry.conkey
        FROM pg_constraint constraint_entry
        JOIN pg_class table_class ON table_class.oid=constraint_entry.conrelid
        JOIN pg_namespace namespace ON namespace.oid=table_class.relnamespace
        WHERE constraint_entry.contype='f' AND namespace.nspname=current_schema()
      )
      SELECT foreign_keys.conname
      FROM foreign_keys
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_index index_entry
        WHERE index_entry.indrelid=foreign_keys.conrelid
          AND index_entry.indisvalid
          AND ARRAY(
            SELECT key_number
            FROM unnest(index_entry.indkey::smallint[]) WITH ORDINALITY AS indexed_key(key_number,position)
            WHERE position <= cardinality(foreign_keys.conkey)
            ORDER BY position
          ) = foreign_keys.conkey
      )
      ORDER BY foreign_keys.conname
    `)
    expect(unindexedForeignKeys).toEqual([])

    const first = await repository.createProject({ title: 'Constraint owner' }, provenance)
    const second = await repository.createProject({ title: 'Constraint target' }, provenance)
    const firstPhase = await repository.createPhase(first.id, { name: 'Foreign phase', status: 'active' }, provenance)
    const secondWork = await repository.createWorkItem(second.id, { kind: 'task', title: 'Scoped work' }, provenance)

    await expect(database.executor.execute("UPDATE projects SET state='invalid' WHERE id=$1", [first.id]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(database.executor.execute('UPDATE work_items SET phase_id=$1 WHERE id=$2', [firstPhase.id, secondWork.id]))
      .rejects.toMatchObject({ code: '23503' })

    await repository.createLabel({ name: 'Case-sensitive display' }, provenance)
    await expect(repository.createLabel({ name: 'case-SENSITIVE display' }, provenance))
      .rejects.toThrow(/already exists/i)
  }, 30_000)

  it('keeps projects, operational memory, checkpoints and search in parity', async () => {
    const { repository, operational } = harness!
    const project = await repository.createProject({
      title: 'Resonance migration',
      description: 'PostgreSQL parity probe for Återhämtning',
      completionCriteria: 'All resonance evidence is durable',
    }, provenance)
    const phase = await repository.createPhase(project.id, { name: 'Resonance verification', status: 'active' }, provenance)
    const requirement = await operational.createRequirement(project.id, {
      stableKey: 'PG-PARITY-1',
      kind: 'requirement',
      title: 'Resonance state remains reconstructable',
      description: 'Återhämtning remains searchable without diacritics.',
      responsiblePhaseId: phase.id,
      criteria: [{ title: 'Checkpoint digest reconstructs', required: true }],
    })
    const workItem = await repository.createWorkItem(project.id, {
      stableKey: 'PG-WORK-1',
      kind: 'task',
      title: 'Verify resonance checkpoint',
      status: 'in_progress',
      phaseId: phase.id,
      requirementIds: [requirement.id],
    }, provenance)
    const checkpoint = await repository.saveCheckpoint(project.id, {
      expectedVersion: project.version,
      content: 'Resonance checkpoint is ready for PostgreSQL verification.',
      currentFocus: 'Verify PostgreSQL parity',
      nextAction: 'Capture structured state',
      blockers: [],
    }, provenance)
    const run = await operational.createRun(project.id, {
      command: 'pnpm test -- resonance',
      startedAt: '2026-07-11T10:00:00.000Z',
      endedAt: '2026-07-11T10:00:01.000Z',
      outcome: 'verified',
      exitCode: 0,
      stdoutExcerpt: 'resonance checks passed',
      stdoutTruncated: false,
      stderrTruncated: false,
      testSummary: { scope: 'postgres parity', passed: 4, failed: 0, skipped: 0, targetCount: 4 },
    })
    const evidence = await operational.createEvidence(project.id, {
      runId: run.run.id,
      result: 'verified',
      summary: 'Resonance parity and checkpoint digest verified.',
      criterionIds: [requirement.criteria[0]!.id],
      workItemIds: [workItem.id],
      checkpointIds: [checkpoint.id],
    })
    const snapshot = await operational.captureCheckpointSnapshot(project.id, checkpoint.id)

    await expect(repository.getProject(project.id)).resolves.toMatchObject({
      title: 'Resonance migration',
      currentCheckpointId: checkpoint.id,
      currentFocus: 'Verify PostgreSQL parity',
    })
    await expect(operational.getRequirement(requirement.id)).resolves.toMatchObject({
      id: requirement.id,
      linkedWorkItemIds: [workItem.id],
      linkedEvidenceIds: [evidence.id],
      proofStatus: 'proven',
      gate: 'satisfied',
    })
    await expect(operational.listRuns(project.id)).resolves.toEqual([
      expect.objectContaining({ id: run.run.id, outcome: 'verified' }),
    ])
    await expect(operational.listEvidence(project.id)).resolves.toEqual([
      expect.objectContaining({ id: evidence.id, checkpointIds: [checkpoint.id] }),
    ])
    expect(snapshot).toMatchObject({ checkpointId: checkpoint.id, schemaVersion: 3 })
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/)
    await expect(operational.reconstructCheckpointState(checkpoint.id)).resolves.toMatchObject({
      project: { id: project.id },
      requirements: [expect.objectContaining({ id: requirement.id })],
      evidence: [expect.objectContaining({ id: evidence.id })],
      _snapshot: { legacy: false, digest: snapshot.digest },
    })

    expect(await repository.search('resonance', 20, { projectId: project.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'project', id: project.id }),
      expect.objectContaining({ type: 'work_item', id: workItem.id }),
      expect.objectContaining({ type: 'update', id: checkpoint.id }),
    ]))
    expect(await operational.search('resonance', 20, { projectId: project.id, entityTypes: ['requirement', 'run', 'evidence'] }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'requirement', id: requirement.id }),
        expect.objectContaining({ type: 'run', id: run.run.id }),
        expect.objectContaining({ type: 'evidence', id: evidence.id }),
      ]))
    expect(await repository.search('aterhamtning', 20, { projectId: project.id, entityTypes: ['project'] }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'project', id: project.id })]))
    expect(await operational.search('aterhamtning', 20, { projectId: project.id, entityTypes: ['requirement'] }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'requirement', id: requirement.id })]))

    const exported = await repository.exportAll()
    expect(exported.formatVersion).toBe(4)
    expect(exported.tables.projects).toHaveLength(1)
    expect(exported.tables.checkpoint_snapshots).toHaveLength(1)
  }, 30_000)

  it('enforces optimistic concurrency under simultaneous mutations', async () => {
    const { repository } = harness!
    const project = await repository.createProject({ title: 'Optimistic project' }, provenance)

    const updates = await Promise.allSettled([
      repository.updateProject(project.id, { expectedVersion: project.version, currentFocus: 'Left writer' }, provenance),
      repository.updateProject(project.id, { expectedVersion: project.version, currentFocus: 'Right writer' }, provenance),
    ])

    expect(updates.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejection = updates.find(({ status }) => status === 'rejected')
    expect(rejection).toMatchObject({ status: 'rejected', reason: expect.any(ConflictError) })
    await expect(repository.getProject(project.id)).resolves.toMatchObject({ version: project.version + 1 })
  }, 30_000)

  it('serialises opposite requirement-parent mutations', async () => {
    const { repository, operational } = harness!
    const project = await repository.createProject({ title: 'Requirement graph project' }, provenance)
    const left = await operational.createRequirement(project.id, {
      stableKey: 'GRAPH-REQ-LEFT', kind: 'requirement', title: 'Left requirement',
    })
    const right = await operational.createRequirement(project.id, {
      stableKey: 'GRAPH-REQ-RIGHT', kind: 'requirement', title: 'Right requirement',
    })

    const mutations = await Promise.allSettled([
      operational.updateRequirement(left.id, { expectedVersion: left.version, parentId: right.id }),
      operational.updateRequirement(right.id, { expectedVersion: right.version, parentId: left.id }),
    ])

    expect(mutations.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(mutations.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(mutations.find(({ status }) => status === 'rejected')).toMatchObject({
      status: 'rejected', reason: expect.any(ValidationError),
    })
    const [storedLeft, storedRight] = await Promise.all([
      operational.getRequirement(left.id), operational.getRequirement(right.id),
    ])
    expect([storedLeft?.parentId, storedRight?.parentId].filter(Boolean)).toHaveLength(1)
  }, 30_000)

  it('serialises opposite work-parent mutations', async () => {
    const { repository } = harness!
    const project = await repository.createProject({ title: 'Work parent graph project' }, provenance)
    const left = await repository.createWorkItem(project.id, {
      kind: 'task', title: 'Left work item',
    }, provenance)
    const right = await repository.createWorkItem(project.id, {
      kind: 'task', title: 'Right work item',
    }, provenance)

    const mutations = await Promise.allSettled([
      repository.updateWorkItem(left.id, { expectedVersion: left.version, parentId: right.id }, provenance),
      repository.updateWorkItem(right.id, { expectedVersion: right.version, parentId: left.id }, provenance),
    ])

    expect(mutations.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(mutations.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(mutations.find(({ status }) => status === 'rejected')).toMatchObject({
      status: 'rejected', reason: expect.any(ValidationError),
    })
    const stored = await repository.listWorkItems(project.id)
    expect(stored.map(({ parentId }) => parentId).filter(Boolean)).toHaveLength(1)
  }, 30_000)

  it('serialises opposite work-relation mutations', async () => {
    const { repository, operational } = harness!
    const project = await repository.createProject({ title: 'Work relation graph project' }, provenance)
    const left = await repository.createWorkItem(project.id, {
      kind: 'task', title: 'Left relation item',
    }, provenance)
    const right = await repository.createWorkItem(project.id, {
      kind: 'task', title: 'Right relation item',
    }, provenance)

    const mutations = await Promise.allSettled([
      operational.linkWorkItems(project.id, {
        fromWorkItemId: left.id, toWorkItemId: right.id, kind: 'depends_on',
      }),
      operational.linkWorkItems(project.id, {
        fromWorkItemId: right.id, toWorkItemId: left.id, kind: 'depends_on',
      }),
    ])

    expect(mutations.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(mutations.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(mutations.find(({ status }) => status === 'rejected')).toMatchObject({
      status: 'rejected', reason: expect.any(ValidationError),
    })
    await expect(operational.listWorkRelations(project.id)).resolves.toHaveLength(1)
  }, 30_000)

  it('serialises simultaneous idempotent replays and rejects conflicting payloads', async () => {
    const { repository, operational } = harness!
    const project = await repository.createProject({ title: 'Idempotency project' }, provenance)
    const payload = { projectId: project.id, stableKey: 'IDEMPOTENT-1', title: 'Exactly once' }
    let executions = 0
    const execute = async () => {
      executions += 1
      return repository.createWorkItem(project.id, {
        stableKey: payload.stableKey,
        kind: 'task',
        title: payload.title,
      }, provenance)
    }

    const [first, replay] = await Promise.all([
      operational.runIdempotent('postgres-test', 'same-request', 'create_work_item', payload, execute),
      operational.runIdempotent('postgres-test', 'same-request', 'create_work_item', payload, execute),
    ])
    expect(replay.id).toBe(first.id)
    expect(executions).toBe(1)
    expect((await repository.listWorkItems(project.id)).filter(({ stableKey }) => stableKey === payload.stableKey)).toHaveLength(1)

    const competing = await Promise.allSettled([
      operational.runIdempotent('postgres-test', 'conflicting-request', 'probe', { value: 'left' }, async () => ({ winner: 'left' })),
      operational.runIdempotent('postgres-test', 'conflicting-request', 'probe', { value: 'right' }, async () => ({ winner: 'right' })),
    ])
    expect(competing.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(competing.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(competing.find(({ status }) => status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/idempotency/i) }),
    })

    await operational.runIdempotent('postgres-test', 'void-result', 'link_probe', { linked: true }, async () => undefined)
    const voidResult = (await repository.exportAll()).tables.idempotency_records!
      .find((row) => row.client === 'postgres-test' && row.idempotency_key === 'void-result')
    expect(voidResult?.result_json).toBe('null')
  }, 30_000)

  it('rolls back idempotency claims and cross-repository writes together', async () => {
    const { database, repository, operational } = harness!
    await expect(operational.runIdempotent(
      'postgres-test',
      'rollback-request',
      'create_project',
      { title: 'Must roll back' },
      async () => {
        await repository.createProject({ title: 'Must roll back' }, provenance)
        throw new Error('forced cross-repository failure')
      },
    )).rejects.toThrow('forced cross-repository failure')

    await expect(repository.listProjects({ q: 'Must roll back' })).resolves.toEqual([])
    const claimCount = await database.executor.one(`
      SELECT count(*)::integer AS count
      FROM idempotency_records
      WHERE client='postgres-test' AND idempotency_key='rollback-request'
    `)
    expect(claimCount.count).toBe(0)

    const retry = await operational.runIdempotent(
      'postgres-test',
      'rollback-request',
      'create_project',
      { title: 'Must roll back' },
      () => repository.createProject({ title: 'Recovered after rollback' }, provenance),
    )
    expect(retry.title).toBe('Recovered after rollback')
  }, 30_000)

  it('drains queued transaction queries before committing or rolling back', async () => {
    const { database } = harness!

    await database.executor.transaction(async (transaction) => {
      void transaction.query(`
        INSERT INTO projects (id,title,state,version,blockers_json,created_at,updated_at)
        VALUES ($1::uuid,$2,'active',1,'[]'::jsonb,now(),now())
      `, [randomUUID(), 'Queued commit'])
    })
    const committed = await database.executor.one(`
      SELECT count(*)::integer AS count FROM projects WHERE title='Queued commit'
    `)
    expect(committed.count).toBe(1)

    await expect(database.executor.transaction(async (transaction) => {
      void transaction.query(`
        INSERT INTO projects (id,title,state,version,blockers_json,created_at,updated_at)
        VALUES ($1::uuid,$2,'active',1,'[]'::jsonb,now(),now())
      `, [randomUUID(), 'Queued rollback'])
      throw new Error('force rollback after queued query')
    })).rejects.toThrow('force rollback after queued query')
    const rolledBack = await database.executor.one(`
      SELECT count(*)::integer AS count FROM projects WHERE title='Queued rollback'
    `)
    expect(rolledBack.count).toBe(0)
  }, 30_000)

  it('migrates a full SQLite fixture canonically and advances imported sequences', async () => {
    const { repository, operational } = harness!
    const sourceDir = await mkdtemp(join(tmpdir(), 'istra-postgres-migration-source-'))
    const source = await openIstraDatabase({ dataDir: sourceDir })
    try {
      const sourceRepository = new SqliteIstraRepository(source.db)
      const sourceOperational = new SqliteOperationalRepository(source.db)
      const project = sourceRepository.createProject({ title: 'Portable migration fixture' }, provenance)
      const requirement = sourceOperational.createRequirement(project.id, {
        stableKey: 'MIGRATE-1',
        kind: 'requirement',
        title: 'Migration preserves the ledger',
        criteria: [{ title: 'Canonical tables match', required: true }],
      })
      const workItem = sourceRepository.createWorkItem(project.id, {
        stableKey: 'MIGRATE-WORK-1',
        kind: 'task',
        title: 'Compare portable tables',
        requirementIds: [requirement.id],
      }, provenance)
      const checkpoint = sourceRepository.saveCheckpoint(project.id, {
        expectedVersion: project.version,
        content: 'SQLite migration fixture checkpoint',
        blockers: [],
      }, provenance)
      const run = sourceOperational.createRun(project.id, {
        command: 'pnpm test -- migration-fixture',
        startedAt: '2026-07-11T11:00:00.000Z',
        endedAt: '2026-07-11T11:00:01.000Z',
        outcome: 'verified',
        exitCode: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      })
      const evidence = sourceOperational.createEvidence(project.id, {
        runId: run.run.id,
        result: 'verified',
        summary: 'Canonical SQLite fixture verified.',
        criterionIds: [requirement.criteria[0]!.id],
        workItemIds: [workItem.id],
        checkpointIds: [checkpoint.id],
      })
      sourceOperational.captureCheckpointSnapshot(project.id, checkpoint.id)
      const sourceBundle = sourceRepository.exportAll()

      const result = await repository.importForMigration(sourceBundle)
      expect(result.tableCounts.projects).toBe(1)
      const targetBundle = await repository.exportAll()
      expect(canonicalJson(targetBundle.tables)).toBe(canonicalJson(sourceBundle.tables))
      expect(await repository.search('migration fixture', 20, { projectId: project.id })).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'project', id: project.id }),
        expect.objectContaining({ type: 'update', id: checkpoint.id }),
      ]))

      const continued = await operational.createEvidence(project.id, {
        result: 'recorded',
        summary: 'PostgreSQL sequence continued after import.',
        requirementIds: [requirement.id],
      })
      expect(continued.ordinal).toBeGreaterThan(evidence.ordinal)

      const beforeRefusal = await repository.exportAll()
      await expect(repository.importForMigration(sourceBundle)).rejects.toThrow(/target is not empty/i)
      expect(canonicalJson((await repository.exportAll()).tables)).toBe(canonicalJson(beforeRefusal.tables))

      await repository.clearForFailedActivation()
      await expect(repository.isEmpty()).resolves.toBe(true)
    } finally {
      source.db.close()
      await rm(sourceDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('leaves the target empty when a migration copy fails before activation', async () => {
    const { repository } = harness!
    const sourceDir = await mkdtemp(join(tmpdir(), 'istra-postgres-failed-migration-'))
    const source = await openIstraDatabase({ dataDir: sourceDir })
    try {
      const sourceRepository = new SqliteIstraRepository(source.db)
      const project = sourceRepository.createProject({ title: 'Atomic failed migration' }, provenance)
      sourceRepository.createWorkItem(project.id, { kind: 'task', title: 'Valid source work' }, provenance)
      const bundle = sourceRepository.exportAll()
      const invalid = structuredClone(bundle)
      invalid.tables.work_queue_items![0]!.work_item_id = randomUUID()

      await expect(repository.importForMigration(invalid)).rejects.toThrow()
      await expect(repository.isEmpty()).resolves.toBe(true)

      await expect(repository.importForMigration(bundle)).resolves.toMatchObject({
        tableCounts: { projects: 1, work_items: 1 },
      })
    } finally {
      source.db.close()
      await rm(sourceDir, { recursive: true, force: true })
    }
  }, 30_000)
})
