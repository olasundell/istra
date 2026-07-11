import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHttpApp } from '../adapters/http/app.js'
import { createMcpServer } from '../adapters/mcp/server.js'
import { createRuntime } from '../infrastructure/runtime.js'
import { resolveDatabasePaths } from '../infrastructure/sqlite/database.js'

describe('concurrent HTTP and MCP writes', () => {
  let dataDir: string
  let httpRuntime: Awaited<ReturnType<typeof createRuntime>>
  let mcpRuntime: Awaited<ReturnType<typeof createRuntime>>
  let app: FastifyInstance
  let server: ReturnType<typeof createMcpServer>
  let client: Client

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'istra-concurrency-test-'))
    httpRuntime = await createRuntime({ dataDir })
    mcpRuntime = await createRuntime({ dataDir })
    app = await buildHttpApp({ service: httpRuntime.service })
    server = createMcpServer(mcpRuntime.service)
    client = new Client({ name: 'concurrency-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await client.close()
    await server.close()
    await app.close()
    await mcpRuntime.close()
    await httpRuntime.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('allows exactly one adapter to win an optimistic-concurrency race', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { host: '127.0.0.1:4317', 'content-type': 'application/json' },
      payload: { title: 'Contended project' },
    })
    expect(createResponse.statusCode).toBe(200)
    const project = createResponse.json().data as { id: string; version: number }

    // Prime both per-process backup managers so this race exercises the two
    // independent SQLite connections rather than backup initialisation.
    await mcpRuntime.service.createLabel({ name: 'MCP race primer' })

    const [httpResult, mcpResult] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${project.id}`,
        headers: { host: 'localhost:4317', 'content-type': 'application/json' },
        payload: { expectedVersion: project.version, state: 'paused' },
      }),
      client.callTool({
        name: 'update_project',
        arguments: { projectId: project.id, expectedVersion: project.version, state: 'completed', client: 'mcp-racer' },
      }),
    ])

    const httpSucceeded = httpResult.statusCode === 200
    const mcpSucceeded = mcpResult.isError !== true
    expect(Number(httpSucceeded) + Number(mcpSucceeded)).toBe(1)
    if (!httpSucceeded) {
      expect(httpResult.statusCode).toBe(409)
      expect(httpResult.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } })
    }
    if (!mcpSucceeded) {
      expect(mcpResult.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringMatching(/changed|conflict/i) }),
      ]))
    }

    const detail = await httpRuntime.service.getProject(project.id)
    expect(detail?.project.version).toBe(project.version + 1)
    expect(detail?.project.state).toBe(httpSucceeded ? 'paused' : 'completed')
    expect(detail?.activity.filter(({ eventType }) => eventType === 'project.updated')).toHaveLength(1)
  })

  it('replays one stored result across two connections and rejects mismatched key reuse', async () => {
    const project = await httpRuntime.service.createProject({ title: 'Idempotency race' })
    await mcpRuntime.service.createLabel({ name: 'MCP idempotency primer' })
    const payload = { stableKey: 'RACE-1', kind: 'requirement' as const, title: 'Created once' }

    const [first, second] = await Promise.all([
      httpRuntime.service.createRequirement(project.id, payload, 'same-key', 'same-client'),
      mcpRuntime.service.createRequirement(project.id, payload, 'same-key', 'same-client'),
    ])

    expect(second.id).toBe(first.id)
    expect((await httpRuntime.service.listRequirements(project.id)).filter(({ stableKey }) => stableKey === 'RACE-1')).toHaveLength(1)
    expect((await httpRuntime.service.listActivity(project.id)).filter(({ eventType, entityId }) => eventType === 'requirement.created' && entityId === first.id)).toHaveLength(1)
    await expect(mcpRuntime.service.createRequirement(project.id, { ...payload, title: 'Different payload' }, 'same-key', 'same-client')).rejects.toThrow(/Idempotency key/)
  })

  it('rolls an interrupted writer transaction back so an idempotent retry can complete', async () => {
    const project = await httpRuntime.service.createProject({ title: 'Crash retry' })
    const state = (await httpRuntime.operationalRepository.listRequirementStates(project.id))[0]!
    const worker = new Worker(`
      const { randomUUID } = require('node:crypto');
      const { DatabaseSync } = require('node:sqlite');
      const { workerData } = require('node:worker_threads');
      const db = new DatabaseSync(workerData.databasePath);
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
      const now = new Date().toISOString();
      db.prepare('INSERT INTO requirements(id,project_id,stable_key,kind,title,state_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(), workerData.projectId, 'CRASH-1', 'requirement', 'Uncommitted requirement', workerData.stateId, now, now);
      process.exit(0);
    `, { eval: true, workerData: { databasePath: resolveDatabasePaths(dataDir).databasePath, projectId: project.id, stateId: state.id } })
    await new Promise<void>((resolvePromise, rejectPromise) => {
      worker.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`worker exited ${code}`)))
      worker.once('error', rejectPromise)
    })

    expect((await httpRuntime.service.listRequirements(project.id)).some(({ stableKey }) => stableKey === 'CRASH-1')).toBe(false)
    const retry = await mcpRuntime.service.createRequirement(project.id, {
      stableKey: 'CRASH-1', kind: 'requirement', title: 'Committed retry',
    }, 'crash-key', 'crash-client')
    expect(retry.title).toBe('Committed retry')
    expect((await httpRuntime.service.listRequirements(project.id)).filter(({ stableKey }) => stableKey === 'CRASH-1')).toHaveLength(1)
  })
})
