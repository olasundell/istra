# Operating Istra

Istra's supported baseline is single-user operation on one machine. SQLite is the zero-configuration default; a Docker Compose PostgreSQL service can provide one shared database for the host-run API, Codex MCP and OpenCode MCP. Neither topology is internet-facing or multi-user: there is no authentication, TLS termination or remote-access security model.

## Choose one data boundary

Every active Istra runtime must select the same backend. Native SQLite works when the API and plugins share the platform data directory. PostgreSQL works when all three use the same shared configuration or matching environment override.

The `istra` Compose service connects to the same Compose PostgreSQL service over the private network. Do not start it during a host-side migration into that database. Do not bind-mount the macOS SQLite database into Docker while host processes also use it; SQLite locks and Istra's PID-based backup lock are not designed to coordinate across the Docker VM and host PID namespaces. Do not scale the Compose application service beyond one replica.

## Start and inspect PostgreSQL

```bash
cp .env.example .env
chmod 600 .env
docker compose up --detach --wait postgres
docker compose ps postgres
```

The service uses `postgres:17-bookworm`, publishes PostgreSQL only on `127.0.0.1:${ISTRA_POSTGRES_PORT:-5433}`, and stores data in `istra-postgres-data`. Set the same private password in `POSTGRES_PASSWORD` and the percent-encoded password portions of both database URLs in the ignored `.env` file before starting it. `ISTRA_DATABASE_URL` uses the host endpoint `127.0.0.1:5433`; `ISTRA_COMPOSE_DATABASE_URL` uses the private service endpoint `postgres:5432`.

To run the PostgreSQL-backed application container:

```bash
docker compose up --build --detach --wait istra
curl --fail http://127.0.0.1:${ISTRA_PORT:-4317}/api/v1/ready
docker compose logs --follow istra
```

Starting `istra` also starts `postgres` and waits for its health check. Verify the selected backend explicitly:

```bash
curl --fail http://127.0.0.1:${ISTRA_PORT:-4317}/api/v1/storage
```

The response must report `"backend":"postgresql"`, `"ready":true` and target `postgresql://postgres:5432/istra` without credentials. The service runs as the unprivileged `node` user, with a read-only root filesystem, no Linux capabilities and two retained writable volumes:

- `istra-data` retains the existing application data mount, but PostgreSQL owns the active database state.
- `istra-backups` retains the existing backup mount; automatic PostgreSQL backups are not yet available.

`docker compose down` removes containers but retains all named volumes. `docker compose down --volumes` permanently removes the PostgreSQL database and both retained application volumes.

