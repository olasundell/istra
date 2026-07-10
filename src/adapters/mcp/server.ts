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

export function createMcpServer(service: IstraService): McpServer {
  const server = new McpServer({ name: 'istra', version: '0.1.0' })

  server.registerTool('list_projects', {
    description: 'List Istra projects, optionally filtered by lifecycle state or text.',
    inputSchema: z.object({ state: ProjectStateSchema.optional(), includeArchived: z.boolean().default(false), query: z.string().max(500).optional() }),
    annotations: readOnly,
  }, async (args) => result(service.listProjects({ state: args.state, includeArchived: args.includeArchived, q: args.query })))

  server.registerTool('get_project_pulse', {
    description: 'Read a project’s current pulse, checkpoint, phases, unresolved work and recent activity before starting work.',
    inputSchema: z.object({ projectId: z.string().uuid() }),
    annotations: readOnly,
  }, async ({ projectId }) => {
    const detail = service.getProject(projectId)
    if (!detail) throw new NotFoundError('Project', projectId)
    return result(detail)
  })

  server.registerTool('list_work_items', {
    description: 'List work items for a project, optionally restricted to statuses.',
    inputSchema: z.object({ projectId: z.string().uuid(), statuses: z.array(WorkItemStatusSchema).max(10).optional() }),
    annotations: readOnly,
  }, async ({ projectId, statuses }) => result(service.listWorkItems(projectId, statuses)))

  server.registerTool('search', {
    description: 'Search project descriptions, phases, work items and current journal revisions.',
    inputSchema: z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(200).default(50) }),
    annotations: readOnly,
  }, async ({ query, limit }) => result(service.search(query, limit)))

  server.registerTool('create_project', {
    description: 'Create an open-ended project. Only a title is required.',
    inputSchema: CreateProjectSchema.omit({ source: true }).extend({ client }),
    annotations: write,
  }, async ({ client: clientName, ...input }) => result(await service.createProject(input, source(clientName))))

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
    description: 'Atomically record a dated journal checkpoint and select its structured pulse as the project’s current checkpoint.',
    inputSchema: CheckpointSchema.extend({ projectId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ projectId, client: clientName, ...input }) => result(await service.saveCheckpoint(projectId, input, source(clientName))))

  server.registerTool('create_phase', {
    description: 'Create an optional, overlapping phase within a project.',
    inputSchema: CreatePhaseSchema.extend({ projectId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ projectId, client: clientName, ...input }) => result(await service.createPhase(projectId, input, source(clientName))))

  server.registerTool('update_phase', {
    description: 'Edit, reorder, change status, archive or unarchive a phase.',
    inputSchema: UpdatePhaseSchema.extend({ phaseId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ phaseId, client: clientName, ...input }) => result(await service.updatePhase(phaseId, input, source(clientName))))

  server.registerTool('create_work_item', {
    description: 'Create an issue, task, idea, question or risk within a project.',
    inputSchema: CreateWorkItemSchema.extend({ projectId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ projectId, client: clientName, ...input }) => result(await service.createWorkItem(projectId, input, source(clientName))))

  server.registerTool('update_work_item', {
    description: 'Edit or transition a work item using optimistic concurrency.',
    inputSchema: UpdateWorkItemSchema.extend({ workItemId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ workItemId, client: clientName, ...input }) => result(await service.updateWorkItem(workItemId, input, source(clientName))))

  server.registerTool('create_update', {
    description: 'Add a note, progress report, decision or discovery to a project journal.',
    inputSchema: CreateUpdateSchema.extend({ projectId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ projectId, client: clientName, ...input }) => result(await service.createUpdate(projectId, input, source(clientName))))

  server.registerTool('revise_update', {
    description: 'Append a revision to an authored update while retaining all earlier revisions.',
    inputSchema: ReviseUpdateSchema.extend({ updateId: z.string().uuid(), client }),
    annotations: write,
  }, async ({ updateId, client: clientName, ...input }) => result(await service.reviseUpdate(updateId, input, source(clientName))))

  return server
}
