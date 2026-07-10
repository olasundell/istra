import type {
  ActivityEvent,
  DashboardActivityEvent,
  CheckpointInput,
  CreateLabelInput,
  CreatePhaseInput,
  CreateProjectInput,
  CreateUpdateInput,
  CreateWorkItemInput,
  Label,
  Phase,
  Project,
  ProjectDetail,
  ProjectState,
  ProjectUpdate,
  Provenance,
  ReviseUpdateInput,
  SearchResult,
  SearchFilters,
  UpdatePhaseInput,
  UpdateProjectInput,
  UpdateWorkItemInput,
  WorkItem,
  Page,
} from '../domain/contracts.js'

export interface ExportBundle {
  format: 'istra-export'
  formatVersion: 1 | 2
  exportedAt: string
  tables: Record<string, Array<Record<string, unknown>>>
}

export interface IstraRepository {
  listProjects(filters?: { state?: ProjectState; includeArchived?: boolean; q?: string }): Project[]
  getProject(id: string): Project | null
  getProjectDetail(id: string): ProjectDetail | null
  createProject(input: CreateProjectInput, provenance: Provenance): Project
  updateProject(id: string, input: UpdateProjectInput, provenance: Provenance): Project
  archiveProject(id: string, expectedVersion: number, archived: boolean, provenance: Provenance): Project
  listPhases(projectId: string, includeArchived?: boolean): Phase[]
  createPhase(projectId: string, input: CreatePhaseInput, provenance: Provenance): Phase
  updatePhase(id: string, input: UpdatePhaseInput, provenance: Provenance): Phase
  listWorkItems(projectId: string, statuses?: string[]): WorkItem[]
  listWorkItemsPage(projectId: string, limit: number, cursor?: string | null, statuses?: string[]): Page<WorkItem>
  createWorkItem(projectId: string, input: CreateWorkItemInput, provenance: Provenance): WorkItem
  updateWorkItem(id: string, input: UpdateWorkItemInput, provenance: Provenance): WorkItem
  listUpdates(projectId: string, includeDeleted?: boolean): ProjectUpdate[]
  listUpdatesPage(projectId: string, limit: number, cursor?: string | null, includeDeleted?: boolean): Page<ProjectUpdate>
  getUpdateRevisions(updateId: string): ProjectUpdate['currentRevision'][]
  createUpdate(projectId: string, input: CreateUpdateInput, provenance: Provenance): ProjectUpdate
  reviseUpdate(updateId: string, input: ReviseUpdateInput, provenance: Provenance): ProjectUpdate
  softDeleteUpdate(updateId: string, expectedVersion: number, provenance: Provenance): ProjectUpdate
  saveCheckpoint(projectId: string, input: CheckpointInput, provenance: Provenance): ProjectUpdate
  listLabels(): Label[]
  createLabel(input: CreateLabelInput, provenance: Provenance): Label
  attachLabel(workItemId: string, labelId: string, expectedVersion: number, provenance: Provenance): WorkItem
  detachLabel(workItemId: string, labelId: string, expectedVersion: number, provenance: Provenance): WorkItem
  listActivity(projectId: string, limit?: number): ActivityEvent[]
  listActivityPage(projectId: string, limit: number, cursor?: string | null): Page<ActivityEvent>
  listRecentActivity(limit?: number): DashboardActivityEvent[]
  search(query: string, limit?: number, filters?: SearchFilters): SearchResult[]
  exportAll(): ExportBundle
  validateImport(bundle: ExportBundle): void
  importAll(bundle: ExportBundle): void
}
