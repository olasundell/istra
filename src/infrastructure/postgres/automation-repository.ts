import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { ConflictError, NotFoundError, ValidationError } from '../../application/errors.js'
import { encodeAutomationCursor } from '../../application/automation-cursor.js'
import type { WorkItem } from '../../domain/contracts.js'
import type {
  AutomationAttempt, AutomationAttemptObservation, AutomationQueueChange, AutomationQueueProbe,
  ClaimAutomatedWorkResult, ClaimNextAutomatedWorkInput, CompleteAutomatedWorkInput, CompleteAutomatedWorkResult,
  HeartbeatAutomatedWorkInput, HeartbeatAutomatedWorkResult, OperatorReleaseAutomatedWorkInput, QueueAutomationLeaseSummary,
  QueueAutomationOverview, QueueAutomationPolicy, RecordAutomationAttemptInput, ReleaseAutomatedWorkResult, RunnerReleaseAutomatedWorkInput,
  UpdateQueueAutomationPolicyInput, WorkLease,
} from '../../domain/automation.js'
import type { PostgresExecutor } from './database.js'
import { lockProjectGraph } from './project-graph-lock.js'

type Row = Record<string, unknown>
type EventWriter = (projectId: string, entityType: string, entityId: string, eventType: string, payload?: Record<string, unknown>) => Promise<void>
const now = () => new Date().toISOString()
const nullable = (value: unknown): string | null => value == null ? null : value instanceof Date ? value.toISOString() : String(value)
const iso = (value: unknown): string => nullable(value)!
const json = <T>(value: unknown, fallback: T): T => {
  if (value == null) return fallback
  if (typeof value !== 'string') return value as T
  try { return JSON.parse(value) as T } catch { return fallback }
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const expiresAt = (timestamp: string, seconds: number) => new Date(Date.parse(timestamp) + seconds * 1_000).toISOString()

export class PostgresAutomationRepository {
  constructor(private readonly executor: PostgresExecutor, private readonly event: EventWriter) {}

  private async queue(projectId: string, queueId: string): Promise<Row> {
    const row = await this.executor.maybeOne<Row>('SELECT * FROM work_queues WHERE id=$1 AND project_id=$2', [queueId, projectId])
    if (!row) throw new NotFoundError('Work queue', queueId)
    return row
  }

  private policyFromRow(row: Row): QueueAutomationPolicy {
    return {
      queueId: String(row.queue_id), projectId: String(row.project_id), enabled: Boolean(row.enabled),
      allowedKinds: json(row.allowed_kinds_json, ['issue', 'task']), maxActiveClaims: Number(row.max_active_claims),
      leaseSeconds: Number(row.lease_seconds), requiresManualApproval: Boolean(row.requires_manual_approval),
      allowSameWorkerRecovery: Boolean(row.allow_same_worker_recovery), version: Number(row.version),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    }
  }

  async getPolicy(projectId: string, queueId: string): Promise<QueueAutomationPolicy> {
    const queue = await this.queue(projectId, queueId)
    const row = await this.executor.maybeOne<Row>('SELECT * FROM work_queue_automation_policies WHERE queue_id=$1', [queueId])
    return row ? this.policyFromRow(row) : {
      queueId, projectId, enabled: false, allowedKinds: ['issue', 'task'], maxActiveClaims: 1, leaseSeconds: 900,
      requiresManualApproval: true, allowSameWorkerRecovery: true, version: 0,
      createdAt: iso(queue.created_at), updatedAt: iso(queue.updated_at),
    }
  }

  async updatePolicy(projectId: string, queueId: string, input: UpdateQueueAutomationPolicyInput): Promise<QueueAutomationPolicy> {
    return this.executor.transaction(async () => {
      await lockProjectGraph(this.executor, projectId); await this.queue(projectId, queueId)
      const timestamp = now()
      const existing = await this.executor.maybeOne<Row>('SELECT version FROM work_queue_automation_policies WHERE queue_id=$1 FOR UPDATE', [queueId])
      if (!existing) {
        if (input.expectedVersion !== null) throw new ConflictError('Queue automation policy', queueId)
        await this.executor.execute(`INSERT INTO work_queue_automation_policies(queue_id,project_id,enabled,allowed_kinds_json,max_active_claims,lease_seconds,requires_manual_approval,allow_same_worker_recovery,created_at,updated_at)
          VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$9)`, [queueId, projectId, input.enabled, JSON.stringify([...new Set(input.allowedKinds)]), input.maxActiveClaims, input.leaseSeconds, input.requiresManualApproval, input.allowSameWorkerRecovery, timestamp])
      } else {
        if (input.expectedVersion === null || Number(existing.version) !== input.expectedVersion) throw new ConflictError('Queue automation policy', queueId)
        const changed = await this.executor.execute(`UPDATE work_queue_automation_policies SET enabled=$1,allowed_kinds_json=$2::jsonb,max_active_claims=$3,lease_seconds=$4,requires_manual_approval=$5,allow_same_worker_recovery=$6,version=version+1,updated_at=$7 WHERE queue_id=$8 AND version=$9`,
          [input.enabled, JSON.stringify([...new Set(input.allowedKinds)]), input.maxActiveClaims, input.leaseSeconds, input.requiresManualApproval, input.allowSameWorkerRecovery, timestamp, queueId, input.expectedVersion])
        if (!changed) throw new ConflictError('Queue automation policy', queueId)
      }
      await this.event(projectId, 'automation_policy', queueId, 'automation_policy.updated', { enabled: input.enabled })
      return this.getPolicy(projectId, queueId)
    })
  }

  private leaseFromRow(row: Row): WorkLease {
    return {
      id: String(row.id), projectId: String(row.project_id), queueId: String(row.queue_id), workItemId: String(row.work_item_id), workerId: String(row.worker_id),
      claimedWorkItemVersion: Number(row.claimed_work_item_version), acquiredAt: iso(row.acquired_at), heartbeatAt: iso(row.heartbeat_at), expiresAt: iso(row.expires_at),
      releasedAt: nullable(row.released_at), releaseReason: nullable(row.release_reason) as WorkLease['releaseReason'], terminalOutcome: nullable(row.terminal_outcome) as WorkLease['terminalOutcome'], version: Number(row.version),
    }
  }

  private async workItemFromRow(row: Row): Promise<WorkItem> {
    const id = String(row.id)
    const labels = (await this.executor.many<Row>('SELECT l.* FROM labels l JOIN work_item_labels wil ON wil.label_id=l.id WHERE wil.work_item_id=$1 ORDER BY lower(l.name),l.id', [id])).map((label) => ({ id: String(label.id), name: String(label.name), colour: nullable(label.colour), version: Number(label.version), createdAt: iso(label.created_at), updatedAt: iso(label.updated_at) }))
    const reasons = (await this.executor.many<Row>(`SELECT reason FROM (
      SELECT CASE WHEN wr.kind='blocks' THEN 'Blocked by ' || wi.title ELSE 'Depends on ' || wi.title END reason
      FROM work_relations wr JOIN work_items wi ON ((wr.kind='depends_on' AND wi.id=wr.to_work_item_id) OR (wr.kind='blocks' AND wi.id=wr.from_work_item_id))
      WHERE ((wr.kind='depends_on' AND wr.from_work_item_id=$1) OR (wr.kind='blocks' AND wr.to_work_item_id=$1)) AND wi.status NOT IN ('resolved','dropped')
      UNION ALL SELECT content FROM external_blockers WHERE project_id=$2 AND resolved_at IS NULL AND (work_item_id IS NULL OR work_item_id=$1)) reasons`, [id, row.project_id])).map((entry) => String(entry.reason))
    return {
      id, projectId: String(row.project_id), phaseId: nullable(row.phase_id), kind: String(row.kind) as WorkItem['kind'], title: String(row.title), description: nullable(row.description),
      status: String(row.status) as WorkItem['status'], priority: nullable(row.priority) as WorkItem['priority'], labels, version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      stableKey: nullable(row.stable_key), parentId: nullable(row.parent_id), queueId: nullable(row.queue_id), rank: nullable(row.rank), effectiveBlocked: reasons.length > 0 || String(row.status) === 'blocked', blockerReasons: reasons,
    }
  }

  private observationFromRow(row: Row): AutomationAttemptObservation {
    return { id: String(row.id), attemptId: String(row.attempt_id), sequence: Number(row.sequence), kind: String(row.kind) as AutomationAttemptObservation['kind'], summary: String(row.summary), runId: nullable(row.run_id), evidenceId: nullable(row.evidence_id), delivery: json(row.delivery_json, null), createdAt: iso(row.created_at) }
  }

  private async attemptFromRow(row: Row): Promise<AutomationAttempt> {
    const observations = (await this.executor.many<Row>('SELECT * FROM automation_attempt_observations WHERE attempt_id=$1 ORDER BY sequence', [row.id])).map((entry) => this.observationFromRow(entry))
    return { id: String(row.id), projectId: String(row.project_id), queueId: String(row.queue_id), workItemId: String(row.work_item_id), leaseId: String(row.lease_id), ordinal: Number(row.ordinal), startedAt: iso(row.started_at), endedAt: nullable(row.released_at), outcome: nullable(row.terminal_outcome) as AutomationAttempt['outcome'], observations }
  }

  async getOverview(projectId: string, queueId: string): Promise<QueueAutomationOverview> {
    await this.queue(projectId, queueId); const timestamp = now()
    const leaseRows = await this.executor.many<Row>(`SELECT l.*,wi.title work_item_title,wi.status work_item_status FROM work_leases l JOIN work_items wi ON wi.id=l.work_item_id
      WHERE l.queue_id=$1 AND l.released_at IS NULL ORDER BY l.acquired_at,l.id`, [queueId])
    const summaries = leaseRows.map((row): QueueAutomationLeaseSummary => ({
      ...this.leaseFromRow(row), workItemTitle: String(row.work_item_title), workItemStatus: String(row.work_item_status) as QueueAutomationLeaseSummary['workItemStatus'],
      state: iso(row.expires_at) <= timestamp ? 'expired' : 'active',
    }))
    const attempt = await this.executor.maybeOne<Row>('SELECT a.*,l.released_at,l.terminal_outcome FROM automation_attempts a JOIN work_leases l ON l.id=a.lease_id WHERE a.queue_id=$1 ORDER BY a.started_at DESC,a.id DESC LIMIT 1', [queueId])
    return {
      policy: await this.getPolicy(projectId, queueId), activeLeases: summaries.filter(({ state }) => state === 'active'), expiredLeases: summaries.filter(({ state }) => state === 'expired'),
      lastAttempt: attempt ? await this.attemptFromRow(attempt) : null,
      cursor: encodeAutomationCursor({ projectId, queueId, sequence: await this.latestSequence(projectId, queueId), checkedAt: timestamp }),
    }
  }

  private async latestSequence(projectId: string, queueId: string): Promise<number> {
    return Number((await this.executor.one<Row>('SELECT COALESCE(MAX(sequence),0) sequence FROM automation_queue_changes WHERE project_id=$1 AND queue_id=$2', [projectId, queueId])).sequence)
  }

  private async claimFeed(projectId: string, workItemId: string, blockerReasons: string[], cursor: string) {
    const requirementIds = (await this.executor.many<Row>('SELECT requirement_id FROM requirement_work_links WHERE work_item_id=$1 ORDER BY requirement_id', [workItemId])).map((row) => String(row.requirement_id))
    const rows = await this.executor.many<Row>(`SELECT u.id,u.kind,u.updated_at,r.content,p.current_checkpoint_id FROM updates u JOIN update_revisions r ON r.id=u.current_revision_id JOIN projects p ON p.id=u.project_id WHERE u.project_id=$1 AND u.deleted_at IS NULL ORDER BY u.updated_at DESC,u.id DESC LIMIT 5`, [projectId])
    const updates = rows.map((row) => ({ id: String(row.id), kind: String(row.kind) as import('../../domain/contracts.js').UpdateKind, content: String(row.content), updatedAt: iso(row.updated_at), current: String(row.id) === nullable(row.current_checkpoint_id) }))
    let current = updates.find((update) => update.current) ?? null
    if (!current) { const row = await this.executor.maybeOne<Row>(`SELECT u.id,u.kind,u.updated_at,r.content FROM projects p JOIN updates u ON u.id=p.current_checkpoint_id JOIN update_revisions r ON r.id=u.current_revision_id WHERE p.id=$1`, [projectId]); if (row) current = { id: String(row.id), kind: String(row.kind) as import('../../domain/contracts.js').UpdateKind, content: String(row.content), updatedAt: iso(row.updated_at), current: true } }
    return { cursor, changes: [], timedOut: false, requirementIds, blockerReasons, currentCheckpoint: current ? { id: current.id, kind: current.kind, content: current.content, updatedAt: current.updatedAt } : null, recentUpdates: updates.map(({ current: _current, ...update }) => update) }
  }

  async claim(projectId: string, queueId: string, input: ClaimNextAutomatedWorkInput): Promise<ClaimAutomatedWorkResult> {
    return this.executor.transaction(async () => {
      await lockProjectGraph(this.executor, projectId)
      const project = await this.executor.maybeOne<Row>('SELECT * FROM projects WHERE id=$1 FOR UPDATE', [projectId])
      if (!project || project.archived_at) throw new NotFoundError('Project', projectId)
      await this.queue(projectId, queueId); const timestamp = now()
      const cursor = encodeAutomationCursor({ projectId, queueId, sequence: await this.latestSequence(projectId, queueId), checkedAt: timestamp })
      if (String(project.state) !== 'active') return { outcome: 'project_paused', cursor }
      const policy = await this.getPolicy(projectId, queueId)
      if (!policy.enabled) return { outcome: 'policy_disabled', cursor }
      const active = Number((await this.executor.one<Row>('SELECT COUNT(*)::integer count FROM work_leases WHERE queue_id=$1 AND released_at IS NULL AND expires_at>$2', [queueId, timestamp])).count)
      if (active >= policy.maxActiveClaims) return { outcome: 'capacity_reached', cursor }
      const allowed = policy.allowedKinds.filter((kind) => !input.allowedKinds || input.allowedKinds.includes(kind))
      if (!allowed.length) return { outcome: 'empty', cursor }
      const kindParams = allowed.map((_, index) => `$${index + 3}`).join(',')
      const recoveryParam = allowed.length + 3, workerParam = allowed.length + 4, queueParam = allowed.length + 5, timeParam = allowed.length + 6
      const row = await this.executor.maybeOne<Row>(`SELECT wi.*,wqi.queue_id,wqi.rank,wl.id expired_lease_id FROM work_items wi
        JOIN work_queue_items wqi ON wqi.work_item_id=wi.id AND wqi.queue_id=$1
        LEFT JOIN work_leases wl ON wl.work_item_id=wi.id AND wl.released_at IS NULL
        WHERE wi.project_id=$2 AND wi.kind IN (${kindParams})
          AND ((wi.status='open' AND wl.id IS NULL) OR (wi.status='in_progress' AND $${recoveryParam}=TRUE AND wl.worker_id=$${workerParam} AND wl.queue_id=$${queueParam} AND wl.claimed_work_item_version=wi.version AND wl.expires_at<=$${timeParam}))
          AND NOT EXISTS (SELECT 1 FROM external_blockers eb WHERE eb.project_id=wi.project_id AND eb.resolved_at IS NULL AND (eb.work_item_id IS NULL OR eb.work_item_id=wi.id))
          AND NOT EXISTS (SELECT 1 FROM work_relations wr JOIN work_items dependency ON ((wr.kind='depends_on' AND dependency.id=wr.to_work_item_id) OR (wr.kind='blocks' AND dependency.id=wr.from_work_item_id))
            WHERE ((wr.kind='depends_on' AND wr.from_work_item_id=wi.id) OR (wr.kind='blocks' AND wr.to_work_item_id=wi.id)) AND dependency.status NOT IN ('resolved','dropped'))
        ORDER BY wqi.rank COLLATE "C",wqi.work_item_id LIMIT 1 FOR UPDATE OF wi`, [queueId, projectId, ...allowed, policy.allowSameWorkerRecovery, input.workerId, queueId, timestamp])
      if (!row) return { outcome: 'empty', cursor }
      if (row.expired_lease_id) await this.executor.execute("UPDATE work_leases SET released_at=$1,release_reason='recovery',terminal_outcome='interrupted',version=version+1 WHERE id=$2 AND released_at IS NULL", [timestamp, row.expired_lease_id])
      const updated = await this.executor.maybeOne<Row>("UPDATE work_items SET status='in_progress',version=version+1,updated_at=$1 WHERE id=$2 AND version=$3 RETURNING *", [timestamp, row.id, row.version])
      if (!updated) throw new ConflictError('Work item', String(row.id))
      const leaseId = randomUUID(), attemptId = randomUUID(), token = randomBytes(32).toString('base64url')
      const leaseSeconds = Math.min(input.leaseSeconds ?? policy.leaseSeconds, policy.leaseSeconds)
      await this.executor.execute(`INSERT INTO work_leases(id,project_id,queue_id,work_item_id,worker_id,token_hash,claimed_work_item_version,acquired_at,heartbeat_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)`, [leaseId, projectId, queueId, row.id, input.workerId, tokenHash(token), updated.version, timestamp, expiresAt(timestamp, leaseSeconds)])
      const ordinal = Number((await this.executor.one<Row>('SELECT COALESCE(MAX(ordinal),0)+1 ordinal FROM automation_attempts WHERE work_item_id=$1', [row.id])).ordinal)
      await this.executor.execute('INSERT INTO automation_attempts(id,project_id,queue_id,work_item_id,lease_id,ordinal,started_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [attemptId, projectId, queueId, row.id, leaseId, ordinal, timestamp])
      await this.event(projectId, 'work_lease', leaseId, 'work_lease.claimed', { queueId, workItemId: row.id, workerId: input.workerId, attemptId })
      const item = await this.workItemFromRow({ ...updated, queue_id: queueId, rank: row.rank })
      const lease = this.leaseFromRow((await this.executor.one<Row>('SELECT * FROM work_leases WHERE id=$1', [leaseId])))
      const attempt = await this.attemptFromRow(await this.executor.one<Row>('SELECT a.*,l.released_at,l.terminal_outcome FROM automation_attempts a JOIN work_leases l ON l.id=a.lease_id WHERE a.id=$1', [attemptId]))
      const feedCursor = encodeAutomationCursor({ projectId, queueId, sequence: await this.latestSequence(projectId, queueId), checkedAt: timestamp })
      return { outcome: 'claimed', item, lease: { ...lease, leaseToken: token }, attempt, feed: await this.claimFeed(projectId, item.id, item.blockerReasons ?? [], feedCursor) }
    })
  }

  private async leaseAndItem(leaseId: string, forUpdate = false): Promise<{ leaseRow: Row; item: WorkItem; policy: QueueAutomationPolicy }> {
    const leaseRow = await this.executor.maybeOne<Row>(`SELECT * FROM work_leases WHERE id=$1${forUpdate ? ' FOR UPDATE' : ''}`, [leaseId])
    if (!leaseRow) throw new NotFoundError('Work lease', leaseId)
    const itemRow = await this.executor.one<Row>(`SELECT wi.*,wqi.queue_id,wqi.rank FROM work_items wi LEFT JOIN work_queue_items wqi ON wqi.work_item_id=wi.id WHERE wi.id=$1${forUpdate ? ' FOR UPDATE OF wi' : ''}`, [leaseRow.work_item_id])
    return { leaseRow, item: await this.workItemFromRow(itemRow), policy: await this.getPolicy(String(leaseRow.project_id), String(leaseRow.queue_id)) }
  }
  private async lockedLeaseAndItem(leaseId: string) {
    const initial = await this.executor.maybeOne<Row>('SELECT project_id FROM work_leases WHERE id=$1', [leaseId])
    if (!initial) throw new NotFoundError('Work lease', leaseId)
    await lockProjectGraph(this.executor, String(initial.project_id))
    return this.leaseAndItem(leaseId, true)
  }
  private validToken(row: Row, token: string | null | undefined) { return Boolean(token) && String(row.token_hash) === tokenHash(token!) }

  async heartbeat(leaseId: string, input: HeartbeatAutomatedWorkInput): Promise<HeartbeatAutomatedWorkResult> {
    return this.executor.transaction(async () => {
      const current = await this.lockedLeaseAndItem(leaseId), timestamp = now()
      if (!this.validToken(current.leaseRow, input.leaseToken) || current.leaseRow.released_at || iso(current.leaseRow.expires_at) <= timestamp) return { outcome: 'lease_lost', lease: this.leaseFromRow(current.leaseRow), item: current.item }
      const project = await this.executor.one<Row>('SELECT state FROM projects WHERE id=$1', [current.item.projectId])
      if (String(project.state) !== 'active') return { outcome: 'project_paused', lease: this.leaseFromRow(current.leaseRow), item: current.item }
      if (!current.policy.enabled) return { outcome: 'policy_disabled', lease: this.leaseFromRow(current.leaseRow), item: current.item }
      if (current.item.version !== Number(current.leaseRow.claimed_work_item_version) || current.item.status !== 'in_progress' || current.item.queueId !== String(current.leaseRow.queue_id) || current.item.effectiveBlocked) return { outcome: 'human_changed_state', lease: this.leaseFromRow(current.leaseRow), item: current.item }
      const row = await this.executor.maybeOne<Row>('UPDATE work_leases SET heartbeat_at=$1,expires_at=$2,version=version+1 WHERE id=$3 AND version=$4 AND released_at IS NULL AND expires_at>$1 RETURNING *', [timestamp, expiresAt(timestamp, current.policy.leaseSeconds), leaseId, current.leaseRow.version])
      if (!row) return { outcome: 'lease_lost', lease: this.leaseFromRow(await this.executor.one<Row>('SELECT * FROM work_leases WHERE id=$1', [leaseId])), item: current.item }
      const lease = this.leaseFromRow(row); await this.event(lease.projectId, 'work_lease', leaseId, 'work_lease.heartbeat', { expiresAt: lease.expiresAt })
      return { outcome: 'heartbeat', lease }
    })
  }

  async record(leaseId: string, input: RecordAutomationAttemptInput): Promise<AutomationAttemptObservation> {
    return this.executor.transaction(async () => {
      const current = await this.leaseAndItem(leaseId, true), timestamp = now()
      if (!this.validToken(current.leaseRow, input.leaseToken) || current.leaseRow.released_at || iso(current.leaseRow.expires_at) <= timestamp) throw new ConflictError('Work lease', leaseId)
      const attempt = await this.executor.one<Row>('SELECT * FROM automation_attempts WHERE lease_id=$1', [leaseId])
      for (const [table, id] of [['runs', input.runId], ['evidence', input.evidenceId]] as const) if (id && !await this.executor.maybeOne(`SELECT 1 FROM ${table} WHERE id=$1 AND project_id=$2`, [id, current.leaseRow.project_id])) throw new ValidationError(`${table === 'runs' ? 'runId' : 'evidenceId'} must belong to the lease project`)
      const sequence = Number((await this.executor.one<Row>('SELECT COALESCE(MAX(sequence),0)+1 sequence FROM automation_attempt_observations WHERE attempt_id=$1', [attempt.id])).sequence), id = randomUUID()
      const row = await this.executor.one<Row>('INSERT INTO automation_attempt_observations(id,attempt_id,sequence,kind,summary,run_id,evidence_id,delivery_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *', [id, attempt.id, sequence, input.kind, input.summary, input.runId ?? null, input.evidenceId ?? null, input.delivery ? JSON.stringify(input.delivery) : null, timestamp])
      await this.event(String(current.leaseRow.project_id), 'automation_attempt', String(attempt.id), 'automation_attempt.recorded', { sequence, kind: input.kind, runId: input.runId ?? null, evidenceId: input.evidenceId ?? null })
      return this.observationFromRow(row)
    })
  }

  async complete(leaseId: string, input: CompleteAutomatedWorkInput): Promise<CompleteAutomatedWorkResult> {
    return this.executor.transaction(async () => {
      const current = await this.lockedLeaseAndItem(leaseId), timestamp = now()
      if (!this.validToken(current.leaseRow, input.leaseToken) || current.leaseRow.released_at || iso(current.leaseRow.expires_at) <= timestamp) return { outcome: 'lease_lost', lease: this.leaseFromRow(current.leaseRow), item: current.item }
      const project = await this.executor.one<Row>('SELECT state FROM projects WHERE id=$1', [current.item.projectId])
      if (String(project.state) !== 'active') return { outcome: 'project_paused', lease: this.leaseFromRow(current.leaseRow), item: current.item }
      if (!current.policy.enabled) return { outcome: 'policy_disabled', lease: this.leaseFromRow(current.leaseRow), item: current.item }
      if (current.item.version !== input.expectedWorkItemVersion || current.item.version !== Number(current.leaseRow.claimed_work_item_version) || current.item.status !== 'in_progress' || current.item.queueId !== String(current.leaseRow.queue_id) || current.item.effectiveBlocked) return { outcome: 'human_changed_state', lease: this.leaseFromRow(current.leaseRow), item: current.item }
      const outcome = input.outcome === 'resolved' && current.policy.requiresManualApproval ? 'awaiting_approval' : input.outcome
      const status = outcome === 'resolved' ? 'resolved' : outcome === 'blocked' ? 'blocked' : ['retryable', 'interrupted'].includes(outcome) ? 'open' : 'in_progress'
      const itemRow = await this.executor.one<Row>('UPDATE work_items SET status=$1,version=version+1,updated_at=$2 WHERE id=$3 AND version=$4 RETURNING *', [status, timestamp, current.item.id, current.item.version])
      const leaseRow = await this.executor.one<Row>('UPDATE work_leases SET released_at=$1,release_reason=$2,terminal_outcome=$3,version=version+1 WHERE id=$4 AND released_at IS NULL RETURNING *', [timestamp, outcome === 'interrupted' ? 'runner_shutdown' : 'manual', outcome, leaseId])
      await this.event(current.item.projectId, 'work_lease', leaseId, 'work_lease.completed', { workItemId: current.item.id, outcome })
      return { outcome, lease: this.leaseFromRow(leaseRow), item: await this.workItemFromRow({ ...itemRow, queue_id: current.item.queueId, rank: current.item.rank }) }
    })
  }

  private async releaseInternal(leaseId: string, leaseToken: string | null, reason: WorkLease['releaseReason'], operator: boolean, expectedLeaseVersion?: number): Promise<ReleaseAutomatedWorkResult> {
    return this.executor.transaction(async () => {
      const current = await this.lockedLeaseAndItem(leaseId), timestamp = now()
      if (operator && Number(current.leaseRow.version) !== expectedLeaseVersion) throw new ConflictError('Work lease', leaseId)
      if (current.leaseRow.released_at) return { outcome: 'already_released', lease: this.leaseFromRow(current.leaseRow), item: current.item }
      if (!operator && !this.validToken(current.leaseRow, leaseToken)) return { outcome: 'lease_lost', lease: this.leaseFromRow(current.leaseRow), item: current.item }
      const leaseRow = await this.executor.one<Row>("UPDATE work_leases SET released_at=$1,release_reason=$2,terminal_outcome='interrupted',version=version+1 WHERE id=$3 AND released_at IS NULL RETURNING *", [timestamp, reason, leaseId])
      let item = current.item
      if (item.version === Number(current.leaseRow.claimed_work_item_version) && item.status === 'in_progress' && item.queueId === String(current.leaseRow.queue_id)) {
        const row = await this.executor.one<Row>("UPDATE work_items SET status='open',version=version+1,updated_at=$1 WHERE id=$2 AND version=$3 RETURNING *", [timestamp, item.id, item.version])
        item = await this.workItemFromRow({ ...row, queue_id: item.queueId, rank: item.rank })
      }
      await this.event(item.projectId, 'work_lease', leaseId, 'work_lease.released', { workItemId: item.id, reason })
      return { outcome: 'released', lease: this.leaseFromRow(leaseRow), item }
    })
  }

  release(leaseId: string, input: RunnerReleaseAutomatedWorkInput) { return this.releaseInternal(leaseId, input.leaseToken, input.reason, false) }
  operatorRelease(leaseId: string, input: OperatorReleaseAutomatedWorkInput) { return this.releaseInternal(leaseId, null, 'manual', true, input.expectedLeaseVersion) }

  async readChanges(projectId: string, queueId: string, afterSequence: number, expiredAfter: string, checkedAt: string): Promise<AutomationQueueProbe> {
    await this.queue(projectId, queueId)
    const latestSequence = await this.latestSequence(projectId, queueId)
    if (afterSequence > latestSequence) throw new ValidationError('Invalid automation queue cursor')
    const page = (await this.executor.many<Row>('SELECT * FROM automation_queue_changes WHERE project_id=$1 AND queue_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 201', [projectId, queueId, afterSequence])).slice(0, 200)
    const changes = page.map((row): AutomationQueueChange => ({ sequence: Number(row.sequence), projectId: String(row.project_id), queueId: String(row.queue_id), eventType: String(row.event_type), entityType: String(row.entity_type), entityId: String(row.entity_id), createdAt: iso(row.created_at) }))
    const expiredLeases = (await this.executor.many<Row>('SELECT * FROM work_leases WHERE project_id=$1 AND queue_id=$2 AND released_at IS NULL AND expires_at>$3 AND expires_at<=$4 ORDER BY expires_at,id', [projectId, queueId, expiredAfter, checkedAt])).map((row) => this.leaseFromRow(row))
    const next = await this.executor.one<Row>('SELECT MIN(expires_at) next_expiry FROM work_leases WHERE project_id=$1 AND queue_id=$2 AND released_at IS NULL AND expires_at>$3', [projectId, queueId, checkedAt])
    return { changes, cursorSequence: changes.at(-1)?.sequence ?? afterSequence, expiredLeases, nextExpiryAt: nullable(next.next_expiry) }
  }
}
