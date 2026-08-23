import { AsyncLocalStorage } from 'node:async_hooks'
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
} from 'pg'
import { latestPostgresSchemaVersion, postgresMigrations } from './migrations.js'

const migrationLockId = '5283936332345650'
const defaultConnectionTimeoutMillis = 2_000
const defaultIdleTimeoutMillis = 30_000
const defaultKeepAliveInitialDelayMillis = 10_000
const defaultMaxLifetimeSeconds = 300
const defaultReadinessTimeoutMillis = 2_000
const defaultStatementTimeoutMillis = 30_000
const protectedConnectionParameters = new Set([
  'application_name',
  'connectionTimeoutMillis',
  'idle_in_transaction_session_timeout',
  'keepAlive',
  'keepAliveInitialDelayMillis',
  'query_timeout',
  'statement_timeout',
])
const protectedStartupOptionNames = [
  'application_name',
  'idle_in_transaction_session_timeout',
  'statement_timeout',
]

export interface PostgresPoolDiagnostics {
  totalCount: number
  idleCount: number
  waitingCount: number
}

export interface PostgresConnectionOptions {
  connectionString: string
  max?: number
  idleTimeoutMillis?: number
  connectionTimeoutMillis?: number
  statementTimeoutMillis?: number
  queryTimeoutMillis?: number
  readinessTimeoutMillis?: number
  keepAliveInitialDelayMillis?: number
  maxLifetimeSeconds?: number
  idleInTransactionSessionTimeoutMillis?: number
  applicationName?: string
  ssl?: PoolConfig['ssl']
  migrate?: boolean
  onPoolError?: (error: Error, diagnostics: PostgresPoolDiagnostics) => void
}

export interface PostgresTransactionOptions {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable'
  readOnly?: boolean
  deferrable?: boolean
}

interface TransactionState {
  client: PoolClient
  nextSavepoint: number
  queryTail: Promise<void>
  destroyClient: boolean
}

