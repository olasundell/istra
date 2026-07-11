// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { ValidationError } from '../../application/errors.js'
import type { PostgresExecutor } from './database.js'
import { PostgresOperationalRepository } from './operational-repository.js'

function repositoryWith(overrides: Record<string, unknown> = {}) {
  const executor = {
    many: vi.fn(async (_sql: string, _values: readonly unknown[] = []) => []),
    maybeOne: vi.fn(async () => null),
    one: vi.fn(async () => ({})),
    execute: vi.fn(async () => 1),
    transaction: vi.fn(async (work: (executor: unknown) => Promise<unknown>) => work(executor)),
    ...overrides,
  }
  return { executor, repository: new PostgresOperationalRepository(executor as unknown as PostgresExecutor) }
}

describe('PostgreSQL operational repository', () => {
  it('applies entity-specific search filters before the limit', async () => {
    const { executor, repository } = repositoryWith()

    await repository.search('marker', 17, {
      projectId: '00000000-0000-4000-8000-000000000001',
      entityTypes: ['requirement'],
      state: 'partial',
      phaseId: '00000000-0000-4000-8000-000000000002',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-12-31T23:59:59.000Z',
    })

    expect(executor.many).toHaveBeenCalledTimes(1)
    const [sql, values] = executor.many.mock.calls[0]!
    expect(sql).toEqual(expect.stringContaining("si.entity_type='requirement'"))
    expect(sql).toEqual(expect.stringContaining('s.semantic='))
    expect(sql).toEqual(expect.stringContaining('requirement_phase_links'))
    expect(sql).toEqual(expect.stringContaining('r.created_at>='))
    expect(sql).toEqual(expect.stringContaining('r.created_at<='))
    expect(values).toEqual(expect.arrayContaining(['marker', 'partial', 17]))
  })

  it('rejects evidence links to an update owned by another project', async () => {
    const projectId = '00000000-0000-4000-8000-000000000001'
    const { repository } = repositoryWith({
      maybeOne: vi.fn(async (sql: string) => sql.startsWith('SELECT * FROM projects') ? { id: projectId } : null),
    })

    await expect(repository.createEvidence(projectId, {
      result: 'recorded',
      summary: 'Cross-project link probe',
      updateIds: ['00000000-0000-4000-8000-000000000002'],
    })).rejects.toBeInstanceOf(ValidationError)
  })
})
