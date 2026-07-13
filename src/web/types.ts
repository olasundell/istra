export {
  phaseStates,
  priorities,
  projectStates,
  requirementKinds,
  requirementStateSemantics,
  relationKinds,
  runOutcomes,
  evidenceResults,
  updateKinds,
  workItemKinds,
  workItemStatuses,
} from "../domain/contracts";

export type {
  AutomationAttempt,
  AutomationAttemptObservation,
  AutomationQueueFeed,
  QueueAutomationLeaseSummary,
  QueueAutomationOverview,
  QueueAutomationPolicy,
  UpdateQueueAutomationPolicyInput,
  WorkLease,
} from "../domain/automation";

export type {
  AcceptanceCriterion,
  ActivityEvent,
  ArtifactReference,
  DashboardActivityEvent,
  CheckpointInput,
  CheckpointComparison,
  CheckpointSaveResult,
  CreateLabelInput,
  CreatePhaseInput,
  CreateProjectInput,
  CreateUpdateInput,
  CreateWorkItemInput,
  Evidence,
  ExternalBlocker,
  Label,
  Phase,
  Page,
  PhaseState,
  Priority,
  Project,
  ProjectDetail,
  ProjectPulse,
  ProjectState,
  ProjectUpdate,
  ProjectPulseSummary,
  Requirement,
  RequirementRollup,
  RequirementRollupBucket,
  RequirementStateDefinition,
  Run,
  SearchResult,
  TestSummary,
  UpdateKind,
  UpdateRevision,
  UpdateProjectInput,
  WorkItem,
  WorkItemKind,
  WorkItemStatus,
  WorkQueue,
  WorkRelation,
  Workspace,
  WorkspaceRevision,
} from "../domain/contracts";

export interface BackupStatus {
  backend?: "sqlite" | "postgresql";
  automaticBackups?: boolean;
  importSupported?: boolean;
  databasePath?: string;
  lastBackupAt?: string | null;
  nextBackupKind?: string;
  backups?: Array<{ name: string; kind: string; createdAt: string; size?: number }>;
}

export interface ActivityViewItem {
  id: string;
  projectId: string | null;
  projectTitle?: string;
  kind: string;
  summary: string;
  occurredAt: string;
  source?: string | null;
}
