import { createHash } from 'node:crypto'
import { canonicalJson } from '../domain/canonical-json.js'
import { AutomationDeliverySchema, automationCompletionOutcomes, automationReleaseReasons } from '../domain/automation.js'

export const exportTables: Record<string, string[]> = {
  projects: ['id','title','description','intent','deadline','completion_criteria','state','current_focus','next_action','blockers_json','current_checkpoint_id','archived_at','version','created_at','updated_at','last_activity_at'],
  error_reports: ['id','kind','component','summary','observation','expected_behaviour','actual_behaviour','reproduction_steps_json','impact','project_id','workspace_path','status','triage_note','source','client','actor','redaction_json','version','created_at','updated_at'],
  phases: ['id','project_id','name','description','status','position','archived_at','version','created_at','updated_at'],
  work_items: ['id','project_id','phase_id','stable_key','parent_id','kind','title','description','status','priority','version','created_at','updated_at'],
  labels: ['id','name','colour','version','created_at','updated_at'],
  work_item_labels: ['work_item_id','label_id','created_at'],
  updates: ['id','project_id','kind','current_revision_id','deleted_at','version','created_at','updated_at'],
  update_revisions: ['id','update_id','revision','content','snapshot_json','source','client','created_at'],
  activity_events: ['id','project_id','entity_type','entity_id','event_type','payload_json','source','client','actor','idempotency_key','created_at'],
  requirement_states: ['id','project_id','name','semantic','position','colour','created_at','updated_at'],
  requirements: ['id','project_id','stable_key','kind','parent_id','title','description','state_id','responsible_phase_id','version','created_at','updated_at'],
  requirement_key_aliases: ['requirement_id','alias','created_at'],
  acceptance_criteria: ['id','requirement_id','title','description','position','required','version','archived_at','created_at','updated_at'],
  requirement_phase_links: ['requirement_id','phase_id','role','created_at'],
  work_queues: ['id','project_id','name','description','version','created_at','updated_at'],
  work_queue_automation_policies: ['queue_id','project_id','enabled','allowed_kinds_json','max_active_claims','lease_seconds','requires_manual_approval','allow_same_worker_recovery','version','created_at','updated_at'],
  work_queue_items: ['queue_id','work_item_id','rank','created_at'],
  work_leases: ['id','project_id','queue_id','work_item_id','worker_id','token_hash','claimed_work_item_version','acquired_at','heartbeat_at','expires_at','released_at','release_reason','terminal_outcome','version'],
  automation_attempts: ['id','project_id','queue_id','work_item_id','lease_id','ordinal','started_at'],
  requirement_work_links: ['requirement_id','work_item_id','created_at'],
  work_phase_links: ['work_item_id','phase_id','role','created_at'],
  work_relations: ['id','project_id','from_work_item_id','to_work_item_id','kind','created_at'],
  external_blockers: ['id','project_id','work_item_id','content','resolved_at','created_at','updated_at'],
  workspaces: ['id','name','canonical_root','remote','created_at','updated_at'],
  workspace_aliases: ['workspace_id','alias','created_at'],
  project_workspaces: ['project_id','workspace_id','created_at'],
  workspace_revisions: ['id','workspace_id','branch','"commit"','dirty','diff_hash','captured_at'],
  project_secret_names: ['project_id','name','created_at'],
  runs: ['id','project_id','workspace_revision_id','command','working_directory','started_at','ended_at','duration_ms','outcome','exit_code','toolchain_json','stdout_excerpt','stderr_excerpt','stdout_truncated','stderr_truncated','validation_status','redaction_json','created_at'],
  test_summaries: ['id','run_id','scope','passed','failed','skipped','target_count','created_at'],
  artifact_references: ['id','run_id','uri','media_type','byte_count','digest','created_at'],
  evidence: ['id','ordinal','project_id','run_id','result','summary','target_version','stale','stale_reason','validation_status','redaction_json','created_at','updated_at'],
  evidence_artifact_links: ['evidence_id','artifact_id'],
  evidence_requirement_links: ['evidence_id','requirement_id'],
  evidence_criterion_links: ['evidence_id','criterion_id','criterion_version','created_at'],
  evidence_work_links: ['evidence_id','work_item_id'],
  evidence_update_links: ['evidence_id','update_id'],
  evidence_checkpoint_links: ['evidence_id','checkpoint_id'],
  evidence_overrides: ['evidence_id','reason','actor','source','client','created_at'],
  automation_attempt_observations: ['id','attempt_id','sequence','kind','summary','run_id','evidence_id','delivery_json','created_at'],
  checkpoint_snapshots: ['id','checkpoint_id','schema_version','captured_at','document_json','digest'],
  idempotency_records: ['client','idempotency_key','operation','request_hash','result_json','created_at'],
}

