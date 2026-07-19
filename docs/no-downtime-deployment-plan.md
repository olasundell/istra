# No-downtime deployment plan

Status: deferred architecture plan. The current supported path remains the guarded maintenance-window deployment in `scripts/deploy-production.ts`.

## Goal

Allow future Istra web/API releases to be deployed without connection failures or rejected requests while preserving the disposable PostgreSQL trial, exact-image verification, safe rollback boundaries and local-only security model.

Availability has three separate meanings:

1. The web/API remains reachable throughout the deployment.
2. PostgreSQL remains safe for compatible readers and writers while its schema changes.
3. Existing MCP tasks remain usable until they finish, even though they cannot acquire new tools without a restart or new task.

The third point is deliberately not a promise that a running Codex or OpenCode task will hot-load a new MCP package. The current client registries do not support that.

## Current position

The present deployment is not no-downtime:

- Compose runs one `istra` application service on the only host binding for port 4317.
- The deployment stops that service, requires every other PostgreSQL connection to close, takes and verifies a final backup, migrates production and force-recreates the application.
- Application and MCP runtimes automatically run migrations during startup.
- Migration history is exact for each binary, so an older binary cannot restart after a newer schema version has been recorded.
- PostgreSQL v4/v5 currently run in one transaction, including index and trigger replacement that is not designed for concurrent writers.
- Codex and OpenCode MCP processes connect directly to PostgreSQL, and installed package changes do not alter an already-running task's tool registry.

The existing maintenance-window deployment is the low-risk choice for the current release. The first transition from the single application port to a proxy-owned port will also need a short planned cutover. The phases below make later web/API releases no-downtime.

## Target architecture

```text
                         +------------------+
127.0.0.1:4317 --------> | loopback proxy   |
                         +--------+---------+
                                  |
                         active upstream only
                          /                 \
                 +-------+------+   +------+-------+
                 | Istra blue   |   | Istra green  |
                 | immutable    |   | immutable    |
                 +-------+------+   +------+-------+
                          \                 /
                           +-------+-------+
                                   |
                          +--------+---------+
                          | PostgreSQL       |
                          | compatible schema|
                          +------------------+
```

The proxy owns the stable host port. Blue and green are distinct internal services with immutable image tags and no host ports. Only a healthy instance becomes active. The inactive instance remains available for a fast traffic rollback until the release is accepted.

## Phase 1: compatibility bridge

Separate schema management from normal process startup before introducing concurrent application versions.

- Add an explicit migration mode used only by deployment and administrative commands.
- Start the web server and MCP runtime with automatic migration disabled.
- Define a supported schema range for each runtime, for example `minimumSchemaVersion` and `maximumSchemaVersion`.
- Make readiness fail when the database falls outside that range.
- Produce a bridge runtime that can serve the current production schema and the expanded automation schema.
- Keep new automation entry points disabled until the expanded schema is present.
- Add a compatibility test matrix covering the bridge and candidate runtimes against every schema version they claim to support.

Acceptance:

- Starting either normal runtime never changes schema state.
- The bridge runtime serves both the pre-expansion and post-expansion schemas.
- Unsupported old and future schemas fail readiness with a credential-free diagnostic.
- A migration command remains protected by the existing advisory lock and deployment target checks.

Trade-off: explicit schema compatibility and a separate migration path add release discipline and tests, but remove hidden database mutation from every application and MCP startup.

## Phase 2: online expand/contract migrations

Make every migration safe for a period in which old and new runtimes coexist.

Before PostgreSQL v4/v5 reaches production:

- Put the final `automation_queue_changes(queue_id, sequence DESC)` index definition directly in v4.
- Remove the v5 drop/recreate of that index.
- Keep the existing state-change trigger and add blocker-change behaviour without dropping a trigger used by the old runtime.
- Treat new tables, functions and triggers as expansion only; do not rename or remove anything read by the old runtime.
- Apply bounded `lock_timeout` and `statement_timeout` values, and retry rather than waiting indefinitely for a conflicting lock.

For later migrations:

- Split transactional migrations from operations such as `CREATE INDEX CONCURRENTLY` that PostgreSQL forbids inside a transaction.
- Version trigger functions or add parallel triggers during expansion.
- Deploy code that can read both representations before changing write behaviour.
- Perform destructive contraction only after the previous application and MCP versions have drained and rollback to them is no longer required.

Acceptance:

- Continuous read/write probes succeed while each expansion migration runs against a production-sized disposable database.
- Lock-conflict tests prove a migration aborts safely instead of blocking application writes beyond the agreed bound.
- Both blue and green pass storage readiness and repository contracts on the expanded schema.
- Reverting traffic to blue requires no database restore.

Trade-off: expand/contract keeps application rollback cheap, but schema removal becomes a later release step and temporarily retains duplicate structures.

