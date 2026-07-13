// @vitest-environment node

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UnsupportedOperationError, ValidationError } from '../application/errors.js'
import type { IstraRepository, OperationalRepository } from '../application/ports.js'
import { canonicalJson } from '../domain/canonical-json.js'
import type { MutationContext, Provenance } from '../domain/contracts.js'
import { openPostgresDatabase } from './postgres/database.js'
import { PostgresOperationalRepository } from './postgres/operational-repository.js'
import { PostgresIstraRepository } from './postgres/repository.js'
import { openIstraDatabase } from './sqlite/database.js'
import { SqliteOperationalRepository } from './sqlite/operational-repository.js'
import { SqliteIstraRepository } from './sqlite/repository.js'

const provenance: Provenance = { source: 'system', client: 'repository-contract' }
const mutationContext = (key: string): MutationContext => ({ source: 'mcp', client: 'repository-contract', actor: 'repository-contract', idempotencyKey: key, occurredAt: new Date().toISOString() })
const testDatabaseUrl = process.env.TEST_DATABASE_URL

interface RepositoryHarness {
  repository: IstraRepository
  operational: OperationalRepository
  importValidation: 'supported' | 'unavailable'
  close(): Promise<void>
}

interface ContractFixture {
  projectId: string
  requirementId: string
  criterionId: string
  queueId: string
  workItemId: string
  relatedWorkItemId: string
  relationId: string
  blockerId: string
  workspaceId: string
  workspaceRevisionId: string
  workspaceRoot: string
  runId: string
  evidenceId: string
  checkpointId: string
  snapshotDigest: string
  errorReportId: string
}

type RepositoryFactory = () => Promise<RepositoryHarness>

async function createContractFixture(harness: RepositoryHarness): Promise<ContractFixture> {
  const { repository, operational } = harness
  const project = await repository.createProject({
    title: 'Backend-neutral contract signal',
    description: 'Exercises portable operational memory behaviour.',
  }, provenance)
  const phase = await repository.createPhase(project.id, {
    name: 'Contract verification',
    status: 'active',
  }, provenance)
  await operational.createRequirementState(project.id, {
    name: 'Reviewing',
    semantic: 'partial',
  })
  const requirement = await operational.createRequirement(project.id, {
    stableKey: 'CONTRACT-REQ-1',
    kind: 'requirement',
    title: 'Contractsignal remains reconstructable',
    responsiblePhaseId: phase.id,
    criteria: [{ title: 'Both storage factories preserve the proof graph', required: true }],
  })
  const queue = await operational.createWorkQueue(project.id, {
    name: 'Contract queue',
    description: 'Backend-neutral ordering.',
  })
  const workItem = await repository.createWorkItem(project.id, {
    stableKey: 'CONTRACT-WORK-1',
    kind: 'task',
    title: 'Capture the contract checkpoint',
    status: 'in_progress',
    phaseId: phase.id,
    queueId: queue.id,
    requirementIds: [requirement.id],
  }, provenance)
  const relatedWorkItem = await repository.createWorkItem(project.id, {
    stableKey: 'CONTRACT-WORK-2',
    kind: 'task',
    title: 'Review the contract checkpoint',
    queueId: queue.id,
  }, provenance)
  const relation = await operational.linkWorkItems(project.id, {
    fromWorkItemId: workItem.id,
    toWorkItemId: relatedWorkItem.id,
    kind: 'blocks',
  })
  const blocker = await operational.createExternalBlocker(project.id, {
    workItemId: relatedWorkItem.id,
    content: 'Waiting for the backend contract run.',
  })
  const workspaceRoot = join(tmpdir(), `istra-contract-${project.id}`)
  const workspace = await operational.createWorkspace({
    name: 'Repository contract workspace',
    canonicalRoot: workspaceRoot,
    aliases: [`${workspaceRoot}-alias`],
    remote: null,
  })
  await operational.linkProjectWorkspace(project.id, workspace.id)
  const workspaceRevision = await operational.createWorkspaceRevision({
    workspaceId: workspace.id,
    branch: 'main',
    commit: 'contract-fixture',
    dirty: false,
    diffHash: null,
  })
  const checkpoint = await repository.saveCheckpoint(project.id, {
    expectedVersion: project.version,
    content: 'Backend-neutral contract checkpoint.',
    currentFocus: 'Verify repository parity',
    nextAction: 'Reconstruct the checkpoint',
    blockers: ['Waiting for the backend contract run.'],
  }, provenance)
  const run = await operational.createRun(project.id, {
    workspaceRevisionId: workspaceRevision.id,
    command: 'pnpm test -- repository-contract',
    workingDirectory: workspaceRoot,
    startedAt: '2026-07-11T07:00:00.000Z',
    endedAt: '2026-07-11T07:00:01.000Z',
    outcome: 'verified',
    exitCode: 0,
    stdoutExcerpt: 'contractsignal verified',
    stdoutTruncated: false,
    stderrTruncated: false,
    artifacts: [{ uri: 'artifact://repository-contract-run', mediaType: 'text/plain' }],
    testSummary: { scope: 'repository contract', passed: 2, failed: 0, skipped: 0, targetCount: 2 },
  })
  const evidence = await operational.createEvidence(project.id, {
    runId: run.run.id,
    result: 'verified',
    summary: 'Contractsignal proof graph verified.',
    criterionIds: [requirement.criteria[0]!.id],
    workItemIds: [workItem.id],
    checkpointIds: [checkpoint.id],
    artifacts: [{ uri: 'artifact://repository-contract-evidence', mediaType: 'application/json' }],
  })
  const errorReport = await operational.createErrorReport({
    kind: 'design',
    component: 'repository-contract',
    summary: 'Contract error-report persistence probe',
    observation: 'The backend-neutral contract records the global error inbox too.',
    projectId: project.id,
    workspacePath: workspaceRoot,
  })
  const snapshot = await operational.captureCheckpointSnapshot(project.id, checkpoint.id)

  return {
    projectId: project.id,
    requirementId: requirement.id,
    criterionId: requirement.criteria[0]!.id,
    queueId: queue.id,
    workItemId: workItem.id,
    relatedWorkItemId: relatedWorkItem.id,
    relationId: relation.id,
    blockerId: blocker.id,
    workspaceId: workspace.id,
    workspaceRevisionId: workspaceRevision.id,
    workspaceRoot,
    runId: run.run.id,
    evidenceId: evidence.id,
    checkpointId: checkpoint.id,
    snapshotDigest: snapshot.digest,
    errorReportId: errorReport.id,
  }
}

