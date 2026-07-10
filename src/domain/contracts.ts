import { z } from 'zod'
import { validateRunInvariants } from './run-invariants.js'

export const projectStates = ['active', 'paused', 'dormant', 'completed'] as const
export const phaseStates = ['planned', 'active', 'completed', 'abandoned'] as const
export const workItemKinds = ['issue', 'task', 'idea', 'question', 'risk'] as const
export const workItemStatuses = ['open', 'in_progress', 'blocked', 'resolved', 'dropped'] as const
export const updateKinds = ['note', 'progress', 'decision', 'discovery', 'checkpoint'] as const
export const priorities = ['low', 'medium', 'high', 'critical'] as const
export const requirementKinds = ['goal', 'capability', 'requirement'] as const
export const requirementStateSemantics = ['open', 'partial', 'proven', 'defect'] as const
export const relationKinds = ['depends_on', 'blocks', 'relates_to'] as const
export const runOutcomes = ['recorded', 'verified', 'failed', 'interrupted'] as const
export const evidenceResults = ['recorded', 'verified', 'failed', 'interrupted'] as const
export const proofStatuses = ['open', 'partial', 'proven', 'defect'] as const
export const validationStatuses = ['validated', 'legacy_unvalidated', 'overridden'] as const

export const ProjectStateSchema = z.enum(projectStates)
export const PhaseStateSchema = z.enum(phaseStates)
export const WorkItemKindSchema = z.enum(workItemKinds)
export const WorkItemStatusSchema = z.enum(workItemStatuses)
export const UpdateKindSchema = z.enum(updateKinds)
export const PrioritySchema = z.enum(priorities)
export const RequirementKindSchema = z.enum(requirementKinds)
export const RequirementStateSemanticSchema = z.enum(requirementStateSemantics)
export const RelationKindSchema = z.enum(relationKinds)
export const RunOutcomeSchema = z.enum(runOutcomes)
export const EvidenceResultSchema = z.enum(evidenceResults)
export const ProofStatusSchema = z.enum(proofStatuses)
export const ValidationStatusSchema = z.enum(validationStatuses)

export type ProjectState = z.infer<typeof ProjectStateSchema>
export type PhaseState = z.infer<typeof PhaseStateSchema>
export type WorkItemKind = z.infer<typeof WorkItemKindSchema>
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>
export type UpdateKind = z.infer<typeof UpdateKindSchema>
export type Priority = z.infer<typeof PrioritySchema>
export type RequirementKind = z.infer<typeof RequirementKindSchema>
export type RequirementStateSemantic = z.infer<typeof RequirementStateSemanticSchema>
export type RelationKind = z.infer<typeof RelationKindSchema>
export type RunOutcome = z.infer<typeof RunOutcomeSchema>
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>
export type ProofStatus = z.infer<typeof ProofStatusSchema>
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>
export type Provenance = { source: 'ui' | 'mcp' | 'import' | 'system'; client?: string; actor?: string; idempotencyKey?: string | null; occurredAt?: string }
export type MutationContext = Provenance & { actor: string; idempotencyKey: string | null; occurredAt: string }

export interface Project {
  id: string
  title: string
  description: string | null
  intent: string | null
  deadline: string | null
  completionCriteria: string | null
  state: ProjectState
  currentFocus: string | null
  nextAction: string | null
  blockers: string[]
  currentCheckpointId: string | null
  archivedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
  lastActivityAt: string
}

