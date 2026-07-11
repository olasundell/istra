import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { NotFoundError } from '../../application/errors.js'
import type { IstraService } from '../../application/istra-service.js'
import {
  CheckpointSchema,
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
  CreateRunObjectSchema,
  CreateWorkQueueSchema,
  CreateWorkRelationSchema,
  CreateWorkspaceRevisionSchema,
  CreateWorkspaceSchema,
  UpdateRequirementSchema,
  CreateLabelSchema,
  PageRequestSchema,
  ErrorReportPageRequestSchema,
  UpdateErrorReportSchema,
} from '../../domain/contracts.js'

const client = z.string().trim().max(200).optional().describe('Name of the MCP client recording this change')
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const source = (name?: string) => ({ source: 'mcp' as const, client: name ?? 'istra-mcp' })

function result(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { result: data },
  }
}

function required<T>(value: T | null, entity: string, id: string): T {
  if (value === null) throw new NotFoundError(entity, id)
  return value
}

export function createMcpServer(service: IstraService): McpServer {
  const server = new McpServer({ name: 'istra', version: '0.1.0' })

  server.registerTool('get_storage_status', {
    description: 'Read the active storage backend, redacted target, schema version, readiness and backup capabilities.',
    inputSchema: z.object({}),
    annotations: readOnly,
  }, async () => result(await service.storageStatus()))

  server.registerTool('list_projects', {
    description: 'List Istra projects, optionally filtered by lifecycle state or text.',
    inputSchema: z.object({ state: ProjectStateSchema.optional(), includeArchived: z.boolean().default(false), query: z.string().max(500).optional() }),
    annotations: readOnly,
  }, async (args) => result(await service.listProjects({ state: args.state, includeArchived: args.includeArchived, q: args.query })))

  server.registerTool('get_project_pulse', {
    description: 'Read a project’s current pulse, checkpoint, phases, unresolved work and recent activity before starting work.',
    inputSchema: z.object({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId }) => {
    const detail = await service.getProject(projectId)
    if (!detail) throw new NotFoundError('Project', projectId)
    return result(detail)
  })

  server.registerTool('list_work_items', {
    description: 'List work items for a project, optionally restricted to statuses.',
    inputSchema: z.object({ projectId: z.string().uuid(), statuses: z.array(WorkItemStatusSchema).max(10).optional() }),
    annotations: readOnly,
  }, async ({ projectId, statuses }) => result(await service.listWorkItems(projectId, statuses)))

  server.registerTool('search', {
    description: 'Search project descriptions, phases, work items and current journal revisions.',
    inputSchema: z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(200).default(50), projectId: z.string().uuid().optional(), entityTypes: z.array(z.enum(['project', 'phase', 'work_item', 'update', 'requirement', 'run', 'evidence'])).max(10).optional(), state: z.string().trim().max(100).optional(), phaseId: z.string().uuid().optional(), requirementId: z.string().uuid().optional(), evidenceResult: z.enum(['recorded', 'verified', 'failed', 'interrupted']).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }),
    annotations: readOnly,
  }, async ({ query, limit, ...filters }) => result(await service.search(query, limit, filters)))

  server.registerTool('report_error', {
    description: 'Report a concrete or strongly suspected fault in Istra’s MCP tools, plugins, instructions or workflow. Report only Istra faults after a quick sanity check; do not report user-project bugs, expected validation errors, or failures of this tool itself. Keep evidence concise and sanitised, then continue the user’s task.',
    inputSchema: CreateErrorReportSchema.extend({
      idempotencyKey: z.string().trim().min(1).max(200).describe('A task-scoped key reused only to retry this identical report.'),
      client,
    }).strict(),
    annotations: write,
  }, async ({ idempotencyKey, client: clientName, ...input }) => result(await service.reportError(input, source(clientName), idempotencyKey)))
  server.registerTool('list_error_reports_page', {
    description: 'Read a bounded page of unresolved Istra error reports. Use only when explicitly asked to triage the inbox.',
    inputSchema: ErrorReportPageRequestSchema,
    annotations: readOnly,
  }, async (page) => result(await service.listErrorReportsPage(page)))
  server.registerTool('get_error_report', {
    description: 'Read one Istra error report and its creation and triage history. Use only when explicitly asked to triage the inbox.',
    inputSchema: z.object({ reportId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ reportId }) => result(required(await service.getErrorReport(reportId), 'Error report', reportId)))
  server.registerTool('update_error_report', {
    description: 'Set the triage status or note for an Istra error report using optimistic concurrency. Use only when explicitly asked to triage the inbox.',
    inputSchema: UpdateErrorReportSchema.extend({ reportId: z.string().uuid(), client }).strict(),
    annotations: write,
  }, async ({ reportId, client: clientName, ...input }) => result(await service.updateErrorReport(reportId, input, source(clientName))))

  server.registerTool('list_labels', {
    description: 'List labels available to work items.',
    inputSchema: z.object({}),
    annotations: readOnly,
  }, async () => result(await service.listLabels()))
  server.registerTool('create_label', {
    description: 'Create a reusable work-item label.',
    inputSchema: CreateLabelSchema.extend({ idempotencyKey: z.string().trim().min(1).max(200), client }),
    annotations: write,
  }, async ({ idempotencyKey, client: clientName, ...input }) => result(await service.createLabel(input, source(clientName), idempotencyKey)))

  server.registerTool('create_project', {
    description: 'Create an open-ended project. Only a title is required.',
    inputSchema: CreateProjectSchema.omit({ source: true }).extend({ idempotencyKey: z.string().trim().min(1).max(200).optional(), client }),
    annotations: write,
  }, async ({ client: clientName, idempotencyKey, ...input }) => result(await service.createProject(input, source(clientName), idempotencyKey)))

  server.registerTool('update_project', {
    description: 'Edit a project’s metadata, lifecycle state or current pulse fields using optimistic concurrency.',
    inputSchema: UpdateProjectSchema.extend({ projectId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ projectId, client: clientName, ...input }) => result(await service.updateProject(projectId, input, source(clientName))))

  server.registerTool('archive_project', {
    description: 'Archive or unarchive a project without changing or resolving its children.',
    inputSchema: z.object({ projectId: z.string().uuid(), expectedVersion: z.number().int().positive(), archived: z.boolean(), client }),
    annotations: write,
  }, async ({ projectId, client: clientName, ...input }) => result(await service.archiveProject(projectId, input, source(clientName))))

  server.registerTool('save_checkpoint', {
    description: 'Atomically record a checkpoint, capture its canonical structured state and return the snapshot digest.',
    inputSchema: CheckpointSchema.extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200).optional(), client }),
    annotations: write,
  }, async ({ projectId, client: clientName, idempotencyKey, ...input }) => result(await service.saveCheckpoint(projectId, input, source(clientName), idempotencyKey)))

  server.registerTool('create_phase', {
    description: 'Create an optional, overlapping phase within a project.',
    inputSchema: CreatePhaseSchema.extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200).optional(), client }),
    annotations: write,
  }, async ({ projectId, client: clientName, idempotencyKey, ...input }) => result(await service.createPhase(projectId, input, source(clientName), idempotencyKey)))

  server.registerTool('update_phase', {
    description: 'Edit, reorder, change status, archive or unarchive a phase.',
    inputSchema: UpdatePhaseSchema.extend({ phaseId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ phaseId, client: clientName, ...input }) => result(await service.updatePhase(phaseId, input, source(clientName))))

  server.registerTool('create_work_item', {
    description: 'Create an issue, task, idea, question or risk within a project.',
    inputSchema: CreateWorkItemSchema.extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200).optional(), client }),
    annotations: write,
  }, async ({ projectId, client: clientName, idempotencyKey, ...input }) => result(await service.createWorkItem(projectId, input, source(clientName), idempotencyKey)))

  server.registerTool('update_work_item', {
    description: 'Edit or transition a work item using optimistic concurrency.',
    inputSchema: UpdateWorkItemSchema.extend({ workItemId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ workItemId, client: clientName, ...input }) => result(await service.updateWorkItem(workItemId, input, source(clientName))))

  server.registerTool('create_update', {
    description: 'Add a note, progress report, decision or discovery to a project journal.',
    inputSchema: CreateUpdateSchema.extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200).optional(), client }),
    annotations: write,
  }, async ({ projectId, client: clientName, idempotencyKey, ...input }) => result(await service.createUpdate(projectId, input, source(clientName), idempotencyKey)))

  server.registerTool('revise_update', {
    description: 'Append a revision to an authored update while retaining all earlier revisions.',
    inputSchema: ReviseUpdateSchema.extend({ updateId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200).optional(), client }),
    annotations: write,
  }, async ({ updateId, idempotencyKey, client: clientName, ...input }) => result(await service.reviseUpdate(updateId, input, source(clientName), idempotencyKey)))
  server.registerTool('get_update_revisions', {
    description: 'Read all retained revisions for a journal update.',
    inputSchema: z.object({ updateId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ updateId }) => result(await service.getUpdateRevisions(updateId)))
  server.registerTool('list_project_activity', {
    description: 'Read recent project activity, bounded by a requested limit.',
    inputSchema: z.object({ projectId: z.string().uuid(), limit: z.number().int().min(1).max(1000).default(200) }),
    annotations: readOnly,
  }, async ({ projectId, limit }) => result(await service.listActivity(projectId, limit)))

  server.registerTool('resolve_project', {
    description: 'Resolve projects linked to a filesystem workspace path. Never matches by title.',
    inputSchema: z.object({ workspacePath: z.string().trim().min(1).max(4000) }),
    annotations: readOnly,
  }, async ({ workspacePath }) => result(await service.resolveProject(workspacePath)))

  server.registerTool('get_project_pulse_summary', {
    description: 'Read a compact project pulse with requirement, queue, blocker and evidence summaries.',
    inputSchema: z.object({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId }) => result(required(await service.getProjectPulseSummary(projectId), 'Project', projectId)))

  server.registerTool('list_requirement_states', {
    description: 'List configurable requirement states for a project.',
    inputSchema: z.object({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId }) => result(await service.listRequirementStates(projectId)))
  server.registerTool('create_requirement_state', {
    description: 'Create a semantic requirement state for a project.',
    inputSchema: CreateRequirementStateSchema.extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200), client }),
    annotations: write,
  }, async ({ projectId, idempotencyKey, client: clientName, ...input }) => result(await service.createRequirementState(projectId, input, idempotencyKey, source(clientName))))
  server.registerTool('list_requirements', {
    description: 'List the hierarchical requirement ledger for a project.',
    inputSchema: z.object({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId }) => result(await service.listRequirements(projectId)))
  server.registerTool('list_requirements_page', {
    description: 'Read a bounded page of the requirement ledger.',
    inputSchema: PageRequestSchema.extend({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId, ...page }) => result(await service.listRequirementsPage(projectId, page)))
  server.registerTool('get_requirement', {
    description: 'Read one requirement with criteria, links and gate status.',
    inputSchema: z.object({ requirementId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ requirementId }) => result(required(await service.getRequirement(requirementId), 'Requirement', requirementId)))
  server.registerTool('create_requirement', {
    description: 'Create a stable-keyed goal, capability or requirement.',
    inputSchema: CreateRequirementSchema.extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200), client }),
    annotations: write,
  }, async ({ projectId, idempotencyKey, client: clientName, ...input }) => result(await service.createRequirement(projectId, input, idempotencyKey, source(clientName))))
  server.registerTool('update_requirement', {
    description: 'Update a requirement using optimistic concurrency.',
    inputSchema: UpdateRequirementSchema.extend({ requirementId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ requirementId, client: clientName, ...input }) => result(await service.updateRequirement(requirementId, input, source(clientName))))
  server.registerTool('get_requirement_rollup', {
    description: 'Compute requirement counts and gate failures for a project.',
    inputSchema: z.object({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId }) => result(await service.getRequirementRollup(projectId)))
  server.registerTool('link_requirement_work', {
    description: 'Link a requirement to a work item.',
    inputSchema: z.object({ projectId: z.string().uuid(), requirementId: z.string().uuid(), workItemId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ projectId, requirementId, workItemId, client: clientName }) => result((await service.linkRequirementWork(projectId, requirementId, workItemId, source(clientName))) ?? { linked: true }))
  server.registerTool('unlink_requirement_work', {
    description: 'Remove a requirement/work link.',
    inputSchema: z.object({ requirementId: z.string().uuid(), workItemId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ requirementId, workItemId, client: clientName }) => result((await service.unlinkRequirementWork(requirementId, workItemId, source(clientName))) ?? { linked: false }))

  server.registerTool('list_work_queues', {
    description: 'List ordered work queues for a project.',
    inputSchema: z.object({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId }) => result(await service.listWorkQueues(projectId)))
  server.registerTool('create_work_queue', {
    description: 'Create an ordered work queue.',
    inputSchema: CreateWorkQueueSchema.extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200), client }),
    annotations: write,
  }, async ({ projectId, idempotencyKey, client: clientName, ...input }) => result(await service.createWorkQueue(projectId, input, idempotencyKey, source(clientName))))
  server.registerTool('list_operational_work_items', {
    description: 'List work items with queue rank and derived blocker reasons.',
    inputSchema: z.object({ projectId: z.string().uuid(), queueId: z.string().uuid().optional() }),
    annotations: readOnly,
  }, async ({ projectId, queueId }) => result(await service.listOperationalWorkItems(projectId, queueId)))
  server.registerTool('list_operational_work_items_page', {
    description: 'Read a bounded page of ordered work with derived blockers.',
    inputSchema: PageRequestSchema.extend({ projectId: z.string().uuid(), queueId: z.string().uuid().optional() }),
    annotations: readOnly,
  }, async ({ projectId, ...page }) => result(await service.listOperationalWorkItemsPage(projectId, page)))
  server.registerTool('list_work_relations', {
    description: 'List dependency and related-work edges for a project.',
    inputSchema: z.object({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId }) => result(await service.listWorkRelations(projectId)))
  server.registerTool('link_work_items', {
    description: 'Create a dependency or related-work edge.',
    inputSchema: CreateWorkRelationSchema.extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200), client }),
    annotations: write,
  }, async ({ projectId, idempotencyKey, client: clientName, ...input }) => result(await service.linkWorkItems(projectId, input, idempotencyKey, source(clientName))))
  server.registerTool('unlink_work_items', {
    description: 'Remove a work relation.',
    inputSchema: z.object({ relationId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ relationId, client: clientName }) => result((await service.unlinkWorkItems(relationId, source(clientName))) ?? { linked: false }))
  server.registerTool('list_external_blockers', {
    description: 'List unresolved or historical external blockers.',
    inputSchema: z.object({ projectId: z.string().uuid(), includeResolved: z.boolean().default(false) }),
    annotations: readOnly,
  }, async ({ projectId, includeResolved }) => result(await service.listExternalBlockers(projectId, includeResolved)))
  server.registerTool('create_external_blocker', {
    description: 'Record an external blocker for a project or work item.',
    inputSchema: CreateExternalBlockerSchema.extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200), client }),
    annotations: write,
  }, async ({ projectId, idempotencyKey, client: clientName, ...input }) => result(await service.createExternalBlocker(projectId, input, idempotencyKey, source(clientName))))
  server.registerTool('resolve_external_blocker', {
    description: 'Resolve an external blocker.',
    inputSchema: z.object({ blockerId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ blockerId, client: clientName }) => result(await service.resolveExternalBlocker(blockerId, source(clientName))))

  server.registerTool('create_workspace', {
    description: 'Register a filesystem/Git workspace identity.',
    inputSchema: CreateWorkspaceSchema.extend({ idempotencyKey: z.string().trim().min(1).max(200), client }),
    annotations: write,
  }, async ({ idempotencyKey, client: clientName, ...input }) => result(await service.createWorkspace(input, idempotencyKey, source(clientName))))
  server.registerTool('link_project_workspace', {
    description: 'Link a workspace to a project.',
    inputSchema: z.object({ projectId: z.string().uuid(), workspaceId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200), client }),
    annotations: write,
  }, async ({ projectId, workspaceId, idempotencyKey, client: clientName }) => result((await service.linkProjectWorkspace(projectId, workspaceId, idempotencyKey, source(clientName))) ?? { linked: true }))
  server.registerTool('create_workspace_revision', {
    description: 'Record read-only branch, commit and dirty-state metadata.',
    inputSchema: CreateWorkspaceRevisionSchema.extend({ idempotencyKey: z.string().trim().min(1).max(200), client }),
    annotations: write,
  }, async ({ idempotencyKey, client: clientName, ...input }) => result(await service.createWorkspaceRevision(input, idempotencyKey, source(clientName))))

  server.registerTool('create_run', {
    description: 'Record a bounded command/test execution with redacted excerpts.',
    inputSchema: CreateRunObjectSchema.extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200), client }).strict(),
    annotations: write,
  }, async ({ projectId, idempotencyKey, client: clientName, ...input }) => result(await service.createRun(projectId, input, idempotencyKey, source(clientName))))
  server.registerTool('list_runs', {
    description: 'List structured runs for a project.',
    inputSchema: z.object({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId }) => result(await service.listRuns(projectId)))
  server.registerTool('list_runs_page', {
    description: 'Read a bounded page of execution runs.',
    inputSchema: PageRequestSchema.extend({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId, ...page }) => result(await service.listRunsPage(projectId, page)))
  server.registerTool('create_evidence', {
    description: 'Record evidence linked to requirements, work, decisions or checkpoints.',
    inputSchema: CreateEvidenceSchema.omit({ override: true }).extend({ projectId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200), client }).strict(),
    annotations: write,
  }, async ({ projectId, idempotencyKey, client: clientName, ...input }) => result(await service.createEvidence(projectId, input, idempotencyKey, source(clientName))))
  server.registerTool('list_evidence', {
    description: 'List evidence and verification freshness for a project.',
    inputSchema: z.object({ projectId: z.string().uuid(), includeStale: z.boolean().default(false) }),
    annotations: readOnly,
  }, async ({ projectId, includeStale }) => result(await service.listEvidence(projectId, includeStale)))
  server.registerTool('list_evidence_page', {
    description: 'Read a bounded page of evidence records.',
    inputSchema: PageRequestSchema.extend({ projectId: z.string().uuid(), includeStale: z.boolean().default(false) }),
    annotations: readOnly,
  }, async ({ projectId, ...page }) => result(await service.listEvidencePage(projectId, page)))

  server.registerTool('list_project_history_page', {
    description: 'Read a bounded page of project updates or activity events.',
    inputSchema: PageRequestSchema.extend({ projectId: z.string().uuid(), entity: z.enum(['updates', 'activity']) }),
    annotations: readOnly,
  }, async ({ projectId, entity, ...page }) => result(await (entity === 'updates' ? service.listUpdatesPage(projectId, page) : service.listActivityPage(projectId, page))))

  server.registerTool('backfill_legacy_checkpoint_snapshot', {
    description: 'Backfill an immutable structured snapshot for a legacy checkpoint that predates atomic checkpoint capture.',
    inputSchema: z.object({ projectId: z.string().uuid(), checkpointId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(200), client }),
    annotations: write,
  }, async ({ projectId, checkpointId, idempotencyKey, client: clientName }) => result(await service.backfillLegacyCheckpointSnapshot(projectId, checkpointId, idempotencyKey, source(clientName))))
  server.registerTool('get_checkpoint_snapshot', {
    description: 'Read an immutable checkpoint reconstruction document.',
    inputSchema: z.object({ checkpointId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ checkpointId }) => result(required(await service.getCheckpointSnapshot(checkpointId), 'Checkpoint snapshot', checkpointId)))
  server.registerTool('compare_checkpoint_snapshots', {
    description: 'Compare two immutable checkpoint snapshots by structured section.',
    inputSchema: z.object({ leftCheckpointId: z.string().uuid(), rightCheckpointId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ leftCheckpointId, rightCheckpointId }) => result(await service.compareCheckpointSnapshots(leftCheckpointId, rightCheckpointId)))
  server.registerTool('reconstruct_checkpoint_state', {
    description: 'Reconstruct project state from an immutable checkpoint snapshot.',
    inputSchema: z.object({ checkpointId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ checkpointId }) => result(required(await service.reconstructCheckpointState(checkpointId), 'Checkpoint snapshot', checkpointId)))

  return server
}
