import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ConflictError, NotFoundError, ValidationError } from '../../application/errors.js'
import type { ExportBundle, IstraRepository } from '../../application/ports.js'
import { CreateErrorReportSchema, PulseSnapshotSchema, UpdateErrorReportSchema } from '../../domain/contracts.js'
import type {
  ActivityEvent,
  CheckpointInput,
  DashboardActivityEvent,
  CreateLabelInput,
  CreatePhaseInput,
  CreateProjectInput,
  CreateUpdateInput,
  CreateWorkItemInput,
  Label,
  Phase,
  Project,
  ProjectDetail,
  ProjectState,
  ProjectUpdate,
  Provenance,
  PulseSnapshot,
  ReviseUpdateInput,
  SearchFilters,
  SearchResult,
  UpdatePhaseInput,
  UpdateProjectInput,
  UpdateRevision,
  UpdateWorkItemInput,
  WorkItem,
  Page,
} from '../../domain/contracts.js'
import { migrations } from './migrations.js'
import { decodeCursor, encodeCursor, pageOf } from '../../application/pagination.js'
import { validateEvidenceInvariants, validateRunInvariants } from '../../domain/run-invariants.js'
import { canonicalJson } from '../../domain/canonical-json.js'
import { SecretRedactor } from '../../application/secret-redactor.js'
import { automationExportViolations, deterministicRows, exportTables, portableExportRows } from '../export-format.js'

type SqlRow = Record<string, unknown>
const now = () => new Date().toISOString()
const textOrNull = (value: unknown): string | null => value == null ? null : String(value)