const jsonColumns = new Set([
  'projects.blockers_json', 'error_reports.reproduction_steps_json', 'error_reports.redaction_json',
  'update_revisions.snapshot_json', 'activity_events.payload_json', 'runs.toolchain_json',
  'runs.redaction_json', 'evidence.redaction_json', 'checkpoint_snapshots.document_json', 'idempotency_records.result_json',
  'work_queue_automation_policies.allowed_kinds_json', 'automation_attempt_observations.delivery_json',
])

export function isJsonExportColumn(table: string, column: string): boolean {
  return jsonColumns.has(`${table}.${column.replaceAll('"', '')}`)
}

const booleanColumns = new Set([
  'acceptance_criteria.required', 'workspace_revisions.dirty', 'runs.stdout_truncated', 'runs.stderr_truncated', 'evidence.stale',
  'work_queue_automation_policies.enabled', 'work_queue_automation_policies.requires_manual_approval', 'work_queue_automation_policies.allow_same_worker_recovery',
])

export function isBooleanExportColumn(table: string, column: string): boolean {
  return booleanColumns.has(`${table}.${column.replaceAll('"', '')}`)
}

const integer64Columns = new Set(['runs.duration_ms', 'artifact_references.byte_count', 'evidence.ordinal'])

function normaliseJson(table: string, column: string, value: unknown): string {
  if (typeof value !== 'string') return canonicalJson(value)
  try {
    return canonicalJson(JSON.parse(value))
  } catch {
    throw new Error(`${table}.${column} contains invalid JSON`)
  }
}

function normaliseTimestamp(table: string, column: string, value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new Error(`${table}.${column} contains an invalid timestamp`)
  return date.toISOString()
}

export function normaliseExportRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const columns = exportTables[table]
  if (!columns) throw new Error(`Unknown export table ${table}`)
  return Object.fromEntries(columns.map((quotedColumn) => {
    const column = quotedColumn.replaceAll('"', '')
    const value = row[column]
    if (value === null || value === undefined) return [column, null]
    if (jsonColumns.has(`${table}.${column}`)) return [column, normaliseJson(table, column, value)]
    if (booleanColumns.has(`${table}.${column}`)) return [column, value === true || value === 1 || value === '1' ? 1 : 0]
    if (integer64Columns.has(`${table}.${column}`)) {
      const number = Number(value)
      if (!Number.isSafeInteger(number)) throw new Error(`${table}.${column} exceeds JavaScript's safe integer range`)
      return [column, number]
    }
    if (column === 'deadline' || column.endsWith('_at')) return [column, normaliseTimestamp(table, column, value)]
    return [column, value]
  }))
}

export function deterministicRows(table: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => normaliseExportRow(table, row)).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
}

const automationIdempotencyOperations = new Set([
  'update_queue_automation_policy', 'claim_next_automated_work', 'heartbeat_automated_work', 'record_automation_attempt',
  'complete_automated_work', 'release_automated_work', 'operator_release_automated_work',
])

export function portableExportRows(table: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const safeRows = table === 'idempotency_records'
    ? rows.filter((row) => !automationIdempotencyOperations.has(String(row.operation)))
    : table === 'work_leases'
      ? rows.map((row) => row.released_at == null ? {
          ...row,
          token_hash: createHash('sha256').update(String(row.token_hash)).digest('hex'),
          expires_at: row.heartbeat_at,
        } : row)
      : rows
  return deterministicRows(table, safeRows)
}

