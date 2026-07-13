import { z } from 'zod'

export const automationWorkItemKinds = ['issue', 'task'] as const
export const automationAttemptObservationKinds = ['progress', 'verification', 'delivery', 'note'] as const
export const automationCompletionOutcomes = ['resolved', 'awaiting_approval', 'retryable', 'blocked', 'interrupted'] as const
export const automationGuardOutcomes = ['lease_lost', 'human_changed_state', 'project_paused', 'policy_disabled'] as const
export const automationReleaseReasons = ['manual', 'runner_shutdown', 'recovery', 'abandoned', 'expired'] as const
export const runnerAutomationReleaseReasons = ['runner_shutdown', 'abandoned'] as const

export const AutomationWorkItemKindSchema = z.enum(automationWorkItemKinds)
export const AutomationAttemptObservationKindSchema = z.enum(automationAttemptObservationKinds)
export const AutomationCompletionOutcomeSchema = z.enum(automationCompletionOutcomes)
export const AutomationReleaseReasonSchema = z.enum(automationReleaseReasons)
export const RunnerAutomationReleaseReasonSchema = z.enum(runnerAutomationReleaseReasons)

export type AutomationWorkItemKind = z.infer<typeof AutomationWorkItemKindSchema>
export type AutomationCompletionOutcome = z.infer<typeof AutomationCompletionOutcomeSchema>
export type AutomationTerminalOutcome = AutomationCompletionOutcome
export type AutomationGuardOutcome = typeof automationGuardOutcomes[number]
export type AutomationReleaseReason = z.infer<typeof AutomationReleaseReasonSchema>

export interface QueueAutomationPolicy {
  queueId: string
  projectId: string
  enabled: boolean
  allowedKinds: AutomationWorkItemKind[]
  maxActiveClaims: number
  leaseSeconds: number
  requiresManualApproval: boolean
  allowSameWorkerRecovery: boolean
  version: number
  createdAt: string
  updatedAt: string
}

export interface WorkLease {
  id: string
  projectId: string
  queueId: string
  workItemId: string
  workerId: string
  claimedWorkItemVersion: number
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  releasedAt: string | null
  releaseReason: AutomationReleaseReason | null
  terminalOutcome: AutomationTerminalOutcome | null
  version: number
}

export interface ClaimedWorkLease extends WorkLease {
  leaseToken: string
}

export interface AutomationDelivery {
  repositoryPath: string
  integrationBranch: string
  commitSha: string
  commitMessage: string
  artefactUri?: string | null
}

export interface AutomationAttemptObservation {
  id: string
  attemptId: string
  sequence: number
  kind: z.infer<typeof AutomationAttemptObservationKindSchema>
  summary: string
  runId: string | null
  evidenceId: string | null
  delivery: AutomationDelivery | null
  createdAt: string
}

export interface AutomationAttempt {
  id: string
  projectId: string
  queueId: string
  workItemId: string
  leaseId: string
  ordinal: number
  startedAt: string
  endedAt: string | null
  outcome: AutomationTerminalOutcome | null
  observations: AutomationAttemptObservation[]
}

export interface AutomationQueueChange {
  sequence: number
  projectId: string
  queueId: string
  eventType: string
  entityType: string
  entityId: string
  createdAt: string
}

export interface AutomationQueueFeed {
  cursor: string
  changes: AutomationQueueChange[]
  timedOut: boolean
}

export interface AutomationClaimUpdate {
  id: string
  kind: import('./contracts.js').UpdateKind
  content: string
  updatedAt: string
}

export interface AutomationClaimFeed extends AutomationQueueFeed {
  requirementIds: string[]
  blockerReasons: string[]
  currentCheckpoint: AutomationClaimUpdate | null
  recentUpdates: AutomationClaimUpdate[]
}

export interface AutomationQueueProbe {
  changes: AutomationQueueChange[]
  cursorSequence: number
  expiredLeases: WorkLease[]
  nextExpiryAt: string | null
}

export interface QueueAutomationLeaseSummary extends WorkLease {
  workItemTitle: string
  workItemStatus: import('./contracts.js').WorkItemStatus
  state: 'active' | 'expired'
}

export interface QueueAutomationOverview {
  policy: QueueAutomationPolicy
  activeLeases: QueueAutomationLeaseSummary[]
  expiredLeases: QueueAutomationLeaseSummary[]
  lastAttempt: AutomationAttempt | null
  cursor: string
}

export type ClaimAutomatedWorkResult =
  | { outcome: 'claimed'; item: import('./contracts.js').WorkItem; lease: ClaimedWorkLease; attempt: AutomationAttempt; feed: AutomationClaimFeed }
  | { outcome: 'empty'; cursor: string }
  | { outcome: 'policy_disabled' | 'project_paused' | 'capacity_reached'; cursor: string }

