import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provenance } from '../../domain/contracts.js'
import { openIstraDatabase } from './database.js'
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
})
