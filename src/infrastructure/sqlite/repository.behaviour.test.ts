import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ValidationError } from '../../application/errors.js'
import type { ExportBundle } from '../../application/ports.js'
import type { Provenance } from '../../domain/contracts.js'
import { openIstraDatabase } from './database.js'
import { SqliteOperationalRepository } from './operational-repository.js'
import { SqliteIstraRepository } from './repository.js'

describe('SQLite repository behaviour', () => {
  const provenance: Provenance = { source: 'ui', client: 'repository-test' }
  let dataDir: string
  let db: DatabaseSync
  let repository: SqliteIstraRepository

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'istra-repository-test-'))
    const database = await openIstraDatabase({ dataDir })
    db = database.db
    repository = new SqliteIstraRepository(db)
  })

  afterEach(async () => {
    vi.useRealTimers()
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('rolls back update, revision and search rows when history recording fails', () => {
    const project = repository.createProject({ title: 'Atomic history' }, provenance)
    db.exec(`
      CREATE TRIGGER fail_update_event
      BEFORE INSERT ON activity_events
      WHEN NEW.event_type = 'update.created'
      BEGIN
        SELECT RAISE(ABORT, 'forced event failure');
      END;
    `)

    expect(() => repository.createUpdate(project.id, {
      kind: 'note',
      content: 'This must not partially persist',
    }, provenance)).toThrow(/forced event failure/)

    expect((db.prepare('SELECT COUNT(*) AS count FROM updates').get() as { count: number }).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM update_revisions').get() as { count: number }).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM search_index WHERE entity_type = ?').get('update') as { count: number }).count).toBe(0)
  })

  it('keeps checkpoint selection stable while preserving its structured snapshot across revisions', () => {
    const project = repository.createProject({ title: 'Checkpoint memory' }, provenance)
    const activePhaseA = repository.createPhase(project.id, { name: 'Research', status: 'active' }, provenance)
    const activePhaseB = repository.createPhase(project.id, { name: 'Prototype', status: 'active' }, provenance)
    repository.createPhase(project.id, { name: 'Later', status: 'planned' }, provenance)
    const unresolved = repository.createWorkItem(project.id, {
      kind: 'issue', title: 'Open question', status: 'blocked', phaseId: activePhaseA.id,
    }, provenance)
    repository.createWorkItem(project.id, {
      kind: 'task', title: 'Already done', status: 'resolved', phaseId: activePhaseB.id,
    }, provenance)

    const checkpoint = repository.saveCheckpoint(project.id, {
      expectedVersion: project.version,
      content: 'First checkpoint text',
      currentFocus: 'Keep the pulse durable',
      nextAction: 'Revise the prose',
      blockers: ['Open question'],
    }, provenance)
    expect(checkpoint.currentRevision.snapshot).toMatchObject({
      activePhaseIds: expect.arrayContaining([activePhaseA.id, activePhaseB.id]),
      unresolvedWorkItemIds: [unresolved.id],
      currentFocus: 'Keep the pulse durable',
      nextAction: 'Revise the prose',
      blockers: ['Open question'],
    })
    expect(checkpoint.currentRevision.snapshot?.activePhaseIds).toHaveLength(2)

    const ordinaryUpdate = repository.createUpdate(project.id, {
      kind: 'decision', content: 'An ordinary entry does not replace the checkpoint.',
    }, provenance)
    expect(repository.getProject(project.id)?.currentCheckpointId).toBe(checkpoint.id)
    expect(ordinaryUpdate.id).not.toBe(checkpoint.id)

    const revised = repository.reviseUpdate(checkpoint.id, {
      expectedVersion: checkpoint.version,
      content: 'Revised checkpoint prose',
    }, provenance)
    expect(revised.currentRevision.snapshot).toEqual(checkpoint.currentRevision.snapshot)
    expect(repository.getUpdateRevisions(checkpoint.id).map(({ content }) => content)).toEqual([
      'Revised checkpoint prose',
      'First checkpoint text',
    ])
  })

  it('archives a phase without changing its children and supports overlapping phases', () => {
    const project = repository.createProject({ title: 'Volatile phases' }, provenance)
    const first = repository.createPhase(project.id, { name: 'First active phase', status: 'active' }, provenance)
    const second = repository.createPhase(project.id, { name: 'Second active phase', status: 'active' }, provenance)
    const item = repository.createWorkItem(project.id, {
      kind: 'task', title: 'Keep this child', status: 'in_progress', phaseId: first.id,
    }, provenance)
    expect(repository.getProjectDetail(project.id)?.pulse.activePhases.map(({ id }) => id)).toEqual([first.id, second.id])

    const archived = repository.updatePhase(first.id, {
      expectedVersion: first.version,
      archived: true,
    }, provenance)
    expect(archived.archivedAt).not.toBeNull()
    expect(repository.getProjectDetail(project.id)?.pulse.activePhases.map(({ id }) => id)).toEqual([second.id])
    expect(repository.listWorkItems(project.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: item.id, phaseId: first.id, status: 'in_progress' }),
    ]))
  })

  it('keeps FTS and project activity time in sync with current child content', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T08:00:00.000Z'))
    const project = repository.createProject({ title: 'Searchable memory' }, provenance)
    const item = repository.createWorkItem(project.id, {
      kind: 'idea', title: 'Hyperdrive sketch', status: 'open',
    }, provenance)
    expect(repository.search('hyperdrive')).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'work_item', id: item.id }),
    ]))

    vi.setSystemTime(new Date('2026-07-10T09:00:00.000Z'))
    const renamed = repository.updateWorkItem(item.id, {
      expectedVersion: item.version,
      title: 'Warp engine sketch',
    }, provenance)
    expect(repository.search('hyperdrive')).toEqual([])
    expect(repository.search('warp')).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'work_item', id: item.id }),
    ]))
    expect(repository.listProjects()[0]?.lastActivityAt).toBe('2026-07-10T09:00:00.000Z')

    const update = repository.createUpdate(project.id, {
      kind: 'discovery', content: 'Blueberries are indexed.',
    }, provenance)
    expect(repository.search('blueberries')[0]).toMatchObject({ type: 'update', id: update.id })
    const revised = repository.reviseUpdate(update.id, {
      expectedVersion: update.version,
      content: 'Raspberries replaced the previous term.',
    }, provenance)
    expect(repository.search('blueberries')).toEqual([])
    expect(repository.search('raspberries')[0]).toMatchObject({ type: 'update', id: update.id })

    repository.softDeleteUpdate(revised.id, revised.version, provenance)
    expect(repository.search('raspberries')).toEqual([])
    expect(repository.getUpdateRevisions(update.id)).toHaveLength(2)
    expect(renamed.version).toBe(item.version + 1)
  })

  it('reports explicit blocking relations through the primary repository', () => {
    const operational = new SqliteOperationalRepository(db)
    const project = repository.createProject({ title: 'Blocking graph' }, provenance)
    const blocker = repository.createWorkItem(project.id, { kind: 'task', title: 'Compile' }, provenance)
    const blocked = repository.createWorkItem(project.id, { kind: 'task', title: 'Verify' }, provenance)

    operational.linkWorkItems(project.id, {
      fromWorkItemId: blocker.id,
      toWorkItemId: blocked.id,
      kind: 'blocks',
    })

    expect(repository.listWorkItems(project.id).find(({ id }) => id === blocked.id)).toMatchObject({
      effectiveBlocked: true,
      blockerReasons: ['Blocked by Compile'],
    })
  })

  it('preserves related phases when only the responsible phase changes', () => {
    const project = repository.createProject({ title: 'Phase links' }, provenance)
    const original = repository.createPhase(project.id, { name: 'Original', status: 'active' }, provenance)
    const related = repository.createPhase(project.id, { name: 'Related', status: 'planned' }, provenance)
    const replacement = repository.createPhase(project.id, { name: 'Replacement', status: 'active' }, provenance)
    const item = repository.createWorkItem(project.id, {
      kind: 'task', title: 'Keep related work', phaseId: original.id, relatedPhaseIds: [related.id],
    }, provenance)

    repository.updateWorkItem(item.id, { expectedVersion: item.version, phaseId: replacement.id }, provenance)

    expect(db.prepare('SELECT phase_id,role FROM work_phase_links WHERE work_item_id=? ORDER BY role').all(item.id)).toEqual([
      { phase_id: related.id, role: 'related' },
      { phase_id: replacement.id, role: 'responsible' },
    ])
  })

  it('paginates through the complete activity history beyond one thousand events', () => {
    const project = repository.createProject({ title: 'Long activity history' }, provenance)
    const insert = db.prepare('INSERT INTO activity_events(id,project_id,entity_type,entity_id,event_type,payload_json,source,created_at) VALUES (?,?,?,?,?,?,?,?)')
    db.exec('BEGIN')
    for (let index = 0; index < 1_005; index += 1) {
      insert.run(`bulk-${index}`, project.id, 'probe', project.id, 'probe.recorded', '{}', 'system', `2026-01-01T00:${String(index).padStart(4, '0')}Z`)
    }
    db.exec('COMMIT')

    let cursor: string | null | undefined
    const ids: string[] = []
    do {
      const page = repository.listActivityPage(project.id, 200, cursor)
      ids.push(...page.items.map(({ id }) => id))
      cursor = page.nextCursor
    } while (cursor)

    const total = Number((db.prepare('SELECT COUNT(*) AS count FROM activity_events WHERE project_id=?').get(project.id) as { count: number }).count)
    expect(ids).toHaveLength(total)
    expect(new Set(ids)).toHaveLength(total)
  })

  it('round-trips valid self-referencing rows regardless of insertion order', () => {
    const project = repository.createProject({ title: 'Hierarchy export' }, provenance)
    const child = repository.createWorkItem(project.id, { kind: 'task', title: 'Child first' }, provenance)
    const parent = repository.createWorkItem(project.id, { kind: 'task', title: 'Parent later' }, provenance)
    repository.updateWorkItem(child.id, { expectedVersion: child.version, parentId: parent.id }, provenance)
    const bundle = repository.exportAll()

    expect(() => repository.validateImport(bundle)).not.toThrow()
    repository.importAll(bundle)
    expect(repository.listWorkItems(project.id).find(({ id }) => id === child.id)?.parentId).toBe(parent.id)
  })

  it('accepts legacy v1 exports and initialises their operational defaults', () => {
    const project = repository.createProject({ title: 'Legacy export' }, provenance)
    const phase = repository.createPhase(project.id, { name: 'Legacy phase', status: 'active' }, provenance)
    const workItem = repository.createWorkItem(project.id, { kind: 'task', title: 'Legacy work', phaseId: phase.id }, provenance)
    const current = repository.exportAll()
    const legacyTables = ['projects', 'phases', 'work_items', 'labels', 'work_item_labels', 'updates', 'update_revisions', 'activity_events']
    const legacy: ExportBundle = {
      format: 'istra-export',
      formatVersion: 1,
      exportedAt: current.exportedAt,
      tables: Object.fromEntries(legacyTables.map((table) => [table, current.tables[table]!.map((row) => {
        if (table !== 'work_items') return row
        const { stable_key: _stableKey, parent_id: _parentId, ...v1Row } = row
        return v1Row
      })])),
    }

    expect(() => repository.validateImport(legacy)).not.toThrow()
    repository.importAll(legacy)
    expect(repository.getProject(project.id)?.title).toBe('Legacy export')
    expect((db.prepare('SELECT COUNT(*) AS count FROM requirement_states WHERE project_id=?').get(project.id) as { count: number }).count).toBe(4)
    expect((db.prepare('SELECT COUNT(*) AS count FROM work_queues WHERE project_id=?').get(project.id) as { count: number }).count).toBe(1)
    const operational = new SqliteOperationalRepository(db)
    const queue = operational.listWorkQueues(project.id)[0]!
    expect(operational.listWorkItems(project.id, queue.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: workItem.id, phaseId: phase.id }),
    ]))
    expect(db.prepare("SELECT role FROM work_phase_links WHERE work_item_id=? AND phase_id=?").get(workItem.id, phase.id)).toEqual({ role: 'responsible' })
    expect(repository.search('Legacy', 20, { phaseId: phase.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'work_item', id: workItem.id }),
    ]))
  })

  it('rejects evidence artifacts assigned to another run and snapshots of ordinary updates', () => {
    const operational = new SqliteOperationalRepository(db)
    const first = repository.createProject({ title: 'Artifact source' }, provenance)
    const second = repository.createProject({ title: 'Evidence target' }, provenance)
    const run = operational.createRun(first.id, {
      command: 'pnpm test', outcome: 'verified', stdoutTruncated: false, stderrTruncated: false,
      artifacts: [{ uri: 'artifact://foreign-run' }],
    })
    const evidence = operational.createEvidence(second.id, {
      result: 'verified', summary: 'Standalone evidence', artifacts: [{ uri: 'artifact://standalone' }],
    })
    const invalidArtifactBundle = repository.exportAll()
    invalidArtifactBundle.tables.evidence_artifact_links!.find((row) => row.evidence_id === evidence.id)!.artifact_id = run.artifacts[0]!.id
    expect(() => repository.validateImport(invalidArtifactBundle)).toThrow(ValidationError)

    const checkpoint = repository.saveCheckpoint(second.id, {
      expectedVersion: second.version, content: 'Valid checkpoint', blockers: [],
    }, provenance)
    operational.captureCheckpointSnapshot(second.id, checkpoint.id)
    const note = repository.createUpdate(second.id, { kind: 'note', content: 'Not a checkpoint' }, provenance)
    const invalidSnapshotBundle = repository.exportAll()
    invalidSnapshotBundle.tables.checkpoint_snapshots![0]!.checkpoint_id = note.id
    expect(() => repository.validateImport(invalidSnapshotBundle)).toThrow(ValidationError)
  })

  it('rejects operational import links that cross project boundaries', () => {
    const operational = new SqliteOperationalRepository(db)
    const first = repository.createProject({ title: 'First import project' }, provenance)
    const second = repository.createProject({ title: 'Second import project' }, provenance)
    const requirement = operational.createRequirement(first.id, { stableKey: 'FIRST-1', kind: 'requirement', title: 'First requirement' })
    const secondState = operational.listRequirementStates(second.id)[0]!
    const bundle = repository.exportAll()
    bundle.tables.requirements!.find((row) => row.id === requirement.id)!.state_id = secondState.id

    expect(() => repository.validateImport(bundle)).toThrow(ValidationError)
  })
})
