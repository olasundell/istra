# Istra

> Durable project memory for the work between the plan and the proof.

Istra is a local-first command centre for open-ended work. It keeps the current pulse visible, turns decisions and next actions into a searchable journal, and connects requirements to work, runs, evidence and checkpoints so the next session can start with context instead of archaeology.

<p align="center">
  <img src="docs/screenshots/dashboard.jpg" alt="Istra dashboard showing a list of projects and recent activity" width="49%">
  <img src="docs/screenshots/project-detail.jpg" alt="Istra project detail showing the current pulse and operational memory" width="49%">
</p>
<p align="center"><sub>A focused dashboard for the whole portfolio, then a deep project view for the work that matters today.</sub></p>

<p align="center">
  <img src="docs/screenshots/search.jpg" alt="Istra search showing results across project memory" width="49%">
  <img src="docs/screenshots/project-detail-mobile.jpg" alt="Istra project detail on a mobile viewport" width="32%">
</p>
<p align="center"><sub>Search the whole memory, and keep the hand-off usable when the screen gets small.</sub></p>

## Why Istra

Most tools capture tasks. Istra captures continuity.

- **Current pulse** — Keep focus, next action and blockers visible at the top of every project.
- **Operational memory** — Trace intent through requirements, work queues, external blockers, runs and evidence.
- **Durable journal** — Record progress, decisions, discoveries and checkpoints with revision history.
- **Searchable by default** — Find a project, phase, work item or remembered decision without reconstructing the story.
- **Local and calm** — Zero-configuration SQLite or local PostgreSQL, loopback-only HTTP and portable exports; no accounts, remote sync or collaboration layer required.
- **Agent-ready** — Use the same application service from the web UI, MCP, Codex and OpenCode.

Istra is designed for the moment after the meeting, the interrupted investigation or the half-finished build: the important thing is not only what exists, but why it exists, what was proved, and what should happen next.

## Requirements

- Node.js 24 LTS or Node.js 26 (SQLite uses the built-in `node:sqlite` module)
- pnpm 11.11.0
- Docker Compose when using the local PostgreSQL service

The repository's `.nvmrc`, package metadata, container image and CI all use the Node.js 24 compatibility baseline.

## Run locally

```bash
pnpm install
pnpm dev
```

The development UI runs at `http://127.0.0.1:5173` and proxies `/api/v1` to the local Fastify server on port `4317`.

For a production-style local build:

```bash
pnpm build
pnpm start
```

The production server serves both the UI and API at `http://127.0.0.1:4317`.

## Run PostgreSQL with Docker Compose

SQLite remains the zero-configuration default. To share PostgreSQL between the host-run API, Codex MCP and OpenCode MCP, start only the PostgreSQL service:

```bash
cp .env.example .env
chmod 600 .env
docker compose up --detach --wait postgres
docker compose ps postgres
```

PostgreSQL is published on host loopback only, using port `5433` by default, and persists data in the `istra-postgres-data` named volume. Set the same private password in `POSTGRES_PASSWORD` and the percent-encoded password portions of `ISTRA_DATABASE_URL` and `ISTRA_COMPOSE_DATABASE_URL`. The host URL uses `127.0.0.1:5433`; the container URL uses `postgres:5432`. Then load the ignored file into the maintenance shell and migrate:

```bash
set -a
. ./.env
set +a
pnpm storage:migrate:postgres
pnpm storage:status
```

The migration command is the supported SQLite-to-PostgreSQL cutover path. It verifies the copied data before atomically selecting PostgreSQL in the platform-local Istra configuration. Environment variables override that shared configuration.

The `istra` Compose service uses the Compose PostgreSQL service and waits for its health check. Starting the application service also starts PostgreSQL:

```bash
docker compose up --build --detach --wait istra
```

Open `http://127.0.0.1:4317`. The application container runs as a non-root user, publishes only on host loopback, and connects to PostgreSQL over the private Compose network at `postgres:5432`.

Do not start the application during a host-side migration into the same PostgreSQL database. The unauthenticated API and database ports must not be exposed to a LAN or the internet.

See [Operating Istra](docs/operations.md) for configuration, upgrades, logs, off-volume backups and restore steps.

## Data and backups

The default database path is platform-specific:

