# Cursor plugin design

Date: 2026-08-13

## Summary

Add Cursor as a first-class Istra host in the existing `plugins/istra` bundle. Cursor gets the same bundled stdio MCP server and shared skills as Codex, Claude Code and OpenCode, plus Cursor-only rules and slash commands. v1 is installable locally and marketplace-ready. It is not submitted to the Cursor Marketplace in this change.

## Goals

- Cursor agents resolve a checkout to an Istra project, read pulse and operational memory, record runs and evidence, save checkpoints, and report Istra faults through the same MCP tools as the other hosts.
- Writes from Cursor use `client: "cursor-plugin:istra"`.
- A copied or marketplace-installed plugin starts `dist/mcp/stdio.mjs` from the plugin directory and shares the platform-local Istra database. It does not depend on this git checkout and does not create a second data path.
- Developers can load the plugin from `~/.cursor/plugins/local/istra` while iterating, and the repository carries a Cursor marketplace manifest for later submission.

## Non-goals

- Hooks, custom agents, plugin variables, canvases, or a Cursor-specific fork of the skills.
- Changing Claude Code / Codex `.mcp.json`, the OpenCode entrypoint, or the Hermes skill copies.
- Submitting the plugin to cursor.com/marketplace.
- Live Cursor-window tests in CI.
- A root Agent Plugins `plugin.json`. Cursor extras (rules, commands) require the Cursor Plugin format.

## Architecture

The plugin lives in `plugins/istra`, next to `.claude-plugin/` and `.codex-plugin/`.

```text
istra/                                  # repository
├── .cursor-plugin/
│   └── marketplace.json                # Cursor marketplace index
└── plugins/istra/
    ├── .cursor-plugin/plugin.json      # Cursor host manifest
    ├── mcp.json                        # Cursor MCP only
    ├── .mcp.json                       # unchanged; Claude Code / Codex
    ├── rules/istra-project-memory.mdc
    ├── commands/
    │   ├── istra-pulse.md
    │   ├── istra-checkpoint.md
    │   └── istra-report-fault.md
    ├── skills/                         # shared; add Cursor client identity
    └── dist/mcp/stdio.mjs              # existing bundled runtime
```

The Cursor manifest explicitly registers `skills/`, `rules/`, `commands/`, and plugin-root `mcp.json`, matching Cursor's published plugin examples and keeping component discovery reviewable from the manifest.

Local development: copy `plugins/istra` to `~/.cursor/plugins/local/istra`, then run **Developer: Reload Window**. Cursor rejects a symlink whose target is outside the local plugin directory.

## Manifests

### `plugins/istra/.cursor-plugin/plugin.json`

- `name`: `istra`
- `version`: `0.1.0` (independent of the Claude Code `0.1.1` host version)
- `description`: durable operational project memory for open-ended work in Cursor
- `author.name`: `Istra contributors`
- `homepage` / `repository`: the GitHub URLs already used by the Claude Code manifest
- `license`: `MIT`
- `keywords`: same set as the other hosts (`project-memory`, `checkpoints`, `requirements`, `evidence`, `error-reporting`, `local-first`)
- `logo`: `assets/istra-mark.png`, the shared selected Istra mark packaged with every host
- `commands`: `./commands/`
- `skills`: `./skills/`
- `rules`: `./rules/`
- `mcpServers`: `./mcp.json`

No `variables` schema: `ISTRA_DATA_DIR` and related settings remain environment / platform-local configuration, as for every other host.

### `.cursor-plugin/marketplace.json` (repository root)

- `name`: `istra`
- `owner.name`: `Istra contributors`
- `metadata.description`: installable Istra project-memory plugins for coding agents
- one plugin entry: `name` `istra`, `source` `./plugins/istra`, Cursor-specific description

All paths are relative. No `..` segments and no absolute paths.

## MCP

Add `plugins/istra/mcp.json`. Do not modify `.mcp.json`.

The Cursor server must:

1. Use stdio transport inferred from `command`.
2. Run `node` with `${PLUGIN_ROOT}/dist/mcp/stdio.mjs` as its only argument.
3. Set `cwd` to `${PLUGIN_ROOT}` so Cursor's documented plugin-root substitution resolves the bundled runtime independently of the open workspace.
4. Leave storage selection to the existing MCP runtime (platform-local config and env overrides).

Do not put a checkout-absolute path in `mcp.json`. Do not point Cursor at `.mcp.json`.

Cursor tool names stay the MCP names (`resolve_project`, `save_checkpoint`, and so on). Do not invent an `istra_` prefix; that is OpenCode-only.

If the Istra MCP server is unavailable, the skills already require the agent to say the integration must be restored and forbid REST, direct SQLite, or a second tracker. The always-on rule repeats that boundary.

## Skills

Edit the shared skills in `plugins/istra/skills/`. Do not copy them.

`istra-project-memory`:

- Add Cursor to the host client-identity sentence: `client: "cursor-plugin:istra"` when running in Cursor.
- Keep the existing Codex and Claude Code identities. OpenCode and Hermes stay on their own instruction files.

`istra-error-reporting`:

