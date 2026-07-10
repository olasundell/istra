---
name: istra-project-memory
description: Use Istra as durable project memory through its MCP tools. Trigger when Codex is asked to start, resume or continue work tracked in Istra; inspect a project's current pulse or history; search prior decisions and issues; capture a decision, discovery, progress update, phase or work item; or close substantive work with a checkpoint.
---

# Istra Project Memory

Use Istra as the only data path for project memory. Do not read or edit the SQLite database directly and do not recreate Istra state in files, comments or another tracker.

## Begin Work

1. Identify the project with `list_projects`. Use a narrow query when the user supplied a name or topic.
2. If several projects remain plausible, ask the user which one they mean. Do not choose based only on recency.
3. Call `get_project_pulse` before substantive work.
4. Briefly surface the current focus, next action, blockers, active phases and relevant unresolved work. Preserve uncertainty: intent, deadlines and completion criteria are optional.
5. Use `search` when prior decisions, discoveries or issue history may affect the task.

Do not block a clearly scoped task on project bookkeeping. Read the pulse, then perform the requested work.

## Record Durable Changes

Use `client: "codex-plugin:istra"` on every write.

- Record a material decision with `create_update` and kind `decision`.
- Record a new fact or unexpected result with kind `discovery`.
- Record meaningful movement with kind `progress`; do not log routine commands or every implementation step.
- Create an `issue`, `question`, `risk`, `idea` or `task` with `create_work_item` when it should remain unresolved after the current task.
- Create or update phases only when the work's shape has genuinely changed. Phases may overlap.
- Change lifecycle state or archive a project only when the user explicitly requests it or has already made that decision.

Avoid duplicate entries. Prefer revising an authored update when correcting it rather than creating a contradictory replacement.

## Close Substantive Work

After work that changed the project:

1. Call `get_project_pulse` again so the closing write uses the latest project version and concurrent MCP or UI changes are visible.
2. Record any still-unwritten decision, discovery or unresolved work item.
3. Call `save_checkpoint` with:
   - concise Markdown describing what changed and important verification;
   - the current focus after the work;
   - one concrete next action, or `null` when none is known;
   - current blockers as an array, retaining existing blockers that remain true;
   - the latest `expectedVersion`.
4. Report what was written to Istra in the final response.

Do not create a checkpoint for a read-only lookup, a discussion that changed nothing, or an aborted task. Ordinary updates never replace the current checkpoint.

## Concurrency and Failure

On a stale-version conflict, re-read the project pulse, reconcile the concurrent change and retry only when the intended write still applies. Never blindly overwrite newer state.

If the `istra` MCP server is unavailable, explain that the plugin integration must be restored. Do not bypass it through REST, direct SQLite access or a second persistence mechanism.
