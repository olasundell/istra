import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IstraService } from '../../application/istra-service.js'
import type { DataProtection } from '../../application/ports.js'
import type { MutationContext, Provenance } from '../../domain/contracts.js'
import { openIstraDatabase } from './database.js'
import { SqliteOperationalRepository } from './operational-repository.js'
import { SqliteIstraRepository } from './repository.js'

const provenance: Provenance = { source: 'system', client: 'automation-test' }
const context = (key: string): MutationContext => ({ source: 'mcp', client: 'automation-test', actor: 'automation-test', idempotencyKey: key, occurredAt: new Date().toISOString() })

describe('SQLite agent queue automation', () => {
  let dataDir: string
  let database: Awaited<ReturnType<typeof openIstraDatabase>>
  let repository: SqliteIstraRepository
  let operational: SqliteOperationalRepository
  let service: IstraService

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'istra-automation-test-'))
    database = await openIstraDatabase({ dataDir })
    repository = new SqliteIstraRepository(database.db)
    operational = new SqliteOperationalRepository(database.db)
    const protection: DataProtection = { backend: 'sqlite', automatic: false, importSupported: true, beforeWrite: async () => undefined, create: async () => '', list: async () => [] }
    service = new IstraService(repository, protection, operational)
  })

  afterEach(async () => {
    vi.useRealTimers()
    database.db.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('keeps policies disabled by default and atomically claims eligible ranked work', async () => {
    const project = repository.createProject({ title: 'Automation contract' }, provenance)
    const requirement = operational.createRequirement(project.id, { stableKey: 'AUTOMATION-1', kind: 'requirement', title: 'Automated delivery is safe' })
    repository.createUpdate(project.id, { kind: 'decision', content: 'Use bounded lease tokens.' }, provenance)
    const blocked = repository.createWorkItem(project.id, { kind: 'task', title: 'Blocked first' }, provenance)
    const eligible = repository.createWorkItem(project.id, { kind: 'issue', title: 'Eligible second', requirementIds: [requirement.id] }, provenance)
    operational.createExternalBlocker(project.id, { workItemId: blocked.id, content: 'Waiting for review' })
    const queueId = eligible.queueId!

    expect(operational.getQueueAutomationPolicy(project.id, queueId)).toMatchObject({ enabled: false, version: 0 })
    expect(await service.claimNextAutomatedWork(project.id, queueId, { workerId: 'worker-a', idempotencyKey: 'disabled-claim' }, { source: 'mcp', client: 'worker-a' })).toMatchObject({ outcome: 'policy_disabled' })

    await service.updateQueueAutomationPolicy(project.id, queueId, {
      expectedVersion: null, enabled: true, allowedKinds: ['issue', 'task'], maxActiveClaims: 1, leaseSeconds: 30,
      requiresManualApproval: true, allowSameWorkerRecovery: true,
    }, 'enable-policy', { source: 'mcp', client: 'operator' })

    const claim = await service.claimNextAutomatedWork(project.id, queueId, { workerId: 'worker-a', idempotencyKey: 'claim-1' }, { source: 'mcp', client: 'worker-a' })
    expect(claim).toMatchObject({ outcome: 'claimed', item: { id: eligible.id, status: 'in_progress' }, lease: { workerId: 'worker-a' }, attempt: { ordinal: 1 } })
    if (claim.outcome !== 'claimed') throw new Error('Expected a claim')
    expect(claim.feed).toMatchObject({ requirementIds: [requirement.id], blockerReasons: [], currentCheckpoint: null, recentUpdates: [expect.objectContaining({ content: 'Use bounded lease tokens.' })] })
    expect(claim.lease.leaseToken).toHaveLength(43)

    const replay = await service.claimNextAutomatedWork(project.id, queueId, { workerId: 'worker-a', idempotencyKey: 'claim-1' }, { source: 'mcp', client: 'worker-a' })
    expect(replay).toEqual(claim)
    expect(await service.claimNextAutomatedWork(project.id, queueId, { workerId: 'worker-b', idempotencyKey: 'claim-2' }, { source: 'mcp', client: 'worker-b' })).toMatchObject({ outcome: 'capacity_reached' })

    expect(await service.heartbeatAutomatedWork(claim.lease.id, { leaseToken: claim.lease.leaseToken, idempotencyKey: 'heartbeat-1' }, { source: 'mcp', client: 'worker-a' })).toMatchObject({ outcome: 'heartbeat' })
    expect(await service.recordAutomationAttempt(claim.lease.id, {
      leaseToken: claim.lease.leaseToken, idempotencyKey: 'attempt-1', kind: 'delivery', summary: 'Prepared an integration commit.',
      delivery: { repositoryPath: '/tmp/repository', integrationBranch: 'feature/example', commitSha: 'abcdef1', commitMessage: 'Implement example' },
    }, { source: 'mcp', client: 'worker-a' })).toMatchObject({ sequence: 1, kind: 'delivery' })

    const completed = await service.completeAutomatedWork(claim.lease.id, {
      leaseToken: claim.lease.leaseToken, idempotencyKey: 'complete-1', outcome: 'resolved', expectedWorkItemVersion: claim.item.version,
    }, { source: 'mcp', client: 'worker-a' })
    expect(completed).toMatchObject({ outcome: 'awaiting_approval', item: { id: eligible.id, status: 'in_progress' }, lease: { releasedAt: expect.any(String) } })
    expect(operational.getQueueAutomationOverview(project.id, queueId)).toMatchObject({ activeLeases: [], lastAttempt: { outcome: 'awaiting_approval', observations: [expect.objectContaining({ kind: 'delivery' })] } })
  })

  it('does not overwrite human changes and wakes a cursor when a lease expires', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const project = repository.createProject({ title: 'Lease safety' }, provenance)
    const item = repository.createWorkItem(project.id, { kind: 'task', title: 'Automated task' }, provenance)
    const queueId = item.queueId!
    operational.runMutation(context('enable'), 'update_queue_automation_policy', {}, () => operational.updateQueueAutomationPolicy(project.id, queueId, {
      expectedVersion: null, enabled: true, allowedKinds: ['task'], maxActiveClaims: 1, leaseSeconds: 30, requiresManualApproval: false, allowSameWorkerRecovery: true,
    }))
    const claim = await service.claimNextAutomatedWork(project.id, queueId, { workerId: 'worker-a', idempotencyKey: 'claim' }, { source: 'mcp', client: 'worker-a' })
    if (claim.outcome !== 'claimed') throw new Error('Expected a claim')

    const human = repository.updateWorkItem(item.id, { expectedVersion: claim.item.version, title: 'Human changed title' }, provenance)
    expect(await service.completeAutomatedWork(claim.lease.id, { leaseToken: claim.lease.leaseToken, idempotencyKey: 'complete', outcome: 'resolved', expectedWorkItemVersion: human.version }, { source: 'mcp', client: 'worker-a' })).toMatchObject({ outcome: 'human_changed_state', item: { title: 'Human changed title' } })

    vi.setSystemTime(new Date('2026-07-11T12:00:31.000Z'))
    const feed = await service.waitForQueueChanges(project.id, queueId, { cursor: claim.feed.cursor, timeoutSeconds: 0 })
    expect(feed.timedOut).toBe(false)
    expect(feed.changes).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'work_lease.expired', entityId: claim.lease.id })]))
    expect(await service.operatorReleaseAutomatedWork(claim.lease.id, { expectedLeaseVersion: claim.lease.version, reason: 'manual', idempotencyKey: 'release' }, { source: 'ui', client: 'istra-web' })).toMatchObject({ outcome: 'released', item: { title: 'Human changed title', status: 'in_progress' } })
  })

  it('fences completion and heartbeat when an operator disables automation', async () => {
    const project = repository.createProject({ title: 'Disabled policy fence' }, provenance)
    const item = repository.createWorkItem(project.id, { kind: 'task', title: 'Do not finish after disable' }, provenance)
    const queueId = item.queueId!
    await service.updateQueueAutomationPolicy(project.id, queueId, {
      expectedVersion: null, enabled: true, allowedKinds: ['task'], maxActiveClaims: 1, leaseSeconds: 60,
      requiresManualApproval: false, allowSameWorkerRecovery: true,
    }, 'enable', { source: 'ui', client: 'operator' })
    const claim = await service.claimNextAutomatedWork(project.id, queueId, { workerId: 'worker-a', idempotencyKey: 'claim' }, { source: 'mcp', client: 'worker-a' })
    if (claim.outcome !== 'claimed') throw new Error('Expected a claim')
    await service.updateQueueAutomationPolicy(project.id, queueId, {
      expectedVersion: 1, enabled: false, allowedKinds: ['task'], maxActiveClaims: 1, leaseSeconds: 60,
      requiresManualApproval: false, allowSameWorkerRecovery: true,
    }, 'disable', { source: 'ui', client: 'operator' })

    await expect(service.heartbeatAutomatedWork(claim.lease.id, { leaseToken: claim.lease.leaseToken, idempotencyKey: 'heartbeat' }, { source: 'mcp', client: 'worker-a' }))
      .resolves.toMatchObject({ outcome: 'policy_disabled', item: { status: 'in_progress' } })
    await expect(service.completeAutomatedWork(claim.lease.id, { leaseToken: claim.lease.leaseToken, idempotencyKey: 'complete', outcome: 'resolved', expectedWorkItemVersion: claim.item.version }, { source: 'mcp', client: 'worker-a' }))
      .resolves.toMatchObject({ outcome: 'policy_disabled', item: { status: 'in_progress' }, lease: { releasedAt: null } })
  })

  it('pages a queue change backlog without advancing past undelivered rows', async () => {
    const project = repository.createProject({ title: 'Paged feed' }, provenance)
    const item = repository.createWorkItem(project.id, { kind: 'task', title: 'Feed item' }, provenance)
    const queueId = item.queueId!
    const start = Number((database.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM automation_queue_changes WHERE queue_id=?').get(queueId) as { sequence: number }).sequence)
    const insert = database.db.prepare('INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at) VALUES (?,?,?,?,?,?)')
    for (let index = 0; index < 201; index += 1) insert.run(project.id, queueId, 'work_item.updated', 'work_item', item.id, new Date(1_700_000_000_000 + index).toISOString())

    const first = operational.readAutomationQueueChanges(project.id, queueId, start, '2020-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    const second = operational.readAutomationQueueChanges(project.id, queueId, first.cursorSequence, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
    expect(first.changes).toHaveLength(200)
    expect(first.cursorSequence).toBe(first.changes.at(-1)!.sequence)
    expect(second.changes).toHaveLength(1)

    const otherProject = repository.createProject({ title: 'Other cursor scope' }, provenance)
    const otherItem = repository.createWorkItem(otherProject.id, { kind: 'task', title: 'Other item' }, provenance)
    const cursor = operational.getQueueAutomationOverview(project.id, queueId).cursor
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toMatchObject({ version: 1, projectId: project.id, queueId })
    await expect(service.waitForQueueChanges(otherProject.id, otherItem.queueId!, { cursor, timeoutSeconds: 0 })).rejects.toThrow(/invalid automation queue cursor/i)

    const invalidCursor = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    await expect(service.waitForQueueChanges(project.id, queueId, {
      cursor: invalidCursor({ version: 2, projectId: project.id, queueId, sequence: first.cursorSequence, checkedAt: new Date().toISOString() }),
      timeoutSeconds: 0,
    })).rejects.toThrow(/invalid automation queue cursor/i)
    await expect(service.waitForQueueChanges(project.id, queueId, {
      cursor: invalidCursor({ version: 1, projectId: project.id, queueId, sequence: first.cursorSequence, checkedAt: '2999-01-01T00:00:00.000Z' }),
      timeoutSeconds: 0,
    })).rejects.toThrow(/invalid automation queue cursor/i)
    await expect(service.waitForQueueChanges(project.id, queueId, {
      cursor: invalidCursor({ version: 1, projectId: project.id, queueId, sequence: second.cursorSequence + 1, checkedAt: new Date().toISOString() }),
      timeoutSeconds: 0,
    })).rejects.toThrow(/invalid automation queue cursor/i)
  })

  it('exports active leases without reusable tokens and leaves live replay unchanged', async () => {
    const project = repository.createProject({ title: 'Token-safe export' }, provenance)
    const item = repository.createWorkItem(project.id, { kind: 'task', title: 'Protected claim' }, provenance)
    await service.updateQueueAutomationPolicy(project.id, item.queueId!, {
      expectedVersion: null, enabled: true, allowedKinds: ['task'], maxActiveClaims: 1, leaseSeconds: 60,
      requiresManualApproval: false, allowSameWorkerRecovery: true,
    }, 'enable', { source: 'ui', client: 'operator' })
    const claimInput = { workerId: 'worker-a', idempotencyKey: 'claim-token' }
    const claim = await service.claimNextAutomatedWork(project.id, item.queueId!, claimInput, { source: 'mcp', client: 'worker-a' })
    if (claim.outcome !== 'claimed') throw new Error('Expected a claim')
    const stored = database.db.prepare('SELECT token_hash,heartbeat_at,expires_at FROM work_leases WHERE id=?').get(claim.lease.id) as { token_hash: string; heartbeat_at: string; expires_at: string }

    const bundle = repository.exportAll()
    const exportedLease = bundle.tables.work_leases!.find(({ id }) => id === claim.lease.id)!
    expect(exportedLease.token_hash).toBe(createHash('sha256').update(stored.token_hash).digest('hex'))
    expect(exportedLease.expires_at).toBe(stored.heartbeat_at)
    expect(bundle.tables.idempotency_records).not.toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'claim_next_automated_work' })]))
    expect(database.db.prepare('SELECT token_hash,expires_at FROM work_leases WHERE id=?').get(claim.lease.id)).toEqual({ token_hash: stored.token_hash, expires_at: stored.expires_at })
    await expect(service.claimNextAutomatedWork(project.id, item.queueId!, claimInput, { source: 'mcp', client: 'worker-a' })).resolves.toEqual(claim)
  })

  it('recovers only an unchanged expired lease owned by the same worker', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-11T13:00:00.000Z'))
    const project = repository.createProject({ title: 'Strict recovery' }, provenance)
    const item = repository.createWorkItem(project.id, { kind: 'task', title: 'Recoverable item' }, provenance)
    await service.updateQueueAutomationPolicy(project.id, item.queueId!, {
      expectedVersion: null, enabled: true, allowedKinds: ['task'], maxActiveClaims: 1, leaseSeconds: 30,
      requiresManualApproval: false, allowSameWorkerRecovery: true,
    }, 'enable', { source: 'ui', client: 'operator' })
    const first = await service.claimNextAutomatedWork(project.id, item.queueId!, { workerId: 'worker-a', idempotencyKey: 'claim-1' }, { source: 'mcp', client: 'worker-a' })
    if (first.outcome !== 'claimed') throw new Error('Expected a claim')
    vi.setSystemTime(new Date('2026-07-11T13:00:31.000Z'))
    const recovered = await service.claimNextAutomatedWork(project.id, item.queueId!, { workerId: 'worker-a', idempotencyKey: 'claim-2' }, { source: 'mcp', client: 'worker-a' })
    expect(recovered).toMatchObject({ outcome: 'claimed', attempt: { ordinal: 2 }, item: { id: item.id } })

    if (recovered.outcome !== 'claimed') throw new Error('Expected a recovery claim')
    repository.updateWorkItem(item.id, { expectedVersion: recovered.item.version, title: 'Human took ownership' }, provenance)
    vi.setSystemTime(new Date('2026-07-11T13:01:02.000Z'))
    await expect(service.claimNextAutomatedWork(project.id, item.queueId!, { workerId: 'worker-a', idempotencyKey: 'claim-3' }, { source: 'mcp', client: 'worker-a' }))
      .resolves.toMatchObject({ outcome: 'empty' })
    expect(operational.getQueueAutomationOverview(project.id, item.queueId!)).toMatchObject({ activeLeases: [], expiredLeases: [expect.objectContaining({ id: recovered.lease.id, state: 'expired' })] })
  })

  it('requires the current lease version for operator release', async () => {
    const project = repository.createProject({ title: 'Operator concurrency' }, provenance)
    const item = repository.createWorkItem(project.id, { kind: 'task', title: 'Versioned release' }, provenance)
    await service.updateQueueAutomationPolicy(project.id, item.queueId!, {
      expectedVersion: null, enabled: true, allowedKinds: ['task'], maxActiveClaims: 1, leaseSeconds: 60,
      requiresManualApproval: false, allowSameWorkerRecovery: true,
    }, 'enable', { source: 'ui', client: 'operator' })
    const claim = await service.claimNextAutomatedWork(project.id, item.queueId!, { workerId: 'worker-a', idempotencyKey: 'claim' }, { source: 'mcp', client: 'worker-a' })
    if (claim.outcome !== 'claimed') throw new Error('Expected a claim')
    const heartbeat = await service.heartbeatAutomatedWork(claim.lease.id, { leaseToken: claim.lease.leaseToken, idempotencyKey: 'heartbeat' }, { source: 'mcp', client: 'worker-a' })
    if (heartbeat.outcome !== 'heartbeat') throw new Error('Expected a heartbeat')
    await expect(service.operatorReleaseAutomatedWork(claim.lease.id, { expectedLeaseVersion: claim.lease.version, reason: 'manual', idempotencyKey: 'stale-release' }, { source: 'ui', client: 'operator' })).rejects.toThrow(/changed/i)
    await expect(service.operatorReleaseAutomatedWork(claim.lease.id, { expectedLeaseVersion: heartbeat.lease.version, reason: 'manual', idempotencyKey: 'release' }, { source: 'ui', client: 'operator' })).resolves.toMatchObject({ outcome: 'released' })
  })

  it('rejects portable automation rows with cross-project ownership', () => {
    const first = repository.createProject({ title: 'First project' }, provenance)
    const second = repository.createProject({ title: 'Second project' }, provenance)
    const item = repository.createWorkItem(first.id, { kind: 'task', title: 'Owned by first' }, provenance)
    operational.updateQueueAutomationPolicy(first.id, item.queueId!, {
      expectedVersion: null, enabled: true, allowedKinds: ['task'], maxActiveClaims: 1, leaseSeconds: 60,
      requiresManualApproval: false, allowSameWorkerRecovery: true,
    })
    const bundle = repository.exportAll()
    bundle.tables.work_queue_automation_policies![0]!.project_id = second.id
    expect(() => repository.validateImport(bundle)).toThrow(/invalid automation data/i)
  })

  it('round-trips automation policy and attempt state through export format v5', async () => {
    const project = repository.createProject({ title: 'Portable automation' }, provenance)
    const item = repository.createWorkItem(project.id, { kind: 'task', title: 'Portable task' }, provenance)
    operational.runMutation(context('policy'), 'update_queue_automation_policy', {}, () => operational.updateQueueAutomationPolicy(project.id, item.queueId!, {
      expectedVersion: null, enabled: true, allowedKinds: ['task'], maxActiveClaims: 1, leaseSeconds: 60, requiresManualApproval: false, allowSameWorkerRecovery: true,
    }))
    const bundle = repository.exportAll()
    expect(bundle.formatVersion).toBe(5)
    expect(bundle.tables.work_queue_automation_policies).toHaveLength(1)
    const targetDir = await mkdtemp(join(tmpdir(), 'istra-automation-import-'))
    const target = await openIstraDatabase({ dataDir: targetDir })
    try {
      const targetRepository = new SqliteIstraRepository(target.db)
      targetRepository.validateImport(bundle); targetRepository.importAll(bundle)
      expect(new SqliteOperationalRepository(target.db).getQueueAutomationPolicy(project.id, item.queueId!)).toMatchObject({ enabled: true, allowedKinds: ['task'] })
    } finally { target.db.close(); await rm(targetDir, { recursive: true, force: true }) }
  })
})
