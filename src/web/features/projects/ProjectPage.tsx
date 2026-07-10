import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { ActivityTimeline } from "../../components/Timeline";
import { EmptyState, ErrorNotice } from "../../components/Overlay";
import { Icon } from "../../components/Icon";
import { KindMark, PriorityView, WorkItemStatusView } from "../../components/Status";
import { formatDate, humanise, toActivityView, updateContent } from "../../format";
import { projectStates, type Phase, type ProjectPulseSummary, type ProjectState, type ProjectUpdate, type Requirement, type WorkItem } from "../../types";
import { useResource } from "../../useResource";
import { CheckpointDrawer, EditProjectDialog, PhaseDialog, UpdateDialog, WorkItemDialog } from "./ProjectForms";

type Panel =
  | { type: "checkpoint" }
  | { type: "edit-project" }
  | { type: "phase"; phase?: Phase }
  | { type: "work-item"; item?: WorkItem }
  | { type: "update"; update?: ProjectUpdate }
  | null;

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const detail = useResource(() => api.getProject(projectId), [projectId]);
  const operationalPulse = useResource(() => api.getPulseSummary(projectId), [projectId]);
  const requirements = useResource(() => api.listRequirementsPage(projectId, 8), [projectId]);
  const allPhases = useResource(() => api.listPhases(projectId, true), [projectId]);
  const globalLabels = useResource(() => api.listLabels(), []);
  const [panel, setPanel] = useState<Panel>(null);
  const [workFilter, setWorkFilter] = useState<"open" | "blocked" | "all">("open");
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const visibleWorkItems = useMemo(() => {
    const items = detail.data?.workItems ?? [];
    if (workFilter === "all") return items;
    if (workFilter === "blocked") return items.filter((item) => item.status === "blocked");
    return items.filter((item) => item.status === "open" || item.status === "in_progress");
  }, [detail.data?.workItems, workFilter]);

  if (detail.loading) return <ProjectSkeleton />;
  if (detail.error) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return <div className="page"><EmptyState title="Project not found" action={<Link className="text-button" to="/">Back to projects</Link>}>It may have been removed or the address is no longer valid.</EmptyState></div>;
    }
    return <div className="page"><ErrorNotice error={detail.error} onRetry={detail.reload} /></div>;
  }
  if (!detail.data) return null;

  const { project, pulse, phases, updates, activity } = detail.data;
  const sortedPhases = phases.filter((phase) => !phase.archivedAt).sort((a, b) => a.position - b.position);
  const archivedPhases = (allPhases.data ?? []).filter((phase) => phase.archivedAt);
  const activityItems = (showAllActivity ? activity : activity.slice(0, 4)).map((event) => toActivityView(event, project));

  async function updateState(state: ProjectState) {
    setMutationError(null);
    try {
      await api.updateProject(project, { expectedVersion: project.version, state });
      await Promise.all([detail.reload(), operationalPulse.reload()]);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Could not change project state");
    }
  }

  async function toggleArchive() {
    setMutationError(null);
    try {
      await api.setArchived(project, !project.archivedAt);
      if (!project.archivedAt) navigate("/archive");
      else await Promise.all([detail.reload(), operationalPulse.reload()]);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Could not change archive state");
    }
  }

  async function restorePhase(phase: Phase) {
    setMutationError(null);
    try {
      await api.updatePhase(phase, { archived: false });
      await Promise.all([detail.reload(), allPhases.reload(), operationalPulse.reload()]);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Could not restore the phase");
    }
  }

  async function deleteUpdate(update: ProjectUpdate) {
    if (!window.confirm("Soft-delete this update? Its revision history will be retained.")) return;
    setMutationError(null);
    try {
      await api.deleteUpdate(update);
      await Promise.all([detail.reload(), operationalPulse.reload()]);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Could not delete the update");
    }
  }

  return (
    <div className={`page page--project${panel?.type === "checkpoint" ? " page--drawer-open" : ""}`}>
      <header className="project-header">
        <Link className="back-link" to="/"><Icon name="back" size={16} /> All projects</Link>
        <h1>{project.title}</h1>
        <div className="project-actions">
          <label className={`state-select state-select--${project.state}`}>
            <span aria-hidden="true" />
            <span className="sr-only">Project state</span>
            <select aria-label="Project state" onChange={(event) => void updateState(event.target.value as ProjectState)} value={project.state}>
              {projectStates.map((state) => <option key={state} value={state}>{humanise(state)}</option>)}
            </select>
          </label>
          <div className="project-actions__right">
            <button aria-label="Edit project details" className="icon-button edit-project-button" onClick={() => setPanel({ type: "edit-project" })}><Icon name="edit" size={18} /></button>
            <button className="button button--secondary" onClick={() => void toggleArchive()}><Icon name="archive" size={18} />{project.archivedAt ? "Restore" : "Archive"}</button>
            <button className="button button--primary" onClick={() => setPanel({ type: "checkpoint" })}>Record checkpoint</button>
          </div>
        </div>
      </header>

      {mutationError ? <p className="form-error" role="alert">{mutationError}</p> : null}
      <p className="project-description">{project.description || project.intent || "No description yet. Let the project take shape as you work."}</p>

      <section aria-labelledby="pulse-heading" className="pulse-section">
        <h2 className="section-kicker" id="pulse-heading">Current pulse</h2>
        <div className="pulse-grid">
          <PulseValue accent="blue" label="Current focus" value={pulse.currentFocus || "Not set yet"} />
          <PulseValue accent="rust" label="Next action" value={pulse.nextAction || "Choose the next small step"} />
          <PulseValue accent="grey" label="Blockers" value={pulse.blockers.length ? pulse.blockers.join("; ") : "No blockers recorded"} />
        </div>
      </section>

      <OperationalMemoryPanel
        error={operationalPulse.error ?? requirements.error}
        loading={operationalPulse.loading || requirements.loading}
        onRetry={() => void Promise.all([operationalPulse.reload(), requirements.reload()])}
        pulse={operationalPulse.data}
        requirements={requirements.data?.items ?? []}
        requirementsLoading={requirements.loading}
      />

      <section aria-labelledby="phases-heading" className="phases-section">
        <div className="section-heading-row">
          <h2 className="section-kicker" id="phases-heading">Phases</h2>
          <button className="text-button" onClick={() => setPanel({ type: "phase" })}><Icon name="plus" size={17} /> Add phase</button>
        </div>
        {sortedPhases.length ? (
          <ol className="phase-track">
            {sortedPhases.map((phase) => (
              <li className={`phase-track__item phase-track__item--${phase.status}`} key={phase.id}>
                <button aria-label={`Edit ${phase.name}`} className="phase-track__node" onClick={() => setPanel({ type: "phase", phase })}>
                  {phase.status === "completed" ? <Icon name="check" size={16} /> : null}
                </button>
                <strong>{phase.name}</strong>
                <span><i aria-hidden="true" />{humanise(phase.status)}</span>
              </li>
            ))}
          </ol>
        ) : <EmptyState title="No phases yet" action={<button className="text-button" onClick={() => setPanel({ type: "phase" })}><Icon name="plus" size={17} /> Add a phase</button>}>Phases are optional and may overlap when the work does.</EmptyState>}
        {archivedPhases.length ? <details className="archived-phases"><summary>{archivedPhases.length} archived {archivedPhases.length === 1 ? "phase" : "phases"}</summary>{archivedPhases.map((phase) => <div key={phase.id}><span>{phase.name}</span><button className="text-button" onClick={() => void restorePhase(phase)}>Restore</button></div>)}</details> : null}
      </section>

      <div className="project-lower-grid">
        <section aria-labelledby="work-items-heading" className="work-items-section">
          <div className="work-heading">
            <h2 className="section-kicker" id="work-items-heading">Work items</h2>
            <div aria-label="Filter work items" className="segmented-control">
              {(["open", "blocked", "all"] as const).map((filter) => <button aria-pressed={workFilter === filter} key={filter} onClick={() => setWorkFilter(filter)}>{humanise(filter)}</button>)}
            </div>
          </div>
          <WorkItemTable items={visibleWorkItems} onEdit={(item) => setPanel({ type: "work-item", item })} />
          <button className="text-button add-row-button" onClick={() => setPanel({ type: "work-item" })}><Icon name="plus" size={18} /> Add work item</button>
        </section>

        <aside aria-labelledby="activity-heading" className="project-activity">
          <h2 className="section-kicker" id="activity-heading">Activity</h2>
          <ActivityTimeline items={activityItems} />
          {activity.length > 4 ? <button className="text-button" onClick={() => setShowAllActivity((current) => !current)}>{showAllActivity ? "Show recent activity" : "View full activity"}</button> : null}
        </aside>
      </div>

      <section aria-labelledby="journal-heading" className="journal-section" id="journal">
        <div className="section-heading-row">
          <div><h2 className="section-kicker" id="journal-heading">Journal</h2><p>Progress, decisions, discoveries and checkpoint history.</p></div>
          <button className="text-button" onClick={() => setPanel({ type: "update" })}><Icon name="plus" size={17} /> Add update</button>
        </div>
        {updates.length ? <div className="journal-list">{updates.map((update) => <JournalEntry canDelete={project.currentCheckpointId !== update.id} key={update.id} update={update} onDelete={() => void deleteUpdate(update)} onEdit={() => setPanel({ type: "update", update })} />)}</div> : <EmptyState title="Nothing recorded yet">Add an update or record a checkpoint to begin the journal.</EmptyState>}
      </section>

      {panel?.type === "checkpoint" ? <CheckpointDrawer project={project} onClose={() => setPanel(null)} onSaved={async () => { await Promise.all([detail.reload(), operationalPulse.reload()]); }} /> : null}
      {panel?.type === "edit-project" ? <EditProjectDialog project={project} onClose={() => setPanel(null)} onSaved={async () => { await Promise.all([detail.reload(), operationalPulse.reload()]); }} /> : null}
      {panel?.type === "phase" ? <PhaseDialog projectId={project.id} phase={panel.phase} onClose={() => setPanel(null)} onSaved={async () => { await Promise.all([detail.reload(), allPhases.reload(), operationalPulse.reload()]); }} /> : null}
      {panel?.type === "work-item" ? <WorkItemDialog projectId={project.id} item={panel.item} phases={sortedPhases} labels={globalLabels.data ?? detail.data.labels} onClose={() => setPanel(null)} onSaved={async () => { await Promise.all([detail.reload(), globalLabels.reload(), operationalPulse.reload()]); }} /> : null}
      {panel?.type === "update" ? <UpdateDialog projectId={project.id} update={panel.update} onClose={() => setPanel(null)} onSaved={async () => { await Promise.all([detail.reload(), operationalPulse.reload()]); }} /> : null}
    </div>
  );
}

