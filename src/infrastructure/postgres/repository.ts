import { randomUUID } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { ConflictError, NotFoundError, UnsupportedOperationError, ValidationError } from '../../application/errors.js'
import { decodeCursor, encodeCursor, pageOf } from '../../application/pagination.js'
import type { ExportBundle, IstraRepository } from '../../application/ports.js'
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
  Page,
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
} from '../../domain/contracts.js'
import { canonicalJson } from '../../domain/canonical-json.js'
import { deterministicRows, exportTables, isJsonExportColumn } from '../export-format.js'
import type { PostgresExecutor } from './database.js'
import { lockProjectGraph } from './project-graph-lock.js'

type SqlRow = QueryResultRow & Record<string, unknown>

const now = () => new Date().toISOString()
const textOrNull = (value: unknown): string | null => value == null ? null : String(value)
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value)

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value as T
  try { return JSON.parse(value) as T } catch { return fallback }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505')
}

function beforeAfter<T extends Record<string, unknown>>(before: T, after: T, keys: string[]): Record<string, { before: unknown; after: unknown }> {
  return Object.fromEntries(keys
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => [key, { before: before[key], after: after[key] }]))
}

function projectFromRow(row: SqlRow): Project {
  return {
    id: String(row.id),
    title: String(row.title),
    description: textOrNull(row.description),
    intent: textOrNull(row.intent),
    deadline: row.deadline == null ? null : iso(row.deadline),
    completionCriteria: textOrNull(row.completion_criteria),
    state: String(row.state) as Project['state'],
    currentFocus: textOrNull(row.current_focus),
    nextAction: textOrNull(row.next_action),
    blockers: json<string[]>(row.blockers_json, []),
    currentCheckpointId: textOrNull(row.current_checkpoint_id),
    archivedAt: row.archived_at == null ? null : iso(row.archived_at),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastActivityAt: iso(row.last_activity_at),
  }
}

