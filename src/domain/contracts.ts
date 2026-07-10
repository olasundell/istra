import { z } from 'zod'

export const projectStates = ['active', 'paused', 'dormant', 'completed'] as const
export const phaseStates = ['planned', 'active', 'completed', 'abandoned'] as const
export const workItemKinds = ['issue', 'task', 'idea', 'question', 'risk'] as const
export const workItemStatuses = ['open', 'in_progress', 'blocked', 'resolved', 'dropped'] as const
export const updateKinds = ['note', 'progress', 'decision', 'discovery', 'checkpoint'] as const
export const priorities = ['low', 'medium', 'high', 'critical'] as const

export const ProjectStateSchema = z.enum(projectStates)
export const PhaseStateSchema = z.enum(phaseStates)
export const WorkItemKindSchema = z.enum(workItemKinds)
export const WorkItemStatusSchema = z.enum(workItemStatuses)
export const UpdateKindSchema = z.enum(updateKinds)
export const PrioritySchema = z.enum(priorities)

export type ProjectState = z.infer<typeof ProjectStateSchema>
export type PhaseState = z.infer<typeof PhaseStateSchema>
export type WorkItemKind = z.infer<typeof WorkItemKindSchema>
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>
export type UpdateKind = z.infer<typeof UpdateKindSchema>
export type Priority = z.infer<typeof PrioritySchema>
export type Provenance = { source: 'ui' | 'mcp' | 'import' | 'system'; client?: string }

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
  projectId: string
  entityType: string
  entityId: string
  eventType: string
  payload: Record<string, unknown>
  source: string
  client: string | null
  createdAt: string
}

export interface DashboardActivityEvent extends ActivityEvent {
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
  type: 'project' | 'phase' | 'work_item' | 'update'
  id: string
  projectId: string
  title: string
  excerpt: string
  score: number
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
  phaseId: z.string().uuid().nullable().optional(),
  kind: WorkItemKindSchema,
  title: z.string().trim().min(1).max(500),
  description: nullableText,
  status: WorkItemStatusSchema.default('open'),
  priority: PrioritySchema.nullable().optional(),
  labelIds: z.array(z.string().uuid()).max(50).optional(),
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
export type CreateWorkItemInput = z.infer<typeof CreateWorkItemSchema>
export type UpdateWorkItemInput = z.infer<typeof UpdateWorkItemSchema>
export type CreateUpdateInput = z.infer<typeof CreateUpdateSchema>
export type ReviseUpdateInput = z.infer<typeof ReviseUpdateSchema>
export type CheckpointInput = z.infer<typeof CheckpointSchema>
export type CreateLabelInput = z.infer<typeof CreateLabelSchema>