function OperationalMemoryPanel({ pulse, requirements, loading, requirementsLoading, error, onRetry }: { pulse: ProjectPulseSummary | null; requirements: Requirement[]; loading: boolean; requirementsLoading: boolean; error: Error | null; onRetry: () => void }) {
  const blocked = pulse?.queueHead.filter((item) => item.effectiveBlocked).length ?? 0;
  const status = error ? "Unavailable" : loading ? "Loading…" : "Live";
  return (
    <section aria-labelledby="operational-memory-heading" className="operational-memory-section">
      <div className="section-heading-row"><div><h2 className="section-kicker" id="operational-memory-heading">Operational memory</h2><p>Trace intent through work and verification.</p></div><span className="operational-memory__status">{status}</span></div>
      {error ? <ErrorNotice error={error} onRetry={onRetry} /> : pulse ? (
        <>
          <div className="operational-memory-grid">
            <div className="operational-memory-card"><span>Requirements</span><strong>{pulse.requirementRollup.total}</strong><small>{pulse.requirementRollup.bySemantic.proven} proven · {pulse.requirementRollup.gateFailures} gate failures · {pulse.requirementRollup.defects} defects</small></div>
            <div className="operational-memory-card"><span>Queue head</span><strong>{pulse.queueHead.length}</strong><small>{blocked} effectively blocked</small></div>
            <div className="operational-memory-card"><span>External blockers</span><strong>{pulse.blockers.length}</strong><small>Unresolved operational blockers</small></div>
            <div className="operational-memory-card"><span>Stale evidence</span><strong>{pulse.staleEvidenceCount}</strong><small>{pulse.failedEvidenceCount} failed verification</small></div>
          </div>
          {requirementsLoading ? <p className="operational-memory__empty">Loading requirement ledger…</p> : requirements.length ? <div className="operational-memory__requirements"><h3>Requirement ledger</h3><ul>{requirements.map((requirement) => <li key={requirement.id}><strong>{requirement.stableKey}</strong><span>{requirement.title}</span><em className={`requirement-gate requirement-gate--${requirement.gate}`}>{humanise(requirement.gate)}</em></li>)}</ul></div> : <p className="operational-memory__empty">No requirements recorded yet. Add goals or acceptance criteria when this project needs traceability.</p>}
        </>
      ) : <p className="operational-memory__empty">Loading operational memory…</p>}
    </section>
  );
}

