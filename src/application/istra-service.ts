import { z } from 'zod'
import type { BackupManager } from '../infrastructure/sqlite/database.js'
import {
  CheckpointSchema,
  CreateLabelSchema,
  CreatePhaseSchema,
  CreateProjectSchema,
  CreateUpdateSchema,
  CreateWorkItemSchema,
  ProjectStateSchema,
  ReviseUpdateSchema,
  UpdatePhaseSchema,
  UpdateProjectSchema,
  UpdateWorkItemSchema,
  WorkItemStatusSchema,
  type Provenance,
} from '../domain/contracts.js'
import { ValidationError } from './errors.js'
import type { ExportBundle, IstraRepository } from './ports.js'

const ExportBundleSchema = z.object({
  format: z.literal('istra-export'),
  formatVersion: z.literal(1),
  exportedAt: z.string().datetime({ offset: true }),
  tables: z.record(z.array(z.record(z.unknown()))),
}).strict()

const provenance = (value?: Partial<Provenance>): Provenance => ({ source: value?.source ?? 'ui', client: value?.client })

export class IstraService {
  constructor(private readonly repository: IstraRepository, private readonly backups: BackupManager) {}

  private parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
    const result = schema.safeParse(value)
    if (!result.success) throw new ValidationError('Input validation failed', result.error.flatten())
    return result.data
  }

  private async write<T>(operation: () => T): Promise<T> {
    await this.backups.beforeWrite()
    return operation()
  }

  listProjects(filters: unknown = {}) {
    const parsed = this.parse(z.object({ state: ProjectStateSchema.optional(), includeArchived: z.boolean().optional(), q: z.string().max(500).optional() }), filters)
    return this.repository.listProjects(parsed)
  }

  getProject(id: string) { return this.repository.getProjectDetail(id) }
  listPhases(projectId: string, includeArchived = false) { return this.repository.listPhases(projectId, includeArchived) }
  listWorkItems(projectId: string, statuses?: string[]) {
    const parsed = this.parse(z.array(WorkItemStatusSchema).max(10).optional(), statuses)
    return this.repository.listWorkItems(projectId, parsed)
  }
  listUpdates(projectId: string, includeDeleted = false) { return this.repository.listUpdates(projectId, includeDeleted) }
  listActivity(projectId: string, limit?: number) { return this.repository.listActivity(projectId, limit) }
  listRecentActivity(limit?: number) { return this.repository.listRecentActivity(limit) }
  getUpdateRevisions(updateId: string) { return this.repository.getUpdateRevisions(updateId) }
  listLabels() { return this.repository.listLabels() }
  search(query: string, limit?: number) { return this.repository.search(query, limit) }
  exportAll() { return this.repository.exportAll() }
  async backupStatus() {
    const files = await this.backups.list()
    const backups = files.map((file) => ({
      name: file.name,
      kind: file.name.startsWith('pre-import-') ? 'pre-import' : file.name.startsWith('pre-migration-') ? 'pre-migration' : file.name.startsWith('weekly-') ? 'weekly' : 'daily',
      createdAt: file.modifiedAt,
      size: file.size,
    })).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const lastBackupAt = backups.reduce<string | null>((latest, file) => !latest || file.createdAt > latest ? file.createdAt : latest, null)
    return {
      databasePath: this.backups.paths.databasePath,
      lastBackupAt,
      nextBackupKind: 'daily',
      backups,
    }
  }

  createProject(input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(CreateProjectSchema, input)
    return this.write(() => this.repository.createProject(parsed, provenance(source)))
  }
  updateProject(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(UpdateProjectSchema, input)
    return this.write(() => this.repository.updateProject(id, parsed, provenance(source)))
  }
  archiveProject(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(z.object({ expectedVersion: z.number().int().positive(), archived: z.boolean() }), input)
    return this.write(() => this.repository.archiveProject(id, parsed.expectedVersion, parsed.archived, provenance(source)))
  }
  createPhase(projectId: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(CreatePhaseSchema, input)
    return this.write(() => this.repository.createPhase(projectId, parsed, provenance(source)))
  }
  updatePhase(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(UpdatePhaseSchema, input)
    return this.write(() => this.repository.updatePhase(id, parsed, provenance(source)))
  }
  createWorkItem(projectId: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(CreateWorkItemSchema, input)
    return this.write(() => this.repository.createWorkItem(projectId, parsed, provenance(source)))
  }
  updateWorkItem(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(UpdateWorkItemSchema, input)
    return this.write(() => this.repository.updateWorkItem(id, parsed, provenance(source)))
  }
  createUpdate(projectId: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(CreateUpdateSchema, input)
    return this.write(() => this.repository.createUpdate(projectId, parsed, provenance(source)))
  }
  reviseUpdate(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(ReviseUpdateSchema, input)
    return this.write(() => this.repository.reviseUpdate(id, parsed, provenance(source)))
  }
  deleteUpdate(id: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(z.object({ expectedVersion: z.number().int().positive() }), input)
    return this.write(() => this.repository.softDeleteUpdate(id, parsed.expectedVersion, provenance(source)))
  }
  saveCheckpoint(projectId: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(CheckpointSchema, input)
    return this.write(() => this.repository.saveCheckpoint(projectId, parsed, provenance(source)))
  }
  createLabel(input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(CreateLabelSchema, input)
    return this.write(() => this.repository.createLabel(parsed, provenance(source)))
  }
  attachLabel(workItemId: string, labelId: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(z.object({ expectedVersion: z.number().int().positive() }), input)
    return this.write(() => this.repository.attachLabel(workItemId, labelId, parsed.expectedVersion, provenance(source)))
  }
  detachLabel(workItemId: string, labelId: string, input: unknown, source?: Partial<Provenance>) {
    const parsed = this.parse(z.object({ expectedVersion: z.number().int().positive() }), input)
    return this.write(() => this.repository.detachLabel(workItemId, labelId, parsed.expectedVersion, provenance(source)))
  }

  async importAll(value: unknown): Promise<void> {
    const bundle = this.parse(ExportBundleSchema, value) as ExportBundle
    this.repository.validateImport(bundle)
    await this.backups.beforeWrite()
    await this.backups.create('pre-import')
    this.repository.importAll(bundle)
  }
}