If the configured host port is already used by a native Istra server, choose another one in `.env` (for example `ISTRA_PORT=14317`) before starting Compose. Confirm the mapping with `docker compose ps`; do not assume a reported healthy container means a colliding host port reaches that container on every Docker implementation.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ISTRA_PORT` | `4317` | Host loopback port used by Compose. |
| `ISTRA_POSTGRES_PORT` | `5433` | Host loopback port for the Compose PostgreSQL service. |
| `POSTGRES_DB` | `istra` | Database created by the PostgreSQL image. |
| `POSTGRES_USER` | `istra` | PostgreSQL role created by the image. |
| `POSTGRES_PASSWORD` | none | Required local PostgreSQL password, stored only in ignored `.env`. |
| `ISTRA_STORAGE` | `sqlite` | Runtime backend override: `sqlite` or `postgresql`. |
| `ISTRA_DATABASE_URL` | none | Host PostgreSQL connection URL; implies PostgreSQL when set. |
| `ISTRA_COMPOSE_DATABASE_URL` | derived from Compose PostgreSQL variables | Container-only PostgreSQL URL using `postgres:5432`. |
| `ISTRA_POSTGRES_POOL_MAX` | `4` | Maximum connections in each Istra runtime's PostgreSQL pool. |
| `ISTRA_CONFIG_PATH` | `<data-dir>/config.json` | Optional path to the shared storage selection. |
| `PORT` | `4317` | HTTP port inside the process. |
| `ISTRA_HOST` | `127.0.0.1` natively, `0.0.0.0` in the image | Listen address. Only the container should need `0.0.0.0`. |
| `ISTRA_LOG_LEVEL` | `info` | Fastify/Pino log level. |
| `ISTRA_DATA_DIR` | platform data directory natively, `/var/lib/istra` in the image | Database directory. |
| `ISTRA_BACKUP_DIR` | `<data-dir>/backups` natively, `/var/backups/istra` in the image | SQLite snapshot directory. |
| `ISTRA_STATIC_DIR` | `dist-web` | Built web application directory. |

Explicit runtime options take precedence over environment variables, which take precedence over the shared config file; SQLite remains the fallback. PostgreSQL requires a valid `postgres:` or `postgresql:` URL. The shared config is written with mode `0600`, and status responses redact credentials. Invalid storage, port, log-level and listen-address settings fail at startup. Compose publishes both service ports only through `127.0.0.1` on the host.

## Migrate local SQLite to PostgreSQL

Build and verify the PostgreSQL-capable runtime before the maintenance window. Then update the SQLite-backed Istra requirement and work item that track the cutover. Stop every writer before copying: the native API/watch process, Codex MCP children, OpenCode MCP children and any `istra` application container.

```bash
docker compose stop istra
lsof -nP "$HOME/Library/Application Support/Istra/istra.sqlite3"
```

Inspect every process reported by `lsof`, terminate only verified Istra processes, and repeat until the command reports no owners. Do not invoke an old MCP runtime during the cutover window.

Start PostgreSQL without starting the application, then migrate:

```bash
docker compose up --detach --wait postgres
set -a
. ./.env
set +a
pnpm storage:migrate:postgres
pnpm storage:status
```

The migration refuses a non-empty PostgreSQL target, takes a pre-cutover SQLite snapshot, copies the portable state transactionally, verifies canonical tables, entity counts, checkpoint digests and representative filtered searches, and only then writes the shared PostgreSQL selection. If copy or verification fails, imported target rows are cleared and the shared selection remains SQLite. Never print `config.json`; it contains the connection URL.

Rebuild and reinstall the self-contained Codex and OpenCode packages, then restart the host API and every MCP runtime. Verify `GET /api/v1/storage` and MCP `get_storage_status` report PostgreSQL. Re-run `lsof` on the SQLite file after each client restarts; any owner means the cutover is incomplete. A Codex plugin installed on disk may still require a new or reloaded task before the live tool registry changes.

Keep the closed SQLite database and its backups unchanged as rollback artefacts. To roll back, atomically select SQLite in the shared configuration, restart the API and every MCP runtime, verify storage status from each client, and confirm PostgreSQL has no remaining writers. Never run SQLite and PostgreSQL as dual writers.

## Trial-first PostgreSQL deployment

Use the guarded deployment command for upgrades of the PostgreSQL-backed Compose application. It defaults to a read-only dry run and refuses apply mode unless all of the following are true:

- `ISTRA_DATABASE_URL` identifies a loopback PostgreSQL database with a non-default name.
- `--confirm-target` is the exact same credential-free URL, including host, port and database.
- The Git working tree is completely clean and `pnpm check` leaves it clean.
- The resolved Compose application and PostgreSQL service target that same database.
- The existing `istra:local` image is available to tag for rollback.
- The configured Codex marketplace source is the expected local Istra package.
- PostgreSQL client tools, Docker, pnpm, Codex, OpenCode and the Codex cachebuster helper are already installed. The deployment does not download helper dependencies.

The command reads the pinned ignored `.env` with Node's built-in environment-file parser. It does not source or execute the file as shell code. The file must be a regular non-symlink owned by the deployment user and inaccessible to group/other users. Choose a private backup directory outside and non-nested with the checkout, then inspect the plan:

```bash
mkdir -p "$HOME/Library/Application Support/Istra/postgres-backups"
chmod 700 "$HOME/Library/Application Support/Istra/postgres-backups"
pnpm deploy:production -- \
  --env-file "$PWD/.env" \
  --confirm-target postgresql://127.0.0.1:5433/istra \
  --backup-dir "$HOME/Library/Application Support/Istra/postgres-backups"
```

The dry run reads and validates the pinned environment, validates the supplied values, and prints only credential-free targets. It does not run external commands, connect to a database, write files, build an image or change a runtime. Review the generated trial database name and order before opening the maintenance window.

Run apply mode from a normal terminal, not from an active Codex or OpenCode task. Stop native Istra API processes and close Codex/OpenCode tasks that may own PostgreSQL pools; the script stops the Compose application itself and then refuses to continue if any connection remains:

```bash
pnpm deploy:production -- \
  --apply \
  --env-file "$PWD/.env" \
  --confirm-target postgresql://127.0.0.1:5433/istra \
  --backup-dir "$HOME/Library/Application Support/Istra/postgres-backups"
