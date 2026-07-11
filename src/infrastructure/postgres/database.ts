import { AsyncLocalStorage } from 'node:async_hooks'
import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from 'pg'
import { latestPostgresSchemaVersion, postgresMigrations } from './migrations.js'

const migrationLockId = '5283936332345650'

export interface PostgresConnectionOptions {
  connectionString: string
  max?: number
  idleTimeoutMillis?: number
  connectionTimeoutMillis?: number
  statementTimeoutMillis?: number
  applicationName?: string
  ssl?: PoolConfig['ssl']
  migrate?: boolean
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
}

export interface PostgresHealth {
  ready: boolean
  schemaVersion: number
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
    return result
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
    const active = this.transactions.getStore()?.client
    if (active) return work(active)
    const client = await this.pool.connect()
    try {
      return await work(client)
    } finally {
      client.release()
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
        await this.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        await this.query(`RELEASE SAVEPOINT ${savepoint}`)
        throw error
      }
    }

    const client = await this.pool.connect()
    try {
      await client.query(beginStatement(options))
      return await this.transactions.run({ client, nextSavepoint: 0, queryTail: Promise.resolve() }, async () => {
        try {
          const result = await work(this)
          await this.query('COMMIT')
          return result
        } catch (error) {
          await this.query('ROLLBACK')
          throw error
        }
      })
    } finally {
      client.release()
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
      await client.query('ROLLBACK')
      throw error
    }
  })
}

export class PostgresDatabase {
  readonly executor: PostgresExecutor
  readonly target: string
  private closed = false

  constructor(readonly pool: Pool, target: string) {
    this.executor = new PostgresExecutor(pool)
    this.target = target
  }

  async healthCheck(): Promise<PostgresHealth> {
    try {
      const row = await this.executor.one<{ version: number }>(
        'SELECT COALESCE(MAX(version),0)::integer AS version FROM schema_migrations',
      )
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
  parsePostgresUrl(options.connectionString)
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 4,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    statement_timeout: options.statementTimeoutMillis ?? 30_000,
    application_name: options.applicationName ?? 'istra',
    ssl: options.ssl,
  })
  // An idle client error should make the next health check fail, not terminate
  // the process through EventEmitter's special unhandled `error` behaviour.
  pool.on('error', () => undefined)
  const database = new PostgresDatabase(pool, redactPostgresTarget(options.connectionString))
  try {
    if (options.migrate !== false) await migratePostgres(database.executor)
    return database
  } catch (error) {
    await database.close()
    throw error
  }
}
