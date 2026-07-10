---
name: istra-project-memory
description: Use Istra as durable operational project memory through its MCP tools. Trigger when Codex starts, resumes or closes work tracked in Istra; resolves a checkout to a project; reads or maintains requirements, queues, blockers or evidence; records command runs and verification; or inspects project history and checkpoints.
---

# Istra Project Memory

Use Istra as the only durable data path for project memory. Do not read or edit its SQLite database directly, and do not recreate Istra state in files, comments or another tracker.

If Istra’s MCP tools, plugin packaging, bundled instructions or prescribed workflow appears faulty, invoke `$istra-error-reporting` and follow its bounded reporting policy. Do not use project work items to report Istra faults.

## Begin Work

1. Call `resolve_project` first with the current checkout path.
2. If exactly one project matches, use it. If none matches, call `list_projects` with a narrow query before considering a new project. If several projects remain plausible, ask the user; never choose by title or recency alone.
3. Call `get_project_pulse_summary` to read the current checkpoint, requirement roll-up, queue head, blockers and evidence warnings.
4. Call `list_work_queues`, then call `list_requirements_page`, `list_operational_work_items_page`, `list_external_blockers` and `list_evidence_page` for the relevant project. Request unresolved blockers and include stale evidence. Follow pagination only as far as the task requires.
5. Use `search` or `list_project_history_page` when prior decisions, discoveries, runs or evidence may affect the task.
6. Briefly surface the current focus, next action, relevant requirements and acceptance proof, active work, blockers, and failed or stale evidence before substantive work.

Do not block a clearly scoped task on bookkeeping. Resolve and read first, then perform the requested work.

## Maintain Requirements and Work

Use `client: "codex-plugin:istra"` on every write. When a tool accepts an idempotency key, supply a stable key for the logical write and reuse it only when retrying the identical operation and payload.

- Use `create_requirement` or `update_requirement` as the task changes requirement state. Give new requirements stable keys and explicit acceptance criteria; preserve hierarchy and responsible or related phases. Use the latest version for updates.
- Use `create_work_item` or `update_work_item` as the task changes work state. Preserve stable keys, queue placement, parent relationships and requirement links. Maintain dependencies with `link_work_items`, and create or resolve external blockers when they explain effective blocked state.
- Link requirements and work with `link_requirement_work` instead of duplicating the relationship in prose.
- Record material decisions and discoveries with `create_update`; do not use journal text as a substitute for structured requirement or work state.
- Change project lifecycle state or archive entities only when the user explicitly requests it or has already made that decision.

Avoid duplicates. Revise an authored update when correcting it rather than creating a contradictory replacement.

## Record Runs and Evidence

- Record meaningful verification commands with `create_run`; do not log routine navigation or every implementation command.
- Record the command, working directory, timing, exit code, toolchain and test summary accurately. Use `verified` only for a genuinely successful run; use `failed` for a failed command or test and `interrupted` when execution did not finish.
- Keep stdout and stderr excerpts short and bounded. Omit secrets, credentials, tokens, cookies and private environment values before calling Istra; server-side redaction is a final safety boundary, not permission to submit secrets. Store durable output as referenced artefacts where appropriate.
- Call `create_evidence` to link evidence to the exact acceptance criteria and work items, and include the requirement and run when available. Record failed or interrupted proof honestly; do not turn it into verified evidence.
- Never create evidence overrides.
- Treat stale evidence as historical context, not current proof. Re-run the relevant verification and attach fresh evidence before marking work proven.

## Close Substantive Work

After work that changed the project:

1. Re-read `get_project_pulse_summary` and the affected requirements, work items and evidence so concurrent changes are visible.
2. Bring requirement, work, blocker and evidence state up to date. Record any still-unwritten decision or discovery.
3. Call atomic `save_checkpoint` with concise Markdown, the current focus, one concrete next action or `null`, current blockers, the latest `expectedVersion`, and an idempotency key.
4. Confirm that `save_checkpoint` returned its snapshot identifier and digest. If either is absent, report that checkpoint closure is incomplete and do not claim an authoritative checkpoint.
5. Report the Istra records written in the final response.

Do not create a checkpoint for a read-only lookup or a discussion that changed nothing. If work stops after durable partial changes, record interrupted runs and remaining work accurately, then checkpoint the honest partial state.

## Concurrency and Failure

On a stale-version conflict, re-read the affected record, reconcile the concurrent change and retry only when the intended write still applies. Never blindly overwrite newer state or reuse an idempotency key for different input.

If the `istra` MCP server is unavailable, explain that the plugin integration must be restored. Do not bypass it through REST, direct SQLite access or a second persistence mechanism.
