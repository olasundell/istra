import { copyFile, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { migrations } from './migrations.js'

export interface DatabasePaths {
  dataDir: string
  databasePath: string
  backupDir: string
}

export function resolveDatabasePaths(
  dataDir = process.env.ISTRA_DATA_DIR,
  backupDir = process.env.ISTRA_BACKUP_DIR,
): DatabasePaths {
  const platformDefault = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Istra')
    : process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? homedir(), 'Istra')
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'istra')
  const absolute = resolve(dataDir ?? platformDefault)
  return {
    dataDir: absolute,
    databasePath: join(absolute, 'istra.sqlite3'),
    backupDir: resolve(backupDir ?? join(absolute, 'backups')),
  }
}

export interface OpenDatabaseResult {
  db: DatabaseSync
  paths: DatabasePaths
  backupManager: BackupManager
}

function isoFileTimestamp(date = new Date()): string {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

async function onlineBackupInWorker(sourcePath: string, targetPath: string): Promise<void> {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync, backup } = require('node:sqlite');
    (async () => {
      const source = new DatabaseSync(workerData.sourcePath, { readOnly: true });
      try {
        source.exec('PRAGMA busy_timeout = 5000');
        await backup(source, workerData.targetPath, { rate: 10000 });
        parentPort.postMessage({ ok: true });
      } catch (error) {
        parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
      } finally {
        source.close();
      }
    })();
  `
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const worker = new Worker(code, { eval: true, workerData: { sourcePath, targetPath } })
    let settled = false
    worker.once('message', (message: { ok: boolean; message?: string }) => {
      settled = true
      if (message.ok) resolvePromise()
      else rejectPromise(new Error(message.message ?? 'SQLite online backup failed'))
    })
    worker.once('error', (error) => { settled = true; rejectPromise(error) })
    worker.once('exit', (exitCode) => {
      if (!settled) rejectPromise(new Error(`SQLite backup worker exited without a result (code ${exitCode})`))
    })
  })
}

export class BackupManager {
  private dailyWriteDate: string | null = null

  constructor(private readonly db: DatabaseSync, readonly paths: DatabasePaths) {}

  async create(kind: 'daily' | 'weekly' | 'pre-migration' | 'pre-import', suffix?: string): Promise<string> {
    await mkdir(this.paths.backupDir, { recursive: true })
    const now = new Date()
    const stem = kind === 'daily'
      ? `daily-${now.toISOString().slice(0, 10)}`
      : kind === 'weekly'
        ? `weekly-${isoWeek(now)}`
        : `${kind}-${suffix ?? isoFileTimestamp(now)}`
    const target = join(this.paths.backupDir, `${stem}.sqlite3`)
    const lockPath = `${target}.lock`
    let lock: Awaited<ReturnType<typeof open>> | undefined
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        lock = await open(lockPath, 'wx')
        await lock.writeFile(String(process.pid), 'utf8')
        break
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
        const owner = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10)
        let active = Number.isInteger(owner) && owner > 0
        if (active) {
          try { process.kill(owner, 0) } catch (ownerError) {
            active = ownerError instanceof Error && 'code' in ownerError && ownerError.code === 'EPERM'
          }
        }
        if (!active) { await rm(lockPath, { force: true }); continue }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (!lock) throw new Error(`Timed out waiting for backup lock ${lockPath}`)
    try {
      const reusableTarget = kind === 'daily' || kind === 'weekly'
      if (!reusableTarget || !(await this.isValidBackup(target))) {
        await rm(target, { force: true })
        const dailyTarget = join(this.paths.backupDir, `daily-${now.toISOString().slice(0, 10)}.sqlite3`)
        if (kind === 'weekly' && await this.isValidBackup(dailyTarget)) {
          await copyFile(dailyTarget, target)
        } else {
          await onlineBackupInWorker(this.paths.databasePath, target)
        }
      }
      await this.prune(basename(target))
    } finally {
      await lock.close()
      await rm(lockPath, { force: true })
    }
    return target
  }

  private async isValidBackup(path: string): Promise<boolean> {
    if (!(await stat(path).then(() => true, () => false))) return false
    let candidate: DatabaseSync | undefined
    try {
      candidate = new DatabaseSync(path, { readOnly: true })
      const result = candidate.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
      return result.integrity_check === 'ok'
    } catch { return false } finally { candidate?.close() }
  }

  async beforeWrite(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10)
    if (this.dailyWriteDate === today) return
    await this.create('daily')
    await this.create('weekly')
    this.dailyWriteDate = today
  }

  async list(includeLockedName?: string): Promise<Array<{ name: string; path: string; size: number; modifiedAt: string }>> {
    await mkdir(this.paths.backupDir, { recursive: true })
    const directoryEntries = await readdir(this.paths.backupDir)
    const lockedNames = new Set(directoryEntries.filter((name) => name.endsWith('.sqlite3.lock')).map((name) => name.slice(0, -5)))
    const names = directoryEntries.filter((name) => name.endsWith('.sqlite3') && (!lockedNames.has(name) || name === includeLockedName)).sort().reverse()
    return Promise.all(names.map(async (name) => {
      const path = join(this.paths.backupDir, name)
      const info = await stat(path)
      return { name, path, size: info.size, modifiedAt: info.mtime.toISOString() }
    }))
  }

  private async prune(includeLockedName: string): Promise<void> {
    const files = await this.list(includeLockedName)
    const retention: Array<[string, number]> = [['daily-', 14], ['weekly-', 8], ['pre-migration-', 5], ['pre-import-', 5]]
    for (const [prefix, keep] of retention) {
      const stale = files.filter((file) => file.name.startsWith(prefix)).slice(keep)
      await Promise.all(stale.map((file) => rm(file.path, { force: true })))
    }
  }
}

function currentMigrationVersion(db: DatabaseSync): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
  if (!table) return 0
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }
  return Number(row.version)
}

function assertCompatibleMigrationHistory(db: DatabaseSync, databasePath: string): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
  if (!table) return
  const expected = new Map(migrations.map((migration) => [migration.version, migration.name]))
  const applied = db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all() as Array<{ version: number; name: string }>
  const incompatible = applied.find((migration) => expected.get(Number(migration.version)) !== String(migration.name))
  if (incompatible) {
    throw new Error(`Database ${databasePath} uses an incompatible legacy schema. Recreate it before starting Istra.`)
  }
}

export async function openIstraDatabase(options: { dataDir?: string; databasePath?: string; backupDir?: string } = {}): Promise<OpenDatabaseResult> {
  const resolved = resolveDatabasePaths(options.dataDir, options.backupDir)
  const databasePath = options.databasePath ? resolve(options.databasePath) : resolved.databasePath
  const paths = {
    dataDir: dirname(databasePath),
    databasePath,
    backupDir: options.databasePath && !options.backupDir && !process.env.ISTRA_BACKUP_DIR
      ? join(dirname(databasePath), 'backups')
      : resolved.backupDir,
  }
  await mkdir(paths.dataDir, { recursive: true })
  const existed = await stat(databasePath).then(() => true, () => false)
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;')
  const backupManager = new BackupManager(db, paths)
  try {
    assertCompatibleMigrationHistory(db, databasePath)
  } catch (error) {
    db.close()
    throw error
  }
  const version = currentMigrationVersion(db)
  const pending = migrations.filter((migration) => migration.version > version)
  if (pending.length > 0 && existed) await backupManager.create('pre-migration', `v${version}-to-v${pending.at(-1)?.version}-${isoFileTimestamp()}`)
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }
  }
  return { db, paths, backupManager }
}