export function automationExportViolations(formatVersion: number, tables: Record<string, Array<Record<string, unknown>>>): string[] {
  if (formatVersion < 5) return []
  const required = ['work_queue_automation_policies', 'work_leases', 'automation_attempts', 'automation_attempt_observations']
  const violations = required.filter((table) => !Array.isArray(tables[table])).map((table) => `missing ${table}`)
  if (violations.length) return violations
  const byId = (table: string, column = 'id') => new Map((tables[table] ?? []).map((row) => [String(row[column]), row]))
  const queues = byId('work_queues')
  const items = byId('work_items')
  const runs = byId('runs')
  const evidence = byId('evidence')
  const leases = byId('work_leases')
  const attempts = byId('automation_attempts')
  const completionOutcomes = new Set<string>(automationCompletionOutcomes)
  const releaseReasons = new Set<string>(automationReleaseReasons)

  for (const policy of tables.work_queue_automation_policies ?? []) {
    const queue = queues.get(String(policy.queue_id))
    if (!queue || String(queue.project_id) !== String(policy.project_id)) violations.push(`policy ${String(policy.queue_id)} has cross-project ownership`)
    let kinds: unknown = null
    try { kinds = JSON.parse(String(policy.allowed_kinds_json)) } catch { /* reported below */ }
    if (!Array.isArray(kinds) || kinds.length < 1 || kinds.length > 2 || new Set(kinds).size !== kinds.length || kinds.some((kind) => !['issue', 'task'].includes(String(kind)))) {
      violations.push(`policy ${String(policy.queue_id)} has invalid allowed kinds`)
    }
  }
  for (const lease of tables.work_leases ?? []) {
    const id = String(lease.id); const queue = queues.get(String(lease.queue_id)); const item = items.get(String(lease.work_item_id))
    if (!queue || !item || String(queue.project_id) !== String(lease.project_id) || String(item.project_id) !== String(lease.project_id)) violations.push(`lease ${id} has cross-project ownership`)
    if (!/^[0-9a-f]{64}$/.test(String(lease.token_hash))) violations.push(`lease ${id} has an invalid token hash`)
    const acquired = Date.parse(String(lease.acquired_at)); const heartbeat = Date.parse(String(lease.heartbeat_at)); const expiry = Date.parse(String(lease.expires_at))
    if ([acquired, heartbeat, expiry].some(Number.isNaN) || acquired > heartbeat || heartbeat > expiry) violations.push(`lease ${id} has invalid timestamps`)
    const active = lease.released_at == null
    const released = active ? null : Date.parse(String(lease.released_at))
    if (released !== null && (Number.isNaN(released) || released < acquired)) violations.push(`lease ${id} has an invalid release timestamp`)
    if (active ? lease.release_reason != null || lease.terminal_outcome != null : lease.release_reason == null || lease.terminal_outcome == null) violations.push(`lease ${id} has inconsistent release state`)
    if (lease.release_reason != null && !releaseReasons.has(String(lease.release_reason))) violations.push(`lease ${id} has an invalid release reason`)
    if (lease.terminal_outcome != null && !completionOutcomes.has(String(lease.terminal_outcome))) violations.push(`lease ${id} has an invalid terminal outcome`)
  }
  for (const attempt of tables.automation_attempts ?? []) {
    const lease = leases.get(String(attempt.lease_id))
    if (!lease || ['project_id', 'queue_id', 'work_item_id'].some((column) => String(lease[column]) !== String(attempt[column]))) violations.push(`attempt ${String(attempt.id)} does not match its lease`)
  }
  for (const observation of tables.automation_attempt_observations ?? []) {
    const attempt = attempts.get(String(observation.attempt_id))
    if (!attempt) { violations.push(`observation ${String(observation.id)} has no attempt`); continue }
    if (observation.run_id != null && String(runs.get(String(observation.run_id))?.project_id) !== String(attempt.project_id)) violations.push(`observation ${String(observation.id)} has a cross-project run`)
    if (observation.evidence_id != null && String(evidence.get(String(observation.evidence_id))?.project_id) !== String(attempt.project_id)) violations.push(`observation ${String(observation.id)} has cross-project evidence`)
    if (observation.delivery_json != null) {
      let delivery: unknown = null
      try { delivery = JSON.parse(String(observation.delivery_json)) } catch { /* reported below */ }
      if (!AutomationDeliverySchema.safeParse(delivery).success) violations.push(`observation ${String(observation.id)} has invalid delivery data`)
    }
  }
  return violations
}