- Extend the description and identity sentence so Cursor is a named host, not only Codex / Claude Code / OpenCode.
- Add `client: "cursor-plugin:istra"` for Cursor sessions.
- Leave the reporting policy unchanged (one report per root cause, sanitise first, never recurse on `report_error`, never report user-project bugs).

Hermes copies under `hermes/skills/` are out of scope.

## Rule

`plugins/istra/rules/istra-project-memory.mdc`:

```yaml
description: Use Istra MCP as the only durable project-memory path in Cursor.
alwaysApply: true
```

Body stays short (well under a screen). It states:

- Istra is the only durable project-memory path; do not bypass MCP.
- Use `client: "cursor-plugin:istra"` on every write.
- Follow `istra-project-memory` for resolve → pulse → work → evidence → checkpoint.
- Follow `istra-error-reporting` for Istra MCP, plugin, instruction, or workflow faults only.
- Do not block a clearly scoped task on bookkeeping.

The rule does not duplicate the skill checklists.

## Commands

Each command is a markdown file with `name` and `description` frontmatter. Commands invoke the shared skills; they do not define a second workflow.

| File | Slash command | Behaviour |
| --- | --- | --- |
| `commands/istra-pulse.md` | `/istra-pulse` | Call `resolve_project` with the current checkout path, then `get_project_pulse_summary`. Briefly surface focus, next action, relevant requirements, active work, blockers, and failed or stale evidence. Do not checkpoint. |
| `commands/istra-checkpoint.md` | `/istra-checkpoint` | Follow the skill’s close-work path: re-read pulse and affected records, bring structured state up to date, call `save_checkpoint`, confirm snapshot identifier and digest. Skip when nothing durable changed. |
| `commands/istra-report-fault.md` | `/istra-report-fault` | Follow `istra-error-reporting`. Report only Istra faults. Never include secrets. Never recurse on reporter failure. |

## Packaging and docs

Update `plugins/istra/package.json` `files` so the npm/OpenCode pack also includes `.cursor-plugin`, `mcp.json`, `rules`, and `commands`. That keeps one bundle listing complete; it does not make OpenCode load Cursor files.

Document Cursor in:

- root `README.md` (agent-ready line, new Cursor plugin section, `pnpm test:plugin` description, commands list)
- `plugins/istra/README.md` (install: copy into `~/.cursor/plugins/local` or Customize; commands; `cursor-plugin:istra` provenance)

Install copy for local development. Cursor rejects a symlink whose target is outside `~/.cursor/plugins/local`:

```bash
mkdir -p ~/.cursor/plugins/local
rsync -a --delete /absolute/path/to/istra/plugins/istra/ ~/.cursor/plugins/local/istra/
```

Then reload the Cursor window. Marketplace install remains a later, manual submission.

## Tests

Add `src/integration/cursor-plugin.test.ts` and include it in `pnpm test:plugin`.

The contract test asserts:

- Repository marketplace lists `istra` with source `./plugins/istra`.
- Cursor manifest matches the fields above and explicitly registers every packaged component.
- `mcp.json` starts `node` with `${PLUGIN_ROOT}/dist/mcp/stdio.mjs`, uses `${PLUGIN_ROOT}` as `cwd`, and does not hard-code a checkout path.
- Shared skills contain `client: "cursor-plugin:istra"`.
- Rule frontmatter is valid and the body names the Cursor client identity.
- The three command files have `name` and `description` and refer to the skill workflows (`resolve_project` / pulse, `save_checkpoint`, `report_error`).
- `package.json` `files` contains the Cursor assets.

Extend existing Claude / package tests that pin the error-reporting host list so they accept Cursor in that sentence.

Do not spawn a Cursor UI. Expand Cursor's documented `${PLUGIN_ROOT}` token against an isolated copied bundle, launch its own `mcp.json`, and prove that the runtime exposes the expected tools.

## Error handling and provenance

- Cursor mutations, including error reports and automation calls, use `client: "cursor-plugin:istra"`.
- Idempotency keys follow the existing skill: stable per logical write; reuse only for an identical retry.
- Stale-version conflicts: re-read, reconcile, retry only when the intended write still applies.
- Unavailable MCP: explain that the plugin integration must be restored; do not bypass it.
- `report_error` failures are mentioned once if material, then ignored; they are never reported through `report_error`.

## Implementation order

1. Manifests (`plugin.json`, `marketplace.json`) and `mcp.json`.
2. Rule and three commands.
3. Shared skill identity / description updates.
4. `package.json` `files`, README sections, `test:plugin` wiring.
5. Cursor plugin contract test; update host-list assertions in existing tests.
6. Optional manual follow-up: copy the plugin into Cursor and confirm Customize shows the MCP server, rule, skills, and commands.

## Success criteria

- `pnpm test:plugin` passes, including the new Cursor contract.
- The copied-bundle integration test starts the packaged MCP server outside the checkout and exposes the expected Istra tools.
- Packaged skills, rules and commands require Cursor writes to carry `client: "cursor-plugin:istra"`.
- Claude Code, Codex, Hermes and OpenCode packaging tests still pass without `.mcp.json` changes.
