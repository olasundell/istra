import { describe, expect, it, vi } from 'vitest'
import {
  assertSafeTrialDatabase,
  createDeploymentConfig,
  describeDeployment,
  executeTrialFirstWorkflow,
  loadPinnedEnvironmentFile,
  restoreOpenCodeLoader,
  runDeployment,
  type WorkflowPhases,
} from './deploy-production.js'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const productionUrl = 'postgresql://istra:do-not-print-me@127.0.0.1:5433/istra'
const confirmation = 'postgresql://127.0.0.1:5433/istra'

function config(extraArguments: string[] = []) {
  return createDeploymentConfig(
    ['--confirm-target', confirmation, '--backup-dir', '/tmp/istra-deploy-test-backups', ...extraArguments],
    { ISTRA_DATABASE_URL: productionUrl },
    new Date('2026-07-19T10:20:30.000Z'),
    '/tmp/istra-repository',
  )
}

function phases(overrides: Partial<WorkflowPhases> = {}): { phases: WorkflowPhases; calls: string[] } {
  const calls: string[] = []
  const phase = (name: string) => async () => {
    calls.push(name)
  }
  return {
    calls,
    phases: {
      preflight: phase('preflight'),
      buildCandidate: phase('buildCandidate'),
      dumpTrialSeed: phase('dumpTrialSeed'),
      createTrial: phase('createTrial'),
      restoreTrial: phase('restoreTrial'),
      migrateTrial: phase('migrateTrial'),
      verifyTrial: phase('verifyTrial'),
      prepareClients: phase('prepareClients'),
      stopProduction: phase('stopProduction'),
      verifyNoProductionWriters: phase('verifyNoProductionWriters'),
      backupProduction: phase('backupProduction'),
      migrateProduction: phase('migrateProduction'),
      verifyMigratedProduction: phase('verifyMigratedProduction'),
      promoteCandidate: phase('promoteCandidate'),
      deployRuntime: phase('deployRuntime'),
      activateClients: phase('activateClients'),
      verifyDeployment: phase('verifyDeployment'),
      restartUnchangedProduction: phase('restartUnchangedProduction'),
      cleanupTrial: phase('cleanupTrial'),
      ...overrides,
    },
  }
}

