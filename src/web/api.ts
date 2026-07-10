import type {
  ActivityEvent,
  BackupStatus,
  CheckpointInput,
  CreateLabelInput,
  CreatePhaseInput,
  CreateProjectInput,
  CreateUpdateInput,
  CreateWorkItemInput,
  DashboardActivityEvent,
  Label,
  Phase,
  Project,
  ProjectDetail,
  ProjectUpdate,
  SearchResult,
  UpdateRevision,
  WorkItem,
} from "./types";

const API_ROOT = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function unwrap<T>(body: unknown): T {
  if (body && typeof body === "object" && "data" in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(`${API_ROOT}${path}`, { ...init, headers });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { error?: { code?: string; message?: string }; message?: string } | null;
    throw new ApiError(
      problem?.error?.message ?? problem?.message ?? `Request failed with status ${response.status}`,
      response.status,
      problem?.error?.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return unwrap<T>(await response.json());
}

function queryString(values: Record<string, string | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const result = query.toString();
  return result ? `?${result}` : "";
}

export const api = {
  listProjects: (options: { state?: string; includeArchived?: boolean; q?: string } = {}) =>
    request<Project[]>(`/projects${queryString(options)}`),
  getProject: (id: string) => request<ProjectDetail>(`/projects/${id}`),
  createProject: (payload: CreateProjectInput) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(payload) }),
  updateProject: (project: Project, payload: Partial<Project> & { expectedVersion: number }) =>
    request<Project>(`/projects/${project.id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  setArchived: (project: Project, archived: boolean) =>
    request<Project>(`/projects/${project.id}/archive`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: project.version, archived }),
    }),
  createCheckpoint: (project: Project, payload: Omit<CheckpointInput, "expectedVersion">) =>
    request<ProjectUpdate>(`/projects/${project.id}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({ ...payload, expectedVersion: project.version }),
    }),

  listPhases: (projectId: string, includeArchived = false) => request<Phase[]>(`/projects/${projectId}/phases${queryString({ includeArchived })}`),
  createPhase: (projectId: string, payload: CreatePhaseInput) =>
    request<Phase>(`/projects/${projectId}/phases`, { method: "POST", body: JSON.stringify(payload) }),
  updatePhase: (phase: Phase, payload: Partial<Phase> & { archived?: boolean }) =>
    request<Phase>(`/phases/${phase.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...payload, expectedVersion: phase.version }),
    }),

  listLabels: () => request<Label[]>("/labels"),
  createLabel: (payload: CreateLabelInput) =>
    request<Label>("/labels", { method: "POST", body: JSON.stringify(payload) }),
  attachLabel: (item: WorkItem, labelId: string) =>
    request<WorkItem>(`/work-items/${item.id}/labels/${labelId}`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: item.version }),
    }),
  detachLabel: (item: WorkItem, labelId: string) =>
    request<WorkItem>(`/work-items/${item.id}/labels/${labelId}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: item.version }),
    }),

  listWorkItems: (projectId: string) => request<WorkItem[]>(`/projects/${projectId}/work-items`),
  createWorkItem: (projectId: string, payload: CreateWorkItemInput) =>
    request<WorkItem>(`/projects/${projectId}/work-items`, { method: "POST", body: JSON.stringify(payload) }),
  updateWorkItem: (item: WorkItem, payload: Partial<WorkItem>) =>
    request<WorkItem>(`/work-items/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...payload, expectedVersion: item.version }),
    }),

  listUpdates: (projectId: string) => request<ProjectUpdate[]>(`/projects/${projectId}/updates`),
  createUpdate: (projectId: string, payload: CreateUpdateInput) =>
    request<ProjectUpdate>(`/projects/${projectId}/updates`, { method: "POST", body: JSON.stringify(payload) }),
  reviseUpdate: (update: ProjectUpdate, content: string) =>
    request<ProjectUpdate>(`/updates/${update.id}/revisions`, {
      method: "POST",
      body: JSON.stringify({ content, expectedVersion: update.version }),
    }),
  listUpdateRevisions: (updateId: string) => request<UpdateRevision[]>(`/updates/${updateId}/revisions`),
  deleteUpdate: (update: ProjectUpdate) =>
    request<ProjectUpdate>(`/updates/${update.id}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: update.version }),
    }),

  getActivity: (projectId: string) => request<ActivityEvent[]>(`/projects/${projectId}/activity`),
  listRecentActivity: (limit = 10) => request<DashboardActivityEvent[]>(`/activity${queryString({ limit: String(limit) })}`),
  search: (q: string) => request<SearchResult[]>(`/search${queryString({ q })}`),
  backupStatus: () => request<BackupStatus>("/backups"),
  exportUrl: `${API_ROOT}/export`,
  importData: (document: unknown) =>
    request<{ imported: boolean }>("/import", { method: "POST", body: JSON.stringify(document) }),
};
