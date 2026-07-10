import { z } from 'zod'
import type { BackupManager } from '../infrastructure/sqlite/database.js'
import {
  CheckpointSchema,
  CreateLabelSchema,
  CreatePhaseSchema,
  CreateProjectSchema,
  CreateUpdateSchema,
  CreateWorkItemSchema,
  ProjectStateSchema,
  ReviseUpdateSchema,
  UpdatePhaseSchema,
  UpdateProjectSchema,
  UpdateWorkItemSchema,
  WorkItemStatusSchema,
  CreateEvidenceSchema,
  CreateErrorReportSchema,
  CreateExternalBlockerSchema,
  CreateRequirementSchema,
  CreateRequirementStateSchema,
  CreateRunSchema,
  CreateWorkQueueSchema,
  CreateWorkRelationSchema,
  CreateWorkspaceRevisionSchema,
  CreateWorkspaceSchema,
  UpdateRequirementSchema,
  PageRequestSchema,
  ErrorReportPageRequestSchema,
  UpdateErrorReportSchema,
  type Provenance,
  type MutationContext,
  type SearchFilters,
} from '../domain/contracts.js'
import { ValidationError } from './errors.js'
import type { ExportBundle, IstraRepository } from './ports.js'
import type { OperationalRepository } from '../infrastructure/sqlite/operational-repository.js'

const ExportBundleSchema = z.object({
  format: z.literal('istra-export'),
  formatVersion: z.union([z.literal(3), z.literal(4)]),
  exportedAt: z.string().datetime({ offset: true }),
  tables: z.record(z.array(z.record(z.unknown()))),
}).strict()

const queryBoolean = (value: unknown): boolean => value === true || value === 'true'
type OperationalCaller = Partial<Provenance> | string

export class IstraService {
  constructor(private readonly repository: IstraRepository, private readonly backups: BackupManager, private readonly operational?: OperationalRepository) {}

  private operations(): OperationalRepository {
    if (!this.operational) throw new ValidationError('Operational memory is not configured')
    return this.operational
  }

