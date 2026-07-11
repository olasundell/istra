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
  AcceptanceCriterion,
  ArtifactReference,
  CheckpointComparison,
  CheckpointSnapshot,
  CreateErrorReportInput,
  CreateEvidenceInput,
  CreateExternalBlockerInput,
  CreateRequirementInput,
  CreateRequirementStateInput,
  CreateRunInput,
  CreateWorkQueueInput,
  CreateWorkRelationInput,
  CreateWorkspaceInput,
  CreateWorkspaceRevisionInput,
  ErrorReport,
  Evidence,
  ExternalBlocker,
  MutationContext,
  ProjectPulseSummary,
  Requirement,
  RequirementRollup,
  RequirementStateDefinition,
  Run,
  TestSummary,
  UpdateErrorReportInput,
  UpdateRequirementInput,
  WorkQueue,
  WorkRelation,
  Workspace,
  WorkspaceRevision,
} from '../domain/contracts.js'

export type Awaitable<T> = T | Promise<T>

export interface ExportBundle {
  format: 'istra-export'
  formatVersion: 3 | 4
  exportedAt: string
  tables: Record<string, Array<Record<string, unknown>>>
}

export interface IstraRepository {
  listProjects(filters?: { state?: ProjectState; includeArchived?: boolean; q?: string }): Awaitable<Project[]>
  getProject(id: string): Awaitable<Project | null>
  getProjectDetail(id: string): Awaitable<ProjectDetail | null>
  createProject(input: CreateProjectInput, provenance: Provenance): Awaitable<Project>
  updateProject(id: string, input: UpdateProjectInput, provenance: Provenance): Awaitable<Project>
  archiveProject(id: string, expectedVersion: number, archived: boolean, provenance: Provenance): Awaitable<Project>
  listPhases(projectId: string, includeArchived?: boolean): Awaitable<Phase[]>
  createPhase(projectId: string, input: CreatePhaseInput, provenance: Provenance): Awaitable<Phase>
  updatePhase(id: string, input: UpdatePhaseInput, provenance: Provenance): Awaitable<Phase>
  listWorkItems(projectId: string, statuses?: string[]): Awaitable<WorkItem[]>
  listWorkItemsPage(projectId: string, limit: number, cursor?: string | null, statuses?: string[]): Awaitable<Page<WorkItem>>
  createWorkItem(projectId: string, input: CreateWorkItemInput, provenance: Provenance): Awaitable<WorkItem>
  updateWorkItem(id: string, input: UpdateWorkItemInput, provenance: Provenance): Awaitable<WorkItem>
  listUpdates(projectId: string, includeDeleted?: boolean): Awaitable<ProjectUpdate[]>
  listUpdatesPage(projectId: string, limit: number, cursor?: string | null, includeDeleted?: boolean): Awaitable<Page<ProjectUpdate>>
  getUpdateRevisions(updateId: string): Awaitable<ProjectUpdate['currentRevision'][]>
  createUpdate(projectId: string, input: CreateUpdateInput, provenance: Provenance): Awaitable<ProjectUpdate>
  reviseUpdate(updateId: string, input: ReviseUpdateInput, provenance: Provenance): Awaitable<ProjectUpdate>
  softDeleteUpdate(updateId: string, expectedVersion: number, provenance: Provenance): Awaitable<ProjectUpdate>
  saveCheckpoint(projectId: string, input: CheckpointInput, provenance: Provenance): Awaitable<ProjectUpdate>
  listLabels(): Awaitable<Label[]>
  createLabel(input: CreateLabelInput, provenance: Provenance): Awaitable<Label>
  attachLabel(workItemId: string, labelId: string, expectedVersion: number, provenance: Provenance): Awaitable<WorkItem>
  detachLabel(workItemId: string, labelId: string, expectedVersion: number, provenance: Provenance): Awaitable<WorkItem>
  listActivity(projectId: string, limit?: number): Awaitable<ActivityEvent[]>
  listActivityPage(projectId: string, limit: number, cursor?: string | null): Awaitable<Page<ActivityEvent>>
  listRecentActivity(limit?: number): Awaitable<DashboardActivityEvent[]>
  search(query: string, limit?: number, filters?: SearchFilters): Awaitable<SearchResult[]>
  exportAll(): Awaitable<ExportBundle>
  validateImport(bundle: ExportBundle): Awaitable<void>
  importAll(bundle: ExportBundle): Awaitable<void>
}

