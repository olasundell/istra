import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { resolve } from 'node:path'
import { AppError, NotFoundError, ValidationError } from '../../application/errors.js'
import type { IstraService } from '../../application/istra-service.js'

export interface HttpAppOptions {
  service: IstraService
  staticDir?: string
  logger?: boolean
}

const idParams = (request: { params: unknown }) => request.params as { id: string }
const projectParams = (request: { params: unknown }) => request.params as { projectId: string }
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
  app.get('/api/v1/projects', async (request) => {
    const query = request.query as { state?: string; includeArchived?: string; q?: string }
    return { data: options.service.listProjects({ state: query.state || undefined, includeArchived: query.includeArchived === 'true', q: query.q }) }
  })
  app.post('/api/v1/projects', async (request) => ({ data: await options.service.createProject(request.body, source(request)) }))
  app.get('/api/v1/projects/:id', async (request) => {
    const { id } = idParams(request); const detail = options.service.getProject(id)
    if (!detail) throw new NotFoundError('Project', id)
    return { data: detail }
  })
  app.patch('/api/v1/projects/:id', async (request) => ({ data: await options.service.updateProject(idParams(request).id, request.body, source(request)) }))
  app.post('/api/v1/projects/:id/archive', async (request) => ({ data: await options.service.archiveProject(idParams(request).id, request.body, source(request)) }))
  app.post('/api/v1/projects/:id/checkpoints', async (request) => ({ data: await options.service.saveCheckpoint(idParams(request).id, request.body, source(request)) }))

  app.get('/api/v1/projects/:projectId/phases', async (request) => ({ data: options.service.listPhases(projectParams(request).projectId, (request.query as { includeArchived?: string }).includeArchived === 'true') }))
  app.post('/api/v1/projects/:projectId/phases', async (request) => ({ data: await options.service.createPhase(projectParams(request).projectId, request.body, source(request)) }))
  app.patch('/api/v1/phases/:id', async (request) => ({ data: await options.service.updatePhase(idParams(request).id, request.body, source(request)) }))

  app.get('/api/v1/projects/:projectId/work-items', async (request) => {
    const statuses = (request.query as { status?: string }).status?.split(',').filter(Boolean)
    return { data: options.service.listWorkItems(projectParams(request).projectId, statuses) }
  })
  app.post('/api/v1/projects/:projectId/work-items', async (request) => ({ data: await options.service.createWorkItem(projectParams(request).projectId, request.body, source(request)) }))
  app.patch('/api/v1/work-items/:id', async (request) => ({ data: await options.service.updateWorkItem(idParams(request).id, request.body, source(request)) }))

  app.get('/api/v1/projects/:projectId/updates', async (request) => ({ data: options.service.listUpdates(projectParams(request).projectId, (request.query as { includeDeleted?: string }).includeDeleted === 'true') }))
  app.post('/api/v1/projects/:projectId/updates', async (request) => ({ data: await options.service.createUpdate(projectParams(request).projectId, request.body, source(request)) }))
  app.get('/api/v1/updates/:id/revisions', async (request) => ({ data: options.service.getUpdateRevisions(idParams(request).id) }))
  app.post('/api/v1/updates/:id/revisions', async (request) => ({ data: await options.service.reviseUpdate(idParams(request).id, request.body, source(request)) }))
  app.delete('/api/v1/updates/:id', async (request) => ({ data: await options.service.deleteUpdate(idParams(request).id, request.body, source(request)) }))

  app.get('/api/v1/labels', async () => ({ data: options.service.listLabels() }))
  app.post('/api/v1/labels', async (request) => ({ data: await options.service.createLabel(request.body, source(request)) }))
  app.put('/api/v1/work-items/:id/labels/:labelId', async (request) => ({ data: await options.service.attachLabel(labelParams(request).id, labelParams(request).labelId, request.body, source(request)) }))
  app.delete('/api/v1/work-items/:id/labels/:labelId', async (request) => ({ data: await options.service.detachLabel(labelParams(request).id, labelParams(request).labelId, request.body, source(request)) }))

  app.get('/api/v1/projects/:projectId/activity', async (request) => ({ data: options.service.listActivity(projectParams(request).projectId, Number((request.query as { limit?: string }).limit) || undefined) }))
  app.get('/api/v1/activity', async (request) => ({ data: options.service.listRecentActivity(Number((request.query as { limit?: string }).limit) || undefined) }))
  app.get('/api/v1/search', async (request) => ({ data: options.service.search((request.query as { q?: string }).q ?? '', Number((request.query as { limit?: string }).limit) || undefined) }))
  app.get('/api/v1/export', async (_request, reply) => reply.header('Content-Disposition', `attachment; filename="istra-${new Date().toISOString().slice(0, 10)}.json"`).send(options.service.exportAll()))
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