```

Apply mode performs these gates in order:

1. It verifies source, tools and resolved Compose configuration, tags the existing image as `istra:rollback-<deployment-id>`, and builds `istra:candidate-<deployment-id>`. Building the candidate does not move the live `istra:local` tag.
2. It takes a consistent custom-format production dump, restores it into a generated `<production>_istra_trial_<deployment-id>` database, applies the current migrations and checks storage status, row counts and disabled automation policies there.
3. It runs the PostgreSQL integration suite against isolated schemas inside the trial database. It then runs the exact candidate image against the migrated trial database through the PostgreSQL container's network namespace and requires the expected ready schema and trial target.
4. It prepares immutable Codex and OpenCode packages without activating them. Package tests already passed in `pnpm check`; staged manifests, Node syntax and installed SHA-256 hashes are checked again during activation.
5. Only after all trial gates pass does it stop the Compose application. It requires zero other database connections, rechecks the exact database identity and original project count, and creates a mode-`0600` custom-format production backup. `pg_restore --list` and a retained SHA-256 sidecar must succeed before migration.
6. It migrates production, verifies the new schema and confirms every queue remains automation-disabled. It then promotes the candidate image to `istra:local`, force-recreates the application without rebuilding, and verifies `/api/v1/ready` and `/api/v1/storage`.
7. It atomically refreshes the local Codex marketplace package and the immutable OpenCode package/loader. If OpenCode activation fails after Codex activation, both loaders are restored to their previous packages. The generated trial database is force-dropped in the final cleanup path.

The script never includes a password or database URL in its progress/error output or Docker command arguments. Secrets are passed through bounded child-process environments. A deployment lock under the backup directory prevents concurrent runs. If a process is killed so abruptly that the lock remains, first prove that no deployment process or generated trial database is still active, then remove only that exact `.istra-deploy.lock` directory.

After success, restart OpenCode and start a new Codex task. Installed files cannot update the MCP registry of an already-running task. Keep the reported PostgreSQL backup, SHA-256 sidecar, rollback image, previous Codex source directory and previous OpenCode loader until the deployment has been used successfully.

### Failure boundaries and rollback

If trial creation, migration, tests or candidate-image smoke fails, the script drops the generated trial database and never stops, backs up or migrates production. The only retained Docker changes are the rollback and candidate image tags; the running container and `istra:local` tag remain unchanged.

If a failure occurs after the application stop is attempted but before the production migration is attempted, the script starts the same unchanged container. It uses `docker compose start`, so it does not resolve a mutable image tag. Inspect any `.partial` backup before deleting it, then fix the failure and begin again with a new deployment id and fresh trial clone.

Once the production migration is attempted, an older image alone is **never** an automatic or assumed-valid rollback: the migration may have committed before its process reported failure, and older binaries reject newer migration history. A migration or post-migration failure deliberately leaves the service stopped unless the new runtime was already verified. Inspect the schema and backup before taking any recovery action. Do not retag `istra:rollback-<deployment-id>` over `istra:local` and start it against that database.

For a post-migration database rollback, preserve the failed migrated database. Restore the reported custom-format backup into a new, explicitly named non-default database, never over the existing production database. Use PostgreSQL's `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE` environment variables so credentials do not appear in command arguments; create the new database, restore with `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`, and run the previous runtime's storage check against it. Only after that duplicate reports the old expected schema and project count should you change both host and Compose URLs in the ignored `.env`, retag the reported rollback image as `istra:local`, and recreate the application. Recheck `/api/v1/storage`, Codex and OpenCode before allowing writes. Keep both the migrated database and backup until the rollback is independently verified.

To roll back only a packaged client after a successful database/runtime deployment, stop that client first. The Codex source retained at `~/plugins/istra.previous.<deployment-id>` can be moved back to the configured marketplace source and reinstalled with `codex plugin add istra@personal --json`. The OpenCode loader retained as `~/.config/opencode/plugins/istra.js.previous.<deployment-id>` can be copied back over the active loader. Restart the client and verify `get_storage_status`; do not point an older client at a schema it does not support.

## SQLite fallback backups

Automatic snapshots remain available whenever a native Istra runtime selects SQLite. They protect against application mistakes, but they are not disaster recovery until copied outside the platform backup directory.

List current snapshots through the API while SQLite is active, then copy the reported files to separate storage:

```bash
curl --fail http://127.0.0.1:${ISTRA_PORT:-4317}/api/v1/backups
```

The PostgreSQL-backed Compose application does not create SQLite snapshots. The portable JSON export is the preferred cross-version recovery artefact. Store at least one recent JSON export and, when SQLite is active, a snapshot outside the platform data directory. PostgreSQL status reports automated backups as unavailable; PostgreSQL backup and restore automation, and destructive full-replacement import, are explicitly deferred. Portable export remains available.

## Restore a full SQLite snapshot

Use the Data management import for a portable JSON restore. A full SQLite snapshot restore applies only to a native runtime explicitly configured for SQLite; it is not a restore path for the PostgreSQL-backed Compose application. Stop the native API and every MCP writer, validate the chosen file with `PRAGMA integrity_check`, preserve the current database and WAL files, replace the database atomically in the platform data directory, then restart all native runtimes. After restart, inspect the projects, `/api/v1/ready` and `/api/v1/storage`. Startup rejects incompatible migration histories rather than silently rewriting them. Keep the pre-restore snapshot until the restored instance has been verified.

## Health and shutdown

- `GET /api/v1/health` is process liveness.
- `GET /api/v1/ready` verifies the selected storage backend can answer a database query.
- `GET /api/v1/storage` reports the backend, redacted target, schema version, readiness and backup capability.
- Compose health checks use readiness.
- `docker compose stop` sends `SIGTERM`; Istra stops accepting traffic, closes Fastify and its database connections, and fails the shutdown after ten seconds rather than hanging indefinitely.

SQLite runs with foreign keys, WAL, a five-second busy timeout and `synchronous=FULL`. This favours durable project memory over maximum write throughput.
PostgreSQL search uses a stored weighted `tsvector`, GIN indexing and the trusted `unaccent` extension so common unaccented queries match the same Latin-script content as SQLite FTS5.
