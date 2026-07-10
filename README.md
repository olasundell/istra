# Istra

Istra is a local, single-user project memory for work that does not necessarily have a fixed goal or finish line. It keeps a structured current pulse alongside a durable journal of checkpoints, decisions, discoveries, issues and state changes.

## Requirements

- Node.js 24 or newer (Istra uses the built-in `node:sqlite` module)
- pnpm 11

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

## Data and backups

The default database path is platform-specific:

- macOS: `~/Library/Application Support/Istra/istra.sqlite3`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/istra/istra.sqlite3`
- Windows: `%LOCALAPPDATA%\Istra\istra.sqlite3`

Set `ISTRA_DATA_DIR` to keep the database and backups elsewhere. Istra enables foreign keys and WAL mode, takes daily and weekly online snapshots before the first write, and creates dedicated snapshots before migrations and imports.

Use the Data management view for a portable, versioned JSON export or a full replacement import. Import validates the bundle before changing active data and takes a pre-import backup. Import is intentionally not a merge operation.

The authoritative-ledger development schema is created from one fresh migration and accepts export format v3 only. Earlier databases and v1/v2 exports are intentionally unsupported: stop every Istra web/MCP process, remove the old database together with its `-wal` and `-shm` files, then restart Istra to create the new schema. Startup fails closed when it detects an older migration history; it never deletes a database automatically.

## MCP

The stdio MCP server uses the same application service and database as the UI:

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

MCP provides read/search and non-destructive create, edit and archive tools. It deliberately does not expose hard deletion, import or backup restoration.

## Codex plugin

The installable plugin source lives in `plugins/istra`. It packages the stdio MCP server and the `istra-project-memory` skill, which reads the current pulse before substantive work and records durable decisions, unresolved work and closing checkpoints afterwards.

Build the self-contained plugin runtime with:

```bash
pnpm build:plugin
```

The resulting `plugins/istra/dist/mcp/stdio.mjs` needs Node.js 24 or newer at runtime, but does not depend on this checkout's `node_modules`. Its `.mcp.json` uses the same platform data directory and `ISTRA_DATA_DIR` override as the web application, so the plugin does not create a second data path.

## OpenCode plugin

The same `plugins/istra` directory is an npm package named `opencode-istra`. Once published, install it globally with:

```bash
opencode plugin opencode-istra --global
```

The OpenCode entrypoint adds the bundled local `istra` MCP server and the Istra project-memory instructions. It preserves a pre-existing `mcp.istra` configuration, and uses the same default data directory and `ISTRA_DATA_DIR` override as the application.

For local development before publishing, add the absolute `plugins/istra` path to the `plugin` array in `opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/Istra/plugins/istra"]
}
```

## Commands

```bash
pnpm dev            # API and Vite development servers
pnpm build          # server and production web build
pnpm build:plugin   # self-contained MCP runtime and OpenCode server package
pnpm start          # production-style loopback server
pnpm migrate        # open the database and apply pending migrations
pnpm mcp            # stdio MCP server from source
pnpm typecheck      # browser and server TypeScript checks
pnpm test           # unit and integration tests
pnpm test:plugin    # verify the packaged Codex and OpenCode plugins
pnpm test:e2e       # Playwright browser journeys
```

## Architecture

- `src/domain` contains shared contracts and validation schemas.
- `src/application` contains the use-case service and persistence port.
- `src/infrastructure/sqlite` contains migrations, repositories, search, imports and backups.
- `src/adapters/http` and `src/adapters/mcp` expose the same application service.
- `src/web` contains the React application.

All HTTP listeners bind to loopback. Browser mutations require JSON and reject foreign Host and Origin values. There are no accounts, remote synchronisation or collaboration features in v1.
