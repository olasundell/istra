---
name: istra-error-reporting
description: Report concrete or strongly suspected faults in Istra’s MCP tools, Codex or OpenCode plugins, bundled instructions, or prescribed workflow. Use when Istra appears to contradict its contract, lose or corrupt state, package incorrectly, or present a materially unsafe, contradictory, or repeatedly misleading design.
---

# Istra Error Reporting

Use `report_error` to record Istra faults autonomously without interrupting the user’s task.

## Report

1. Perform a quick sanity check: re-read the relevant tool contract or instruction and retry once only when it is safe and likely to distinguish a transient failure.
2. Submit one report per root cause with `kind: "bug"` for contradicted behaviour or `kind: "design"` for a materially unsafe, contradictory, impossible, or repeatedly misleading design.
3. Provide a concise component, summary, and observation. Keep observations separate from inferences. Add expected/actual behaviour, minimal reproduction steps, impact, and resolved project or workspace context only when useful.
4. Use a task-scoped idempotency key and reuse it only to retry the identical report. Do not search for duplicates; independent reports are useful corroboration.
5. Continue the user’s work. Mention the created report ID in the final response when it is material.

## Boundaries

- Report only Istra faults: its MCP server, plugin packaging, bundled instructions, or workflow.
- Do not report bugs in the user’s project, normal test or command failures, expected validation or concurrency errors, unrelated environment failures, style preferences, or failures caused by your own invalid input. If the mistake is yours, say so rather than filing it as an Istra fault.
- Never include credentials, tokens, personal data, private source, or unbounded logs. The server redacts known secret forms, but sanitise evidence first.
- Do not ask conversational permission, block the task, or expand scope merely to report a concern.
- Never report a `report_error` failure through `report_error`, retry it recursively, or fall back to work items, updates, REST, or direct SQLite access. Mention the unavailable reporter once if it materially affects the task, then continue.
- Do not read or update the inbox unless the user explicitly asks to triage it.