export interface PostgresHealth {
  ready: boolean
  schemaVersion: number
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

export function isPostgresConnectionFailure(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(isPostgresConnectionFailure)
  const code = errorCode(error)
  if (code?.startsWith('08')) return true
  if (code && ['57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return true
  if (!(error instanceof Error)) return false
  return error.message === 'Query read timeout'
    || /connection (?:terminated|closed|ended) unexpectedly/i.test(error.message)
    || /server closed the connection unexpectedly/i.test(error.message)
}

function aggregateRollbackFailure(error: unknown, rollbackError: unknown): AggregateError {
  return new AggregateError([error, rollbackError], 'PostgreSQL operation failed and its rollback did not complete')
}

export function postgresPoolConfig(options: PostgresConnectionOptions): PoolConfig {
  const parsed = parsePostgresUrl(options.connectionString)
  const conflictingParameters = [...parsed.searchParams.keys()]
    .filter((parameter) => protectedConnectionParameters.has(parameter))
  const startupOptions = parsed.searchParams.get('options')?.toLowerCase()
  if (startupOptions && protectedStartupOptionNames.some((parameter) => startupOptions.includes(parameter))) {
    conflictingParameters.push('options')
  }
  if (conflictingParameters.length > 0) {
    throw new Error(`ISTRA_DATABASE_URL must not override managed PostgreSQL parameters: ${conflictingParameters.join(', ')}`)
  }
  const statementTimeoutMillis = options.statementTimeoutMillis ?? defaultStatementTimeoutMillis
  return {
    connectionString: options.connectionString,
    max: options.max ?? 4,
    idleTimeoutMillis: options.idleTimeoutMillis ?? defaultIdleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? defaultConnectionTimeoutMillis,
    keepAlive: true,
    keepAliveInitialDelayMillis: options.keepAliveInitialDelayMillis ?? defaultKeepAliveInitialDelayMillis,
    maxLifetimeSeconds: options.maxLifetimeSeconds ?? defaultMaxLifetimeSeconds,
    statement_timeout: statementTimeoutMillis,
    query_timeout: options.queryTimeoutMillis ?? statementTimeoutMillis + 5_000,
    idle_in_transaction_session_timeout: options.idleInTransactionSessionTimeoutMillis ?? statementTimeoutMillis,
    application_name: options.applicationName ?? 'istra',
    ssl: options.ssl,
  }
}

function poolDiagnostics(pool: Pool): PostgresPoolDiagnostics {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  }
}

function reportPoolError(error: Error, diagnostics: PostgresPoolDiagnostics): void {
  const code = errorCode(error)
  process.stderr.write(`${JSON.stringify({
    level: 'warn',
    message: 'PostgreSQL idle pool client failed and was evicted',
    ...(code ? { code } : {}),
    pool: diagnostics,
  })}\n`)
}

function parsePostgresUrl(connectionString: string): URL {
  let parsed: URL
  try {
    parsed = new URL(connectionString)
  } catch {
    throw new Error('ISTRA_DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('ISTRA_DATABASE_URL must be a valid PostgreSQL URL')
  }
  return parsed
}

export function redactPostgresTarget(connectionString: string): string {
  const parsed = parsePostgresUrl(connectionString)
  const database = parsed.pathname === '/' ? '' : parsed.pathname
  return `${parsed.protocol}//${parsed.host}${database}`
}

function beginStatement(options: PostgresTransactionOptions): string {
  if (options.deferrable && (!options.readOnly || options.isolationLevel !== 'serializable')) {
    throw new Error('Deferrable PostgreSQL transactions must be serializable and read-only')
  }
  const isolation = options.isolationLevel?.toUpperCase() ?? 'READ COMMITTED'
  return [
    `BEGIN ISOLATION LEVEL ${isolation}`,
    options.readOnly ? 'READ ONLY' : 'READ WRITE',
    options.deferrable ? 'DEFERRABLE' : 'NOT DEFERRABLE',
  ].join(' ')
}

/**
 * Shared query/transaction entry point for both PostgreSQL repositories.
 * AsyncLocalStorage ensures every nested repository call uses the same
 * transaction-scoped PoolClient.
 */
export class PostgresExecutor {
  private readonly transactions = new AsyncLocalStorage<TransactionState>()

  constructor(readonly pool: Pool) {}

  get inTransaction(): boolean {
    return this.transactions.getStore() !== undefined
  }

  get transactionClient(): PoolClient | null {
    return this.transactions.getStore()?.client ?? null
  }

  async query<Row extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    const transaction = this.transactions.getStore()
    if (!transaction) return this.pool.query<Row>(text, [...values])

    const result = transaction.queryTail.then(() => transaction.client.query<Row>(text, [...values]))
    transaction.queryTail = result.then(() => undefined, () => undefined)
    try {
      return await result
    } catch (error) {
      if (isPostgresConnectionFailure(error)) transaction.destroyClient = true
      throw error
    }
  }

  async many<Row extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<Row[]> {
    return (await this.query<Row>(text, values)).rows
  }

  async maybeOne<Row extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<Row | null> {
    const result = await this.query<Row>(text, values)
    if (result.rows.length > 1) throw new Error('Expected at most one PostgreSQL row')
    return result.rows[0] ?? null
  }

  async one<Row extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<Row> {
    const result = await this.query<Row>(text, values)
    if (result.rows.length !== 1) throw new Error('Expected exactly one PostgreSQL row')
    return result.rows[0]!
  }

  async execute(text: string, values: readonly unknown[] = []): Promise<number> {
    const result = await this.query(text, values)
    return result.rowCount ?? result.rows.length
  }

  async withConnection<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const transaction = this.transactions.getStore()
    if (transaction) {
      try {
        return await work(transaction.client)
      } catch (error) {
        if (isPostgresConnectionFailure(error)) transaction.destroyClient = true
        throw error
      }
    }
    const client = await this.pool.connect()
    let destroyClient = false
    try {
      return await work(client)
    } catch (error) {
      destroyClient = isPostgresConnectionFailure(error)
      throw error
    } finally {
      client.release(destroyClient)
    }
  }

  async transaction<T>(work: (executor: PostgresExecutor) => Promise<T>, options: PostgresTransactionOptions = {}): Promise<T> {
    const active = this.transactions.getStore()
    if (active) {
      const savepoint = `istra_${++active.nextSavepoint}`
      await this.query(`SAVEPOINT ${savepoint}`)
      try {
        const result = await work(this)
        await this.query(`RELEASE SAVEPOINT ${savepoint}`)
        return result
      } catch (error) {
        if (active.destroyClient) throw error
        try {
          await this.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          await this.query(`RELEASE SAVEPOINT ${savepoint}`)
        } catch (rollbackError) {
          active.destroyClient = true
          throw aggregateRollbackFailure(error, rollbackError)
        }
        throw error
      }
    }

    const client = await this.pool.connect()
    const state: TransactionState = { client, nextSavepoint: 0, queryTail: Promise.resolve(), destroyClient: false }
    try {
      await client.query(beginStatement(options))
      return await this.transactions.run(state, async () => {
        try {
          const result = await work(this)
          await this.query('COMMIT')
          return result
        } catch (error) {
          if (state.destroyClient) throw error
          try {
            await this.query('ROLLBACK')
          } catch (rollbackError) {
            state.destroyClient = true
            throw aggregateRollbackFailure(error, rollbackError)
          }
          throw error
        }
      })
    } catch (error) {
      if (isPostgresConnectionFailure(error)) state.destroyClient = true
      throw error
    } finally {
      client.release(state.destroyClient)
    }
  }
}

interface MigrationRow extends QueryResultRow {
  version: number
  name: string
}

function assertCompatibleMigrationHistory(applied: MigrationRow[]): void {
  for (const [index, migration] of applied.entries()) {
    const expected = postgresMigrations[index]
    if (!expected || migration.version !== expected.version || migration.name !== expected.name) {
      throw new Error('PostgreSQL database uses an incompatible Istra migration history')
    }
  }
}

export async function migratePostgres(executor: PostgresExecutor): Promise<number> {
  return executor.withConnection(async (client) => {
    await client.query('BEGIN')
    try {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [migrationLockId])
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL
        )
      `)
      const applied = (await client.query<MigrationRow>('SELECT version,name FROM schema_migrations ORDER BY version')).rows
      assertCompatibleMigrationHistory(applied)
      for (const migration of postgresMigrations.slice(applied.length)) {
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO schema_migrations(version,name,applied_at) VALUES ($1,$2,$3)',
          [migration.version, migration.name, new Date().toISOString()],
        )
      }
      await client.query('COMMIT')
      return latestPostgresSchemaVersion
    } catch (error) {
      if (isPostgresConnectionFailure(error)) throw error
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        throw aggregateRollbackFailure(error, rollbackError)
      }
      throw error
    }
  })
}

export class PostgresDatabase {
  readonly executor: PostgresExecutor
  readonly target: string
  private closed = false

  constructor(readonly pool: Pool, target: string, private readonly readinessTimeoutMillis = defaultReadinessTimeoutMillis) {
    this.executor = new PostgresExecutor(pool)
    this.target = target
  }

  async healthCheck(): Promise<PostgresHealth> {
    try {
      const query: QueryConfig & { query_timeout: number } = {
        text: 'SELECT COALESCE(MAX(version),0)::integer AS version FROM schema_migrations',
        query_timeout: this.readinessTimeoutMillis,
      }
      const result = await this.pool.query<{ version: number }>(query)
      const row = result.rows[0]
      if (!row || result.rows.length !== 1) throw new Error('Expected exactly one PostgreSQL schema version row')
      return { ready: true, schemaVersion: Number(row.version) }
    } catch {
      return { ready: false, schemaVersion: 0 }
    }
  }

  async schemaVersion(): Promise<number> {
    const row = await this.executor.one<{ version: number }>(
      'SELECT COALESCE(MAX(version),0)::integer AS version FROM schema_migrations',
    )
    return Number(row.version)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end()
  }
}

export async function openPostgresDatabase(options: PostgresConnectionOptions): Promise<PostgresDatabase> {
  const pool = new Pool(postgresPoolConfig(options))
  // Observe idle-client errors so EventEmitter does not terminate the process;
  // pg-pool has already evicted the failed client when this event is emitted.
  pool.on('error', (error) => (options.onPoolError ?? reportPoolError)(error, poolDiagnostics(pool)))
  const database = new PostgresDatabase(
    pool,
    redactPostgresTarget(options.connectionString),
    options.readinessTimeoutMillis ?? defaultReadinessTimeoutMillis,
  )
  try {
    if (options.migrate !== false) await migratePostgres(database.executor)
    return database
  } catch (error) {
    await database.close()
    throw error
  }
}