function repositoryBehaviourContract(name: string, factory: RepositoryFactory, skip = false): void {
  describe.skipIf(skip)(`${name} repository behaviour contract`, () => {
    let harness: RepositoryHarness

    beforeEach(async () => {
      harness = await factory()
    }, 30_000)

    afterEach(async () => {
      await harness.close()
    }, 30_000)

    it('persists operational entities and reconstructs structured checkpoints', async () => {
      const fixture = await createContractFixture(harness)
      const { repository, operational } = harness

      expect(await operational.listRequirementStates(fixture.projectId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Reviewing', semantic: 'partial' }),
      ]))
      expect(await operational.getRequirement(fixture.requirementId)).toMatchObject({
        linkedWorkItemIds: [fixture.workItemId],
        linkedEvidenceIds: [fixture.evidenceId],
        proofStatus: 'proven',
        gate: 'satisfied',
      })
      expect(await operational.listWorkQueues(fixture.projectId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: fixture.queueId }),
      ]))
      expect(await operational.listWorkItems(fixture.projectId, fixture.queueId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: fixture.workItemId, queueId: fixture.queueId }),
        expect.objectContaining({
          id: fixture.relatedWorkItemId,
          effectiveBlocked: true,
          blockerReasons: expect.arrayContaining([
            'Blocked by Capture the contract checkpoint',
            'Waiting for the backend contract run.',
          ]),
        }),
      ]))
      expect(await operational.listWorkRelations(fixture.projectId)).toEqual([
        expect.objectContaining({ id: fixture.relationId }),
      ])
      expect(await operational.listExternalBlockers(fixture.projectId)).toEqual([
        expect.objectContaining({ id: fixture.blockerId }),
      ])
      expect(await operational.resolveProject(join(fixture.workspaceRoot, 'src'))).toEqual([
        expect.objectContaining({ id: fixture.projectId }),
      ])
      expect(await operational.listRuns(fixture.projectId)).toEqual([
        expect.objectContaining({
          id: fixture.runId,
          artifacts: expect.arrayContaining([expect.objectContaining({ uri: 'artifact://repository-contract-run' })]),
        }),
      ])
      expect(await operational.listEvidence(fixture.projectId)).toEqual([
        expect.objectContaining({
          id: fixture.evidenceId,
          criterionLinks: [expect.objectContaining({ criterionId: fixture.criterionId })],
          workItemIds: [fixture.workItemId],
          checkpointIds: [fixture.checkpointId],
          artifacts: [expect.objectContaining({ uri: 'artifact://repository-contract-evidence' })],
        }),
      ])
      expect(await operational.getErrorReport(fixture.errorReportId)).toMatchObject({
        report: { id: fixture.errorReportId, projectId: fixture.projectId },
        history: [expect.objectContaining({ eventType: 'error_report.created' })],
      })
      expect(await repository.getProject(fixture.projectId)).toMatchObject({ currentCheckpointId: fixture.checkpointId })

      const reconstructed = await operational.reconstructCheckpointState(fixture.checkpointId)
      expect(reconstructed).toMatchObject({
        project: { id: fixture.projectId },
        requirements: expect.arrayContaining([expect.objectContaining({ id: fixture.requirementId })]),
        workItems: expect.arrayContaining([
          expect.objectContaining({ id: fixture.workItemId }),
          expect.objectContaining({ id: fixture.relatedWorkItemId }),
        ]),
        queues: expect.arrayContaining([expect.objectContaining({ id: fixture.queueId })]),
        relations: [expect.objectContaining({ id: fixture.relationId })],
        blockers: [expect.objectContaining({ id: fixture.blockerId })],
        workspaces: [expect.objectContaining({ id: fixture.workspaceId })],
        workspaceRevisions: [expect.objectContaining({ id: fixture.workspaceRevisionId })],
        runs: [expect.objectContaining({ id: fixture.runId })],
        evidence: [expect.objectContaining({ id: fixture.evidenceId })],
        _snapshot: { legacy: false, schemaVersion: 3, digest: fixture.snapshotDigest },
      })
      expect(await operational.compareCheckpointSnapshots(fixture.checkpointId, fixture.checkpointId)).toMatchObject({
        same: true,
        leftLegacy: false,
        rightLegacy: false,
      })
      expect(await operational.search('contractsignal', 20, {
        projectId: fixture.projectId,
        entityTypes: ['requirement', 'run', 'evidence'],
      })).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'requirement', id: fixture.requirementId }),
        expect.objectContaining({ type: 'run', id: fixture.runId }),
        expect.objectContaining({ type: 'evidence', id: fixture.evidenceId }),
      ]))
    }, 30_000)

    it('exports deterministic portable rows and enforces backend import-validation policy', async () => {
      const fixture = await createContractFixture(harness)
      const first = await harness.repository.exportAll()
      const second = await harness.repository.exportAll()

      expect(first).toMatchObject({ format: 'istra-export', formatVersion: 5 })
      expect(canonicalJson(second.tables)).toBe(canonicalJson(first.tables))
      for (const rows of Object.values(first.tables)) {
        expect(rows).toEqual([...rows].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))))
      }
      expect(first.tables.checkpoint_snapshots).toEqual([
        expect.objectContaining({ checkpoint_id: fixture.checkpointId, digest: fixture.snapshotDigest }),
      ])

      const validationDir = await mkdtemp(join(tmpdir(), 'istra-portable-export-contract-'))
      const validationDatabase = await openIstraDatabase({ dataDir: validationDir })
      try {
        const validationRepository = new SqliteIstraRepository(validationDatabase.db)
        const validationOperational = new SqliteOperationalRepository(validationDatabase.db)
        validationRepository.validateImport(first)
        validationRepository.importAll(first)
        expect(canonicalJson(validationRepository.exportAll().tables)).toBe(canonicalJson(first.tables))
        expect(validationOperational.reconstructCheckpointState(fixture.checkpointId)).toMatchObject({
          project: { id: fixture.projectId },
          _snapshot: { legacy: false, schemaVersion: 3, digest: fixture.snapshotDigest },
        })
      } finally {
        validationDatabase.db.close()
        await rm(validationDir, { recursive: true, force: true })
      }

      const validate = (bundle: typeof first) => Promise.resolve().then(() => harness.repository.validateImport(bundle))
      if (harness.importValidation === 'supported') {
        await expect(validate(first)).resolves.toBeUndefined()
        const invalid = structuredClone(first)
        invalid.tables.projects![0]!.current_checkpoint_id = fixture.workItemId
        await expect(validate(invalid)).rejects.toBeInstanceOf(ValidationError)
      } else {
        await expect(validate(first)).rejects.toBeInstanceOf(UnsupportedOperationError)
      }
    }, 30_000)

    it('keeps automation claim, lease, attempt and completion semantics backend-neutral', async () => {
      const { repository, operational } = harness
      const project = await repository.createProject({ title: 'Automation parity' }, provenance)
      const item = await repository.createWorkItem(project.id, { kind: 'task', title: 'Backend-neutral claim' }, provenance)
      const queueId = item.queueId!
      expect(await operational.getQueueAutomationPolicy(project.id, queueId)).toMatchObject({ enabled: false, version: 0 })
      await operational.runMutation(mutationContext('policy'), 'update_queue_automation_policy', {}, () => operational.updateQueueAutomationPolicy(project.id, queueId, {
        expectedVersion: null, enabled: true, allowedKinds: ['task'], maxActiveClaims: 1, leaseSeconds: 60, requiresManualApproval: false, allowSameWorkerRecovery: true,
      }))
      const claim = await operational.runMutation(mutationContext('claim'), 'claim_next_automated_work', {}, () => operational.claimNextAutomatedWork(project.id, queueId, { workerId: 'contract-worker', idempotencyKey: 'claim' }))
      expect(claim).toMatchObject({ outcome: 'claimed', item: { id: item.id, status: 'in_progress' }, attempt: { ordinal: 1 } })
      if (claim.outcome !== 'claimed') throw new Error('Expected a claim')
      await operational.runMutation(mutationContext('observation'), 'record_automation_attempt', {}, () => operational.recordAutomationAttempt(claim.lease.id, { leaseToken: claim.lease.leaseToken, idempotencyKey: 'observation', kind: 'verification', summary: 'Backend contract passed.' }))
      const completed = await operational.runMutation(mutationContext('complete'), 'complete_automated_work', {}, () => operational.completeAutomatedWork(claim.lease.id, { leaseToken: claim.lease.leaseToken, idempotencyKey: 'complete', outcome: 'resolved', expectedWorkItemVersion: claim.item.version }))
      expect(completed).toMatchObject({ outcome: 'resolved', item: { status: 'resolved' }, lease: { releasedAt: expect.any(String), terminalOutcome: 'resolved' } })
      expect(await operational.getQueueAutomationOverview(project.id, queueId)).toMatchObject({ activeLeases: [], lastAttempt: { outcome: 'resolved', observations: [expect.objectContaining({ kind: 'verification' })] } })
    }, 30_000)
  })
}

