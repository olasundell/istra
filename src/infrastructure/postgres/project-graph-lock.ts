import type { PostgresExecutor } from './database.js'

/**
 * Serialise graph validation and mutation for one project within the current
 * PostgreSQL transaction. Every project graph uses the same advisory-lock key
 * so cross-repository mutations cannot observe stale, independently validated
 * graph states.
 */
export async function lockProjectGraph(executor: PostgresExecutor, projectId: string): Promise<void> {
  if (!executor.inTransaction) throw new Error('Project graph locks require an active PostgreSQL transaction')
  await executor.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('istra-project-graph:' || $1::text, 0))`,
    [projectId],
  )
}
