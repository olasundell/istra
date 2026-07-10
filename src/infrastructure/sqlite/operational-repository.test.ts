import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    expect(operational.getRequirementRollup(project.id)).toMatchObject({ total: 1, gateFailures: 1, defects: 0 })
    const custom = operational.createRequirementState(project.id, { name: 'Investigating', semantic: 'partial' })
    expect(custom.name).toBe('Investigating')
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
    const payload = { workspaceRevisionId: revision.id, command: 'TOKEN=secret pnpm test', outcome: 'failed' as const, exitCode: 1, stdoutExcerpt: 'token=secret\nfailed', stdoutTruncated: false, stderrTruncated: false, toolchain: { node: '24' } }
    const first = operational.runIdempotent('test-client', 'run-1', 'create_run', payload, () => operational.createRun(project.id, payload))
    const second = operational.runIdempotent('test-client', 'run-1', 'create_run', payload, () => operational.createRun(project.id, payload))
    expect(second.run.id).toBe(first.run.id)
    expect(first.run.stdoutExcerpt).toContain('[REDACTED]')
    expect(operational.listRuns(project.id)).toHaveLength(1)
  })

  it('captures a reconstructable checkpoint snapshot and evidence links', () => {
    const project = repository.createProject({ title: 'Snapshot probe' }, provenance)
    const requirement = operational.createRequirement(project.id, { stableKey: 'FG-WAR-02', kind: 'goal', title: 'War simulation is reproducible' })
    const checkpoint = repository.saveCheckpoint(project.id, { expectedVersion: project.version, content: 'Initial structured state', currentFocus: 'Verify replay', nextAction: 'Run the suite', blockers: [] }, provenance)
    const evidence = operational.createEvidence(project.id, { result: 'verified', summary: 'Replay checksum matched', requirementIds: [requirement.id] })
    const snapshot = operational.captureCheckpointSnapshot(project.id, checkpoint.id)
    expect(snapshot.schemaVersion).toBe(2)
    expect(snapshot.digest).toHaveLength(64)
    expect(snapshot.document).toMatchObject({ project: { id: project.id }, requirements: [expect.objectContaining({ stableKey: 'FG-WAR-02' })], evidenceHeads: [expect.objectContaining({ id: evidence.id, result: 'verified' })] })
    expect(operational.getCheckpointSnapshot(checkpoint.id)?.digest).toBe(snapshot.digest)
  })

  it('exports and imports operational state with graph and evidence records intact', async () => {
    const project = repository.createProject({ title: 'Portable operational state' }, provenance)
    const requirement = operational.createRequirement(project.id, { stableKey: 'MAP-03', kind: 'requirement', title: 'Map is proven' })
    const item = repository.createWorkItem(project.id, { stableKey: 'WORK-01', kind: 'task', title: 'Run map checks' }, provenance)
    operational.linkRequirementWork(project.id, requirement.id, item.id)
    const run = operational.createRun(project.id, { command: 'pnpm test', outcome: 'verified', stdoutTruncated: false, stderrTruncated: false, artifacts: [{ uri: 'artifact://test-report', mediaType: 'text/plain' }] })
    operational.createEvidence(project.id, {
      runId: run.run.id,
      result: 'verified',
      summary: 'Checks passed',
      requirementIds: [requirement.id],
      workItemIds: [item.id],
      artifacts: [{ uri: 'artifact://evidence-report', mediaType: 'text/plain' }],
    })
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
    } finally {
      target.db.close()
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  it('supports project-scoped filtered search across operational records', () => {
    const project = repository.createProject({ title: 'Searchable operational state' }, provenance)
    const requirement = operational.createRequirement(project.id, { stableKey: 'SEARCH-01', kind: 'requirement', title: 'Find the hidden signal' })
    operational.createEvidence(project.id, { result: 'verified', summary: 'The hidden signal was verified', requirementIds: [requirement.id] })
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
    operational.createRun(project.id, { command: 'shared filter marker', outcome: 'verified', stdoutTruncated: false, stderrTruncated: false })
    operational.createEvidence(project.id, { result: 'verified', summary: 'Shared filter marker' })

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
      result: 'verified', summary: 'Verified version one', targetVersion: requirement.version, requirementIds: [requirement.id],
    })
    operational.updateRequirement(requirement.id, { expectedVersion: requirement.version, title: 'Version two' })

    expect(operational.listEvidence(project.id, false).map(({ id }) => id)).not.toContain(evidence.id)
    expect(operational.listEvidence(project.id, true).find(({ id }) => id === evidence.id)).toMatchObject({ stale: true })
  })

  it('redacts bearer credentials without retaining the token value', () => {
    const project = repository.createProject({ title: 'Credential redaction' }, provenance)
    const result = operational.createRun(project.id, {
      command: 'curl -H "Authorization: Bearer topsecret" https://example.invalid',
      outcome: 'failed', stdoutTruncated: false, stderrTruncated: false,
    })

    expect(result.run.command).toContain('[REDACTED]')
    expect(result.run.command).not.toContain('topsecret')
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
})
