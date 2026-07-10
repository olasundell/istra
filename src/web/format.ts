import type { ActivityEvent, ActivityViewItem, DashboardActivityEvent, Project, ProjectUpdate } from "./types";

export function formatDate(value?: string | null, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return "No activity yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", options ?? { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function formatTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function humanise(value: string): string {
  return value.replace(/[._-]+/g, " ").replace(/^./, (character) => character.toUpperCase());
}

export function updateContent(update: ProjectUpdate): string {
  return update.currentRevision?.content ?? "";
}

export function activitySummary(event: ActivityEvent): string {
  const explicit = event.payload.summary ?? event.payload.title ?? event.payload.content;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  if (event.payload.changes && typeof event.payload.changes === "object") {
    const first = Object.entries(event.payload.changes as Record<string, unknown>)[0];
    if (first) {
      const [field, rawChange] = first;
      if (rawChange && typeof rawChange === "object") {
        const change = rawChange as { before?: unknown; after?: unknown };
        return `${humanise(field)}: ${formatChangeValue(change.before)} → ${formatChangeValue(change.after)}`;
      }
    }
  }
  if (Array.isArray(event.payload.changed) && event.payload.changed.length) {
    return `Changed ${event.payload.changed.map((field) => humanise(String(field)).toLocaleLowerCase()).join(", ")}`;
  }
  return humanise(event.eventType);
}

function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "None";
  if (typeof value === "string" && /^(active|paused|dormant|completed|planned|abandoned|open|blocked|resolved|dropped|in_progress)$/.test(value)) return humanise(value);
  return String(value);
}

export function toActivityView(event: ActivityEvent | DashboardActivityEvent, project?: Project): ActivityViewItem {
  const payloadKind = typeof event.payload.kind === "string" ? event.payload.kind : null;
  const inferredKind = event.eventType.includes("checkpoint") ? "checkpoint" : event.eventType.split(".").at(-1) ?? event.eventType;
  return {
    id: event.id,
    projectId: event.projectId,
    projectTitle: project?.title ?? ("projectTitle" in event ? event.projectTitle : undefined),
    kind: payloadKind ?? inferredKind,
    summary: activitySummary(event),
    occurredAt: event.createdAt,
    source: event.source,
  };
}
