import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provenance } from '../../domain/contracts.js'
import { openIstraDatabase } from './database.js'
import { SqliteIstraRepository } from './repository.js'
import { SqliteOperationalRepository } from './operational-repository.js'

describe('operational project memory', () => {
  const provenance: Provenance = { source: 'system', client: 'operational-test' }
  let dataDir: string
  let database: Awaited<ReturnType<typeof openIstraDatabase>>
  let repository: SqliteIstraRepository
  let operational: SqliteOperationalRepository

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'istra-operational-test-'))
    database = await openIstraDatabase({ dataDir })
    repository = new SqliteIstraRepository(database.db)
    operational = new SqliteOperationalRepository(database.db)
  })

  afterEach(async () => {
    vi.useRealTimers()
    database.db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('creates configurable requirement states, criteria and computed gates', () => {
    const project = repository.createProject({ title: 'Aurora probe' }, provenance)
    const states = operational.listRequirementStates(project.id)
    expect(states.map(({ name }) => name)).toEqual(['Missing', 'Partial', 'Proven', 'Defect'])
    const requirement = operational.createRequirement(project.id, {
      stableKey: 'MAP-03', kind: 'requirement', title: 'Map data is complete', criteria: [{ title: 'All provinces have owners', required: true }],
    })
    expect(requirement.gate).toBe('unsatisfied')
    expect(requirement.proofStatus).toBe('open')
    expect(operational.getRequirementRollup(project.id)).toMatchObject({ total: 1, gateFailures: 1, defects: 0, byProofStatus: { open: 1, partial: 0, proven: 0, defect: 0 } })
    const custom = operational.createRequirementState(project.id, { name: 'Investigating', semantic: 'partial' })
    expect(custom.name).toBe('Investigating')
  })

  it('keeps criterion identity authoritative and scopes proof to exact criterion versions', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'))
    const project = repository.createProject({ title: 'Criterion proof' }, provenance)
    const requirement = operational.createRequirement(project.id, {
      stableKey: 'PROOF-1', kind: 'requirement', title: 'Criterion-scoped proof', criteria: [
        { title: 'Required criterion A', required: true },
        { title: 'Optional criterion B', required: false },
      ],
    })
    const [criterionA, criterionB] = requirement.criteria
    const verifiedRun = operational.createRun(project.id, {
      command: 'pnpm test', startedAt: '2026-07-10T10:00:00.000Z', endedAt: '2026-07-10T10:00:01.000Z', outcome: 'verified', exitCode: 0, stdoutTruncated: false, stderrTruncated: false,
    })
    const evidenceA = operational.createEvidence(project.id, {
      runId: verifiedRun.run.id, result: 'verified', summary: 'Criterion A passed', criterionIds: [criterionA!.id],
    })

    expect(operational.getRequirement(requirement.id)).toMatchObject({
      proofStatus: 'proven',
      criteria: [
        expect.objectContaining({ id: criterionA!.id, proofStatus: 'proven', proofEvidenceId: evidenceA.id }),
        expect.objectContaining({ id: criterionB!.id, required: false, proofStatus: 'open' }),
      ],
    })

    const requiredBoth = operational.updateRequirement(requirement.id, {
      expectedVersion: requirement.version,
      criteria: [
        { id: criterionA!.id, expectedVersion: criterionA!.version, title: criterionA!.title, description: criterionA!.description, required: true },
        { id: criterionB!.id, expectedVersion: criterionB!.version, title: criterionB!.title, description: criterionB!.description, required: true },
      ],
    })
    expect(requiredBoth.proofStatus).toBe('partial')
    expect(requiredBoth.criteria[0]).toMatchObject({ id: criterionA!.id, version: criterionA!.version, proofStatus: 'proven' })
    expect(requiredBoth.criteria[1]).toMatchObject({ id: criterionB!.id, version: criterionB!.version + 1, proofStatus: 'open' })

    const failedRun = operational.createRun(project.id, {
      command: 'pnpm test -- criterion-b', startedAt: '2026-07-10T10:01:00.000Z', endedAt: '2026-07-10T10:01:01.000Z', outcome: 'failed', exitCode: 1, stdoutTruncated: false, stderrTruncated: false,
    })
    operational.createEvidence(project.id, {
      runId: failedRun.run.id, result: 'failed', summary: 'Criterion B failed', criterionIds: [criterionB!.id],
    })
    expect(operational.getRequirement(requirement.id)?.proofStatus).toBe('defect')

    const verifiedB = operational.createEvidence(project.id, {
      runId: verifiedRun.run.id, result: 'verified', summary: 'Criterion B passed after the fix', criterionIds: [criterionB!.id],
    })
    expect(operational.getRequirement(requirement.id)).toMatchObject({ proofStatus: 'proven' })
    expect(operational.getRequirement(requirement.id)?.criteria[1]).toMatchObject({ proofEvidenceId: verifiedB.id })

    const beforeCriterionChange = operational.getRequirement(requirement.id)!
    const changedCriterion = operational.updateRequirement(requirement.id, {
      expectedVersion: beforeCriterionChange.version,
      criteria: [
        { id: criterionA!.id, expectedVersion: beforeCriterionChange.criteria[0]!.version, title: 'Required criterion A, clarified', description: null, required: true },
        { id: criterionB!.id, expectedVersion: beforeCriterionChange.criteria[1]!.version, title: criterionB!.title, description: criterionB!.description, required: true },
      ],
    })
    expect(changedCriterion.proofStatus).toBe('partial')
    expect(changedCriterion.criteria[0]).toMatchObject({ id: criterionA!.id, version: criterionA!.version + 1, proofStatus: 'open' })
    expect(changedCriterion.criteria[1]).toMatchObject({ id: criterionB!.id, proofStatus: 'proven' })

    const criteriaOmitted = operational.updateRequirement(requirement.id, {
      expectedVersion: changedCriterion.version, title: 'Criterion-scoped proof, renamed',
    })
    expect(criteriaOmitted.criteria.map(({ id, version }) => ({ id, version }))).toEqual(changedCriterion.criteria.map(({ id, version }) => ({ id, version })))

    const archived = operational.updateRequirement(requirement.id, {
      expectedVersion: criteriaOmitted.version,
      criteria: [{ id: criterionA!.id, expectedVersion: criteriaOmitted.criteria[0]!.version, title: 'Required criterion A, clarified', description: null, required: true }],
    })
    expect(archived.criteria.find(({ id }) => id === criterionB!.id)).toMatchObject({ archivedAt: expect.any(String) })
    expect(operational.listEvidence(project.id, true).find(({ id }) => id === verifiedB.id)?.criterionLinks).toContainEqual(expect.objectContaining({ criterionId: criterionB!.id }))

    const otherRequirement = operational.createRequirement(project.id, { stableKey: 'PROOF-2', kind: 'requirement', title: 'Other requirement' })
    expect(() => operational.updateRequirement(otherRequirement.id, {
      expectedVersion: otherRequirement.version,
      criteria: [{ id: criterionA!.id, expectedVersion: archived.criteria[0]!.version, title: 'Cannot move', required: true }],
    })).toThrow(/belong to the requirement/)
  })

  it('derives dependency blockers and rejects dependency cycles', () => {
    const project = repository.createProject({ title: 'Graph probe' }, provenance)
    const first = repository.createWorkItem(project.id, { kind: 'task', title: 'Compile', status: 'open' }, provenance)
    const second = repository.createWorkItem(project.id, { kind: 'task', title: 'Verify', status: 'open' }, provenance)
    operational.linkWorkItems(project.id, { fromWorkItemId: second.id, toWorkItemId: first.id, kind: 'depends_on' })
    expect(operational.listWorkItems(project.id).find(({ id }) => id === second.id)).toMatchObject({ effectiveBlocked: true, blockerReasons: ['Depends on Compile'] })
    expect(() => operational.linkWorkItems(project.id, { fromWorkItemId: first.id, toWorkItemId: second.id, kind: 'depends_on' })).toThrow(/cycle/)
    const blocker = operational.createExternalBlocker(project.id, { workItemId: first.id, content: 'Waiting for hardware' })
    expect(operational.listExternalBlockers(project.id)).toHaveLength(1)
    expect(operational.resolveExternalBlocker(blocker.id).resolvedAt).not.toBeNull()
  })

  it('persists stable work keys, hierarchy, queue order and explicit blocking edges', () => {
    const project = repository.createProject({ title: 'Structured graph' }, provenance)
    const parent = repository.createWorkItem(project.id, { stableKey: 'FG-WAR-01', kind: 'task', title: 'Build simulation' }, provenance)
    const child = repository.createWorkItem(project.id, { stableKey: 'FG-WAR-02', parentId: parent.id, kind: 'task', title: 'Verify simulation' }, provenance)
    expect(child).toMatchObject({ parentId: parent.id, queueId: expect.any(String), rank: expect.any(String) })
    expect(operational.listWorkItems(project.id).find(({ id }) => id === child.id)).toMatchObject({ queueId: child.queueId, rank: child.rank })
    operational.linkWorkItems(project.id, { fromWorkItemId: parent.id, toWorkItemId: child.id, kind: 'blocks' })
    expect(operational.listWorkItems(project.id).find(({ id }) => id === child.id)).toMatchObject({ effectiveBlocked: true, blockerReasons: [`Blocked by ${parent.title}`] })
  })

  it('rolls requirements up through goals, capabilities and milestones', () => {
    const project = repository.createProject({ title: 'Requirement rollups' }, provenance)
    const phase = repository.createPhase(project.id, { name: 'Prototype', status: 'active' }, provenance)
    const goal = operational.createRequirement(project.id, { stableKey: 'GOAL-01', kind: 'goal', title: 'Playable prototype' })
    const capability = operational.createRequirement(project.id, { stableKey: 'CAP-01', kind: 'capability', parentId: goal.id, title: 'Combat loop' })
    operational.createRequirement(project.id, { stableKey: 'REQ-01', kind: 'requirement', parentId: capability.id, title: 'Damage resolves', responsiblePhaseId: phase.id, relatedPhaseIds: [phase.id], criteria: [{ title: 'A hit changes health', required: true }] })
    const rollup = operational.getRequirementRollup(project.id)
    expect(rollup.byGoal[0]).toMatchObject({ stableKey: 'GOAL-01', total: 3 })
    expect(rollup.byCapability[0]).toMatchObject({ stableKey: 'CAP-01', total: 2 })
    expect(rollup.byMilestone[0]).toMatchObject({ name: 'Prototype', total: 1 })
  })

  it('resolves projects by workspace and records redacted runs and idempotent retries', () => {
    const project = repository.createProject({ title: 'Workspace probe' }, provenance)
    const workspace = operational.createWorkspace({ name: 'Istra', canonicalRoot: dataDir, aliases: [], remote: null })
    operational.linkProjectWorkspace(project.id, workspace.id)
    expect(operational.resolveProject(join(dataDir, 'src'))[0]?.id).toBe(project.id)
    const revision = operational.createWorkspaceRevision({ workspaceId: workspace.id, branch: 'main', commit: 'abc', dirty: true, diffHash: 'def' })
    const payload = { workspaceRevisionId: revision.id, command: 'TOKEN=secret pnpm test', startedAt: '2026-07-10T10:00:00.000Z', endedAt: '2026-07-10T10:00:01.000Z', outcome: 'failed' as const, exitCode: 1, stdoutExcerpt: 'token=secret\nfailed', stdoutTruncated: false, stderrTruncated: false, toolchain: { node: '24' } }
    const first = operational.runIdempotent('test-client', 'run-1', 'create_run', payload, () => operational.createRun(project.id, payload))
    const second = operational.runIdempotent('test-client', 'run-1', 'create_run', payload, () => operational.createRun(project.id, payload))
    expect(second.run.id).toBe(first.run.id)
    expect(first.run.stdoutExcerpt).toContain('[REDACTED]')
    expect(operational.listRuns(project.id)).toHaveLength(1)
  })

  it('stores global Istra error reports with redaction, history, triage and exact retries', () => {
    const project = repository.createProject({ title: 'Error report context' }, provenance)
    const payload = {
      kind: 'bug' as const,
      component: 'mcp:create_run',
      summary: 'Token handling leaks in a tool response',
      observation: 'TOKEN=secret appeared in a returned diagnostic.',
      expectedBehaviour: 'Secrets are always redacted.',
      actualBehaviour: 'The diagnostic included TOKEN=secret.',
      reproductionSteps: ['Call the tool with TOKEN=secret.'],
      impact: 'Sensitive data could be exposed.',
      projectId: project.id,
      workspacePath: dataDir,
    }
    const first = operational.runIdempotent('error-report-test', 'report-1', 'report_error', payload, () => operational.createErrorReport(payload))
    const replay = operational.runIdempotent<typeof first>('error-report-test', 'report-1', 'report_error', payload, () => { throw new Error('replay must not execute') })

    expect(replay.id).toBe(first.id)
    expect(first).toMatchObject({ kind: 'bug', status: 'open', projectId: project.id, redaction: { count: expect.any(Number) } })
    expect(first.observation).toContain('[REDACTED]')
    expect(operational.listErrorReportsPage(10).items.map(({ id }) => id)).toContain(first.id)
    expect(operational.getErrorReport(first.id)).toMatchObject({ report: { id: first.id }, history: [expect.objectContaining({ eventType: 'error_report.created' })] })

    expect(() => operational.runIdempotent('error-report-test', 'report-1', 'report_error', { ...payload, summary: 'Changed' }, () => operational.createErrorReport(payload))).toThrow(/idempotency/i)
    const independent = operational.runIdempotent('error-report-test', 'report-2', 'report_error', { ...payload, kind: 'design' as const, summary: 'The recovery path is misleading' }, () => operational.createErrorReport({ ...payload, kind: 'design', summary: 'The recovery path is misleading' }))
    expect(independent.id).not.toBe(first.id)

    expect(() => operational.updateErrorReport(first.id, { expectedVersion: first.version + 1, status: 'acknowledged' })).toThrow(/changed; refresh/i)
    const acknowledged = operational.updateErrorReport(first.id, { expectedVersion: first.version, status: 'acknowledged', triageNote: 'Investigate TOKEN=secret handling.' })
    expect(acknowledged).toMatchObject({ status: 'acknowledged', version: first.version + 1 })
    expect(acknowledged.triageNote).toContain('[REDACTED]')
    expect(operational.listErrorReportsPage(10).items.map(({ id }) => id)).toContain(first.id)
    expect(operational.getErrorReport(first.id)?.history.map(({ eventType }) => eventType)).toEqual(expect.arrayContaining(['error_report.created', 'error_report.status_updated']))
    expect(operational.listErrorReportsPage(10, undefined, ['resolved']).items).toHaveLength(0)
  })

  it('captures a reconstructable checkpoint snapshot and evidence links', () => {
    const project = repository.createProject({ title: 'Snapshot probe' }, provenance)
    const requirement = operational.createRequirement(project.id, {
      stableKey: 'FG-WAR-02', kind: 'goal', title: 'War simulation is reproducible', criteria: [{ title: 'Replay checksum matches', required: true }],
    })
    const checkpoint = repository.saveCheckpoint(project.id, { expectedVersion: project.version, content: 'Initial structured state', currentFocus: 'Verify replay', nextAction: 'Run the suite', blockers: [] }, provenance)
    const run = operational.createRun(project.id, { command: 'pnpm test', startedAt: '2026-07-10T10:00:00.000Z', endedAt: '2026-07-10T10:00:01.000Z', outcome: 'verified', exitCode: 0, stdoutTruncated: false, stderrTruncated: false })
    const evidence = operational.createEvidence(project.id, { runId: run.run.id, result: 'verified', summary: 'Replay checksum matched', criterionIds: [requirement.criteria[0]!.id] })
    const snapshot = operational.captureCheckpointSnapshot(project.id, checkpoint.id)
    expect(snapshot.schemaVersion).toBe(3)
    expect(snapshot.digest).toHaveLength(64)
    expect(snapshot.document).toMatchObject({
      project: { id: project.id },
      requirements: [expect.objectContaining({ stableKey: 'FG-WAR-02' })],
      runs: [expect.objectContaining({ id: run.run.id, validationStatus: 'validated' })],
      evidence: [expect.objectContaining({ id: evidence.id, criterionLinks: [expect.objectContaining({ criterionId: requirement.criteria[0]!.id })] })],
      evidenceHeads: [expect.objectContaining({ id: evidence.id, result: 'verified' })],
    })
    expect(operational.getCheckpointSnapshot(checkpoint.id)?.digest).toBe(snapshot.digest)
  })

  it('exports and imports operational state with graph and evidence records intact', async () => {
    const project = repository.createProject({ title: 'Portable operational state' }, provenance)
    const requirement = operational.createRequirement(project.id, { stableKey: 'MAP-03', kind: 'requirement', title: 'Map is proven' })
    const item = repository.createWorkItem(project.id, { stableKey: 'WORK-01', kind: 'task', title: 'Run map checks' }, provenance)
    operational.linkRequirementWork(project.id, requirement.id, item.id)
    const run = operational.createRun(project.id, { command: 'pnpm test', startedAt: '2026-07-10T10:00:00.000Z', endedAt: '2026-07-10T10:00:01.000Z', outcome: 'verified', exitCode: 0, stdoutTruncated: false, stderrTruncated: false, artifacts: [{ uri: 'artifact://test-report', mediaType: 'text/plain' }] })
    operational.createEvidence(project.id, {
      runId: run.run.id,
      result: 'verified',
      summary: 'Checks passed',
      requirementIds: [requirement.id],
      workItemIds: [item.id],
      artifacts: [{ uri: 'artifact://evidence-report', mediaType: 'text/plain' }],
    })
    const report = operational.createErrorReport({ kind: 'design', component: 'instructions', summary: 'The retry rule is ambiguous', observation: 'Two instructions give conflicting retry advice.', projectId: project.id })
    const bundle = repository.exportAll()
    const targetDir = await mkdtemp(join(tmpdir(), 'istra-import-operational-'))
    const target = await openIstraDatabase({ dataDir: targetDir })
    try {
      const targetRepository = new SqliteIstraRepository(target.db)
      targetRepository.validateImport(bundle)
      targetRepository.importAll(bundle)
      const targetOperational = new SqliteOperationalRepository(target.db)
      expect(targetOperational.listRequirements(project.id)[0]?.stableKey).toBe('MAP-03')
      expect(targetOperational.listRuns(project.id)[0]?.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ uri: 'artifact://test-report' }),
      ]))
      expect(targetOperational.listEvidence(project.id)[0]).toMatchObject({
        workItemIds: expect.arrayContaining([item.id]),
        artifacts: [expect.objectContaining({ uri: 'artifact://evidence-report' })],
      })
      expect(targetOperational.getErrorReport(report.id)?.report).toMatchObject({ id: report.id, kind: 'design', projectId: project.id })
    } finally {
      target.db.close()
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('treats a legacy v3 export as a full replacement with an empty error inbox', async () => {
    const report = operational.createErrorReport({ kind: 'bug', component: 'mcp', summary: 'Legacy export probe', observation: 'The report should not survive a v3 import.' })
    const legacy = repository.exportAll()
    legacy.formatVersion = 3
    delete legacy.tables.error_reports

    const targetDir = await mkdtemp(join(tmpdir(), 'istra-import-legacy-error-reports-'))
    const target = await openIstraDatabase({ dataDir: targetDir })
    try {
      const targetRepository = new SqliteIstraRepository(target.db)
      const targetOperational = new SqliteOperationalRepository(target.db)
      const targetReport = targetOperational.createErrorReport({ kind: 'design', component: 'instructions', summary: 'Existing target report', observation: 'This must be cleared by full replacement.' })
      targetRepository.validateImport(legacy)
      targetRepository.importAll(legacy)
      expect(targetOperational.getErrorReport(report.id)).toBeNull()
      expect(targetOperational.getErrorReport(targetReport.id)).toBeNull()
    } finally {
      target.db.close()
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('supports project-scoped filtered search across operational records', () => {
    const project = repository.createProject({ title: 'Searchable operational state' }, provenance)
    const requirement = operational.createRequirement(project.id, { stableKey: 'SEARCH-01', kind: 'requirement', title: 'Find the hidden signal' })
    operational.createEvidence(project.id, { result: 'recorded', summary: 'The hidden signal was verified', requirementIds: [requirement.id] })
    expect(operational.search('hidden', 20, { projectId: project.id, entityTypes: ['requirement', 'evidence'] }).map(({ type }) => type)).toEqual(expect.arrayContaining(['requirement', 'evidence']))
  })

  it('excludes result types that cannot satisfy the requested search filter', () => {
    const project = repository.createProject({ title: 'Typed search filters' }, provenance)
    const phase = repository.createPhase(project.id, { name: 'Search phase', status: 'active' }, provenance)
    const requirement = operational.createRequirement(project.id, {
      stableKey: 'FILTER-1', kind: 'requirement', title: 'Shared filter marker', responsiblePhaseId: phase.id,
    })
    const workItem = repository.createWorkItem(project.id, {
      kind: 'task', title: 'Shared filter marker', status: 'open', phaseId: phase.id, requirementIds: [requirement.id],
    }, provenance)
    const run = operational.createRun(project.id, { command: 'shared filter marker', startedAt: '2026-07-10T10:00:00.000Z', endedAt: '2026-07-10T10:00:01.000Z', outcome: 'verified', exitCode: 0, stdoutTruncated: false, stderrTruncated: false })
    operational.createEvidence(project.id, { runId: run.run.id, result: 'verified', summary: 'Shared filter marker' })

    expect(operational.search('filter marker', 20, { evidenceResult: 'verified' }).map(({ type }) => type)).toEqual(['evidence'])
    expect(operational.search('filter marker', 20, { requirementId: requirement.id }).map(({ type, id }) => ({ type, id }))).toEqual([
      { type: 'work_item', id: workItem.id },
    ])
    expect(new Set(operational.search('filter marker', 20, { phaseId: phase.id }).map(({ type }) => type))).toEqual(new Set(['requirement', 'work_item']))
    expect(new Set(operational.search('filter marker', 20, { state: 'open' }).map(({ type }) => type))).toEqual(new Set(['requirement', 'work_item']))
  })

  it('creates operational defaults during project creation and keeps reads mutation-free', () => {
    const project = repository.createProject({ title: 'Read-only defaults' }, provenance)
    expect((database.db.prepare('SELECT COUNT(*) AS count FROM requirement_states WHERE project_id=?').get(project.id) as { count: number }).count).toBe(4)
    expect((database.db.prepare('SELECT COUNT(*) AS count FROM work_queues WHERE project_id=?').get(project.id) as { count: number }).count).toBe(1)

    database.db.exec('PRAGMA query_only=ON')
    expect(() => operational.listRequirementStates(project.id)).not.toThrow()
    expect(() => operational.listRequirements(project.id)).not.toThrow()
    expect(() => operational.listWorkQueues(project.id)).not.toThrow()
    expect(() => operational.listWorkItems(project.id)).not.toThrow()
    database.db.exec('PRAGMA query_only=OFF')
  })

  it('rolls the write back when an idempotency record cannot be persisted', () => {
    const project = repository.createProject({ title: 'Atomic idempotency' }, provenance)
    database.db.exec(`
      CREATE TRIGGER fail_idempotency_record
      BEFORE INSERT ON idempotency_records
      BEGIN
        SELECT RAISE(ABORT, 'forced idempotency failure');
      END;
    `)

    expect(() => operational.runIdempotent('test-client', 'atomic-1', 'create_requirement', { projectId: project.id }, () => operational.createRequirement(project.id, {
      stableKey: 'ATOMIC-1', kind: 'requirement', title: 'Must roll back',
    }))).toThrow(/forced idempotency failure/)
    expect((database.db.prepare('SELECT COUNT(*) AS count FROM requirements WHERE project_id=?').get(project.id) as { count: number }).count).toBe(0)
  })

  it('preserves related requirement phases on a responsible-phase-only update', () => {
    const project = repository.createProject({ title: 'Requirement phase links' }, provenance)
    const original = repository.createPhase(project.id, { name: 'Original', status: 'active' }, provenance)
    const related = repository.createPhase(project.id, { name: 'Related', status: 'planned' }, provenance)
    const replacement = repository.createPhase(project.id, { name: 'Replacement', status: 'active' }, provenance)
    const requirement = operational.createRequirement(project.id, {
      stableKey: 'PHASE-1', kind: 'requirement', title: 'Keep related phase', responsiblePhaseId: original.id, relatedPhaseIds: [related.id],
    })

    const updated = operational.updateRequirement(requirement.id, {
      expectedVersion: requirement.version,
      responsiblePhaseId: replacement.id,
    })

    expect(updated.responsiblePhaseId).toBe(replacement.id)
    expect(updated.relatedPhaseIds).toEqual([related.id])
  })

  it('filters newly stale evidence on the first read', () => {
    const project = repository.createProject({ title: 'Stale evidence' }, provenance)
    const requirement = operational.createRequirement(project.id, { stableKey: 'STALE-1', kind: 'requirement', title: 'Version one' })
    const evidence = operational.createEvidence(project.id, {
      result: 'recorded', summary: 'Recorded version one', targetVersion: requirement.version, requirementIds: [requirement.id],
    })
    operational.updateRequirement(requirement.id, { expectedVersion: requirement.version, title: 'Version two' })

    expect(operational.listEvidence(project.id, false).map(({ id }) => id)).not.toContain(evidence.id)
    expect(operational.listEvidence(project.id, true).find(({ id }) => id === evidence.id)).toMatchObject({ stale: true })
  })

  it('removes target-version evidence from criterion proof as soon as its linked requirement advances', () => {
    const project = repository.createProject({ title: 'Criterion target staleness' }, provenance)
    const requirement = operational.createRequirement(project.id, {
      stableKey: 'STALE-CRITERION', kind: 'requirement', title: 'Version one', criteria: [{ title: 'Exact version is verified', required: true }],
    })
    const run = operational.createRun(project.id, {
      command: 'pnpm test', startedAt: '2026-07-10T10:00:00.000Z', endedAt: '2026-07-10T10:00:01.000Z', outcome: 'verified', exitCode: 0,
      stdoutTruncated: false, stderrTruncated: false,
    })
    const evidence = operational.createEvidence(project.id, {
      runId: run.run.id, result: 'verified', summary: 'Version one passed', targetVersion: requirement.version, criterionIds: [requirement.criteria[0]!.id],
    })
    expect(operational.getRequirement(requirement.id)?.proofStatus).toBe('proven')

    database.db.prepare('UPDATE evidence SET stale=1,stale_reason=? WHERE id=?').run('Superseded by an external review', evidence.id)
    expect(operational.getRequirement(requirement.id)?.proofStatus).toBe('open')
    database.db.prepare('UPDATE evidence SET stale=0,stale_reason=NULL WHERE id=?').run(evidence.id)
    expect(operational.getRequirement(requirement.id)?.proofStatus).toBe('proven')

    operational.updateRequirement(requirement.id, { expectedVersion: requirement.version, title: 'Version two' })
    expect(operational.getRequirement(requirement.id)).toMatchObject({ proofStatus: 'open', criteria: [expect.objectContaining({ proofStatus: 'open' })] })
  })

  it('redacts every persisted run and evidence field without retaining secret values', () => {
    const project = repository.createProject({ title: 'Credential redaction' }, provenance)
    database.db.prepare('INSERT INTO project_secret_names(project_id,name,created_at) VALUES (?,?,?)').run(project.id, 'PROJECT_CREDENTIAL', new Date().toISOString())
    const result = operational.createRun(project.id, {
      command: 'curl -H "Authorization: Bearer topsecret" https://example.invalid',
      workingDirectory: '/tmp?project_credential=working-secret',
      startedAt: '2026-07-10T10:00:00.000Z', endedAt: '2026-07-10T10:00:01.000Z',
      outcome: 'failed', exitCode: 1,
      stdoutExcerpt: '{"password":"stdout-secret"}',
      stderrExcerpt: 'Cookie: session=stderr-secret',
      toolchain: { registry: 'https://user:tool-secret@example.invalid' },
      artifacts: [{ uri: 'https://example.invalid/report?access_token=run-artifact-secret' }],
      stdoutTruncated: false, stderrTruncated: false,
    })
    const evidence = operational.createEvidence(project.id, {
      runId: result.run.id,
      result: 'failed',
      summary: 'PROJECT_CREDENTIAL=evidence-secret',
      artifacts: [{ uri: 'https://example.invalid/report?password=evidence-artifact-secret' }],
    })

    expect(result.run.redaction.count).toBeGreaterThanOrEqual(6)
    expect(evidence.redaction.count).toBe(2)
    const persisted = JSON.stringify(repository.exportAll())
    for (const secret of ['topsecret', 'working-secret', 'stdout-secret', 'stderr-secret', 'tool-secret', 'run-artifact-secret', 'evidence-secret', 'evidence-artifact-secret']) {
      expect(persisted).not.toContain(secret)
    }
  })

  it('associates evidence artifacts even when no run is present', () => {
    const project = repository.createProject({ title: 'Evidence artifacts' }, provenance)
    const evidence = operational.createEvidence(project.id, {
      result: 'recorded', summary: 'Standalone evidence artifact',
      artifacts: [{ uri: 'artifact://evidence-log', mediaType: 'text/plain' }],
    })

    expect(evidence.artifacts).toEqual([expect.objectContaining({ uri: 'artifact://evidence-log', runId: null })])
    expect(operational.listEvidence(project.id, true)[0]?.artifacts).toEqual([expect.objectContaining({ uri: 'artifact://evidence-log' })])
  })

  it('deletes artefacts only after their final run or evidence owner disappears', () => {
    const project = repository.createProject({ title: 'Artefact ownership' }, provenance)
    const runOwned = operational.createRun(project.id, {
      command: 'record run artefact', outcome: 'recorded', stdoutTruncated: false, stderrTruncated: false,
      artifacts: [{ uri: 'artifact://run-only' }],
    })
    const evidenceOwned = operational.createEvidence(project.id, {
      result: 'recorded', summary: 'Evidence-owned artefact', artifacts: [{ uri: 'artifact://evidence-only' }],
    })
    const dualRun = operational.createRun(project.id, {
      command: 'record dual artefact', outcome: 'recorded', stdoutTruncated: false, stderrTruncated: false,
    })
    const dualOwned = operational.createEvidence(project.id, {
      runId: dualRun.run.id, result: 'recorded', summary: 'Dual-owned artefact', artifacts: [{ uri: 'artifact://dual' }],
    })
    const exists = (id: string) => Boolean(database.db.prepare('SELECT 1 FROM artifact_references WHERE id=?').get(id))

    database.db.prepare('DELETE FROM runs WHERE id=?').run(runOwned.run.id)
    expect(exists(runOwned.artifacts[0]!.id)).toBe(false)

    database.db.prepare('DELETE FROM evidence WHERE id=?').run(evidenceOwned.id)
    expect(exists(evidenceOwned.artifacts[0]!.id)).toBe(false)

    database.db.prepare('DELETE FROM runs WHERE id=?').run(dualRun.run.id)
    expect(exists(dualOwned.artifacts[0]!.id)).toBe(true)
    expect(operational.listEvidence(project.id, true).find(({ id }) => id === dualOwned.id)).toMatchObject({ runId: null })
    database.db.prepare('DELETE FROM evidence WHERE id=?').run(dualOwned.id)
    expect(exists(dualOwned.artifacts[0]!.id)).toBe(false)
  })

  it('audits one provenance event and project pulse for idempotent operational writes', () => {
    const project = repository.createProject({ title: 'Mutation provenance' }, provenance)
    const before = Number((database.db.prepare('SELECT COUNT(*) AS count FROM activity_events WHERE project_id=?').get(project.id) as { count: number }).count)
    const context = { source: 'ui' as const, actor: 'local-human', client: 'web', idempotencyKey: 'requirement-1', occurredAt: '2026-07-10T12:00:00.000Z' }
    const payload = { projectId: project.id, stableKey: 'AUDIT-1' }
    const first = operational.runMutation(context, 'create_requirement', payload, () => operational.createRequirement(project.id, {
      stableKey: 'AUDIT-1', kind: 'requirement', title: 'Audit this mutation',
    }))
    const replay = operational.runMutation<typeof first>(context, 'create_requirement', payload, () => { throw new Error('replay must not execute') })

    expect(replay.id).toBe(first.id)
    expect(Number((database.db.prepare('SELECT COUNT(*) AS count FROM activity_events WHERE project_id=?').get(project.id) as { count: number }).count)).toBe(before + 1)
    expect(database.db.prepare("SELECT source,client,actor,idempotency_key,created_at FROM activity_events WHERE entity_id=? AND event_type='requirement.created'").get(first.id)).toEqual({
      source: 'ui', client: 'web', actor: 'local-human', idempotency_key: 'requirement-1', created_at: context.occurredAt,
    })
    expect(database.db.prepare('SELECT last_activity_at FROM projects WHERE id=?').get(project.id)).toEqual({ last_activity_at: context.occurredAt })
    expect(() => operational.runMutation(context, 'create_requirement', { ...payload, stableKey: 'AUDIT-2' }, () => first)).toThrow(/Idempotency key/)

    const changedActor = { ...context, actor: 'rotated-local-actor' }
    expect(operational.runMutation<typeof first>(changedActor, 'create_requirement', payload, () => { throw new Error('same client must replay') }).id).toBe(first.id)

    const otherClient = { ...context, client: 'cli', occurredAt: '2026-07-10T12:01:00.000Z' }
    const independent = operational.runMutation(otherClient, 'create_requirement', { ...payload, stableKey: 'AUDIT-2' }, () => operational.createRequirement(project.id, {
      stableKey: 'AUDIT-2', kind: 'requirement', title: 'Independent client namespace',
    }))
    expect(independent.id).not.toBe(first.id)
  })
})