describe('guarded production deployment contract', () => {
  it('defaults to a no-I/O dry run and never invokes the command runner', async () => {
    const deployConfig = config()
    const runner = vi.fn(async () => {
      throw new Error('runner must not be called')
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(runDeployment(deployConfig, runner)).resolves.toBeNull()

    expect(deployConfig.mode).toBe('dry-run')
    expect(runner).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('accepts the conventional pnpm argument separator', () => {
    expect(createDeploymentConfig(
      ['--', '--apply', '--confirm-target', confirmation, '--backup-dir', '/tmp/istra-backups'],
      { ISTRA_DATABASE_URL: productionUrl },
    ).mode).toBe('apply')
  })

  it('validates a pinned private environment file without executing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'istra-env-test-'))
    const envFile = join(directory, '.env')
    try {
      await writeFile(envFile, 'UNTRUSTED_SHELL=$(exit 99)\n')
      await chmod(envFile, 0o600)

      await expect(loadPinnedEnvironmentFile(
        ['--env-file', envFile],
        { ISTRA_DATABASE_URL: productionUrl },
        '/tmp/istra-repository',
      )).resolves.toBe(envFile)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects inherited Compose routing overrides', () => {
    expect(() => createDeploymentConfig(
      ['--confirm-target', confirmation, '--backup-dir', '/tmp/istra-backups'],
      { ISTRA_DATABASE_URL: productionUrl, COMPOSE_FILE: '/tmp/other-compose.yaml' },
    )).toThrow('COMPOSE_FILE must be unset')
  })

  it('redacts credentials from the dry-run plan', () => {
    const summary = describeDeployment(config())

    expect(summary).toContain(confirmation)
    expect(summary).not.toContain('do-not-print-me')
    expect(summary).not.toContain('istra:do-not-print-me')
  })

  it('requires an exact credential-free production confirmation', () => {
    expect(() => createDeploymentConfig(
      ['--confirm-target', 'postgresql://127.0.0.1:5433/not-istra', '--backup-dir', '/tmp/istra-backups'],
      { ISTRA_DATABASE_URL: productionUrl },
    )).toThrow(/does not match the exact production target/)

    expect(() => createDeploymentConfig(
      ['--confirm-target', productionUrl, '--backup-dir', '/tmp/istra-backups'],
      { ISTRA_DATABASE_URL: productionUrl },
    )).toThrow(/credential-free/)
  })

  it('requires non-empty production role credentials without echoing them', () => {
    expect(() => createDeploymentConfig(
      ['--confirm-target', confirmation, '--backup-dir', '/tmp/istra-backups'],
      { ISTRA_DATABASE_URL: 'postgresql://127.0.0.1:5433/istra' },
    )).toThrow('ISTRA_DATABASE_URL must include a non-empty simple role name and password')
    expect(() => createDeploymentConfig(
      ['--confirm-target', confirmation, '--backup-dir', '/tmp/istra-backups'],
      { ISTRA_DATABASE_URL: 'postgresql://istra@127.0.0.1:5433/istra' },
    )).toThrow('ISTRA_DATABASE_URL must include a non-empty simple role name and password')
  })

  it('keeps the backup directory outside and separate from the repository', () => {
    expect(() => createDeploymentConfig(
      ['--confirm-target', confirmation, '--backup-dir', '/tmp/istra-repository/backups'],
      { ISTRA_DATABASE_URL: productionUrl },
      new Date('2026-07-19T10:20:30.000Z'),
      '/tmp/istra-repository',
    )).toThrow('Backup directory and repository must be separate, non-nested paths')
    expect(() => createDeploymentConfig(
      ['--confirm-target', confirmation, '--backup-dir', '/tmp'],
      { ISTRA_DATABASE_URL: productionUrl },
      new Date('2026-07-19T10:20:30.000Z'),
      '/tmp/istra-repository',
    )).toThrow('Backup directory and repository must be separate, non-nested paths')
  })

  it.each(['postgres', 'template0', 'template1', 'root', 'defaultdb'])(
    'rejects reserved production database %s',
    (database) => {
      expect(() => createDeploymentConfig(
        ['--confirm-target', `postgresql://127.0.0.1:5433/${database}`, '--backup-dir', '/tmp/istra-backups'],
        { ISTRA_DATABASE_URL: `postgresql://istra:secret@127.0.0.1:5433/${database}` },
      )).toThrow(/may not target/)
    },
  )

  it('only accepts a generated, deployment-owned trial database name', () => {
    expect(() => assertSafeTrialDatabase('istra', 'istra')).toThrow(/deployment-owned prefix/)
    expect(() => assertSafeTrialDatabase('another_trial_20260719', 'istra')).toThrow(/deployment-owned prefix/)
    expect(() => assertSafeTrialDatabase('istra_injection;drop', 'istra')).toThrow(/unsafe/)
    expect(() => assertSafeTrialDatabase('istra_istra_trial_20260719102030', 'istra')).not.toThrow()
  })

  it('does not enter any production phase when trial verification fails', async () => {
    const setup = phases()
    setup.phases.verifyTrial = async () => {
      setup.calls.push('verifyTrial')
      throw new Error('trial verification failed')
    }
    setup.phases.cleanupTrial = async () => {
      setup.calls.push('cleanupTrial')
    }

    await expect(executeTrialFirstWorkflow(setup.phases)).rejects.toThrow('trial verification failed')

    expect(setup.calls).not.toContain('stopProduction')
    expect(setup.calls).not.toContain('backupProduction')
    expect(setup.calls).not.toContain('migrateProduction')
    expect(setup.calls.at(-1)).toBe('cleanupTrial')
  })

  it('cleans up a created trial database when restore fails', async () => {
    const cleanup = vi.fn(async () => undefined)
    const setup = phases({
      restoreTrial: async () => {
        throw new Error('restore failed')
      },
      cleanupTrial: cleanup,
    })

    await expect(executeTrialFirstWorkflow(setup.phases)).rejects.toThrow('restore failed')

    expect(cleanup).toHaveBeenCalledOnce()
    expect(setup.calls).not.toContain('stopProduction')
  })

  it('restarts the unchanged production container after a post-stop pre-migration failure', async () => {
    const restart = vi.fn(async () => undefined)
    const setup = phases({
      backupProduction: async () => {
        throw new Error('backup failed')
      },
      restartUnchangedProduction: restart,
    })

    await expect(executeTrialFirstWorkflow(setup.phases)).rejects.toThrow('backup failed')

    expect(restart).toHaveBeenCalledOnce()
    expect(setup.calls).not.toContain('migrateProduction')
  })

  it('attempts to restart when stopping production itself reports failure', async () => {
    const restart = vi.fn(async () => undefined)
    const setup = phases({
      stopProduction: async () => {
        throw new Error('stop reported failure')
      },
      restartUnchangedProduction: restart,
    })

    await expect(executeTrialFirstWorkflow(setup.phases)).rejects.toThrow('stop reported failure')

    expect(restart).toHaveBeenCalledOnce()
  })

  it('never restarts an old container after the migration command succeeds', async () => {
    const restart = vi.fn(async () => undefined)
    const setup = phases({
      verifyMigratedProduction: async () => {
        throw new Error('post-migration verification failed')
      },
      restartUnchangedProduction: restart,
    })

    await expect(executeTrialFirstWorkflow(setup.phases)).rejects.toThrow('post-migration verification failed')

    expect(restart).not.toHaveBeenCalled()
  })

  it('never restarts an old container after migration has been attempted', async () => {
    const restart = vi.fn(async () => undefined)
    const setup = phases({
      migrateProduction: async () => {
        throw new Error('migration exited ambiguously')
      },
      restartUnchangedProduction: restart,
    })

    await expect(executeTrialFirstWorkflow(setup.phases)).rejects.toThrow('migration exited ambiguously')

    expect(restart).not.toHaveBeenCalled()
  })

  it('reports trial cleanup failure alongside the original failure', async () => {
    const setup = phases({
      verifyTrial: async () => {
        throw new Error('verification failed')
      },
      cleanupTrial: async () => {
        throw new Error('drop failed')
      },
    })

    await expect(executeTrialFirstWorkflow(setup.phases)).rejects.toThrow(
      'verification failed; disposable trial cleanup also failed: drop failed',
    )
  })

  it('orders the production backup before migration and deployment', async () => {
    const setup = phases()

    await expect(executeTrialFirstWorkflow(setup.phases)).resolves.toEqual({
      trialCreated: true,
      productionStopped: true,
      productionMigrationAttempted: true,
    })

    expect(setup.calls).toEqual([
      'preflight',
      'buildCandidate',
      'dumpTrialSeed',
      'createTrial',
      'restoreTrial',
      'migrateTrial',
      'verifyTrial',
      'prepareClients',
      'stopProduction',
      'verifyNoProductionWriters',
      'backupProduction',
      'migrateProduction',
      'verifyMigratedProduction',
      'promoteCandidate',
      'deployRuntime',
      'activateClients',
      'verifyDeployment',
      'cleanupTrial',
    ])
  })

  it('removes a newly-created OpenCode loader when activation has no previous loader', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'istra-loader-test-'))
    const loader = join(directory, 'istra.js')
    const previous = join(directory, 'istra.js.previous')
    try {
      await writeFile(loader, 'new loader')

      await restoreOpenCodeLoader(loader, previous, false)

      await expect(readFile(loader, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('restores the previous OpenCode loader when one existed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'istra-loader-test-'))
    const loader = join(directory, 'istra.js')
    const previous = join(directory, 'istra.js.previous')
    try {
      await writeFile(loader, 'new loader')
      await writeFile(previous, 'old loader')

      await restoreOpenCodeLoader(loader, previous, true)

      await expect(readFile(loader, 'utf8')).resolves.toBe('old loader')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