export type HeartbeatAutomatedWorkResult =
  | { outcome: 'heartbeat'; lease: WorkLease }
  | { outcome: AutomationGuardOutcome; lease: WorkLease; item: import('./contracts.js').WorkItem }

export type CompleteAutomatedWorkResult =
  | { outcome: AutomationCompletionOutcome; lease: WorkLease; item: import('./contracts.js').WorkItem }
  | { outcome: AutomationGuardOutcome; lease: WorkLease; item: import('./contracts.js').WorkItem }

export type ReleaseAutomatedWorkResult =
  { outcome: 'released' | 'already_released' | 'lease_lost'; lease: WorkLease; item: import('./contracts.js').WorkItem }

const boundedIdempotencyKey = z.string().trim().min(1).max(200)
const leaseToken = z.string().trim().min(32).max(500)

export const UpdateQueueAutomationPolicySchema = z.object({
  expectedVersion: z.number().int().positive().nullable(),
  enabled: z.boolean(),
  allowedKinds: z.array(AutomationWorkItemKindSchema).min(1).max(automationWorkItemKinds.length),
  maxActiveClaims: z.number().int().min(1).max(32),
  leaseSeconds: z.number().int().min(30).max(5_400),
  requiresManualApproval: z.boolean(),
  allowSameWorkerRecovery: z.boolean(),
}).strict()

export const ClaimNextAutomatedWorkSchema = z.object({
  workerId: z.string().trim().min(1).max(200),
  allowedKinds: z.array(AutomationWorkItemKindSchema).min(1).max(automationWorkItemKinds.length).optional(),
  leaseSeconds: z.number().int().min(30).max(5_400).optional(),
  idempotencyKey: boundedIdempotencyKey,
}).strict()

export const HeartbeatAutomatedWorkSchema = z.object({
  leaseToken,
  idempotencyKey: boundedIdempotencyKey,
}).strict()

export const AutomationDeliverySchema = z.object({
  repositoryPath: z.string().trim().min(1).max(4_000),
  integrationBranch: z.string().trim().min(1).max(500),
  commitSha: z.string().trim().regex(/^[0-9a-f]{7,64}$/i),
  commitMessage: z.string().trim().min(1).max(2_000),
  artefactUri: z.string().trim().min(1).max(4_000).nullable().optional(),
}).strict()

export const RecordAutomationAttemptSchema = z.object({
  leaseToken,
  kind: AutomationAttemptObservationKindSchema,
  summary: z.string().trim().min(1).max(20_000),
  runId: z.string().uuid().nullable().optional(),
  evidenceId: z.string().uuid().nullable().optional(),
  delivery: AutomationDeliverySchema.nullable().optional(),
  idempotencyKey: boundedIdempotencyKey,
}).strict()

export const CompleteAutomatedWorkSchema = z.object({
  leaseToken,
  outcome: AutomationCompletionOutcomeSchema,
  expectedWorkItemVersion: z.number().int().positive(),
  idempotencyKey: boundedIdempotencyKey,
}).strict()

export const RunnerReleaseAutomatedWorkSchema = z.object({
  leaseToken,
  reason: RunnerAutomationReleaseReasonSchema,
  idempotencyKey: boundedIdempotencyKey,
}).strict()

export const OperatorReleaseAutomatedWorkSchema = z.object({
  expectedLeaseVersion: z.number().int().positive(),
  reason: z.literal('manual').default('manual'),
  idempotencyKey: boundedIdempotencyKey,
}).strict()

export const WaitForQueueChangesSchema = z.object({
  cursor: z.string().trim().min(1).max(2_000).optional(),
  timeoutSeconds: z.number().int().min(0).max(60).default(30),
}).strict()

export type UpdateQueueAutomationPolicyInput = z.infer<typeof UpdateQueueAutomationPolicySchema>
export type ClaimNextAutomatedWorkInput = z.infer<typeof ClaimNextAutomatedWorkSchema>
export type HeartbeatAutomatedWorkInput = z.infer<typeof HeartbeatAutomatedWorkSchema>
export type RecordAutomationAttemptInput = z.infer<typeof RecordAutomationAttemptSchema>
export type CompleteAutomatedWorkInput = z.infer<typeof CompleteAutomatedWorkSchema>
export type RunnerReleaseAutomatedWorkInput = z.infer<typeof RunnerReleaseAutomatedWorkSchema>
export type OperatorReleaseAutomatedWorkInput = z.infer<typeof OperatorReleaseAutomatedWorkSchema>
export type WaitForQueueChangesInput = z.infer<typeof WaitForQueueChangesSchema>