export interface OperationalRepository {
  runMutation<T>(context: MutationContext, operation: string, payload: unknown, work: () => Awaitable<T>): Awaitable<T>
  runIdempotent<T>(client: string, key: string, operation: string, payload: unknown, work: () => Awaitable<T>): Awaitable<T>
  listRequirementStates(projectId: string): Awaitable<RequirementStateDefinition[]>
  createRequirementState(projectId: string, input: CreateRequirementStateInput): Awaitable<RequirementStateDefinition>
  listRequirements(projectId: string): Awaitable<Requirement[]>
  listRequirementsPage(projectId: string, limit: number, cursor?: string | null): Awaitable<Page<Requirement>>
  getRequirement(id: string): Awaitable<Requirement | null>
  createRequirement(projectId: string, input: CreateRequirementInput): Awaitable<Requirement>
  updateRequirement(id: string, input: UpdateRequirementInput): Awaitable<Requirement>
  linkRequirementWork(projectId: string, requirementId: string, workItemId: string): Awaitable<void>
  unlinkRequirementWork(requirementId: string, workItemId: string): Awaitable<void>
  getRequirementRollup(projectId: string): Awaitable<RequirementRollup>
  listWorkQueues(projectId: string): Awaitable<WorkQueue[]>
  createWorkQueue(projectId: string, input: CreateWorkQueueInput): Awaitable<WorkQueue>
  listWorkItems(projectId: string, queueId?: string): Awaitable<WorkItem[]>
  listWorkItemsPage(projectId: string, limit: number, cursor?: string | null, queueId?: string): Awaitable<Page<WorkItem>>
  linkWorkItems(projectId: string, input: CreateWorkRelationInput): Awaitable<WorkRelation>
  unlinkWorkItems(id: string): Awaitable<void>
  listWorkRelations(projectId: string): Awaitable<WorkRelation[]>
  createExternalBlocker(projectId: string, input: CreateExternalBlockerInput): Awaitable<ExternalBlocker>
  listExternalBlockers(projectId: string, includeResolved?: boolean): Awaitable<ExternalBlocker[]>
  resolveExternalBlocker(id: string): Awaitable<ExternalBlocker>
  createWorkspace(input: CreateWorkspaceInput): Awaitable<Workspace>
  linkProjectWorkspace(projectId: string, workspaceId: string): Awaitable<void>
  createWorkspaceRevision(input: CreateWorkspaceRevisionInput): Awaitable<WorkspaceRevision>
  resolveProject(workspacePath: string): Awaitable<Project[]>
  createRun(projectId: string, input: CreateRunInput): Awaitable<{ run: Run; testSummary: TestSummary | null; artifacts: ArtifactReference[] }>
  listRuns(projectId: string): Awaitable<Run[]>
  listRunsPage(projectId: string, limit: number, cursor?: string | null): Awaitable<Page<Run>>
  createEvidence(projectId: string, input: CreateEvidenceInput): Awaitable<Evidence>
  listEvidence(projectId: string, includeStale?: boolean): Awaitable<Evidence[]>
  listEvidencePage(projectId: string, limit: number, cursor?: string | null, includeStale?: boolean): Awaitable<Page<Evidence>>
  createErrorReport(input: CreateErrorReportInput): Awaitable<ErrorReport>
  listErrorReportsPage(limit: number, cursor?: string | null, statuses?: ErrorReport['status'][], kinds?: ErrorReport['kind'][], component?: string): Awaitable<Page<ErrorReport>>
  getErrorReport(id: string): Awaitable<{ report: ErrorReport; history: ActivityEvent[] } | null>
  updateErrorReport(id: string, input: UpdateErrorReportInput): Awaitable<ErrorReport>
  captureCheckpointSnapshot(projectId: string, checkpointId: string): Awaitable<CheckpointSnapshot>
  getCheckpointSnapshot(checkpointId: string): Awaitable<CheckpointSnapshot | null>
  compareCheckpointSnapshots(leftCheckpointId: string, rightCheckpointId: string): Awaitable<CheckpointComparison>
  reconstructCheckpointState(checkpointId: string): Awaitable<Record<string, unknown> | null>
  getProjectPulseSummary(projectId: string): Awaitable<ProjectPulseSummary | null>
  search(query: string, limit?: number, filters?: SearchFilters): Awaitable<SearchResult[]>
}

export interface BackupFile {
  name: string
  modifiedAt: string
  size: number
}

export interface DataProtection {
  backend: 'sqlite' | 'postgresql'
  automatic: boolean
  importSupported: boolean
  databasePath?: string
  beforeWrite(): Promise<void>
  create(kind: 'daily' | 'weekly' | 'pre-migration' | 'pre-import', suffix?: string): Promise<string>
  list(): Promise<BackupFile[]>
}

export interface StorageStatus {
  backend: 'sqlite' | 'postgresql'
  target: string
  schemaVersion: number
  ready: boolean
  automaticBackups: boolean
  importSupported: boolean
}
