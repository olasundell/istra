<p align="center"><img src="assets/istra-mark.png" alt="Istra logo" width="80" height="80"></p>
<h1 align="center">Istra agent plugins</h1>

This package adds durable, local-first operational project memory to Codex, Claude Code, Cursor, Hermes Agent and OpenCode. Every client starts the same self-contained Node.js MCP server against the database used by the Istra web application, then applies the requirements, work-queue, run, evidence and checkpoint workflow appropriate to its host.

The bundle requires Node.js 24 or newer because its MCP runtime uses `node:sqlite`. Set `ISTRA_DATA_DIR` to share a non-default Istra data directory.

## Claude Code

Add the repository marketplace and install the plugin at user scope:

```bash
claude plugin marketplace add olasundell/istra --scope user
claude plugin install istra@istra --scope user
```

For unpublished local development, use the absolute repository path in the marketplace-add command. Claude Code exposes `/istra:istra-project-memory` and `/istra:istra-error-reporting`; run `/reload-plugins` in an existing session after installing or updating.

The shared `.mcp.json` starts `dist/mcp/stdio.mjs` from `${CLAUDE_PLUGIN_ROOT}` in Claude Code and from the plugin working directory in Codex, keeping both copied plugin caches independent of the checkout.

Claude Code caches marketplace plugins by the manifest version, which must be bumped for every published Claude Code plugin update.

## Codex

The Codex manifest loads the shared `.mcp.json`, the same two skills, and the bundled MCP runtime. Add the repository or local checkout as a Codex marketplace, then install `istra` from the marketplace name reported by Codex. Codex writes use `client: "codex-plugin:istra"`; Claude Code writes use `client: "claude-plugin:istra"`; Cursor writes use `client: "cursor-plugin:istra"`.

## Cursor

Copy this package into Cursor’s local plugin directory (Cursor rejects a symlink whose target is outside `~/.cursor/plugins/local`), then reload the window:

```bash
mkdir -p ~/.cursor/plugins/local
rsync -a --delete /absolute/path/to/istra/plugins/istra/ ~/.cursor/plugins/local/istra/
```

The Cursor manifest registers `mcp.json`, `skills/`, `rules/` and `commands/` from this directory. Cursor expands `${PLUGIN_ROOT}` in the MCP configuration and starts `dist/mcp/stdio.mjs` from the installed plugin directory. Cursor exposes `/istra-pulse`, `/istra-checkpoint` and `/istra-report-fault`. The repository-root `.cursor-plugin/marketplace.json` is ready for a later marketplace submission.

## Hermes Agent

With Hermes Agent 0.20.0 or newer, install the repository-root plugin, then add this package's bundled runtime through Hermes' MCP configuration:

```bash
hermes plugins install olasundell/istra --enable
ISTRA_HERMES_ROOT="$(dirname "$(hermes config path)")/plugins/istra"
hermes mcp add istra --command node --args "$ISTRA_HERMES_ROOT/plugins/istra/dist/mcp/stdio.mjs"
hermes mcp test istra
```

Require the test output to report a successful connection and discovered Istra tools; do not rely on its process exit status alone. If the optional `mcp` Python SDK is missing, install Hermes MCP support by following [Hermes' official guidance](https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes/), then repeat the test.

Start a new session with `hermes -s istra:istra-project-memory`. Hermes plugin skills are explicitly loaded and namespaced; its MCP tools use the `mcp__istra__` prefix. Hermes writes use `client: "hermes-plugin:istra"`.

The separate MCP command is required because Hermes does not expose MCP registration through its public native-plugin API. The plugin deliberately leaves the user's `config.yaml` untouched during import.

## OpenCode

Install globally for all OpenCode projects:

```bash
opencode plugin opencode-istra --global
```

For local development from this checkout, add the absolute path to `plugins/istra` to the `plugin` array in `opencode.json`. The plugin registers a local `istra` MCP server unless `mcp.istra` is already configured and exposes tools with an `istra_` prefix. OpenCode writes use `client: "opencode-plugin:istra"`.

## Behaviour

Agents report only concrete or strongly suspected faults in Istra itself—its MCP tools, packaging, instructions, or workflow. They report once per root cause after a quick check, without blocking user work, and never include secrets or recursively report a reporter failure.

To override the OpenCode runtime manually, configure `mcp.istra` in `opencode.json` with a local command that runs `node` and this package's `dist/mcp/stdio.mjs` file.
