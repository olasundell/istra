import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AcceptanceCriterion,
  CheckpointSnapshot,
  CheckpointComparison,
  CreateEvidenceInput,
  CreateExternalBlockerInput,
  CreateRequirementInput,
  CreateRequirementStateInput,
  CreateRunInput,
  CreateWorkQueueInput,
  CreateWorkRelationInput,
  CreateWorkspaceInput,
  CreateWorkspaceRevisionInput,
  Evidence,
  ExternalBlocker,
  Project,
  ProjectPulseSummary,
  Requirement,
  RequirementRollup,
  RequirementRollupBucket,
  RequirementStateDefinition,
  RequirementStateSemantic,
  Run,
  TestSummary,
  UpdateRequirementInput,
  WorkItem,
  WorkQueue,
  WorkRelation,
  Workspace,
  WorkspaceRevision,
  ArtifactReference,
  Page,
  SearchFilters,
  SearchResult,
} from '../../domain/contracts.js'
import { ConflictError, IdempotencyConflictError, NotFoundError, ValidationError } from '../../application/errors.js'
import { pageOf } from '../../application/pagination.js'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()
const textOrNull = (value: unknown): string | null => value === null || value === undefined ? null : String(value)
const bool = (value: unknown) => Number(value) === 1
const json = <T>(value: unknown, fallback: T): T => {
  try { return value === null || value === undefined ? fallback : JSON.parse(String(value)) as T } catch { return fallback }
}

export interface OperationalRepository {
  runIdempotent<T>(client: string, key: string, operation: string, payload: unknown, work: () => T): T
  listRequirementStates(projectId: string): RequirementStateDefinition[]
  createRequirementState(projectId: string, input: CreateRequirementStateInput): RequirementStateDefinition
  listRequirements(projectId: string): Requirement[]
  listRequirementsPage(projectId: string, limit: number, cursor?: string | null): Page<Requirement>
  getRequirement(id: string): Requirement | null
  createRequirement(projectId: string, input: CreateRequirementInput): Requirement
  updateRequirement(id: string, input: UpdateRequirementInput): Requirement
  linkRequirementWork(projectId: string, requirementId: string, workItemId: string): void
  unlinkRequirementWork(requirementId: string, workItemId: string): void
  getRequirementRollup(projectId: string): RequirementRollup
  listWorkQueues(projectId: string): WorkQueue[]
  createWorkQueue(projectId: string, input: CreateWorkQueueInput): WorkQueue
  listWorkItems(projectId: string, queueId?: string): WorkItem[]
  listWorkItemsPage(projectId: string, limit: number, cursor?: string | null, queueId?: string): Page<WorkItem>
  linkWorkItems(projectId: string, input: CreateWorkRelationInput): WorkRelation
  unlinkWorkItems(id: string): void
  listWorkRelations(projectId: string): WorkRelation[]
  createExternalBlocker(projectId: string, input: CreateExternalBlockerInput): ExternalBlocker
  listExternalBlockers(projectId: string, includeResolved?: boolean): ExternalBlocker[]
  resolveExternalBlocker(id: string): ExternalBlocker
  createWorkspace(input: CreateWorkspaceInput): Workspace
  linkProjectWorkspace(projectId: string, workspaceId: string): void
  createWorkspaceRevision(input: CreateWorkspaceRevisionInput): WorkspaceRevision
  resolveProject(workspacePath: string): Project[]
  createRun(projectId: string, input: CreateRunInput): { run: Run; testSummary: TestSummary | null; artifacts: ArtifactReference[] }
  listRuns(projectId: string): Run[]
  listRunsPage(projectId: string, limit: number, cursor?: string | null): Page<Run>
  createEvidence(projectId: string, input: CreateEvidenceInput): Evidence
  listEvidence(projectId: string, includeStale?: boolean): Evidence[]
  listEvidencePage(projectId: string, limit: number, cursor?: string | null, includeStale?: boolean): Page<Evidence>
  captureCheckpointSnapshot(projectId: string, checkpointId: string): CheckpointSnapshot
  getCheckpointSnapshot(checkpointId: string): CheckpointSnapshot | null
  compareCheckpointSnapshots(leftCheckpointId: string, rightCheckpointId: string): CheckpointComparison
  reconstructCheckpointState(checkpointId: string): Record<string, unknown> | null
  getProjectPulseSummary(projectId: string): ProjectPulseSummary | null
  search(query: string, limit?: number, filters?: SearchFilters): SearchResult[]
}

export class SqliteOperationalRepository implements OperationalRepository {
  private savepointSequence = 0

  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(work: () => T): T {
    if (this.db.isTransaction) {
      const savepoint = `operational_${this.savepointSequence++}`
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

  runIdempotent<T>(client: string, key: string, operation: string, payload: unknown, work: () => T): T {
    const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT operation,request_hash,result_json FROM idempotency_records WHERE client=? AND idempotency_key=?').get(client, key) as Row | undefined
      if (existing) {
        if (String(existing.operation) !== operation || String(existing.request_hash) !== requestHash) throw new IdempotencyConflictError(key)
        return json<T>(existing.result_json, undefined as T)
      }
      const result = work()
      this.db.prepare('INSERT INTO idempotency_records(client,idempotency_key,operation,request_hash,result_json,created_at) VALUES (?,?,?,?,?,?)').run(client, key, operation, requestHash, JSON.stringify(result) ?? 'null', now())
      return result
    })
  }

  private project(projectId: string): Row {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as Row | undefined
    if (!row) throw new NotFoundError('Project', projectId)
    return row
  }

  listRequirementStates(projectId: string): RequirementStateDefinition[] {
    this.project(projectId)
    return (this.db.prepare('SELECT * FROM requirement_states WHERE project_id=? ORDER BY position,created_at').all(projectId) as Row[]).map((row) => ({
      id: String(row.id), projectId: String(row.project_id), name: String(row.name), semantic: String(row.semantic) as RequirementStateSemantic,
      position: Number(row.position), colour: textOrNull(row.colour), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }))
  }

