import { z } from 'zod'
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
import {
  ClaimNextAutomatedWorkSchema,
  CompleteAutomatedWorkSchema,
  HeartbeatAutomatedWorkSchema,
  OperatorReleaseAutomatedWorkSchema,
  RecordAutomationAttemptSchema,
  RunnerReleaseAutomatedWorkSchema,
  UpdateQueueAutomationPolicySchema,
  WaitForQueueChangesSchema,
} from '../domain/automation.js'
import { decodeAutomationCursor, encodeAutomationCursor } from './automation-cursor.js'
import { UnsupportedOperationError, ValidationError } from './errors.js'
import type { Awaitable, DataProtection, ExportBundle, IstraRepository, OperationalRepository, StorageStatus } from './ports.js'

const ExportBundleSchema = z.object({
  format: z.literal('istra-export'),
  formatVersion: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  exportedAt: z.string().datetime({ offset: true }),
  tables: z.record(z.array(z.record(z.unknown()))),
}).strict()

const queryBoolean = (value: unknown): boolean => value === true || value === 'true'
type OperationalCaller = Partial<Provenance> | string

function flatMapAwaitable<T, U>(value: Awaitable<T>, map: (resolved: T) => Awaitable<U>): Awaitable<U> {
  return value instanceof Promise ? value.then(map) : map(value)
}

export class IstraService {
  constructor(
    private readonly repository: IstraRepository,
    private readonly dataProtection: DataProtection,
    private readonly operational?: OperationalRepository,
    private readonly readStorageStatus?: () => Awaitable<StorageStatus>,
  ) {}

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

  private automationCaller(caller: OperationalCaller): OperationalCaller {
    if (typeof caller === 'string') {
      if (!caller.trim()) throw new ValidationError('Automation mutations require a client name')
      return caller
    }
    if (!caller.client?.trim()) throw new ValidationError('Automation mutations require a client name')
    return caller
  }

  private async writeOperational<T>(caller: OperationalCaller, key: string | undefined, operationName: string, payload: unknown, operation: () => Awaitable<T>): Promise<T> {
    await this.dataProtection.beforeWrite()
    return await this.operations().runMutation(this.mutationContext(caller, key), operationName, payload, operation)
  }

  private async writeCore<T>(source: Partial<Provenance> | undefined, key: string | undefined, operationName: string, payload: unknown, operation: (context: MutationContext) => Awaitable<T>): Promise<T> {
    await this.dataProtection.beforeWrite()
    const context = this.mutationContext(source, key)
    return await this.operations().runMutation(context, operationName, payload, () => operation(context))
  }

  async listProjects(filters: unknown = {}) {
    const parsed = this.parse(z.object({ state: ProjectStateSchema.optional(), includeArchived: z.boolean().optional(), q: z.string().max(500).optional() }), filters)
    return await this.repository.listProjects(parsed)
  }

