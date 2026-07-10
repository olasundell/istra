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

## Commands

```bash
pnpm dev            # API and Vite development servers
pnpm build          # server and production web build
pnpm start          # production-style loopback server
pnpm migrate        # open the database and apply pending migrations
pnpm mcp            # stdio MCP server from source
pnpm typecheck      # browser and server TypeScript checks
pnpm test           # unit and integration tests
pnpm test:e2e       # Playwright browser journeys
```

## Architecture

- `src/domain` contains shared contracts and validation schemas.
- `src/application` contains the use-case service and persistence port.
- `src/infrastructure/sqlite` contains migrations, repositories, search, imports and backups.
- `src/adapters/http` and `src/adapters/mcp` expose the same application service.
- `src/web` contains the React application.

All HTTP listeners bind to loopback. Browser mutations require JSON and reject foreign Host and Origin values. There are no accounts, remote synchronisation or collaboration features in v1.
