import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExportBundle } from '../../application/ports.js'
import { createRuntime } from '../../infrastructure/runtime.js'
import { buildHttpApp } from './app.js'

describe('HTTP API contract', () => {
  let app: FastifyInstance
  let closeRuntime: () => void
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'istra-http-test-'))
    const runtime = await createRuntime({ dataDir })
    closeRuntime = runtime.close
    app = await buildHttpApp({ service: runtime.service })
  })

  afterEach(async () => {
    await app.close()
    closeRuntime()
    await rm(dataDir, { recursive: true, force: true })
  })

  const jsonHeaders = { host: '127.0.0.1:4317', 'content-type': 'application/json' }

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

    const exportResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/export',
      headers: { host: 'localhost:4317' },
    })
    expect(exportResponse.statusCode).toBe(200)
    expect(exportResponse.headers['content-disposition']).toContain('attachment;')
    const exported = exportResponse.json() as ExportBundle
    expect(exported).toMatchObject({ format: 'istra-export', formatVersion: 1 })
    expect(exported).not.toHaveProperty('data')

    const importResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/import',
      headers: jsonHeaders,
      payload: exported,
    })
    expect(importResponse.statusCode).toBe(200)
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
})
