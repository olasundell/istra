import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityEvent, Project, ProjectDetail } from '../../domain/contracts.js'
import { createRuntime } from '../../infrastructure/runtime.js'
import { createMcpServer } from './server.js'

describe('MCP server contract', () => {
  let client: Client
  let server: ReturnType<typeof createMcpServer>
  let runtime: Awaited<ReturnType<typeof createRuntime>>
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'istra-mcp-test-'))
    runtime = await createRuntime({ dataDir })
    server = createMcpServer(runtime.service)
    client = new Client({ name: 'istra-test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await client.close()
    await server.close()
    runtime.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  function structured<T>(response: unknown): T {
    expect(response).toEqual(expect.objectContaining({ structuredContent: expect.any(Object) }))
    return (response as { structuredContent: Record<string, unknown> }).structuredContent.result as T
  }

  it('exposes the required non-destructive tools and omits import, restore and hard deletion', async () => {
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool]))

    expect([...byName.keys()]).toEqual(expect.arrayContaining([
      'archive_project',
      'create_phase',
      'create_project',
      'create_update',
      'create_work_item',
      'get_project_pulse',
      'list_projects',
      'list_work_items',
      'revise_update',
      'save_checkpoint',
      'search',
      'update_phase',
      'update_project',
      'update_work_item',
    ]))
    expect(byName.has('import')).toBe(false)
    expect(byName.has('restore_backup')).toBe(false)
    expect(byName.has('delete_project')).toBe(false)
    expect(byName.has('hard_delete_update')).toBe(false)

    for (const tool of tools) expect(tool.annotations?.destructiveHint).toBe(false)
    for (const readTool of ['list_projects', 'get_project_pulse', 'list_work_items', 'search']) {
      expect(byName.get(readTool)?.annotations?.readOnlyHint).toBe(true)
    }
  })

  it('returns machine-readable results and records MCP client provenance on writes', async () => {
    const creation = await client.callTool({
      name: 'create_project',
      arguments: { title: 'MCP-created project', client: 'codex-audit' },
    })
    expect(creation.isError).not.toBe(true)
    expect(creation.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('MCP-created project') }),
    ]))
    const project = structured<Project>(creation)

    const update = await client.callTool({
      name: 'create_update',
      arguments: {
        projectId: project.id,
        kind: 'decision',
        content: 'Keep the SQLite history durable.',
        client: 'codex-audit',
      },
    })
    expect(update.isError).not.toBe(true)

    const pulseResult = await client.callTool({
      name: 'get_project_pulse',
      arguments: { projectId: project.id },
    })
    const detail = structured<ProjectDetail>(pulseResult)
    expect(detail.updates[0]?.currentRevision.content).toBe('Keep the SQLite history durable.')
    expect(detail.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'project.created',
        source: 'mcp',
        client: 'codex-audit',
      } satisfies Partial<ActivityEvent>),
      expect.objectContaining({
        eventType: 'update.created',
        source: 'mcp',
        client: 'codex-audit',
        payload: expect.objectContaining({ content: 'Keep the SQLite history durable.' }),
      }),
    ]))
  })

  it('shares live state with the application service in both directions', async () => {
    const applicationProject = await runtime.service.createProject(
      { title: 'Created through the application service' },
      { source: 'ui', client: 'http' },
    )

    const listed = structured<Project[]>(await client.callTool({ name: 'list_projects', arguments: {} }))
    expect(listed.map(({ id }) => id)).toContain(applicationProject.id)

    const mcpProject = structured<Project>(await client.callTool({
      name: 'create_project',
      arguments: { title: 'Visible to HTTP services' },
    }))
    expect(runtime.service.getProject(mcpProject.id)?.project.title).toBe('Visible to HTTP services')
  })
})
