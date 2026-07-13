import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityEvent, ErrorReport, Project, ProjectDetail } from '../../domain/contracts.js'
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
    await runtime.close()
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
      'backfill_legacy_checkpoint_snapshot',
      'create_evidence',
      'report_error',
      'list_error_reports_page',
      'get_error_report',
      'get_storage_status',
      'update_error_report',
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
      'get_queue_automation_policy',
      'get_queue_automation_overview',
      'update_queue_automation_policy',
      'claim_next_automated_work',
      'heartbeat_automated_work',
      'record_automation_attempt',
      'complete_automated_work',
      'release_automated_work',
      'wait_for_queue_changes',
    ]))
    expect(byName.has('import')).toBe(false)
    expect(byName.has('restore_backup')).toBe(false)
    expect(byName.has('delete_project')).toBe(false)
    expect(byName.has('hard_delete_update')).toBe(false)
    expect(byName.has('capture_checkpoint_snapshot')).toBe(false)
    expect((byName.get('create_evidence')?.inputSchema as { properties?: Record<string, unknown> }).properties).not.toHaveProperty('override')

    const errorReportSchema = byName.get('report_error')?.inputSchema as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
    expect(errorReportSchema.required).toEqual(expect.arrayContaining(['kind', 'component', 'summary', 'observation', 'idempotencyKey']))
    expect(errorReportSchema.required).not.toContain('projectId')
    expect(errorReportSchema.additionalProperties).toBe(false)

    const createRunSchema = byName.get('create_run')?.inputSchema as {
      properties?: Record<string, { type?: string; anyOf?: Array<{ type?: string }> }>
      required?: string[]
    }
    expect(Object.keys(createRunSchema.properties ?? {})).toEqual(expect.arrayContaining([
      'projectId',
      'idempotencyKey',
      'command',
      'workingDirectory',
      'startedAt',
      'endedAt',
      'outcome',
      'exitCode',
      'toolchain',
      'stdoutExcerpt',
      'stderrExcerpt',
      'testSummary',
    ]))
    expect(createRunSchema.required).toEqual(expect.arrayContaining(['projectId', 'idempotencyKey', 'command']))
    expect(createRunSchema.properties?.exitCode?.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'integer' }),
    ]))
    expect(createRunSchema.properties?.toolchain).toMatchObject({ type: 'object' })
    expect(createRunSchema.properties?.testSummary).toMatchObject({ type: 'object' })

    for (const name of ['update_queue_automation_policy','claim_next_automated_work','heartbeat_automated_work','record_automation_attempt','complete_automated_work','release_automated_work']) {
      const schema = byName.get(name)?.inputSchema as { required?: string[]; properties?: Record<string, { enum?: string[] }> }
      expect(schema.required).toEqual(expect.arrayContaining(['client', 'idempotencyKey']))
      expect(byName.get(name)?.annotations?.idempotentHint).toBe(true)
    }
    const releaseSchema = byName.get('release_automated_work')?.inputSchema as { required?: string[]; properties?: Record<string, { enum?: string[] }> }
    expect(releaseSchema.required).toEqual(expect.arrayContaining(['leaseToken']))
    expect(releaseSchema.properties?.reason?.enum).toEqual(['runner_shutdown', 'abandoned'])
    expect(byName.has('operator_release_automated_work')).toBe(false)
    const waitSchema = byName.get('wait_for_queue_changes')?.inputSchema as { properties?: Record<string, { type?: string; minimum?: number; maximum?: number; default?: number }> }
    expect(waitSchema.properties?.timeoutSeconds).toMatchObject({ type: 'integer', minimum: 0, maximum: 60, default: 30 })

    for (const tool of tools) expect(tool.annotations?.destructiveHint).toBe(false)
    for (const readTool of ['get_storage_status', 'list_projects', 'get_project_pulse', 'list_work_items', 'search']) {
      expect(byName.get(readTool)?.annotations?.readOnlyHint).toBe(true)
    }

    const storage = structured<{
      backend: string
      target: string
      schemaVersion: number
      ready: boolean
      automaticBackups: boolean
      importSupported: boolean
    }>(await client.callTool({ name: 'get_storage_status', arguments: {} }))
    expect(storage).toMatchObject({
      backend: 'sqlite',
      target: expect.stringContaining('istra.sqlite3'),
      schemaVersion: expect.any(Number),
      ready: true,
      automaticBackups: true,
      importSupported: true,
    })
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
    expect((await runtime.service.getProject(mcpProject.id))?.project.title).toBe('Visible to HTTP services')
  })

  it('reports and triages Istra faults through strict, idempotent MCP tools', async () => {
    const arguments_ = {
      kind: 'bug', component: 'mcp:create_run', summary: 'Secret leaked in an error response',
      observation: 'TOKEN=secret appeared in an MCP response.', expectedBehaviour: 'Secrets are redacted.', actualBehaviour: 'TOKEN=secret was visible.',
      reproductionSteps: ['Call create_run with TOKEN=secret.'], impact: 'Sensitive data could be exposed.',
      idempotencyKey: 'mcp-error-report-1', client: 'codex-error-reporter',
    }
    const created = await client.callTool({ name: 'report_error', arguments: arguments_ })
    expect(created.isError).not.toBe(true)
    const report = structured<ErrorReport>(created)
    expect(report).toMatchObject({ kind: 'bug', status: 'open', source: 'mcp', client: 'codex-error-reporter' })
    expect(report.observation).toContain('[REDACTED]')

    const replay = structured<ErrorReport>(await client.callTool({ name: 'report_error', arguments: arguments_ }))
    expect(replay.id).toBe(report.id)
    const changedPayload = await client.callTool({ name: 'report_error', arguments: { ...arguments_, summary: 'Different report' } })
    expect(changedPayload.isError).toBe(true)
    const invalidPayload = await client.callTool({ name: 'report_error', arguments: { ...arguments_, idempotencyKey: 'mcp-error-report-invalid', unexpected: true } })
    expect(invalidPayload.isError).toBe(true)
    const invalidKind = await client.callTool({ name: 'report_error', arguments: { ...arguments_, idempotencyKey: 'mcp-error-report-kind', kind: 'incident' } })
    expect(invalidKind.isError).toBe(true)

    const listed = structured<{ items: ErrorReport[] }>(await client.callTool({ name: 'list_error_reports_page', arguments: {} }))
    expect(listed.items.map(({ id }) => id)).toContain(report.id)
    const detail = structured<{ report: ErrorReport; history: ActivityEvent[] }>(await client.callTool({ name: 'get_error_report', arguments: { reportId: report.id } }))
    expect(detail.history).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'error_report.created' })]))

    const acknowledged = structured<ErrorReport>(await client.callTool({ name: 'update_error_report', arguments: { reportId: report.id, expectedVersion: report.version, status: 'acknowledged', triageNote: 'Investigating the redaction boundary.', client: 'codex-triage' } }))
    expect(acknowledged).toMatchObject({ status: 'acknowledged', version: report.version + 1 })
    const stale = await client.callTool({ name: 'update_error_report', arguments: { reportId: report.id, expectedVersion: report.version, status: 'resolved' } })
    expect(stale.isError).toBe(true)
  })

  it('preserves existing MCP write call shapes without idempotency keys', async () => {
    const project = structured<Project>(await client.callTool({
      name: 'create_project',
      arguments: { title: 'Backwards-compatible project' },
    }))
    const phase = await client.callTool({
      name: 'create_phase',
      arguments: { projectId: project.id, name: 'Compatibility phase' },
    })
    const workItem = await client.callTool({
      name: 'create_work_item',
      arguments: { projectId: project.id, kind: 'task', title: 'Compatibility task' },
    })
    const update = structured<{ id: string; version: number }>(await client.callTool({
      name: 'create_update',
      arguments: { projectId: project.id, kind: 'progress', content: 'Initial update' },
    }))
    const revision = await client.callTool({
      name: 'revise_update',
      arguments: { updateId: update.id, expectedVersion: update.version, content: 'Revised update' },
    })
    const checkpointResponse = await client.callTool({
      name: 'save_checkpoint',
      arguments: { projectId: project.id, expectedVersion: project.version, content: 'Compatibility checkpoint' },
    })

    for (const response of [phase, workItem, revision, checkpointResponse]) expect(response.isError).not.toBe(true)
    expect(structured<{ checkpoint: { kind: string }; snapshot: { digest: string; schemaVersion: number } }>(checkpointResponse)).toMatchObject({
      checkpoint: { kind: 'checkpoint' },
      snapshot: { digest: expect.stringMatching(/^[a-f0-9]{64}$/), schemaVersion: 3 },
    })
  })

  it('accepts validated verified evidence but does not honour MCP override input', async () => {
    const project = structured<Project>(await client.callTool({
      name: 'create_project',
      arguments: { title: 'MCP evidence project' },
    }))
    const run = structured<{ run: { id: string; outcome: string; validationStatus: string } }>(await client.callTool({
      name: 'create_run',
      arguments: {
        projectId: project.id,
        idempotencyKey: 'verified-run-key',
        client: 'codex-evidence',
        command: 'pnpm test',
        startedAt: '2026-07-10T10:00:00.000Z',
        endedAt: '2026-07-10T10:00:01.000Z',
        outcome: 'verified',
        exitCode: 0,
      },
    }))
    expect(run.run).toMatchObject({ outcome: 'verified', validationStatus: 'validated' })

    const evidence = await client.callTool({
      name: 'create_evidence',
      arguments: {
        projectId: project.id,
        idempotencyKey: 'verified-evidence-key',
        client: 'codex-evidence',
        runId: run.run.id,
        result: 'verified',
        summary: 'The verified run passed.',
      },
    })
    expect(evidence.isError).not.toBe(true)
    expect(structured<{ validationStatus: string; override: unknown }>(evidence)).toMatchObject({ validationStatus: 'validated', override: null })

    const overrideAttempt = await client.callTool({
      name: 'create_evidence',
      arguments: {
        projectId: project.id,
        idempotencyKey: 'override-attempt-key',
        client: 'codex-evidence',
        result: 'verified',
        summary: 'Attempt an MCP override.',
        override: { reason: 'MCP must not be able to create an override.' },
      },
    })
    expect(overrideAttempt.isError).toBe(true)
    expect(overrideAttempt.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringMatching(/override|unrecognized|unknown/i) }),
    ]))
  })

  it('returns tool errors for missing nullable resources', async () => {
    const missingId = '00000000-0000-4000-8000-000000000000'
    const calls = [
      { name: 'get_project_pulse_summary', arguments: { projectId: missingId } },
      { name: 'get_requirement', arguments: { requirementId: missingId } },
      { name: 'get_checkpoint_snapshot', arguments: { checkpointId: missingId } },
      { name: 'reconstruct_checkpoint_state', arguments: { checkpointId: missingId } },
    ]

    for (const call of calls) {
      const response = await client.callTool(call)
      expect(response.isError).toBe(true)
    }
  })
})