- macOS: `~/Library/Application Support/Istra/istra.sqlite3`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/istra/istra.sqlite3`
- Windows: `%LOCALAPPDATA%\Istra\istra.sqlite3`

Set `ISTRA_DATA_DIR` to keep SQLite elsewhere and `ISTRA_BACKUP_DIR` to separate its snapshots. Istra enables foreign keys, WAL mode and full synchronous durability, takes daily and weekly online snapshots before the first write, and creates dedicated snapshots before migrations and imports.

Use the Data management view for a portable, versioned JSON export. SQLite supports validated full-replacement import and creates a pre-import snapshot. PostgreSQL automated backups and destructive full-replacement imports are deferred; export remains available, but PostgreSQL reports backups as unavailable and rejects replacement import.

The authoritative ledger starts at migration v1 and adds the global error-report inbox in v2; PostgreSQL v3 adds indexed accent-insensitive search parity. Existing databases with matching migration history upgrade transactionally; SQLite takes a pre-migration snapshot first, while incompatible legacy histories fail closed and are never deleted automatically. Istra exports format v4, accepts v3 and v4 SQLite imports, and treats a v3 import as a full replacement with an empty error inbox.

## MCP

The stdio MCP server uses the same application service and storage selection as the UI:

```bash
pnpm mcp
```

For a project-scoped Codex configuration, add the following to `.codex/config.toml`, replacing the path with this checkout's absolute path:

```toml
[mcp_servers.istra]
command = "pnpm"
args = ["--dir", "/absolute/path/to/Istra", "mcp"]
required = false
default_tools_approval_mode = "writes"
```

MCP provides read/search and non-destructive create, edit and archive tools. `report_error` records a bounded, sanitised report of a perceived Istra MCP, plugin, instruction, or workflow fault; it is not for bugs in the user’s project. Istra deliberately does not expose hard deletion, import or backup restoration.

## Codex plugin

The installable plugin source lives in `plugins/istra`. It packages the stdio MCP server, the `istra-project-memory` skill, and the implicitly triggered `istra-error-reporting` skill. The latter tells agents when to report Istra faults autonomously, safely, and without blocking the user’s task.

Build the self-contained plugin runtime with:

```bash
pnpm build:plugin
```

The resulting `plugins/istra/dist/mcp/stdio.mjs` needs Node.js 24 or newer at runtime, but does not depend on this checkout's `node_modules`. Its `.mcp.json` reads the same platform-local storage configuration and environment overrides as the web application, so the plugin does not create a second data path.

## OpenCode plugin

The same `plugins/istra` directory is an npm package named `opencode-istra`. Once published, install it globally with:

```bash
opencode plugin opencode-istra --global
```

The OpenCode entrypoint adds the bundled local `istra` MCP server and matching operational project-memory instructions. It preserves a pre-existing `mcp.istra` configuration and uses the same shared storage selection as the application.

For local development before publishing, add the absolute `plugins/istra` path to the `plugin` array in `opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/Istra/plugins/istra"]
}
```

## Commands

```bash
pnpm dev            # API and Vite development servers
pnpm build          # server, web and packaged plugin builds
pnpm build:app      # server and web build without rebuilding plugin artefacts
pnpm build:plugin   # self-contained MCP runtime and OpenCode server package
pnpm start          # production-style loopback server
pnpm migrate        # open the database and apply pending migrations
pnpm storage:status # show the selected backend and redacted readiness status
pnpm storage:migrate:postgres # copy local SQLite data to PostgreSQL and activate it
pnpm mcp            # stdio MCP server from source
pnpm typecheck      # browser and server TypeScript checks
pnpm test           # unit and integration tests
pnpm test:postgres  # live PostgreSQL suite (requires TEST_DATABASE_URL)
pnpm check          # typecheck, tests and all production builds
pnpm test:plugin    # verify the packaged Codex and OpenCode plugins
pnpm test:e2e       # Playwright browser journeys
```

## Architecture

- `src/domain` contains shared contracts and validation schemas.
- `src/application` contains the use-case service and persistence port.
- `src/infrastructure/sqlite` contains the default local backend, imports and snapshot backups.
- `src/infrastructure/postgres` contains PostgreSQL migrations, repositories and search.
- `src/adapters/http` and `src/adapters/mcp` expose the same application service.
- `src/web` contains the React application.

Native HTTP listeners bind to loopback by default. The container listens internally on all interfaces but Compose publishes it only on host loopback. Browser mutations require JSON and reject foreign Host and Origin values. There are no accounts, remote synchronisation or collaboration features in v1.

## Licence

Istra is licensed under the [MIT License](LICENSE).
