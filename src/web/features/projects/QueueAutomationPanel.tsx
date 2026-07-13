import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Field, Overlay } from "../../components/Overlay";
import { formatDate, humanise } from "../../format";
import type { QueueAutomationLeaseSummary, QueueAutomationOverview, QueueAutomationPolicy, WorkQueue } from "../../types";
import { useQueueAutomationOverview } from "./useQueueAutomationOverview";

export function QueueAutomationPanel({ projectId, queues, queuesLoading, queuesError, onEligibilityChanged }: {
  projectId: string;
  queues: WorkQueue[];
  queuesLoading: boolean;
  queuesError: Error | null;
  onEligibilityChanged: () => void | Promise<void>;
}) {
  const currentQueues = queues.filter((queue) => queue.projectId === projectId);
  const [selectedQueueId, setSelectedQueueId] = useState("");
  const [editing, setEditing] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [releasingLeaseId, setReleasingLeaseId] = useState<string | null>(null);
  const releaseKeys = useRef(new Map<string, { key: string; version: number }>());
  const activeQueueId = currentQueues.some((queue) => queue.id === selectedQueueId) ? selectedQueueId : currentQueues[0]?.id ?? "";
  const activeQueue = currentQueues.find((queue) => queue.id === activeQueueId);
  const overview = useQueueAutomationOverview(projectId, activeQueueId, onEligibilityChanged);
  const currentOverview = overview.data?.policy.projectId === projectId && overview.data.policy.queueId === activeQueueId ? overview.data : null;

  useEffect(() => {
    setSelectedQueueId((selected) => currentQueues.some((queue) => queue.id === selected) ? selected : currentQueues[0]?.id ?? "");
    setEditing(false);
    setMutationError(null);
  }, [projectId, queues]);

  function selectQueue(queueId: string) {
    setEditing(false);
    setMutationError(null);
    setSelectedQueueId(queueId);
  }

  async function releaseLease(lease: QueueAutomationLeaseSummary) {
    const state = lease.state === "expired" ? "expired" : "active";
    if (!window.confirm(`Release the ${state} lease for “${lease.workItemTitle}” held by ${lease.workerId}? Unchanged work will return to the open queue.`)) return;
    setMutationError(null);
    setReleasingLeaseId(lease.id);
    const existingIntent = releaseKeys.current.get(lease.id);
    const idempotencyKey = existingIntent?.version === lease.version ? existingIntent.key : crypto.randomUUID();
    releaseKeys.current.set(lease.id, { key: idempotencyKey, version: lease.version });
    try {
      await api.releaseAutomatedWork(lease.id, lease.version, idempotencyKey);
      releaseKeys.current.delete(lease.id);
      overview.reload();
      await onEligibilityChanged();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Could not release the lease");
    } finally {
      setReleasingLeaseId(null);
    }
  }

  const error = queuesError ?? overview.error;
  return (
    <section aria-labelledby="queue-automation-heading" className="queue-automation-section">
      <div className="section-heading-row">
        <div><h2 className="section-kicker" id="queue-automation-heading">Automation</h2><p>Coordinate external runners without giving Istra command or credential access.</p></div>
        {currentOverview ? <span className={`automation-state automation-state--${currentOverview.policy.enabled ? "enabled" : "disabled"}`}>{currentOverview.policy.enabled ? "Enabled" : "Disabled"}</span> : null}
      </div>
      {queuesLoading ? <p className="operational-memory__empty">Loading queue automation…</p> : error ? <p className="form-error" role="alert">{error.message}</p> : !activeQueue ? <p className="operational-memory__empty">Create a work queue before enabling automation.</p> : currentOverview ? (
        <>
          <div className="automation-toolbar">
            <label><span>Queue</span><select aria-label="Automation queue" disabled={currentQueues.length < 2} onChange={(event) => selectQueue(event.target.value)} value={activeQueueId}>{currentQueues.map((queue) => <option key={queue.id} value={queue.id}>{queue.name}</option>)}</select></label>
            <button className="button button--secondary" disabled={overview.loading} onClick={() => setEditing(true)} type="button">Configure policy</button>
          </div>
          {overview.liveError ? <div className="automation-live-error" role="status"><span>Live updates paused: {overview.liveError.message}</span><button className="text-button" onClick={overview.reload} type="button">Retry</button></div> : <p className="sr-only" aria-live="polite">Queue automation updates are live.</p>}
          {mutationError ? <p className="form-error" role="alert">{mutationError}</p> : null}
          <div className="automation-grid">
            <AutomationSummary overview={currentOverview} />
            <div className="automation-card"><span>Active leases</span><strong>{currentOverview.activeLeases.length}</strong><small>Capacity {currentOverview.policy.maxActiveClaims}</small></div>
            <div className="automation-card"><span>Lease window</span><strong>{Math.round(currentOverview.policy.leaseSeconds / 60)} min</strong><small>{currentOverview.policy.requiresManualApproval ? "Manual delivery approval" : "May auto-resolve"}</small></div>
          </div>
          <LeaseList heading="Active leases" leases={currentOverview.activeLeases} releasingLeaseId={releasingLeaseId} onRelease={releaseLease} />
          <LeaseList heading="Expired leases requiring recovery" leases={currentOverview.expiredLeases} releasingLeaseId={releasingLeaseId} onRelease={releaseLease} />
          {!currentOverview.activeLeases.length && !currentOverview.expiredLeases.length ? <p className="automation-empty">No unreleased runner lease.</p> : null}
          {currentOverview.lastAttempt ? <div className="automation-attempt"><span>Latest attempt</span><strong>{currentOverview.lastAttempt.outcome ? humanise(currentOverview.lastAttempt.outcome) : "In progress"}</strong><small>Attempt {currentOverview.lastAttempt.ordinal} · {formatDate(currentOverview.lastAttempt.startedAt)} · {currentOverview.lastAttempt.observations.length} observations</small></div> : null}
          {editing ? <AutomationPolicyDialog policy={currentOverview.policy} queueName={activeQueue.name} onClose={() => setEditing(false)} onSaved={async () => { overview.reload(); await onEligibilityChanged(); setEditing(false); }} /> : null}
        </>
      ) : <p className="operational-memory__empty">Loading queue automation…</p>}
    </section>
  );
}

