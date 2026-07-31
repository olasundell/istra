# Istra agent plugins

This package adds durable, local-first operational project memory to Codex, Claude Code and OpenCode. Every client starts the same self-contained Node.js MCP server against the database used by the Istra web application, then applies the requirements, work-queue, run, evidence and checkpoint workflow appropriate to its host.

The bundle requires Node.js 24 or newer because its MCP runtime uses `node:sqlite`. Set `ISTRA_DATA_DIR` to share a non-default Istra data directory.

## Claude Code

Add the repository marketplace and install the plugin at user scope:

```bash
claude plugin marketplace add olasundell/istra --scope user
claude plugin install istra@istra --scope user
```

For unpublished local development, use the absolute repository path in the marketplace-add command. Claude Code exposes `/istra:istra-project-memory` and `/istra:istra-error-reporting`; run `/reload-plugins` in an existing session after installing or updating.

The shared `.mcp.json` starts `dist/mcp/stdio.mjs` from `${CLAUDE_PLUGIN_ROOT}` in Claude Code and from the plugin working directory in Codex, keeping both copied plugin caches independent of the checkout.

Claude Code caches marketplace plugins by the manifest version, which must be bumped for every published package update.

## Codex

The Codex manifest loads the shared `.mcp.json`, the same two skills, and the bundled MCP runtime. Codex writes use `client: "codex-plugin:istra"`; Claude Code writes use `client: "claude-plugin:istra"`.

## OpenCode

Install globally for all OpenCode projects:

```bash
opencode plugin opencode-istra --global
```

For local development from this checkout, add the absolute path to `plugins/istra` to the `plugin` array in `opencode.json`. The plugin registers a local `istra` MCP server unless `mcp.istra` is already configured and exposes tools with an `istra_` prefix. OpenCode writes use `client: "opencode-plugin:istra"`.

## Behaviour

Agents report only concrete or strongly suspected faults in Istra itself—its MCP tools, packaging, instructions, or workflow. They report once per root cause after a quick check, without blocking user work, and never include secrets or recursively report a reporter failure.

To override the OpenCode runtime manually, configure `mcp.istra` in `opencode.json` with a local command that runs `node` and this package's `dist/mcp/stdio.mjs` file.
