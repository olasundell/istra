import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IstraService } from '../../application/istra-service.js'
import type { DataProtection, ExportBundle } from '../../application/ports.js'
import { createRuntime } from '../../infrastructure/runtime.js'
import { buildHttpApp } from './app.js'

describe('HTTP API contract', () => {
  let app: FastifyInstance
  let runtime: Awaited<ReturnType<typeof createRuntime>>
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'istra-http-test-'))
    runtime = await createRuntime({ dataDir })
    app = await buildHttpApp({
      service: runtime.service,
      readinessCheck: () => runtime.healthCheck(),
    })
  })

  afterEach(async () => {
    await app.close()
    await runtime.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const jsonHeaders = { host: '127.0.0.1:4317', 'content-type': 'application/json' }

  function serviceDataProtection() {
    return (runtime.service as unknown as { dataProtection: { beforeWrite(): Promise<void> } }).dataProtection
  }

  async function createProject(title = 'Memory project') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: jsonHeaders,
      payload: { title },
    })
    expect(response.statusCode).toBe(200)
    return response.json().data as { id: string; title: string; version: number }
  }

  it('reports liveness separately from database readiness', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'localhost:4317' } })
    const ready = await app.inject({ method: 'GET', url: '/api/v1/ready', headers: { host: 'localhost:4317' } })
    expect(health).toMatchObject({ statusCode: 200 })
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toEqual({ data: { status: 'ready' } })

    const unavailable = await buildHttpApp({
      service: runtime.service,
      readinessCheck: () => { throw new Error('database unavailable') },
    })
    const response = await unavailable.inject({ method: 'GET', url: '/api/v1/ready', headers: { host: 'localhost:4317' } })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: { code: 'NOT_READY', message: 'Istra is not ready' } })
    await unavailable.close()
  })

  it('reports backend-neutral storage status', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/storage', headers: { host: 'localhost:4317' } })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        backend: 'sqlite',
        target: expect.stringContaining('istra.sqlite3'),
        schemaVersion: expect.any(Number),
        ready: true,
        automaticBackups: true,
        importSupported: true,
      },
    })
  })

  it('rejects foreign hosts, foreign origins and non-JSON mutations', async () => {
    const foreignHost = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'istra.example.com' } })
    expect(foreignHost.statusCode).toBe(403)
    expect(foreignHost.json()).toMatchObject({ error: { code: 'FORBIDDEN_HOST' } })

    const foreignOrigin = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: 'localhost:4317', origin: 'https://example.com' },
    })
    expect(foreignOrigin.statusCode).toBe(403)
    expect(foreignOrigin.json()).toMatchObject({ error: { code: 'FORBIDDEN_ORIGIN' } })

    const wrongMediaType = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { host: 'localhost:4317', 'content-type': 'text/plain' },
      payload: '{"title":"Rejected"}',
    })
    expect(wrongMediaType.statusCode).toBe(415)
    expect(wrongMediaType.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } })

    const malformedJson = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: jsonHeaders,
      payload: '{"title":',
    })
    expect(malformedJson.statusCode).toBe(400)
    expect(malformedJson.json()).toMatchObject({
      error: { code: 'INVALID_JSON', message: expect.any(String) },
    })

    const oversizedBody = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: jsonHeaders,
      payload: JSON.stringify({ title: 'x'.repeat(20 * 1024 * 1024) }),
    })
    expect(oversizedBody.statusCode).toBe(413)
    expect(oversizedBody.json()).toMatchObject({
      error: { code: 'FST_ERR_CTP_BODY_TOO_LARGE', message: expect.any(String) },
    })
  })

  it('returns a consistent 409 envelope for stale writes', async () => {
    const project = await createProject()
    const firstWrite = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      headers: jsonHeaders,
      payload: { expectedVersion: project.version, title: 'Fresh title' },
    })
    expect(firstWrite.statusCode).toBe(200)

    const staleWrite = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      headers: jsonHeaders,
      payload: { expectedVersion: project.version, title: 'Stale title' },
    })
    expect(staleWrite.statusCode).toBe(409)
    expect(staleWrite.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT', message: expect.any(String) },
    })
  })

  it('round-trips the directly downloaded export through import without losing history or relationships', async () => {
    const project = await createProject('Round-trip project')
    const phaseResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/phases`,
      headers: jsonHeaders,
      payload: { name: 'Exploration', status: 'active' },
    })
    expect(phaseResponse.statusCode).toBe(200)
    const phase = phaseResponse.json().data as { id: string }

    const workItemResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/work-items`,
      headers: jsonHeaders,
      payload: { phaseId: phase.id, kind: 'issue', title: 'Preserve me', status: 'blocked' },
    })
    expect(workItemResponse.statusCode).toBe(200)

    const updateResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/updates`,
      headers: jsonHeaders,
      payload: { kind: 'decision', content: 'SQLite is the durable store.' },
    })
    expect(updateResponse.statusCode).toBe(200)
    const update = updateResponse.json().data as { id: string; version: number }
    const revisionResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/updates/${update.id}/revisions`,
      headers: jsonHeaders,
      payload: { expectedVersion: update.version, content: 'SQLite remains the durable store.' },
    })
    expect(revisionResponse.statusCode).toBe(200)

    const checkpointResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/checkpoints`,
      headers: jsonHeaders,
      payload: {
        expectedVersion: project.version,
        content: 'Checkpoint before export',
        currentFocus: 'Round-trip fidelity',
        nextAction: 'Import it again',
        blockers: ['None'],
      },
    })
    expect(checkpointResponse.statusCode).toBe(200)
    expect(checkpointResponse.json()).toMatchObject({
      data: {
        checkpoint: { kind: 'checkpoint', currentRevision: { content: 'Checkpoint before export' } },
        snapshot: { id: expect.any(String), digest: expect.stringMatching(/^[a-f0-9]{64}$/), schemaVersion: 3, capturedAt: expect.any(String) },
      },
    })

    const exportResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/export',
      headers: { host: 'localhost:4317' },
    })
    expect(exportResponse.statusCode).toBe(200)
    expect(exportResponse.headers['content-disposition']).toContain('attachment;')
    const exported = exportResponse.json() as ExportBundle
    expect(exported).toMatchObject({ format: 'istra-export', formatVersion: 4 })
    expect(exported).not.toHaveProperty('data')

    const importResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/import',
      headers: jsonHeaders,
      payload: exported,
    })
    expect(importResponse.statusCode, JSON.stringify(importResponse.json())).toBe(200)
    expect(importResponse.json()).toEqual({ data: { imported: true } })

    const secondExport = await app.inject({
      method: 'GET',
      url: '/api/v1/export',
      headers: { host: '127.0.0.1:4317' },
    })
    expect((secondExport.json() as ExportBundle).tables).toEqual(exported.tables)
  })

  it('rejects an invalid import before replacing existing data', async () => {
    const project = await createProject('Must survive')
    const updateResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/updates`,
      headers: jsonHeaders,
      payload: { kind: 'note', content: 'Existing history must survive too.' },
    })
    expect(updateResponse.statusCode).toBe(200)
    const exported = (await app.inject({
      method: 'GET',
      url: '/api/v1/export',
      headers: { host: '127.0.0.1:4317' },
    })).json() as ExportBundle
    exported.tables.projects![0]!.current_checkpoint_id = '00000000-0000-4000-8000-000000000000'

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/import',
      headers: jsonHeaders,
      payload: exported,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })

    exported.tables.projects![0]!.current_checkpoint_id = null
    exported.tables.updates![0]!.current_revision_id = '00000000-0000-4000-8000-000000000000'
    const invalidRevisionResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/import',
      headers: jsonHeaders,
      payload: exported,
    })
    expect(invalidRevisionResponse.statusCode).toBe(400)
    expect(invalidRevisionResponse.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}`,
      headers: { host: 'localhost:4317' },
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({ data: { project: { title: 'Must survive' } } })
  })

  it('returns 501 when full replacement import is unavailable for the active backend', async () => {
    const protection: DataProtection = {
      backend: 'postgresql',
      automatic: false,
      importSupported: false,
      beforeWrite: async () => undefined,
      create: async () => { throw new Error('PostgreSQL backups are unavailable') },
      list: async () => [],
    }
    const service = new IstraService(runtime.repository, protection, runtime.operationalRepository, async () => ({
      backend: 'postgresql', target: 'postgresql://localhost/istra', schemaVersion: 2, ready: true, automaticBackups: false, importSupported: false,
    }))
    const postgresApp = await buildHttpApp({ service })

    try {
      const response = await postgresApp.inject({
        method: 'POST',
        url: '/api/v1/import',
        headers: jsonHeaders,
        payload: {},
      })

      expect(response.statusCode).toBe(501)
      expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_OPERATION' } })
    } finally {
      await postgresApp.close()
    }
  })

  it('returns structured backup status without exposing a restore mutation', async () => {
    await createProject()
    const statusResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/backups',
      headers: { host: '127.0.0.1:4317' },
    })
    expect(statusResponse.statusCode).toBe(200)
    expect(statusResponse.json()).toMatchObject({
      data: {
        databasePath: expect.stringContaining('istra.sqlite3'),
        lastBackupAt: expect.any(String),
        backups: expect.arrayContaining([
          expect.objectContaining({ name: expect.stringMatching(/\.sqlite3$/), createdAt: expect.any(String) }),
        ]),
      },
    })

    const restoreResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/backups/restore',
      headers: jsonHeaders,
      payload: {},
    })
    expect(restoreResponse.statusCode).toBe(404)
    expect(restoreResponse.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    })
  })

  it('normalises idempotency keys for operational writes', async () => {
    const project = await createProject('Operational project')
    const payload = { stableKey: 'REQ-1', kind: 'requirement', title: 'Durable requirement' }

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/requirements`,
      headers: { ...jsonHeaders, 'idempotency-key': '  requirement-key  ' },
      payload,
    })
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/requirements`,
      headers: { ...jsonHeaders, 'idempotency-key': 'requirement-key' },
      payload,
    })

    expect(first.statusCode).toBe(200)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data.id).toBe(first.json().data.id)
  })

  it('backs up operational writes', async () => {
    const project = await createProject('Backed-up operational project')
    const beforeWrite = vi.spyOn(serviceDataProtection(), 'beforeWrite').mockResolvedValue()
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/requirements`,
      headers: jsonHeaders,
      payload: { stableKey: 'REQ-2', kind: 'requirement', title: 'Backed-up requirement' },
    })

    expect(response.statusCode).toBe(200)
    expect(beforeWrite).toHaveBeenCalledTimes(1)
  })

  it('backs up every operational mutation path', async () => {
    const project = await createProject('Operational mutation coverage')
    const firstWorkItem = await runtime.service.createWorkItem(project.id, { kind: 'task', title: 'First linked task' })
    const secondWorkItem = await runtime.service.createWorkItem(project.id, { kind: 'task', title: 'Second linked task' })
    const checkpoint = await runtime.service.saveCheckpoint(project.id, { expectedVersion: project.version, content: 'Snapshot source' })
    const beforeWrite = vi.spyOn(serviceDataProtection(), 'beforeWrite').mockResolvedValue()

    const state = await runtime.service.createRequirementState(project.id, { name: 'Reviewing', semantic: 'partial' }, 'state-key', 'test')
    const requirement = await runtime.service.createRequirement(project.id, { stableKey: 'REQ-ALL', kind: 'requirement', title: 'Covered requirement', stateId: state.id })
    await runtime.service.updateRequirement(requirement.id, { expectedVersion: requirement.version, title: 'Updated requirement' })
    await runtime.service.linkRequirementWork(project.id, requirement.id, firstWorkItem.id)
    await runtime.service.unlinkRequirementWork(requirement.id, firstWorkItem.id)
    await runtime.service.createWorkQueue(project.id, { name: 'Secondary queue' }, 'queue-key', 'test')
    const relation = await runtime.service.linkWorkItems(project.id, { fromWorkItemId: firstWorkItem.id, toWorkItemId: secondWorkItem.id, kind: 'relates_to' })
    await runtime.service.unlinkWorkItems(relation.id)
    const blocker = await runtime.service.createExternalBlocker(project.id, { content: 'External dependency' }, 'blocker-key', 'test')
    await runtime.service.resolveExternalBlocker(blocker.id)
    const workspace = await runtime.service.createWorkspace({ name: 'Coverage workspace', canonicalRoot: join(dataDir, 'workspace') })
    await runtime.service.linkProjectWorkspace(project.id, workspace.id, 'workspace-link-key', 'test')
    const revision = await runtime.service.createWorkspaceRevision({ workspaceId: workspace.id, dirty: false })
    const run = await runtime.service.createRun(project.id, { workspaceRevisionId: revision.id, command: 'pnpm test', startedAt: '2026-07-10T10:00:00.000Z', endedAt: '2026-07-10T10:00:01.000Z', outcome: 'verified', exitCode: 0 }, 'run-key', 'test')
    await runtime.service.createEvidence(project.id, { runId: run.run.id, result: 'verified', summary: 'Tests passed' })
    const legacySnapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/checkpoints/${checkpoint.checkpoint.id}/legacy-snapshot`,
      headers: { ...jsonHeaders, 'idempotency-key': 'snapshot-key', 'x-istra-client': 'test' },
      payload: {},
    })

    expect(legacySnapshotResponse.statusCode).toBe(200)
    expect(legacySnapshotResponse.json()).toMatchObject({ data: { checkpointId: checkpoint.checkpoint.id, schemaVersion: 3 } })
    expect(beforeWrite).toHaveBeenCalledTimes(16)
  })

  it('allows HTTP verification overrides and records their audit context', async () => {
    const project = await createProject('Override audit project')
    const reason = 'Verified manually against an external signed test report.'
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/evidence`,
      headers: { ...jsonHeaders, 'idempotency-key': 'override-evidence-key', 'x-istra-client': 'mcp:override-reviewer' },
      payload: { result: 'verified', summary: 'External verification accepted', override: { reason } },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        result: 'verified',
        validationStatus: 'overridden',
        override: { reason, actor: 'mcp:override-reviewer', source: 'ui', client: 'mcp:override-reviewer', createdAt: expect.any(String) },
      },
    })

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}`,
      headers: { host: 'localhost:4317' },
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().data.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'evidence.created',
        source: 'ui',
        client: 'mcp:override-reviewer',
        actor: 'mcp:override-reviewer',
        idempotencyKey: 'override-evidence-key',
        payload: expect.objectContaining({ overridden: true }),
      }),
    ]))
  })

  it('applies search filters before the requested result limit', async () => {
    const otherProject = await createProject('Other search project')
    for (let index = 0; index < 201; index += 1) {
      await runtime.service.createPhase(otherProject.id, { name: `needle ${index}`, description: 'needle needle' })
    }
    const targetProject = await createProject('Target search project')
    const targetPhase = await runtime.service.createPhase(targetProject.id, { name: 'Target phase', description: 'needle' })

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/search?q=needle&limit=1&projectId=${targetProject.id}&entityTypes=phase`,
      headers: { host: 'localhost:4317' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual([
      expect.objectContaining({ id: targetPhase.id, projectId: targetProject.id, type: 'phase' }),
    ])
  })

  it('excludes core search results that do not match state filters', async () => {
    const project = await createProject('State-filtered search project')
    const openItem = await runtime.service.createWorkItem(project.id, { kind: 'task', title: 'shared search term', status: 'open' })
    const resolvedItem = await runtime.service.createWorkItem(project.id, { kind: 'task', title: 'shared search term', status: 'resolved' })

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/search?q=shared&projectId=${project.id}&entityTypes=work_item&state=resolved`,
      headers: { host: 'localhost:4317' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().data).toEqual([
      expect.objectContaining({ id: resolvedItem.id, projectId: project.id, type: 'work_item' }),
    ])
    expect(response.json().data).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: openItem.id }),
    ]))
  })

  it('returns not-found errors for missing checkpoint snapshot resources', async () => {
    const checkpointId = '00000000-0000-4000-8000-000000000000'
    for (const suffix of ['snapshot', 'state']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/checkpoints/${checkpointId}/${suffix}`,
        headers: { host: 'localhost:4317' },
      })
      expect(response.statusCode).toBe(404)
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    }
  })
})
