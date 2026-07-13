import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { resolve } from 'node:path'
import { z } from 'zod'
import { AppError, NotFoundError, ValidationError } from '../../application/errors.js'
import type { IstraService } from '../../application/istra-service.js'

export interface HttpAppOptions {
  service: IstraService
  staticDir?: string
  logger?: FastifyServerOptions['logger']
  readinessCheck?: () => void | Promise<void>
}

const idParams = (request: { params: unknown }) => request.params as { id: string }
const projectParams = (request: { params: unknown }) => request.params as { projectId: string }
const queueParams = (request: { params: unknown }) => request.params as { projectId: string; queueId: string }
const labelParams = (request: { params: unknown }) => request.params as { id: string; labelId: string }

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false
  let host: string | undefined
  if (value.startsWith('[')) {
    const closing = value.indexOf(']')
    if (closing < 0 || !/^(?::\d+)?$/.test(value.slice(closing + 1))) return false
    host = value.slice(1, closing)
  } else {
    const parts = value.split(':')
    if (parts.length > 2 || (parts[1] !== undefined && !/^\d+$/.test(parts[1]))) return false
    host = parts[0]
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function isLoopbackOrigin(value: string | undefined): boolean {
  if (!value) return true
  try { return isLoopbackHost(new URL(value).host) } catch { return false }
}

function source(request: { headers: Record<string, unknown> }) {
  const client = request.headers['x-istra-client']
  return { source: 'ui' as const, client: typeof client === 'string' ? client.slice(0, 200) : 'http' }
}

function automationSource(request: { headers: Record<string, unknown> }) {
  const value = request.headers['x-istra-client']
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    throw new ValidationError('Automation mutations require an x-istra-client header between 1 and 200 characters')
  }
  return { source: 'ui' as const, client: value.trim() }
}

function idempotencyKey(request: { headers: Record<string, unknown> }): string | undefined {
  const value = request.headers['idempotency-key']
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined
}

function automationIdempotencyKey(request: { headers: Record<string, unknown> }): string {
  const value = request.headers['idempotency-key']
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    throw new ValidationError('Automation mutations require an Idempotency-Key header between 1 and 200 characters')
  }
  return value.trim()
}

const AutomationWaitQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(2_000).optional(),
  timeoutSeconds: z.coerce.number().int().min(0).max(60).default(30),
}).strict()

function automationWaitQuery(value: unknown) {
  const parsed = AutomationWaitQuerySchema.safeParse(value)
  if (!parsed.success) throw new ValidationError('Input validation failed', parsed.error.flatten())
  return parsed.data
}

