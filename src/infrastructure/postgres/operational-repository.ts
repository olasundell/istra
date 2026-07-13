import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  AcceptanceCriterion, ActivityEvent, ArtifactReference, CheckpointComparison, CheckpointSnapshot,
  CreateErrorReportInput, CreateEvidenceInput, CreateExternalBlockerInput, CreateRequirementInput,
  CreateRequirementStateInput, CreateRunInput, CreateWorkQueueInput, CreateWorkRelationInput,
  CreateWorkspaceInput, CreateWorkspaceRevisionInput, ErrorReport, Evidence, ExternalBlocker,
  MutationContext, Page, Project, ProjectPulseSummary, RedactionMetadata, Requirement,
  RequirementRollup, RequirementRollupBucket, RequirementStateDefinition, RequirementStateSemantic,
  Run, SearchFilters, SearchResult, TestSummary, UpdateErrorReportInput, UpdateRequirementInput,
  ValidationStatus, WorkItem, WorkQueue, WorkRelation, Workspace, WorkspaceRevision,
} from '../../domain/contracts.js'
import type {
  ClaimNextAutomatedWorkInput, CompleteAutomatedWorkInput, HeartbeatAutomatedWorkInput,
  OperatorReleaseAutomatedWorkInput, RecordAutomationAttemptInput, RunnerReleaseAutomatedWorkInput, UpdateQueueAutomationPolicyInput,
} from '../../domain/automation.js'
import type { Awaitable, OperationalRepository } from '../../application/ports.js'
import { ConflictError, IdempotencyConflictError, NotFoundError, ValidationError } from '../../application/errors.js'
import { pageOf } from '../../application/pagination.js'
import { evaluateCriterionProof, explainRequirementProof, type CriterionEvidenceObservation } from '../../domain/proof.js'
import { assertEvidenceInvariants, assertRunInvariants } from '../../domain/run-invariants.js'
import { SecretRedactor, type SecretRedactionResult } from '../../application/secret-redactor.js'
import { canonicalJson, canonicaliseJson } from '../../domain/canonical-json.js'
import type { PostgresExecutor } from './database.js'
import { lockProjectGraph } from './project-graph-lock.js'
import { PostgresAutomationRepository } from './automation-repository.js'

type Row = Record<string, unknown>
const now = () => new Date().toISOString()
const text = (value: unknown): string | null => value == null ? null : String(value)
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value)
const bool = (value: unknown): boolean => value === true || value === 1 || value === '1'
const json = <T>(value: unknown, fallback: T): T => {
  if (value == null) return fallback
  if (typeof value !== 'string') return value as T
  try { return JSON.parse(value) as T } catch { return fallback }
}
const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
const redactionMetadata = (entries: Array<{ field: string; result: SecretRedactionResult }>): RedactionMetadata => ({
  count: entries.reduce((total, entry) => total + entry.result.count, 0),
  fields: [...new Set(entries.flatMap((entry) => entry.result.redactions.map((redaction) => `${entry.field}:${redaction.kind}:${redaction.name}`)))],
})
const allowedProjectTables = new Set(['requirements', 'work_items', 'phases'])

async function serialMap<T, U>(values: T[], map: (value: T) => Promise<U>): Promise<U[]> {
  const results: U[] = []
  for (const value of values) results.push(await map(value))
  return results
}

function projectFromRow(row: Row): Project {
  return {
    id: String(row.id), title: String(row.title), description: text(row.description), intent: text(row.intent), deadline: text(row.deadline),
    completionCriteria: text(row.completion_criteria), state: String(row.state) as Project['state'], currentFocus: text(row.current_focus),
    nextAction: text(row.next_action), blockers: json<string[]>(row.blockers_json, []), currentCheckpointId: text(row.current_checkpoint_id),
    archivedAt: text(row.archived_at) ? iso(row.archived_at) : null, version: Number(row.version), createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at), lastActivityAt: iso(row.last_activity_at),
  }
}

export class PostgresOperationalRepository implements OperationalRepository {
  private readonly contexts = new AsyncLocalStorage<MutationContext>()
  private readonly automation: PostgresAutomationRepository

  constructor(private readonly executor: PostgresExecutor) {
    this.automation = new PostgresAutomationRepository(executor, (projectId, entityType, entityId, eventType, payload) => this.event(projectId, entityType, entityId, eventType, payload))
  }

  async runIdempotent<T>(client: string, key: string, operation: string, payload: unknown, work: () => Awaitable<T>): Promise<T> {
    return this.runMutation({ source: 'system', actor: client, client, idempotencyKey: key, occurredAt: now() }, operation, payload, work)
  }

  async runMutation<T>(context: MutationContext, operation: string, payload: unknown, work: () => Awaitable<T>): Promise<T> {
    const requestHash = createHash('sha256').update(canonicalJson(payload)).digest('hex')
    return this.executor.transaction(async () => this.contexts.run(context, async () => {
      const client = context.client ?? context.actor
      if (context.idempotencyKey) {
        const claimed = await this.executor.execute(`INSERT INTO idempotency_records(client,idempotency_key,operation,request_hash,result_json,created_at)
          VALUES ($1,$2,$3,$4,'null'::jsonb,$5) ON CONFLICT DO NOTHING`, [client, context.idempotencyKey, operation, requestHash, context.occurredAt])
        if (!claimed) {
          const existing = await this.executor.one<Row>('SELECT operation,request_hash,result_json FROM idempotency_records WHERE client=$1 AND idempotency_key=$2 FOR UPDATE', [client, context.idempotencyKey])
          if (String(existing.operation) !== operation || String(existing.request_hash) !== requestHash) throw new IdempotencyConflictError(context.idempotencyKey)
          return json<T>(existing.result_json, undefined as T)
        }
      }
      const result = await work()
      if (context.idempotencyKey) await this.executor.execute('UPDATE idempotency_records SET result_json=$3::jsonb WHERE client=$1 AND idempotency_key=$2', [client, context.idempotencyKey, JSON.stringify(result) ?? 'null'])
      return result
    }))
  }

  private context(): MutationContext {
    return this.contexts.getStore() ?? { source: 'system', actor: 'internal', client: 'internal', idempotencyKey: null, occurredAt: now() }
  }

  private async event(projectId: string | null, entityType: string, entityId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
    const context = this.context()
    await this.executor.execute(`INSERT INTO activity_events(id,project_id,entity_type,entity_id,event_type,payload_json,source,client,actor,idempotency_key,created_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`, [randomUUID(), projectId, entityType, entityId, eventType, JSON.stringify(payload), context.source, context.client ?? null, context.actor, context.idempotencyKey, context.occurredAt])
    if (projectId) await this.executor.execute('UPDATE projects SET last_activity_at=$1 WHERE id=$2', [context.occurredAt, projectId])
  }

  private async replaceSearch(type: 'requirement' | 'run' | 'evidence', id: string, projectId: string, title: string, body: string): Promise<void> {
    await this.executor.execute(`INSERT INTO search_index(entity_type,entity_id,project_id,title,body)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (entity_type,entity_id) DO UPDATE SET project_id=EXCLUDED.project_id,title=EXCLUDED.title,body=EXCLUDED.body`,
    [type, id, projectId, title, body])
  }

  private async project(projectId: string): Promise<Row> {
    const row = await this.executor.maybeOne<Row>('SELECT * FROM projects WHERE id=$1', [projectId])
    if (!row) throw new NotFoundError('Project', projectId)
    return row
  }

  private async assertProjectEntity(table: string, id: string, projectId: string): Promise<Row> {
    if (!allowedProjectTables.has(table)) throw new Error(`Unsupported project table ${table}`)
    const row = await this.executor.maybeOne<Row>(`SELECT * FROM ${table} WHERE id=$1 AND project_id=$2`, [id, projectId])
    if (!row) throw new ValidationError(`${table} must belong to the project`)
    return row
  }

  async listRequirementStates(projectId: string): Promise<RequirementStateDefinition[]> {
    await this.project(projectId)
    return (await this.executor.many<Row>('SELECT * FROM requirement_states WHERE project_id=$1 ORDER BY position,created_at', [projectId])).map((row) => ({
      id: String(row.id), projectId: String(row.project_id), name: String(row.name), semantic: String(row.semantic) as RequirementStateSemantic,
      position: Number(row.position), colour: text(row.colour), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    }))
  }