function phaseFromRow(row: SqlRow): Phase {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: textOrNull(row.description),
    status: String(row.status) as Phase['status'],
    position: Number(row.position),
    archivedAt: row.archived_at == null ? null : iso(row.archived_at),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function labelFromRow(row: SqlRow): Label {
  return {
    id: String(row.id),
    name: String(row.name),
    colour: textOrNull(row.colour),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function revisionFromRow(row: SqlRow): UpdateRevision {
  return {
    id: String(row.id),
    updateId: String(row.update_id),
    revision: Number(row.revision),
    content: String(row.content),
    snapshot: json<PulseSnapshot | null>(row.snapshot_json, null),
    source: String(row.source),
    client: textOrNull(row.client),
    createdAt: iso(row.created_at),
  }
}

function activityFromRow(row: SqlRow): ActivityEvent {
  return {
    id: String(row.id),
    projectId: textOrNull(row.project_id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    eventType: String(row.event_type),
    payload: json<Record<string, unknown>>(row.payload_json, {}),
    source: String(row.source),
    client: textOrNull(row.client),
    actor: String(row.actor),
    idempotencyKey: textOrNull(row.idempotency_key),
    createdAt: iso(row.created_at),
  }
}

const booleanColumns = new Set([
  'acceptance_criteria.required',
  'workspace_revisions.dirty',
  'runs.stdout_truncated',
  'runs.stderr_truncated',
  'evidence.stale',
])

function parentFirst(table: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const parentColumn = table === 'work_items' || table === 'requirements' ? 'parent_id' : null
  if (!parentColumn) return rows
  const pending = new Map(rows.map((row) => [String(row.id), row]))
  const ordered: Array<Record<string, unknown>> = []
  while (pending.size) {
    let progressed = false
    for (const [id, row] of pending) {
      const parentId = row[parentColumn]
      if (parentId != null && pending.has(String(parentId))) continue
      ordered.push(row)
      pending.delete(id)
      progressed = true
    }
    if (!progressed) throw new ValidationError(`Migration bundle contains a ${table} parent cycle`)
  }
  return ordered
}

export class PostgresIstraRepository implements IstraRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  private async transaction<T>(work: () => Promise<T>): Promise<T> {
    return this.executor.transaction(async () => work())
  }

  private async seedOperationalDefaults(projectId: string, timestamp = now()): Promise<void> {
    const defaults = [
      ['Missing', 'open', 0, '#7A8594'],
      ['Partial', 'partial', 1, '#C18401'],
      ['Proven', 'proven', 2, '#2D7A4B'],
      ['Defect', 'defect', 3, '#B64D3A'],
    ] as const
    for (const [name, semantic, position, colour] of defaults) {
      await this.executor.execute(`
        INSERT INTO requirement_states(id,project_id,name,semantic,position,colour,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
        ON CONFLICT DO NOTHING
      `, [randomUUID(), projectId, name, semantic, position, colour, timestamp])
    }
    const existing = await this.executor.maybeOne('SELECT id FROM work_queues WHERE project_id=$1 ORDER BY created_at,id LIMIT 1', [projectId])
    if (!existing) {
      await this.executor.execute(`
        INSERT INTO work_queues(id,project_id,name,description,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$5)
        ON CONFLICT DO NOTHING
      `, [randomUUID(), projectId, 'Main queue', 'Default ordered work queue', timestamp])
    }
  }

  private async event(projectId: string | null, entityType: string, entityId: string, eventType: string, payload: Record<string, unknown>, provenance: Provenance): Promise<void> {
    const occurredAt = provenance.occurredAt ?? now()
    await this.executor.execute(`
      INSERT INTO activity_events(id,project_id,entity_type,entity_id,event_type,payload_json,source,client,actor,idempotency_key,created_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
    `, [randomUUID(), projectId, entityType, entityId, eventType, JSON.stringify(payload), provenance.source, provenance.client ?? null, provenance.actor ?? provenance.client ?? provenance.source, provenance.idempotencyKey ?? null, occurredAt])
    if (projectId) await this.executor.execute('UPDATE projects SET last_activity_at=$1 WHERE id=$2', [occurredAt, projectId])
  }

  private async replaceSearch(type: SearchResult['type'], id: string, projectId: string, title: string, body: string): Promise<void> {
    await this.executor.execute(`
      INSERT INTO search_index(entity_type,entity_id,project_id,title,body)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(entity_type,entity_id)
      DO UPDATE SET project_id=EXCLUDED.project_id,title=EXCLUDED.title,body=EXCLUDED.body
    `, [type, id, projectId, title, body])
  }

  private async workItemFromRow(row: SqlRow): Promise<WorkItem> {
    const id = String(row.id)
    const [labels, queue, dependencies, externalBlockers] = await Promise.all([
      this.executor.many<SqlRow>(`SELECT l.* FROM labels l JOIN work_item_labels wil ON wil.label_id=l.id WHERE wil.work_item_id=$1 ORDER BY lower(l.name),l.id`, [id]),
      row.queue_id === undefined
        ? this.executor.maybeOne<SqlRow>('SELECT queue_id,rank FROM work_queue_items WHERE work_item_id=$1 ORDER BY rank,queue_id LIMIT 1', [id])
        : Promise.resolve(row),
      this.executor.many<SqlRow>(`
        SELECT wi.title,wr.kind FROM work_relations wr
        JOIN work_items wi ON ((wr.kind='depends_on' AND wi.id=wr.to_work_item_id) OR (wr.kind='blocks' AND wi.id=wr.from_work_item_id))
        WHERE ((wr.kind='depends_on' AND wr.from_work_item_id=$1) OR (wr.kind='blocks' AND wr.to_work_item_id=$1))
          AND wi.status NOT IN ('resolved','dropped')
      `, [id]),
      this.executor.many<SqlRow>('SELECT content FROM external_blockers WHERE work_item_id=$1 AND resolved_at IS NULL ORDER BY created_at,id', [id]),
    ])
    const reasons = [
      ...dependencies.map((dependency) => `${String(dependency.kind) === 'blocks' ? 'Blocked by' : 'Depends on'} ${String(dependency.title)}`),
      ...externalBlockers.map((blocker) => String(blocker.content)),
    ]
    return {
      id,
      projectId: String(row.project_id),
      phaseId: textOrNull(row.phase_id),
      kind: String(row.kind) as WorkItem['kind'],
      title: String(row.title),
      description: textOrNull(row.description),
      status: String(row.status) as WorkItem['status'],
      priority: textOrNull(row.priority) as WorkItem['priority'],
      labels: labels.map(labelFromRow),
      version: Number(row.version),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      stableKey: textOrNull(row.stable_key),
      parentId: textOrNull(row.parent_id),
      queueId: textOrNull(queue?.queue_id),
      rank: textOrNull(queue?.rank),
      effectiveBlocked: String(row.status) === 'blocked' || reasons.length > 0,
      blockerReasons: reasons,
    }
  }

  private async updateFromRow(row: SqlRow): Promise<ProjectUpdate> {
    const revision = await this.executor.maybeOne<SqlRow>('SELECT * FROM update_revisions WHERE id=$1', [String(row.current_revision_id)])
    if (!revision) throw new Error(`Update ${String(row.id)} has no current revision`)
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      kind: String(row.kind) as ProjectUpdate['kind'],
      currentRevision: revisionFromRow(revision),
      deletedAt: row.deleted_at == null ? null : iso(row.deleted_at),
      version: Number(row.version),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }
  }

  async listProjects(filters: { state?: ProjectState; includeArchived?: boolean; q?: string } = {}): Promise<Project[]> {
    const clauses: string[] = []
    const values: unknown[] = []
    const parameter = (value: unknown) => { values.push(value); return `$${values.length}` }
    if (!filters.includeArchived) clauses.push('archived_at IS NULL')
    if (filters.state) clauses.push(`state=${parameter(filters.state)}`)
    if (filters.q?.trim()) {
      const q = parameter(filters.q.trim())
      clauses.push(`(position(lower(${q}) in lower(title))>0 OR position(lower(${q}) in lower(COALESCE(description,'')))>0)`)
    }
    const rows = await this.executor.many<SqlRow>(`SELECT * FROM projects ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY last_activity_at DESC,id`, values)
    return rows.map(projectFromRow)
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.executor.maybeOne<SqlRow>('SELECT * FROM projects WHERE id=$1', [id])
    return row ? projectFromRow(row) : null
  }

  async getProjectDetail(id: string): Promise<ProjectDetail | null> {
    const project = await this.getProject(id)
    if (!project) return null
    const [phases, workItems, updates, labels, activity] = await Promise.all([
      this.listPhases(id, true),
      this.listWorkItems(id),
      this.listUpdates(id),
      this.executor.many<SqlRow>(`
        SELECT * FROM (
          SELECT DISTINCT l.* FROM labels l
          JOIN work_item_labels wil ON wil.label_id=l.id
          JOIN work_items wi ON wi.id=wil.work_item_id
          WHERE wi.project_id=$1
        ) project_labels
        ORDER BY lower(name),id
      `, [id]),
      this.listActivity(id),
    ])
    const currentCheckpoint = project.currentCheckpointId ? updates.find((entry) => entry.id === project.currentCheckpointId) ?? null : null
    return {
      project,
      pulse: {
        state: project.state,
        currentFocus: project.currentFocus,
        nextAction: project.nextAction,
        blockers: project.blockers,
        currentCheckpoint,
        activePhases: phases.filter((phase) => phase.status === 'active' && !phase.archivedAt),
        unresolvedWorkItems: workItems.filter((item) => !['resolved', 'dropped'].includes(item.status)),
      },
      phases,
      workItems,
      updates,
      labels: labels.map(labelFromRow),
      activity,
    }
  }

  async createProject(input: CreateProjectInput, provenance: Provenance): Promise<Project> {
    const id = randomUUID()
    const timestamp = now()
    return this.transaction(async () => {
      await this.executor.execute(`
        INSERT INTO projects(id,title,description,intent,deadline,completion_criteria,state,created_at,updated_at,last_activity_at)
        VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$7,$7)
      `, [id, input.title, input.description ?? null, input.intent ?? null, input.deadline ?? null, input.completionCriteria ?? null, timestamp])
      await this.seedOperationalDefaults(id, timestamp)
      await this.replaceSearch('project', id, id, input.title, [input.description, input.intent, input.completionCriteria].filter(Boolean).join('\n'))
      await this.event(id, 'project', id, 'project.created', { title: input.title }, provenance)
      return (await this.getProject(id))!
    })
  }

  async updateProject(id: string, input: UpdateProjectInput, provenance: Provenance): Promise<Project> {
    const current = await this.getProject(id)
    if (!current) throw new NotFoundError('Project', id)
    const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'expectedVersion' && value !== undefined)) }
    return this.transaction(async () => {
      const result = await this.executor.query<SqlRow>(`
        UPDATE projects SET title=$1,description=$2,intent=$3,deadline=$4,completion_criteria=$5,state=$6,current_focus=$7,next_action=$8,
          blockers_json=$9::jsonb,version=version+1,updated_at=$10
        WHERE id=$11 AND version=$12 RETURNING *
      `, [next.title, next.description, next.intent, next.deadline, next.completionCriteria, next.state, next.currentFocus, next.nextAction, JSON.stringify(next.blockers), now(), id, input.expectedVersion])
      if (!result.rows[0]) throw new ConflictError('Project', id)
      await this.replaceSearch('project', id, id, next.title, [next.description, next.intent, next.completionCriteria].filter(Boolean).join('\n'))
      const changes = beforeAfter(current as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, ['title', 'description', 'intent', 'deadline', 'completionCriteria', 'state', 'currentFocus', 'nextAction', 'blockers'])
      await this.event(id, 'project', id, 'project.updated', { changed: Object.keys(changes), changes }, provenance)
      return (await this.getProject(id))!
    })
  }

  async archiveProject(id: string, expectedVersion: number, archived: boolean, provenance: Provenance): Promise<Project> {
    const current = await this.getProject(id)
    if (!current) throw new NotFoundError('Project', id)
    return this.transaction(async () => {
      const result = await this.executor.query<SqlRow>('UPDATE projects SET archived_at=$1,version=version+1,updated_at=$2 WHERE id=$3 AND version=$4 RETURNING *', [archived ? now() : null, now(), id, expectedVersion])
      if (!result.rows[0]) throw new ConflictError('Project', id)
      const updated = projectFromRow(result.rows[0])
      await this.event(id, 'project', id, archived ? 'project.archived' : 'project.unarchived', { changes: { archivedAt: { before: current.archivedAt, after: updated.archivedAt } } }, provenance)
      return (await this.getProject(id))!
    })
  }

  async listPhases(projectId: string, includeArchived = false): Promise<Phase[]> {
    const rows = await this.executor.many<SqlRow>(`SELECT * FROM phases WHERE project_id=$1 ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY position,created_at,id`, [projectId])
    return rows.map(phaseFromRow)
  }

  async createPhase(projectId: string, input: CreatePhaseInput, provenance: Provenance): Promise<Phase> {
    if (!await this.getProject(projectId)) throw new NotFoundError('Project', projectId)
    const id = randomUUID()
    const timestamp = now()
    return this.transaction(async () => {
      const positionRow = await this.executor.one<{ position: number }>('SELECT COALESCE(MAX(position),-1)+1 AS position FROM phases WHERE project_id=$1', [projectId])
      const row = await this.executor.one<SqlRow>(`
        INSERT INTO phases(id,project_id,name,description,status,position,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *
      `, [id, projectId, input.name, input.description ?? null, input.status, input.position ?? Number(positionRow.position), timestamp])
      await this.replaceSearch('phase', id, projectId, input.name, input.description ?? '')
      await this.event(projectId, 'phase', id, 'phase.created', { name: input.name }, provenance)
      return phaseFromRow(row)
    })
  }

  async updatePhase(id: string, input: UpdatePhaseInput, provenance: Provenance): Promise<Phase> {
    const existing = await this.executor.maybeOne<SqlRow>('SELECT * FROM phases WHERE id=$1', [id])
    if (!existing) throw new NotFoundError('Phase', id)
    const current = phaseFromRow(existing)
    const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([key, value]) => !['expectedVersion', 'archived'].includes(key) && value !== undefined)) }
    return this.transaction(async () => {
      const result = await this.executor.query<SqlRow>(`
        UPDATE phases SET name=$1,description=$2,status=$3,position=$4,archived_at=$5,version=version+1,updated_at=$6
        WHERE id=$7 AND version=$8 RETURNING *
      `, [next.name, next.description, next.status, next.position, input.archived === undefined ? current.archivedAt : input.archived ? now() : null, now(), id, input.expectedVersion])
      if (!result.rows[0]) throw new ConflictError('Phase', id)
      const updated = phaseFromRow(result.rows[0])
      await this.replaceSearch('phase', id, current.projectId, updated.name, updated.description ?? '')
      const changes = beforeAfter(current as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>, ['name', 'description', 'status', 'position', 'archivedAt'])
      await this.event(current.projectId, 'phase', id, 'phase.updated', { changed: Object.keys(changes), changes }, provenance)
      return updated
    })
  }

  async listWorkItems(projectId: string, statuses?: string[]): Promise<WorkItem[]> {
    const rows = await this.executor.many<SqlRow>(`
      SELECT * FROM work_items WHERE project_id=$1${statuses?.length ? ' AND status=ANY($2::text[])' : ''}
      ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,updated_at DESC,id
    `, statuses?.length ? [projectId, statuses] : [projectId])
    return Promise.all(rows.map((row) => this.workItemFromRow(row)))
  }

  async listWorkItemsPage(projectId: string, limit: number, cursor?: string | null, statuses?: string[]): Promise<Page<WorkItem>> {
    return pageOf(await this.listWorkItems(projectId, statuses), limit, cursor)
  }

  private async assertPhaseInProject(phaseId: string, projectId: string): Promise<void> {
    const row = await this.executor.maybeOne<SqlRow>('SELECT project_id FROM phases WHERE id=$1', [phaseId])
    if (!row || String(row.project_id) !== projectId) throw new ValidationError('phaseId must refer to a phase in the same project')
  }

  private async assertProjectEntity(table: 'requirements' | 'work_items', id: string, projectId: string): Promise<void> {
    const row = await this.executor.maybeOne<SqlRow>(`SELECT project_id FROM ${table} WHERE id=$1`, [id])
    if (!row) throw new NotFoundError(table === 'requirements' ? 'Requirement' : 'Work item', id)
    if (String(row.project_id) !== projectId) throw new ValidationError(`${table === 'requirements' ? 'requirementId' : 'workItemId'} must refer to an entity in the same project`)
  }

  private async assertParentInProject(parentId: string, projectId: string, childId?: string): Promise<void> {
    await this.assertProjectEntity('work_items', parentId, projectId)
    if (parentId === childId) throw new ValidationError('A work item cannot be its own parent')
    if (!childId) return
    const cycle = await this.executor.maybeOne(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT parent_id FROM work_items WHERE id=$1 AND parent_id IS NOT NULL
        UNION
        SELECT wi.parent_id FROM work_items wi JOIN ancestors a ON wi.id=a.id WHERE wi.parent_id IS NOT NULL
      ) SELECT 1 FROM ancestors WHERE id=$2 LIMIT 1
    `, [parentId, childId])
    if (cycle) throw new ValidationError('Parent relationship would create a cycle')
  }

  private async assertQueueInProject(queueId: string, projectId: string): Promise<void> {
    const row = await this.executor.maybeOne<SqlRow>('SELECT project_id FROM work_queues WHERE id=$1', [queueId])
    if (!row) throw new NotFoundError('Work queue', queueId)
    if (String(row.project_id) !== projectId) throw new ValidationError('queueId must refer to a queue in the same project')
  }

  private async ensureDefaultQueue(projectId: string): Promise<string> {
    const existing = await this.executor.maybeOne<SqlRow>('SELECT id FROM work_queues WHERE project_id=$1 ORDER BY created_at,id LIMIT 1', [projectId])
    if (existing) return String(existing.id)
    const id = randomUUID()
    const timestamp = now()
    const inserted = await this.executor.maybeOne<SqlRow>(`
      INSERT INTO work_queues(id,project_id,name,description,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING RETURNING id
    `, [id, projectId, 'Main queue', 'Default ordered work queue', timestamp])
    if (inserted) return String(inserted.id)
    const winner = await this.executor.one<SqlRow>('SELECT id FROM work_queues WHERE project_id=$1 ORDER BY created_at,id LIMIT 1', [projectId])
    return String(winner.id)
  }

  private async insertQueueItem(queueId: string, workItemId: string, rank: string): Promise<void> {
    try {
      await this.executor.execute('INSERT INTO work_queue_items(queue_id,work_item_id,rank,created_at) VALUES ($1,$2,$3,$4)', [queueId, workItemId, rank, now()])
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : 'Could not add work item to queue')
    }
  }

  private async insertWorkPhaseLink(workItemId: string, phaseId: string, role: 'responsible' | 'related', projectId: string): Promise<void> {
    await this.assertPhaseInProject(phaseId, projectId)
    await this.executor.execute(`
      INSERT INTO work_phase_links(work_item_id,phase_id,role,created_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT(work_item_id,phase_id) DO UPDATE SET role=EXCLUDED.role,created_at=EXCLUDED.created_at
    `, [workItemId, phaseId, role, now()])
  }

  private async insertWorkItemLabel(workItemId: string, labelId: string): Promise<void> {
    if (!await this.executor.maybeOne('SELECT 1 FROM labels WHERE id=$1', [labelId])) throw new NotFoundError('Label', labelId)
    await this.executor.execute('INSERT INTO work_item_labels(work_item_id,label_id,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [workItemId, labelId, now()])
  }

  async createWorkItem(projectId: string, input: CreateWorkItemInput, provenance: Provenance): Promise<WorkItem> {
    const id = randomUUID()
    const timestamp = now()
    const labelIds = [...new Set(input.labelIds ?? [])]
    return this.transaction(async () => {
      if (input.parentId) await lockProjectGraph(this.executor, projectId)
      if (!await this.getProject(projectId)) throw new NotFoundError('Project', projectId)
      if (input.phaseId) await this.assertPhaseInProject(input.phaseId, projectId)
      if (input.parentId) await this.assertParentInProject(input.parentId, projectId)
      const queueId = input.queueId === undefined ? await this.ensureDefaultQueue(projectId) : input.queueId
      if (queueId) await this.assertQueueInProject(queueId, projectId)
      for (const phaseId of new Set(input.relatedPhaseIds ?? [])) await this.assertPhaseInProject(phaseId, projectId)
      for (const requirementId of new Set(input.requirementIds ?? [])) await this.assertProjectEntity('requirements', requirementId, projectId)
      const row = await this.executor.one<SqlRow>(`
        INSERT INTO work_items(id,project_id,phase_id,stable_key,parent_id,kind,title,description,status,priority,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *
      `, [id, projectId, input.phaseId ?? null, input.stableKey ?? null, input.parentId ?? null, input.kind, input.title, input.description ?? null, input.status ?? 'open', input.priority ?? null, timestamp])
      for (const labelId of labelIds) await this.insertWorkItemLabel(id, labelId)
      if (queueId) await this.insertQueueItem(queueId, id, input.rank ?? `${timestamp}-${id}`)
      if (input.phaseId) await this.insertWorkPhaseLink(id, input.phaseId, 'responsible', projectId)
      for (const phaseId of new Set(input.relatedPhaseIds ?? [])) if (phaseId !== input.phaseId) await this.insertWorkPhaseLink(id, phaseId, 'related', projectId)
      for (const requirementId of new Set(input.requirementIds ?? [])) {
        await this.executor.execute('INSERT INTO requirement_work_links(requirement_id,work_item_id,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [requirementId, id, timestamp])
      }
      await this.replaceSearch('work_item', id, projectId, input.title, input.description ?? '')
      await this.event(projectId, 'work_item', id, 'work_item.created', { title: input.title, kind: input.kind, status: input.status ?? 'open', phaseId: input.phaseId ?? null, stableKey: input.stableKey ?? null, parentId: input.parentId ?? null, queueId, rank: input.rank ?? null, labelIds }, provenance)
      for (const labelId of labelIds) await this.event(projectId, 'work_item', id, 'work_item.label_attached', { labelId }, provenance)
      return this.workItemFromRow(row)
    })
  }

  async updateWorkItem(id: string, input: UpdateWorkItemInput, provenance: Provenance): Promise<WorkItem> {
    return this.transaction(async () => {
      const initial = await this.executor.maybeOne<SqlRow>('SELECT * FROM work_items WHERE id=$1', [id])
      if (!initial) throw new NotFoundError('Work item', id)
      if (input.parentId !== undefined) await lockProjectGraph(this.executor, String(initial.project_id))
      const existing = input.parentId === undefined
        ? initial
        : await this.executor.maybeOne<SqlRow>('SELECT * FROM work_items WHERE id=$1', [id])
      if (!existing) throw new NotFoundError('Work item', id)
      const current = await this.workItemFromRow(existing)
      if (input.phaseId) await this.assertPhaseInProject(input.phaseId, current.projectId)
      const parentId = input.parentId === undefined ? current.parentId ?? null : input.parentId
      if (parentId) await this.assertParentInProject(parentId, current.projectId, id)
      const queueId = input.queueId === undefined ? current.queueId ?? null : input.queueId
      if (queueId) await this.assertQueueInProject(queueId, current.projectId)
      const relatedPhaseIds = input.relatedPhaseIds ?? (await this.executor.many<SqlRow>("SELECT phase_id FROM work_phase_links WHERE work_item_id=$1 AND role='related'", [id])).map((entry) => String(entry.phase_id))
      for (const phaseId of new Set(relatedPhaseIds)) await this.assertPhaseInProject(phaseId, current.projectId)
      for (const requirementId of new Set(input.requirementIds ?? [])) await this.assertProjectEntity('requirements', requirementId, current.projectId)
      const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([key, value]) => !['expectedVersion', 'labelIds', 'requirementIds', 'relatedPhaseIds', 'queueId', 'rank'].includes(key) && value !== undefined)), parentId, queueId, rank: input.rank === undefined ? current.rank ?? null : input.rank }
      const result = await this.executor.query<SqlRow>(`
        UPDATE work_items SET phase_id=$1,stable_key=$2,parent_id=$3,kind=$4,title=$5,description=$6,status=$7,priority=$8,version=version+1,updated_at=$9
        WHERE id=$10 AND version=$11 RETURNING *
      `, [next.phaseId, next.stableKey ?? null, parentId, next.kind, next.title, next.description, next.status, next.priority, now(), id, input.expectedVersion])
      if (!result.rows[0]) throw new ConflictError('Work item', id)
      const previousLabelIds = current.labels.map((label) => label.id)
      if (input.labelIds) {
        await this.executor.execute('DELETE FROM work_item_labels WHERE work_item_id=$1', [id])
        for (const labelId of new Set(input.labelIds)) await this.insertWorkItemLabel(id, labelId)
      }
      if (input.queueId !== undefined || input.rank !== undefined) {
        await this.executor.execute('DELETE FROM work_queue_items WHERE work_item_id=$1', [id])
        if (queueId) await this.insertQueueItem(queueId, id, input.rank ?? current.rank ?? `${now()}-${id}`)
      }
      if (input.relatedPhaseIds !== undefined || input.phaseId !== undefined) {
        await this.executor.execute('DELETE FROM work_phase_links WHERE work_item_id=$1', [id])
        if (next.phaseId) await this.insertWorkPhaseLink(id, next.phaseId, 'responsible', current.projectId)
        for (const phaseId of new Set(relatedPhaseIds)) if (phaseId !== next.phaseId) await this.insertWorkPhaseLink(id, phaseId, 'related', current.projectId)
      }
      if (input.requirementIds !== undefined) {
        await this.executor.execute('DELETE FROM requirement_work_links WHERE work_item_id=$1', [id])
        for (const requirementId of new Set(input.requirementIds)) {
          await this.executor.execute('INSERT INTO requirement_work_links(requirement_id,work_item_id,created_at) VALUES ($1,$2,$3)', [requirementId, id, now()])
        }
      }
      await this.replaceSearch('work_item', id, current.projectId, next.title, next.description ?? '')
      const updated = await this.workItemFromRow(result.rows[0])
      const currentEventState = { ...current, labelIds: previousLabelIds } as unknown as Record<string, unknown>
      const updatedEventState = { ...updated, labelIds: updated.labels.map((label) => label.id) } as unknown as Record<string, unknown>
      const changes = beforeAfter(currentEventState, updatedEventState, ['title', 'description', 'kind', 'status', 'priority', 'phaseId', 'stableKey', 'parentId', 'queueId', 'rank', 'labelIds'])
      await this.event(current.projectId, 'work_item', id, 'work_item.updated', { changed: Object.keys(changes), changes }, provenance)
      for (const labelId of updated.labels.map((label) => label.id).filter((labelId) => !previousLabelIds.includes(labelId))) await this.event(current.projectId, 'work_item', id, 'work_item.label_attached', { labelId }, provenance)
      for (const labelId of previousLabelIds.filter((labelId) => !updated.labels.some((label) => label.id === labelId))) await this.event(current.projectId, 'work_item', id, 'work_item.label_detached', { labelId }, provenance)
      return updated
    })
  }

  async listUpdates(projectId: string, includeDeleted = false): Promise<ProjectUpdate[]> {
    const rows = await this.executor.many<SqlRow>(`SELECT * FROM updates WHERE project_id=$1 ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at DESC,id`, [projectId])
    return Promise.all(rows.map((row) => this.updateFromRow(row)))
  }

  async listUpdatesPage(projectId: string, limit: number, cursor?: string | null, includeDeleted = false): Promise<Page<ProjectUpdate>> {
    return pageOf(await this.listUpdates(projectId, includeDeleted), limit, cursor)
  }

  async getUpdateRevisions(updateId: string): Promise<UpdateRevision[]> {
    if (!await this.executor.maybeOne('SELECT 1 FROM updates WHERE id=$1', [updateId])) throw new NotFoundError('Update', updateId)
    return (await this.executor.many<SqlRow>('SELECT * FROM update_revisions WHERE update_id=$1 ORDER BY revision DESC,id', [updateId])).map(revisionFromRow)
  }

  async createUpdate(projectId: string, input: CreateUpdateInput, provenance: Provenance): Promise<ProjectUpdate> {
    return this.transaction(() => this.insertUpdate(projectId, input.kind, input.content, null, provenance))
  }

  private async insertUpdate(projectId: string, kind: ProjectUpdate['kind'], content: string, snapshot: PulseSnapshot | null, provenance: Provenance): Promise<ProjectUpdate> {
    if (!await this.getProject(projectId)) throw new NotFoundError('Project', projectId)
    const id = randomUUID()
    const revisionId = randomUUID()
    const timestamp = now()
    const row = await this.executor.one<SqlRow>(`
      INSERT INTO updates(id,project_id,kind,current_revision_id,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$5) RETURNING *
    `, [id, projectId, kind, revisionId, timestamp])
    await this.executor.execute(`
      INSERT INTO update_revisions(id,update_id,revision,content,snapshot_json,source,client,created_at)
      VALUES ($1,$2,1,$3,$4::jsonb,$5,$6,$7)
    `, [revisionId, id, content, snapshot ? JSON.stringify(snapshot) : null, provenance.source, provenance.client ?? null, timestamp])
    await this.replaceSearch('update', id, projectId, kind, content)
    await this.event(projectId, 'update', id, kind === 'checkpoint' ? 'checkpoint.created' : 'update.created', { kind, content }, provenance)
    return this.updateFromRow(row)
  }

  async reviseUpdate(updateId: string, input: ReviseUpdateInput, provenance: Provenance): Promise<ProjectUpdate> {
    return this.transaction(async () => {
      const existing = await this.executor.maybeOne<SqlRow>('SELECT * FROM updates WHERE id=$1', [updateId])
      if (!existing) throw new NotFoundError('Update', updateId)
      if (existing.deleted_at) throw new ValidationError('Deleted updates cannot be revised')
      const result = await this.executor.query<SqlRow>('UPDATE updates SET version=version+1,updated_at=$1 WHERE id=$2 AND version=$3 RETURNING *', [now(), updateId, input.expectedVersion])
      if (!result.rows[0]) throw new ConflictError('Update', updateId)
      const revisionRow = await this.executor.one<{ revision: number }>('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM update_revisions WHERE update_id=$1', [updateId])
      const revision = Number(revisionRow.revision)
      const revisionId = randomUUID()
      const timestamp = now()
      const currentRevision = await this.executor.one<SqlRow>('SELECT snapshot_json FROM update_revisions WHERE id=$1', [String(existing.current_revision_id)])
      await this.executor.execute(`
        INSERT INTO update_revisions(id,update_id,revision,content,snapshot_json,source,client,created_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
      `, [revisionId, updateId, revision, input.content, currentRevision.snapshot_json == null ? null : JSON.stringify(currentRevision.snapshot_json), provenance.source, provenance.client ?? null, timestamp])
      const updatedRow = await this.executor.one<SqlRow>('UPDATE updates SET current_revision_id=$1 WHERE id=$2 RETURNING *', [revisionId, updateId])
      await this.replaceSearch('update', updateId, String(existing.project_id), String(existing.kind), input.content)
      await this.event(String(existing.project_id), 'update', updateId, 'update.revised', { revision, content: input.content }, provenance)
      return this.updateFromRow(updatedRow)
    })
  }

  async softDeleteUpdate(updateId: string, expectedVersion: number, provenance: Provenance): Promise<ProjectUpdate> {
    return this.transaction(async () => {
      const existing = await this.executor.maybeOne<SqlRow>('SELECT * FROM updates WHERE id=$1', [updateId])
      if (!existing) throw new NotFoundError('Update', updateId)
      if (existing.kind === 'checkpoint' && await this.executor.maybeOne('SELECT 1 FROM projects WHERE current_checkpoint_id=$1', [updateId])) {
        throw new ValidationError('The current checkpoint cannot be deleted until another checkpoint is saved')
      }
      const timestamp = now()
      const result = await this.executor.query<SqlRow>('UPDATE updates SET deleted_at=$1,version=version+1,updated_at=$1 WHERE id=$2 AND version=$3 RETURNING *', [timestamp, updateId, expectedVersion])
      if (!result.rows[0]) throw new ConflictError('Update', updateId)
      await this.executor.execute("DELETE FROM search_index WHERE entity_type='update' AND entity_id=$1", [updateId])
      await this.event(String(existing.project_id), 'update', updateId, 'update.deleted', {}, provenance)
      return this.updateFromRow(result.rows[0])
    })
  }

  async saveCheckpoint(projectId: string, input: CheckpointInput, provenance: Provenance): Promise<ProjectUpdate> {
    return this.transaction(async () => {
      const project = await this.getProject(projectId)
      if (!project) throw new NotFoundError('Project', projectId)
      if (project.version !== input.expectedVersion) throw new ConflictError('Project', projectId)
      const currentFocus = input.currentFocus === undefined ? project.currentFocus : input.currentFocus
      const nextAction = input.nextAction === undefined ? project.nextAction : input.nextAction
      const blockers = input.blockers ?? project.blockers
      const [phases, workItems] = await Promise.all([this.listPhases(projectId), this.listWorkItems(projectId)])
      const snapshot: PulseSnapshot = {
        state: project.state,
        currentFocus,
        nextAction,
        blockers,
        activePhaseIds: phases.filter((phase) => phase.status === 'active').map((phase) => phase.id),
        unresolvedWorkItemIds: workItems.filter((item) => !['resolved', 'dropped'].includes(item.status)).map((item) => item.id),
        capturedAt: now(),
      }
      const checkpoint = await this.insertUpdate(projectId, 'checkpoint', input.content, snapshot, provenance)
      const result = await this.executor.query<SqlRow>(`
        UPDATE projects SET current_focus=$1,next_action=$2,blockers_json=$3::jsonb,current_checkpoint_id=$4,version=version+1,updated_at=$5
        WHERE id=$6 AND version=$7 RETURNING *
      `, [currentFocus, nextAction, JSON.stringify(blockers), checkpoint.id, now(), projectId, input.expectedVersion])
      if (!result.rows[0]) throw new ConflictError('Project', projectId)
      await this.event(projectId, 'project', projectId, 'project.checkpoint_selected', { checkpointId: checkpoint.id }, provenance)
      return checkpoint
    })
  }

  async listLabels(): Promise<Label[]> {
    return (await this.executor.many<SqlRow>('SELECT * FROM labels ORDER BY lower(name),id')).map(labelFromRow)
  }

  async createLabel(input: CreateLabelInput, provenance: Provenance): Promise<Label> {
    const id = randomUUID()
    const timestamp = now()
    return this.transaction(async () => {
      let row: SqlRow
      try {
        row = await this.executor.one<SqlRow>('INSERT INTO labels(id,name,colour,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) RETURNING *', [id, input.name, input.colour ?? null, timestamp])
      } catch (error) {
        if (isUniqueViolation(error)) throw new ValidationError(`A label named “${input.name}” already exists`)
        throw error
      }
      await this.event(null, 'label', id, 'label.created', { name: input.name }, provenance)
      return labelFromRow(row)
    })
  }

  async attachLabel(workItemId: string, labelId: string, expectedVersion: number, provenance: Provenance): Promise<WorkItem> {
    return this.transaction(async () => {
      const existing = await this.executor.maybeOne<SqlRow>('SELECT * FROM work_items WHERE id=$1', [workItemId])
      if (!existing) throw new NotFoundError('Work item', workItemId)
      if (Number(existing.version) !== expectedVersion) throw new ConflictError('Work item', workItemId)
      if (!await this.executor.maybeOne('SELECT 1 FROM labels WHERE id=$1', [labelId])) throw new NotFoundError('Label', labelId)
      if (await this.executor.maybeOne('SELECT 1 FROM work_item_labels WHERE work_item_id=$1 AND label_id=$2', [workItemId, labelId])) return this.workItemFromRow(existing)
      const result = await this.executor.query<SqlRow>('UPDATE work_items SET version=version+1,updated_at=$1 WHERE id=$2 AND version=$3 RETURNING *', [now(), workItemId, expectedVersion])
      if (!result.rows[0]) throw new ConflictError('Work item', workItemId)
      await this.insertWorkItemLabel(workItemId, labelId)
      await this.event(String(existing.project_id), 'work_item', workItemId, 'work_item.label_attached', { labelId }, provenance)
      return this.workItemFromRow(result.rows[0])
    })
  }

  async detachLabel(workItemId: string, labelId: string, expectedVersion: number, provenance: Provenance): Promise<WorkItem> {
    return this.transaction(async () => {
      const existing = await this.executor.maybeOne<SqlRow>('SELECT * FROM work_items WHERE id=$1', [workItemId])
      if (!existing) throw new NotFoundError('Work item', workItemId)
      if (Number(existing.version) !== expectedVersion) throw new ConflictError('Work item', workItemId)
      if (!await this.executor.maybeOne('SELECT 1 FROM work_item_labels WHERE work_item_id=$1 AND label_id=$2', [workItemId, labelId])) return this.workItemFromRow(existing)
      const result = await this.executor.query<SqlRow>('UPDATE work_items SET version=version+1,updated_at=$1 WHERE id=$2 AND version=$3 RETURNING *', [now(), workItemId, expectedVersion])
      if (!result.rows[0]) throw new ConflictError('Work item', workItemId)
      await this.executor.execute('DELETE FROM work_item_labels WHERE work_item_id=$1 AND label_id=$2', [workItemId, labelId])
      await this.event(String(existing.project_id), 'work_item', workItemId, 'work_item.label_detached', { labelId }, provenance)
      return this.workItemFromRow(result.rows[0])
    })
  }

  async listActivity(projectId: string, limit = 200): Promise<ActivityEvent[]> {
    const rows = await this.executor.many<SqlRow>('SELECT * FROM activity_events WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2', [projectId, Math.min(Math.max(limit, 1), 1000)])
    return rows.map(activityFromRow)
  }

  async listActivityPage(projectId: string, limit: number, cursor?: string | null): Promise<Page<ActivityEvent>> {
    const start = decodeCursor(cursor)
    const boundedLimit = Math.min(Math.max(limit, 1), 200)
    const rows = await this.executor.many<SqlRow>('SELECT * FROM activity_events WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3', [projectId, boundedLimit + 1, start])
    const hasMore = rows.length > boundedLimit
    const items = rows.slice(0, boundedLimit).map(activityFromRow)
    return { items, nextCursor: hasMore ? encodeCursor(start + items.length) : null, hasMore }
  }

  async listRecentActivity(limit = 50): Promise<DashboardActivityEvent[]> {
    const rows = await this.executor.many<SqlRow>(`
      SELECT ae.*,p.title AS project_title FROM activity_events ae
      JOIN projects p ON p.id=ae.project_id WHERE p.archived_at IS NULL
      ORDER BY ae.created_at DESC,ae.id DESC LIMIT $1
    `, [Math.min(Math.max(limit, 1), 200)])
    return rows.map((row) => ({ ...activityFromRow(row), projectId: String(row.project_id), projectTitle: String(row.project_title) }))
  }

  async search(query: string, limit = 50, filters: SearchFilters = {}): Promise<SearchResult[]> {
    const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
    if (!tokens.length) return []
    const values: unknown[] = []
    const parameter = (value: unknown) => { values.push(value); return `$${values.length}` }
    const tsQuery = parameter(tokens.map((token) => `${token}:*`).join(' & '))
    const clauses = [`search_index.search_vector @@ to_tsquery('simple',istra_unaccent(${tsQuery}))`]
    if (filters.projectId) clauses.push(`search_index.project_id=${parameter(filters.projectId)}`)
    if (filters.entityTypes) {
      if (!filters.entityTypes.length) clauses.push('FALSE')
      else clauses.push(`search_index.entity_type=ANY(${parameter(filters.entityTypes)}::text[])`)
    }
    if (filters.state) clauses.push(`COALESCE(p.state,ph.status,wi.status)=${parameter(filters.state)}`)
    if (filters.phaseId) {
      const phase = parameter(filters.phaseId)
      clauses.push(`(ph.id=${phase} OR (search_index.entity_type='work_item' AND (wi.phase_id=${phase} OR EXISTS (SELECT 1 FROM work_phase_links wpl WHERE wpl.work_item_id=search_index.entity_id AND wpl.phase_id=${phase}))))`)
    }
    if (filters.requirementId) clauses.push(`search_index.entity_type='work_item' AND EXISTS (SELECT 1 FROM requirement_work_links rwl WHERE rwl.work_item_id=search_index.entity_id AND rwl.requirement_id=${parameter(filters.requirementId)})`)
    if (filters.evidenceResult) clauses.push('FALSE')
    if (filters.from) clauses.push(`COALESCE(p.created_at,ph.created_at,wi.created_at,u.created_at)>=${parameter(filters.from)}`)
    if (filters.to) clauses.push(`COALESCE(p.created_at,ph.created_at,wi.created_at,u.created_at)<=${parameter(filters.to)}`)
    const boundedLimit = parameter(Math.min(Math.max(limit, 1), 200))
    const rows = await this.executor.many<SqlRow>(`
      SELECT search_index.entity_type,search_index.entity_id,search_index.project_id,search_index.title,
        ts_headline('simple',search_index.title || ' ' || search_index.body,to_tsquery('simple',istra_unaccent(${tsQuery})),'MaxWords=24,MinWords=1') AS excerpt,
        ts_rank_cd(search_index.search_vector,to_tsquery('simple',istra_unaccent(${tsQuery}))) AS score
      FROM search_index
      LEFT JOIN projects p ON search_index.entity_type='project' AND p.id=search_index.entity_id
      LEFT JOIN phases ph ON search_index.entity_type='phase' AND ph.id=search_index.entity_id
      LEFT JOIN work_items wi ON search_index.entity_type='work_item' AND wi.id=search_index.entity_id
      LEFT JOIN updates u ON search_index.entity_type='update' AND u.id=search_index.entity_id
      WHERE ${clauses.join(' AND ')} ORDER BY score DESC,search_index.entity_type,search_index.entity_id LIMIT ${boundedLimit}
    `, values)
    return rows.map((row) => ({
      type: String(row.entity_type) as SearchResult['type'],
      id: String(row.entity_id),
      projectId: String(row.project_id),
      title: String(row.title),
      excerpt: String(row.excerpt),
      score: Number(row.score),
    }))
  }

  async exportAll(): Promise<ExportBundle> {
    const tables: ExportBundle['tables'] = {}
    await this.executor.transaction(async () => {
      for (const [table, columns] of Object.entries(exportTables)) {
        const selectColumns = columns.map((column) => isJsonExportColumn(table, column) ? `${column}::text AS ${column}` : column)
        const rows = await this.executor.many<SqlRow>(`SELECT ${selectColumns.join(',')} FROM ${table}`)
        tables[table] = deterministicRows(table, rows)
      }
    }, { isolationLevel: 'repeatable read', readOnly: true })
    return { format: 'istra-export', formatVersion: 4, exportedAt: now(), tables }
  }

  async isEmpty(): Promise<boolean> {
    for (const table of Object.keys(exportTables)) {
      if (await this.executor.maybeOne(`SELECT 1 FROM ${table} LIMIT 1`)) return false
    }
    return true
  }

  async importForMigration(bundle: ExportBundle): Promise<{ tableCounts: Record<string, number> }> {
    if (bundle.format !== 'istra-export' || bundle.formatVersion !== 4) {
      throw new ValidationError('PostgreSQL migration requires an Istra export format v4 bundle')
    }
    return this.transaction(async () => {
      if (!await this.isEmpty()) throw new ValidationError('PostgreSQL migration target is not empty')
      await this.executor.execute('SET CONSTRAINTS ALL DEFERRED')
      const tableCounts: Record<string, number> = {}
      for (const [table, columns] of Object.entries(exportTables)) {
        const suppliedRows = bundle.tables[table]
        if (!Array.isArray(suppliedRows)) throw new ValidationError(`Migration bundle is missing table ${table}`)
        const rows = parentFirst(table, deterministicRows(table, suppliedRows))
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(',')
        for (const row of rows) {
          const values = columns.map((quotedColumn) => {
            const column = quotedColumn.replaceAll('"', '')
            const value = row[column]
            return booleanColumns.has(`${table}.${column}`) && value != null ? Boolean(value) : value
          })
          await this.executor.execute(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${placeholders})`, values)
        }
        tableCounts[table] = rows.length
      }
      await this.rebuildSearchForMigration()
      await this.executor.execute(`
        SELECT setval(
          pg_get_serial_sequence('evidence','ordinal'),
          COALESCE((SELECT MAX(ordinal) FROM evidence),1),
          EXISTS(SELECT 1 FROM evidence)
        )
      `)

      const imported = await this.exportAll()
      for (const table of Object.keys(exportTables)) {
        const expected = deterministicRows(table, bundle.tables[table]!)
        if (canonicalJson(imported.tables[table]) !== canonicalJson(expected)) {
          throw new ValidationError(`PostgreSQL migration verification failed for table ${table}`)
        }
      }
      return { tableCounts }
    })
  }

  async clearForFailedActivation(): Promise<void> {
    await this.transaction(async () => {
      await this.executor.execute('SET CONSTRAINTS ALL DEFERRED')
      await this.executor.execute('DELETE FROM search_index')
      for (const table of Object.keys(exportTables).reverse()) await this.executor.execute(`DELETE FROM ${table}`)
      await this.executor.execute(`SELECT setval(pg_get_serial_sequence('evidence','ordinal'),1,false)`)
    })
  }

  private async rebuildSearchForMigration(): Promise<void> {
    await this.executor.execute('DELETE FROM search_index')
    await this.executor.execute(`
      INSERT INTO search_index(entity_type,entity_id,project_id,title,body)
      SELECT 'project',id,id,title,concat_ws(E'\\n',description,intent,completion_criteria) FROM projects
    `)
    await this.executor.execute(`
      INSERT INTO search_index(entity_type,entity_id,project_id,title,body)
      SELECT 'phase',id,project_id,name,COALESCE(description,'') FROM phases
    `)
    await this.executor.execute(`
      INSERT INTO search_index(entity_type,entity_id,project_id,title,body)
      SELECT 'work_item',id,project_id,title,COALESCE(description,'') FROM work_items
    `)
    await this.executor.execute(`
      INSERT INTO search_index(entity_type,entity_id,project_id,title,body)
      SELECT 'update',u.id,u.project_id,u.kind,r.content FROM updates u
      JOIN update_revisions r ON r.id=u.current_revision_id WHERE u.deleted_at IS NULL
    `)
    await this.executor.execute(`
      INSERT INTO search_index(entity_type,entity_id,project_id,title,body)
      SELECT 'requirement',id,project_id,stable_key || ' ' || title,COALESCE(description,'') FROM requirements
    `)
    await this.executor.execute(`
      INSERT INTO search_index(entity_type,entity_id,project_id,title,body)
      SELECT 'run',id,project_id,command,concat_ws(E'\\n',stdout_excerpt,stderr_excerpt) FROM runs
    `)
    await this.executor.execute(`
      INSERT INTO search_index(entity_type,entity_id,project_id,title,body)
      SELECT 'evidence',id,project_id,result,summary FROM evidence
    `)
  }

  async validateImport(_bundle: ExportBundle): Promise<void> {
    throw new UnsupportedOperationError('PostgreSQL full-replacement import is unavailable until PostgreSQL backup and restore support is implemented')
  }

  async importAll(_bundle: ExportBundle): Promise<void> {
    throw new UnsupportedOperationError('PostgreSQL full-replacement import is unavailable until PostgreSQL backup and restore support is implemented')
  }
}