export interface Phase {
  id: string
  projectId: string
  name: string
  description: string | null
  status: PhaseState
  position: number
  archivedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface WorkItem {
  id: string
  projectId: string
  phaseId: string | null
  kind: WorkItemKind
  title: string
  description: string | null
  status: WorkItemStatus
  priority: Priority | null
  labels: Label[]
  version: number
  createdAt: string
  updatedAt: string
  stableKey?: string | null
  parentId?: string | null
  queueId?: string | null
  rank?: string | null
  effectiveBlocked?: boolean
  blockerReasons?: string[]
}

export interface Label {
  id: string
  name: string
  colour: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export const PulseSnapshotSchema = z.object({
  state: ProjectStateSchema,
  currentFocus: z.string().nullable(),
  nextAction: z.string().nullable(),
  blockers: z.array(z.string()),
  activePhaseIds: z.array(z.string().uuid()),
  unresolvedWorkItemIds: z.array(z.string().uuid()),
  capturedAt: z.string().datetime({ offset: true }),
})
export type PulseSnapshot = z.infer<typeof PulseSnapshotSchema>

export interface UpdateRevision {
  id: string
  updateId: string
  revision: number
  content: string
  snapshot: PulseSnapshot | null
  source: string
  client: string | null
  createdAt: string
}

export interface ProjectUpdate {
  id: string
  projectId: string
  kind: UpdateKind
  currentRevision: UpdateRevision
  deletedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface ActivityEvent {
  id: string
  projectId: string | null
  entityType: string
  entityId: string
  eventType: string
  payload: Record<string, unknown>
  source: string
  client: string | null
  actor: string
  idempotencyKey: string | null
  createdAt: string
}

export interface DashboardActivityEvent extends ActivityEvent {
  projectId: string
  projectTitle: string
}

export interface ProjectPulse {
  state: ProjectState
  currentFocus: string | null
  nextAction: string | null
  blockers: string[]
  currentCheckpoint: ProjectUpdate | null
  activePhases: Phase[]
  unresolvedWorkItems: WorkItem[]
}

export interface ProjectDetail {
  project: Project
  pulse: ProjectPulse
  phases: Phase[]
  workItems: WorkItem[]
  updates: ProjectUpdate[]
  labels: Label[]
  activity: ActivityEvent[]
}

export interface SearchResult {
  type: 'project' | 'phase' | 'work_item' | 'update' | 'requirement' | 'run' | 'evidence'
  id: string
  projectId: string
  title: string
  excerpt: string
  score: number
}

export interface SearchFilters {
  projectId?: string
  entityTypes?: SearchResult['type'][]
  state?: string
  phaseId?: string
  requirementId?: string
  evidenceResult?: EvidenceResult
  from?: string
  to?: string
}

export interface RequirementStateDefinition {
  id: string
  projectId: string
  name: string
  semantic: RequirementStateSemantic
  position: number
  colour: string | null
  createdAt: string
  updatedAt: string
}

export interface AcceptanceCriterion {
  id: string
  requirementId: string
  title: string
  description: string | null
  position: number
  required: boolean
  version: number
  archivedAt: string | null
  proofStatus: ProofStatus
  proofEvidenceId: string | null
  proofReason: string
  createdAt: string
  updatedAt: string
}

export interface Requirement {
  id: string
  projectId: string
  stableKey: string
  kind: RequirementKind
  parentId: string | null
  title: string
  description: string | null
  stateId: string
  responsiblePhaseId: string | null
  version: number
  createdAt: string
  updatedAt: string
  criteria: AcceptanceCriterion[]
  relatedPhaseIds: string[]
  linkedWorkItemIds: string[]
  linkedEvidenceIds: string[]
  gate: 'satisfied' | 'unsatisfied' | 'not_configured'
  proofStatus: ProofStatus
  proofExplanation: RequirementProofExplanation
}

export interface RequirementProofExplanation {
  status: ProofStatus
  requiredCriteria: number
  provenCriteria: number
  defectiveCriteria: number
  partialCriteria: number
  openCriteria: number
  criteria: Array<Pick<AcceptanceCriterion, 'id' | 'title' | 'required' | 'archivedAt' | 'proofStatus' | 'proofEvidenceId' | 'proofReason'>>
}

export interface RequirementRollup {
  total: number
  bySemantic: Record<RequirementStateSemantic, number>
  byProofStatus: Record<ProofStatus, number>
  gateFailures: number
  defects: number
  byCapability: RequirementRollupBucket[]
  byMilestone: RequirementRollupBucket[]
  byGoal: RequirementRollupBucket[]
}

export interface RequirementRollupBucket {
  id: string
  stableKey?: string
  name: string
  counts: Record<RequirementStateSemantic, number>
  total: number
}

export interface WorkQueue {
  id: string
  projectId: string
  name: string
  description: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface WorkRelation {
  id: string
  projectId: string
  fromWorkItemId: string
  toWorkItemId: string
  kind: RelationKind
  createdAt: string
}

export interface ExternalBlocker {
  id: string
  projectId: string
  workItemId: string | null
  content: string
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Workspace {
  id: string
  name: string
  canonicalRoot: string
  aliases: string[]
  remote: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkspaceRevision {
  id: string
  workspaceId: string
  branch: string | null
  commit: string | null
  dirty: boolean
  diffHash: string | null
  capturedAt: string
}

export interface Run {
  id: string
  projectId: string
  workspaceRevisionId: string | null
  command: string
  workingDirectory: string | null
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  outcome: RunOutcome
  exitCode: number | null
  toolchain: Record<string, string>
  stdoutExcerpt: string | null
  stderrExcerpt: string | null
  stdoutTruncated: boolean
  stderrTruncated: boolean
  artifacts: ArtifactReference[]
  validationStatus: ValidationStatus
  redaction: RedactionMetadata
  createdAt: string
}

export interface TestSummary {
  id: string
  runId: string
  scope: string
  passed: number
  failed: number
  skipped: number
  targetCount: number
  createdAt: string
}

export interface ArtifactReference {
  id: string
  runId: string | null
  uri: string
  mediaType: string | null
  byteCount: number | null
  digest: string | null
  createdAt: string
}

export interface RedactionMetadata {
  count: number
  fields: string[]
}

export interface EvidenceCriterionLink {
  criterionId: string
  criterionVersion: number
  stale: boolean
}

export interface EvidenceOverride {
  reason: string
  actor: string
  source: Provenance['source']
  client: string | null
  createdAt: string
}

export interface Evidence {
  id: string
  ordinal: number
  projectId: string
  runId: string | null
  result: EvidenceResult
  summary: string
  targetVersion: number | null
  stale: boolean
  staleReason: string | null
  createdAt: string
  updatedAt: string
  requirementIds: string[]
  workItemIds: string[]
  updateIds: string[]
  checkpointIds: string[]
  artifacts: ArtifactReference[]
  criterionLinks: EvidenceCriterionLink[]
  validationStatus: ValidationStatus
  redaction: RedactionMetadata
  override: EvidenceOverride | null
}

export interface CheckpointSnapshot {
  id: string
  checkpointId: string
  schemaVersion: 3
  capturedAt: string
  document: Record<string, unknown>
  digest: string
}

export interface CheckpointSaveResult {
  checkpoint: ProjectUpdate
  snapshot: Pick<CheckpointSnapshot, 'id' | 'digest' | 'schemaVersion' | 'capturedAt'>
}

export interface CheckpointComparison {
  leftCheckpointId: string
  rightCheckpointId: string
  same: boolean
  changedSections: string[]
  leftDigest: string
  rightDigest: string
  leftLegacy: boolean
  rightLegacy: boolean
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

export interface ProjectPulseSummary {
  project: Project
  currentCheckpoint: { id: string; content: string; createdAt: string } | null
  activePhases: Array<Pick<Phase, 'id' | 'name' | 'status'>>
  requirementRollup: RequirementRollup
  queueHead: WorkItem[]
  blockers: ExternalBlocker[]
  staleEvidenceCount: number
  failedEvidenceCount: number
}

const nullableText = z.string().trim().max(20_000).nullable().optional()
const isoDate = z.string().datetime({ offset: true }).nullable().optional()
export const ProvenanceSchema = z.object({
  source: z.enum(['ui', 'mcp', 'import', 'system']).default('ui'),
  client: z.string().trim().max(200).optional(),
}).default({ source: 'ui' })

export const CreateProjectSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: nullableText,
  intent: nullableText,
  deadline: isoDate,
  completionCriteria: nullableText,
  source: z.string().optional(),
})

export const UpdateProjectSchema = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(240).optional(),
  description: nullableText,
  intent: nullableText,
  deadline: isoDate,
  completionCriteria: nullableText,
  state: ProjectStateSchema.optional(),
  currentFocus: nullableText,
  nextAction: nullableText,
  blockers: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
})

export const CreatePhaseSchema = z.object({
  name: z.string().trim().min(1).max(240),
  description: nullableText,
  status: PhaseStateSchema.default('planned'),
  position: z.number().int().nonnegative().optional(),
})
export const UpdatePhaseSchema = CreatePhaseSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
  archived: z.boolean().optional(),
})

export const CreateWorkItemSchema = z.object({
  stableKey: z.string().trim().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/).nullable().optional(),
  phaseId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  queueId: z.string().uuid().nullable().optional(),
  rank: z.string().trim().min(1).max(200).nullable().optional(),
  kind: WorkItemKindSchema,
  title: z.string().trim().min(1).max(500),
  description: nullableText,
  status: WorkItemStatusSchema.default('open'),
  priority: PrioritySchema.nullable().optional(),
  labelIds: z.array(z.string().uuid()).max(50).optional(),
  requirementIds: z.array(z.string().uuid()).max(100).optional(),
  relatedPhaseIds: z.array(z.string().uuid()).max(100).optional(),
})
export const UpdateWorkItemSchema = CreateWorkItemSchema.partial().extend({ expectedVersion: z.number().int().positive() })