repositoryBehaviourContract('SQLite', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'istra-repository-contract-'))
  const database = await openIstraDatabase({ dataDir })
  return {
    repository: new SqliteIstraRepository(database.db),
    operational: new SqliteOperationalRepository(database.db),
    importValidation: 'supported',
    close: async () => {
      database.db.close()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
})

function schemaConnectionString(connectionString: string, schema: string): string {
  const url = new URL(connectionString)
  url.searchParams.set('options', `-csearch_path=${schema}`)
  return url.toString()
}

function quoteSchema(schema: string): string {
  if (!/^istra_contract_[a-f0-9]+$/.test(schema)) throw new Error('Unsafe PostgreSQL contract schema name')
  return `"${schema}"`
}

repositoryBehaviourContract('PostgreSQL', async () => {
  const admin = new Pool({
    connectionString: testDatabaseUrl,
    max: 1,
    application_name: 'istra-repository-contract-admin',
  })
  const schema = `istra_contract_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${quoteSchema(schema)}`)
  try {
    const database = await openPostgresDatabase({
      connectionString: schemaConnectionString(testDatabaseUrl!, schema),
      max: 4,
      applicationName: 'istra-repository-contract',
    })
    return {
      repository: new PostgresIstraRepository(database.executor),
      operational: new PostgresOperationalRepository(database.executor),
      importValidation: 'unavailable',
      close: async () => {
        await database.close()
        await admin.query(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`)
        await admin.end()
      },
    }
  } catch (error) {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`)
    await admin.end()
    throw error
  }
}, !testDatabaseUrl)