function beforeAfter<T extends Record<string, unknown>>(before: T, after: T, keys: string[]): Record<string, { before: unknown; after: unknown }> {
  return Object.fromEntries(keys.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map((key) => [key, { before: before[key], after: after[key] }]))
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function projectFromRow(row: SqlRow): Project {
  return {
    id: String(row.id), title: String(row.title), description: textOrNull(row.description), intent: textOrNull(row.intent),
    deadline: textOrNull(row.deadline), completionCriteria: textOrNull(row.completion_criteria), state: String(row.state) as Project['state'],
    currentFocus: textOrNull(row.current_focus), nextAction: textOrNull(row.next_action), blockers: parseJson<string[]>(row.blockers_json, []),
    currentCheckpointId: textOrNull(row.current_checkpoint_id), archivedAt: textOrNull(row.archived_at), version: Number(row.version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastActivityAt: String(row.last_activity_at),
  }
}

function phaseFromRow(row: SqlRow): Phase {
  return {
    id: String(row.id), projectId: String(row.project_id), name: String(row.name), description: textOrNull(row.description),
    status: String(row.status) as Phase['status'], position: Number(row.position), archivedAt: textOrNull(row.archived_at),
    version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function labelFromRow(row: SqlRow): Label {
  return { id: String(row.id), name: String(row.name), colour: textOrNull(row.colour), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

function revisionFromRow(row: SqlRow): UpdateRevision {
  return {
    id: String(row.id), updateId: String(row.update_id), revision: Number(row.revision), content: String(row.content),
    snapshot: parseJson<PulseSnapshot | null>(row.snapshot_json, null), source: String(row.source), client: textOrNull(row.client), createdAt: String(row.created_at),
  }
}

export class SqliteIstraRepository implements IstraRepository {
  private savepointSequence = 0

  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(work: () => T): T {
    if (this.db.isTransaction) {
      const savepoint = `repository_${this.savepointSequence++}`
      this.db.exec(`SAVEPOINT ${savepoint}`)
      try {
        const result = work()
        this.db.exec(`RELEASE ${savepoint}`)
        return result
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${savepoint}`)
        this.db.exec(`RELEASE ${savepoint}`)
        throw error
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private seedOperationalDefaults(projectId: string, timestamp = now()): void {
    const defaults = [
      ['Missing', 'open', 0, '#7A8594'],
      ['Partial', 'partial', 1, '#C18401'],
      ['Proven', 'proven', 2, '#2D7A4B'],
      ['Defect', 'defect', 3, '#B64D3A'],
    ] as const
    const insertState = this.db.prepare('INSERT OR IGNORE INTO requirement_states(id,project_id,name,semantic,position,colour,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    for (const [name, semantic, position, colour] of defaults) insertState.run(randomUUID(), projectId, name, semantic, position, colour, timestamp, timestamp)
    if (!this.db.prepare('SELECT 1 FROM work_queues WHERE project_id=?').get(projectId)) {
      this.db.prepare('INSERT INTO work_queues(id,project_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), projectId, 'Main queue', 'Default ordered work queue', timestamp, timestamp)
    }
  }

  private event(projectId: string | null, entityType: string, entityId: string, eventType: string, payload: Record<string, unknown>, provenance: Provenance): void {
    const occurredAt = provenance.occurredAt ?? now()
    this.db.prepare(`INSERT INTO activity_events(id,project_id,entity_type,entity_id,event_type,payload_json,source,client,actor,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), projectId, entityType, entityId, eventType, JSON.stringify(payload), provenance.source, provenance.client ?? null, provenance.actor ?? provenance.client ?? provenance.source, provenance.idempotencyKey ?? null, occurredAt)
    if (projectId) this.db.prepare('UPDATE projects SET last_activity_at=? WHERE id=?').run(occurredAt, projectId)
  }

  private replaceSearch(type: SearchResult['type'], id: string, projectId: string, title: string, body: string): void {
    this.db.prepare('DELETE FROM search_index WHERE entity_type=? AND entity_id=?').run(type, id)
    this.db.prepare('INSERT INTO search_index(entity_type,entity_id,project_id,title,body) VALUES (?,?,?,?,?)').run(type, id, projectId, title, body)
  }

  private workItemFromRow(row: SqlRow): WorkItem {
    const id = String(row.id)
    const labels = this.db.prepare(`SELECT l.* FROM labels l JOIN work_item_labels wil ON wil.label_id=l.id WHERE wil.work_item_id=? ORDER BY l.name COLLATE NOCASE`).all(id) as SqlRow[]
    const queue = row.queue_id === undefined
      ? this.db.prepare('SELECT queue_id,rank FROM work_queue_items WHERE work_item_id=? ORDER BY rank,queue_id LIMIT 1').get(id) as SqlRow | undefined
      : row
    const reasons: string[] = []
    const dependencies = this.db.prepare("SELECT wi.title,wr.kind FROM work_relations wr JOIN work_items wi ON ((wr.kind='depends_on' AND wi.id=wr.to_work_item_id) OR (wr.kind='blocks' AND wi.id=wr.from_work_item_id)) WHERE ((wr.kind='depends_on' AND wr.from_work_item_id=?) OR (wr.kind='blocks' AND wr.to_work_item_id=?)) AND wi.status NOT IN ('resolved','dropped')").all(id, id) as SqlRow[]
    if (dependencies.length) reasons.push(...dependencies.map((dependency) => `${String(dependency.kind) === 'blocks' ? 'Blocked by' : 'Depends on'} ${String(dependency.title)}`))
    const externalBlockers = this.db.prepare('SELECT content FROM external_blockers WHERE work_item_id=? AND resolved_at IS NULL').all(id) as SqlRow[]
    if (externalBlockers.length) reasons.push(...externalBlockers.map((blocker) => String(blocker.content)))
    return {
      id, projectId: String(row.project_id), phaseId: textOrNull(row.phase_id), kind: String(row.kind) as WorkItem['kind'],
      title: String(row.title), description: textOrNull(row.description), status: String(row.status) as WorkItem['status'], priority: textOrNull(row.priority) as WorkItem['priority'],
      labels: labels.map(labelFromRow), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      stableKey: textOrNull(row.stable_key), parentId: textOrNull(row.parent_id), queueId: textOrNull(queue?.queue_id), rank: textOrNull(queue?.rank),
      effectiveBlocked: String(row.status) === 'blocked' || reasons.length > 0, blockerReasons: reasons,
    }
  }

  private updateFromRow(row: SqlRow): ProjectUpdate {
    const revision = this.db.prepare('SELECT * FROM update_revisions WHERE id=?').get(String(row.current_revision_id)) as SqlRow | undefined
    if (!revision) throw new Error(`Update ${String(row.id)} has no current revision`)
    return {
      id: String(row.id), projectId: String(row.project_id), kind: String(row.kind) as ProjectUpdate['kind'], currentRevision: revisionFromRow(revision),
      deletedAt: textOrNull(row.deleted_at), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
  }

  listProjects(filters: { state?: ProjectState; includeArchived?: boolean; q?: string } = {}): Project[] {
    const where: string[] = []
    const args: string[] = []
    if (!filters.includeArchived) where.push('archived_at IS NULL')
    if (filters.state) { where.push('state=?'); args.push(filters.state) }
    if (filters.q?.trim()) { where.push('(title LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')'); const q = `%${filters.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`; args.push(q, q) }
    return (this.db.prepare(`SELECT * FROM projects ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_activity_at DESC`).all(...args) as SqlRow[]).map(projectFromRow)
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as SqlRow | undefined
    return row ? projectFromRow(row) : null
  }

  getProjectDetail(id: string): ProjectDetail | null {
    const project = this.getProject(id)
    if (!project) return null
    const phases = this.listPhases(id, true)
    const workItems = this.listWorkItems(id)
    const updates = this.listUpdates(id)
    const currentCheckpoint = project.currentCheckpointId ? updates.find((entry) => entry.id === project.currentCheckpointId) ?? null : null
    const labels = this.db.prepare(`SELECT DISTINCT l.* FROM labels l JOIN work_item_labels wil ON wil.label_id=l.id JOIN work_items wi ON wi.id=wil.work_item_id WHERE wi.project_id=? ORDER BY l.name COLLATE NOCASE`).all(id) as SqlRow[]
    return {
      project,
      pulse: {
        state: project.state, currentFocus: project.currentFocus, nextAction: project.nextAction, blockers: project.blockers, currentCheckpoint,
        activePhases: phases.filter((phase) => phase.status === 'active' && !phase.archivedAt),
        unresolvedWorkItems: workItems.filter((item) => !['resolved','dropped'].includes(item.status)),
      },
      phases, workItems, updates, labels: labels.map(labelFromRow), activity: this.listActivity(id),
    }
  }

  createProject(input: CreateProjectInput, provenance: Provenance): Project {
    const id = randomUUID(); const timestamp = now()
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO projects(id,title,description,intent,deadline,completion_criteria,state,created_at,updated_at,last_activity_at) VALUES (?,?,?,?,?,?,'active',?,?,?)`)
        .run(id, input.title, input.description ?? null, input.intent ?? null, input.deadline ?? null, input.completionCriteria ?? null, timestamp, timestamp, timestamp)
      this.seedOperationalDefaults(id, timestamp)
      this.replaceSearch('project', id, id, input.title, [input.description, input.intent, input.completionCriteria].filter(Boolean).join('\n'))
      this.event(id, 'project', id, 'project.created', { title: input.title }, provenance)
      return this.getProject(id)!
    })
  }

  updateProject(id: string, input: UpdateProjectInput, provenance: Provenance): Project {
    const current = this.getProject(id); if (!current) throw new NotFoundError('Project', id)
    const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'expectedVersion' && value !== undefined)) }
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE projects SET title=?,description=?,intent=?,deadline=?,completion_criteria=?,state=?,current_focus=?,next_action=?,blockers_json=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(next.title, next.description, next.intent, next.deadline, next.completionCriteria, next.state, next.currentFocus, next.nextAction, JSON.stringify(next.blockers), now(), id, input.expectedVersion)
      if (Number(result.changes) === 0) throw new ConflictError('Project', id)
      this.replaceSearch('project', id, id, next.title, [next.description, next.intent, next.completionCriteria].filter(Boolean).join('\n'))
      const changes = beforeAfter(current as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, ['title','description','intent','deadline','completionCriteria','state','currentFocus','nextAction','blockers'])
      this.event(id, 'project', id, 'project.updated', { changed: Object.keys(changes), changes }, provenance)
      return this.getProject(id)!
    })
  }

  archiveProject(id: string, expectedVersion: number, archived: boolean, provenance: Provenance): Project {
    const current = this.getProject(id); if (!current) throw new NotFoundError('Project', id)
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE projects SET archived_at=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(archived ? now() : null, now(), id, expectedVersion)
      if (Number(result.changes) === 0) throw new ConflictError('Project', id)
      const updated = this.getProject(id)!
      this.event(id, 'project', id, archived ? 'project.archived' : 'project.unarchived', { changes: { archivedAt: { before: current.archivedAt, after: updated.archivedAt } } }, provenance)
      return this.getProject(id)!
    })
  }

  listPhases(projectId: string, includeArchived = false): Phase[] {
    return (this.db.prepare(`SELECT * FROM phases WHERE project_id=? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY position,created_at`).all(projectId) as SqlRow[]).map(phaseFromRow)
  }

  createPhase(projectId: string, input: CreatePhaseInput, provenance: Provenance): Phase {
    if (!this.getProject(projectId)) throw new NotFoundError('Project', projectId)
    const id = randomUUID(); const timestamp = now(); const position = input.position ?? Number((this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM phases WHERE project_id=?').get(projectId) as SqlRow).p)
    return this.transaction(() => {
      this.db.prepare('INSERT INTO phases(id,project_id,name,description,status,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, projectId, input.name, input.description ?? null, input.status, position, timestamp, timestamp)
      this.replaceSearch('phase', id, projectId, input.name, input.description ?? '')
      this.event(projectId, 'phase', id, 'phase.created', { name: input.name }, provenance)
      return phaseFromRow(this.db.prepare('SELECT * FROM phases WHERE id=?').get(id) as SqlRow)
    })
  }

  updatePhase(id: string, input: UpdatePhaseInput, provenance: Provenance): Phase {
    const row = this.db.prepare('SELECT * FROM phases WHERE id=?').get(id) as SqlRow | undefined; if (!row) throw new NotFoundError('Phase', id)
    const current = phaseFromRow(row); const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([k,v]) => !['expectedVersion','archived'].includes(k) && v !== undefined)) }
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE phases SET name=?,description=?,status=?,position=?,archived_at=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(next.name, next.description, next.status, next.position, input.archived === undefined ? current.archivedAt : input.archived ? now() : null, now(), id, input.expectedVersion)
      if (Number(result.changes) === 0) throw new ConflictError('Phase', id)
      this.replaceSearch('phase', id, current.projectId, next.name, next.description ?? '')
      const updated = phaseFromRow(this.db.prepare('SELECT * FROM phases WHERE id=?').get(id) as SqlRow)
      const changes = beforeAfter(current as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>, ['name','description','status','position','archivedAt'])
      this.event(current.projectId, 'phase', id, 'phase.updated', { changed: Object.keys(changes), changes }, provenance)
      return updated
    })
  }

  listWorkItems(projectId: string, statuses?: string[]): WorkItem[] {
    const filtered = statuses?.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : ''
    return (this.db.prepare(`SELECT * FROM work_items WHERE project_id=?${filtered} ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, updated_at DESC`).all(projectId, ...(statuses ?? [])) as SqlRow[]).map((row) => this.workItemFromRow(row))
  }

  listWorkItemsPage(projectId: string, limit: number, cursor?: string | null, statuses?: string[]): Page<WorkItem> {
    return pageOf(this.listWorkItems(projectId, statuses), limit, cursor)
  }

  createWorkItem(projectId: string, input: CreateWorkItemInput, provenance: Provenance): WorkItem {
    if (!this.getProject(projectId)) throw new NotFoundError('Project', projectId)
    if (input.phaseId) this.assertPhaseInProject(input.phaseId, projectId)
    if (input.parentId) this.assertParentInProject(input.parentId, projectId)
    const queueId = input.queueId === undefined ? this.ensureDefaultQueue(projectId) : input.queueId
    if (queueId) this.assertQueueInProject(queueId, projectId)
    for (const phaseId of new Set(input.relatedPhaseIds ?? [])) this.assertPhaseInProject(phaseId, projectId)
    for (const requirementId of new Set(input.requirementIds ?? [])) this.assertProjectEntity('requirements', requirementId, projectId)
    const id = randomUUID(); const timestamp = now(); const labelIds = [...new Set(input.labelIds ?? [])]
    return this.transaction(() => {
      this.db.prepare('INSERT INTO work_items(id,project_id,phase_id,stable_key,parent_id,kind,title,description,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId, input.phaseId ?? null, input.stableKey ?? null, input.parentId ?? null, input.kind, input.title, input.description ?? null, input.status ?? 'open', input.priority ?? null, timestamp, timestamp)
      for (const labelId of labelIds) this.insertWorkItemLabel(id, labelId)
      if (queueId) this.insertQueueItem(queueId, id, input.rank ?? `${timestamp}-${id}`)
      if (input.phaseId) this.insertWorkPhaseLink(id, input.phaseId, 'responsible', projectId)
      for (const phaseId of new Set(input.relatedPhaseIds ?? [])) if (phaseId !== input.phaseId) this.insertWorkPhaseLink(id, phaseId, 'related', projectId)
      for (const requirementId of new Set(input.requirementIds ?? [])) this.db.prepare('INSERT OR IGNORE INTO requirement_work_links(requirement_id,work_item_id,created_at) VALUES (?,?,?)').run(requirementId, id, timestamp)
      this.replaceSearch('work_item', id, projectId, input.title, input.description ?? '')
      this.event(projectId, 'work_item', id, 'work_item.created', { title: input.title, kind: input.kind, status: input.status ?? 'open', phaseId: input.phaseId ?? null, stableKey: input.stableKey ?? null, parentId: input.parentId ?? null, queueId, rank: input.rank ?? null, labelIds }, provenance)
      for (const labelId of labelIds) this.event(projectId, 'work_item', id, 'work_item.label_attached', { labelId }, provenance)
      return this.workItemFromRow(this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id) as SqlRow)
    })
  }

  updateWorkItem(id: string, input: UpdateWorkItemInput, provenance: Provenance): WorkItem {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id) as SqlRow | undefined; if (!row) throw new NotFoundError('Work item', id)
    const current = this.workItemFromRow(row); if (input.phaseId) this.assertPhaseInProject(input.phaseId, current.projectId)
    const parentId = input.parentId === undefined ? current.parentId ?? null : input.parentId
    if (parentId) this.assertParentInProject(parentId, current.projectId, id)
    const queueId = input.queueId === undefined ? current.queueId ?? null : input.queueId
    if (queueId) this.assertQueueInProject(queueId, current.projectId)
    const relatedPhaseIds = input.relatedPhaseIds ?? (this.db.prepare("SELECT phase_id FROM work_phase_links WHERE work_item_id=? AND role='related'").all(id) as SqlRow[]).map((entry) => String(entry.phase_id))
    for (const phaseId of new Set(relatedPhaseIds)) this.assertPhaseInProject(phaseId, current.projectId)
    for (const requirementId of new Set(input.requirementIds ?? [])) this.assertProjectEntity('requirements', requirementId, current.projectId)
    const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([k,v]) => !['expectedVersion','labelIds','requirementIds','relatedPhaseIds','queueId','rank'].includes(k) && v !== undefined)), parentId, queueId, rank: input.rank === undefined ? current.rank ?? null : input.rank }
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE work_items SET phase_id=?,stable_key=?,parent_id=?,kind=?,title=?,description=?,status=?,priority=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(next.phaseId, next.stableKey ?? null, parentId, next.kind, next.title, next.description, next.status, next.priority, now(), id, input.expectedVersion)
      if (Number(result.changes) === 0) throw new ConflictError('Work item', id)
      const previousLabelIds = current.labels.map((label) => label.id)
      if (input.labelIds) { this.db.prepare('DELETE FROM work_item_labels WHERE work_item_id=?').run(id); for (const labelId of new Set(input.labelIds)) this.insertWorkItemLabel(id, labelId) }
      if (input.queueId !== undefined || input.rank !== undefined) {
        this.db.prepare('DELETE FROM work_queue_items WHERE work_item_id=?').run(id)
        if (queueId) this.insertQueueItem(queueId, id, input.rank ?? current.rank ?? `${now()}-${id}`)
      }
      if (input.relatedPhaseIds !== undefined || input.phaseId !== undefined) {
        this.db.prepare('DELETE FROM work_phase_links WHERE work_item_id=?').run(id)
        if (next.phaseId) this.insertWorkPhaseLink(id, next.phaseId, 'responsible', current.projectId)
        for (const phaseId of new Set(relatedPhaseIds)) if (phaseId !== next.phaseId) this.insertWorkPhaseLink(id, phaseId, 'related', current.projectId)
      }
      if (input.requirementIds !== undefined) {
        this.db.prepare('DELETE FROM requirement_work_links WHERE work_item_id=?').run(id)
        for (const requirementId of new Set(input.requirementIds)) this.db.prepare('INSERT INTO requirement_work_links(requirement_id,work_item_id,created_at) VALUES (?,?,?)').run(requirementId, id, now())
      }
      this.replaceSearch('work_item', id, current.projectId, next.title, next.description ?? '')
      const updated = this.workItemFromRow(this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id) as SqlRow)
      const currentEventState = { ...current, labelIds: previousLabelIds } as unknown as Record<string, unknown>
      const updatedEventState = { ...updated, labelIds: updated.labels.map((label) => label.id) } as unknown as Record<string, unknown>
      const changes = beforeAfter(currentEventState, updatedEventState, ['title','description','kind','status','priority','phaseId','stableKey','parentId','queueId','rank','labelIds'])
      this.event(current.projectId, 'work_item', id, 'work_item.updated', { changed: Object.keys(changes), changes }, provenance)
      for (const labelId of updated.labels.map((label) => label.id).filter((labelId) => !previousLabelIds.includes(labelId))) this.event(current.projectId, 'work_item', id, 'work_item.label_attached', { labelId }, provenance)
      for (const labelId of previousLabelIds.filter((labelId) => !updated.labels.some((label) => label.id === labelId))) this.event(current.projectId, 'work_item', id, 'work_item.label_detached', { labelId }, provenance)
      return updated
    })
  }

  private assertPhaseInProject(phaseId: string, projectId: string): void {
    const row = this.db.prepare('SELECT project_id FROM phases WHERE id=?').get(phaseId) as SqlRow | undefined
    if (!row || row.project_id !== projectId) throw new ValidationError('phaseId must refer to a phase in the same project')
  }

  private assertProjectEntity(table: 'requirements' | 'work_items', id: string, projectId: string): void {
    const row = this.db.prepare(`SELECT project_id FROM ${table} WHERE id=?`).get(id) as SqlRow | undefined
    if (!row) throw new NotFoundError(table === 'requirements' ? 'Requirement' : 'Work item', id)
    if (String(row.project_id) !== projectId) throw new ValidationError(`${table === 'requirements' ? 'requirementId' : 'workItemId'} must refer to an entity in the same project`)
  }

  private assertParentInProject(parentId: string, projectId: string, childId?: string): void {
    this.assertProjectEntity('work_items', parentId, projectId)
    if (parentId === childId) throw new ValidationError('A work item cannot be its own parent')
    if (!childId) return
    const cycle = this.db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT parent_id FROM work_items WHERE id=? AND parent_id IS NOT NULL
      UNION
      SELECT wi.parent_id FROM work_items wi JOIN descendants d ON wi.id=d.id WHERE wi.parent_id IS NOT NULL
    ) SELECT 1 FROM descendants WHERE id=? LIMIT 1`).get(parentId, childId)
    if (cycle) throw new ValidationError('Parent relationship would create a cycle')
  }

  private assertQueueInProject(queueId: string, projectId: string): void {
    const row = this.db.prepare('SELECT project_id FROM work_queues WHERE id=?').get(queueId) as SqlRow | undefined
    if (!row) throw new NotFoundError('Work queue', queueId)
    if (String(row.project_id) !== projectId) throw new ValidationError('queueId must refer to a queue in the same project')
  }

  private ensureDefaultQueue(projectId: string): string {
    const existing = this.db.prepare('SELECT id FROM work_queues WHERE project_id=? ORDER BY created_at LIMIT 1').get(projectId) as SqlRow | undefined
    if (existing) return String(existing.id)
    const id = randomUUID(); const timestamp = now()
    this.db.prepare('INSERT INTO work_queues(id,project_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, projectId, 'Main queue', 'Default ordered work queue', timestamp, timestamp)
    return id
  }

  private insertQueueItem(queueId: string, workItemId: string, rank: string): void {
    try {
      this.db.prepare('INSERT INTO work_queue_items(queue_id,work_item_id,rank,created_at) VALUES (?,?,?,?)').run(queueId, workItemId, rank, now())
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : 'Could not add work item to queue')
    }
  }

  private insertWorkPhaseLink(workItemId: string, phaseId: string, role: 'responsible' | 'related', projectId: string): void {
    this.assertPhaseInProject(phaseId, projectId)
    this.db.prepare('INSERT OR REPLACE INTO work_phase_links(work_item_id,phase_id,role,created_at) VALUES (?,?,?,?)').run(workItemId, phaseId, role, now())
  }

  private insertWorkItemLabel(workItemId: string, labelId: string): void {
    if (!this.db.prepare('SELECT 1 FROM labels WHERE id=?').get(labelId)) throw new NotFoundError('Label', labelId)
    this.db.prepare('INSERT OR IGNORE INTO work_item_labels(work_item_id,label_id,created_at) VALUES (?,?,?)').run(workItemId, labelId, now())
  }

  listUpdates(projectId: string, includeDeleted = false): ProjectUpdate[] {
    return (this.db.prepare(`SELECT * FROM updates WHERE project_id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at DESC`).all(projectId) as SqlRow[]).map((row) => this.updateFromRow(row))
  }

  listUpdatesPage(projectId: string, limit: number, cursor?: string | null, includeDeleted = false): Page<ProjectUpdate> {
    return pageOf(this.listUpdates(projectId, includeDeleted), limit, cursor)
  }

  getUpdateRevisions(updateId: string): UpdateRevision[] {
    if (!this.db.prepare('SELECT 1 FROM updates WHERE id=?').get(updateId)) throw new NotFoundError('Update', updateId)
    return (this.db.prepare('SELECT * FROM update_revisions WHERE update_id=? ORDER BY revision DESC').all(updateId) as SqlRow[]).map(revisionFromRow)
  }

  createUpdate(projectId: string, input: CreateUpdateInput, provenance: Provenance): ProjectUpdate {
    return this.transaction(() => this.insertUpdate(projectId, input.kind, input.content, null, provenance))
  }

  private insertUpdate(projectId: string, kind: ProjectUpdate['kind'], content: string, snapshot: PulseSnapshot | null, provenance: Provenance): ProjectUpdate {
    if (!this.getProject(projectId)) throw new NotFoundError('Project', projectId)
    const id = randomUUID(); const revisionId = randomUUID(); const timestamp = now()
    this.db.prepare('INSERT INTO updates(id,project_id,kind,current_revision_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, projectId, kind, revisionId, timestamp, timestamp)
    this.db.prepare('INSERT INTO update_revisions(id,update_id,revision,content,snapshot_json,source,client,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(revisionId, id, 1, content, snapshot ? JSON.stringify(snapshot) : null, provenance.source, provenance.client ?? null, timestamp)
    this.replaceSearch('update', id, projectId, kind, content)
    this.event(projectId, 'update', id, kind === 'checkpoint' ? 'checkpoint.created' : 'update.created', { kind, content }, provenance)
    return this.updateFromRow(this.db.prepare('SELECT * FROM updates WHERE id=?').get(id) as SqlRow)
  }

  reviseUpdate(updateId: string, input: ReviseUpdateInput, provenance: Provenance): ProjectUpdate {
    const row = this.db.prepare('SELECT * FROM updates WHERE id=?').get(updateId) as SqlRow | undefined; if (!row) throw new NotFoundError('Update', updateId)
    if (row.deleted_at) throw new ValidationError('Deleted updates cannot be revised')
    const projectId = String(row.project_id)
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE updates SET version=version+1,updated_at=? WHERE id=? AND version=?').run(now(), updateId, input.expectedVersion)
      if (Number(result.changes) === 0) throw new ConflictError('Update', updateId)
      const revision = Number((this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM update_revisions WHERE update_id=?').get(updateId) as SqlRow).revision)
      const revisionId = randomUUID(); const timestamp = now()
      const currentRevision = this.db.prepare('SELECT snapshot_json FROM update_revisions WHERE id=?').get(String(row.current_revision_id)) as SqlRow
      this.db.prepare('INSERT INTO update_revisions(id,update_id,revision,content,snapshot_json,source,client,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(revisionId, updateId, revision, input.content, textOrNull(currentRevision.snapshot_json), provenance.source, provenance.client ?? null, timestamp)
      this.db.prepare('UPDATE updates SET current_revision_id=? WHERE id=?').run(revisionId, updateId)
      this.replaceSearch('update', updateId, projectId, String(row.kind), input.content)
      this.event(projectId, 'update', updateId, 'update.revised', { revision, content: input.content }, provenance)
      return this.updateFromRow(this.db.prepare('SELECT * FROM updates WHERE id=?').get(updateId) as SqlRow)
    })
  }

  softDeleteUpdate(updateId: string, expectedVersion: number, provenance: Provenance): ProjectUpdate {
    const row = this.db.prepare('SELECT * FROM updates WHERE id=?').get(updateId) as SqlRow | undefined; if (!row) throw new NotFoundError('Update', updateId)
    if (row.kind === 'checkpoint' && this.db.prepare('SELECT 1 FROM projects WHERE current_checkpoint_id=?').get(updateId)) throw new ValidationError('The current checkpoint cannot be deleted until another checkpoint is saved')
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE updates SET deleted_at=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(now(), now(), updateId, expectedVersion)
      if (Number(result.changes) === 0) throw new ConflictError('Update', updateId)
      this.db.prepare('DELETE FROM search_index WHERE entity_type=? AND entity_id=?').run('update', updateId)
      this.event(String(row.project_id), 'update', updateId, 'update.deleted', {}, provenance)
      return this.updateFromRow(this.db.prepare('SELECT * FROM updates WHERE id=?').get(updateId) as SqlRow)
    })
  }

  saveCheckpoint(projectId: string, input: CheckpointInput, provenance: Provenance): ProjectUpdate {
    const project = this.getProject(projectId); if (!project) throw new NotFoundError('Project', projectId)
    return this.transaction(() => {
      if (project.version !== input.expectedVersion) throw new ConflictError('Project', projectId)
      const currentFocus = input.currentFocus === undefined ? project.currentFocus : input.currentFocus
      const nextAction = input.nextAction === undefined ? project.nextAction : input.nextAction
      const blockers = input.blockers ?? project.blockers
      const snapshot: PulseSnapshot = {
        state: project.state, currentFocus, nextAction, blockers,
        activePhaseIds: this.listPhases(projectId).filter((phase) => phase.status === 'active').map((phase) => phase.id),
        unresolvedWorkItemIds: this.listWorkItems(projectId).filter((item) => !['resolved','dropped'].includes(item.status)).map((item) => item.id),
        capturedAt: now(),
      }
      const checkpoint = this.insertUpdate(projectId, 'checkpoint', input.content, snapshot, provenance)
      const result = this.db.prepare('UPDATE projects SET current_focus=?,next_action=?,blockers_json=?,current_checkpoint_id=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(currentFocus, nextAction, JSON.stringify(blockers), checkpoint.id, now(), projectId, input.expectedVersion)
      if (Number(result.changes) === 0) throw new ConflictError('Project', projectId)
      this.event(projectId, 'project', projectId, 'project.checkpoint_selected', { checkpointId: checkpoint.id }, provenance)
      return checkpoint
    })
  }

  listLabels(): Label[] { return (this.db.prepare('SELECT * FROM labels ORDER BY name COLLATE NOCASE').all() as SqlRow[]).map(labelFromRow) }

  createLabel(input: CreateLabelInput, provenance: Provenance): Label {
    const id = randomUUID(); const timestamp = now()
    return this.transaction(() => {
      try {
        this.db.prepare('INSERT INTO labels(id,name,colour,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, input.name, input.colour ?? null, timestamp, timestamp)
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE')) throw new ValidationError(`A label named “${input.name}” already exists`)
        throw error
      }
      this.event(null, 'label', id, 'label.created', { name: input.name }, provenance)
      return labelFromRow(this.db.prepare('SELECT * FROM labels WHERE id=?').get(id) as SqlRow)
    })
  }

  attachLabel(workItemId: string, labelId: string, expectedVersion: number, provenance: Provenance): WorkItem {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id=?').get(workItemId) as SqlRow | undefined; if (!row) throw new NotFoundError('Work item', workItemId)
    return this.transaction(() => {
      const fresh = this.db.prepare('SELECT * FROM work_items WHERE id=?').get(workItemId) as SqlRow
      if (Number(fresh.version) !== expectedVersion) throw new ConflictError('Work item', workItemId)
      if (!this.db.prepare('SELECT 1 FROM labels WHERE id=?').get(labelId)) throw new NotFoundError('Label', labelId)
      if (this.db.prepare('SELECT 1 FROM work_item_labels WHERE work_item_id=? AND label_id=?').get(workItemId, labelId)) return this.workItemFromRow(fresh)
      const result = this.db.prepare('UPDATE work_items SET version=version+1,updated_at=? WHERE id=? AND version=?').run(now(), workItemId, expectedVersion)
      if (Number(result.changes) === 0) throw new ConflictError('Work item', workItemId)
      this.insertWorkItemLabel(workItemId, labelId)
      this.event(String(row.project_id), 'work_item', workItemId, 'work_item.label_attached', { labelId }, provenance)
      return this.workItemFromRow(this.db.prepare('SELECT * FROM work_items WHERE id=?').get(workItemId) as SqlRow)
    })
  }

  detachLabel(workItemId: string, labelId: string, expectedVersion: number, provenance: Provenance): WorkItem {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id=?').get(workItemId) as SqlRow | undefined; if (!row) throw new NotFoundError('Work item', workItemId)
    return this.transaction(() => {
      const fresh = this.db.prepare('SELECT * FROM work_items WHERE id=?').get(workItemId) as SqlRow
      if (Number(fresh.version) !== expectedVersion) throw new ConflictError('Work item', workItemId)
      if (!this.db.prepare('SELECT 1 FROM work_item_labels WHERE work_item_id=? AND label_id=?').get(workItemId, labelId)) return this.workItemFromRow(fresh)
      const result = this.db.prepare('UPDATE work_items SET version=version+1,updated_at=? WHERE id=? AND version=?').run(now(), workItemId, expectedVersion)
      if (Number(result.changes) === 0) throw new ConflictError('Work item', workItemId)
      this.db.prepare('DELETE FROM work_item_labels WHERE work_item_id=? AND label_id=?').run(workItemId, labelId)
      this.event(String(row.project_id), 'work_item', workItemId, 'work_item.label_detached', { labelId }, provenance)
      return this.workItemFromRow(this.db.prepare('SELECT * FROM work_items WHERE id=?').get(workItemId) as SqlRow)
    })
  }

  listActivity(projectId: string, limit = 200): ActivityEvent[] {
    return (this.db.prepare('SELECT * FROM activity_events WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(projectId, Math.min(Math.max(limit, 1), 1000)) as SqlRow[]).map((row) => ({
      id: String(row.id), projectId: textOrNull(row.project_id), entityType: String(row.entity_type), entityId: String(row.entity_id), eventType: String(row.event_type),
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}), source: String(row.source), client: textOrNull(row.client), actor: String(row.actor), idempotencyKey: textOrNull(row.idempotency_key), createdAt: String(row.created_at),
    }))
  }

  listActivityPage(projectId: string, limit: number, cursor?: string | null): Page<ActivityEvent> {
    const start = decodeCursor(cursor)
    const boundedLimit = Math.min(Math.max(limit, 1), 200)
    const rows = this.db.prepare('SELECT * FROM activity_events WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(projectId, boundedLimit + 1, start) as SqlRow[]
    const hasMore = rows.length > boundedLimit
    const items = rows.slice(0, boundedLimit).map((row) => ({
      id: String(row.id), projectId: textOrNull(row.project_id), entityType: String(row.entity_type), entityId: String(row.entity_id), eventType: String(row.event_type),
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}), source: String(row.source), client: textOrNull(row.client), actor: String(row.actor), idempotencyKey: textOrNull(row.idempotency_key), createdAt: String(row.created_at),
    }))
    return { items, nextCursor: hasMore ? encodeCursor(start + items.length) : null, hasMore }
  }

  listRecentActivity(limit = 50): DashboardActivityEvent[] {
    const rows = this.db.prepare(`SELECT ae.*,p.title AS project_title FROM activity_events ae JOIN projects p ON p.id=ae.project_id WHERE p.archived_at IS NULL ORDER BY ae.created_at DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 200)) as SqlRow[]
    return rows.map((row) => ({
      id: String(row.id), projectId: String(row.project_id), projectTitle: String(row.project_title), entityType: String(row.entity_type), entityId: String(row.entity_id), eventType: String(row.event_type),
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}), source: String(row.source), client: textOrNull(row.client), actor: String(row.actor), idempotencyKey: textOrNull(row.idempotency_key), createdAt: String(row.created_at),
    }))
  }

  search(query: string, limit = 50, filters: SearchFilters = {}): SearchResult[] {
    const terms = query.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`).join(' ')
    if (!terms) return []
    const clauses = ['search_index MATCH ?']
    const parameters: Array<string | number> = [terms]
    if (filters.projectId) { clauses.push('search_index.project_id=?'); parameters.push(filters.projectId) }
    if (filters.entityTypes) {
      if (!filters.entityTypes.length) clauses.push('0')
      else { clauses.push(`search_index.entity_type IN (${filters.entityTypes.map(() => '?').join(',')})`); parameters.push(...filters.entityTypes) }
    }
    if (filters.state) { clauses.push('COALESCE(p.state,ph.status,wi.status)=?'); parameters.push(filters.state) }
    if (filters.phaseId) {
      clauses.push("(ph.id=? OR (search_index.entity_type='work_item' AND (wi.phase_id=? OR EXISTS (SELECT 1 FROM work_phase_links wpl WHERE wpl.work_item_id=search_index.entity_id AND wpl.phase_id=?))))")
      parameters.push(filters.phaseId, filters.phaseId, filters.phaseId)
    }
    if (filters.requirementId) {
      clauses.push("search_index.entity_type='work_item' AND EXISTS (SELECT 1 FROM requirement_work_links rwl WHERE rwl.work_item_id=search_index.entity_id AND rwl.requirement_id=?)")
      parameters.push(filters.requirementId)
    }
    if (filters.evidenceResult) clauses.push('0')
    if (filters.from) { clauses.push('COALESCE(p.created_at,ph.created_at,wi.created_at,u.created_at)>=?'); parameters.push(filters.from) }
    if (filters.to) { clauses.push('COALESCE(p.created_at,ph.created_at,wi.created_at,u.created_at)<=?'); parameters.push(filters.to) }
    parameters.push(Math.min(Math.max(limit, 1), 200))
    const rows = this.db.prepare(`SELECT search_index.entity_type,search_index.entity_id,search_index.project_id,search_index.title,snippet(search_index,4,'','',' … ',24) AS excerpt,bm25(search_index,5.0,1.0) AS score
      FROM search_index
      LEFT JOIN projects p ON search_index.entity_type='project' AND p.id=search_index.entity_id
      LEFT JOIN phases ph ON search_index.entity_type='phase' AND ph.id=search_index.entity_id
      LEFT JOIN work_items wi ON search_index.entity_type='work_item' AND wi.id=search_index.entity_id
      LEFT JOIN updates u ON search_index.entity_type='update' AND u.id=search_index.entity_id
      WHERE ${clauses.join(' AND ')} ORDER BY score LIMIT ?`).all(...parameters) as SqlRow[]
    return rows.map((row) => ({ type: String(row.entity_type) as SearchResult['type'], id: String(row.entity_id), projectId: String(row.project_id), title: String(row.title), excerpt: String(row.excerpt), score: Number(row.score) }))
  }

  exportAll(): ExportBundle {
    const tables: ExportBundle['tables'] = {}
    for (const [table, columns] of Object.entries(exportTables)) {
      tables[table] = portableExportRows(table, this.db.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() as Array<Record<string, unknown>>)
    }
    return { format: 'istra-export', formatVersion: 5, exportedAt: now(), tables }
  }

  validateImport(bundle: ExportBundle): void {
    const temp = new DatabaseSync(':memory:')
    try {
      if (![3, 4, 5].includes(bundle.formatVersion)) throw new ValidationError(`Unsupported import format version ${String(bundle.formatVersion)}`)
      const automationViolations = automationExportViolations(bundle.formatVersion, bundle.tables)
      if (automationViolations.length) throw new ValidationError('Import contains invalid automation data', { automationViolations })
      temp.exec('PRAGMA foreign_keys=ON;')
      for (const migration of migrations) temp.exec(migration.sql)
      temp.exec('BEGIN; PRAGMA defer_foreign_keys=ON;')
      this.loadTables(temp, bundle)
      const integrity = temp.prepare('PRAGMA integrity_check').get() as SqlRow
      const foreignKeys = temp.prepare('PRAGMA foreign_key_check').all()
      const invalidCheckpoints = temp.prepare(`SELECT p.id,p.current_checkpoint_id FROM projects p LEFT JOIN updates u ON u.id=p.current_checkpoint_id WHERE p.current_checkpoint_id IS NOT NULL AND (u.id IS NULL OR u.project_id<>p.id OR u.kind<>'checkpoint' OR u.deleted_at IS NOT NULL)`).all()
      const invalidCurrentRevisions = temp.prepare(`SELECT u.id,u.current_revision_id FROM updates u LEFT JOIN update_revisions r ON r.id=u.current_revision_id WHERE r.id IS NULL OR r.update_id<>u.id`).all()
      const invalidPhaseProjects = temp.prepare(`SELECT wi.id,wi.phase_id FROM work_items wi JOIN phases p ON p.id=wi.phase_id WHERE wi.project_id<>p.project_id`).all()
      const invalidOperationalProjects = temp.prepare(`
        SELECT relation,id FROM (
          SELECT 'requirement_state' AS relation,r.id FROM requirements r JOIN requirement_states s ON s.id=r.state_id WHERE r.project_id<>s.project_id
          UNION ALL SELECT 'requirement_parent',r.id FROM requirements r JOIN requirements parent ON parent.id=r.parent_id WHERE r.project_id<>parent.project_id
          UNION ALL SELECT 'requirement_responsible_phase',r.id FROM requirements r JOIN phases p ON p.id=r.responsible_phase_id WHERE r.project_id<>p.project_id
          UNION ALL SELECT 'requirement_phase',l.requirement_id FROM requirement_phase_links l JOIN requirements r ON r.id=l.requirement_id JOIN phases p ON p.id=l.phase_id WHERE r.project_id<>p.project_id
          UNION ALL SELECT 'work_parent',w.id FROM work_items w JOIN work_items parent ON parent.id=w.parent_id WHERE w.project_id<>parent.project_id
          UNION ALL SELECT 'work_queue',q.work_item_id FROM work_queue_items q JOIN work_items w ON w.id=q.work_item_id JOIN work_queues queue ON queue.id=q.queue_id WHERE w.project_id<>queue.project_id
          UNION ALL SELECT 'requirement_work',l.work_item_id FROM requirement_work_links l JOIN requirements r ON r.id=l.requirement_id JOIN work_items w ON w.id=l.work_item_id WHERE r.project_id<>w.project_id
          UNION ALL SELECT 'work_phase',l.work_item_id FROM work_phase_links l JOIN work_items w ON w.id=l.work_item_id JOIN phases p ON p.id=l.phase_id WHERE w.project_id<>p.project_id
          UNION ALL SELECT 'work_relation',r.id FROM work_relations r JOIN work_items source ON source.id=r.from_work_item_id JOIN work_items target ON target.id=r.to_work_item_id WHERE r.project_id<>source.project_id OR r.project_id<>target.project_id
          UNION ALL SELECT 'external_blocker',b.id FROM external_blockers b JOIN work_items w ON w.id=b.work_item_id WHERE b.project_id<>w.project_id
          UNION ALL SELECT 'run_workspace',r.id FROM runs r JOIN workspace_revisions revision ON revision.id=r.workspace_revision_id WHERE NOT EXISTS (SELECT 1 FROM project_workspaces pw WHERE pw.project_id=r.project_id AND pw.workspace_id=revision.workspace_id)
          UNION ALL SELECT 'evidence_run',e.id FROM evidence e JOIN runs r ON r.id=e.run_id WHERE e.project_id<>r.project_id
          UNION ALL SELECT 'evidence_requirement',l.evidence_id FROM evidence_requirement_links l JOIN evidence e ON e.id=l.evidence_id JOIN requirements r ON r.id=l.requirement_id WHERE e.project_id<>r.project_id
          UNION ALL SELECT 'evidence_criterion',l.evidence_id FROM evidence_criterion_links l JOIN evidence e ON e.id=l.evidence_id JOIN acceptance_criteria c ON c.id=l.criterion_id JOIN requirements r ON r.id=c.requirement_id WHERE e.project_id<>r.project_id OR l.criterion_version>c.version
          UNION ALL SELECT 'evidence_criterion_requirement',l.evidence_id FROM evidence_criterion_links l JOIN acceptance_criteria c ON c.id=l.criterion_id WHERE NOT EXISTS (SELECT 1 FROM evidence_requirement_links erl WHERE erl.evidence_id=l.evidence_id AND erl.requirement_id=c.requirement_id)
          UNION ALL SELECT 'evidence_work',l.evidence_id FROM evidence_work_links l JOIN evidence e ON e.id=l.evidence_id JOIN work_items w ON w.id=l.work_item_id WHERE e.project_id<>w.project_id
          UNION ALL SELECT 'evidence_update',l.evidence_id FROM evidence_update_links l JOIN evidence e ON e.id=l.evidence_id JOIN updates u ON u.id=l.update_id WHERE e.project_id<>u.project_id
          UNION ALL SELECT 'evidence_checkpoint',l.evidence_id FROM evidence_checkpoint_links l JOIN evidence e ON e.id=l.evidence_id JOIN updates u ON u.id=l.checkpoint_id WHERE e.project_id<>u.project_id OR u.kind<>'checkpoint'
          UNION ALL SELECT 'evidence_artifact',l.evidence_id FROM evidence_artifact_links l JOIN evidence e ON e.id=l.evidence_id JOIN artifact_references a ON a.id=l.artifact_id WHERE a.run_id IS NOT e.run_id
          UNION ALL SELECT 'evidence_override',e.id FROM evidence e LEFT JOIN evidence_overrides o ON o.evidence_id=e.id WHERE (e.validation_status='overridden')<>(o.evidence_id IS NOT NULL)
          UNION ALL SELECT 'checkpoint_snapshot',s.id FROM checkpoint_snapshots s JOIN updates u ON u.id=s.checkpoint_id WHERE u.kind<>'checkpoint' OR s.schema_version<>3
        )
      `).all()
      const orphanArtifacts = temp.prepare(`SELECT a.id FROM artifact_references a LEFT JOIN evidence_artifact_links l ON l.artifact_id=a.id WHERE a.run_id IS NULL GROUP BY a.id HAVING COUNT(l.evidence_id)=0`).all()
      const invalidRuns = (temp.prepare('SELECT * FROM runs').all() as SqlRow[]).flatMap((run) => {
        const summary = temp.prepare('SELECT passed,failed,skipped,target_count FROM test_summaries WHERE run_id=?').get(String(run.id)) as SqlRow | undefined
        const violations = validateRunInvariants({
          startedAt: String(run.started_at), endedAt: textOrNull(run.ended_at), outcome: String(run.outcome) as 'recorded' | 'verified' | 'failed' | 'interrupted',
          exitCode: run.exit_code === null ? null : Number(run.exit_code),
          testSummary: summary ? { passed: Number(summary.passed), failed: Number(summary.failed), skipped: Number(summary.skipped), targetCount: Number(summary.target_count) } : null,
        })
        return violations.length ? [{ runId: String(run.id), violations }] : []
      })
      const invalidEvidence = (temp.prepare('SELECT * FROM evidence').all() as SqlRow[]).flatMap((evidence) => {
        const run = evidence.run_id ? temp.prepare('SELECT * FROM runs WHERE id=?').get(String(evidence.run_id)) as SqlRow | undefined : undefined
        const override = temp.prepare('SELECT reason FROM evidence_overrides WHERE evidence_id=?').get(String(evidence.id)) as SqlRow | undefined
        const violations = validateEvidenceInvariants({ result: String(evidence.result) as 'recorded' | 'verified' | 'failed' | 'interrupted', runId: textOrNull(evidence.run_id) }, {
          linkedRun: run ? { id: String(run.id), outcome: String(run.outcome) as 'recorded' | 'verified' | 'failed' | 'interrupted', invariantsValid: String(run.validation_status) === 'validated' } : null,
          verifiedOverride: override ? { reason: String(override.reason) } : null,
        })
        return violations.length ? [{ evidenceId: String(evidence.id), violations }] : []
      })
      const redactors = new Map<string, SecretRedactor>()
      const redactorFor = (projectId: string | null): SecretRedactor => {
        const cacheKey = projectId ?? '__global__'
        const existing = redactors.get(cacheKey)
        if (existing) return existing
        const secretNames = projectId ? (temp.prepare('SELECT name FROM project_secret_names WHERE project_id=?').all(projectId) as SqlRow[]).map((row) => String(row.name)) : []
        const redactor = new SecretRedactor({ secretNames })
        redactors.set(cacheKey, redactor)
        return redactor
      }
      const invalidRedactions: Array<{ entityType: string; entityId: string; field: string }> = []
      for (const run of temp.prepare('SELECT * FROM runs').all() as SqlRow[]) {
        const redactor = redactorFor(String(run.project_id))
        const fields: Record<string, unknown> = {
          command: run.command,
          working_directory: run.working_directory,
          stdout_excerpt: run.stdout_excerpt,
          stderr_excerpt: run.stderr_excerpt,
          ...Object.fromEntries(Object.entries(parseJson<Record<string, unknown>>(run.toolchain_json, {})).map(([name, value]) => [`toolchain.${name}`, value])),
        }
        for (const [field, value] of Object.entries(fields)) if (typeof value === 'string' && redactor.redact(value).redacted) invalidRedactions.push({ entityType: 'run', entityId: String(run.id), field })
      }
      for (const evidence of temp.prepare('SELECT id,project_id,summary FROM evidence').all() as SqlRow[]) {
        if (redactorFor(String(evidence.project_id)).redact(String(evidence.summary)).redacted) invalidRedactions.push({ entityType: 'evidence', entityId: String(evidence.id), field: 'summary' })
      }
      for (const artifact of temp.prepare(`SELECT a.id,a.uri,COALESCE(r.project_id,e.project_id) AS project_id
        FROM artifact_references a
        LEFT JOIN runs r ON r.id=a.run_id
        LEFT JOIN evidence_artifact_links l ON l.artifact_id=a.id
        LEFT JOIN evidence e ON e.id=l.evidence_id`).all() as SqlRow[]) {
        if (artifact.project_id && redactorFor(String(artifact.project_id)).redact(String(artifact.uri)).redacted) invalidRedactions.push({ entityType: 'artifact', entityId: String(artifact.id), field: 'uri' })
      }
      const invalidErrorReports: Array<{ reportId: string; reason: string }> = []
      for (const report of temp.prepare('SELECT * FROM error_reports').all() as SqlRow[]) {
        const reproductionSteps = parseJson<unknown>(report.reproduction_steps_json, null)
        const creation = CreateErrorReportSchema.safeParse({
          kind: report.kind, component: report.component, summary: report.summary, observation: report.observation,
          expectedBehaviour: report.expected_behaviour, actualBehaviour: report.actual_behaviour, reproductionSteps,
          impact: report.impact, projectId: report.project_id, workspacePath: report.workspace_path,
        })
        const triage = UpdateErrorReportSchema.safeParse({ expectedVersion: report.version, status: report.status, triageNote: report.triage_note })
        if (!creation.success || !triage.success) {
          invalidErrorReports.push({ reportId: String(report.id), reason: 'error report does not satisfy its input constraints' })
          continue
        }
        const validatedReproductionSteps = creation.data.reproductionSteps ?? []
        const redactor = redactorFor(textOrNull(report.project_id))
        const fields: Record<string, unknown> = {
          component: report.component, summary: report.summary, observation: report.observation,
          expected_behaviour: report.expected_behaviour, actual_behaviour: report.actual_behaviour,
          reproduction_steps: validatedReproductionSteps.join('\n'), impact: report.impact,
          workspace_path: report.workspace_path, triage_note: report.triage_note,
        }
        for (const [field, value] of Object.entries(fields)) if (typeof value === 'string' && redactor.redact(value).redacted) invalidRedactions.push({ entityType: 'error_report', entityId: String(report.id), field })
      }
      const invalidStructuredSnapshots = (temp.prepare(`SELECT s.id,s.document_json,s.digest,u.project_id
        FROM checkpoint_snapshots s JOIN updates u ON u.id=s.checkpoint_id`).all() as SqlRow[]).flatMap((snapshot) => {
        const document = parseJson<unknown>(snapshot.document_json, null)
        if (!document || typeof document !== 'object' || Array.isArray(document)) return [{ snapshotId: String(snapshot.id), reason: 'structured snapshot document must be an object' }]
        const structured = document as Record<string, unknown>
        const snapshotProject = structured.project
        if (!snapshotProject || typeof snapshotProject !== 'object' || Array.isArray(snapshotProject) || String((snapshotProject as Record<string, unknown>).id) !== String(snapshot.project_id)) {
          return [{ snapshotId: String(snapshot.id), reason: 'structured snapshot project does not match its checkpoint' }]
        }
        const requiredArrays = [
          'phases', 'requirementStates', 'requirements', 'workItems', 'queues', 'relations', 'blockers', 'workspaces',
          'workspaceRevisions', 'runs', 'testSummaries', 'evidence', 'updates', 'updateRevisions', 'labels', 'projectSecretNames', 'evidenceHeads',
        ]
        if (requiredArrays.some((section) => !Array.isArray(structured[section]))) return [{ snapshotId: String(snapshot.id), reason: 'structured snapshot is missing a required v3 section' }]
        const links = structured.links
        const requiredLinkSections = ['requirementAliases', 'requirementPhases', 'requirementWork', 'workPhases']
        if (!links || typeof links !== 'object' || Array.isArray(links) || requiredLinkSections.some((section) => !Array.isArray((links as Record<string, unknown>)[section]))) {
          return [{ snapshotId: String(snapshot.id), reason: 'structured snapshot is missing required v3 ownership links' }]
        }
        const projectId = String(snapshot.project_id)
        const projectScopedSections: Array<[string, string]> = [
          ['phases', 'project_id'], ['requirementStates', 'projectId'], ['requirements', 'projectId'], ['workItems', 'projectId'],
          ['queues', 'projectId'], ['relations', 'projectId'], ['blockers', 'projectId'], ['workspaces', 'project_id'],
          ['runs', 'projectId'], ['evidence', 'projectId'], ['updates', 'project_id'],
        ]
        const containsForeignProject = projectScopedSections.some(([section, projectField]) => (structured[section] as unknown[]).some((entry) => (
          !entry || typeof entry !== 'object' || Array.isArray(entry) || String((entry as Record<string, unknown>)[projectField]) !== projectId
        )))
        if (containsForeignProject) return [{ snapshotId: String(snapshot.id), reason: 'structured snapshot contains data owned by another project' }]
        const ids = (section: string, field: string) => new Set((structured[section] as Array<Record<string, unknown>>).map((entry) => String(entry[field])))
        const workspaceIds = ids('workspaces', 'id')
        const workspaceRevisionIds = ids('workspaceRevisions', 'id')
        const phaseIds = ids('phases', 'id')
        const requirementStateIds = ids('requirementStates', 'id')
        const requirementIds = ids('requirements', 'id')
        const workItemIds = ids('workItems', 'id')
        const queueIds = ids('queues', 'id')
        const runIds = ids('runs', 'id')
        const evidenceIds = ids('evidence', 'id')
        const updateIds = ids('updates', 'id')
        const updateRevisionIds = ids('updateRevisions', 'id')
        const labelIds = ids('labels', 'id')
        if ((structured.workspaceRevisions as Array<Record<string, unknown>>).some((entry) => !workspaceIds.has(String(entry.workspace_id)))
          || (structured.testSummaries as Array<Record<string, unknown>>).some((entry) => !runIds.has(String(entry.run_id)))
          || (structured.updateRevisions as Array<Record<string, unknown>>).some((entry) => !updateIds.has(String(entry.update_id)))
          || (structured.evidenceHeads as Array<Record<string, unknown>>).some((entry) => !evidenceIds.has(String(entry.id)))) {
          return [{ snapshotId: String(snapshot.id), reason: 'structured snapshot contains an invalid nested ownership link' }]
        }
        const criteriaOwned = (structured.requirements as Array<Record<string, unknown>>).every((requirement) => Array.isArray(requirement.criteria)
          && (requirement.criteria as Array<Record<string, unknown>>).every((criterion) => String(criterion.requirementId) === String(requirement.id)))
        if (!criteriaOwned || !(structured.projectSecretNames as unknown[]).every((name) => typeof name === 'string')) {
          return [{ snapshotId: String(snapshot.id), reason: 'structured snapshot contains invalid criterion or redaction ownership data' }]
        }
        const criterionIds = new Set((structured.requirements as Array<Record<string, unknown>>).flatMap((requirement) => (requirement.criteria as Array<Record<string, unknown>>).map((criterion) => String(criterion.id))))
        const belongsOrNull = (set: Set<string>, value: unknown) => value === null || value === undefined || set.has(String(value))
        const nestedOwnershipInvalid = (structured.requirements as Array<Record<string, unknown>>).some((requirement) => !belongsOrNull(requirementIds, requirement.parentId)
            || !requirementStateIds.has(String(requirement.stateId))
            || !belongsOrNull(phaseIds, requirement.responsiblePhaseId)
            || !Array.isArray(requirement.relatedPhaseIds) || (requirement.relatedPhaseIds as unknown[]).some((id) => !phaseIds.has(String(id)))
            || !Array.isArray(requirement.linkedWorkItemIds) || (requirement.linkedWorkItemIds as unknown[]).some((id) => !workItemIds.has(String(id)))
            || !Array.isArray(requirement.linkedEvidenceIds) || (requirement.linkedEvidenceIds as unknown[]).some((id) => !evidenceIds.has(String(id)))
            || (requirement.criteria as Array<Record<string, unknown>>).some((criterion) => !belongsOrNull(evidenceIds, criterion.proofEvidenceId)))
          || (structured.workItems as Array<Record<string, unknown>>).some((item) => !belongsOrNull(phaseIds, item.phaseId)
            || !belongsOrNull(workItemIds, item.parentId) || !belongsOrNull(queueIds, item.queueId)
            || !Array.isArray(item.labels) || (item.labels as Array<Record<string, unknown>>).some((label) => !labelIds.has(String(label.id))))
          || (structured.relations as Array<Record<string, unknown>>).some((relation) => !workItemIds.has(String(relation.fromWorkItemId)) || !workItemIds.has(String(relation.toWorkItemId)))
          || (structured.blockers as Array<Record<string, unknown>>).some((blocker) => !belongsOrNull(workItemIds, blocker.workItemId))
          || (structured.runs as Array<Record<string, unknown>>).some((run) => !belongsOrNull(workspaceRevisionIds, run.workspaceRevisionId)
            || !Array.isArray(run.artifacts) || (run.artifacts as Array<Record<string, unknown>>).some((artifact) => String(artifact.runId) !== String(run.id)))
          || (structured.evidence as Array<Record<string, unknown>>).some((evidence) => !belongsOrNull(runIds, evidence.runId)
            || !Array.isArray(evidence.requirementIds) || (evidence.requirementIds as unknown[]).some((id) => !requirementIds.has(String(id)))
            || !Array.isArray(evidence.workItemIds) || (evidence.workItemIds as unknown[]).some((id) => !workItemIds.has(String(id)))
            || !Array.isArray(evidence.updateIds) || (evidence.updateIds as unknown[]).some((id) => !updateIds.has(String(id)))
            || !Array.isArray(evidence.checkpointIds) || (evidence.checkpointIds as unknown[]).some((id) => !updateIds.has(String(id)))
            || !Array.isArray(evidence.criterionLinks) || (evidence.criterionLinks as Array<Record<string, unknown>>).some((link) => !criterionIds.has(String(link.criterionId)))
            || !Array.isArray(evidence.artifacts) || (evidence.artifacts as Array<Record<string, unknown>>).some((artifact) => String(artifact.runId ?? '') !== String(evidence.runId ?? '')))
          || (structured.updates as Array<Record<string, unknown>>).some((update) => !updateRevisionIds.has(String(update.current_revision_id)))
          || (structured.workspaces as Array<Record<string, unknown>>).some((workspace) => !Array.isArray(workspace.aliases) || (workspace.aliases as unknown[]).some((alias) => typeof alias !== 'string'))
          || !belongsOrNull(updateIds, (snapshotProject as Record<string, unknown>).current_checkpoint_id)
        const ownershipLinks = links as Record<string, Array<Record<string, unknown>>>
        const rawOwnershipInvalid = ownershipLinks.requirementAliases!.some((link) => !requirementIds.has(String(link.requirement_id)))
          || ownershipLinks.requirementPhases!.some((link) => !requirementIds.has(String(link.requirement_id)) || !phaseIds.has(String(link.phase_id)))
          || ownershipLinks.requirementWork!.some((link) => !requirementIds.has(String(link.requirement_id)) || !workItemIds.has(String(link.work_item_id)))
          || ownershipLinks.workPhases!.some((link) => !workItemIds.has(String(link.work_item_id)) || !phaseIds.has(String(link.phase_id)))
        if (nestedOwnershipInvalid || rawOwnershipInvalid) return [{ snapshotId: String(snapshot.id), reason: 'structured snapshot contains a cross-project nested reference' }]
        const digest = createHash('sha256').update(canonicalJson(document)).digest('hex')
        return digest === String(snapshot.digest) ? [] : [{ snapshotId: String(snapshot.id), reason: 'structured snapshot digest does not match its document' }]
      })
      const invalidSnapshots: Array<{ updateId: string; reason: string }> = []
      const snapshots = temp.prepare(`SELECT u.id,u.project_id,r.snapshot_json FROM updates u JOIN update_revisions r ON r.update_id=u.id WHERE u.kind='checkpoint'`).all() as SqlRow[]
      for (const row of snapshots) {
        const parsed = PulseSnapshotSchema.safeParse(parseJson(row.snapshot_json, null))
        if (!parsed.success) { invalidSnapshots.push({ updateId: String(row.id), reason: 'invalid snapshot shape' }); continue }
        const phaseIds = parsed.data.activePhaseIds
        const workItemIds = parsed.data.unresolvedWorkItemIds
        const phaseCount = phaseIds.length ? Number((temp.prepare(`SELECT COUNT(*) AS count FROM phases WHERE project_id=? AND id IN (${phaseIds.map(() => '?').join(',')})`).get(String(row.project_id), ...phaseIds) as SqlRow).count) : 0
        const workItemCount = workItemIds.length ? Number((temp.prepare(`SELECT COUNT(*) AS count FROM work_items WHERE project_id=? AND id IN (${workItemIds.map(() => '?').join(',')})`).get(String(row.project_id), ...workItemIds) as SqlRow).count) : 0
        if (phaseCount !== new Set(phaseIds).size || workItemCount !== new Set(workItemIds).size) invalidSnapshots.push({ updateId: String(row.id), reason: 'snapshot references an entity outside the project' })
      }
      if (integrity.integrity_check !== 'ok' || foreignKeys.length || invalidCheckpoints.length || invalidCurrentRevisions.length || invalidPhaseProjects.length || invalidOperationalProjects.length || invalidSnapshots.length || invalidStructuredSnapshots.length || orphanArtifacts.length || invalidRuns.length || invalidEvidence.length || invalidErrorReports.length || invalidRedactions.length) {
        throw new ValidationError('Import failed database integrity checks', { integrity, foreignKeys, invalidCheckpoints, invalidCurrentRevisions, invalidPhaseProjects, invalidOperationalProjects, invalidSnapshots, invalidStructuredSnapshots, orphanArtifacts, invalidRuns, invalidEvidence, invalidErrorReports, invalidRedactions })
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error
      throw new ValidationError('Import contains invalid relational data', { cause: error instanceof Error ? error.message : String(error) })
    } finally {
      if (temp.isTransaction) temp.exec('ROLLBACK')
      temp.close()
    }
  }

  importAll(bundle: ExportBundle): void {
    this.transaction(() => {
      this.db.exec('PRAGMA defer_foreign_keys=ON')
      this.db.prepare('UPDATE projects SET current_checkpoint_id=NULL').run()
      for (const table of Object.keys(exportTables).reverse()) this.db.prepare(`DELETE FROM ${table}`).run()
      this.db.prepare('DELETE FROM search_index').run()
      this.loadTables(this.db, bundle)
      for (const row of this.db.prepare('SELECT id FROM projects').all() as SqlRow[]) {
        const projectId = String(row.id)
        this.seedOperationalDefaults(projectId)
      }
      this.rebuildSearch()
    })
  }

  private loadTables(db: DatabaseSync, bundle: ExportBundle): void {
    for (const [table, columns] of Object.entries(exportTables)) {
      const rows = bundle.tables[table]
      if (!Array.isArray(rows)) {
        if (bundle.formatVersion === 3 && table === 'error_reports') continue
        if (bundle.formatVersion < 5 && ['work_queue_automation_policies','work_leases','automation_attempts','automation_queue_changes','automation_attempt_observations'].includes(table)) continue
        throw new ValidationError(`Import is missing table ${table}`)
      }
      const statement = db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      for (const row of rows) statement.run(...columns.map((column) => {
        const key = column.replaceAll('"', '')
        return row[key] == null ? null : row[key] as never
      }))
    }
  }

  private rebuildSearch(): void {
    for (const row of this.db.prepare('SELECT * FROM projects').all() as SqlRow[]) this.replaceSearch('project', String(row.id), String(row.id), String(row.title), [row.description,row.intent,row.completion_criteria].filter(Boolean).join('\n'))
    for (const row of this.db.prepare('SELECT * FROM phases').all() as SqlRow[]) this.replaceSearch('phase', String(row.id), String(row.project_id), String(row.name), textOrNull(row.description) ?? '')
    for (const row of this.db.prepare('SELECT * FROM work_items').all() as SqlRow[]) this.replaceSearch('work_item', String(row.id), String(row.project_id), String(row.title), textOrNull(row.description) ?? '')
    const updateRows = this.db.prepare(`SELECT u.id,u.project_id,u.kind,r.content FROM updates u JOIN update_revisions r ON r.id=u.current_revision_id WHERE u.deleted_at IS NULL`).all() as SqlRow[]
    for (const row of updateRows) this.replaceSearch('update', String(row.id), String(row.project_id), String(row.kind), String(row.content))
  }
}