  async createRequirementState(projectId: string, input: CreateRequirementStateInput): Promise<RequirementStateDefinition> {
    await this.project(projectId)
    const id = randomUUID(); const timestamp = now()
    const position = input.position ?? Number((await this.executor.one<Row>('SELECT COALESCE(MAX(position),-1)+1 AS position FROM requirement_states WHERE project_id=$1', [projectId])).position)
    try {
      await this.executor.execute('INSERT INTO requirement_states(id,project_id,name,semantic,position,colour,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [id, projectId, input.name, input.semantic, position, input.colour ?? null, timestamp])
    } catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'Could not create requirement state') }
    await this.event(projectId, 'requirement_state', id, 'requirement_state.created', { name: input.name, semantic: input.semantic })
    return (await this.listRequirementStates(projectId)).find((state) => state.id === id)!
  }

  private async evidenceStaleness(row: Row): Promise<{ stale: boolean; staleReason: string | null }> {
    const targetVersion = row.target_version == null ? null : Number(row.target_version)
    const storedStale = bool(row.stale); const storedReason = text(row.stale_reason)
    if (targetVersion == null) return { stale: storedStale, staleReason: storedReason }
    const versions = await this.executor.many<Row>(`SELECT version FROM requirements r JOIN evidence_requirement_links l ON l.requirement_id=r.id WHERE l.evidence_id=$1
      UNION ALL SELECT version FROM work_items w JOIN evidence_work_links l ON l.work_item_id=w.id WHERE l.evidence_id=$1
      UNION ALL SELECT version FROM updates u JOIN evidence_update_links l ON l.update_id=u.id WHERE l.evidence_id=$1
      UNION ALL SELECT version FROM updates u JOIN evidence_checkpoint_links l ON l.checkpoint_id=u.id WHERE l.evidence_id=$1`, [String(row.id)])
    const current = versions.length ? Math.max(...versions.map((entry) => Number(entry.version))) : targetVersion
    const derived = current > targetVersion
    return { stale: storedStale || derived, staleReason: storedStale ? storedReason ?? 'Evidence was explicitly marked stale' : derived ? `Linked entity advanced from version ${targetVersion} to ${current}` : null }
  }

  private async criteria(requirementId: string): Promise<AcceptanceCriterion[]> {
    const rows = await this.executor.many<Row>('SELECT * FROM acceptance_criteria WHERE requirement_id=$1 ORDER BY archived_at IS NOT NULL,position,created_at', [requirementId])
    return serialMap(rows, async (row) => {
      const observations = await serialMap(await this.executor.many<Row>(`SELECT e.*,l.criterion_version FROM evidence_criterion_links l JOIN evidence e ON e.id=l.evidence_id WHERE l.criterion_id=$1 ORDER BY e.ordinal DESC`, [row.id]), async (entry): Promise<CriterionEvidenceObservation> => {
        const effective = await this.evidenceStaleness(entry)
        return { id: String(entry.id), ordinal: Number(entry.ordinal), result: String(entry.result) as Evidence['result'], createdAt: iso(entry.created_at), stale: effective.stale || Number(entry.criterion_version) !== Number(row.version), validationStatus: String(entry.validation_status) as ValidationStatus }
      })
      const proof = evaluateCriterionProof({ id: String(row.id), title: String(row.title), required: bool(row.required), evidence: observations })
      const archivedAt = row.archived_at == null ? null : iso(row.archived_at)
      return { id: String(row.id), requirementId: String(row.requirement_id), title: String(row.title), description: text(row.description), position: Number(row.position), required: bool(row.required), version: Number(row.version), archivedAt, proofStatus: proof.status, proofEvidenceId: proof.evidenceId, proofReason: archivedAt ? 'Criterion is archived and does not participate in requirement proof' : proof.reason, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
    })
  }

  private async requirementFromRow(row: Row): Promise<Requirement> {
    const id = String(row.id)
    const related = await this.executor.many<Row>("SELECT phase_id FROM requirement_phase_links WHERE requirement_id=$1 AND role='related' ORDER BY phase_id", [id])
    const work = await this.executor.many<Row>('SELECT work_item_id FROM requirement_work_links WHERE requirement_id=$1 ORDER BY work_item_id', [id])
    const evidence = await this.executor.many<Row>('SELECT evidence_id FROM evidence_requirement_links WHERE requirement_id=$1 ORDER BY evidence_id', [id])
    const criteria = await this.criteria(id)
    const proofExplanation = explainRequirementProof(criteria.map((criterion) => ({ id: criterion.id, title: criterion.title, required: criterion.required, archivedAt: criterion.archivedAt, evidence: [], status: criterion.proofStatus, evidenceId: criterion.proofEvidenceId, reason: criterion.proofReason })))
    return { id, projectId: String(row.project_id), stableKey: String(row.stable_key), kind: String(row.kind) as Requirement['kind'], parentId: text(row.parent_id), title: String(row.title), description: text(row.description), stateId: String(row.state_id), responsiblePhaseId: text(row.responsible_phase_id), version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), criteria, relatedPhaseIds: related.map((x) => String(x.phase_id)), linkedWorkItemIds: work.map((x) => String(x.work_item_id)), linkedEvidenceIds: evidence.map((x) => String(x.evidence_id)), gate: proofExplanation.requiredCriteria === 0 ? 'not_configured' : proofExplanation.status === 'proven' ? 'satisfied' : 'unsatisfied', proofStatus: proofExplanation.status, proofExplanation }
  }

  async listRequirements(projectId: string): Promise<Requirement[]> {
    await this.project(projectId)
    return serialMap(await this.executor.many<Row>('SELECT r.*,s.semantic FROM requirements r JOIN requirement_states s ON s.id=r.state_id WHERE r.project_id=$1 ORDER BY lower(r.stable_key),r.id', [projectId]), (row) => this.requirementFromRow(row))
  }
  async listRequirementsPage(projectId: string, limit: number, cursor?: string | null): Promise<Page<Requirement>> { return pageOf(await this.listRequirements(projectId), limit, cursor) }
  async getRequirement(id: string): Promise<Requirement | null> { const row = await this.executor.maybeOne<Row>('SELECT r.*,s.semantic FROM requirements r JOIN requirement_states s ON s.id=r.state_id WHERE r.id=$1', [id]); return row ? this.requirementFromRow(row) : null }

  private async assertRequirementParent(parentId: string, projectId: string, childId?: string): Promise<void> {
    await this.assertProjectEntity('requirements', parentId, projectId)
    if (parentId === childId) throw new ValidationError('A requirement cannot be its own parent')
    if (!childId) return
    const cycle = await this.executor.maybeOne(`WITH RECURSIVE ancestors(id) AS (SELECT parent_id FROM requirements WHERE id=$1 AND parent_id IS NOT NULL UNION SELECT r.parent_id FROM requirements r JOIN ancestors a ON r.id=a.id WHERE r.parent_id IS NOT NULL) SELECT 1 FROM ancestors WHERE id=$2 LIMIT 1`, [parentId, childId])
    if (cycle) throw new ValidationError('Requirement parent relationship would create a cycle')
  }

  async createRequirement(projectId: string, input: CreateRequirementInput): Promise<Requirement> {
    await this.project(projectId)
    const state = input.stateId ? await this.executor.maybeOne<Row>('SELECT id FROM requirement_states WHERE id=$1 AND project_id=$2', [input.stateId, projectId]) : await this.executor.maybeOne<Row>("SELECT id FROM requirement_states WHERE project_id=$1 AND semantic='open' ORDER BY position LIMIT 1", [projectId])
    if (!state) throw new ValidationError('Requirement state does not belong to the project')
    if (input.responsiblePhaseId) await this.assertProjectEntity('phases', input.responsiblePhaseId, projectId)
    if (input.criteria?.some((criterion) => criterion.id)) throw new ValidationError('New requirements cannot reuse existing criterion ids')
    return this.executor.transaction(async () => {
      if (input.parentId) {
        await lockProjectGraph(this.executor, projectId)
        await this.assertRequirementParent(input.parentId, projectId)
      }
      const id = randomUUID(); const timestamp = now()
      try { await this.executor.execute('INSERT INTO requirements(id,project_id,stable_key,kind,parent_id,title,description,state_id,responsible_phase_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)', [id, projectId, input.stableKey, input.kind, input.parentId ?? null, input.title, input.description ?? null, state.id, input.responsiblePhaseId ?? null, timestamp]) } catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'Could not create requirement') }
      for (const [position, criterion] of (input.criteria ?? []).entries()) await this.executor.execute('INSERT INTO acceptance_criteria(id,requirement_id,title,description,position,required,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [randomUUID(), id, criterion.title, criterion.description ?? null, position, criterion.required, timestamp])
      for (const phaseId of new Set(input.relatedPhaseIds ?? [])) { await this.assertProjectEntity('phases', phaseId, projectId); await this.executor.execute('INSERT INTO requirement_phase_links(requirement_id,phase_id,role,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, phaseId, phaseId === input.responsiblePhaseId ? 'responsible' : 'related', timestamp]) }
      await this.replaceSearch('requirement', id, projectId, `${input.stableKey} ${input.title}`, input.description ?? '')
      await this.event(projectId, 'requirement', id, 'requirement.created', { stableKey: input.stableKey, criterionCount: input.criteria?.length ?? 0 })
      return (await this.getRequirement(id))!
    })
  }

  async updateRequirement(id: string, input: UpdateRequirementInput): Promise<Requirement> {
    const initial = await this.getRequirement(id); if (!initial) throw new NotFoundError('Requirement', id)
    return this.executor.transaction(async () => {
      if (input.parentId !== undefined) await lockProjectGraph(this.executor, initial.projectId)
      const current = input.parentId === undefined ? initial : await this.getRequirement(id)
      if (!current) throw new NotFoundError('Requirement', id)
      const parentId = input.parentId === undefined ? current.parentId : input.parentId
      if (parentId) await this.assertRequirementParent(parentId, current.projectId, id)
      const stateId = input.stateId ?? current.stateId
      if (!await this.executor.maybeOne('SELECT 1 FROM requirement_states WHERE id=$1 AND project_id=$2', [stateId, current.projectId])) throw new ValidationError('Requirement state does not belong to the project')
      const responsiblePhaseId = input.responsiblePhaseId === undefined ? current.responsiblePhaseId : input.responsiblePhaseId
      if (responsiblePhaseId) await this.assertProjectEntity('phases', responsiblePhaseId, current.projectId)
      const relatedPhaseIds = input.relatedPhaseIds ?? current.relatedPhaseIds
      for (const phaseId of new Set(relatedPhaseIds)) await this.assertProjectEntity('phases', phaseId, current.projectId)
      const next = { ...current, ...input, parentId, stateId, responsiblePhaseId }
      const changed = await this.executor.execute(`UPDATE requirements SET stable_key=$1,kind=$2,parent_id=$3,title=$4,description=$5,state_id=$6,responsible_phase_id=$7,version=version+1,updated_at=$8 WHERE id=$9 AND version=$10`, [next.stableKey, next.kind, parentId ?? null, next.title, next.description ?? null, stateId, responsiblePhaseId ?? null, now(), id, input.expectedVersion])
      if (!changed) throw new ConflictError('Requirement', id)
      if (input.relatedPhaseIds !== undefined || input.responsiblePhaseId !== undefined) {
        await this.executor.execute('DELETE FROM requirement_phase_links WHERE requirement_id=$1', [id])
        if (responsiblePhaseId) await this.executor.execute('INSERT INTO requirement_phase_links(requirement_id,phase_id,role,created_at) VALUES ($1,$2,$3,$4)', [id, responsiblePhaseId, 'responsible', now()])
        for (const phaseId of new Set(relatedPhaseIds)) if (phaseId !== responsiblePhaseId) await this.executor.execute('INSERT INTO requirement_phase_links(requirement_id,phase_id,role,created_at) VALUES ($1,$2,$3,$4)', [id, phaseId, 'related', now()])
      }
      if (input.criteria !== undefined) {
        const existing = await this.executor.many<Row>('SELECT * FROM acceptance_criteria WHERE requirement_id=$1', [id])
        const byId = new Map(existing.map((criterion) => [String(criterion.id), criterion])); const retained = new Set<string>()
        for (const [position, criterion] of input.criteria.entries()) {
          if (!criterion.id) {
            const criterionId = randomUUID(); const timestamp = now()
            await this.executor.execute('INSERT INTO acceptance_criteria(id,requirement_id,title,description,position,required,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [criterionId, id, criterion.title, criterion.description ?? null, position, criterion.required, timestamp])
            await this.event(current.projectId, 'acceptance_criterion', criterionId, 'acceptance_criterion.created', { requirementId: id }); continue
          }
          const stored = byId.get(criterion.id); if (!stored) throw new ValidationError('Criterion must belong to the requirement being updated')
          const materiallyChanged = String(stored.title) !== criterion.title || text(stored.description) !== (criterion.description ?? null) || bool(stored.required) !== criterion.required || Number(stored.position) !== position || stored.archived_at !== null
          const count = await this.executor.execute(`UPDATE acceptance_criteria SET title=$1,description=$2,position=$3,required=$4,archived_at=NULL,version=version+$5,updated_at=$6 WHERE id=$7 AND requirement_id=$8 AND version=$9`, [criterion.title, criterion.description ?? null, position, criterion.required, materiallyChanged ? 1 : 0, now(), criterion.id, id, criterion.expectedVersion])
          if (!count) throw new ConflictError('Acceptance criterion', criterion.id)
          retained.add(criterion.id); if (materiallyChanged) await this.event(current.projectId, 'acceptance_criterion', criterion.id, 'acceptance_criterion.updated', { requirementId: id })
        }
        for (const stored of existing.filter((criterion) => criterion.archived_at == null && !retained.has(String(criterion.id)))) {
          await this.executor.execute('UPDATE acceptance_criteria SET archived_at=$1,version=version+1,updated_at=$1 WHERE id=$2', [now(), stored.id])
          await this.event(current.projectId, 'acceptance_criterion', String(stored.id), 'acceptance_criterion.archived', { requirementId: id })
        }
      }
      await this.replaceSearch('requirement', id, current.projectId, `${next.stableKey} ${next.title}`, next.description ?? '')
      await this.event(current.projectId, 'requirement', id, 'requirement.updated', { stableKey: next.stableKey })
      return (await this.getRequirement(id))!
    })
  }

  async linkRequirementWork(projectId: string, requirementId: string, workItemId: string): Promise<void> {
    await this.assertProjectEntity('requirements', requirementId, projectId)
    await this.assertProjectEntity('work_items', workItemId, projectId)
    await this.executor.execute('INSERT INTO requirement_work_links(requirement_id,work_item_id,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [requirementId, workItemId, now()])
    await this.event(projectId, 'requirement', requirementId, 'requirement.work_linked', { workItemId })
  }
  async unlinkRequirementWork(requirementId: string, workItemId: string): Promise<void> { const row = await this.executor.maybeOne<Row>('SELECT project_id FROM requirements WHERE id=$1', [requirementId]); await this.executor.execute('DELETE FROM requirement_work_links WHERE requirement_id=$1 AND work_item_id=$2', [requirementId, workItemId]); if (row) await this.event(String(row.project_id), 'requirement', requirementId, 'requirement.work_unlinked', { workItemId }) }

  async getRequirementRollup(projectId: string): Promise<RequirementRollup> {
    const requirements = await this.listRequirements(projectId)
    const states = await this.listRequirementStates(projectId)
    const phases = await this.executor.many<Row>('SELECT id,name FROM phases WHERE project_id=$1', [projectId])
    const bySemantic: Record<RequirementStateSemantic, number> = { open: 0, partial: 0, proven: 0, defect: 0 }; const byProofStatus = { open: 0, partial: 0, proven: 0, defect: 0 }
    const stateMap = new Map(states.map((state) => [state.id, state.semantic])); const phaseMap = new Map(phases.map((phase) => [String(phase.id), String(phase.name)])); const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]))
    const empty = (): Record<RequirementStateSemantic, number> => ({ open: 0, partial: 0, proven: 0, defect: 0 }); const capabilities = new Map<string, RequirementRollupBucket>(); const goals = new Map<string, RequirementRollupBucket>(); const milestones = new Map<string, RequirementRollupBucket>()
    const add = (map: Map<string, RequirementRollupBucket>, id: string, name: string, requirement: Requirement, stableKey?: string) => { const bucket = map.get(id) ?? { id, name, ...(stableKey ? { stableKey } : {}), counts: empty(), total: 0 }; bucket.counts[stateMap.get(requirement.stateId) ?? 'open'] += 1; bucket.total += 1; map.set(id, bucket) }
    for (const requirement of requirements) {
      bySemantic[stateMap.get(requirement.stateId) ?? 'open'] += 1; byProofStatus[requirement.proofStatus] += 1
      const seen = new Set<string>(); let parentId = requirement.parentId
      while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = byId.get(parentId); if (!parent) break; if (parent.kind === 'capability') add(capabilities, parent.id, parent.title, requirement, parent.stableKey); if (parent.kind === 'goal') add(goals, parent.id, parent.title, requirement, parent.stableKey); parentId = parent.parentId }
      if (requirement.kind === 'capability') add(capabilities, requirement.id, requirement.title, requirement, requirement.stableKey)
      if (requirement.kind === 'goal') add(goals, requirement.id, requirement.title, requirement, requirement.stableKey)
      for (const phaseId of new Set([...(requirement.responsiblePhaseId ? [requirement.responsiblePhaseId] : []), ...requirement.relatedPhaseIds])) { const name = phaseMap.get(phaseId); if (name) add(milestones, phaseId, name, requirement) }
    }
    const sorted = (map: Map<string, RequirementRollupBucket>) => [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
    return { total: requirements.length, bySemantic, byProofStatus, gateFailures: requirements.filter((r) => r.gate === 'unsatisfied').length, defects: byProofStatus.defect, byCapability: sorted(capabilities), byMilestone: sorted(milestones), byGoal: sorted(goals) }
  }

  async listWorkQueues(projectId: string): Promise<WorkQueue[]> { await this.project(projectId); return (await this.executor.many<Row>('SELECT * FROM work_queues WHERE project_id=$1 ORDER BY created_at,id', [projectId])).map((row) => ({ id: String(row.id), projectId: String(row.project_id), name: String(row.name), description: text(row.description), version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })) }
  async createWorkQueue(projectId: string, input: CreateWorkQueueInput): Promise<WorkQueue> { await this.project(projectId); const id = randomUUID(); const timestamp = now(); try { await this.executor.execute('INSERT INTO work_queues(id,project_id,name,description,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)', [id, projectId, input.name, input.description ?? null, timestamp]) } catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'Could not create work queue') }; await this.event(projectId, 'work_queue', id, 'work_queue.created', { name: input.name }); return (await this.listWorkQueues(projectId)).find((q) => q.id === id)! }
  getQueueAutomationPolicy(projectId: string, queueId: string) { return this.automation.getPolicy(projectId, queueId) }
  updateQueueAutomationPolicy(projectId: string, queueId: string, input: UpdateQueueAutomationPolicyInput) { return this.automation.updatePolicy(projectId, queueId, input) }
  getQueueAutomationOverview(projectId: string, queueId: string) { return this.automation.getOverview(projectId, queueId) }
  claimNextAutomatedWork(projectId: string, queueId: string, input: ClaimNextAutomatedWorkInput) { return this.automation.claim(projectId, queueId, input) }
  heartbeatAutomatedWork(leaseId: string, input: HeartbeatAutomatedWorkInput) { return this.automation.heartbeat(leaseId, input) }
  recordAutomationAttempt(leaseId: string, input: RecordAutomationAttemptInput) { return this.automation.record(leaseId, input) }
  completeAutomatedWork(leaseId: string, input: CompleteAutomatedWorkInput) { return this.automation.complete(leaseId, input) }
  releaseAutomatedWork(leaseId: string, input: RunnerReleaseAutomatedWorkInput) { return this.automation.release(leaseId, input) }
  operatorReleaseAutomatedWork(leaseId: string, input: OperatorReleaseAutomatedWorkInput) { return this.automation.operatorRelease(leaseId, input) }
  readAutomationQueueChanges(projectId: string, queueId: string, afterSequence: number, expiredAfter: string, checkedAt: string) { return this.automation.readChanges(projectId, queueId, afterSequence, expiredAfter, checkedAt) }

  private async workItemFromRow(row: Row): Promise<WorkItem> {
    const id = String(row.id)
    const labels = await this.executor.many<Row>('SELECT l.* FROM labels l JOIN work_item_labels wil ON wil.label_id=l.id WHERE wil.work_item_id=$1 ORDER BY lower(l.name)', [id])
    const dependencies = await this.executor.many<Row>("SELECT wi.title,wr.kind FROM work_relations wr JOIN work_items wi ON ((wr.kind='depends_on' AND wi.id=wr.to_work_item_id) OR (wr.kind='blocks' AND wi.id=wr.from_work_item_id)) WHERE ((wr.kind='depends_on' AND wr.from_work_item_id=$1) OR (wr.kind='blocks' AND wr.to_work_item_id=$1)) AND wi.status NOT IN ('resolved','dropped')", [id])
    const external = await this.executor.many<Row>('SELECT content FROM external_blockers WHERE work_item_id=$1 AND resolved_at IS NULL', [id])
    const reasons = [...dependencies.map((x) => `${String(x.kind) === 'blocks' ? 'Blocked by' : 'Depends on'} ${String(x.title)}`), ...external.map((x) => String(x.content))]
    return { id, projectId: String(row.project_id), phaseId: text(row.phase_id), kind: String(row.kind) as WorkItem['kind'], title: String(row.title), description: text(row.description), status: String(row.status) as WorkItem['status'], priority: text(row.priority) as WorkItem['priority'], labels: labels.map((label) => ({ id: String(label.id), name: String(label.name), colour: text(label.colour), version: Number(label.version), createdAt: iso(label.created_at), updatedAt: iso(label.updated_at) })), version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), stableKey: text(row.stable_key), parentId: text(row.parent_id), queueId: text(row.queue_id), rank: text(row.rank), effectiveBlocked: reasons.length > 0 || String(row.status) === 'blocked', blockerReasons: reasons }
  }
  async listWorkItems(projectId: string, queueId?: string): Promise<WorkItem[]> { await this.project(projectId); const rows = queueId ? await this.executor.many<Row>('SELECT wi.*,wqi.queue_id,wqi.rank FROM work_items wi JOIN work_queue_items wqi ON wqi.work_item_id=wi.id WHERE wi.project_id=$1 AND wqi.queue_id=$2 ORDER BY wqi.rank,wqi.work_item_id', [projectId, queueId]) : await this.executor.many<Row>("SELECT wi.*,wqi.queue_id,wqi.rank FROM work_items wi LEFT JOIN work_queue_items wqi ON wqi.work_item_id=wi.id WHERE wi.project_id=$1 ORDER BY COALESCE(wqi.rank,'￿'),wi.updated_at DESC", [projectId]); return serialMap(rows, (row) => this.workItemFromRow(row)) }
  async listWorkItemsPage(projectId: string, limit: number, cursor?: string | null, queueId?: string): Promise<Page<WorkItem>> { return pageOf(await this.listWorkItems(projectId, queueId), limit, cursor) }

  private async dependencyWouldCycle(fromId: string, toId: string): Promise<boolean> { return Boolean(await this.executor.maybeOne(`WITH RECURSIVE dependencies(dependent,dependency) AS (SELECT from_work_item_id,to_work_item_id FROM work_relations WHERE kind='depends_on' UNION ALL SELECT to_work_item_id,from_work_item_id FROM work_relations WHERE kind='blocks'), reachable(id) AS (SELECT dependency FROM dependencies WHERE dependent=$1 UNION SELECT d.dependency FROM dependencies d JOIN reachable r ON r.id=d.dependent) SELECT 1 FROM reachable WHERE id=$2 LIMIT 1`, [toId, fromId])) }
  async linkWorkItems(projectId: string, input: CreateWorkRelationInput): Promise<WorkRelation> {
    if (input.fromWorkItemId === input.toWorkItemId) throw new ValidationError('A work item cannot relate to itself')
    return this.executor.transaction(async () => {
      await lockProjectGraph(this.executor, projectId)
      await this.assertProjectEntity('work_items', input.fromWorkItemId, projectId)
      await this.assertProjectEntity('work_items', input.toWorkItemId, projectId)
      if (input.kind === 'depends_on' && await this.dependencyWouldCycle(input.fromWorkItemId, input.toWorkItemId)) throw new ValidationError('Dependency would create a cycle')
      if (input.kind === 'blocks' && await this.dependencyWouldCycle(input.toWorkItemId, input.fromWorkItemId)) throw new ValidationError('Blocking relationship would create a cycle')
      const id = randomUUID(); const timestamp = now()
      try {
        await this.executor.execute('INSERT INTO work_relations(id,project_id,from_work_item_id,to_work_item_id,kind,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, projectId, input.fromWorkItemId, input.toWorkItemId, input.kind, timestamp])
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : 'Could not create work relation')
      }
      await this.event(projectId, 'work_relation', id, 'work_relation.created', { ...input })
      return { id, projectId, fromWorkItemId: input.fromWorkItemId, toWorkItemId: input.toWorkItemId, kind: input.kind, createdAt: timestamp }
    })
  }
  async unlinkWorkItems(id: string): Promise<void> { const current = await this.executor.maybeOne<Row>('SELECT * FROM work_relations WHERE id=$1', [id]); if (!current) return; await this.executor.transaction(async () => { await lockProjectGraph(this.executor, String(current.project_id)); const relation = await this.executor.maybeOne<Row>('DELETE FROM work_relations WHERE id=$1 RETURNING *', [id]); if (relation) await this.event(String(relation.project_id), 'work_relation', id, 'work_relation.deleted', { kind: relation.kind }) }) }
  async listWorkRelations(projectId: string): Promise<WorkRelation[]> { return (await this.executor.many<Row>('SELECT * FROM work_relations WHERE project_id=$1 ORDER BY created_at,id', [projectId])).map((row) => ({ id: String(row.id), projectId: String(row.project_id), fromWorkItemId: String(row.from_work_item_id), toWorkItemId: String(row.to_work_item_id), kind: String(row.kind) as WorkRelation['kind'], createdAt: iso(row.created_at) })) }

  async createExternalBlocker(projectId: string, input: CreateExternalBlockerInput): Promise<ExternalBlocker> { return this.executor.transaction(async () => { await lockProjectGraph(this.executor, projectId); await this.project(projectId); if (input.workItemId) await this.assertProjectEntity('work_items', input.workItemId, projectId); const id = randomUUID(); const timestamp = now(); await this.executor.execute('INSERT INTO external_blockers(id,project_id,work_item_id,content,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)', [id, projectId, input.workItemId ?? null, input.content, timestamp]); await this.event(projectId, 'external_blocker', id, 'external_blocker.created', { workItemId: input.workItemId ?? null }); return { id, projectId, workItemId: input.workItemId ?? null, content: input.content, resolvedAt: null, createdAt: timestamp, updatedAt: timestamp } }) }
  async listExternalBlockers(projectId: string, includeResolved = false): Promise<ExternalBlocker[]> { const rows = await this.executor.many<Row>(`SELECT * FROM external_blockers WHERE project_id=$1 ${includeResolved ? '' : 'AND resolved_at IS NULL'} ORDER BY created_at DESC,id`, [projectId]); return rows.map((row) => ({ id: String(row.id), projectId: String(row.project_id), workItemId: text(row.work_item_id), content: String(row.content), resolvedAt: row.resolved_at == null ? null : iso(row.resolved_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })) }
  async resolveExternalBlocker(id: string): Promise<ExternalBlocker> { const current = await this.executor.maybeOne<Row>('SELECT * FROM external_blockers WHERE id=$1', [id]); if (!current) throw new NotFoundError('External blocker', id); return this.executor.transaction(async () => { await lockProjectGraph(this.executor, String(current.project_id)); const timestamp = now(); const row = await this.executor.maybeOne<Row>('UPDATE external_blockers SET resolved_at=$1,updated_at=$1 WHERE id=$2 RETURNING *', [timestamp, id]); if (!row) throw new NotFoundError('External blocker', id); await this.event(String(row.project_id), 'external_blocker', id, 'external_blocker.resolved'); return { id, projectId: String(row.project_id), workItemId: text(row.work_item_id), content: String(row.content), resolvedAt: timestamp, createdAt: iso(row.created_at), updatedAt: timestamp } }) }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> { const id = randomUUID(); const timestamp = now(); const root = resolve(input.canonicalRoot); const aliases = [...new Set((input.aliases ?? []).map((entry) => resolve(entry)))]; return this.executor.transaction(async () => { try { await this.executor.execute('INSERT INTO workspaces(id,name,canonical_root,remote,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)', [id, input.name, root, input.remote ?? null, timestamp]); for (const alias of aliases) await this.executor.execute('INSERT INTO workspace_aliases(workspace_id,alias,created_at) VALUES ($1,$2,$3)', [id, alias, timestamp]) } catch (error) { throw new ValidationError(error instanceof Error ? error.message : 'Could not create workspace') }; await this.event(null, 'workspace', id, 'workspace.created', { name: input.name, canonicalRoot: root }); return { id, name: input.name, canonicalRoot: root, aliases, remote: input.remote ?? null, createdAt: timestamp, updatedAt: timestamp } }) }
  async linkProjectWorkspace(projectId: string, workspaceId: string): Promise<void> { await this.project(projectId); if (!await this.executor.maybeOne('SELECT 1 FROM workspaces WHERE id=$1', [workspaceId])) throw new NotFoundError('Workspace', workspaceId); await this.executor.execute('INSERT INTO project_workspaces(project_id,workspace_id,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [projectId, workspaceId, now()]); await this.event(projectId, 'workspace', workspaceId, 'workspace.linked', { projectId }) }
  async createWorkspaceRevision(input: CreateWorkspaceRevisionInput): Promise<WorkspaceRevision> { if (!await this.executor.maybeOne('SELECT 1 FROM workspaces WHERE id=$1', [input.workspaceId])) throw new NotFoundError('Workspace', input.workspaceId); const id = randomUUID(); const capturedAt = now(); await this.executor.execute('INSERT INTO workspace_revisions(id,workspace_id,branch,"commit",dirty,diff_hash,captured_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, input.workspaceId, input.branch ?? null, input.commit ?? null, input.dirty, input.diffHash ?? null, capturedAt]); const projects = await this.executor.many<Row>('SELECT project_id FROM project_workspaces WHERE workspace_id=$1', [input.workspaceId]); if (projects.length) for (const project of projects) await this.event(String(project.project_id), 'workspace_revision', id, 'workspace_revision.created', { workspaceId: input.workspaceId, dirty: input.dirty }); else await this.event(null, 'workspace_revision', id, 'workspace_revision.created', { workspaceId: input.workspaceId, dirty: input.dirty }); return { id, workspaceId: input.workspaceId, branch: input.branch ?? null, commit: input.commit ?? null, dirty: input.dirty, diffHash: input.diffHash ?? null, capturedAt } }
  async resolveProject(workspacePath: string): Promise<Project[]> { const target = resolve(workspacePath); const rows = await this.executor.many<Row>(`SELECT p.*,w.canonical_root FROM projects p JOIN project_workspaces pw ON pw.project_id=p.id JOIN workspaces w ON w.id=pw.workspace_id WHERE $1=w.canonical_root OR $1 LIKE w.canonical_root || '/%' OR EXISTS (SELECT 1 FROM workspace_aliases wa WHERE wa.workspace_id=w.id AND ($1=wa.alias OR $1 LIKE wa.alias || '/%')) ORDER BY GREATEST(length(w.canonical_root),COALESCE((SELECT MAX(length(wa.alias)) FROM workspace_aliases wa WHERE wa.workspace_id=w.id AND ($1=wa.alias OR $1 LIKE wa.alias || '/%')),0)) DESC`, [target]); if (!rows.length) return []; const longest = Math.max(...rows.map((row) => String(row.canonical_root).length)); return rows.filter((row) => String(row.canonical_root).length === longest).map(projectFromRow) }

  private async secretRedactor(projectId?: string | null): Promise<SecretRedactor> { const names = projectId ? (await this.executor.many<Row>('SELECT name FROM project_secret_names WHERE project_id=$1 ORDER BY name', [projectId])).map((row) => String(row.name)) : []; return new SecretRedactor({ secretNames: names }) }
  private errorReportFromRow(row: Row): ErrorReport { return { id: String(row.id), kind: String(row.kind) as ErrorReport['kind'], component: String(row.component), summary: String(row.summary), observation: String(row.observation), expectedBehaviour: text(row.expected_behaviour), actualBehaviour: text(row.actual_behaviour), reproductionSteps: json<string[]>(row.reproduction_steps_json, []), impact: text(row.impact), projectId: text(row.project_id), workspacePath: text(row.workspace_path), status: String(row.status) as ErrorReport['status'], triageNote: text(row.triage_note), source: String(row.source) as ErrorReport['source'], client: text(row.client), actor: String(row.actor), redaction: json<RedactionMetadata>(row.redaction_json, { count: 0, fields: [] }), version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) } }
  async createErrorReport(input: CreateErrorReportInput): Promise<ErrorReport> {
    if (input.projectId) await this.project(input.projectId)
    const id = randomUUID(); const timestamp = now(); const context = this.context(); const redactor = await this.secretRedactor(input.projectId)
    const component = redactor.redact(input.component); const summary = redactor.redact(input.summary); const observation = redactor.redact(input.observation); const expected = input.expectedBehaviour ? redactor.redact(input.expectedBehaviour) : null; const actual = input.actualBehaviour ? redactor.redact(input.actualBehaviour) : null; const steps = (input.reproductionSteps ?? []).map((step) => redactor.redact(step)); const impact = input.impact ? redactor.redact(input.impact) : null; const workspace = input.workspacePath ? redactor.redact(input.workspacePath) : null
    const redaction = redactionMetadata([{ field: 'component', result: component }, { field: 'summary', result: summary }, { field: 'observation', result: observation }, ...(expected ? [{ field: 'expectedBehaviour', result: expected }] : []), ...(actual ? [{ field: 'actualBehaviour', result: actual }] : []), ...steps.map((result, index) => ({ field: `reproductionSteps.${index}`, result })), ...(impact ? [{ field: 'impact', result: impact }] : []), ...(workspace ? [{ field: 'workspacePath', result: workspace }] : [])])
    await this.executor.execute(`INSERT INTO error_reports(id,kind,component,summary,observation,expected_behaviour,actual_behaviour,reproduction_steps_json,impact,project_id,workspace_path,status,triage_note,source,client,actor,redaction_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,'open',NULL,$12,$13,$14,$15::jsonb,$16,$16)`, [id, input.kind, component.value, summary.value, observation.value, expected?.value ?? null, actual?.value ?? null, JSON.stringify(steps.map((x) => x.value)), impact?.value ?? null, input.projectId ?? null, workspace?.value ?? null, context.source, context.client ?? null, context.actor, JSON.stringify(redaction), timestamp])
    await this.event(null, 'error_report', id, 'error_report.created', { kind: input.kind, component: component.value, redactionCount: redaction.count })
    return this.errorReportFromRow(await this.executor.one<Row>('SELECT * FROM error_reports WHERE id=$1', [id]))
  }
  async listErrorReportsPage(limit: number, cursor?: string | null, statuses?: ErrorReport['status'][], kinds?: ErrorReport['kind'][], component?: string): Promise<Page<ErrorReport>> { const clauses: string[] = []; const values: unknown[] = []; const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)) }; if (statuses?.length) { values.push(statuses); clauses.push(`status=ANY($${values.length}::text[])`) } if (kinds?.length) { values.push(kinds); clauses.push(`kind=ANY($${values.length}::text[])`) } if (component) add('component=?', component); const rows = await this.executor.many<Row>(`SELECT * FROM error_reports ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC,id DESC`, values); return pageOf(rows.map((row) => this.errorReportFromRow(row)), limit, cursor) }
  async getErrorReport(id: string): Promise<{ report: ErrorReport; history: ActivityEvent[] } | null> { const row = await this.executor.maybeOne<Row>('SELECT * FROM error_reports WHERE id=$1', [id]); if (!row) return null; const history = (await this.executor.many<Row>("SELECT * FROM activity_events WHERE entity_type='error_report' AND entity_id=$1 ORDER BY created_at,id", [id])).map((e) => ({ id: String(e.id), projectId: text(e.project_id), entityType: String(e.entity_type), entityId: String(e.entity_id), eventType: String(e.event_type), payload: json<Record<string, unknown>>(e.payload_json, {}), source: String(e.source) as ActivityEvent['source'], client: text(e.client), actor: String(e.actor), idempotencyKey: text(e.idempotency_key), createdAt: iso(e.created_at) })); return { report: this.errorReportFromRow(row), history } }
  async updateErrorReport(id: string, input: UpdateErrorReportInput): Promise<ErrorReport> { const current = await this.executor.maybeOne<Row>('SELECT * FROM error_reports WHERE id=$1', [id]); if (!current) throw new NotFoundError('Error report', id); const redactor = await this.secretRedactor(text(current.project_id)); const note = input.triageNote === undefined ? text(current.triage_note) : input.triageNote === null ? null : redactor.redact(input.triageNote).value; const status = input.status ?? String(current.status); const changed = await this.executor.execute('UPDATE error_reports SET status=$1,triage_note=$2,version=version+1,updated_at=$3 WHERE id=$4 AND version=$5', [status, note, now(), id, input.expectedVersion]); if (!changed) throw new ConflictError('Error report', id); await this.event(null, 'error_report', id, 'error_report.status_updated', { status }); return this.errorReportFromRow(await this.executor.one<Row>('SELECT * FROM error_reports WHERE id=$1', [id])) }

  private async artifactsForRun(runId: string): Promise<ArtifactReference[]> { return (await this.executor.many<Row>('SELECT * FROM artifact_references WHERE run_id=$1 ORDER BY created_at,id', [runId])).map((row) => ({ id: String(row.id), runId: text(row.run_id), uri: String(row.uri), mediaType: text(row.media_type), byteCount: row.byte_count == null ? null : Number(row.byte_count), digest: text(row.digest), createdAt: iso(row.created_at) })) }
  async createRun(projectId: string, input: CreateRunInput): Promise<{ run: Run; testSummary: TestSummary | null; artifacts: ArtifactReference[] }> {
    await this.project(projectId)
    if (input.workspaceRevisionId && !await this.executor.maybeOne(`SELECT 1 FROM workspace_revisions wr JOIN project_workspaces pw ON pw.workspace_id=wr.workspace_id WHERE wr.id=$1 AND pw.project_id=$2`, [input.workspaceRevisionId, projectId])) throw new ValidationError('Workspace revision does not belong to the project')
    const id = randomUUID(); const createdAt = now(); const redactor = await this.secretRedactor(projectId); const command = redactor.redact(stripAnsi(input.command)); const working = input.workingDirectory ? redactor.redact(input.workingDirectory) : null; const stdout = input.stdoutExcerpt ? redactor.redact(stripAnsi(input.stdoutExcerpt)) : null; const stderr = input.stderrExcerpt ? redactor.redact(stripAnsi(input.stderrExcerpt)) : null; const tools = Object.entries(input.toolchain ?? {}).map(([name, value]) => ({ name, result: redactor.redact(value) })); const artifactResults = (input.artifacts ?? []).map((artifact) => ({ artifact, result: redactor.redact(artifact.uri) })); const redaction = redactionMetadata([{ field: 'command', result: command }, ...(working ? [{ field: 'workingDirectory', result: working }] : []), ...(stdout ? [{ field: 'stdoutExcerpt', result: stdout }] : []), ...(stderr ? [{ field: 'stderrExcerpt', result: stderr }] : []), ...tools.map(({ name, result }) => ({ field: `toolchain.${name}`, result })), ...artifactResults.map(({ result }, index) => ({ field: `artifacts.${index}.uri`, result }))]); const toolchain = Object.fromEntries(tools.map(({ name, result }) => [name, result.value])); const startedAt = input.startedAt ?? createdAt; const endedAt = input.endedAt ?? null; const durationMs = endedAt ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime()) : null; assertRunInvariants({ startedAt, endedAt, outcome: input.outcome, exitCode: input.exitCode, testSummary: input.testSummary })
    return this.executor.transaction(async () => { await this.executor.execute(`INSERT INTO runs(id,project_id,workspace_revision_id,command,working_directory,started_at,ended_at,duration_ms,outcome,exit_code,toolchain_json,stdout_excerpt,stderr_excerpt,stdout_truncated,stderr_truncated,validation_status,redaction_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,'validated',$16::jsonb,$17)`, [id, projectId, input.workspaceRevisionId ?? null, command.value, working?.value ?? null, startedAt, endedAt, durationMs, input.outcome, input.exitCode ?? null, JSON.stringify(toolchain), stdout?.value ?? null, stderr?.value ?? null, Boolean(input.stdoutTruncated), Boolean(input.stderrTruncated), JSON.stringify(redaction), createdAt]); let testSummary: TestSummary | null = null; if (input.testSummary) { const sid = randomUUID(); await this.executor.execute('INSERT INTO test_summaries(id,run_id,scope,passed,failed,skipped,target_count,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [sid, id, input.testSummary.scope, input.testSummary.passed, input.testSummary.failed, input.testSummary.skipped, input.testSummary.targetCount, createdAt]); testSummary = { id: sid, runId: id, ...input.testSummary, createdAt } } const artifacts: ArtifactReference[] = []; for (const { artifact, result } of artifactResults) { const aid = randomUUID(); await this.executor.execute('INSERT INTO artifact_references(id,run_id,uri,media_type,byte_count,digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [aid, id, result.value, artifact.mediaType ?? null, artifact.byteCount ?? null, artifact.digest ?? null, createdAt]); artifacts.push({ id: aid, runId: id, uri: result.value, mediaType: artifact.mediaType ?? null, byteCount: artifact.byteCount ?? null, digest: artifact.digest ?? null, createdAt }) } const run: Run = { id, projectId, workspaceRevisionId: input.workspaceRevisionId ?? null, command: command.value, workingDirectory: working?.value ?? null, startedAt, endedAt, durationMs, outcome: input.outcome, exitCode: input.exitCode ?? null, toolchain, stdoutExcerpt: stdout?.value ?? null, stderrExcerpt: stderr?.value ?? null, stdoutTruncated: Boolean(input.stdoutTruncated), stderrTruncated: Boolean(input.stderrTruncated), artifacts, validationStatus: 'validated', redaction, createdAt }; await this.replaceSearch('run', id, projectId, command.value, [stdout?.value, stderr?.value].filter(Boolean).join('\n')); await this.event(projectId, 'run', id, 'run.created', { outcome: input.outcome, redactionCount: redaction.count }); return { run, testSummary, artifacts } })
  }
  async listRuns(projectId: string): Promise<Run[]> { const rows = await this.executor.many<Row>('SELECT * FROM runs WHERE project_id=$1 ORDER BY started_at DESC,id DESC', [projectId]); return serialMap(rows, async (row) => ({ id: String(row.id), projectId: String(row.project_id), workspaceRevisionId: text(row.workspace_revision_id), command: String(row.command), workingDirectory: text(row.working_directory), startedAt: iso(row.started_at), endedAt: row.ended_at == null ? null : iso(row.ended_at), durationMs: row.duration_ms == null ? null : Number(row.duration_ms), outcome: String(row.outcome) as Run['outcome'], exitCode: row.exit_code == null ? null : Number(row.exit_code), toolchain: json<Record<string, string>>(row.toolchain_json, {}), stdoutExcerpt: text(row.stdout_excerpt), stderrExcerpt: text(row.stderr_excerpt), stdoutTruncated: bool(row.stdout_truncated), stderrTruncated: bool(row.stderr_truncated), artifacts: await this.artifactsForRun(String(row.id)), validationStatus: String(row.validation_status) as ValidationStatus, redaction: json<RedactionMetadata>(row.redaction_json, { count: 0, fields: [] }), createdAt: iso(row.created_at) })) }
  async listRunsPage(projectId: string, limit: number, cursor?: string | null): Promise<Page<Run>> { return pageOf(await this.listRuns(projectId), limit, cursor) }

  private async evidenceFromRow(row: Row): Promise<Evidence> {
    const id = String(row.id)
    const stale = await this.evidenceStaleness(row)
    const reqs = await this.executor.many<Row>('SELECT requirement_id FROM evidence_requirement_links WHERE evidence_id=$1 ORDER BY requirement_id', [id])
    const criteria = await this.executor.many<Row>('SELECT l.criterion_id,l.criterion_version,c.version FROM evidence_criterion_links l JOIN acceptance_criteria c ON c.id=l.criterion_id WHERE l.evidence_id=$1 ORDER BY l.criterion_id', [id])
    const work = await this.executor.many<Row>('SELECT work_item_id FROM evidence_work_links WHERE evidence_id=$1 ORDER BY work_item_id', [id])
    const updates = await this.executor.many<Row>('SELECT update_id FROM evidence_update_links WHERE evidence_id=$1 ORDER BY update_id', [id])
    const checkpoints = await this.executor.many<Row>('SELECT checkpoint_id FROM evidence_checkpoint_links WHERE evidence_id=$1 ORDER BY checkpoint_id', [id])
    const artifacts = await this.executor.many<Row>('SELECT a.* FROM artifact_references a JOIN evidence_artifact_links l ON l.artifact_id=a.id WHERE l.evidence_id=$1 ORDER BY a.created_at,a.id', [id])
    const override = await this.executor.maybeOne<Row>('SELECT * FROM evidence_overrides WHERE evidence_id=$1', [id])
    return { id, ordinal: Number(row.ordinal), projectId: String(row.project_id), runId: text(row.run_id), result: String(row.result) as Evidence['result'], summary: String(row.summary), targetVersion: row.target_version == null ? null : Number(row.target_version), stale: stale.stale, staleReason: stale.staleReason, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), requirementIds: reqs.map((x) => String(x.requirement_id)), workItemIds: work.map((x) => String(x.work_item_id)), updateIds: updates.map((x) => String(x.update_id)), checkpointIds: checkpoints.map((x) => String(x.checkpoint_id)), artifacts: artifacts.map((a) => ({ id: String(a.id), runId: text(a.run_id), uri: String(a.uri), mediaType: text(a.media_type), byteCount: a.byte_count == null ? null : Number(a.byte_count), digest: text(a.digest), createdAt: iso(a.created_at) })), criterionLinks: criteria.map((x) => ({ criterionId: String(x.criterion_id), criterionVersion: Number(x.criterion_version), stale: Number(x.criterion_version) !== Number(x.version) })), validationStatus: String(row.validation_status) as ValidationStatus, redaction: json<RedactionMetadata>(row.redaction_json, { count: 0, fields: [] }), override: override ? { reason: String(override.reason), actor: String(override.actor), source: String(override.source) as MutationContext['source'], client: text(override.client), createdAt: iso(override.created_at) } : null }
  }
  async createEvidence(projectId: string, input: CreateEvidenceInput): Promise<Evidence> { await this.project(projectId); const id = randomUUID(); const timestamp = now(); const requirementIds = new Set(input.requirementIds ?? []); const criterionRows: Row[] = []; for (const criterionId of new Set(input.criterionIds ?? [])) { const criterion = await this.executor.maybeOne<Row>('SELECT c.*,r.project_id FROM acceptance_criteria c JOIN requirements r ON r.id=c.requirement_id WHERE c.id=$1 AND r.project_id=$2', [criterionId, projectId]); if (!criterion) throw new ValidationError('Criterion does not belong to the project'); criterionRows.push(criterion); requirementIds.add(String(criterion.requirement_id)) } for (const requirementId of requirementIds) await this.assertProjectEntity('requirements', requirementId, projectId); for (const workItemId of input.workItemIds ?? []) await this.assertProjectEntity('work_items', workItemId, projectId); for (const updateId of input.updateIds ?? []) if (!await this.executor.maybeOne('SELECT 1 FROM updates WHERE id=$1 AND project_id=$2', [updateId, projectId])) throw new ValidationError('Update does not belong to the project'); for (const checkpointId of input.checkpointIds ?? []) if (!await this.executor.maybeOne("SELECT 1 FROM updates WHERE id=$1 AND project_id=$2 AND kind='checkpoint'", [checkpointId, projectId])) throw new ValidationError('Checkpoint does not belong to the project'); const linkedRun = input.runId ? await this.executor.maybeOne<Row>('SELECT * FROM runs WHERE id=$1 AND project_id=$2', [input.runId, projectId]) : null; if (input.runId && !linkedRun) throw new ValidationError('Run does not belong to the project'); const context = this.context(); if (input.override && context.source === 'mcp') throw new ValidationError('Verification overrides are unavailable through MCP'); assertEvidenceInvariants({ result: input.result, runId: input.runId }, { linkedRun: linkedRun ? { id: String(linkedRun.id), outcome: String(linkedRun.outcome) as Run['outcome'], invariantsValid: String(linkedRun.validation_status) === 'validated' } : null, verifiedOverride: input.override }); const redactor = await this.secretRedactor(projectId); const summary = redactor.redact(input.summary); const artifactResults = (input.artifacts ?? []).map((artifact) => ({ artifact, result: redactor.redact(artifact.uri) })); const redaction = redactionMetadata([{ field: 'summary', result: summary }, ...artifactResults.map(({ result }, index) => ({ field: `artifacts.${index}.uri`, result }))]); return this.executor.transaction(async () => { const inserted = await this.executor.one<Row>('INSERT INTO evidence(id,project_id,run_id,result,summary,target_version,validation_status,redaction_json,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9) RETURNING *', [id, projectId, input.runId ?? null, input.result, summary.value, input.targetVersion ?? null, input.override ? 'overridden' : 'validated', JSON.stringify(redaction), timestamp]); for (const requirementId of requirementIds) await this.executor.execute('INSERT INTO evidence_requirement_links VALUES ($1,$2)', [id, requirementId]); for (const criterion of criterionRows) await this.executor.execute('INSERT INTO evidence_criterion_links VALUES ($1,$2,$3,$4)', [id, criterion.id, criterion.version, timestamp]); for (const workId of new Set(input.workItemIds ?? [])) await this.executor.execute('INSERT INTO evidence_work_links VALUES ($1,$2)', [id, workId]); for (const updateId of new Set(input.updateIds ?? [])) await this.executor.execute('INSERT INTO evidence_update_links VALUES ($1,$2)', [id, updateId]); for (const checkpointId of new Set(input.checkpointIds ?? [])) await this.executor.execute('INSERT INTO evidence_checkpoint_links VALUES ($1,$2)', [id, checkpointId]); for (const { artifact, result } of artifactResults) { const aid = randomUUID(); await this.executor.execute('INSERT INTO artifact_references(id,run_id,uri,media_type,byte_count,digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [aid, input.runId ?? null, result.value, artifact.mediaType ?? null, artifact.byteCount ?? null, artifact.digest ?? null, timestamp]); await this.executor.execute('INSERT INTO evidence_artifact_links VALUES ($1,$2)', [id, aid]) } if (input.override) await this.executor.execute('INSERT INTO evidence_overrides VALUES ($1,$2,$3,$4,$5,$6)', [id, input.override.reason, context.actor, context.source, context.client ?? null, timestamp]); await this.replaceSearch('evidence', id, projectId, input.result, summary.value); await this.event(projectId, 'evidence', id, 'evidence.created', { result: input.result, criterionIds: criterionRows.map((x) => x.id), overridden: Boolean(input.override), redactionCount: redaction.count }); return this.evidenceFromRow(inserted) }) }
  async listEvidence(projectId: string, includeStale = false): Promise<Evidence[]> { await this.project(projectId); const values = await serialMap(await this.executor.many<Row>('SELECT * FROM evidence WHERE project_id=$1 ORDER BY ordinal DESC', [projectId]), (row) => this.evidenceFromRow(row)); return includeStale ? values : values.filter((entry) => !entry.stale) }
  async listEvidencePage(projectId: string, limit: number, cursor?: string | null, includeStale = false): Promise<Page<Evidence>> { return pageOf(await this.listEvidence(projectId, includeStale), limit, cursor) }

  async captureCheckpointSnapshot(projectId: string, checkpointId: string): Promise<CheckpointSnapshot> {
    return this.executor.transaction(async () => {
      const project = await this.project(projectId)
      if (!await this.executor.maybeOne("SELECT 1 FROM updates WHERE id=$1 AND project_id=$2 AND kind='checkpoint'", [checkpointId, projectId])) {
        throw new ValidationError('Checkpoint does not belong to the project')
      }
      const existing = await this.getCheckpointSnapshot(checkpointId)
      if (existing) return existing

      // A transaction is pinned to one PoolClient. Keep these reads sequential so
      // pg never receives concurrent queries on that client.
      const phases = await this.executor.many<Row>('SELECT * FROM phases WHERE project_id=$1 ORDER BY position,id', [projectId])
      const requirementStates = await this.listRequirementStates(projectId)
      const requirements = await this.listRequirements(projectId)
      const workItems = await this.listWorkItems(projectId)
      const queues = await this.listWorkQueues(projectId)
      const relations = await this.listWorkRelations(projectId)
      const blockers = await this.listExternalBlockers(projectId, true)
      const workspaces = await this.executor.many<Row>('SELECT w.*,pw.project_id FROM workspaces w JOIN project_workspaces pw ON pw.workspace_id=w.id WHERE pw.project_id=$1 ORDER BY w.canonical_root,w.id', [projectId])
      const workspacesWithAliases = []
      for (const workspace of workspaces) {
        const aliases = await this.executor.many<Row>('SELECT alias FROM workspace_aliases WHERE workspace_id=$1 ORDER BY alias', [workspace.id])
        workspacesWithAliases.push({ ...workspace, aliases: aliases.map((alias) => String(alias.alias)) })
      }
      const workspaceRevisions = await this.executor.many<Row>('SELECT wr.* FROM workspace_revisions wr JOIN project_workspaces pw ON pw.workspace_id=wr.workspace_id WHERE pw.project_id=$1 ORDER BY wr.captured_at,wr.id', [projectId])
      const runs = await this.listRuns(projectId)
      const testSummaries = await this.executor.many<Row>('SELECT ts.* FROM test_summaries ts JOIN runs r ON r.id=ts.run_id WHERE r.project_id=$1 ORDER BY r.started_at,r.id', [projectId])
      const evidence = await this.listEvidence(projectId, true)
      const updates = await this.executor.many<Row>('SELECT * FROM updates WHERE project_id=$1 ORDER BY created_at,id', [projectId])
      const updateRevisions = await this.executor.many<Row>('SELECT ur.* FROM update_revisions ur JOIN updates u ON u.id=ur.update_id WHERE u.project_id=$1 ORDER BY u.created_at,u.id,ur.revision', [projectId])
      const labels = await this.executor.many<Row>('SELECT DISTINCT l.* FROM labels l JOIN work_item_labels wil ON wil.label_id=l.id JOIN work_items wi ON wi.id=wil.work_item_id WHERE wi.project_id=$1 ORDER BY l.name,l.id', [projectId])
      const requirementAliases = await this.executor.many<Row>('SELECT a.* FROM requirement_key_aliases a JOIN requirements r ON r.id=a.requirement_id WHERE r.project_id=$1 ORDER BY a.requirement_id,a.alias', [projectId])
      const requirementPhases = await this.executor.many<Row>('SELECT l.* FROM requirement_phase_links l JOIN requirements r ON r.id=l.requirement_id WHERE r.project_id=$1 ORDER BY l.requirement_id,l.phase_id', [projectId])
      const requirementWork = await this.executor.many<Row>('SELECT l.* FROM requirement_work_links l JOIN requirements r ON r.id=l.requirement_id WHERE r.project_id=$1 ORDER BY l.requirement_id,l.work_item_id', [projectId])
      const workPhases = await this.executor.many<Row>('SELECT l.* FROM work_phase_links l JOIN work_items w ON w.id=l.work_item_id WHERE w.project_id=$1 ORDER BY l.work_item_id,l.phase_id', [projectId])
      const secretNames = await this.executor.many<Row>('SELECT name FROM project_secret_names WHERE project_id=$1 ORDER BY name', [projectId])
      const document = canonicaliseJson({
        project, phases, requirementStates, requirements, workItems, queues, relations, blockers,
        workspaces: workspacesWithAliases, workspaceRevisions, runs, testSummaries, evidence, updates,
        updateRevisions, labels,
        links: { requirementAliases, requirementPhases, requirementWork, workPhases },
        projectSecretNames: secretNames.map((row) => String(row.name)),
        evidenceHeads: evidence.map((entry) => ({ id: entry.id, ordinal: entry.ordinal, result: entry.result, stale: entry.stale, updatedAt: entry.updatedAt })),
      }) as Record<string, unknown>
      const encoded = canonicalJson(document)
      const digest = createHash('sha256').update(encoded).digest('hex')
      const id = randomUUID()
      const capturedAt = now()
      const inserted = await this.executor.maybeOne<Row>('INSERT INTO checkpoint_snapshots(id,checkpoint_id,schema_version,captured_at,document_json,digest) VALUES ($1,$2,3,$3,$4::jsonb,$5) ON CONFLICT (checkpoint_id) DO NOTHING RETURNING *', [id, checkpointId, capturedAt, encoded, digest])
      if (!inserted) return (await this.getCheckpointSnapshot(checkpointId))!
      await this.event(projectId, 'checkpoint_snapshot', id, 'checkpoint_snapshot.captured', { checkpointId, digest })
      return { id, checkpointId, schemaVersion: 3, capturedAt, document, digest }
    })
  }
  async getCheckpointSnapshot(checkpointId: string): Promise<CheckpointSnapshot | null> { const row = await this.executor.maybeOne<Row>('SELECT * FROM checkpoint_snapshots WHERE checkpoint_id=$1', [checkpointId]); return row ? { id: String(row.id), checkpointId: String(row.checkpoint_id), schemaVersion: 3, capturedAt: iso(row.captured_at), document: json<Record<string, unknown>>(row.document_json, {}), digest: String(row.digest) } : null }
  async reconstructCheckpointState(checkpointId: string): Promise<Record<string, unknown> | null> { const structured = await this.getCheckpointSnapshot(checkpointId); if (structured) return { ...structured.document, _snapshot: { legacy: false, schemaVersion: structured.schemaVersion, digest: structured.digest } }; const row = await this.executor.maybeOne<Row>("SELECT r.snapshot_json FROM updates u JOIN update_revisions r ON r.id=u.current_revision_id WHERE u.id=$1 AND u.kind='checkpoint' AND u.deleted_at IS NULL", [checkpointId]); const compact = row ? json<Record<string, unknown> | null>(row.snapshot_json, null) : null; return compact ? { compactSnapshot: compact, _snapshot: { legacy: true, schemaVersion: 1, digest: createHash('sha256').update(canonicalJson(compact)).digest('hex') } } : null }
  async compareCheckpointSnapshots(leftCheckpointId: string, rightCheckpointId: string): Promise<CheckpointComparison> { const left = await this.reconstructCheckpointState(leftCheckpointId); const right = await this.reconstructCheckpointState(rightCheckpointId); if (!left || !right) throw new NotFoundError('Checkpoint snapshot', !left ? leftCheckpointId : rightCheckpointId); const leftMeta = left._snapshot as { digest: string; legacy: boolean }; const rightMeta = right._snapshot as { digest: string; legacy: boolean }; const sections = new Set([...Object.keys(left), ...Object.keys(right)].filter((x) => x !== '_snapshot')); const changedSections = [...sections].filter((section) => JSON.stringify(left[section]) !== JSON.stringify(right[section])).sort(); return { leftCheckpointId, rightCheckpointId, same: changedSections.length === 0, changedSections, leftDigest: leftMeta.digest, rightDigest: rightMeta.digest, leftLegacy: leftMeta.legacy, rightLegacy: rightMeta.legacy } }
  async getProjectPulseSummary(projectId: string): Promise<ProjectPulseSummary | null> {
    const row = await this.executor.maybeOne<Row>('SELECT * FROM projects WHERE id=$1', [projectId])
    if (!row) return null
    const project = projectFromRow(row)
    const phases = await this.executor.many<Row>("SELECT id,name,status FROM phases WHERE project_id=$1 AND status='active' AND archived_at IS NULL ORDER BY position,id", [projectId])
    const queues = await this.listWorkQueues(projectId)
    const blockers = await this.listExternalBlockers(projectId)
    const evidence = await this.listEvidence(projectId, true)
    const rollup = await this.getRequirementRollup(projectId)
    const queueHead = queues[0] ? (await this.listWorkItems(projectId, queues[0].id)).filter((item) => !['resolved','dropped'].includes(item.status)).slice(0, 10) : []
    const checkpoint = project.currentCheckpointId ? await this.executor.maybeOne<Row>('SELECT u.id,r.content,u.created_at FROM updates u JOIN update_revisions r ON r.id=u.current_revision_id WHERE u.id=$1', [project.currentCheckpointId]) : null
    return { project, currentCheckpoint: checkpoint ? { id: String(checkpoint.id), content: String(checkpoint.content), createdAt: iso(checkpoint.created_at) } : null, activePhases: phases.map((phase) => ({ id: String(phase.id), name: String(phase.name), status: 'active' as const })), requirementRollup: rollup, queueHead, blockers, staleEvidenceCount: evidence.filter((entry) => entry.stale).length, failedEvidenceCount: evidence.filter((entry) => entry.result === 'failed').length }
  }
  async search(query: string, limit = 50, filters: SearchFilters = {}): Promise<SearchResult[]> {
    const term = query.trim()
    if (!term) return []
    const bounded = Math.min(Math.max(limit, 1), 200)
    const types = filters.entityTypes ? new Set(filters.entityTypes) : null
    const results: SearchResult[] = []
    const append = async (sql: string, values: unknown[]) => {
      const rows = await this.executor.many<Row>(sql, values)
      results.push(...rows.map((row) => ({ type: String(row.entity_type) as SearchResult['type'], id: String(row.entity_id), projectId: String(row.project_id), title: String(row.title), excerpt: String(row.body).slice(0, 500), score: Number(row.score) })))
    }
    if ((!types || types.has('requirement')) && !filters.requirementId && !filters.evidenceResult) {
      const values: unknown[] = [term]; const clauses = ["si.entity_type='requirement'", "si.search_vector @@ websearch_to_tsquery('simple',istra_unaccent($1))"]
      if (filters.projectId) { values.push(filters.projectId); clauses.push(`r.project_id=$${values.length}`) }
      if (filters.state) { values.push(filters.state); clauses.push(`(s.semantic=$${values.length} OR s.name=$${values.length})`) }
      if (filters.phaseId) { values.push(filters.phaseId); clauses.push(`(r.responsible_phase_id=$${values.length} OR EXISTS (SELECT 1 FROM requirement_phase_links l WHERE l.requirement_id=r.id AND l.phase_id=$${values.length}))`) }
      if (filters.from) { values.push(filters.from); clauses.push(`r.created_at>=$${values.length}`) }
      if (filters.to) { values.push(filters.to); clauses.push(`r.created_at<=$${values.length}`) }
      values.push(bounded); await append(`SELECT si.*,ts_rank(si.search_vector,websearch_to_tsquery('simple',istra_unaccent($1))) score FROM search_index si JOIN requirements r ON r.id=si.entity_id JOIN requirement_states s ON s.id=r.state_id WHERE ${clauses.join(' AND ')} ORDER BY score DESC,r.updated_at DESC LIMIT $${values.length}`, values)
    }
    if ((!types || types.has('work_item')) && !filters.evidenceResult) {
      const values: unknown[] = [term]; const clauses = ["si.entity_type='work_item'", "si.search_vector @@ websearch_to_tsquery('simple',istra_unaccent($1))"]
      if (filters.projectId) { values.push(filters.projectId); clauses.push(`w.project_id=$${values.length}`) }
      if (filters.state) { values.push(filters.state); clauses.push(`w.status=$${values.length}`) }
      if (filters.phaseId) { values.push(filters.phaseId); clauses.push(`(w.phase_id=$${values.length} OR EXISTS (SELECT 1 FROM work_phase_links l WHERE l.work_item_id=w.id AND l.phase_id=$${values.length}))`) }
      if (filters.requirementId) { values.push(filters.requirementId); clauses.push(`EXISTS (SELECT 1 FROM requirement_work_links l WHERE l.work_item_id=w.id AND l.requirement_id=$${values.length})`) }
      if (filters.from) { values.push(filters.from); clauses.push(`w.created_at>=$${values.length}`) }
      if (filters.to) { values.push(filters.to); clauses.push(`w.created_at<=$${values.length}`) }
      values.push(bounded); await append(`SELECT si.*,ts_rank(si.search_vector,websearch_to_tsquery('simple',istra_unaccent($1))) score FROM search_index si JOIN work_items w ON w.id=si.entity_id WHERE ${clauses.join(' AND ')} ORDER BY score DESC,w.updated_at DESC LIMIT $${values.length}`, values)
    }
    if ((!types || types.has('run')) && !filters.state && !filters.phaseId && !filters.requirementId && !filters.evidenceResult) {
      const values: unknown[] = [term]; const clauses = ["si.entity_type='run'", "si.search_vector @@ websearch_to_tsquery('simple',istra_unaccent($1))"]
      if (filters.projectId) { values.push(filters.projectId); clauses.push(`r.project_id=$${values.length}`) }
      if (filters.from) { values.push(filters.from); clauses.push(`r.created_at>=$${values.length}`) }
      if (filters.to) { values.push(filters.to); clauses.push(`r.created_at<=$${values.length}`) }
      values.push(bounded); await append(`SELECT si.*,ts_rank(si.search_vector,websearch_to_tsquery('simple',istra_unaccent($1))) score FROM search_index si JOIN runs r ON r.id=si.entity_id WHERE ${clauses.join(' AND ')} ORDER BY score DESC,r.created_at DESC LIMIT $${values.length}`, values)
    }
    if ((!types || types.has('evidence')) && !filters.state && !filters.phaseId && !filters.requirementId) {
      const values: unknown[] = [term]; const clauses = ["si.entity_type='evidence'", "si.search_vector @@ websearch_to_tsquery('simple',istra_unaccent($1))"]
      if (filters.projectId) { values.push(filters.projectId); clauses.push(`e.project_id=$${values.length}`) }
      if (filters.evidenceResult) { values.push(filters.evidenceResult); clauses.push(`e.result=$${values.length}`) }
      if (filters.from) { values.push(filters.from); clauses.push(`e.created_at>=$${values.length}`) }
      if (filters.to) { values.push(filters.to); clauses.push(`e.created_at<=$${values.length}`) }
      values.push(bounded); await append(`SELECT si.*,ts_rank(si.search_vector,websearch_to_tsquery('simple',istra_unaccent($1))) score FROM search_index si JOIN evidence e ON e.id=si.entity_id WHERE ${clauses.join(' AND ')} ORDER BY score DESC,e.created_at DESC LIMIT $${values.length}`, values)
    }
    return results.slice(0, bounded)
  }
}