  createRequirementState(projectId: string, input: CreateRequirementStateInput): RequirementStateDefinition {
    this.project(projectId)
    const id = randomUUID(); const timestamp = now()
    const position = input.position ?? Number((this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS position FROM requirement_states WHERE project_id=?').get(projectId) as Row).position)
    try {
      this.db.prepare('INSERT INTO requirement_states(id,project_id,name,semantic,position,colour,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, projectId, input.name, input.semantic, position, input.colour ?? null, timestamp, timestamp)
    } catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'Could not create requirement state') }
    return this.listRequirementStates(projectId).find((state) => state.id === id)!
  }

  private criteria(requirementId: string): AcceptanceCriterion[] {
    return (this.db.prepare('SELECT * FROM acceptance_criteria WHERE requirement_id=? ORDER BY position,created_at').all(requirementId) as Row[]).map((row) => ({
      id: String(row.id), requirementId: String(row.requirement_id), title: String(row.title), description: textOrNull(row.description), position: Number(row.position), required: bool(row.required), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }))
  }

  private requirementFromRow(row: Row): Requirement {
    const id = String(row.id)
    const relatedPhaseIds = (this.db.prepare("SELECT phase_id FROM requirement_phase_links WHERE requirement_id=? AND role='related'").all(id) as Row[]).map((entry) => String(entry.phase_id))
    const linkedWorkItemIds = (this.db.prepare('SELECT work_item_id FROM requirement_work_links WHERE requirement_id=?').all(id) as Row[]).map((entry) => String(entry.work_item_id))
    const linkedEvidenceIds = (this.db.prepare('SELECT evidence_id FROM evidence_requirement_links WHERE requirement_id=?').all(id) as Row[]).map((entry) => String(entry.evidence_id))
    const required = this.criteria(id).filter((criterion) => criterion.required)
    const linkedEvidence = (this.db.prepare('SELECT e.* FROM evidence e JOIN evidence_requirement_links l ON l.evidence_id=e.id WHERE l.requirement_id=?').all(id) as Row[]).map((entry) => this.evidenceFromRow(entry))
    const satisfied = required.length > 0 && linkedEvidence.some((entry) => entry.result === 'verified' && !entry.stale)
    const state = String(row.semantic) as RequirementStateSemantic
    const gate = required.length === 0 ? 'not_configured' : satisfied ? 'satisfied' : 'unsatisfied'
    return {
      id, projectId: String(row.project_id), stableKey: String(row.stable_key), kind: String(row.kind) as Requirement['kind'], parentId: textOrNull(row.parent_id), title: String(row.title), description: textOrNull(row.description), stateId: String(row.state_id), responsiblePhaseId: textOrNull(row.responsible_phase_id), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at), criteria: this.criteria(id), relatedPhaseIds, linkedWorkItemIds, linkedEvidenceIds, gate: state === 'proven' && gate !== 'satisfied' ? 'unsatisfied' : gate,
    }
  }

  listRequirements(projectId: string): Requirement[] {
    this.project(projectId)
    return (this.db.prepare('SELECT r.*,s.semantic FROM requirements r JOIN requirement_states s ON s.id=r.state_id WHERE r.project_id=? ORDER BY r.stable_key').all(projectId) as Row[]).map((row) => this.requirementFromRow(row))
  }

  listRequirementsPage(projectId: string, limit: number, cursor?: string | null): Page<Requirement> {
    return pageOf(this.listRequirements(projectId), limit, cursor)
  }

  getRequirement(id: string): Requirement | null {
    const row = this.db.prepare('SELECT r.*,s.semantic FROM requirements r JOIN requirement_states s ON s.id=r.state_id WHERE r.id=?').get(id) as Row | undefined
    return row ? this.requirementFromRow(row) : null
  }

