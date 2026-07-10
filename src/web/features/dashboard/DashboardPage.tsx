import { useDeferredValue, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api";
import { EmptyState, ErrorNotice, Field, Overlay } from "../../components/Overlay";
import { Icon } from "../../components/Icon";
import { ProjectStatus } from "../../components/Status";
import { ActivityTimeline } from "../../components/Timeline";
import { formatDate, toActivityView } from "../../format";
import { projectStates, type Project, type ProjectState, type UpdateKind } from "../../types";
import { useResource } from "../../useResource";
import { NewProjectDialog } from "../projects/ProjectForms";

export function DashboardPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [showProjectDialog, setShowProjectDialog] = useState(false);
  const [showCapture, setShowCapture] = useState(false);
  const [stateFilter, setStateFilter] = useState<ProjectState | "all">("all");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const projects = useResource(() => api.listProjects({ state: stateFilter === "all" ? undefined : stateFilter }), [stateFilter]);
  const activity = useResource(() => api.listRecentActivity(4), []);

  useEffect(() => {
    const openQuickCapture = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      if (projects.data?.length) setShowCapture(true);
    };
    window.addEventListener("keydown", openQuickCapture);
    return () => window.removeEventListener("keydown", openQuickCapture);
  }, [projects.data?.length]);

  const filteredProjects = useMemo(() => {
    if (!projects.data || !deferredQuery) return projects.data ?? [];
    return projects.data.filter((project) =>
      [project.title, project.description, project.currentFocus, project.nextAction]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(deferredQuery)),
    );
  }, [projects.data, deferredQuery]);

  const recentActivity = useMemo(() => (activity.data ?? []).map((event) => toActivityView(event)), [activity.data]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    if (query.trim()) navigate(`/search?q=${encodeURIComponent(query.trim())}`);
  }

  async function reloadDashboard() {
    await Promise.all([projects.reload(), activity.reload()]);
  }

  return (
    <div className="page page--dashboard">
      <header className="page-heading dashboard-heading">
        <div>
          <h1>Project memory</h1>
          <p>Pick up where you left off.</p>
        </div>
      </header>

      <div className="dashboard-toolbar">
        <form className="search-box" onSubmit={submitSearch} role="search">
          <Icon name="search" size={22} />
          <input
            aria-label="Search projects, decisions and issues"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects, decisions and issues"
            value={query}
          />
        </form>
        <button className="button button--primary button--large" onClick={() => setShowProjectDialog(true)}>
          <Icon name="plus" /> New project
        </button>
      </div>

      {projects.error ? <ErrorNotice error={projects.error} onRetry={projects.reload} /> : null}

      <div className="dashboard-columns">
        <section aria-labelledby="projects-heading" className="project-list-section">
          <div className="list-heading"><h2 id="projects-heading">Project</h2><label className="state-filter"><span>State</span><select aria-label="Filter projects by state" onChange={(event) => setStateFilter(event.target.value as ProjectState | "all")} value={stateFilter}><option value="all">All</option>{projectStates.map((state) => <option key={state} value={state}>{state[0]?.toUpperCase()}{state.slice(1)}</option>)}</select></label><span>Last activity</span></div>
          {projects.loading ? <ProjectListSkeleton /> : null}
          {!projects.loading && filteredProjects.length === 0 ? (
            <EmptyState title={query ? "No matching projects" : "Start your project memory"} action={!query ? <button className="text-button" onClick={() => setShowProjectDialog(true)}><Icon name="plus" size={18} /> Create a project</button> : undefined}>
              {query ? "Try a broader search, or search all activity from the Search view." : "Projects can begin with nothing more than a name."}
            </EmptyState>
          ) : null}
          <div className="project-list">
            {filteredProjects.map((project) => <ProjectRow key={project.id} project={project} />)}
          </div>
          <button className="quick-capture" disabled={!projects.data?.length} onClick={() => setShowCapture(true)}>
            <Icon name="note" size={30} />
            <span><strong>Quick capture</strong><small>Jot a note, idea or next step. Press / to focus.</small></span>
          </button>
        </section>

        <aside aria-labelledby="recent-activity-heading" className="recent-activity">
          <h2 id="recent-activity-heading">Recent activity</h2>
          {activity.error ? <p className="timeline-empty">Recent activity is temporarily unavailable.</p> : <ActivityTimeline items={recentActivity} compact />}
        </aside>
      </div>

      {showProjectDialog ? <NewProjectDialog onClose={() => setShowProjectDialog(false)} onSaved={reloadDashboard} /> : null}
      {showCapture && projects.data ? <QuickCaptureDialog projects={projects.data} onClose={() => setShowCapture(false)} onSaved={reloadDashboard} /> : null}
    </div>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const accent = project.state === "paused" ? "rust" : project.state === "dormant" ? "grey" : project.state === "completed" ? "green" : "blue";
  return (
    <Link className={`project-row project-row--${accent}`} to={`/projects/${project.id}`}>
      <div className="project-row__title"><h3>{project.title}</h3><ProjectStatus state={project.state} /></div>
      <div className="project-row__pulse">
        <span><Icon name="target" size={20} /><strong>Current focus:</strong>{project.currentFocus || "Not set yet"}</span>
        <span><Icon name="arrow" size={20} /><strong>Next action:</strong>{project.nextAction || "Choose the next small step"}</span>
      </div>
      <time dateTime={project.lastActivityAt}>{formatDate(project.lastActivityAt)}</time>
      <Icon className="project-row__chevron" name="chevron" />
    </Link>
  );
}

function ProjectListSkeleton() {
  return <div aria-label="Loading projects" className="skeleton-list"><span /><span /><span /></div>;
}

function QuickCaptureDialog({ projects, onClose, onSaved }: { projects: Project[]; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true);
    setError(null);
    try {
      await api.createUpdate(String(data.get("projectId")), {
        kind: String(data.get("kind")) as Exclude<UpdateKind, "checkpoint">,
        content: String(data.get("content")),
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the update");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Overlay title="Quick capture" description="Add a durable note without leaving the dashboard." onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Project"><select name="projectId">{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></Field>
        <Field label="Type"><select name="kind" defaultValue="note"><option value="note">Note</option><option value="progress">Progress</option><option value="decision">Decision</option><option value="discovery">Discovery</option></select></Field>
        <Field label="What do you want to remember?"><textarea autoFocus name="content" rows={7} required /></Field>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="form-actions"><button className="button button--secondary" onClick={onClose} type="button">Cancel</button><button className="button button--primary" disabled={saving} type="submit">{saving ? "Saving…" : "Save update"}</button></div>
      </form>
    </Overlay>
  );
}
