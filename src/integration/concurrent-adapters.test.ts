import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHttpApp } from '../adapters/http/app.js'
import { createMcpServer } from '../adapters/mcp/server.js'
import { createRuntime } from '../infrastructure/runtime.js'

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
    mcpRuntime.close()
    httpRuntime.close()
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
    await mcpRuntime.backupManager.beforeWrite()

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

    const detail = httpRuntime.service.getProject(project.id)
    expect(detail?.project.version).toBe(project.version + 1)
    expect(detail?.project.state).toBe(httpSucceeded ? 'paused' : 'completed')
    expect(detail?.activity.filter(({ eventType }) => eventType === 'project.updated')).toHaveLength(1)
  })
})
