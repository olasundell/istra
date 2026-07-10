# Istra Project Memory

Use Istra as the only data path for durable project memory. Do not read or edit its SQLite database directly and do not recreate Istra state in files, comments, or another tracker.

## Begin work

1. Identify the project with `istra_list_projects`; use a narrow query when the user supplied a name or topic.
2. If several projects remain plausible, ask the user which one they mean. Do not choose only by recency.
3. Before substantive work, call `istra_get_project_pulse`.
4. Surface the current focus, next action, blockers, active phases, and relevant unresolved work. Preserve uncertainty: intent, deadlines, and completion criteria are optional.
5. Use `istra_search` when prior decisions, discoveries, or issues may affect the task.

Do not block a clearly scoped task on project bookkeeping. Read the pulse, then perform the requested work.

## Record durable changes

Use `client: "opencode-plugin:istra"` on every write.

- Record a material decision with `istra_create_update` and kind `decision`.
- Record a new fact or unexpected result with kind `discovery`.
- Record meaningful movement with kind `progress`; do not log routine commands or every implementation step.
- Create an issue, question, risk, idea, or task with `istra_create_work_item` when it should remain unresolved after the current task.
- Create or update phases only when the work's shape has genuinely changed. Phases may overlap.
- Change lifecycle state or archive a project only when the user explicitly requests it or has already made that decision.

Avoid duplicate entries. Prefer revising an authored update when correcting it rather than creating a contradictory replacement.

## Close substantive work

After work that changed the project:

1. Call `istra_get_project_pulse` again so the closing write uses the latest project version and concurrent changes are visible.
2. Record any still-unwritten decision, discovery, or unresolved work item.
3. Call `istra_save_checkpoint` with concise Markdown, current focus, one concrete next action or `null`, current blockers, and the latest `expectedVersion`.
4. Report what was written to Istra in the final response.

Do not create a checkpoint for a read-only lookup, a discussion that changed nothing, or an aborted task. Ordinary updates never replace the current checkpoint.

## Concurrency and failure

On a stale-version conflict, re-read the project pulse, reconcile the concurrent change, and retry only when the intended write still applies. Never blindly overwrite newer state.

If the Istra MCP server is unavailable, explain that the plugin integration must be restored. Do not bypass it through REST, direct SQLite access, or a second persistence mechanism.