function PulseValue({ accent, label, value }: { accent: "blue" | "rust" | "grey"; label: string; value: string }) {
  return <div className={`pulse-value pulse-value--${accent}`}><span>{label}</span><p>{value}</p></div>;
}

function WorkItemTable({ items, onEdit }: { items: WorkItem[]; onEdit: (item: WorkItem) => void }) {
  if (items.length === 0) return <p className="table-empty">No work items match this filter.</p>;
  return (
    <div className="work-table" role="table" aria-label="Work items">
      <div className="work-table__header" role="row"><span role="columnheader">Title</span><span role="columnheader">Type</span><span role="columnheader">Status</span><span role="columnheader">Priority</span><span /></div>
      {items.map((item) => (
        <div className="work-table__row" key={item.id} role="row">
          <button className="work-table__title" onClick={() => onEdit(item)} role="cell"><span>{item.title}</span>{item.labels.length ? <small>{item.labels.map((label) => <i className="label-chip" key={label.id}>{label.name}</i>)}</small> : null}</button>
          <span className="work-table__kind" role="cell"><KindMark kind={item.kind} />{humanise(item.kind)}</span>
          <span role="cell"><WorkItemStatusView status={item.status} /></span>
          <span role="cell"><PriorityView priority={item.priority} /></span>
          <button aria-label={`Edit ${item.title}`} className="icon-button" onClick={() => onEdit(item)} role="cell"><Icon name="more" /></button>
        </div>
      ))}
    </div>
  );
}

