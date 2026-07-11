import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { EmptyState, ErrorNotice, Overlay } from "../../components/Overlay";
import { Icon } from "../../components/Icon";
import { ProjectStatus } from "../../components/Status";
import { formatDate } from "../../format";
import type { Project } from "../../types";
import { useResource } from "../../useResource";

export function ArchivePage() {
  const projects = useResource(() => api.listProjects({ includeArchived: true }), []);
  const backups = useResource(() => api.backupStatus(), []);
  const [showData, setShowData] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const archived = useMemo(() => (projects.data ?? []).filter((project) => project.archivedAt), [projects.data]);

  async function restore(project: Project) {
    setMessage(null);
    try {
      await api.setArchived(project, false);
      await projects.reload();
      setMessage(`${project.title} was restored.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not restore the project");
    }
  }

  return (
    <div className="page page--archive">
      <header className="page-heading page-heading--actions">
        <div><h1>Archive</h1><p>Out of sight, never erased. Every project remains reopenable.</p></div>
        <button className="button button--secondary" onClick={() => setShowData(true)}><Icon name="database" size={18} /> Data & backups</button>
      </header>
      {message ? <p className="notice" role="status">{message}</p> : null}
      {projects.error ? <ErrorNotice error={projects.error} onRetry={projects.reload} /> : null}
      {!projects.loading && archived.length === 0 ? <EmptyState title="The archive is empty">Projects you archive will be preserved here with their phases, work items and history intact.</EmptyState> : null}
      <div className="archive-list">
        {archived.map((project) => (
          <article className="archive-row" key={project.id}>
            <div><Link to={`/projects/${project.id}`}><h2>{project.title}</h2></Link><ProjectStatus state={project.state} /></div>
            <p>{project.description || project.currentFocus || "No description"}</p>
            <time dateTime={project.archivedAt!}>Archived {formatDate(project.archivedAt)}</time>
            <button className="button button--secondary" onClick={() => void restore(project)}>Restore</button>
          </article>
        ))}
      </div>
      {showData ? <DataDialog backup={backups.data} onClose={() => setShowData(false)} onImported={async () => { await Promise.all([projects.reload(), backups.reload()]); }} /> : null}
    </div>
  );
}

function DataDialog({ backup, onClose, onImported }: { backup: Awaited<ReturnType<typeof api.backupStatus>> | null; onClose: () => void; onImported: () => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const isPostgres = backup?.backend === "postgresql";
  const importSupported = backup?.importSupported !== false;

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setStatus(null);
    try {
      const document = JSON.parse(await file.text()) as unknown;
      await api.importData(document);
      await onImported();
      setStatus("Import complete. The previous database was backed up first.");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Import failed");
    } finally {
      setImporting(false);
      event.target.value = "";
    }
  }

  return (
    <Overlay
      title="Data & backups"
      description={isPostgres ? "Your complete project memory lives in the configured PostgreSQL database." : "Your complete project memory lives in one local SQLite database."}
      onClose={onClose}
    >
      <div className="data-actions">
        <a className="data-action" download href={api.exportUrl}><Icon name="download" /><span><strong>Export all data</strong><small>Download a versioned JSON document with current and historical records.</small></span></a>
        <button className="data-action" disabled={importing || !importSupported} onClick={() => inputRef.current?.click()}><Icon name="upload" /><span><strong>{importing ? "Importing…" : "Import an export"}</strong><small>{importSupported ? "Validate and replace the current data after creating a safety backup." : "Unavailable for PostgreSQL until backup and restore support is configured."}</small></span></button>
        <input accept="application/json,.json" className="sr-only" onChange={(event) => void importFile(event)} ref={inputRef} type="file" />
      </div>
      {status ? <p className="notice" role="status">{status}</p> : null}
      <section className="backup-summary">
        <h3>Backup status</h3>
        <dl>
          <div><dt>Backend</dt><dd>{isPostgres ? "PostgreSQL" : "SQLite"}</dd></div>
          <div><dt>Last backup</dt><dd>{formatDate(backup?.lastBackupAt)}</dd></div>
          <div><dt>Stored snapshots</dt><dd>{backup?.backups?.length ?? 0}</dd></div>
          {backup?.databasePath ? <div><dt>Database</dt><dd className="path-value">{backup.databasePath}</dd></div> : null}
        </dl>
        {backup?.backups?.length ? <ol className="backup-list">{backup.backups.slice(0, 5).map((item) => <li key={item.name}><span>{item.kind}</span><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></li>)}</ol> : <p className="muted">{isPostgres ? "Automated PostgreSQL backups are not configured yet." : "The first daily backup is created before the next write."}</p>}
      </section>
    </Overlay>
  );
}