export async function buildHttpApp(options: HttpAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 20 * 1024 * 1024 })

  app.addHook('onRequest', async (request) => {
    if (!isLoopbackHost(request.headers.host)) throw new AppError('FORBIDDEN_HOST', 'Istra accepts loopback Host headers only', 403)
    if (!isLoopbackOrigin(request.headers.origin)) throw new AppError('FORBIDDEN_ORIGIN', 'Istra accepts loopback origins only', 403)
    if (['POST','PUT','PATCH','DELETE'].includes(request.method)) {
      const type = request.headers['content-type']
      if (typeof type !== 'string' || !type.toLowerCase().startsWith('application/json')) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Mutations require Content-Type: application/json', 415)
      }
    }
  })

  app.setErrorHandler((error, _request, reply) => {
    const validation = typeof error === 'object' && error !== null && 'validation' in error ? error.validation : undefined
    const fastifyStatus = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : undefined
    const fastifyCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    const appError = error instanceof AppError ? error : validation
      ? new ValidationError('Request validation failed', validation)
      : fastifyStatus
        ? new AppError(fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ? 'INVALID_JSON' : fastifyCode ?? 'BAD_REQUEST', error instanceof Error ? error.message : 'Invalid request', fastifyStatus)
      : null
    if (!appError) app.log.error(error)
    const statusCode = appError?.statusCode ?? 500
    return reply.status(statusCode).send({ error: { code: appError?.code ?? 'INTERNAL_ERROR', message: appError?.message ?? 'An unexpected error occurred', ...(appError?.details === undefined ? {} : { details: appError.details }) } })
  })
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }))

  app.get('/api/v1/health', async () => ({ data: { status: 'ok' } }))
  app.get('/api/v1/ready', async (_request, reply) => {
    try {
      await options.readinessCheck?.()
      return { data: { status: 'ready' } }
    } catch (error) {
      app.log.error(error, 'Readiness check failed')
      return reply.status(503).send({ error: { code: 'NOT_READY', message: 'Istra is not ready' } })
    }
  })
  app.get('/api/v1/storage', async () => ({ data: await options.service.storageStatus() }))
  app.get('/api/v1/projects', async (request) => {
    const query = request.query as { state?: string; includeArchived?: string; q?: string }
    return { data: await options.service.listProjects({ state: query.state || undefined, includeArchived: query.includeArchived === 'true', q: query.q }) }
  })
  app.post('/api/v1/projects', async (request) => ({ data: await options.service.createProject(request.body, source(request), idempotencyKey(request)) }))
  app.get('/api/v1/projects/:id', async (request) => {
    const { id } = idParams(request); const detail = await options.service.getProject(id)
    if (!detail) throw new NotFoundError('Project', id)
    return { data: detail }
  })
  app.patch('/api/v1/projects/:id', async (request) => ({ data: await options.service.updateProject(idParams(request).id, request.body, source(request)) }))
  app.post('/api/v1/projects/:id/archive', async (request) => ({ data: await options.service.archiveProject(idParams(request).id, request.body, source(request)) }))
  app.post('/api/v1/projects/:id/checkpoints', async (request) => ({ data: await options.service.saveCheckpoint(idParams(request).id, request.body, source(request), idempotencyKey(request)) }))
  app.get('/api/v1/projects/:projectId/pulse', async (request) => {
    const pulse = await options.service.getProjectPulseSummary(projectParams(request).projectId)
    if (!pulse) throw new NotFoundError('Project', projectParams(request).projectId)
    return { data: pulse }
  })
  app.get('/api/v1/projects/:projectId/requirements/states', async (request) => ({ data: await options.service.listRequirementStates(projectParams(request).projectId) }))
  app.post('/api/v1/projects/:projectId/requirements/states', async (request) => ({ data: await options.service.createRequirementState(projectParams(request).projectId, request.body, idempotencyKey(request), source(request)) }))
  app.get('/api/v1/projects/:projectId/requirements', async (request) => ({ data: await options.service.listRequirements(projectParams(request).projectId) }))
  app.get('/api/v1/projects/:projectId/requirements/page', async (request) => ({ data: await options.service.listRequirementsPage(projectParams(request).projectId, request.query) }))
  app.post('/api/v1/projects/:projectId/requirements', async (request) => ({ data: await options.service.createRequirement(projectParams(request).projectId, request.body, idempotencyKey(request), source(request)) }))
  app.get('/api/v1/requirements/:id', async (request) => {
    const requirement = await options.service.getRequirement(idParams(request).id)
    if (!requirement) throw new NotFoundError('Requirement', idParams(request).id)
    return { data: requirement }
  })
  app.patch('/api/v1/requirements/:id', async (request) => ({ data: await options.service.updateRequirement(idParams(request).id, request.body, source(request)) }))
  app.get('/api/v1/projects/:projectId/requirements/rollup', async (request) => ({ data: await options.service.getRequirementRollup(projectParams(request).projectId) }))
  app.post('/api/v1/projects/:projectId/requirements/:requirementId/work-items/:workItemId', async (request) => { const params = request.params as { projectId: string; requirementId: string; workItemId: string }; await options.service.linkRequirementWork(params.projectId, params.requirementId, params.workItemId, source(request)); return { data: { linked: true } } })
  app.delete('/api/v1/requirements/:requirementId/work-items/:workItemId', async (request) => { const params = request.params as { requirementId: string; workItemId: string }; await options.service.unlinkRequirementWork(params.requirementId, params.workItemId, source(request)); return { data: { linked: false } } })

  app.get('/api/v1/projects/:projectId/work-queues', async (request) => ({ data: await options.service.listWorkQueues(projectParams(request).projectId) }))
  app.post('/api/v1/projects/:projectId/work-queues', async (request) => ({ data: await options.service.createWorkQueue(projectParams(request).projectId, request.body, idempotencyKey(request), source(request)) }))
  app.get('/api/v1/projects/:projectId/work-queues/:queueId/automation-policy', async (request) => { const { projectId, queueId } = queueParams(request); return { data: await options.service.getQueueAutomationPolicy(projectId, queueId) } })
  app.put('/api/v1/projects/:projectId/work-queues/:queueId/automation-policy', async (request) => { const { projectId, queueId } = queueParams(request); return { data: await options.service.updateQueueAutomationPolicy(projectId, queueId, request.body, automationIdempotencyKey(request), automationSource(request)) } })
  app.get('/api/v1/projects/:projectId/work-queues/:queueId/automation', async (request) => { const { projectId, queueId } = queueParams(request); return { data: await options.service.getQueueAutomationOverview(projectId, queueId) } })
  app.get('/api/v1/projects/:projectId/work-queues/:queueId/automation/wait', async (request) => { const { projectId, queueId } = queueParams(request); return { data: await options.service.waitForQueueChanges(projectId, queueId, automationWaitQuery(request.query)) } })
  app.post('/api/v1/projects/:projectId/work-queues/:queueId/automation/claim', async (request) => { const { projectId, queueId } = queueParams(request); return { data: await options.service.claimNextAutomatedWork(projectId, queueId, { ...(request.body as object), idempotencyKey: automationIdempotencyKey(request) }, automationSource(request)) } })
  app.post('/api/v1/automation-leases/:id/heartbeat', async (request) => ({ data: await options.service.heartbeatAutomatedWork(idParams(request).id, { ...(request.body as object), idempotencyKey: automationIdempotencyKey(request) }, automationSource(request)) }))
  app.post('/api/v1/automation-leases/:id/attempts', async (request) => ({ data: await options.service.recordAutomationAttempt(idParams(request).id, { ...(request.body as object), idempotencyKey: automationIdempotencyKey(request) }, automationSource(request)) }))
  app.post('/api/v1/automation-leases/:id/complete', async (request) => ({ data: await options.service.completeAutomatedWork(idParams(request).id, { ...(request.body as object), idempotencyKey: automationIdempotencyKey(request) }, automationSource(request)) }))
  app.post('/api/v1/automation-leases/:id/release', async (request) => ({ data: await options.service.releaseAutomatedWork(idParams(request).id, { ...(request.body as object), idempotencyKey: automationIdempotencyKey(request) }, automationSource(request)) }))
  app.post('/api/v1/automation-leases/:id/operator-release', async (request) => ({ data: await options.service.operatorReleaseAutomatedWork(idParams(request).id, { ...(request.body as object), idempotencyKey: automationIdempotencyKey(request) }, automationSource(request)) }))
  app.get('/api/v1/projects/:projectId/operational-work-items', async (request) => ({ data: await options.service.listOperationalWorkItems(projectParams(request).projectId, (request.query as { queueId?: string }).queueId) }))
  app.get('/api/v1/projects/:projectId/operational-work-items/page', async (request) => ({ data: await options.service.listOperationalWorkItemsPage(projectParams(request).projectId, request.query) }))
  app.get('/api/v1/projects/:projectId/work-relations', async (request) => ({ data: await options.service.listWorkRelations(projectParams(request).projectId) }))
  app.post('/api/v1/projects/:projectId/work-relations', async (request) => ({ data: await options.service.linkWorkItems(projectParams(request).projectId, request.body, idempotencyKey(request), source(request)) }))
  app.delete('/api/v1/work-relations/:id', async (request) => { await options.service.unlinkWorkItems(idParams(request).id, source(request)); return { data: { linked: false } } })
  app.get('/api/v1/projects/:projectId/external-blockers', async (request) => ({ data: await options.service.listExternalBlockers(projectParams(request).projectId, (request.query as { includeResolved?: string }).includeResolved === 'true') }))
  app.post('/api/v1/projects/:projectId/external-blockers', async (request) => ({ data: await options.service.createExternalBlocker(projectParams(request).projectId, request.body, idempotencyKey(request), source(request)) }))
  app.post('/api/v1/external-blockers/:id/resolve', async (request) => ({ data: await options.service.resolveExternalBlocker(idParams(request).id, source(request)) }))

  app.post('/api/v1/workspaces', async (request) => ({ data: await options.service.createWorkspace(request.body, idempotencyKey(request), source(request)) }))
  app.post('/api/v1/projects/:projectId/workspaces/:workspaceId', async (request) => { const params = request.params as { projectId: string; workspaceId: string }; await options.service.linkProjectWorkspace(params.projectId, params.workspaceId, idempotencyKey(request), source(request)); return { data: { linked: true } } })
  app.post('/api/v1/workspace-revisions', async (request) => ({ data: await options.service.createWorkspaceRevision(request.body, idempotencyKey(request), source(request)) }))
  app.post('/api/v1/project-resolution', async (request) => ({ data: await options.service.resolveProject(String((request.body as { workspacePath?: string }).workspacePath ?? '')) }))

  app.get('/api/v1/projects/:projectId/runs', async (request) => ({ data: await options.service.listRuns(projectParams(request).projectId) }))
  app.get('/api/v1/projects/:projectId/runs/page', async (request) => ({ data: await options.service.listRunsPage(projectParams(request).projectId, request.query) }))
  app.post('/api/v1/projects/:projectId/runs', async (request) => ({ data: await options.service.createRun(projectParams(request).projectId, request.body, idempotencyKey(request), source(request)) }))
  app.get('/api/v1/projects/:projectId/evidence', async (request) => ({ data: await options.service.listEvidence(projectParams(request).projectId, (request.query as { includeStale?: string }).includeStale === 'true') }))
  app.get('/api/v1/projects/:projectId/evidence/page', async (request) => ({ data: await options.service.listEvidencePage(projectParams(request).projectId, request.query) }))
  app.post('/api/v1/projects/:projectId/evidence', async (request) => ({ data: await options.service.createEvidence(projectParams(request).projectId, request.body, idempotencyKey(request), source(request)) }))
  app.post('/api/v1/projects/:projectId/checkpoints/:checkpointId/legacy-snapshot', async (request) => ({ data: await options.service.backfillLegacyCheckpointSnapshot(projectParams(request).projectId, (request.params as { checkpointId: string }).checkpointId, idempotencyKey(request), source(request)) }))
  app.get('/api/v1/checkpoints/:id/snapshot', async (request) => {
    const { id } = idParams(request); const snapshot = await options.service.getCheckpointSnapshot(id)
    if (!snapshot) throw new NotFoundError('Checkpoint snapshot', id)
    return { data: snapshot }
  })
  app.get('/api/v1/checkpoints/:id/state', async (request) => {
    const { id } = idParams(request); const state = await options.service.reconstructCheckpointState(id)
    if (!state) throw new NotFoundError('Checkpoint snapshot', id)
    return { data: state }
  })
  app.get('/api/v1/checkpoints/:leftId/compare/:rightId', async (request) => { const params = request.params as { leftId: string; rightId: string }; return { data: await options.service.compareCheckpointSnapshots(params.leftId, params.rightId) } })

  app.get('/api/v1/projects/:projectId/phases', async (request) => ({ data: await options.service.listPhases(projectParams(request).projectId, (request.query as { includeArchived?: string }).includeArchived === 'true') }))
  app.post('/api/v1/projects/:projectId/phases', async (request) => ({ data: await options.service.createPhase(projectParams(request).projectId, request.body, source(request), idempotencyKey(request)) }))
  app.patch('/api/v1/phases/:id', async (request) => ({ data: await options.service.updatePhase(idParams(request).id, request.body, source(request)) }))

  app.get('/api/v1/projects/:projectId/work-items', async (request) => {
    const statuses = (request.query as { status?: string }).status?.split(',').filter(Boolean)
    return { data: await options.service.listWorkItems(projectParams(request).projectId, statuses) }
  })
  app.post('/api/v1/projects/:projectId/work-items', async (request) => ({ data: await options.service.createWorkItem(projectParams(request).projectId, request.body, source(request), idempotencyKey(request)) }))
  app.patch('/api/v1/work-items/:id', async (request) => ({ data: await options.service.updateWorkItem(idParams(request).id, request.body, source(request)) }))

  app.get('/api/v1/projects/:projectId/updates', async (request) => ({ data: await options.service.listUpdates(projectParams(request).projectId, (request.query as { includeDeleted?: string }).includeDeleted === 'true') }))
  app.get('/api/v1/projects/:projectId/updates/page', async (request) => ({ data: await options.service.listUpdatesPage(projectParams(request).projectId, request.query) }))
  app.post('/api/v1/projects/:projectId/updates', async (request) => ({ data: await options.service.createUpdate(projectParams(request).projectId, request.body, source(request), idempotencyKey(request)) }))
  app.get('/api/v1/updates/:id/revisions', async (request) => ({ data: await options.service.getUpdateRevisions(idParams(request).id) }))
  app.post('/api/v1/updates/:id/revisions', async (request) => ({ data: await options.service.reviseUpdate(idParams(request).id, request.body, source(request), idempotencyKey(request)) }))
  app.delete('/api/v1/updates/:id', async (request) => ({ data: await options.service.deleteUpdate(idParams(request).id, request.body, source(request)) }))

  app.get('/api/v1/labels', async () => ({ data: await options.service.listLabels() }))
  app.post('/api/v1/labels', async (request) => ({ data: await options.service.createLabel(request.body, source(request), idempotencyKey(request)) }))
  app.put('/api/v1/work-items/:id/labels/:labelId', async (request) => ({ data: await options.service.attachLabel(labelParams(request).id, labelParams(request).labelId, request.body, source(request)) }))
  app.delete('/api/v1/work-items/:id/labels/:labelId', async (request) => ({ data: await options.service.detachLabel(labelParams(request).id, labelParams(request).labelId, request.body, source(request)) }))

  app.get('/api/v1/projects/:projectId/activity', async (request) => ({ data: await options.service.listActivity(projectParams(request).projectId, Number((request.query as { limit?: string }).limit) || undefined) }))
  app.get('/api/v1/projects/:projectId/activity/page', async (request) => ({ data: await options.service.listActivityPage(projectParams(request).projectId, request.query) }))
  app.get('/api/v1/activity', async (request) => ({ data: await options.service.listRecentActivity(Number((request.query as { limit?: string }).limit) || undefined) }))
  app.get('/api/v1/search', async (request) => {
    const query = request.query as { q?: string; limit?: string; projectId?: string; entityTypes?: string; state?: string; phaseId?: string; requirementId?: string; evidenceResult?: string; from?: string; to?: string }
    return { data: await options.service.search(query.q ?? '', Number(query.limit) || undefined, { projectId: query.projectId, entityTypes: query.entityTypes?.split(',').filter(Boolean), state: query.state, phaseId: query.phaseId, requirementId: query.requirementId, evidenceResult: query.evidenceResult, from: query.from, to: query.to }) }
  })
  app.get('/api/v1/export', async (_request, reply) => reply.header('Content-Disposition', `attachment; filename="istra-${new Date().toISOString().slice(0, 10)}.json"`).send(await options.service.exportAll()))
  app.post('/api/v1/import', async (request) => { await options.service.importAll(request.body); return { data: { imported: true } } })
  app.get('/api/v1/backups', async () => ({ data: await options.service.backupStatus() }))

  if (options.staticDir) {
    await app.register(fastifyStatic, { root: resolve(options.staticDir), wildcard: false })
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
      return reply.sendFile('index.html')
    })
  }
  return app
}