function JournalEntry({ update, onEdit, onDelete, canDelete }: { update: ProjectUpdate; onEdit: () => void; onDelete: () => void; canDelete: boolean }) {
  return (
    <article className={`journal-entry journal-entry--${update.kind}`}>
      <header><span>{humanise(update.kind)}</span><time dateTime={update.updatedAt}>{formatDate(update.updatedAt)}</time><button className="icon-button" aria-label="Revise update" onClick={onEdit}><Icon name="edit" size={17} /></button>{canDelete ? <button className="icon-button delete-update" aria-label="Delete update" onClick={onDelete}><Icon name="archive" size={17} /></button> : null}</header>
      <div className="markdown"><ReactMarkdown>{updateContent(update)}</ReactMarkdown></div>
      <RevisionHistory update={update} />
    </article>
  );
}

function RevisionHistory({ update }: { update: ProjectUpdate }) {
  const [open, setOpen] = useState(false);
  const revisions = useResource(() => open ? api.listUpdateRevisions(update.id) : Promise.resolve([]), [open, update.id]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Revision history</summary>
      {open && revisions.loading ? <p className="muted">Loading revisions…</p> : null}
      {revisions.data?.map((revision) => <div className="revision" key={revision.id}><span>Revision {revision.revision} · {formatDate(revision.createdAt)}</span><ReactMarkdown>{revision.content}</ReactMarkdown></div>)}
    </details>
  );
}

function ProjectSkeleton() {
  return <div aria-label="Loading project" className="page project-skeleton"><span /><span /><span /><span /></div>;
}