  private parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
    const result = schema.safeParse(value)
    if (!result.success) throw new ValidationError('Input validation failed', result.error.flatten())
    return result.data
  }

  private mutationContext(caller: OperationalCaller = {}, key?: string): MutationContext {
    const provenance = typeof caller === 'string' ? { source: 'ui' as const, client: caller } : caller
    const client = provenance.client ?? provenance.actor ?? provenance.source ?? 'ui'
    return {
      source: provenance.source ?? 'ui', actor: (provenance.actor ?? client) || 'local-user', client,
      idempotencyKey: key ?? provenance.idempotencyKey ?? null, occurredAt: provenance.occurredAt ?? new Date().toISOString(),
    }
  }

  private async writeOperational<T>(caller: OperationalCaller, key: string | undefined, operationName: string, payload: unknown, operation: () => T): Promise<T> {
    await this.backups.beforeWrite()
    return this.operations().runMutation(this.mutationContext(caller, key), operationName, payload, operation)
  }

  private async writeCore<T>(source: Partial<Provenance> | undefined, key: string | undefined, operationName: string, payload: unknown, operation: (context: MutationContext) => T): Promise<T> {
    await this.backups.beforeWrite()
    const context = this.mutationContext(source, key)
    return this.operations().runMutation(context, operationName, payload, () => operation(context))
  }

  listProjects(filters: unknown = {}) {
    const parsed = this.parse(z.object({ state: ProjectStateSchema.optional(), includeArchived: z.boolean().optional(), q: z.string().max(500).optional() }), filters)
    return this.repository.listProjects(parsed)
  }

  getProject(id: string) { return this.repository.getProjectDetail(id) }
  listPhases(projectId: string, includeArchived = false) { return this.repository.listPhases(projectId, includeArchived) }
  listWorkItems(projectId: string, statuses?: string[]) {
    const parsed = this.parse(z.array(WorkItemStatusSchema).max(10).optional(), statuses)
    return this.repository.listWorkItems(projectId, parsed)
  }
  listWorkItemsPage(projectId: string, input: unknown = {}) {
    const parsed = this.parse(PageRequestSchema, input)
    return this.repository.listWorkItemsPage(projectId, parsed.limit, parsed.cursor, this.parse(z.array(WorkItemStatusSchema).max(10).optional(), (input as { statuses?: unknown })?.statuses))
  }
  listUpdates(projectId: string, includeDeleted = false) { return this.repository.listUpdates(projectId, includeDeleted) }
  listUpdatesPage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return this.repository.listUpdatesPage(projectId, parsed.limit, parsed.cursor, queryBoolean((input as { includeDeleted?: unknown })?.includeDeleted)) }
  listActivity(projectId: string, limit?: number) { return this.repository.listActivity(projectId, limit) }
  listActivityPage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return this.repository.listActivityPage(projectId, parsed.limit, parsed.cursor) }
  listRecentActivity(limit?: number) { return this.repository.listRecentActivity(limit) }
  getUpdateRevisions(updateId: string) { return this.repository.getUpdateRevisions(updateId) }
  listLabels() { return this.repository.listLabels() }
  listErrorReportsPage(input: unknown = {}) {
    const parsed = this.parse(ErrorReportPageRequestSchema, input)
    return this.operations().listErrorReportsPage(parsed.limit, parsed.cursor, parsed.statuses, parsed.kinds, parsed.component)
  }
  getErrorReport(id: string) { return this.operations().getErrorReport(id) }
  search(query: string, limit?: number, filters: unknown = {}) {
    const parsed = this.parse(z.object({ projectId: z.string().uuid().optional(), entityTypes: z.array(z.enum(['project', 'phase', 'work_item', 'update', 'requirement', 'run', 'evidence'])).max(10).optional(), state: z.string().trim().max(100).optional(), phaseId: z.string().uuid().optional(), requirementId: z.string().uuid().optional(), evidenceResult: z.enum(['recorded', 'verified', 'failed', 'interrupted']).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }), filters) as SearchFilters
    const max = this.parse(z.number().int().min(1).max(200), limit ?? 50)
    const core = this.repository.search(query, 200, parsed)
    const operational = this.operational ? this.operations().search(query, 200, parsed) : []
    const merged = new Map([...core, ...operational].map((entry) => [`${entry.type}:${entry.id}`, entry]))
    return [...merged.values()].slice(0, max)
  }
  exportAll() { return this.repository.exportAll() }
  async backupStatus() {
    const files = await this.backups.list()
    const backups = files.map((file) => ({
      name: file.name,
      kind: file.name.startsWith('pre-import-') ? 'pre-import' : file.name.startsWith('pre-migration-') ? 'pre-migration' : file.name.startsWith('weekly-') ? 'weekly' : 'daily',
      createdAt: file.modifiedAt,
      size: file.size,
    })).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const lastBackupAt = backups.reduce<string | null>((latest, file) => !latest || file.createdAt > latest ? file.createdAt : latest, null)
    return {
      databasePath: this.backups.paths.databasePath,
      lastBackupAt,
      nextBackupKind: 'daily',
      backups,
    }
  }

  createProject(input: unknown, source?: Partial<Provenance>, idempotencyKey?: string) {
    const parsed = this.parse(CreateProjectSchema, input)
    return this.writeCore(source, idempotencyKey, 'create_project', parsed, (context) => this.repository.createProject(parsed, context))
  }
  reportError(input: unknown, source?: Partial<Provenance>, idempotencyKey?: string) {
    const parsed = this.parse(CreateErrorReportSchema, input)
    return this.writeOperational(source ?? {}, idempotencyKey, 'report_error', parsed, () => this.operations().createErrorReport(parsed))
  }
  updateErrorReport(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(UpdateErrorReportSchema, input)
    return this.writeOperational(source ?? {}, undefined, 'update_error_report', { id, parsed }, () => this.operations().updateErrorReport(id, parsed))
  }
  updateProject(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(UpdateProjectSchema, input)
    return this.writeCore(source, undefined, 'update_project', { id, parsed }, (context) => this.repository.updateProject(id, parsed, context))
  }
  archiveProject(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(z.object({ expectedVersion: z.number().int().positive(), archived: z.boolean() }), input)
    return this.writeCore(source, undefined, 'archive_project', { id, parsed }, (context) => this.repository.archiveProject(id, parsed.expectedVersion, parsed.archived, context))
  }
  createPhase(projectId: string, input: unknown, source?: Partial<Provenance>, idempotencyKey?: string) {
    const parsed = this.parse(CreatePhaseSchema, input)
    return this.writeCore(source, idempotencyKey, 'create_phase', { projectId, parsed }, (context) => this.repository.createPhase(projectId, parsed, context))
  }
  updatePhase(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(UpdatePhaseSchema, input)
    return this.writeCore(source, undefined, 'update_phase', { id, parsed }, (context) => this.repository.updatePhase(id, parsed, context))
  }
  createWorkItem(projectId: string, input: unknown, source?: Partial<Provenance>, idempotencyKey?: string) {
    const parsed = this.parse(CreateWorkItemSchema, input)
    return this.writeCore(source, idempotencyKey, 'create_work_item', { projectId, parsed }, (context) => this.repository.createWorkItem(projectId, parsed, context))
  }
  updateWorkItem(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(UpdateWorkItemSchema, input)
    return this.writeCore(source, undefined, 'update_work_item', { id, parsed }, (context) => this.repository.updateWorkItem(id, parsed, context))
  }
  createUpdate(projectId: string, input: unknown, source?: Partial<Provenance>, idempotencyKey?: string) {
    const parsed = this.parse(CreateUpdateSchema, input)
    return this.writeCore(source, idempotencyKey, 'create_update', { projectId, parsed }, (context) => this.repository.createUpdate(projectId, parsed, context))
  }
  reviseUpdate(id: string, input: unknown, source?: Partial<Provenance>, idempotencyKey?: string) {
    const parsed = this.parse(ReviseUpdateSchema, input)
    return this.writeCore(source, idempotencyKey, 'revise_update', { id, parsed }, (context) => this.repository.reviseUpdate(id, parsed, context))
  }
  deleteUpdate(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(z.object({ expectedVersion: z.number().int().positive() }), input)
    return this.writeCore(source, undefined, 'delete_update', { id, parsed }, (context) => this.repository.softDeleteUpdate(id, parsed.expectedVersion, context))
  }
  async saveCheckpoint(projectId: string, input: unknown, source?: Partial<Provenance>, idempotencyKey?: string) {
    const parsed = this.parse(CheckpointSchema, input)
    const context = this.mutationContext(source, idempotencyKey)
    await this.backups.beforeWrite()
    return this.operations().runMutation(context, 'save_checkpoint', { projectId, parsed }, () => {
      const checkpoint = this.repository.saveCheckpoint(projectId, parsed, context)
      const snapshot = this.operations().captureCheckpointSnapshot(projectId, checkpoint.id)
      return { checkpoint, snapshot: { id: snapshot.id, digest: snapshot.digest, schemaVersion: snapshot.schemaVersion, capturedAt: snapshot.capturedAt } }
    })
  }
  createLabel(input: unknown, source?: Partial<Provenance>, idempotencyKey?: string) {
    const parsed = this.parse(CreateLabelSchema, input)
    return this.writeCore(source, idempotencyKey, 'create_label', parsed, (context) => this.repository.createLabel(parsed, context))
  }
  attachLabel(workItemId: string, labelId: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(z.object({ expectedVersion: z.number().int().positive() }), input)
    return this.writeCore(source, undefined, 'attach_label', { workItemId, labelId, parsed }, (context) => this.repository.attachLabel(workItemId, labelId, parsed.expectedVersion, context))
  }
  detachLabel(workItemId: string, labelId: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(z.object({ expectedVersion: z.number().int().positive() }), input)
    return this.writeCore(source, undefined, 'detach_label', { workItemId, labelId, parsed }, (context) => this.repository.detachLabel(workItemId, labelId, parsed.expectedVersion, context))
  }

  async importAll(value: unknown): Promise<void> {
    const bundle = this.parse(ExportBundleSchema, value) as ExportBundle
    this.repository.validateImport(bundle)
    await this.backups.create('pre-import')
    this.repository.importAll(bundle)
  }

  listRequirementStates(projectId: string) { return this.operations().listRequirementStates(projectId) }
  createRequirementState(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateRequirementStateSchema, input); const operation = () => this.operations().createRequirementState(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_requirement_state', { projectId, parsed }, operation) }
  listRequirements(projectId: string) { return this.operations().listRequirements(projectId) }
  listRequirementsPage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return this.operations().listRequirementsPage(projectId, parsed.limit, parsed.cursor) }
  getRequirement(id: string) { return this.operations().getRequirement(id) }
  createRequirement(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateRequirementSchema, input); const operation = () => this.operations().createRequirement(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_requirement', { projectId, parsed }, operation) }
  updateRequirement(id: string, input: unknown, caller: OperationalCaller = 'ui') { const parsed = this.parse(UpdateRequirementSchema, input); return this.writeOperational(caller, undefined, 'update_requirement', { id, parsed }, () => this.operations().updateRequirement(id, parsed)) }
  linkRequirementWork(projectId: string, requirementId: string, workItemId: string, caller: OperationalCaller = 'ui') { return this.writeOperational(caller, undefined, 'link_requirement_work', { projectId, requirementId, workItemId }, () => this.operations().linkRequirementWork(projectId, requirementId, workItemId)) }
  unlinkRequirementWork(requirementId: string, workItemId: string, caller: OperationalCaller = 'ui') { return this.writeOperational(caller, undefined, 'unlink_requirement_work', { requirementId, workItemId }, () => this.operations().unlinkRequirementWork(requirementId, workItemId)) }
  getRequirementRollup(projectId: string) { return this.operations().getRequirementRollup(projectId) }
  listWorkQueues(projectId: string) { return this.operations().listWorkQueues(projectId) }
  createWorkQueue(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateWorkQueueSchema, input); const operation = () => this.operations().createWorkQueue(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_work_queue', { projectId, parsed }, operation) }
  listOperationalWorkItems(projectId: string, queueId?: string) { return this.operations().listWorkItems(projectId, queueId) }
  listOperationalWorkItemsPage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return this.operations().listWorkItemsPage(projectId, parsed.limit, parsed.cursor, (input as { queueId?: string })?.queueId) }
  linkWorkItems(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateWorkRelationSchema, input); const operation = () => this.operations().linkWorkItems(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'link_work_items', { projectId, parsed }, operation) }
  unlinkWorkItems(id: string, caller: OperationalCaller = 'ui') { return this.writeOperational(caller, undefined, 'unlink_work_items', { id }, () => this.operations().unlinkWorkItems(id)) }
  listWorkRelations(projectId: string) { return this.operations().listWorkRelations(projectId) }
  createExternalBlocker(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateExternalBlockerSchema, input); const operation = () => this.operations().createExternalBlocker(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_external_blocker', { projectId, parsed }, operation) }
  listExternalBlockers(projectId: string, includeResolved = false) { return this.operations().listExternalBlockers(projectId, includeResolved) }
  resolveExternalBlocker(id: string, caller: OperationalCaller = 'ui') { return this.writeOperational(caller, undefined, 'resolve_external_blocker', { id }, () => this.operations().resolveExternalBlocker(id)) }
  createWorkspace(input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateWorkspaceSchema, input); const operation = () => this.operations().createWorkspace(parsed); return this.writeOperational(caller, idempotencyKey, 'create_workspace', parsed, operation) }
  linkProjectWorkspace(projectId: string, workspaceId: string, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const operation = () => this.operations().linkProjectWorkspace(projectId, workspaceId); return this.writeOperational(caller, idempotencyKey, 'link_project_workspace', { projectId, workspaceId }, operation) }
  createWorkspaceRevision(input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateWorkspaceRevisionSchema, input); const operation = () => this.operations().createWorkspaceRevision(parsed); return this.writeOperational(caller, idempotencyKey, 'create_workspace_revision', parsed, operation) }
  resolveProject(workspacePath: string) { return this.operations().resolveProject(workspacePath) }
  createRun(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateRunSchema, input); const operation = () => this.operations().createRun(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_run', { projectId, parsed }, operation) }
  listRuns(projectId: string) { return this.operations().listRuns(projectId) }
  listRunsPage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return this.operations().listRunsPage(projectId, parsed.limit, parsed.cursor) }
  createEvidence(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateEvidenceSchema, input); const operation = () => this.operations().createEvidence(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_evidence', { projectId, parsed }, operation) }
  listEvidence(projectId: string, includeStale = false) { return this.operations().listEvidence(projectId, includeStale) }
  listEvidencePage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return this.operations().listEvidencePage(projectId, parsed.limit, parsed.cursor, queryBoolean((input as { includeStale?: unknown })?.includeStale)) }
  backfillLegacyCheckpointSnapshot(projectId: string, checkpointId: string, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const operation = () => this.operations().captureCheckpointSnapshot(projectId, checkpointId); return this.writeOperational(caller, idempotencyKey, 'legacy_backfill_checkpoint_snapshot', { projectId, checkpointId }, operation) }
  getCheckpointSnapshot(checkpointId: string) { return this.operations().getCheckpointSnapshot(checkpointId) }
  compareCheckpointSnapshots(leftCheckpointId: string, rightCheckpointId: string) { return this.operations().compareCheckpointSnapshots(leftCheckpointId, rightCheckpointId) }
  reconstructCheckpointState(checkpointId: string) { return this.operations().reconstructCheckpointState(checkpointId) }
  getProjectPulseSummary(projectId: string) { return this.operations().getProjectPulseSummary(projectId) }
}
