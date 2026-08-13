---
name: istra-checkpoint
description: Close substantive Istra work with an authoritative checkpoint.
---

Follow the `istra-project-memory` close-work path. Use `client: "cursor-plugin:istra"` on every write.

1. Re-read `get_project_pulse_summary` and the affected requirements, work items and evidence.
2. Bring requirement, work, blocker and evidence state up to date. Record any still-unwritten decision or discovery.
3. Call `save_checkpoint` with concise Markdown, the current focus, one concrete next action or `null`, current blockers, the latest `expectedVersion`, and an idempotency key.
4. Confirm that `save_checkpoint` returned its snapshot identifier and digest. If either is absent, report that checkpoint closure is incomplete.
5. Skip the checkpoint when nothing durable changed.