  async getProject(id: string) { return await this.repository.getProjectDetail(id) }
  async listPhases(projectId: string, includeArchived = false) { return await this.repository.listPhases(projectId, includeArchived) }
  async listWorkItems(projectId: string, statuses?: string[]) {
    const parsed = this.parse(z.array(WorkItemStatusSchema).max(10).optional(), statuses)
    return await this.repository.listWorkItems(projectId, parsed)
  }
  async listWorkItemsPage(projectId: string, input: unknown = {}) {
    const parsed = this.parse(PageRequestSchema, input)
    return await this.repository.listWorkItemsPage(projectId, parsed.limit, parsed.cursor, this.parse(z.array(WorkItemStatusSchema).max(10).optional(), (input as { statuses?: unknown })?.statuses))
  }
  async listUpdates(projectId: string, includeDeleted = false) { return await this.repository.listUpdates(projectId, includeDeleted) }
  async listUpdatesPage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return await this.repository.listUpdatesPage(projectId, parsed.limit, parsed.cursor, queryBoolean((input as { includeDeleted?: unknown })?.includeDeleted)) }
  async listActivity(projectId: string, limit?: number) { return await this.repository.listActivity(projectId, limit) }
  async listActivityPage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return await this.repository.listActivityPage(projectId, parsed.limit, parsed.cursor) }
  async listRecentActivity(limit?: number) { return await this.repository.listRecentActivity(limit) }
  async getUpdateRevisions(updateId: string) { return await this.repository.getUpdateRevisions(updateId) }
  async listLabels() { return await this.repository.listLabels() }
  async listErrorReportsPage(input: unknown = {}) {
    const parsed = this.parse(ErrorReportPageRequestSchema, input)
    return await this.operations().listErrorReportsPage(parsed.limit, parsed.cursor, parsed.statuses, parsed.kinds, parsed.component)
  }
  async getErrorReport(id: string) { return await this.operations().getErrorReport(id) }
  async search(query: string, limit?: number, filters: unknown = {}) {
    const parsed = this.parse(z.object({ projectId: z.string().uuid().optional(), entityTypes: z.array(z.enum(['project', 'phase', 'work_item', 'update', 'requirement', 'run', 'evidence'])).max(10).optional(), state: z.string().trim().max(100).optional(), phaseId: z.string().uuid().optional(), requirementId: z.string().uuid().optional(), evidenceResult: z.enum(['recorded', 'verified', 'failed', 'interrupted']).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }), filters) as SearchFilters
    const max = this.parse(z.number().int().min(1).max(200), limit ?? 50)
    const [core, operational] = await Promise.all([
      this.repository.search(query, 200, parsed),
      this.operations().search(query, 200, parsed),
    ])
    const merged = new Map([...core, ...operational].map((entry) => [`${entry.type}:${entry.id}`, entry]))
    return [...merged.values()].slice(0, max)
  }
  async exportAll() { return await this.repository.exportAll() }
  async storageStatus(): Promise<StorageStatus> {
    if (this.readStorageStatus) return await this.readStorageStatus()
    return {
      backend: this.dataProtection.backend,
      target: this.dataProtection.databasePath ?? this.dataProtection.backend,
      schemaVersion: 0,
      ready: true,
      automaticBackups: this.dataProtection.automatic,
      importSupported: this.dataProtection.importSupported,
    }
  }
  async backupStatus() {
    const files = await this.dataProtection.list()
    const backups = files.map((file) => ({
      name: file.name,
      kind: file.name.startsWith('pre-import-') ? 'pre-import' : file.name.startsWith('pre-migration-') ? 'pre-migration' : file.name.startsWith('weekly-') ? 'weekly' : 'daily',
      createdAt: file.modifiedAt,
      size: file.size,
    })).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const lastBackupAt = backups.reduce<string | null>((latest, file) => !latest || file.createdAt > latest ? file.createdAt : latest, null)
    return {
      backend: this.dataProtection.backend,
      automaticBackups: this.dataProtection.automatic,
      importSupported: this.dataProtection.importSupported,
      databasePath: this.dataProtection.databasePath,
      lastBackupAt,
      ...(this.dataProtection.automatic ? { nextBackupKind: 'daily' } : {}),
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
    await this.dataProtection.beforeWrite()
    return await this.operations().runMutation(context, 'save_checkpoint', { projectId, parsed }, () => (
      flatMapAwaitable(this.repository.saveCheckpoint(projectId, parsed, context), (checkpoint) => (
        flatMapAwaitable(this.operations().captureCheckpointSnapshot(projectId, checkpoint.id), (snapshot) => ({
          checkpoint,
          snapshot: { id: snapshot.id, digest: snapshot.digest, schemaVersion: snapshot.schemaVersion, capturedAt: snapshot.capturedAt },
        }))
      ))
    ))
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
    if (!this.dataProtection.importSupported) {
      throw new UnsupportedOperationError('Full replacement import is unavailable for PostgreSQL until backup and restore support is configured')
    }
    const bundle = this.parse(ExportBundleSchema, value) as ExportBundle
    await this.repository.validateImport(bundle)
    await this.dataProtection.create('pre-import')
    await this.repository.importAll(bundle)
  }

  async listRequirementStates(projectId: string) { return await this.operations().listRequirementStates(projectId) }
  createRequirementState(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateRequirementStateSchema, input); const operation = () => this.operations().createRequirementState(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_requirement_state', { projectId, parsed }, operation) }
  async listRequirements(projectId: string) { return await this.operations().listRequirements(projectId) }
  async listRequirementsPage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return await this.operations().listRequirementsPage(projectId, parsed.limit, parsed.cursor) }
  async getRequirement(id: string) { return await this.operations().getRequirement(id) }
  createRequirement(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateRequirementSchema, input); const operation = () => this.operations().createRequirement(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_requirement', { projectId, parsed }, operation) }
  updateRequirement(id: string, input: unknown, caller: OperationalCaller = 'ui') { const parsed = this.parse(UpdateRequirementSchema, input); return this.writeOperational(caller, undefined, 'update_requirement', { id, parsed }, () => this.operations().updateRequirement(id, parsed)) }
  linkRequirementWork(projectId: string, requirementId: string, workItemId: string, caller: OperationalCaller = 'ui') { return this.writeOperational(caller, undefined, 'link_requirement_work', { projectId, requirementId, workItemId }, () => this.operations().linkRequirementWork(projectId, requirementId, workItemId)) }
  unlinkRequirementWork(requirementId: string, workItemId: string, caller: OperationalCaller = 'ui') { return this.writeOperational(caller, undefined, 'unlink_requirement_work', { requirementId, workItemId }, () => this.operations().unlinkRequirementWork(requirementId, workItemId)) }
  async getRequirementRollup(projectId: string) { return await this.operations().getRequirementRollup(projectId) }
  async listWorkQueues(projectId: string) { return await this.operations().listWorkQueues(projectId) }
  createWorkQueue(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateWorkQueueSchema, input); const operation = () => this.operations().createWorkQueue(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_work_queue', { projectId, parsed }, operation) }
  async getQueueAutomationPolicy(projectId: string, queueId: string) { return await this.operations().getQueueAutomationPolicy(projectId, queueId) }
  async getQueueAutomationOverview(projectId: string, queueId: string) { return await this.operations().getQueueAutomationOverview(projectId, queueId) }
  updateQueueAutomationPolicy(projectId: string, queueId: string, input: unknown, idempotencyKey: string | undefined, caller: OperationalCaller) { const parsed = this.parse(UpdateQueueAutomationPolicySchema, input); if (!idempotencyKey) throw new ValidationError('Automation mutations require an idempotency key'); const operation = () => this.operations().updateQueueAutomationPolicy(projectId, queueId, parsed); return this.writeOperational(this.automationCaller(caller), idempotencyKey, 'update_queue_automation_policy', { projectId, queueId, parsed }, operation) }
  claimNextAutomatedWork(projectId: string, queueId: string, input: unknown, caller: OperationalCaller) { const parsed = this.parse(ClaimNextAutomatedWorkSchema, input); const operation = () => this.operations().claimNextAutomatedWork(projectId, queueId, parsed); return this.writeOperational(this.automationCaller(caller), parsed.idempotencyKey, 'claim_next_automated_work', { projectId, queueId, parsed }, operation) }
  heartbeatAutomatedWork(leaseId: string, input: unknown, caller: OperationalCaller) { const parsed = this.parse(HeartbeatAutomatedWorkSchema, input); const operation = () => this.operations().heartbeatAutomatedWork(leaseId, parsed); return this.writeOperational(this.automationCaller(caller), parsed.idempotencyKey, 'heartbeat_automated_work', { leaseId, parsed }, operation) }
  recordAutomationAttempt(leaseId: string, input: unknown, caller: OperationalCaller) { const parsed = this.parse(RecordAutomationAttemptSchema, input); const operation = () => this.operations().recordAutomationAttempt(leaseId, parsed); return this.writeOperational(this.automationCaller(caller), parsed.idempotencyKey, 'record_automation_attempt', { leaseId, parsed }, operation) }
  completeAutomatedWork(leaseId: string, input: unknown, caller: OperationalCaller) { const parsed = this.parse(CompleteAutomatedWorkSchema, input); const operation = () => this.operations().completeAutomatedWork(leaseId, parsed); return this.writeOperational(this.automationCaller(caller), parsed.idempotencyKey, 'complete_automated_work', { leaseId, parsed }, operation) }
  releaseAutomatedWork(leaseId: string, input: unknown, caller: OperationalCaller) { const parsed = this.parse(RunnerReleaseAutomatedWorkSchema, input); const operation = () => this.operations().releaseAutomatedWork(leaseId, parsed); return this.writeOperational(this.automationCaller(caller), parsed.idempotencyKey, 'release_automated_work', { leaseId, parsed }, operation) }
  operatorReleaseAutomatedWork(leaseId: string, input: unknown, caller: OperationalCaller) { const parsed = this.parse(OperatorReleaseAutomatedWorkSchema, input); const operation = () => this.operations().operatorReleaseAutomatedWork(leaseId, parsed); return this.writeOperational(this.automationCaller(caller), parsed.idempotencyKey, 'operator_release_automated_work', { leaseId, parsed }, operation) }
  async waitForQueueChanges(projectId: string, queueId: string, input: unknown = {}) {
    const parsed = this.parse(WaitForQueueChangesSchema, input)
    const started = Date.now(); const deadline = started + parsed.timeoutSeconds * 1_000
    const initial = new Date(started).toISOString(); const cursor = decodeAutomationCursor(parsed.cursor, initial, { projectId, queueId })
    for (;;) {
      const checkedAt = new Date().toISOString()
      const probe = await this.operations().readAutomationQueueChanges(projectId, queueId, cursor.sequence, cursor.checkedAt, checkedAt)
      const expiryChanges = probe.expiredLeases.map((lease) => ({ sequence: probe.cursorSequence, projectId, queueId, eventType: 'work_lease.expired', entityType: 'work_lease', entityId: lease.id, createdAt: lease.expiresAt }))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.entityId.localeCompare(right.entityId))
      if (probe.changes.length || expiryChanges.length) return { cursor: encodeAutomationCursor({ projectId, queueId, sequence: probe.cursorSequence, checkedAt }), changes: [...probe.changes, ...expiryChanges], timedOut: false }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { cursor: encodeAutomationCursor({ projectId, queueId, sequence: probe.cursorSequence, checkedAt }), changes: [], timedOut: true }
      const untilExpiry = probe.nextExpiryAt ? Math.max(0, Date.parse(probe.nextExpiryAt) - Date.now()) : remaining
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining, untilExpiry)))
    }
  }
  async listOperationalWorkItems(projectId: string, queueId?: string) { return await this.operations().listWorkItems(projectId, queueId) }
  async listOperationalWorkItemsPage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return await this.operations().listWorkItemsPage(projectId, parsed.limit, parsed.cursor, (input as { queueId?: string })?.queueId) }
  linkWorkItems(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateWorkRelationSchema, input); const operation = () => this.operations().linkWorkItems(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'link_work_items', { projectId, parsed }, operation) }
  unlinkWorkItems(id: string, caller: OperationalCaller = 'ui') { return this.writeOperational(caller, undefined, 'unlink_work_items', { id }, () => this.operations().unlinkWorkItems(id)) }
  async listWorkRelations(projectId: string) { return await this.operations().listWorkRelations(projectId) }
  createExternalBlocker(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateExternalBlockerSchema, input); const operation = () => this.operations().createExternalBlocker(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_external_blocker', { projectId, parsed }, operation) }
  async listExternalBlockers(projectId: string, includeResolved = false) { return await this.operations().listExternalBlockers(projectId, includeResolved) }
  resolveExternalBlocker(id: string, caller: OperationalCaller = 'ui') { return this.writeOperational(caller, undefined, 'resolve_external_blocker', { id }, () => this.operations().resolveExternalBlocker(id)) }
  createWorkspace(input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateWorkspaceSchema, input); const operation = () => this.operations().createWorkspace(parsed); return this.writeOperational(caller, idempotencyKey, 'create_workspace', parsed, operation) }
  linkProjectWorkspace(projectId: string, workspaceId: string, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const operation = () => this.operations().linkProjectWorkspace(projectId, workspaceId); return this.writeOperational(caller, idempotencyKey, 'link_project_workspace', { projectId, workspaceId }, operation) }
  createWorkspaceRevision(input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateWorkspaceRevisionSchema, input); const operation = () => this.operations().createWorkspaceRevision(parsed); return this.writeOperational(caller, idempotencyKey, 'create_workspace_revision', parsed, operation) }
  async resolveProject(workspacePath: string) { return await this.operations().resolveProject(workspacePath) }
  createRun(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateRunSchema, input); const operation = () => this.operations().createRun(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_run', { projectId, parsed }, operation) }
  async listRuns(projectId: string) { return await this.operations().listRuns(projectId) }
  async listRunsPage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return await this.operations().listRunsPage(projectId, parsed.limit, parsed.cursor) }
  createEvidence(projectId: string, input: unknown, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const parsed = this.parse(CreateEvidenceSchema, input); const operation = () => this.operations().createEvidence(projectId, parsed); return this.writeOperational(caller, idempotencyKey, 'create_evidence', { projectId, parsed }, operation) }
  async listEvidence(projectId: string, includeStale = false) { return await this.operations().listEvidence(projectId, includeStale) }
  async listEvidencePage(projectId: string, input: unknown = {}) { const parsed = this.parse(PageRequestSchema, input); return await this.operations().listEvidencePage(projectId, parsed.limit, parsed.cursor, queryBoolean((input as { includeStale?: unknown })?.includeStale)) }
  backfillLegacyCheckpointSnapshot(projectId: string, checkpointId: string, idempotencyKey?: string, caller: OperationalCaller = 'ui') { const operation = () => this.operations().captureCheckpointSnapshot(projectId, checkpointId); return this.writeOperational(caller, idempotencyKey, 'legacy_backfill_checkpoint_snapshot', { projectId, checkpointId }, operation) }
  async getCheckpointSnapshot(checkpointId: string) { return await this.operations().getCheckpointSnapshot(checkpointId) }
  async compareCheckpointSnapshots(leftCheckpointId: string, rightCheckpointId: string) { return await this.operations().compareCheckpointSnapshots(leftCheckpointId, rightCheckpointId) }
  async reconstructCheckpointState(checkpointId: string) { return await this.operations().reconstructCheckpointState(checkpointId) }
  async getProjectPulseSummary(projectId: string) { return await this.operations().getProjectPulseSummary(projectId) }
}
