import type { Priority, ProjectState, WorkItemKind, WorkItemStatus } from "../types";
import { humanise } from "../format";

export function ProjectStatus({ state }: { state: ProjectState }) {
  return <span className={`status-text status-text--${state}`}><span aria-hidden="true" />{humanise(state)}</span>;
}

export function WorkItemStatusView({ status }: { status: WorkItemStatus }) {
  return <span className={`work-status work-status--${status}`}><span aria-hidden="true" />{humanise(status)}</span>;
}

export function KindMark({ kind }: { kind: WorkItemKind }) {
  const symbol: Record<WorkItemKind, string> = { issue: "!", task: "✓", idea: "✦", question: "?", risk: "△" };
  return <span aria-hidden="true" className={`kind-mark kind-mark--${kind}`}>{symbol[kind]}</span>;
}

export function PriorityView({ priority }: { priority: Priority | null }) {
  if (!priority) return <span className="muted">—</span>;
  return <span className={`priority priority--${priority}`}><span aria-hidden="true" />{humanise(priority)}</span>;
}

