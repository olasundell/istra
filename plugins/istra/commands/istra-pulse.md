---
name: istra-pulse
description: Resolve this checkout to an Istra project and surface the current pulse.
---

Follow the `istra-project-memory` begin-work path. Do not checkpoint.

1. Call `resolve_project` with the current checkout path.
2. If exactly one project matches, use it. If none matches, call `list_projects` with a narrow query before considering a new project. If several remain plausible, ask the user.
3. Call `get_project_pulse_summary`.
4. Briefly surface focus, next action, relevant requirements, active work, blockers, and failed or stale evidence.
