// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ConflictError, ValidationError } from '../../application/errors.js'
import { createRuntime } from '../runtime.js'
import { resolveDatabasePaths } from './database.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function runtime() {
  const dataDir = await mkdtemp(join(tmpdir(), 'istra-test-'))
  directories.push(dataDir)
  const application = await createRuntime({ dataDir })
  const db = new DatabaseSync(resolveDatabasePaths(dataDir).databasePath)
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  return {
    ...application,
    db,
    close: async () => {
      db.close()
      await application.close()
    },
  }
}

describe('SQLite project memory repository', () => {
  it('restores current and historical project state after the application restarts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'istra-restart-test-'))
    directories.push(dataDir)

    const firstRun = await createRuntime({ dataDir })
    const project = await firstRun.service.createProject({ title: 'Persistent memory' })
    const savedCheckpoint = await firstRun.service.saveCheckpoint(project.id, {
      expectedVersion: project.version,
      content: 'The first durable checkpoint.',
      currentFocus: 'Prove restart persistence',
      nextAction: 'Reopen the same database',
      blockers: [],
    })
    const { checkpoint } = savedCheckpoint
    expect(savedCheckpoint.snapshot).toMatchObject({ schemaVersion: 3, digest: expect.any(String) })
    await firstRun.service.reviseUpdate(checkpoint.id, {
      expectedVersion: checkpoint.version,
      content: 'The checkpoint and its original revision are durable.',
    })
    await firstRun.close()

    const secondRun = await createRuntime({ dataDir })
    const restored = (await secondRun.service.getProject(project.id))!
    expect(restored.project.currentCheckpointId).toBe(checkpoint.id)
    expect(restored.pulse.currentFocus).toBe('Prove restart persistence')
    expect(restored.updates[0]?.currentRevision.content).toBe('The checkpoint and its original revision are durable.')
    expect(await secondRun.service.getUpdateRevisions(checkpoint.id)).toHaveLength(2)
    expect((await secondRun.service.getCheckpointSnapshot(checkpoint.id))?.digest).toBe(savedCheckpoint.snapshot.digest)
    expect((await secondRun.service.search('durable'))[0]).toMatchObject({ projectId: project.id, type: 'update' })
    await secondRun.close()
  })

  it('persists overlapping phases and rejects a phase from another project', async () => {
    const app = await runtime()
    const first = await app.service.createProject({ title: 'First' })
    const second = await app.service.createProject({ title: 'Second' })
    const discovery = await app.service.createPhase(first.id, { name: 'Discovery', status: 'active' })
    await app.service.createPhase(first.id, { name: 'Build', status: 'active' })

    expect((await app.service.getProject(first.id))?.pulse.activePhases).toHaveLength(2)
    await expect(app.service.createWorkItem(second.id, { title: 'Wrong parent', kind: 'issue', phaseId: discovery.id }))
      .rejects.toBeInstanceOf(ValidationError)
    await app.close()
  })

  it('saves a checkpoint atomically and retains its snapshot when revised', async () => {
    const app = await runtime()
    const project = await app.service.createProject({ title: 'Compiler experiment' })
    await app.service.createPhase(project.id, { name: 'Prototype', status: 'active' })
    await app.service.createWorkItem(project.id, { title: 'Handle invalid input', kind: 'issue', status: 'blocked' })

    const savedCheckpoint = await app.service.saveCheckpoint(project.id, {
      expectedVersion: project.version,
      content: 'Parser works; recovery remains.',
      currentFocus: 'Error recovery',
      nextAction: 'Add recovery cases',
      blockers: ['Need a useful diagnostic shape'],
    })
    const { checkpoint } = savedCheckpoint
    const detail = (await app.service.getProject(project.id))!
    expect(detail.project.currentCheckpointId).toBe(checkpoint.id)
    expect(detail.pulse.currentFocus).toBe('Error recovery')
    expect(checkpoint.currentRevision.snapshot?.activePhaseIds).toHaveLength(1)
    expect(checkpoint.currentRevision.snapshot?.unresolvedWorkItemIds).toHaveLength(1)
    expect(savedCheckpoint.snapshot).toMatchObject({
      schemaVersion: 3,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      capturedAt: expect.any(String),
    })
    expect((await app.service.getCheckpointSnapshot(checkpoint.id))?.id).toBe(savedCheckpoint.snapshot.id)

    const revised = await app.service.reviseUpdate(checkpoint.id, { expectedVersion: checkpoint.version, content: 'Parser and recovery now work.' })
    expect(revised.currentRevision.snapshot).toEqual(checkpoint.currentRevision.snapshot)
    expect(await app.service.getUpdateRevisions(checkpoint.id)).toHaveLength(2)
    await app.close()
  })

  it('rolls back the checkpoint and project pulse when structured snapshot persistence fails', async () => {
    const app = await runtime()
    const project = await app.service.createProject({ title: 'Atomic snapshot failure' })
    app.db.exec(`
      CREATE TRIGGER fail_structured_snapshot
      BEFORE INSERT ON checkpoint_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'forced structured snapshot failure');
      END;
    `)

    await expect(app.service.saveCheckpoint(project.id, {
      expectedVersion: project.version,
      content: 'This checkpoint must not survive.',
      currentFocus: 'Must also roll back',
    })).rejects.toThrow(/forced structured snapshot failure/)

    expect((await app.service.getProject(project.id))?.project).toMatchObject({
      version: project.version,
      currentCheckpointId: null,
      currentFocus: null,
    })
    expect(app.db.prepare("SELECT COUNT(*) AS count FROM updates WHERE project_id=? AND kind='checkpoint'").get(project.id)).toEqual({ count: 0 })
    expect(app.db.prepare('SELECT COUNT(*) AS count FROM checkpoint_snapshots').get()).toEqual({ count: 0 })
    expect((await app.service.listActivity(project.id)).filter(({ eventType }) => eventType.startsWith('checkpoint'))).toHaveLength(0)
    await app.close()
  })

  it('rejects stale writes without changing current state', async () => {
    const app = await runtime()
    const project = await app.service.createProject({ title: 'Versioned' })
    const updated = await app.service.updateProject(project.id, { expectedVersion: project.version, state: 'paused' })
    await expect(app.service.updateProject(project.id, { expectedVersion: project.version, state: 'completed' }))
      .rejects.toBeInstanceOf(ConflictError)
    expect((await app.service.getProject(project.id))?.project).toMatchObject({ state: 'paused', version: updated.version })
    await app.close()
  })

  it('keeps full revision history while FTS indexes only the current revision', async () => {
    const app = await runtime()
    const project = await app.service.createProject({ title: 'Searchable' })
    const update = await app.service.createUpdate(project.id, { kind: 'discovery', content: 'A quokka appeared in the first approach.' })
    expect(await app.service.search('quokka')).toHaveLength(1)
    await app.service.reviseUpdate(update.id, { expectedVersion: update.version, content: 'A wombat replaced the earlier approach.' })
    expect(await app.service.search('quokka')).toHaveLength(0)
    expect((await app.service.search('wombat'))[0]).toMatchObject({ type: 'update', projectId: project.id })
    expect((await app.service.getUpdateRevisions(update.id)).map((entry) => entry.content)).toEqual([
      'A wombat replaced the earlier approach.',
      'A quokka appeared in the first approach.',
    ])
    await app.close()
  })

  it('round-trips visible and historical state through a validated full export', async () => {
    const source = await runtime()
    const project = await source.service.createProject({ title: 'Portable', description: 'Move me' })
    const update = await source.service.createUpdate(project.id, { kind: 'decision', content: 'Use SQLite.' })
    await source.service.reviseUpdate(update.id, { expectedVersion: update.version, content: 'Use built-in SQLite.' })
    const bundle = await source.service.exportAll()

    const target = await runtime()
    await target.service.importAll(bundle)
    const imported = (await target.service.getProject(project.id))!
    expect(imported.project.title).toBe('Portable')
    expect(imported.updates[0]?.currentRevision.content).toBe('Use built-in SQLite.')
    expect(await target.service.getUpdateRevisions(update.id)).toHaveLength(2)
    expect(await target.service.search('built-in')).toHaveLength(1)
    await source.close()
    await target.close()
  })
})
