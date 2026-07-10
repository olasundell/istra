export {
  phaseStates,
  priorities,
  projectStates,
  updateKinds,
  workItemKinds,
  workItemStatuses,
} from "../domain/contracts";

export type {
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
  PhaseState,
  Priority,
  Project,
  ProjectDetail,
  ProjectPulse,
  ProjectState,
  ProjectUpdate,
  SearchResult,
  UpdateKind,
  UpdateRevision,
  UpdateProjectInput,
  WorkItem,
  WorkItemKind,
  WorkItemStatus,
} from "../domain/contracts";

export interface BackupStatus {
  databasePath?: string;
  lastBackupAt?: string | null;
  nextBackupKind?: string;
  backups?: Array<{ name: string; kind: string; createdAt: string; size?: number }>;
}

export interface ActivityViewItem {
  id: string;
  projectId: string;
  projectTitle?: string;
  kind: string;
  summary: string;
  occurredAt: string;
  source?: string | null;
}