export const CreateUpdateSchema = z.object({
  kind: UpdateKindSchema.exclude(['checkpoint']),
  content: z.string().trim().min(1).max(100_000),
})
export const ReviseUpdateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  content: z.string().trim().min(1).max(100_000),
})
export const CheckpointSchema = z.object({
  expectedVersion: z.number().int().positive(),
  content: z.string().trim().min(1).max(100_000),
  currentFocus: nullableText,
  nextAction: nullableText,
  blockers: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
})

export const CreateLabelSchema = z.object({
  name: z.string().trim().min(1).max(100),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
})

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>
export type CreatePhaseInput = z.infer<typeof CreatePhaseSchema>
export type UpdatePhaseInput = z.infer<typeof UpdatePhaseSchema>
export type CreateWorkItemInput = z.input<typeof CreateWorkItemSchema>
export type UpdateWorkItemInput = z.infer<typeof UpdateWorkItemSchema>
export type CreateUpdateInput = z.infer<typeof CreateUpdateSchema>
export type ReviseUpdateInput = z.infer<typeof ReviseUpdateSchema>
export type CheckpointInput = z.infer<typeof CheckpointSchema>
export type CreateLabelInput = z.infer<typeof CreateLabelSchema>

export const CreateRequirementStateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  semantic: RequirementStateSemanticSchema,
  position: z.number().int().nonnegative().optional(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
})
export const AcceptanceCriterionInputSchema = z.object({
  id: z.string().uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(500),
  description: nullableText,
  required: z.boolean().default(true),
}).superRefine((criterion, context) => {
  if (criterion.id && criterion.expectedVersion === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedVersion'], message: 'expectedVersion is required when updating an existing criterion' })
  if (!criterion.id && criterion.expectedVersion !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedVersion'], message: 'expectedVersion requires an existing criterion id' })
})
export const CreateRequirementSchema = z.object({
  stableKey: z.string().trim().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  kind: RequirementKindSchema,
  parentId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(500),
  description: nullableText,
  stateId: z.string().uuid().optional(),
  responsiblePhaseId: z.string().uuid().nullable().optional(),
  relatedPhaseIds: z.array(z.string().uuid()).max(100).optional(),
  criteria: z.array(AcceptanceCriterionInputSchema).max(100).optional(),
})
export const UpdateRequirementSchema = CreateRequirementSchema.partial().extend({ expectedVersion: z.number().int().positive() })
export const CreateRequirementLinkSchema = z.object({
  requirementId: z.string().uuid(),
  workItemId: z.string().uuid(),
})
export const CreateWorkQueueSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: nullableText,
})
export const CreateWorkRelationSchema = z.object({
  fromWorkItemId: z.string().uuid(),
  toWorkItemId: z.string().uuid(),
  kind: RelationKindSchema,
})
export const CreateExternalBlockerSchema = z.object({
  workItemId: z.string().uuid().nullable().optional(),
  content: z.string().trim().min(1).max(2_000),
})
export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  canonicalRoot: z.string().trim().min(1).max(4_000),
  aliases: z.array(z.string().trim().min(1).max(4_000)).max(20).optional(),
  remote: z.string().trim().max(2_000).nullable().optional(),
})
export const CreateWorkspaceRevisionSchema = z.object({
  workspaceId: z.string().uuid(),
  branch: z.string().trim().max(500).nullable().optional(),
  commit: z.string().trim().max(200).nullable().optional(),
  dirty: z.boolean().default(false),
  diffHash: z.string().trim().max(200).nullable().optional(),
})
export const CreateArtifactSchema = z.object({
  uri: z.string().trim().min(1).max(4_000),
  mediaType: z.string().trim().max(200).nullable().optional(),
  byteCount: z.number().int().nonnegative().nullable().optional(),
  digest: z.string().trim().max(200).nullable().optional(),
})
export const CreateRunObjectSchema = z.object({
  workspaceRevisionId: z.string().uuid().nullable().optional(),
  command: z.string().trim().min(1).max(4_000),
  workingDirectory: z.string().trim().max(4_000).nullable().optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  endedAt: z.string().datetime({ offset: true }).nullable().optional(),
  outcome: RunOutcomeSchema.default('recorded'),
  exitCode: z.number().int().nullable().optional(),
  toolchain: z.record(z.string().max(200)).optional(),
  stdoutExcerpt: z.string().max(32_768).nullable().optional(),
  stderrExcerpt: z.string().max(32_768).nullable().optional(),
  stdoutTruncated: z.boolean().default(false),
  stderrTruncated: z.boolean().default(false),
  artifacts: z.array(CreateArtifactSchema).max(100).optional(),
  testSummary: z.object({
    scope: z.string().trim().min(1).max(500),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    targetCount: z.number().int().nonnegative(),
  }).optional(),
})
export const CreateRunSchema = CreateRunObjectSchema.superRefine((run, context) => {
  const startedAt = run.startedAt ?? new Date().toISOString()
  const endedAt = run.endedAt ?? null
  for (const violation of validateRunInvariants({ ...run, startedAt, endedAt })) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: violation.path.split('.'),
      message: violation.message,
    })
  }
})
export const CreateEvidenceSchema = z.object({
  runId: z.string().uuid().nullable().optional(),
  result: EvidenceResultSchema,
  summary: z.string().trim().min(1).max(4_000),
  targetVersion: z.number().int().positive().nullable().optional(),
  requirementIds: z.array(z.string().uuid()).max(100).optional(),
  criterionIds: z.array(z.string().uuid()).max(100).optional(),
  workItemIds: z.array(z.string().uuid()).max(100).optional(),
  updateIds: z.array(z.string().uuid()).max(100).optional(),
  checkpointIds: z.array(z.string().uuid()).max(100).optional(),
  artifacts: z.array(CreateArtifactSchema).max(100).optional(),
  override: z.object({ reason: z.string().trim().min(20).max(2_000) }).optional(),
})
export const PageRequestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().max(500).nullable().optional(),
})

export type CreateRequirementStateInput = z.infer<typeof CreateRequirementStateSchema>
export type CreateRequirementInput = z.infer<typeof CreateRequirementSchema>
export type UpdateRequirementInput = z.infer<typeof UpdateRequirementSchema>
export type CreateWorkQueueInput = z.infer<typeof CreateWorkQueueSchema>
export type CreateWorkRelationInput = z.infer<typeof CreateWorkRelationSchema>
export type CreateExternalBlockerInput = z.infer<typeof CreateExternalBlockerSchema>
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>
export type CreateWorkspaceRevisionInput = z.infer<typeof CreateWorkspaceRevisionSchema>
export type CreateRunInput = z.infer<typeof CreateRunSchema>
export type CreateEvidenceInput = z.infer<typeof CreateEvidenceSchema>
