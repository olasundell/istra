# Istra for OpenCode

Istra adds durable, local-first operational project memory to OpenCode. It starts the bundled Node.js MCP server against the same database used by the Istra web application, then supplies the requirements, work-queue, run, evidence and checkpoint workflow as OpenCode instructions.

## Install

Install globally for all OpenCode projects:

```bash
opencode plugin opencode-istra --global
```

For local development from this checkout, add the absolute path to `plugins/istra` to the `plugin` array in `opencode.json`.

The plugin requires Node.js 24 or newer because the bundled MCP runtime uses `node:sqlite`. Set `ISTRA_DATA_DIR` to share a non-default Istra data directory.

## Behaviour

The plugin registers a local `istra` MCP server unless `mcp.istra` is already configured. OpenCode exposes its tools with an `istra_` prefix, for example `istra_get_project_pulse` and `istra_save_checkpoint`.

To override the runtime manually, configure `mcp.istra` in `opencode.json` with a local command that runs `node` and this package's `dist/mcp/stdio.mjs` file.
