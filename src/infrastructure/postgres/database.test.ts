import { Client, type Pool, type PoolClient, type QueryResult } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  isPostgresConnectionFailure,
  migratePostgres,
  PostgresDatabase,
  PostgresExecutor,
  postgresPoolConfig,
} from './database.js'

function result(rows: Record<string, unknown>[] = []): QueryResult {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  }
}

function transactionPool(query: (text: string) => Promise<QueryResult>) {
  const release = vi.fn()
  const client = { query, release } as unknown as PoolClient
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool
  return { client, pool, release }
}

describe('PostgreSQL connection resilience', () => {
  it('enables bounded socket, query and connection lifetimes by default', () => {
    expect(postgresPoolConfig({ connectionString: 'postgresql://istra:secret@postgres/istra' })).toMatchObject({
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      maxLifetimeSeconds: 300,
      statement_timeout: 30_000,
      query_timeout: 35_000,
      idle_in_transaction_session_timeout: 30_000,
      application_name: 'istra',
    })
  })

  it('keeps explicit pool timing overrides deterministic', () => {
    const config = postgresPoolConfig({
      connectionString: 'postgresql://istra:secret@postgres/istra',
      max: 7,
      idleTimeoutMillis: 11,
      connectionTimeoutMillis: 12,
      statementTimeoutMillis: 13,
      queryTimeoutMillis: 14,
      keepAliveInitialDelayMillis: 15,
      maxLifetimeSeconds: 16,
      idleInTransactionSessionTimeoutMillis: 17,
      applicationName: 'resilience-test',
    })
    expect(config).toMatchObject({
      max: 7,
      idleTimeoutMillis: 11,
      connectionTimeoutMillis: 12,
      statement_timeout: 13,
      query_timeout: 14,
      keepAliveInitialDelayMillis: 15,
      maxLifetimeSeconds: 16,
      idle_in_transaction_session_timeout: 17,
      application_name: 'resilience-test',
    })
    const parameters = (new Client(config) as unknown as {
      connectionParameters: Record<string, unknown>
    }).connectionParameters
    expect(parameters).toMatchObject({
      application_name: 'resilience-test',
      statement_timeout: 13,
      query_timeout: 14,
      idle_in_transaction_session_timeout: 17,
      keepalives: 1,
      keepalives_idle: 0,
    })
  })

  it('rejects database URL parameters that could defeat managed resilience settings', () => {
    expect(() => postgresPoolConfig({
      connectionString: 'postgresql://istra:secret@postgres/istra?query_timeout=600000&statement_timeout=0&keepAlive=false&connectionTimeoutMillis=600000&options=-c%20statement_timeout%3D0',
    })).toThrow('must not override managed PostgreSQL parameters: query_timeout, statement_timeout, keepAlive, connectionTimeoutMillis, options')
  })

  it.each([
    Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('connection exception'), { code: '08006' }),
    Object.assign(new Error('database shutting down'), { code: '57P01' }),
    new Error('Query read timeout'),
    new AggregateError([new Error('domain failure'), Object.assign(new Error('broken rollback'), { code: 'EPIPE' })]),
  ])('recognises errors that make a pooled client unsafe to reuse', (error) => {
    expect(isPostgresConnectionFailure(error)).toBe(true)
  })

  it('does not classify ordinary PostgreSQL statement errors as broken connections', () => {
    expect(isPostgresConnectionFailure(Object.assign(new Error('unique violation'), { code: '23505' }))).toBe(false)
    expect(isPostgresConnectionFailure(Object.assign(new Error('statement timeout'), { code: '57014' }))).toBe(false)
  })

  it('destroys a transaction client after a client-side query timeout', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.startsWith('BEGIN')) return result()
      throw new Error('Query read timeout')
    })
    const { pool, release } = transactionPool(query)
    const executor = new PostgresExecutor(pool)

    await expect(executor.transaction(async (transaction) => transaction.query('SELECT pg_sleep(60)')))
      .rejects.toThrow('Query read timeout')

    expect(query.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE NOT DEFERRABLE',
      'SELECT pg_sleep(60)',
    ])
    expect(release).toHaveBeenCalledWith(true)
  })

  it('rolls back domain failures without discarding a healthy transaction client', async () => {
    const query = vi.fn(async (_text: string) => result())
    const { pool, release } = transactionPool(query)
    const executor = new PostgresExecutor(pool)

    await expect(executor.transaction(async () => { throw new Error('domain failure') }))
      .rejects.toThrow('domain failure')

    expect(query.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE NOT DEFERRABLE',
      'ROLLBACK',
    ])
    expect(release).toHaveBeenCalledWith(false)
  })

  it('destroys a client when transaction rollback cannot complete', async () => {
    const query = vi.fn(async (text: string) => {
      if (text === 'ROLLBACK') throw Object.assign(new Error('reset during rollback'), { code: 'ECONNRESET' })
      return result()
    })
    const { pool, release } = transactionPool(query)
    const executor = new PostgresExecutor(pool)

    await expect(executor.transaction(async () => { throw new Error('domain failure') }))
      .rejects.toThrow('rollback did not complete')

    expect(release).toHaveBeenCalledWith(true)
  })

  it('destroys an active transaction client when direct connection work times out', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.startsWith('BEGIN')) return result()
      throw new Error('Query read timeout')
    })
    const { pool, release } = transactionPool(query)
    const executor = new PostgresExecutor(pool)

    await expect(executor.transaction(async (transaction) => transaction.withConnection(
      (client) => client.query('SELECT pg_sleep(60)'),
    ))).rejects.toThrow('Query read timeout')

    expect(query.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE NOT DEFERRABLE',
      'SELECT pg_sleep(60)',
    ])
    expect(release).toHaveBeenCalledWith(true)
  })

  it('does not wait for rollback after a migration connection failure', async () => {
    const query = vi.fn(async (text: string) => {
      if (text === 'BEGIN') return result()
      throw new Error('Query read timeout')
    })
    const { pool, release } = transactionPool(query)
    const executor = new PostgresExecutor(pool)

    await expect(migratePostgres(executor)).rejects.toThrow('Query read timeout')

    expect(query.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1::bigint)',
    ])
    expect(release).toHaveBeenCalledWith(true)
  })

  it('applies a dedicated client deadline to readiness queries', async () => {
    const query = vi.fn(async () => result([{ version: 5 }]))
    const pool = { query } as unknown as Pool
    const database = new PostgresDatabase(pool, 'postgresql://postgres:5432/istra', 1_250)

    await expect(database.healthCheck()).resolves.toEqual({ ready: true, schemaVersion: 5 })
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ query_timeout: 1_250 }))
  })

  it('reports a bounded readiness failure instead of leaking its database error', async () => {
    const query = vi.fn(async () => { throw new Error('Query read timeout') })
    const pool = { query } as unknown as Pool
    const database = new PostgresDatabase(pool, 'postgresql://postgres:5432/istra', 1_250)

    await expect(database.healthCheck()).resolves.toEqual({ ready: false, schemaVersion: 0 })
  })
})
