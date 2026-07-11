import { canonicalJson } from '../domain/canonical-json.js'

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
  work_queue_items: ['queue_id','work_item_id','rank','created_at'],
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
  checkpoint_snapshots: ['id','checkpoint_id','schema_version','captured_at','document_json','digest'],
  idempotency_records: ['client','idempotency_key','operation','request_hash','result_json','created_at'],
}

const jsonColumns = new Set([
  'projects.blockers_json', 'error_reports.reproduction_steps_json', 'error_reports.redaction_json',
  'update_revisions.snapshot_json', 'activity_events.payload_json', 'runs.toolchain_json',
  'runs.redaction_json', 'evidence.redaction_json', 'checkpoint_snapshots.document_json', 'idempotency_records.result_json',
])

export function isJsonExportColumn(table: string, column: string): boolean {
  return jsonColumns.has(`${table}.${column.replaceAll('"', '')}`)
}

const booleanColumns = new Set([
  'acceptance_criteria.required', 'workspace_revisions.dirty', 'runs.stdout_truncated', 'runs.stderr_truncated', 'evidence.stale',
])

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
