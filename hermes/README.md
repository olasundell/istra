<p align="center"><img src="../assets/brand/istra-mark.png" alt="Istra logo" width="96" height="96"></p>
<h1 align="center">Istra for Hermes Agent</h1>

The repository root is an installable Hermes plugin. It registers Hermes-specific workflow skills while the bundled Istra MCP runtime supplies the tools. Hermes keeps these as two explicit extension surfaces, so both must be enabled.

The plugin requires Hermes Agent 0.20.0 or newer and Node.js 24 or newer.

## Install

Install and enable the Git-backed plugin:

```bash
hermes plugins install olasundell/istra --enable
```

Resolve the active Hermes profile, add the bundled stdio server, and verify that Hermes can discover its tools:

```bash
ISTRA_HERMES_ROOT="$(dirname "$(hermes config path)")/plugins/istra"
hermes mcp add istra --command node --args "$ISTRA_HERMES_ROOT/plugins/istra/dist/mcp/stdio.mjs"
hermes mcp test istra
```

Require the test output to report a successful connection and discovered Istra tools; Hermes 0.20.0 can exit successfully after a failed probe. If it reports that the optional `mcp` Python SDK is missing, that Hermes installation lacks MCP support. Follow [Hermes' official guidance](https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes/) to install the `[mcp]` extra in its environment, then repeat the test.

Start a new session with the operational-memory workflow preloaded:

```bash
hermes -s istra:istra-project-memory
```

The project-memory skill loads `istra:istra-error-reporting` only when Istra itself appears faulty. Hermes exposes the MCP tools with names such as `mcp__istra__resolve_project` and records writes with `client: "hermes-plugin:istra"`.

Set `ISTRA_DATA_DIR` when Hermes should use a non-default Istra data directory. The MCP runtime otherwise follows the same platform-local storage selection as the Istra application and the other agent plugins.

## Update

Because Hermes installs this plugin from the repository root, its Git metadata remains available to the built-in updater:

```bash
hermes plugins update istra
hermes mcp test istra
```

Older copy-based installations may not contain Git metadata. If the updater reports that Istra is not Git-backed, replace that snapshot with `hermes plugins install olasundell/istra --force --enable` before testing it again.

Start a new Hermes session after an update. Restart the gateway as well when it is running.

Hermes currently does not let a native plugin register an MCP server through its public plugin API. The separate `hermes mcp add` step is therefore intentional; the plugin does not modify `config.yaml` during import.
