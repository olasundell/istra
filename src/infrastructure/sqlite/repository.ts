import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ConflictError, NotFoundError, ValidationError } from '../../application/errors.js'
import type { ExportBundle, IstraRepository } from '../../application/ports.js'
import { PulseSnapshotSchema } from '../../domain/contracts.js'
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
  SearchResult,
  UpdatePhaseInput,
  UpdateProjectInput,
  UpdateRevision,
  UpdateWorkItemInput,
  WorkItem,
} from '../../domain/contracts.js'
import { migrations } from './migrations.js'

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

const exportTables: Record<string, string[]> = {
  projects: ['id','title','description','intent','deadline','completion_criteria','state','current_focus','next_action','blockers_json','current_checkpoint_id','archived_at','version','created_at','updated_at','last_activity_at'],
  phases: ['id','project_id','name','description','status','position','archived_at','version','created_at','updated_at'],
  work_items: ['id','project_id','phase_id','kind','title','description','status','priority','version','created_at','updated_at'],
  labels: ['id','name','colour','version','created_at','updated_at'],
  work_item_labels: ['work_item_id','label_id','created_at'],
  updates: ['id','project_id','kind','current_revision_id','deleted_at','version','created_at','updated_at'],
  update_revisions: ['id','update_id','revision','content','snapshot_json','source','client','created_at'],
  activity_events: ['id','project_id','entity_type','entity_id','event_type','payload_json','source','client','created_at'],
}

