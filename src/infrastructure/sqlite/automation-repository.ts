import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ConflictError, NotFoundError, ValidationError } from '../../application/errors.js'
import { encodeAutomationCursor } from '../../application/automation-cursor.js'
import type { MutationContext, WorkItem } from '../../domain/contracts.js'
import type {
  AutomationAttempt,
  AutomationAttemptObservation,
  AutomationQueueChange,
  AutomationQueueProbe,
  ClaimAutomatedWorkResult,
  ClaimNextAutomatedWorkInput,
  CompleteAutomatedWorkResult,
  CompleteAutomatedWorkInput,
  HeartbeatAutomatedWorkResult,
  HeartbeatAutomatedWorkInput,
  OperatorReleaseAutomatedWorkInput,
  QueueAutomationOverview,
  QueueAutomationLeaseSummary,
  QueueAutomationPolicy,
  RecordAutomationAttemptInput,
  ReleaseAutomatedWorkResult,
  RunnerReleaseAutomatedWorkInput,
  UpdateQueueAutomationPolicyInput,
  WorkLease,
} from '../../domain/automation.js'

type Row = Record<string, unknown>
type EventWriter = (projectId: string, entityType: string, entityId: string, eventType: string, payload?: Record<string, unknown>) => void

const now = () => new Date().toISOString()
const bool = (value: unknown) => Number(value) === 1
const nullable = (value: unknown): string | null => value == null ? null : String(value)
const json = <T>(value: unknown, fallback: T): T => {
  try { return value == null ? fallback : JSON.parse(String(value)) as T } catch { return fallback }
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const expiresAt = (timestamp: string, seconds: number) => new Date(Date.parse(timestamp) + seconds * 1_000).toISOString()

export class SqliteAutomationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(work: () => T) => T,
    private readonly context: () => MutationContext,
    private readonly event: EventWriter,
  ) {}

  private queue(projectId: string, queueId: string): Row {
    const row = this.db.prepare('SELECT * FROM work_queues WHERE id=? AND project_id=?').get(queueId, projectId) as Row | undefined
    if (!row) throw new NotFoundError('Work queue', queueId)
    return row
  }

  private policyFromRow(row: Row): QueueAutomationPolicy {
    return {
      queueId: String(row.queue_id), projectId: String(row.project_id), enabled: bool(row.enabled),
      allowedKinds: json(row.allowed_kinds_json, ['issue', 'task']), maxActiveClaims: Number(row.max_active_claims),
      leaseSeconds: Number(row.lease_seconds), requiresManualApproval: bool(row.requires_manual_approval),
      allowSameWorkerRecovery: bool(row.allow_same_worker_recovery), version: Number(row.version),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
  }

  getPolicy(projectId: string, queueId: string): QueueAutomationPolicy {
    const queue = this.queue(projectId, queueId)
    const row = this.db.prepare('SELECT * FROM work_queue_automation_policies WHERE queue_id=?').get(queueId) as Row | undefined
    return row ? this.policyFromRow(row) : {
      queueId, projectId, enabled: false, allowedKinds: ['issue', 'task'], maxActiveClaims: 1,
      leaseSeconds: 900, requiresManualApproval: true, allowSameWorkerRecovery: true, version: 0,
      createdAt: String(queue.created_at), updatedAt: String(queue.updated_at),
    }
  }

  updatePolicy(projectId: string, queueId: string, input: UpdateQueueAutomationPolicyInput): QueueAutomationPolicy {
    return this.transaction(() => {
      this.queue(projectId, queueId)
      const timestamp = now()
      const existing = this.db.prepare('SELECT version FROM work_queue_automation_policies WHERE queue_id=?').get(queueId) as Row | undefined
      if (!existing) {
        if (input.expectedVersion !== null) throw new ConflictError('Queue automation policy', queueId)
        this.db.prepare(`INSERT INTO work_queue_automation_policies(queue_id,project_id,enabled,allowed_kinds_json,max_active_claims,lease_seconds,requires_manual_approval,allow_same_worker_recovery,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(queueId, projectId, Number(input.enabled), JSON.stringify([...new Set(input.allowedKinds)]), input.maxActiveClaims, input.leaseSeconds, Number(input.requiresManualApproval), Number(input.allowSameWorkerRecovery), timestamp, timestamp)
      } else {
        if (input.expectedVersion === null || Number(existing.version) !== input.expectedVersion) throw new ConflictError('Queue automation policy', queueId)
        const result = this.db.prepare(`UPDATE work_queue_automation_policies SET enabled=?,allowed_kinds_json=?,max_active_claims=?,lease_seconds=?,requires_manual_approval=?,allow_same_worker_recovery=?,version=version+1,updated_at=? WHERE queue_id=? AND version=?`)
          .run(Number(input.enabled), JSON.stringify([...new Set(input.allowedKinds)]), input.maxActiveClaims, input.leaseSeconds, Number(input.requiresManualApproval), Number(input.allowSameWorkerRecovery), timestamp, queueId, input.expectedVersion)
        if (!Number(result.changes)) throw new ConflictError('Queue automation policy', queueId)
      }
      this.event(projectId, 'automation_policy', queueId, 'automation_policy.updated', { enabled: input.enabled })
      return this.getPolicy(projectId, queueId)
    })
  }

  private leaseFromRow(row: Row): WorkLease {
    return {
      id: String(row.id), projectId: String(row.project_id), queueId: String(row.queue_id), workItemId: String(row.work_item_id),
      workerId: String(row.worker_id), claimedWorkItemVersion: Number(row.claimed_work_item_version),
      acquiredAt: String(row.acquired_at), heartbeatAt: String(row.heartbeat_at), expiresAt: String(row.expires_at),
      releasedAt: nullable(row.released_at), releaseReason: nullable(row.release_reason) as WorkLease['releaseReason'],
      terminalOutcome: nullable(row.terminal_outcome) as WorkLease['terminalOutcome'], version: Number(row.version),
    }
  }

  private workItemFromRow(row: Row): WorkItem {
    const id = String(row.id)
    const labels = (this.db.prepare('SELECT l.* FROM labels l JOIN work_item_labels wil ON wil.label_id=l.id WHERE wil.work_item_id=? ORDER BY l.name COLLATE NOCASE').all(id) as Row[]).map((label) => ({ id: String(label.id), name: String(label.name), colour: nullable(label.colour), version: Number(label.version), createdAt: String(label.created_at), updatedAt: String(label.updated_at) }))
    const reasons = (this.db.prepare(`SELECT reason FROM (
      SELECT CASE WHEN wr.kind='blocks' THEN 'Blocked by ' || wi.title ELSE 'Depends on ' || wi.title END reason
      FROM work_relations wr JOIN work_items wi ON ((wr.kind='depends_on' AND wi.id=wr.to_work_item_id) OR (wr.kind='blocks' AND wi.id=wr.from_work_item_id))
      WHERE ((wr.kind='depends_on' AND wr.from_work_item_id=?) OR (wr.kind='blocks' AND wr.to_work_item_id=?)) AND wi.status NOT IN ('resolved','dropped')
      UNION ALL SELECT content FROM external_blockers WHERE project_id=? AND resolved_at IS NULL AND (work_item_id IS NULL OR work_item_id=?))`).all(id, id, String(row.project_id), id) as Row[]).map((entry) => String(entry.reason))
    return {
      id, projectId: String(row.project_id), phaseId: nullable(row.phase_id), kind: String(row.kind) as WorkItem['kind'],
      title: String(row.title), description: nullable(row.description), status: String(row.status) as WorkItem['status'],
      priority: nullable(row.priority) as WorkItem['priority'], labels, version: Number(row.version), createdAt: String(row.created_at),
      updatedAt: String(row.updated_at), stableKey: nullable(row.stable_key), parentId: nullable(row.parent_id),
      queueId: nullable(row.queue_id), rank: nullable(row.rank), effectiveBlocked: reasons.length > 0 || String(row.status) === 'blocked', blockerReasons: reasons,
    }
  }

  private attemptFromRow(row: Row): AutomationAttempt {
    const observations = (this.db.prepare('SELECT * FROM automation_attempt_observations WHERE attempt_id=? ORDER BY sequence').all(String(row.id)) as Row[]).map((entry) => this.observationFromRow(entry))
    return {
      id: String(row.id), projectId: String(row.project_id), queueId: String(row.queue_id), workItemId: String(row.work_item_id),
      leaseId: String(row.lease_id), ordinal: Number(row.ordinal), startedAt: String(row.started_at),
      endedAt: nullable(row.released_at), outcome: nullable(row.terminal_outcome) as AutomationAttempt['outcome'], observations,
    }
  }

  private observationFromRow(row: Row): AutomationAttemptObservation {
    return {
      id: String(row.id), attemptId: String(row.attempt_id), sequence: Number(row.sequence),
      kind: String(row.kind) as AutomationAttemptObservation['kind'], summary: String(row.summary), runId: nullable(row.run_id),
      evidenceId: nullable(row.evidence_id), delivery: json(row.delivery_json, null), createdAt: String(row.created_at),
    }
  }

  getOverview(projectId: string, queueId: string): QueueAutomationOverview {
    this.queue(projectId, queueId)
    const timestamp = now()
    const leaseRows = this.db.prepare(`SELECT l.*,wi.title work_item_title,wi.status work_item_status FROM work_leases l JOIN work_items wi ON wi.id=l.work_item_id
      WHERE l.queue_id=? AND l.released_at IS NULL ORDER BY l.acquired_at,l.id`).all(queueId) as Row[]
    const summaries = leaseRows.map((row): QueueAutomationLeaseSummary => ({
      ...this.leaseFromRow(row), workItemTitle: String(row.work_item_title), workItemStatus: String(row.work_item_status) as QueueAutomationLeaseSummary['workItemStatus'],
      state: String(row.expires_at) <= timestamp ? 'expired' : 'active',
    }))
    const attempt = this.db.prepare(`SELECT a.*,l.released_at,l.terminal_outcome FROM automation_attempts a JOIN work_leases l ON l.id=a.lease_id WHERE a.queue_id=? ORDER BY a.started_at DESC,a.id DESC LIMIT 1`).get(queueId) as Row | undefined
    return {
      policy: this.getPolicy(projectId, queueId), activeLeases: summaries.filter(({ state }) => state === 'active'), expiredLeases: summaries.filter(({ state }) => state === 'expired'),
      lastAttempt: attempt ? this.attemptFromRow(attempt) : null,
      cursor: encodeAutomationCursor({ projectId, queueId, sequence: this.latestSequence(projectId, queueId), checkedAt: timestamp }),
    }
  }

  private latestSequence(projectId: string, queueId: string): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0) sequence FROM automation_queue_changes WHERE project_id=? AND queue_id=?').get(projectId, queueId) as Row).sequence)
  }

  private claimFeed(projectId: string, queueId: string, workItemId: string, blockerReasons: string[], cursor: string) {
    const requirementIds = (this.db.prepare('SELECT requirement_id FROM requirement_work_links WHERE work_item_id=? ORDER BY requirement_id').all(workItemId) as Row[]).map((row) => String(row.requirement_id))
    const updates = (this.db.prepare(`SELECT u.id,u.kind,u.updated_at,r.content,p.current_checkpoint_id FROM updates u JOIN update_revisions r ON r.id=u.current_revision_id JOIN projects p ON p.id=u.project_id WHERE u.project_id=? AND u.deleted_at IS NULL ORDER BY u.updated_at DESC,u.id DESC LIMIT 5`).all(projectId) as Row[]).map((row) => ({ id: String(row.id), kind: String(row.kind) as import('../../domain/contracts.js').UpdateKind, content: String(row.content), updatedAt: String(row.updated_at), current: String(row.id) === nullable(row.current_checkpoint_id) }))
    const current = updates.find((update) => update.current) ?? (() => { const row = this.db.prepare(`SELECT u.id,u.kind,u.updated_at,r.content FROM projects p JOIN updates u ON u.id=p.current_checkpoint_id JOIN update_revisions r ON r.id=u.current_revision_id WHERE p.id=?`).get(projectId) as Row | undefined; return row ? { id: String(row.id), kind: String(row.kind) as import('../../domain/contracts.js').UpdateKind, content: String(row.content), updatedAt: String(row.updated_at), current: true } : null })()
    return { cursor, changes: [], timedOut: false, requirementIds, blockerReasons, currentCheckpoint: current ? { id: current.id, kind: current.kind, content: current.content, updatedAt: current.updatedAt } : null, recentUpdates: updates.map(({ current: _current, ...update }) => update) }
  }

  claim(projectId: string, queueId: string, input: ClaimNextAutomatedWorkInput): ClaimAutomatedWorkResult {
    return this.transaction(() => {
      const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as Row | undefined
      if (!project || project.archived_at) throw new NotFoundError('Project', projectId)
      this.queue(projectId, queueId)
      const timestamp = now()
      const cursor = encodeAutomationCursor({ projectId, queueId, sequence: this.latestSequence(projectId, queueId), checkedAt: timestamp })
      if (String(project.state) !== 'active') return { outcome: 'project_paused', cursor }
      const policy = this.getPolicy(projectId, queueId)
      if (!policy.enabled) return { outcome: 'policy_disabled', cursor }
      if (json<unknown[]>(project.blockers_json, []).length > 0) return { outcome: 'empty', cursor }
      const active = Number((this.db.prepare('SELECT COUNT(*) count FROM work_leases WHERE queue_id=? AND released_at IS NULL AND expires_at>?').get(queueId, timestamp) as Row).count)
      if (active >= policy.maxActiveClaims) return { outcome: 'capacity_reached', cursor }
      const allowed = policy.allowedKinds.filter((kind) => !input.allowedKinds || input.allowedKinds.includes(kind))
      if (!allowed.length) return { outcome: 'empty', cursor }
      const placeholders = allowed.map(() => '?').join(',')
      const row = this.db.prepare(`SELECT wi.*,wqi.queue_id,wqi.rank,wl.id expired_lease_id FROM work_items wi
        JOIN work_queue_items wqi ON wqi.work_item_id=wi.id AND wqi.queue_id=?
        LEFT JOIN work_leases wl ON wl.work_item_id=wi.id AND wl.released_at IS NULL
        WHERE wi.project_id=? AND wi.kind IN (${placeholders})
          AND ((wi.status='open' AND wl.id IS NULL) OR (wi.status='in_progress' AND ?=1 AND wl.worker_id=? AND wl.queue_id=? AND wl.claimed_work_item_version=wi.version AND wl.expires_at<=?))
          AND NOT EXISTS (SELECT 1 FROM external_blockers eb WHERE eb.project_id=wi.project_id AND eb.resolved_at IS NULL AND (eb.work_item_id IS NULL OR eb.work_item_id=wi.id))
          AND NOT EXISTS (SELECT 1 FROM work_relations wr JOIN work_items dependency ON ((wr.kind='depends_on' AND dependency.id=wr.to_work_item_id) OR (wr.kind='blocks' AND dependency.id=wr.from_work_item_id))
            WHERE ((wr.kind='depends_on' AND wr.from_work_item_id=wi.id) OR (wr.kind='blocks' AND wr.to_work_item_id=wi.id)) AND dependency.status NOT IN ('resolved','dropped'))
        ORDER BY wqi.rank COLLATE BINARY,wqi.work_item_id LIMIT 1`).get(queueId, projectId, ...allowed, Number(policy.allowSameWorkerRecovery), input.workerId, queueId, timestamp) as Row | undefined
      if (!row) return { outcome: 'empty', cursor }
      if (row.expired_lease_id) this.db.prepare("UPDATE work_leases SET released_at=?,release_reason='recovery',terminal_outcome='interrupted',version=version+1 WHERE id=? AND released_at IS NULL").run(timestamp, String(row.expired_lease_id))
      const workUpdate = this.db.prepare("UPDATE work_items SET status='in_progress',version=version+1,updated_at=? WHERE id=? AND version=?").run(timestamp, String(row.id), Number(row.version))
      if (!Number(workUpdate.changes)) throw new ConflictError('Work item', String(row.id))
      const claimedVersion = Number(row.version) + 1
      const leaseId = randomUUID(); const attemptId = randomUUID(); const token = randomBytes(32).toString('base64url')
      const leaseSeconds = Math.min(input.leaseSeconds ?? policy.leaseSeconds, policy.leaseSeconds)
      this.db.prepare(`INSERT INTO work_leases(id,project_id,queue_id,work_item_id,worker_id,token_hash,claimed_work_item_version,acquired_at,heartbeat_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(leaseId, projectId, queueId, String(row.id), input.workerId, tokenHash(token), claimedVersion, timestamp, timestamp, expiresAt(timestamp, leaseSeconds))
      const ordinal = Number((this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 ordinal FROM automation_attempts WHERE work_item_id=?').get(String(row.id)) as Row).ordinal)
      this.db.prepare('INSERT INTO automation_attempts(id,project_id,queue_id,work_item_id,lease_id,ordinal,started_at) VALUES (?,?,?,?,?,?,?)').run(attemptId, projectId, queueId, String(row.id), leaseId, ordinal, timestamp)
      this.event(projectId, 'work_lease', leaseId, 'work_lease.claimed', { queueId, workItemId: row.id, workerId: input.workerId, attemptId })
      const item = this.workItemFromRow(this.db.prepare('SELECT wi.*,wqi.queue_id,wqi.rank FROM work_items wi JOIN work_queue_items wqi ON wqi.work_item_id=wi.id WHERE wi.id=?').get(String(row.id)) as Row)
      const lease = this.leaseFromRow(this.db.prepare('SELECT * FROM work_leases WHERE id=?').get(leaseId) as Row)
      const attempt = this.attemptFromRow(this.db.prepare('SELECT a.*,l.released_at,l.terminal_outcome FROM automation_attempts a JOIN work_leases l ON l.id=a.lease_id WHERE a.id=?').get(attemptId) as Row)
      const feedCursor = encodeAutomationCursor({ projectId, queueId, sequence: this.latestSequence(projectId, queueId), checkedAt: timestamp })
      return { outcome: 'claimed', item, lease: { ...lease, leaseToken: token }, attempt, feed: this.claimFeed(projectId, queueId, item.id, item.blockerReasons ?? [], feedCursor) }
    })
  }

  private leaseAndItem(leaseId: string): { leaseRow: Row; item: WorkItem; policy: QueueAutomationPolicy } {
    const leaseRow = this.db.prepare('SELECT * FROM work_leases WHERE id=?').get(leaseId) as Row | undefined
    if (!leaseRow) throw new NotFoundError('Work lease', leaseId)
    const itemRow = this.db.prepare('SELECT wi.*,wqi.queue_id,wqi.rank FROM work_items wi LEFT JOIN work_queue_items wqi ON wqi.work_item_id=wi.id WHERE wi.id=?').get(String(leaseRow.work_item_id)) as Row
    return { leaseRow, item: this.workItemFromRow(itemRow), policy: this.getPolicy(String(leaseRow.project_id), String(leaseRow.queue_id)) }
  }

  private validToken(row: Row, token: string | null | undefined): boolean {
    return Boolean(token) && String(row.token_hash) === tokenHash(token!)
  }

  heartbeat(leaseId: string, input: HeartbeatAutomatedWorkInput): HeartbeatAutomatedWorkResult {
    return this.transaction(() => {
      const { leaseRow, item, policy } = this.leaseAndItem(leaseId); const timestamp = now()
      if (!this.validToken(leaseRow, input.leaseToken) || leaseRow.released_at || String(leaseRow.expires_at) <= timestamp) return { outcome: 'lease_lost', lease: this.leaseFromRow(leaseRow), item }
      const project = this.db.prepare('SELECT state FROM projects WHERE id=?').get(item.projectId) as Row
      if (String(project.state) !== 'active') return { outcome: 'project_paused', lease: this.leaseFromRow(leaseRow), item }
      if (!policy.enabled) return { outcome: 'policy_disabled', lease: this.leaseFromRow(leaseRow), item }
      if (item.version !== Number(leaseRow.claimed_work_item_version) || item.status !== 'in_progress' || item.queueId !== String(leaseRow.queue_id) || item.effectiveBlocked) return { outcome: 'human_changed_state', lease: this.leaseFromRow(leaseRow), item }
      const changed = this.db.prepare('UPDATE work_leases SET heartbeat_at=?,expires_at=?,version=version+1 WHERE id=? AND version=? AND released_at IS NULL AND expires_at>?')
        .run(timestamp, expiresAt(timestamp, policy.leaseSeconds), leaseId, Number(leaseRow.version), timestamp)
      if (!Number(changed.changes)) return { outcome: 'lease_lost', lease: this.leaseFromRow(this.db.prepare('SELECT * FROM work_leases WHERE id=?').get(leaseId) as Row), item }
      const lease = this.leaseFromRow(this.db.prepare('SELECT * FROM work_leases WHERE id=?').get(leaseId) as Row)
      this.event(lease.projectId, 'work_lease', leaseId, 'work_lease.heartbeat', { expiresAt: lease.expiresAt })
      return { outcome: 'heartbeat', lease }
    })
  }

  record(leaseId: string, input: RecordAutomationAttemptInput): AutomationAttemptObservation {
    return this.transaction(() => {
      const { leaseRow } = this.leaseAndItem(leaseId); const timestamp = now()
      if (!this.validToken(leaseRow, input.leaseToken) || leaseRow.released_at || String(leaseRow.expires_at) <= timestamp) throw new ConflictError('Work lease', leaseId)
      const attempt = this.db.prepare('SELECT * FROM automation_attempts WHERE lease_id=?').get(leaseId) as Row
      for (const [table, id] of [['runs', input.runId], ['evidence', input.evidenceId]] as const) if (id && !this.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND project_id=?`).get(id, String(leaseRow.project_id))) throw new ValidationError(`${table === 'runs' ? 'runId' : 'evidenceId'} must belong to the lease project`)
      const sequence = Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 sequence FROM automation_attempt_observations WHERE attempt_id=?').get(String(attempt.id)) as Row).sequence)
      const id = randomUUID()
      this.db.prepare('INSERT INTO automation_attempt_observations(id,attempt_id,sequence,kind,summary,run_id,evidence_id,delivery_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, String(attempt.id), sequence, input.kind, input.summary, input.runId ?? null, input.evidenceId ?? null, input.delivery ? JSON.stringify(input.delivery) : null, timestamp)
      this.event(String(leaseRow.project_id), 'automation_attempt', String(attempt.id), 'automation_attempt.recorded', { sequence, kind: input.kind, runId: input.runId ?? null, evidenceId: input.evidenceId ?? null })
      return this.observationFromRow(this.db.prepare('SELECT * FROM automation_attempt_observations WHERE id=?').get(id) as Row)
    })
  }

  complete(leaseId: string, input: CompleteAutomatedWorkInput): CompleteAutomatedWorkResult {
    return this.transaction(() => {
      const { leaseRow, item, policy } = this.leaseAndItem(leaseId); const timestamp = now()
      if (!this.validToken(leaseRow, input.leaseToken) || leaseRow.released_at || String(leaseRow.expires_at) <= timestamp) return { outcome: 'lease_lost', lease: this.leaseFromRow(leaseRow), item }
      const project = this.db.prepare('SELECT state FROM projects WHERE id=?').get(String(leaseRow.project_id)) as Row
      if (String(project.state) !== 'active') return { outcome: 'project_paused', lease: this.leaseFromRow(leaseRow), item }
      if (!policy.enabled) return { outcome: 'policy_disabled', lease: this.leaseFromRow(leaseRow), item }
      const humanChanged = item.version !== input.expectedWorkItemVersion || item.version !== Number(leaseRow.claimed_work_item_version) || item.status !== 'in_progress' || item.queueId !== String(leaseRow.queue_id) || item.effectiveBlocked
      if (humanChanged) return { outcome: 'human_changed_state', lease: this.leaseFromRow(leaseRow), item }
      const outcome = input.outcome === 'resolved' && policy.requiresManualApproval ? 'awaiting_approval' : input.outcome
      const status = outcome === 'resolved' ? 'resolved' : outcome === 'blocked' ? 'blocked' : ['retryable', 'interrupted'].includes(outcome) ? 'open' : 'in_progress'
      const updated = this.db.prepare('UPDATE work_items SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(status, timestamp, item.id, item.version)
      if (!Number(updated.changes)) throw new ConflictError('Work item', item.id)
      this.db.prepare('UPDATE work_leases SET released_at=?,release_reason=?,terminal_outcome=?,version=version+1 WHERE id=? AND released_at IS NULL')
        .run(timestamp, outcome === 'interrupted' ? 'runner_shutdown' : 'manual', outcome, leaseId)
      this.event(item.projectId, 'work_lease', leaseId, 'work_lease.completed', { workItemId: item.id, outcome })
      const fresh = this.leaseAndItem(leaseId)
      return { outcome, lease: this.leaseFromRow(fresh.leaseRow), item: fresh.item }
    })
  }

  private releaseInternal(leaseId: string, leaseToken: string | null, reason: WorkLease['releaseReason'], operator: boolean, expectedLeaseVersion?: number): ReleaseAutomatedWorkResult {
    return this.transaction(() => {
      const { leaseRow, item } = this.leaseAndItem(leaseId); const timestamp = now()
      if (operator && Number(leaseRow.version) !== expectedLeaseVersion) throw new ConflictError('Work lease', leaseId)
      if (leaseRow.released_at) return { outcome: 'already_released', lease: this.leaseFromRow(leaseRow), item }
      if (!operator && !this.validToken(leaseRow, leaseToken)) return { outcome: 'lease_lost', lease: this.leaseFromRow(leaseRow), item }
      this.db.prepare("UPDATE work_leases SET released_at=?,release_reason=?,terminal_outcome='interrupted',version=version+1 WHERE id=? AND released_at IS NULL").run(timestamp, reason, leaseId)
      if (item.version === Number(leaseRow.claimed_work_item_version) && item.status === 'in_progress' && item.queueId === String(leaseRow.queue_id)) this.db.prepare("UPDATE work_items SET status='open',version=version+1,updated_at=? WHERE id=? AND version=?").run(timestamp, item.id, item.version)
      this.event(item.projectId, 'work_lease', leaseId, 'work_lease.released', { workItemId: item.id, reason })
      const fresh = this.leaseAndItem(leaseId)
      return { outcome: 'released', lease: this.leaseFromRow(fresh.leaseRow), item: fresh.item }
    })
  }

  release(leaseId: string, input: RunnerReleaseAutomatedWorkInput): ReleaseAutomatedWorkResult { return this.releaseInternal(leaseId, input.leaseToken, input.reason, false) }
  operatorRelease(leaseId: string, input: OperatorReleaseAutomatedWorkInput): ReleaseAutomatedWorkResult { return this.releaseInternal(leaseId, null, 'manual', true, input.expectedLeaseVersion) }

  readChanges(projectId: string, queueId: string, afterSequence: number, expiredAfter: string, checkedAt: string): AutomationQueueProbe {
    this.queue(projectId, queueId)
    const latestSequence = this.latestSequence(projectId, queueId)
    const retention = this.db.prepare('SELECT discarded_through_sequence FROM automation_queue_change_retention WHERE queue_id=?').get(queueId) as Row | undefined
    const discardedThrough = Number(retention?.discarded_through_sequence ?? 0)
    // Zero explicitly resets a stale cursor; equality is safe because every later change remains retained.
    if (afterSequence > latestSequence || (afterSequence !== 0 && afterSequence < discardedThrough)) throw new ValidationError('Invalid automation queue cursor')
    const page = (this.db.prepare('SELECT * FROM automation_queue_changes WHERE project_id=? AND queue_id=? AND sequence>? ORDER BY sequence LIMIT 201').all(projectId, queueId, afterSequence) as Row[]).slice(0, 200)
    const changes = page.map((row): AutomationQueueChange => ({
      sequence: Number(row.sequence), projectId: String(row.project_id), queueId: String(row.queue_id), eventType: String(row.event_type), entityType: String(row.entity_type), entityId: String(row.entity_id), createdAt: String(row.created_at),
    }))
    const expiredLeases = (this.db.prepare('SELECT * FROM work_leases WHERE project_id=? AND queue_id=? AND released_at IS NULL AND expires_at>? AND expires_at<=? ORDER BY expires_at,id').all(projectId, queueId, expiredAfter, checkedAt) as Row[]).map((row) => this.leaseFromRow(row))
    const next = this.db.prepare('SELECT MIN(expires_at) next_expiry FROM work_leases WHERE project_id=? AND queue_id=? AND released_at IS NULL AND expires_at>?').get(projectId, queueId, checkedAt) as Row
    return { changes, cursorSequence: changes.at(-1)?.sequence ?? afterSequence, expiredLeases, nextExpiryAt: nullable(next.next_expiry) }
  }
}