## Phase 3: blue/green Compose topology

- Add a loopback-only reverse-proxy service that owns host port 4317.
- Replace the single application service with distinct blue and green services on the private Compose network.
- Give each slot an immutable image reference and identical PostgreSQL, volume, security and health configuration.
- Validate a proposed proxy configuration before atomically reloading it.
- Stop accepting new traffic on the old slot, allow Fastify's graceful shutdown to drain requests, then stop that slot.
- Keep PostgreSQL single-primary; blue/green applies to stateless application processes, not the database.

Bootstrap acceptance:

- The one-time port handover is rehearsed against a duplicate environment and has a measured maintenance window and rollback command.
- After bootstrap, either slot can be started, health-checked, selected and drained without rebinding the host port.
- Proxy failure leaves the last valid upstream configuration active.

Trade-off: the proxy and second application slot consume more resources and add an operational component, but isolate traffic switching from container replacement. This is justified only if continuous local availability matters more than the simpler single-user topology.

## Phase 4: extend the guarded deploy script

Preserve the current trial-first gates and replace only the production cutover sequence:

1. Validate source, tools, exact Compose identity and the clean working tree.
2. Build the immutable candidate and retain the currently active image for rollback.
3. Clone production into the generated disposable trial database.
4. Migrate and verify the trial, run PostgreSQL tests, and smoke-test the exact candidate image.
5. Prepare Codex and OpenCode packages without activating them.
6. Apply only the online expansion migration to production while blue remains active.
7. Start green against production without automatic migration and require readiness, storage and automation-safety checks.
8. Atomically switch the proxy to green while continuously probing reads and writes.
9. Drain blue, activate packages for future client sessions and retain blue during the acceptance period.
10. Contract the schema in a later deployment after the rollback window closes.

Failure handling:

- Before production expansion, clean up the trial and leave production untouched.
- After compatible expansion but before the traffic switch, stop green and leave blue active.
- After the traffic switch, switch back to blue while the schema remains compatible.
- Never restore a database merely to roll back compatible application code.
- If an incompatible write has occurred, stop automatic rollback and require an explicit recovery decision.

## Phase 5: MCP client continuity

Use gradual draining first:

- Keep existing direct-database MCP processes running on the bridge-compatible schema.
- Activate the new package for new Codex tasks and restarted OpenCode sessions.
- Let old tasks finish naturally, then prove that no old package retains a PostgreSQL pool before schema contraction.
- Report clearly that existing tasks remain on the old tool set until restarted.

A later option is to make stdio MCP packages thin clients of the stable local HTTP service. That would centralise database access and simplify future cutovers, but it would also make every MCP task dependent on the API and introduce a larger architectural change. It is not required for the first no-downtime web/API release.

## Phase 6: backup and recovery guarantee

An online `pg_dump` is a consistent snapshot, but it cannot by itself provide a no-data-loss rollback for writes committed after that snapshot.

- Keep the disposable trial and verified custom-format dump for migration rehearsal and disaster recovery.
- If no-data-loss database rollback is required, add PostgreSQL WAL archiving and point-in-time recovery to a separate durable location.
- Rehearse restoration into a newly named disposable database and verify schema, project count, checkpoint digests and candidate/rollback runtime compatibility.
- Do not advertise no-data-loss rollback until the WAL restore drill has passed.

Trade-off: WAL/PITR increases storage and operator complexity. It is independent of zero HTTP downtime and should be required only when the stronger recovery guarantee is wanted.

## Verification and release gates

No-downtime is accepted only with observed evidence, not only configuration inspection:

- Poll `/api/v1/ready`, representative reads and an idempotent write throughout migration and cutover; record zero connection failures and zero unexpected non-success responses.
- Keep a long-poll queue-feed request active across the proxy switch and verify bounded reconnection/cursor recovery.
- Exercise concurrent writes while expansion migrations run.
- Kill green before switch, during switch and after switch; prove the documented rollback boundary each time.
- Keep an old MCP task active through expansion and traffic switch, then verify a new task receives the new package.
- Restore the backup/PITR artefact into the disposable trial database and verify it independently.
- Run the full typecheck, default suite, PostgreSQL suite, deployment contract, plugin tests and browser journeys.
- Rehearse the exact production script against an isolated duplicate Compose project before the first live blue/green deployment.

## Deferred decisions

- Whether continuous availability is valuable enough for this single-user local service to justify a permanent proxy and second application slot.
- Which loopback proxy to standardise on and how its active-upstream file is atomically managed.
- Whether database recovery needs ordinary verified backups or the stronger WAL/PITR guarantee.
- Whether MCP should remain a direct-database client or eventually become a thin HTTP client.

Until these decisions are made and the phases are implemented and verified, `pnpm deploy:production -- --apply` must continue to be treated as a maintenance-window operation.