  private assertProjectEntity(table: string, id: string, projectId: string): Row {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=? AND project_id=?`).get(id, projectId) as Row | undefined
    if (!row) throw new ValidationError(`${table} must belong to the project`)
    return row
  }

  private assertRequirementParent(parentId: string, projectId: string, childId?: string): void {
    this.assertProjectEntity('requirements', parentId, projectId)
    if (parentId === childId) throw new ValidationError('A requirement cannot be its own parent')
    if (!childId) return
    const cycle = this.db.prepare(`WITH RECURSIVE ancestors(id) AS (
      SELECT parent_id FROM requirements WHERE id=? AND parent_id IS NOT NULL
      UNION
      SELECT r.parent_id FROM requirements r JOIN ancestors a ON r.id=a.id WHERE r.parent_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id=? LIMIT 1`).get(parentId, childId)
    if (cycle) throw new ValidationError('Requirement parent relationship would create a cycle')
  }

  createRequirement(projectId: string, input: CreateRequirementInput): Requirement {
    this.project(projectId)
    const state = input.stateId ? this.db.prepare('SELECT id FROM requirement_states WHERE id=? AND project_id=?').get(input.stateId, projectId) as Row | undefined : this.db.prepare("SELECT id FROM requirement_states WHERE project_id=? AND semantic='open' ORDER BY position LIMIT 1").get(projectId) as Row | undefined
    if (!state) throw new ValidationError('Requirement state does not belong to the project')
    if (input.parentId) this.assertRequirementParent(input.parentId, projectId)
    if (input.responsiblePhaseId) this.assertProjectEntity('phases', input.responsiblePhaseId, projectId)
    return this.transaction(() => {
      const id = randomUUID(); const timestamp = now()
      try {
        this.db.prepare('INSERT INTO requirements(id,project_id,stable_key,kind,parent_id,title,description,state_id,responsible_phase_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, input.stableKey, input.kind, input.parentId ?? null, input.title, input.description ?? null, String(state.id), input.responsiblePhaseId ?? null, timestamp, timestamp)
      } catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'Could not create requirement') }
      for (const [position, criterion] of (input.criteria ?? []).entries()) this.db.prepare('INSERT INTO acceptance_criteria(id,requirement_id,title,description,position,required,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), id, criterion.title, criterion.description ?? null, position, criterion.required ? 1 : 0, timestamp, timestamp)
      for (const phaseId of new Set(input.relatedPhaseIds ?? [])) { this.assertProjectEntity('phases', phaseId, projectId); this.db.prepare('INSERT INTO requirement_phase_links(requirement_id,phase_id,role,created_at) VALUES (?,?,?,?)').run(id, phaseId, phaseId === input.responsiblePhaseId ? 'responsible' : 'related', timestamp) }
      return this.getRequirement(id)!
    })
  }

  updateRequirement(id: string, input: UpdateRequirementInput): Requirement {
    const current = this.getRequirement(id); if (!current) throw new NotFoundError('Requirement', id)
    const parentId = input.parentId === undefined ? current.parentId : input.parentId
    if (parentId) this.assertRequirementParent(parentId, current.projectId, id)
    const stateId = input.stateId ?? current.stateId
    if (!this.db.prepare('SELECT id FROM requirement_states WHERE id=? AND project_id=?').get(stateId, current.projectId)) throw new ValidationError('Requirement state does not belong to the project')
    const responsiblePhaseId = input.responsiblePhaseId === undefined ? current.responsiblePhaseId : input.responsiblePhaseId
    if (responsiblePhaseId) this.assertProjectEntity('phases', responsiblePhaseId, current.projectId)
    const relatedPhaseIds = input.relatedPhaseIds ?? current.relatedPhaseIds
    for (const phaseId of new Set(relatedPhaseIds)) this.assertProjectEntity('phases', phaseId, current.projectId)
    return this.transaction(() => {
      const next = { ...current, ...input, parentId, stateId, responsiblePhaseId }
      const result = this.db.prepare('UPDATE requirements SET stable_key=?,kind=?,parent_id=?,title=?,description=?,state_id=?,responsible_phase_id=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(next.stableKey, next.kind, parentId ?? null, next.title, next.description ?? null, stateId, responsiblePhaseId ?? null, now(), id, input.expectedVersion)
      if (!Number(result.changes)) throw new ConflictError('Requirement', id)
      if (input.relatedPhaseIds !== undefined || input.responsiblePhaseId !== undefined) {
        this.db.prepare('DELETE FROM requirement_phase_links WHERE requirement_id=?').run(id)
        if (responsiblePhaseId) this.db.prepare('INSERT INTO requirement_phase_links(requirement_id,phase_id,role,created_at) VALUES (?,?,?,?)').run(id, responsiblePhaseId, 'responsible', now())
        for (const phaseId of new Set(relatedPhaseIds)) if (phaseId !== responsiblePhaseId) this.db.prepare('INSERT INTO requirement_phase_links(requirement_id,phase_id,role,created_at) VALUES (?,?,?,?)').run(id, phaseId, 'related', now())
      }
      if (input.criteria !== undefined) {
        this.db.prepare('DELETE FROM acceptance_criteria WHERE requirement_id=?').run(id)
        for (const [position, criterion] of input.criteria.entries()) this.db.prepare('INSERT INTO acceptance_criteria(id,requirement_id,title,description,position,required,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), id, criterion.title, criterion.description ?? null, position, criterion.required ? 1 : 0, now(), now())
      }
      return this.getRequirement(id)!
    })
  }

  linkRequirementWork(projectId: string, requirementId: string, workItemId: string): void {
    this.assertProjectEntity('requirements', requirementId, projectId); this.assertProjectEntity('work_items', workItemId, projectId)
    this.db.prepare('INSERT OR IGNORE INTO requirement_work_links(requirement_id,work_item_id,created_at) VALUES (?,?,?)').run(requirementId, workItemId, now())
  }

  unlinkRequirementWork(requirementId: string, workItemId: string): void { this.db.prepare('DELETE FROM requirement_work_links WHERE requirement_id=? AND work_item_id=?').run(requirementId, workItemId) }

  getRequirementRollup(projectId: string): RequirementRollup {
    const bySemantic: Record<RequirementStateSemantic, number> = { open: 0, partial: 0, proven: 0, defect: 0 }
    const rows = this.db.prepare("SELECT s.semantic,COUNT(*) AS count FROM requirements r JOIN requirement_states s ON s.id=r.state_id WHERE r.project_id=? GROUP BY s.semantic").all(projectId) as Row[]
    for (const row of rows) bySemantic[String(row.semantic) as RequirementStateSemantic] = Number(row.count)
    const requirements = this.listRequirements(projectId)
    const states = new Map(this.listRequirementStates(projectId).map((state) => [state.id, state.semantic]))
    const emptyCounts = (): Record<RequirementStateSemantic, number> => ({ open: 0, partial: 0, proven: 0, defect: 0 })
    const byCapability = new Map<string, RequirementRollupBucket>()
    const byGoal = new Map<string, RequirementRollupBucket>()
    const byMilestone = new Map<string, RequirementRollupBucket>()
    const addTo = (target: Map<string, RequirementRollupBucket>, key: string, name: string, requirement: Requirement, stableKey?: string) => {
      const existing = target.get(key) ?? { id: key, name, ...(stableKey ? { stableKey } : {}), counts: emptyCounts(), total: 0 }
      const semantic = states.get(requirement.stateId) ?? 'open'
      existing.counts[semantic] += 1
      existing.total += 1
      target.set(key, existing)
    }
    const requirementsById = new Map(requirements.map((requirement) => [requirement.id, requirement]))
    for (const requirement of requirements) {
      const ancestors = new Set<string>()
      let parentId = requirement.parentId
      while (parentId && !ancestors.has(parentId)) {
        ancestors.add(parentId)
        const parent = requirementsById.get(parentId)
        if (!parent) break
        if (parent.kind === 'capability') addTo(byCapability, parent.id, parent.title, requirement, parent.stableKey)
        if (parent.kind === 'goal') addTo(byGoal, parent.id, parent.title, requirement, parent.stableKey)
        parentId = parent.parentId
      }
      if (requirement.kind === 'capability') addTo(byCapability, requirement.id, requirement.title, requirement, requirement.stableKey)
      if (requirement.kind === 'goal') addTo(byGoal, requirement.id, requirement.title, requirement, requirement.stableKey)
      const phaseIds = new Set([...(requirement.responsiblePhaseId ? [requirement.responsiblePhaseId] : []), ...requirement.relatedPhaseIds])
      for (const phaseId of phaseIds) {
        const phase = this.db.prepare('SELECT id,name FROM phases WHERE id=? AND project_id=?').get(phaseId, projectId) as Row | undefined
        if (phase) addTo(byMilestone, String(phase.id), String(phase.name), requirement)
      }
    }
    return {
      total: requirements.length,
      bySemantic,
      gateFailures: requirements.filter((requirement) => requirement.gate === 'unsatisfied').length,
      defects: bySemantic.defect,
      byCapability: [...byCapability.values()].sort((left, right) => left.name.localeCompare(right.name)),
      byMilestone: [...byMilestone.values()].sort((left, right) => left.name.localeCompare(right.name)),
      byGoal: [...byGoal.values()].sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

  listWorkQueues(projectId: string): WorkQueue[] {
    this.project(projectId)
    return (this.db.prepare('SELECT * FROM work_queues WHERE project_id=? ORDER BY created_at').all(projectId) as Row[]).map((row) => ({ id: String(row.id), projectId: String(row.project_id), name: String(row.name), description: textOrNull(row.description), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }))
  }

  createWorkQueue(projectId: string, input: CreateWorkQueueInput): WorkQueue {
    this.project(projectId)
    const id = randomUUID(); const timestamp = now()
    try { this.db.prepare('INSERT INTO work_queues(id,project_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, projectId, input.name, input.description ?? null, timestamp, timestamp) } catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'Could not create work queue') }
    return this.listWorkQueues(projectId).find((queue) => queue.id === id)!
  }

  private workItemFromRow(row: Row): WorkItem {
    const id = String(row.id)
    const labels = (this.db.prepare('SELECT l.* FROM labels l JOIN work_item_labels wil ON wil.label_id=l.id WHERE wil.work_item_id=? ORDER BY l.name COLLATE NOCASE').all(id) as Row[]).map((label) => ({ id: String(label.id), name: String(label.name), colour: textOrNull(label.colour), version: Number(label.version), createdAt: String(label.created_at), updatedAt: String(label.updated_at) }))
    const reasons: string[] = []
    const dependencyRows = this.db.prepare("SELECT wi.title,wr.kind FROM work_relations wr JOIN work_items wi ON ((wr.kind='depends_on' AND wi.id=wr.to_work_item_id) OR (wr.kind='blocks' AND wi.id=wr.from_work_item_id)) WHERE ((wr.kind='depends_on' AND wr.from_work_item_id=?) OR (wr.kind='blocks' AND wr.to_work_item_id=?)) AND wi.status NOT IN ('resolved','dropped')").all(id, id) as Row[]
    if (dependencyRows.length) reasons.push(...dependencyRows.map((entry) => `${String(entry.kind) === 'blocks' ? 'Blocked by' : 'Depends on'} ${String(entry.title)}`))
    const external = this.db.prepare('SELECT content FROM external_blockers WHERE work_item_id=? AND resolved_at IS NULL').all(id) as Row[]
    if (external.length) reasons.push(...external.map((entry) => String(entry.content)))
    return {
      id, projectId: String(row.project_id), phaseId: textOrNull(row.phase_id), kind: String(row.kind) as WorkItem['kind'], title: String(row.title), description: textOrNull(row.description), status: String(row.status) as WorkItem['status'], priority: textOrNull(row.priority) as WorkItem['priority'], labels, version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at), stableKey: textOrNull(row.stable_key), parentId: textOrNull(row.parent_id), queueId: textOrNull(row.queue_id), rank: textOrNull(row.rank), effectiveBlocked: reasons.length > 0 || String(row.status) === 'blocked', blockerReasons: reasons,
    }
  }

  listWorkItems(projectId: string, queueId?: string): WorkItem[] {
    this.project(projectId)
    const rows = (queueId
      ? this.db.prepare('SELECT wi.*,wqi.queue_id,wqi.rank FROM work_items wi JOIN work_queue_items wqi ON wqi.work_item_id=wi.id WHERE wi.project_id=? AND wqi.queue_id=? ORDER BY wqi.rank,wqi.work_item_id').all(projectId, queueId)
      : this.db.prepare('SELECT wi.*,wqi.queue_id,wqi.rank FROM work_items wi LEFT JOIN work_queue_items wqi ON wqi.work_item_id=wi.id WHERE wi.project_id=? ORDER BY COALESCE(wqi.rank,\'\uffff\'),wi.updated_at DESC').all(projectId)) as Row[]
    return rows.map((row) => this.workItemFromRow(row))
  }

  listWorkItemsPage(projectId: string, limit: number, cursor?: string | null, queueId?: string): Page<WorkItem> {
    return pageOf(this.listWorkItems(projectId, queueId), limit, cursor)
  }

  private assertWorkPair(projectId: string, fromId: string, toId: string): void {
    if (fromId === toId) throw new ValidationError('A work item cannot relate to itself')
    this.assertProjectEntity('work_items', fromId, projectId); this.assertProjectEntity('work_items', toId, projectId)
  }

  private dependencyWouldCycle(fromId: string, toId: string): boolean {
    const result = this.db.prepare(`WITH RECURSIVE dependencies(dependent,dependency) AS (
      SELECT from_work_item_id,to_work_item_id FROM work_relations WHERE kind='depends_on'
      UNION ALL
      SELECT to_work_item_id,from_work_item_id FROM work_relations WHERE kind='blocks'
    ), reachable(id) AS (
      SELECT dependency FROM dependencies WHERE dependent=?
      UNION
      SELECT d.dependency FROM dependencies d JOIN reachable r ON r.id=d.dependent
    ) SELECT 1 FROM reachable WHERE id=? LIMIT 1`).get(toId, fromId)
    return Boolean(result)
  }

  linkWorkItems(projectId: string, input: CreateWorkRelationInput): WorkRelation {
    this.assertWorkPair(projectId, input.fromWorkItemId, input.toWorkItemId)
    if (input.kind === 'depends_on' && this.dependencyWouldCycle(input.fromWorkItemId, input.toWorkItemId)) throw new ValidationError('Dependency would create a cycle')
    if (input.kind === 'blocks' && this.dependencyWouldCycle(input.toWorkItemId, input.fromWorkItemId)) throw new ValidationError('Blocking relationship would create a cycle')
    const id = randomUUID(); const timestamp = now()
    try { this.db.prepare('INSERT INTO work_relations(id,project_id,from_work_item_id,to_work_item_id,kind,created_at) VALUES (?,?,?,?,?,?)').run(id, projectId, input.fromWorkItemId, input.toWorkItemId, input.kind, timestamp) } catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'Could not create work relation') }
    return { id, projectId, fromWorkItemId: input.fromWorkItemId, toWorkItemId: input.toWorkItemId, kind: input.kind, createdAt: timestamp }
  }

  unlinkWorkItems(id: string): void { this.db.prepare('DELETE FROM work_relations WHERE id=?').run(id) }

  listWorkRelations(projectId: string): WorkRelation[] {
    return (this.db.prepare('SELECT * FROM work_relations WHERE project_id=? ORDER BY created_at,id').all(projectId) as Row[]).map((row) => ({ id: String(row.id), projectId: String(row.project_id), fromWorkItemId: String(row.from_work_item_id), toWorkItemId: String(row.to_work_item_id), kind: String(row.kind) as WorkRelation['kind'], createdAt: String(row.created_at) }))
  }

  createExternalBlocker(projectId: string, input: CreateExternalBlockerInput): ExternalBlocker {
    this.project(projectId)
    if (input.workItemId) this.assertProjectEntity('work_items', input.workItemId, projectId)
    const id = randomUUID(); const timestamp = now()
    this.db.prepare('INSERT INTO external_blockers(id,project_id,work_item_id,content,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, projectId, input.workItemId ?? null, input.content, timestamp, timestamp)
    return { id, projectId, workItemId: input.workItemId ?? null, content: input.content, resolvedAt: null, createdAt: timestamp, updatedAt: timestamp }
  }

  listExternalBlockers(projectId: string, includeResolved = false): ExternalBlocker[] {
    const rows = (includeResolved ? this.db.prepare('SELECT * FROM external_blockers WHERE project_id=? ORDER BY created_at DESC') : this.db.prepare('SELECT * FROM external_blockers WHERE project_id=? AND resolved_at IS NULL ORDER BY created_at DESC')).all(projectId) as Row[]
    return rows.map((row) => ({ id: String(row.id), projectId: String(row.project_id), workItemId: textOrNull(row.work_item_id), content: String(row.content), resolvedAt: textOrNull(row.resolved_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }))
  }

  resolveExternalBlocker(id: string): ExternalBlocker {
    const current = this.db.prepare('SELECT * FROM external_blockers WHERE id=?').get(id) as Row | undefined
    if (!current) throw new NotFoundError('External blocker', id)
    const timestamp = now(); this.db.prepare('UPDATE external_blockers SET resolved_at=?,updated_at=? WHERE id=?').run(timestamp, timestamp, id)
    return { id, projectId: String(current.project_id), workItemId: textOrNull(current.work_item_id), content: String(current.content), resolvedAt: timestamp, createdAt: String(current.created_at), updatedAt: timestamp }
  }

  createWorkspace(input: CreateWorkspaceInput): Workspace {
    const id = randomUUID(); const timestamp = now(); const root = resolve(input.canonicalRoot); const aliases = [...new Set((input.aliases ?? []).map((entry) => resolve(entry)))]
    return this.transaction(() => {
      try { this.db.prepare('INSERT INTO workspaces(id,name,canonical_root,remote,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, input.name, root, input.remote ?? null, timestamp, timestamp) } catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'Could not create workspace') }
      for (const alias of aliases) this.db.prepare('INSERT INTO workspace_aliases(workspace_id,alias,created_at) VALUES (?,?,?)').run(id, alias, timestamp)
      return { id, name: input.name, canonicalRoot: root, aliases, remote: input.remote ?? null, createdAt: timestamp, updatedAt: timestamp }
    })
  }

  linkProjectWorkspace(projectId: string, workspaceId: string): void {
    this.project(projectId)
    if (!this.db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspaceId)) throw new NotFoundError('Workspace', workspaceId)
    this.db.prepare('INSERT OR IGNORE INTO project_workspaces(project_id,workspace_id,created_at) VALUES (?,?,?)').run(projectId, workspaceId, now())
  }

  createWorkspaceRevision(input: CreateWorkspaceRevisionInput): WorkspaceRevision {
    if (!this.db.prepare('SELECT id FROM workspaces WHERE id=?').get(input.workspaceId)) throw new NotFoundError('Workspace', input.workspaceId)
    const id = randomUUID(); const capturedAt = now()
    this.db.prepare('INSERT INTO workspace_revisions(id,workspace_id,branch,"commit",dirty,diff_hash,captured_at) VALUES (?,?,?,?,?,?,?)').run(id, input.workspaceId, input.branch ?? null, input.commit ?? null, input.dirty ? 1 : 0, input.diffHash ?? null, capturedAt)
    return { id, workspaceId: input.workspaceId, branch: input.branch ?? null, commit: input.commit ?? null, dirty: input.dirty, diffHash: input.diffHash ?? null, capturedAt }
  }

  resolveProject(workspacePath: string): Project[] {
    const target = resolve(workspacePath)
    const rows = this.db.prepare(`SELECT p.* FROM projects p JOIN project_workspaces pw ON pw.project_id=p.id JOIN workspaces w ON w.id=pw.workspace_id WHERE w.canonical_root=? OR EXISTS (SELECT 1 FROM workspace_aliases wa WHERE wa.workspace_id=w.id AND wa.alias=?)`).all(target, target) as Row[]
    const enclosing = this.db.prepare(`SELECT p.*,w.canonical_root FROM projects p JOIN project_workspaces pw ON pw.project_id=p.id JOIN workspaces w ON w.id=pw.workspace_id WHERE ?=w.canonical_root OR ? LIKE w.canonical_root || '/%' ORDER BY length(w.canonical_root) DESC`).all(target, target) as Row[]
    const selected = enclosing.length ? enclosing.filter((row, index, all) => index === 0 || String(row.canonical_root).length === String(all[0]?.canonical_root).length) : rows
    return selected.map((row) => ({ id: String(row.id), title: String(row.title), description: textOrNull(row.description), intent: textOrNull(row.intent), deadline: textOrNull(row.deadline), completionCriteria: textOrNull(row.completion_criteria), state: String(row.state) as Project['state'], currentFocus: textOrNull(row.current_focus), nextAction: textOrNull(row.next_action), blockers: json<string[]>(row.blockers_json, []), currentCheckpointId: textOrNull(row.current_checkpoint_id), archivedAt: textOrNull(row.archived_at), version: Number(row.version), createdAt: String(row.created_at), updatedAt: String(row.updated_at), lastActivityAt: String(row.last_activity_at) }))
  }

  private redactExcerpt(value: string | null | undefined): string | null {
    if (!value) return null
    return value
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"']+/gi, '$1[REDACTED]')
      .replace(/(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, '$1=[REDACTED]')
      .slice(0, 32_768)
  }

  createRun(projectId: string, input: CreateRunInput): { run: Run; testSummary: TestSummary | null; artifacts: ArtifactReference[] } {
    this.project(projectId)
    if (input.workspaceRevisionId && !this.db.prepare('SELECT wr.id FROM workspace_revisions wr JOIN project_workspaces pw ON pw.workspace_id=wr.workspace_id WHERE wr.id=? AND pw.project_id=?').get(input.workspaceRevisionId, projectId)) throw new ValidationError('Workspace revision does not belong to the project')
    const id = randomUUID(); const createdAt = now(); const startedAt = input.startedAt ?? createdAt; const endedAt = input.endedAt ?? (input.outcome === 'recorded' ? null : createdAt); const durationMs = endedAt ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()) : null; const command = this.redactExcerpt(input.command) ?? input.command
    return this.transaction(() => {
      this.db.prepare('INSERT INTO runs(id,project_id,workspace_revision_id,command,working_directory,started_at,ended_at,duration_ms,outcome,exit_code,toolchain_json,stdout_excerpt,stderr_excerpt,stdout_truncated,stderr_truncated,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, input.workspaceRevisionId ?? null, command, input.workingDirectory ?? null, startedAt, endedAt, durationMs, input.outcome, input.exitCode ?? null, JSON.stringify(input.toolchain ?? {}), this.redactExcerpt(input.stdoutExcerpt), this.redactExcerpt(input.stderrExcerpt), input.stdoutTruncated ? 1 : 0, input.stderrTruncated ? 1 : 0, createdAt)
      let testSummary: TestSummary | null = null
      if (input.testSummary) { const summaryId = randomUUID(); this.db.prepare('INSERT INTO test_summaries(id,run_id,scope,passed,failed,skipped,target_count,created_at) VALUES (?,?,?,?,?,?,?,?)').run(summaryId, id, input.testSummary.scope, input.testSummary.passed, input.testSummary.failed, input.testSummary.skipped, input.testSummary.targetCount, createdAt); testSummary = { id: summaryId, runId: id, ...input.testSummary, createdAt } }
      const artifacts = (input.artifacts ?? []).map((artifact) => {
        const artifactId = randomUUID()
        this.db.prepare('INSERT INTO artifact_references(id,run_id,uri,media_type,byte_count,digest,created_at) VALUES (?,?,?,?,?,?,?)').run(artifactId, id, artifact.uri, artifact.mediaType ?? null, artifact.byteCount ?? null, artifact.digest ?? null, createdAt)
        return { id: artifactId, runId: id, uri: artifact.uri, mediaType: artifact.mediaType ?? null, byteCount: artifact.byteCount ?? null, digest: artifact.digest ?? null, createdAt }
      })
      const run: Run = { id, projectId, workspaceRevisionId: input.workspaceRevisionId ?? null, command, workingDirectory: input.workingDirectory ?? null, startedAt, endedAt, durationMs, outcome: input.outcome, exitCode: input.exitCode ?? null, toolchain: input.toolchain ?? {}, stdoutExcerpt: this.redactExcerpt(input.stdoutExcerpt), stderrExcerpt: this.redactExcerpt(input.stderrExcerpt), stdoutTruncated: Boolean(input.stdoutTruncated), stderrTruncated: Boolean(input.stderrTruncated), artifacts, createdAt }
      return { run, testSummary, artifacts }
    })
  }

  private artifactsForRun(runId: string): ArtifactReference[] {
    return (this.db.prepare('SELECT * FROM artifact_references WHERE run_id=? ORDER BY created_at,id').all(runId) as Row[]).map((row) => ({ id: String(row.id), runId: textOrNull(row.run_id), uri: String(row.uri), mediaType: textOrNull(row.media_type), byteCount: row.byte_count === null ? null : Number(row.byte_count), digest: textOrNull(row.digest), createdAt: String(row.created_at) }))
  }

  listRuns(projectId: string): Run[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE project_id=? ORDER BY started_at DESC,id DESC').all(projectId) as Row[]
    return rows.map((row) => ({ id: String(row.id), projectId: String(row.project_id), workspaceRevisionId: textOrNull(row.workspace_revision_id), command: String(row.command), workingDirectory: textOrNull(row.working_directory), startedAt: String(row.started_at), endedAt: textOrNull(row.ended_at), durationMs: row.duration_ms === null ? null : Number(row.duration_ms), outcome: String(row.outcome) as Run['outcome'], exitCode: row.exit_code === null ? null : Number(row.exit_code), toolchain: json<Record<string, string>>(row.toolchain_json, {}), stdoutExcerpt: textOrNull(row.stdout_excerpt), stderrExcerpt: textOrNull(row.stderr_excerpt), stdoutTruncated: bool(row.stdout_truncated), stderrTruncated: bool(row.stderr_truncated), artifacts: this.artifactsForRun(String(row.id)), createdAt: String(row.created_at) }))
  }

  listRunsPage(projectId: string, limit: number, cursor?: string | null): Page<Run> {
    return pageOf(this.listRuns(projectId), limit, cursor)
  }

  createEvidence(projectId: string, input: CreateEvidenceInput): Evidence {
    this.project(projectId)
    const id = randomUUID(); const timestamp = now()
    for (const requirementId of input.requirementIds ?? []) this.assertProjectEntity('requirements', requirementId, projectId)
    for (const workItemId of input.workItemIds ?? []) this.assertProjectEntity('work_items', workItemId, projectId)
    for (const updateId of [...(input.updateIds ?? []), ...(input.checkpointIds ?? [])]) this.assertProjectEntity('updates', updateId, projectId)
    if (input.runId && !this.db.prepare('SELECT id FROM runs WHERE id=? AND project_id=?').get(input.runId, projectId)) throw new ValidationError('Run does not belong to the project')
    return this.transaction(() => {
      this.db.prepare('INSERT INTO evidence(id,project_id,run_id,result,summary,target_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, projectId, input.runId ?? null, input.result, input.summary, input.targetVersion ?? null, timestamp, timestamp)
      for (const requirementId of new Set(input.requirementIds ?? [])) this.db.prepare('INSERT INTO evidence_requirement_links(evidence_id,requirement_id) VALUES (?,?)').run(id, requirementId)
      for (const workItemId of new Set(input.workItemIds ?? [])) this.db.prepare('INSERT INTO evidence_work_links(evidence_id,work_item_id) VALUES (?,?)').run(id, workItemId)
      for (const updateId of new Set(input.updateIds ?? [])) this.db.prepare('INSERT INTO evidence_update_links(evidence_id,update_id) VALUES (?,?)').run(id, updateId)
      for (const checkpointId of new Set(input.checkpointIds ?? [])) this.db.prepare('INSERT INTO evidence_checkpoint_links(evidence_id,checkpoint_id) VALUES (?,?)').run(id, checkpointId)
      for (const artifact of input.artifacts ?? []) {
        const artifactId = randomUUID()
        this.db.prepare('INSERT INTO artifact_references(id,run_id,uri,media_type,byte_count,digest,created_at) VALUES (?,?,?,?,?,?,?)').run(artifactId, input.runId ?? null, artifact.uri, artifact.mediaType ?? null, artifact.byteCount ?? null, artifact.digest ?? null, timestamp)
        this.db.prepare('INSERT INTO evidence_artifact_links(evidence_id,artifact_id) VALUES (?,?)').run(id, artifactId)
      }
      return this.evidenceFromRow(this.db.prepare('SELECT * FROM evidence WHERE id=?').get(id) as Row)
    })
  }

  private artifactsForEvidence(evidenceId: string): ArtifactReference[] {
    return (this.db.prepare('SELECT a.* FROM artifact_references a JOIN evidence_artifact_links l ON l.artifact_id=a.id WHERE l.evidence_id=? ORDER BY a.created_at,a.id').all(evidenceId) as Row[]).map((row) => ({
      id: String(row.id), runId: textOrNull(row.run_id), uri: String(row.uri), mediaType: textOrNull(row.media_type), byteCount: row.byte_count === null ? null : Number(row.byte_count), digest: textOrNull(row.digest), createdAt: String(row.created_at),
    }))
  }

  private evidenceFromRow(row: Row): Evidence {
    const id = String(row.id)
    const targetVersion = row.target_version === null ? null : Number(row.target_version)
    let stale = bool(row.stale)
    let staleReason = textOrNull(row.stale_reason)
    if (targetVersion !== null) {
      const versions = [
        ...(this.db.prepare('SELECT version FROM requirements r JOIN evidence_requirement_links l ON l.requirement_id=r.id WHERE l.evidence_id=?').all(id) as Row[]),
        ...(this.db.prepare('SELECT version FROM work_items w JOIN evidence_work_links l ON l.work_item_id=w.id WHERE l.evidence_id=?').all(id) as Row[]),
        ...(this.db.prepare('SELECT version FROM updates u JOIN evidence_update_links l ON l.update_id=u.id WHERE l.evidence_id=?').all(id) as Row[]),
        ...(this.db.prepare('SELECT version FROM updates u JOIN evidence_checkpoint_links l ON l.checkpoint_id=u.id WHERE l.evidence_id=?').all(id) as Row[]),
      ].map((entry) => Number(entry.version))
      const currentVersion = versions.length ? Math.max(...versions) : targetVersion
      stale = currentVersion > targetVersion
      staleReason = stale ? `Linked entity advanced from version ${targetVersion} to ${currentVersion}` : null
    }
    return { id, projectId: String(row.project_id), runId: textOrNull(row.run_id), result: String(row.result) as Evidence['result'], summary: String(row.summary), targetVersion, stale, staleReason, createdAt: String(row.created_at), updatedAt: String(row.updated_at), requirementIds: (this.db.prepare('SELECT requirement_id FROM evidence_requirement_links WHERE evidence_id=?').all(id) as Row[]).map((entry) => String(entry.requirement_id)), workItemIds: (this.db.prepare('SELECT work_item_id FROM evidence_work_links WHERE evidence_id=?').all(id) as Row[]).map((entry) => String(entry.work_item_id)), updateIds: (this.db.prepare('SELECT update_id FROM evidence_update_links WHERE evidence_id=?').all(id) as Row[]).map((entry) => String(entry.update_id)), checkpointIds: (this.db.prepare('SELECT checkpoint_id FROM evidence_checkpoint_links WHERE evidence_id=?').all(id) as Row[]).map((entry) => String(entry.checkpoint_id)), artifacts: this.artifactsForEvidence(id) }
  }

  listEvidence(projectId: string, includeStale = false): Evidence[] {
    this.project(projectId)
    const evidence = (this.db.prepare('SELECT * FROM evidence WHERE project_id=? ORDER BY created_at DESC,id DESC').all(projectId) as Row[]).map((row) => this.evidenceFromRow(row))
    return includeStale ? evidence : evidence.filter((entry) => !entry.stale)
  }

  listEvidencePage(projectId: string, limit: number, cursor?: string | null, includeStale = false): Page<Evidence> {
    return pageOf(this.listEvidence(projectId, includeStale), limit, cursor)
  }

  captureCheckpointSnapshot(projectId: string, checkpointId: string): CheckpointSnapshot {
    this.project(projectId)
    if (!this.db.prepare("SELECT id FROM updates WHERE id=? AND project_id=? AND kind='checkpoint'").get(checkpointId, projectId)) throw new ValidationError('Checkpoint does not belong to the project')
    const existing = this.getCheckpointSnapshot(checkpointId)
    if (existing) return existing
    const project = this.project(projectId)
    const phases = this.db.prepare('SELECT * FROM phases WHERE project_id=? ORDER BY position,id').all(projectId) as Row[]
    const requirements = this.listRequirements(projectId)
    const workItems = this.listWorkItems(projectId)
    const queues = this.listWorkQueues(projectId)
    const relations = this.listWorkRelations(projectId)
    const blockers = this.listExternalBlockers(projectId, true)
    const workspaces = this.db.prepare('SELECT w.*,pw.project_id FROM workspaces w JOIN project_workspaces pw ON pw.workspace_id=w.id WHERE pw.project_id=?').all(projectId) as Row[]
    const evidence = this.listEvidence(projectId, true)
    const document = { project, phases, requirements, workItems, queues, relations, blockers, workspaces, evidenceHeads: evidence.map((entry) => ({ id: entry.id, result: entry.result, stale: entry.stale, updatedAt: entry.updatedAt })) }
    const encoded = JSON.stringify(document)
    const digest = createHash('sha256').update(encoded).digest('hex')
    const id = randomUUID(); const capturedAt = now()
    try {
      this.db.prepare('INSERT INTO checkpoint_snapshots(id,checkpoint_id,schema_version,captured_at,document_json,digest) VALUES (?,?,?,?,?,?)').run(id, checkpointId, 2, capturedAt, encoded, digest)
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) return this.getCheckpointSnapshot(checkpointId)!
      throw error
    }
    return { id, checkpointId, schemaVersion: 2, capturedAt, document, digest }
  }

  getCheckpointSnapshot(checkpointId: string): CheckpointSnapshot | null {
    const row = this.db.prepare('SELECT * FROM checkpoint_snapshots WHERE checkpoint_id=?').get(checkpointId) as Row | undefined
    if (!row) return null
    return { id: String(row.id), checkpointId: String(row.checkpoint_id), schemaVersion: 2, capturedAt: String(row.captured_at), document: json<Record<string, unknown>>(row.document_json, {}), digest: String(row.digest) }
  }

  compareCheckpointSnapshots(leftCheckpointId: string, rightCheckpointId: string): CheckpointComparison {
    const left = this.getCheckpointSnapshot(leftCheckpointId)
    const right = this.getCheckpointSnapshot(rightCheckpointId)
    if (!left || !right) throw new NotFoundError('Checkpoint snapshot', !left ? leftCheckpointId : rightCheckpointId)
    const sections = new Set([...Object.keys(left.document), ...Object.keys(right.document)])
    const changedSections = [...sections].filter((section) => JSON.stringify(left.document[section]) !== JSON.stringify(right.document[section])).sort()
    return { leftCheckpointId, rightCheckpointId, same: changedSections.length === 0, changedSections, leftDigest: left.digest, rightDigest: right.digest }
  }

  reconstructCheckpointState(checkpointId: string): Record<string, unknown> | null {
    return this.getCheckpointSnapshot(checkpointId)?.document ?? null
  }

  getProjectPulseSummary(projectId: string): ProjectPulseSummary | null {
    const projectRow = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as Row | undefined
    if (!projectRow) return null
    const project: Project = { id: String(projectRow.id), title: String(projectRow.title), description: textOrNull(projectRow.description), intent: textOrNull(projectRow.intent), deadline: textOrNull(projectRow.deadline), completionCriteria: textOrNull(projectRow.completion_criteria), state: String(projectRow.state) as Project['state'], currentFocus: textOrNull(projectRow.current_focus), nextAction: textOrNull(projectRow.next_action), blockers: json<string[]>(projectRow.blockers_json, []), currentCheckpointId: textOrNull(projectRow.current_checkpoint_id), archivedAt: textOrNull(projectRow.archived_at), version: Number(projectRow.version), createdAt: String(projectRow.created_at), updatedAt: String(projectRow.updated_at), lastActivityAt: String(projectRow.last_activity_at) }
    const checkpoint = project.currentCheckpointId ? this.db.prepare('SELECT u.id,r.content,u.created_at FROM updates u JOIN update_revisions r ON r.id=u.current_revision_id WHERE u.id=?').get(project.currentCheckpointId) as Row | undefined : undefined
    const activePhases = (this.db.prepare("SELECT id,name,status FROM phases WHERE project_id=? AND status='active' AND archived_at IS NULL ORDER BY position,id").all(projectId) as Row[]).map((row) => ({ id: String(row.id), name: String(row.name), status: String(row.status) as 'active' }))
    const queue = this.listWorkQueues(projectId)[0]
    const queueHead = queue ? this.listWorkItems(projectId, queue.id).filter((item) => !['resolved', 'dropped'].includes(item.status)).slice(0, 10) : []
    const blockers = this.listExternalBlockers(projectId)
    const evidence = this.listEvidence(projectId, true)
    return { project, currentCheckpoint: checkpoint ? { id: String(checkpoint.id), content: String(checkpoint.content), createdAt: String(checkpoint.created_at) } : null, activePhases, requirementRollup: this.getRequirementRollup(projectId), queueHead, blockers, staleEvidenceCount: evidence.filter((entry) => entry.stale).length, failedEvidenceCount: evidence.filter((entry) => entry.result === 'failed').length }
  }

  search(query: string, limit = 50, filters: SearchFilters = {}): SearchResult[] {
    const term = `%${query.trim()}%`
    if (!query.trim()) return []
    const types = filters.entityTypes ? new Set(filters.entityTypes) : null
    const results: SearchResult[] = []
    const projectClause = filters.projectId ? ' AND r.project_id=?' : ''
    const projectArgs = filters.projectId ? [filters.projectId] : []
    const searchRequirements = (!types || types.has('requirement')) && !filters.requirementId && !filters.evidenceResult
    const searchWorkItems = (!types || types.has('work_item')) && !filters.evidenceResult
    const searchRuns = (!types || types.has('run')) && !filters.state && !filters.phaseId && !filters.requirementId && !filters.evidenceResult
    const searchEvidence = (!types || types.has('evidence')) && !filters.state && !filters.phaseId && !filters.requirementId
    if (searchRequirements) {
      const rows = this.db.prepare(`SELECT r.id,r.project_id,r.stable_key,r.title,r.description FROM requirements r JOIN requirement_states s ON s.id=r.state_id WHERE (r.title LIKE ? OR COALESCE(r.description,'') LIKE ?)${projectClause}${filters.state ? ' AND (s.semantic=? OR s.name=?)' : ''}${filters.phaseId ? " AND (r.responsible_phase_id=? OR EXISTS (SELECT 1 FROM requirement_phase_links l WHERE l.requirement_id=r.id AND l.phase_id=?))" : ''}${filters.from ? ' AND r.created_at>=?' : ''}${filters.to ? ' AND r.created_at<=?' : ''} ORDER BY r.updated_at DESC LIMIT ?`).all(term, term, ...projectArgs, ...(filters.state ? [filters.state, filters.state] : []), ...(filters.phaseId ? [filters.phaseId, filters.phaseId] : []), ...(filters.from ? [filters.from] : []), ...(filters.to ? [filters.to] : []), limit) as Row[]
      for (const row of rows) results.push({ type: 'requirement', id: String(row.id), projectId: String(row.project_id), title: `${String(row.stable_key)} ${String(row.title)}`, excerpt: textOrNull(row.description) ?? '', score: 0 })
    }
    if (searchWorkItems) {
      const rows = this.db.prepare(`SELECT w.id,w.project_id,w.title,w.description FROM work_items w WHERE (w.title LIKE ? OR COALESCE(w.description,'') LIKE ?)${filters.projectId ? ' AND w.project_id=?' : ''}${filters.state ? ' AND w.status=?' : ''}${filters.phaseId ? ' AND w.phase_id=?' : ''}${filters.requirementId ? ' AND EXISTS (SELECT 1 FROM requirement_work_links l WHERE l.work_item_id=w.id AND l.requirement_id=?)' : ''}${filters.from ? ' AND w.created_at>=?' : ''}${filters.to ? ' AND w.created_at<=?' : ''} ORDER BY w.updated_at DESC LIMIT ?`).all(term, term, ...(filters.projectId ? [filters.projectId] : []), ...(filters.state ? [filters.state] : []), ...(filters.phaseId ? [filters.phaseId] : []), ...(filters.requirementId ? [filters.requirementId] : []), ...(filters.from ? [filters.from] : []), ...(filters.to ? [filters.to] : []), limit) as Row[]
      for (const row of rows) results.push({ type: 'work_item', id: String(row.id), projectId: String(row.project_id), title: String(row.title), excerpt: textOrNull(row.description) ?? '', score: 0 })
    }
    if (searchRuns) {
      const rows = this.db.prepare(`SELECT id,project_id,command,stdout_excerpt,stderr_excerpt FROM runs WHERE (command LIKE ? OR COALESCE(stdout_excerpt,'') LIKE ? OR COALESCE(stderr_excerpt,'') LIKE ?)${filters.projectId ? ' AND project_id=?' : ''}${filters.from ? ' AND created_at>=?' : ''}${filters.to ? ' AND created_at<=?' : ''} ORDER BY created_at DESC LIMIT ?`).all(term, term, term, ...(filters.projectId ? [filters.projectId] : []), ...(filters.from ? [filters.from] : []), ...(filters.to ? [filters.to] : []), limit) as Row[]
      for (const row of rows) results.push({ type: 'run', id: String(row.id), projectId: String(row.project_id), title: String(row.command), excerpt: textOrNull(row.stderr_excerpt) ?? textOrNull(row.stdout_excerpt) ?? '', score: 0 })
    }
    if (searchEvidence) {
      const rows = this.db.prepare(`SELECT id,project_id,summary,result FROM evidence WHERE summary LIKE ?${filters.projectId ? ' AND project_id=?' : ''}${filters.evidenceResult ? ' AND result=?' : ''}${filters.from ? ' AND created_at>=?' : ''}${filters.to ? ' AND created_at<=?' : ''} ORDER BY created_at DESC LIMIT ?`).all(term, ...(filters.projectId ? [filters.projectId] : []), ...(filters.evidenceResult ? [filters.evidenceResult] : []), ...(filters.from ? [filters.from] : []), ...(filters.to ? [filters.to] : []), limit) as Row[]
      for (const row of rows) results.push({ type: 'evidence', id: String(row.id), projectId: String(row.project_id), title: String(row.result), excerpt: String(row.summary), score: 0 })
    }
    return results.slice(0, Math.min(Math.max(limit, 1), 200))
  }
}
