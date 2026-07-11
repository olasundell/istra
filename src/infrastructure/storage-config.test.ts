import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { redactDatabaseUrl, resolveStorageConfig, writeStorageFile } from './storage-config.js'

describe('storage configuration', () => {
  it('uses SQLite when no storage setting exists', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'istra-storage-'))
    await expect(resolveStorageConfig({ dataDir, environment: {} })).resolves.toMatchObject({
      backend: 'sqlite',
      dataDir,
      databasePath: join(dataDir, 'istra.sqlite3'),
    })
  })

  it('uses environment settings ahead of the shared config', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'istra-storage-'))
    const configPath = join(dataDir, 'config.json')
    await writeStorageFile(configPath, { backend: 'postgresql', databaseUrl: 'postgresql://stored:secret@127.0.0.1/stored', poolMax: 9 })
    await expect(resolveStorageConfig({ dataDir, configPath, environment: { ISTRA_STORAGE: 'sqlite' } })).resolves.toMatchObject({ backend: 'sqlite' })
    await expect(resolveStorageConfig({ dataDir, configPath, environment: { ISTRA_DATABASE_URL: 'postgresql://env:secret@127.0.0.1/env', ISTRA_POSTGRES_POOL_MAX: '2' } })).resolves.toMatchObject({
      backend: 'postgresql', databaseUrl: 'postgresql://env:secret@127.0.0.1/env', poolMax: 2,
    })
  })

  it('uses explicit PostgreSQL runtime options ahead of environment and shared config', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'istra-storage-'))
    const configPath = join(dataDir, 'config.json')
    await writeStorageFile(configPath, {
      backend: 'postgresql',
      databaseUrl: 'postgresql://stored:secret@127.0.0.1/stored',
      poolMax: 9,
    })

    await expect(resolveStorageConfig({
      backend: 'postgresql',
      databaseUrl: 'postgresql://explicit:secret@127.0.0.1/explicit',
      poolMax: 6,
      dataDir,
      configPath,
      environment: {
        ISTRA_STORAGE: 'postgresql',
        ISTRA_DATABASE_URL: 'postgresql://environment:secret@127.0.0.1/environment',
        ISTRA_POSTGRES_POOL_MAX: '2',
      },
    })).resolves.toMatchObject({
      backend: 'postgresql',
      databaseUrl: 'postgresql://explicit:secret@127.0.0.1/explicit',
      poolMax: 6,
    })
  })

  it('uses explicit SQLite runtime options ahead of PostgreSQL environment and shared config', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'istra-storage-'))
    const configPath = join(dataDir, 'config.json')
    const databasePath = join(dataDir, 'explicit', 'istra.sqlite3')
    const backupDir = join(dataDir, 'explicit-backups')
    await writeStorageFile(configPath, {
      backend: 'postgresql',
      databaseUrl: 'postgresql://stored:secret@127.0.0.1/stored',
      poolMax: 9,
    })

    await expect(resolveStorageConfig({
      backend: 'sqlite',
      poolMax: 7,
      dataDir,
      databasePath,
      backupDir,
      configPath,
      environment: {
        ISTRA_STORAGE: 'postgresql',
        ISTRA_DATABASE_URL: 'postgresql://environment:secret@127.0.0.1/environment',
        ISTRA_POSTGRES_POOL_MAX: '2',
        ISTRA_BACKUP_DIR: join(dataDir, 'environment-backups'),
      },
    })).resolves.toMatchObject({
      backend: 'sqlite',
      databasePath,
      backupDir,
      poolMax: 7,
    })
  })

  it('validates PostgreSQL configuration', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'istra-storage-'))
    await expect(resolveStorageConfig({ backend: 'postgresql', dataDir, environment: {} })).rejects.toThrow(/requires/)
    await expect(resolveStorageConfig({ databaseUrl: 'https://example.com/database', dataDir, environment: {} })).rejects.toThrow(/scheme/)
    await expect(resolveStorageConfig({ databaseUrl: 'postgresql://localhost', dataDir, environment: {} })).rejects.toThrow(/database name/)
  })

  it('writes shared configuration atomically with private permissions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'istra-storage-'))
    const configPath = join(dataDir, 'nested', 'config.json')
    await writeStorageFile(configPath, { backend: 'postgresql', databaseUrl: 'postgresql://istra:secret@127.0.0.1/istra' })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ backend: 'postgresql', databaseUrl: 'postgresql://istra:secret@127.0.0.1/istra' })
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  })

  it('rejects malformed shared configuration and redacts credentials', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'istra-storage-'))
    const configPath = join(dataDir, 'config.json')
    await writeFile(configPath, '{not-json')
    await expect(resolveStorageConfig({ dataDir, configPath, environment: {} })).rejects.toThrow(/not valid JSON/)
    expect(redactDatabaseUrl('postgresql://istra:secret@127.0.0.1:5432/istra?sslmode=disable')).toBe('postgresql://127.0.0.1:5432/istra')
  })
})