export class SqliteIstraRepository implements IstraRepository {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private event(projectId: string, entityType: string, entityId: string, eventType: string, payload: Record<string, unknown>, provenance: Provenance): void {
    this.db.prepare(`INSERT INTO activity_events(id,project_id,entity_type,entity_id,event_type,payload_json,source,client,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), projectId, entityType, entityId, eventType, JSON.stringify(payload), provenance.source, provenance.client ?? null, now())
    this.db.prepare('UPDATE projects SET last_activity_at=? WHERE id=?').run(now(), projectId)
  }

  private replaceSearch(type: SearchResult['type'], id: string, projectId: string, title: string, body: string): void {
    this.db.prepare('DELETE FROM search_index WHERE entity_type=? AND entity_id=?').run(type, id)
    this.db.prepare('INSERT INTO search_index(entity_type,entity_id,project_id,title,body) VALUES (?,?,?,?,?)').run(type, id, projectId, title, body)
  }

  private workItemFromRow(row: SqlRow): WorkItem {
    const labels = this.db.prepare(`SELECT l.* FROM labels l JOIN work_item_labels wil ON wil.label_id=l.id WHERE wil.work_item_id=? ORDER BY l.name COLLATE NOCASE`).all(String(row.id)) as SqlRow[]
    return {
      id: String(row.id), projectId: String(row.project_id), phaseId: textOrNull(row.phase_id), kind: String(row.kind) as WorkItem['kind'],
      title: String(row.title), description: textOrNull(row.description), status: String(row.status) as WorkItem['status'], priority: textOrNull(row.priority) as WorkItem['priority'],
      labels: labels.map(labelFromRow), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
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

  createWorkItem(projectId: string, input: CreateWorkItemInput, provenance: Provenance): WorkItem {
    if (!this.getProject(projectId)) throw new NotFoundError('Project', projectId)
    if (input.phaseId) this.assertPhaseInProject(input.phaseId, projectId)
    const id = randomUUID(); const timestamp = now(); const labelIds = [...new Set(input.labelIds ?? [])]
    return this.transaction(() => {
      this.db.prepare('INSERT INTO work_items(id,project_id,phase_id,kind,title,description,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId, input.phaseId ?? null, input.kind, input.title, input.description ?? null, input.status, input.priority ?? null, timestamp, timestamp)
      for (const labelId of labelIds) this.insertWorkItemLabel(id, labelId)
      this.replaceSearch('work_item', id, projectId, input.title, input.description ?? '')
      this.event(projectId, 'work_item', id, 'work_item.created', { title: input.title, kind: input.kind, status: input.status, phaseId: input.phaseId ?? null, labelIds }, provenance)
      for (const labelId of labelIds) this.event(projectId, 'work_item', id, 'work_item.label_attached', { labelId }, provenance)
      return this.workItemFromRow(this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id) as SqlRow)
    })
  }

  updateWorkItem(id: string, input: UpdateWorkItemInput, provenance: Provenance): WorkItem {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id) as SqlRow | undefined; if (!row) throw new NotFoundError('Work item', id)
    const current = this.workItemFromRow(row); if (input.phaseId) this.assertPhaseInProject(input.phaseId, current.projectId)
    const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([k,v]) => !['expectedVersion','labelIds'].includes(k) && v !== undefined)) }
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE work_items SET phase_id=?,kind=?,title=?,description=?,status=?,priority=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(next.phaseId, next.kind, next.title, next.description, next.status, next.priority, now(), id, input.expectedVersion)
      if (Number(result.changes) === 0) throw new ConflictError('Work item', id)
      const previousLabelIds = current.labels.map((label) => label.id)
      if (input.labelIds) { this.db.prepare('DELETE FROM work_item_labels WHERE work_item_id=?').run(id); for (const labelId of new Set(input.labelIds)) this.insertWorkItemLabel(id, labelId) }
      this.replaceSearch('work_item', id, current.projectId, next.title, next.description ?? '')
      const updated = this.workItemFromRow(this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id) as SqlRow)
      const currentEventState = { ...current, labelIds: previousLabelIds } as unknown as Record<string, unknown>
      const updatedEventState = { ...updated, labelIds: updated.labels.map((label) => label.id) } as unknown as Record<string, unknown>
      const changes = beforeAfter(currentEventState, updatedEventState, ['title','description','kind','status','priority','phaseId','labelIds'])
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

  private insertWorkItemLabel(workItemId: string, labelId: string): void {
    if (!this.db.prepare('SELECT 1 FROM labels WHERE id=?').get(labelId)) throw new NotFoundError('Label', labelId)
    this.db.prepare('INSERT OR IGNORE INTO work_item_labels(work_item_id,label_id,created_at) VALUES (?,?,?)').run(workItemId, labelId, now())
  }

  listUpdates(projectId: string, includeDeleted = false): ProjectUpdate[] {
    return (this.db.prepare(`SELECT * FROM updates WHERE project_id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at DESC`).all(projectId) as SqlRow[]).map((row) => this.updateFromRow(row))
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
    try {
      this.db.prepare('INSERT INTO labels(id,name,colour,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, input.name, input.colour ?? null, timestamp, timestamp)
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) throw new ValidationError(`A label named “${input.name}” already exists`)
      throw error
    }
    return labelFromRow(this.db.prepare('SELECT * FROM labels WHERE id=?').get(id) as SqlRow)
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
    return (this.db.prepare('SELECT * FROM activity_events WHERE project_id=? ORDER BY created_at DESC LIMIT ?').all(projectId, Math.min(Math.max(limit, 1), 1000)) as SqlRow[]).map((row) => ({
      id: String(row.id), projectId: String(row.project_id), entityType: String(row.entity_type), entityId: String(row.entity_id), eventType: String(row.event_type),
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}), source: String(row.source), client: textOrNull(row.client), createdAt: String(row.created_at),
    }))
  }

  listRecentActivity(limit = 50): DashboardActivityEvent[] {
    const rows = this.db.prepare(`SELECT ae.*,p.title AS project_title FROM activity_events ae JOIN projects p ON p.id=ae.project_id WHERE p.archived_at IS NULL ORDER BY ae.created_at DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 200)) as SqlRow[]
    return rows.map((row) => ({
      id: String(row.id), projectId: String(row.project_id), projectTitle: String(row.project_title), entityType: String(row.entity_type), entityId: String(row.entity_id), eventType: String(row.event_type),
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}), source: String(row.source), client: textOrNull(row.client), createdAt: String(row.created_at),
    }))
  }

  search(query: string, limit = 50): SearchResult[] {
    const terms = query.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`).join(' ')
    if (!terms) return []
    const rows = this.db.prepare(`SELECT entity_type,entity_id,project_id,title,snippet(search_index,4,'','',' … ',24) AS excerpt,bm25(search_index,5.0,1.0) AS score FROM search_index WHERE search_index MATCH ? ORDER BY score LIMIT ?`).all(terms, Math.min(Math.max(limit, 1), 200)) as SqlRow[]
    return rows.map((row) => ({ type: String(row.entity_type) as SearchResult['type'], id: String(row.entity_id), projectId: String(row.project_id), title: String(row.title), excerpt: String(row.excerpt), score: Number(row.score) }))
  }

  exportAll(): ExportBundle {
    const tables: ExportBundle['tables'] = {}
    for (const [table, columns] of Object.entries(exportTables)) tables[table] = this.db.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() as Array<Record<string, unknown>>
    return { format: 'istra-export', formatVersion: 1, exportedAt: now(), tables }
  }

  validateImport(bundle: ExportBundle): void {
    const temp = new DatabaseSync(':memory:')
    try {
      temp.exec('PRAGMA foreign_keys=ON;')
      temp.exec(migrations[0]!.sql)
      this.loadTables(temp, bundle)
      const integrity = temp.prepare('PRAGMA integrity_check').get() as SqlRow
      const foreignKeys = temp.prepare('PRAGMA foreign_key_check').all()
      const invalidCheckpoints = temp.prepare(`SELECT p.id,p.current_checkpoint_id FROM projects p LEFT JOIN updates u ON u.id=p.current_checkpoint_id WHERE p.current_checkpoint_id IS NOT NULL AND (u.id IS NULL OR u.project_id<>p.id OR u.kind<>'checkpoint' OR u.deleted_at IS NOT NULL)`).all()
      const invalidCurrentRevisions = temp.prepare(`SELECT u.id,u.current_revision_id FROM updates u LEFT JOIN update_revisions r ON r.id=u.current_revision_id WHERE r.id IS NULL OR r.update_id<>u.id`).all()
      const invalidPhaseProjects = temp.prepare(`SELECT wi.id,wi.phase_id FROM work_items wi JOIN phases p ON p.id=wi.phase_id WHERE wi.project_id<>p.project_id`).all()
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
      if (integrity.integrity_check !== 'ok' || foreignKeys.length || invalidCheckpoints.length || invalidCurrentRevisions.length || invalidPhaseProjects.length || invalidSnapshots.length) {
        throw new ValidationError('Import failed database integrity checks', { integrity, foreignKeys, invalidCheckpoints, invalidCurrentRevisions, invalidPhaseProjects, invalidSnapshots })
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error
      throw new ValidationError('Import contains invalid relational data', { cause: error instanceof Error ? error.message : String(error) })
    } finally { temp.close() }
  }

  importAll(bundle: ExportBundle): void {
    this.transaction(() => {
      this.db.prepare('UPDATE projects SET current_checkpoint_id=NULL').run()
      for (const table of Object.keys(exportTables).reverse()) this.db.prepare(`DELETE FROM ${table}`).run()
      this.db.prepare('DELETE FROM search_index').run()
      this.loadTables(this.db, bundle)
      this.rebuildSearch()
    })
  }

  private loadTables(db: DatabaseSync, bundle: ExportBundle): void {
    for (const [table, columns] of Object.entries(exportTables)) {
      const rows = bundle.tables[table]
      if (!Array.isArray(rows)) throw new ValidationError(`Import is missing table ${table}`)
      const statement = db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      for (const row of rows) statement.run(...columns.map((column) => row[column] == null ? null : row[column] as never))
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
