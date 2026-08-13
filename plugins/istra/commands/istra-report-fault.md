---
name: istra-report-fault
description: Report a bounded Istra MCP, plugin, instruction, or workflow fault.
---

Follow the `istra-error-reporting` skill. Use `client: "cursor-plugin:istra"`.

Call `report_error` only for faults in Istra itself. Do not report bugs in the user’s project. Never include secrets. Never report a `report_error` failure through `report_error`. Continue the user’s work after filing.
