# Istra Project Memory

Use Istra as the only durable data path for project memory. Do not read or edit its SQLite database directly, and do not recreate Istra state in files, comments, or another tracker.

## Report Istra faults

Call `istra_report_error` autonomously after a quick sanity check when Istra’s MCP tools, plugin packaging, bundled instructions, or prescribed workflow appears to contradict its contract, lose or corrupt state, or present a materially unsafe, contradictory, impossible, or repeatedly misleading design. Use `kind: "bug"` for contradicted behaviour and `kind: "design"` for design concerns; keep observations separate from inferences and provide concise, sanitised evidence.

Report once per root cause with a task-scoped idempotency key, reusing that key only for an identical retry. Do not search for duplicates, ask conversational permission, block the user’s task, or read or update the inbox unless explicitly asked to triage it. Never report user-project bugs, ordinary failed commands/tests, expected validation or concurrency errors, unrelated environment failures, stylistic preferences, or faults caused by your own invalid input. Do not include credentials, tokens, personal data, private source, or unbounded logs. Never recursively report a failure of `istra_report_error` or fall back to work items, updates, REST, or direct SQLite; mention the reporting failure once if material and continue.

## Begin work

1. Call `istra_resolve_project` first with the current checkout path.
2. If exactly one project matches, use it. If none matches, call `istra_list_projects` with a narrow query before considering a new project. If several projects remain plausible, ask the user; never choose by title or recency alone.
3. Call `istra_get_project_pulse_summary` to read the current checkpoint, requirement roll-up, queue head, blockers, and evidence warnings.
4. Call `istra_list_work_queues`, then call `istra_list_requirements_page`, `istra_list_operational_work_items_page`, `istra_list_external_blockers`, and `istra_list_evidence_page` for the relevant project. Request unresolved blockers and include stale evidence. Follow pagination only as far as the task requires.
5. Use `istra_search` or `istra_list_project_history_page` when prior decisions, discoveries, runs, or evidence may affect the task.
6. Briefly surface the current focus, next action, relevant requirements and acceptance proof, active work, blockers, and failed or stale evidence before substantive work.

Do not block a clearly scoped task on bookkeeping. Resolve and read first, then perform the requested work.

## Maintain requirements and work

Use `client: "opencode-plugin:istra"` on every write. When a tool accepts an idempotency key, supply a stable key for the logical write and reuse it only when retrying the identical operation and payload.

- Use `istra_create_requirement` or `istra_update_requirement` as the task changes requirement state. Give new requirements stable keys and explicit acceptance criteria; preserve hierarchy and responsible or related phases. Use the latest version for updates.
- Use `istra_create_work_item` or `istra_update_work_item` as the task changes work state. Preserve stable keys, queue placement, parent relationships, and requirement links. Maintain dependencies with `istra_link_work_items`, and create or resolve external blockers when they explain effective blocked state.
- Link requirements and work with `istra_link_requirement_work` instead of duplicating the relationship in prose.
- Record material decisions and discoveries with `istra_create_update`; do not use journal text as a substitute for structured requirement or work state.
- Change project lifecycle state or archive entities only when the user explicitly requests it or has already made that decision.

Avoid duplicates. Revise an authored update when correcting it rather than creating a contradictory replacement.

## Record runs and evidence

- Record meaningful verification commands with `istra_create_run`; do not log routine navigation or every implementation command.
- Record the command, working directory, timing, exit code, toolchain, and test summary accurately. Use `verified` only for a genuinely successful run; use `failed` for a failed command or test and `interrupted` when execution did not finish.
- Keep stdout and stderr excerpts short and bounded. Omit secrets, credentials, tokens, cookies, and private environment values before calling Istra; server-side redaction is a final safety boundary, not permission to submit secrets. Store durable output as referenced artefacts where appropriate.
- Call `istra_create_evidence` to link evidence to the exact acceptance criteria and work items, and include the requirement and run when available. Record failed or interrupted proof honestly; do not turn it into verified evidence.
- Never create evidence overrides.
- Treat stale evidence as historical context, not current proof. Re-run the relevant verification and attach fresh evidence before marking work proven.

## Close substantive work

After work that changed the project:

1. Re-read `istra_get_project_pulse_summary` and the affected requirements, work items, and evidence so concurrent changes are visible.
2. Bring requirement, work, blocker, and evidence state up to date. Record any still-unwritten decision or discovery.
3. Call atomic `istra_save_checkpoint` with concise Markdown, the current focus, one concrete next action or `null`, current blockers, the latest `expectedVersion`, and an idempotency key.
4. Confirm that `istra_save_checkpoint` returned its snapshot identifier and digest. If either is absent, report that checkpoint closure is incomplete and do not claim an authoritative checkpoint.
5. Report the Istra records written in the final response.

Do not create a checkpoint for a read-only lookup or a discussion that changed nothing. If work stops after durable partial changes, record interrupted runs and remaining work accurately, then checkpoint the honest partial state.

## Concurrency and failure

On a stale-version conflict, re-read the affected record, reconcile the concurrent change, and retry only when the intended write still applies. Never blindly overwrite newer state or reuse an idempotency key for different input.

If the Istra MCP server is unavailable, explain that the plugin integration must be restored. Do not bypass it through REST, direct SQLite access, or a second persistence mechanism.