function AutomationSummary({ overview }: { overview: QueueAutomationOverview }) {
  return <div className="automation-card"><span>Eligible kinds</span><strong>{overview.policy.allowedKinds.map(humanise).join(" + ")}</strong><small>{overview.policy.allowSameWorkerRecovery ? "Same-worker recovery" : "Manual recovery only"}</small></div>;
}

function LeaseList({ heading, leases, releasingLeaseId, onRelease }: {
  heading: string;
  leases: QueueAutomationLeaseSummary[];
  releasingLeaseId: string | null;
  onRelease: (lease: QueueAutomationLeaseSummary) => void | Promise<void>;
}) {
  if (!leases.length) return null;
  return <div className="automation-list"><h3>{heading}</h3>{leases.map((lease) => (
    <div className="automation-list__row" key={lease.id}>
      <div className="automation-list__identity">
        <div><strong>{lease.workItemTitle}</strong><span className={`automation-lease-state automation-lease-state--${lease.state}`}>{humanise(lease.state)}</span></div>
        <span>Work item {lease.workItemId.slice(0, 8)} · {humanise(lease.workItemStatus)} · worker {lease.workerId}</span>
        <span>Heartbeat <AutomationTime value={lease.heartbeatAt} /> · expires <AutomationTime value={lease.expiresAt} /></span>
      </div>
      <button
        aria-label={`Release lease for ${lease.workItemTitle} held by ${lease.workerId}`}
        className="button button--danger"
        disabled={releasingLeaseId === lease.id}
        onClick={() => void onRelease(lease)}
        type="button"
      >{releasingLeaseId === lease.id ? "Releasing…" : "Release"}</button>
    </div>
  ))}</div>;
}

function AutomationTime({ value }: { value: string }) {
  const date = new Date(value);
  const label = Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date);
  return <time dateTime={value}>{label}</time>;
}

function AutomationPolicyDialog({ policy, queueName, onClose, onSaved }: { policy: QueueAutomationPolicy; queueName: string; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kindsError, setKindsError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const allowedKinds = form.getAll("allowedKinds").map(String) as Array<"issue" | "task">;
    if (!allowedKinds.length) {
      setKindsError("Select at least one eligible work-item kind.");
      formRef.current?.querySelector<HTMLInputElement>('input[name="allowedKinds"]')?.focus();
      return;
    }
    setKindsError(null);
    setSaving(true);
    setError(null);
    try {
      await api.updateQueueAutomationPolicy(policy.projectId, policy.queueId, {
        expectedVersion: policy.version || null,
        enabled: form.get("enabled") === "on",
        allowedKinds,
        maxActiveClaims: Number(form.get("maxActiveClaims")),
        leaseSeconds: Number(form.get("leaseMinutes")) * 60,
        requiresManualApproval: form.get("requiresManualApproval") === "on",
        allowSameWorkerRecovery: form.get("allowSameWorkerRecovery") === "on",
      });
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the policy"); } finally { setSaving(false); }
  }

  return <Overlay title={`Automation · ${queueName}`} description="Automated claiming is opt-in. Istra coordinates leases; the external runner owns execution." onClose={onClose}>
    <form className="form-stack" onSubmit={submit} ref={formRef}>
      <label className="check-field"><input name="enabled" type="checkbox" defaultChecked={policy.enabled} /><span>Enable automated claiming</span></label>
      <fieldset aria-describedby={kindsError ? "automation-kinds-error" : undefined} className="label-fieldset"><legend>Eligible work-item kinds</legend><div className="label-options">{(["issue", "task"] as const).map((kind) => <label className="check-field" key={kind}><input name="allowedKinds" type="checkbox" value={kind} defaultChecked={policy.allowedKinds.includes(kind)} onChange={() => setKindsError(null)} /><span>{humanise(kind)}</span></label>)}</div>{kindsError ? <p className="field-error" id="automation-kinds-error" role="alert">{kindsError}</p> : null}</fieldset>
      <div className="form-grid">
        <Field label="Maximum active claims"><input name="maxActiveClaims" type="number" min="1" max="32" defaultValue={policy.maxActiveClaims} required /></Field>
        <Field label="Lease duration (minutes)"><input name="leaseMinutes" type="number" min="1" max="90" defaultValue={Math.round(policy.leaseSeconds / 60)} required /></Field>
      </div>
      <label className="check-field"><input name="requiresManualApproval" type="checkbox" defaultChecked={policy.requiresManualApproval} /><span>Require manual approval before resolution</span></label>
      <label className="check-field"><input name="allowSameWorkerRecovery" type="checkbox" defaultChecked={policy.allowSameWorkerRecovery} /><span>Allow the same worker to recover its expired lease</span></label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="form-actions"><button className="button button--secondary" onClick={onClose} type="button">Cancel</button><button className="button button--primary" disabled={saving} type="submit">{saving ? "Saving…" : "Save policy"}</button></div>
    </form>
  </Overlay>;
}
