import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openIstraDatabase, type OpenDatabaseResult } from './database.js'
import { migrations } from './migrations.js'

describe('SQLite database integrity', () => {
  const directories: string[] = []
  const databases: DatabaseSync[] = []

  afterEach(async () => {
    vi.useRealTimers()
    for (const database of databases.splice(0)) database.close()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  async function openDatabase(): Promise<OpenDatabaseResult> {
    const dataDir = await mkdtemp(join(tmpdir(), 'istra-database-test-'))
    directories.push(dataDir)
    const result = await openIstraDatabase({ dataDir })
    databases.push(result.db)
    return result
  }

  it('enables the durability and relational-integrity pragmas on every connection', async () => {
    const { db } = await openDatabase()

    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5_000)

    expect(() => {
      db.prepare(`
        INSERT INTO phases(id, project_id, name, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), randomUUID(), 'Orphan', 'planned', new Date().toISOString(), new Date().toISOString())
    }).toThrow()
  })

  it('backfills legacy work into the default queue and responsible phase projection', () => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    db.exec('PRAGMA foreign_keys=ON')
    for (const migration of migrations.filter(({ version }) => version <= 3)) db.exec(migration.sql)
    const timestamp = '2026-07-10T08:00:00.000Z'
    const projectId = randomUUID()
    const phaseId = randomUUID()
    const workItemId = randomUUID()
    db.prepare("INSERT INTO projects(id,title,state,created_at,updated_at) VALUES (?,?,'active',?,?)").run(projectId, 'Legacy project', timestamp, timestamp)
    db.prepare("INSERT INTO phases(id,project_id,name,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").run(phaseId, projectId, 'Legacy phase', timestamp, timestamp)
    db.prepare("INSERT INTO work_items(id,project_id,phase_id,kind,title,status,created_at,updated_at) VALUES (?,?,?,'task',?,'open',?,?)").run(workItemId, projectId, phaseId, 'Legacy work', timestamp, timestamp)

    db.exec(migrations.find(({ version }) => version === 4)!.sql)

    expect(db.prepare('SELECT q.project_id,i.work_item_id FROM work_queue_items i JOIN work_queues q ON q.id=i.queue_id WHERE i.work_item_id=?').get(workItemId)).toEqual({ project_id: projectId, work_item_id: workItemId })
    expect(db.prepare('SELECT phase_id,role FROM work_phase_links WHERE work_item_id=?').get(workItemId)).toEqual({ phase_id: phaseId, role: 'responsible' })
  })

  it('rejects a current checkpoint that is missing, deleted, the wrong kind, or owned by another project', async () => {
    const { db } = await openDatabase()
    const now = new Date().toISOString()
    const firstProjectId = randomUUID()
    const secondProjectId = randomUUID()
    const insertProject = db.prepare(`
      INSERT INTO projects(id, title, state, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
    `)
    insertProject.run(firstProjectId, 'First project', now, now)
    insertProject.run(secondProjectId, 'Second project', now, now)

    const insertUpdate = db.prepare(`
      INSERT INTO updates(id, project_id, kind, deleted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const noteId = randomUUID()
    const deletedCheckpointId = randomUUID()
    const otherCheckpointId = randomUUID()
    const validCheckpointId = randomUUID()
    insertUpdate.run(noteId, firstProjectId, 'note', null, now, now)
    insertUpdate.run(deletedCheckpointId, firstProjectId, 'checkpoint', now, now, now)
    insertUpdate.run(otherCheckpointId, secondProjectId, 'checkpoint', null, now, now)
    insertUpdate.run(validCheckpointId, firstProjectId, 'checkpoint', null, now, now)

    const pointProjectAt = db.prepare('UPDATE projects SET current_checkpoint_id = ? WHERE id = ?')
    for (const invalidId of [randomUUID(), noteId, deletedCheckpointId, otherCheckpointId]) {
      expect(() => pointProjectAt.run(invalidId, firstProjectId)).toThrow(/invalid current checkpoint/)
    }
    expect(() => pointProjectAt.run(validCheckpointId, firstProjectId)).not.toThrow()
  })

  it('creates restorable daily and weekly snapshots before a write', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T08:00:00.000Z'))
    const { db, backupManager } = await openDatabase()
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO projects(id, title, state, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
    `).run(randomUUID(), 'Before the write', now, now)

    await backupManager.beforeWrite()
    const backups = await backupManager.list()
    expect(backups.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'daily-2026-07-10.sqlite3',
      'weekly-2026-W28.sqlite3',
    ]))

    const daily = backups.find(({ name }) => name === 'daily-2026-07-10.sqlite3')
    expect(daily).toBeDefined()
    const restored = new DatabaseSync(daily!.path, { readOnly: true })
    databases.push(restored)
    expect((restored.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count).toBe(1)
    expect((restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
  })

  it('does not accept a corrupt daily target as a completed pre-write backup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T08:00:00.000Z'))
    const { db, backupManager, paths } = await openDatabase()
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO projects(id, title, state, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
    `).run(randomUUID(), 'Must be backed up', now, now)
    await mkdir(paths.backupDir, { recursive: true })
    await writeFile(join(paths.backupDir, 'daily-2026-07-10.sqlite3'), 'incomplete backup')

    await backupManager.beforeWrite()

    const restored = new DatabaseSync(join(paths.backupDir, 'daily-2026-07-10.sqlite3'), { readOnly: true })
    databases.push(restored)
    expect((restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    expect((restored.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count).toBe(1)
  })

  it('retains only the newest fourteen daily snapshots', async () => {
    vi.useFakeTimers()
    const { backupManager } = await openDatabase()

    for (let day = 1; day <= 16; day += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 5, day, 8)))
      await backupManager.create('daily')
    }

    const dailyBackups = (await backupManager.list()).filter(({ name }) => name.startsWith('daily-'))
    expect(dailyBackups).toHaveLength(14)
    expect(dailyBackups.at(-1)?.name).toBe('daily-2026-06-03.sqlite3')
    expect(dailyBackups[0]?.name).toBe('daily-2026-06-16.sqlite3')
  })
})
