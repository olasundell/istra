import { useState, type FormEvent } from "react";
import { api } from "../../api";
import { Field, Overlay } from "../../components/Overlay";
import {
  phaseStates,
  priorities,
  updateKinds,
  workItemKinds,
  workItemStatuses,
  type CreateProjectInput,
  type Label,
  type Phase,
  type Project,
  type ProjectUpdate,
  type WorkItem,
} from "../../types";
import { humanise, updateContent } from "../../format";

interface FormOverlayProps {
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function SubmitError({ message }: { message: string | null }) {
  return message ? <p className="form-error" role="alert">{message}</p> : null;
}

export function NewProjectDialog({ onClose, onSaved }: FormOverlayProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload: CreateProjectInput = {
      title: String(form.get("title") ?? ""),
      description: String(form.get("description") ?? "") || null,
      intent: String(form.get("intent") ?? "") || null,
      deadline: null,
      completionCriteria: null,
      source: "ui",
    };
    setSaving(true);
    setError(null);
    try {
      await api.createProject(payload);
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the project");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Overlay title="New project" description="A title is all you need. Everything else can emerge as you work." onClose={onClose}>
      <form className="form-stack" id="new-project-form" onSubmit={submit}>
        <Field label="Project title" htmlFor="new-project-title">
          <input autoFocus id="new-project-title" name="title" required maxLength={240} />
        </Field>
        <Field label="Description" hint="Optional — describe the shape of the project as it exists today." htmlFor="new-project-description">
          <textarea id="new-project-description" name="description" rows={4} maxLength={20000} />
        </Field>
        <Field label="Intent" hint="Optional and changeable." htmlFor="new-project-intent">
          <textarea id="new-project-intent" name="intent" rows={3} maxLength={20000} />
        </Field>
        <SubmitError message={error} />
        <div className="form-actions">
          <button className="button button--secondary" onClick={onClose} type="button">Cancel</button>
          <button className="button button--primary" disabled={saving} type="submit">{saving ? "Creating…" : "Create project"}</button>
        </div>
      </form>
    </Overlay>
  );
}

export function EditProjectDialog({ project, onClose, onSaved }: FormOverlayProps & { project: Project }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const deadline = String(form.get("deadline") ?? "");
    setSaving(true);
    setError(null);
    try {
      await api.updateProject(project, {
        expectedVersion: project.version,
        title: String(form.get("title") ?? ""),
        description: String(form.get("description") ?? "") || null,
        intent: String(form.get("intent") ?? "") || null,
        deadline: deadline ? new Date(`${deadline}T00:00:00.000Z`).toISOString() : null,
        completionCriteria: String(form.get("completionCriteria") ?? "") || null,
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save project details");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Overlay title="Edit project" description="Intent, deadlines and completion criteria are optional and can change at any time." onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Title"><input autoFocus name="title" required maxLength={240} defaultValue={project.title} /></Field>
        <Field label="Description"><textarea name="description" rows={3} defaultValue={project.description ?? ""} /></Field>
        <Field label="Intent"><textarea name="intent" rows={3} defaultValue={project.intent ?? ""} /></Field>
        <Field label="Deadline"><input name="deadline" type="date" defaultValue={project.deadline?.slice(0, 10) ?? ""} /></Field>
        <Field label="Completion criteria"><textarea name="completionCriteria" rows={3} defaultValue={project.completionCriteria ?? ""} /></Field>
        <SubmitError message={error} />
        <div className="form-actions"><button className="button button--secondary" onClick={onClose} type="button">Cancel</button><button className="button button--primary" disabled={saving} type="submit">{saving ? "Saving…" : "Save project"}</button></div>
      </form>
    </Overlay>
  );
}

export function CheckpointDrawer({ project, onClose, onSaved }: FormOverlayProps & { project: Project }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError(null);
    try {
      await api.createCheckpoint(project, {
        content: String(form.get("content") ?? ""),
        currentFocus: String(form.get("currentFocus") ?? "") || null,
        nextAction: String(form.get("nextAction") ?? "") || null,
        blockers: String(form.get("blockers") ?? "").split("\n").map((entry) => entry.trim()).filter(Boolean),
      });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record the checkpoint");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Overlay title="Record checkpoint" onClose={onClose} variant="drawer" footer={
      <>
        <button className="button button--secondary" onClick={onClose} type="button">Cancel</button>
        <button className="button button--primary" disabled={saving} form="checkpoint-form" type="submit">{saving ? "Saving…" : "Save checkpoint"}</button>
      </>
    }>
      <form className="form-stack checkpoint-form" id="checkpoint-form" onSubmit={submit}>
        <Field label="What changed?" htmlFor="checkpoint-content">
          <textarea autoFocus id="checkpoint-content" name="content" rows={7} required maxLength={100000} />
        </Field>
        <div className="field-rule" />
        <Field label="Current focus" htmlFor="checkpoint-focus">
          <textarea id="checkpoint-focus" name="currentFocus" rows={5} maxLength={20000} defaultValue={project.currentFocus ?? ""} />
        </Field>
        <Field label="Next action" htmlFor="checkpoint-action">
          <textarea id="checkpoint-action" name="nextAction" rows={5} maxLength={20000} defaultValue={project.nextAction ?? ""} />
        </Field>
        <Field label="Blockers" hint="One per line" htmlFor="checkpoint-blockers">
          <textarea id="checkpoint-blockers" name="blockers" rows={5} maxLength={20000} defaultValue={project.blockers.join("\n")} />
        </Field>
        <SubmitError message={error} />
      </form>
    </Overlay>
  );
}

export function PhaseDialog({ projectId, phase, onClose, onSaved }: FormOverlayProps & { projectId: string; phase?: Phase }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const payload = {
        name: String(form.get("name") ?? ""),
        description: String(form.get("description") ?? "") || null,
        status: String(form.get("status") ?? "planned") as Phase["status"],
        ...(phase ? { position: Number(form.get("position") ?? phase.position), archived: form.get("archived") === "on" } : {}),
      };
      if (phase) await api.updatePhase(phase, payload);
      else await api.createPhase(projectId, payload);
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the phase");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Overlay title={phase ? "Edit phase" : "Add phase"} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Name"><input autoFocus name="name" required maxLength={240} defaultValue={phase?.name} /></Field>
        <Field label="Description"><textarea name="description" rows={3} defaultValue={phase?.description ?? ""} /></Field>
        <Field label="Status"><select name="status" defaultValue={phase?.status ?? "planned"}>{phaseStates.map((state) => <option key={state} value={state}>{humanise(state)}</option>)}</select></Field>
        {phase ? <Field label="Order" hint="Lower numbers appear earlier in the phase track."><input name="position" type="number" min="0" step="1" defaultValue={phase.position} /></Field> : null}
        {phase ? <label className="check-field"><input name="archived" type="checkbox" defaultChecked={Boolean(phase.archivedAt)} /><span>Archive this phase</span></label> : null}
        <SubmitError message={error} />
        <div className="form-actions"><button className="button button--secondary" onClick={onClose} type="button">Cancel</button><button className="button button--primary" disabled={saving} type="submit">{saving ? "Saving…" : "Save phase"}</button></div>
      </form>
    </Overlay>
  );
}

export function WorkItemDialog({ projectId, item, phases, labels, onClose, onSaved }: FormOverlayProps & { projectId: string; item?: WorkItem; phases: Phase[]; labels: Label[] }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const newLabelName = String(form.get("newLabel") ?? "").trim();
      const newLabel = newLabelName ? await api.createLabel({ name: newLabelName, colour: null }) : null;
      const payload = {
        title: String(form.get("title") ?? ""),
        description: String(form.get("description") ?? "") || null,
        kind: String(form.get("kind") ?? "task") as WorkItem["kind"],
        status: String(form.get("status") ?? "open") as WorkItem["status"],
        priority: (String(form.get("priority") ?? "") || null) as WorkItem["priority"],
        phaseId: String(form.get("phaseId") ?? "") || null,
        labelIds: [...form.getAll("labelIds").map(String), ...(newLabel ? [newLabel.id] : [])],
      };
      if (item) await api.updateWorkItem(item, payload);
      else await api.createWorkItem(projectId, payload);
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the work item");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Overlay title={item ? "Edit work item" : "Add work item"} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Title"><input autoFocus name="title" required maxLength={500} defaultValue={item?.title} /></Field>
        <div className="form-grid">
          <Field label="Type"><select name="kind" defaultValue={item?.kind ?? "task"}>{workItemKinds.map((kind) => <option key={kind} value={kind}>{humanise(kind)}</option>)}</select></Field>
          <Field label="Status"><select name="status" defaultValue={item?.status ?? "open"}>{workItemStatuses.map((status) => <option key={status} value={status}>{humanise(status)}</option>)}</select></Field>
        </div>
        <div className="form-grid">
          <Field label="Priority"><select name="priority" defaultValue={item?.priority ?? ""}><option value="">No priority</option>{priorities.map((priority) => <option key={priority} value={priority}>{humanise(priority)}</option>)}</select></Field>
          <Field label="Phase"><select name="phaseId" defaultValue={item?.phaseId ?? ""}><option value="">No phase</option>{phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}</select></Field>
        </div>
        <Field label="Details"><textarea name="description" rows={4} defaultValue={item?.description ?? ""} /></Field>
        <fieldset className="label-fieldset">
          <legend>Labels</legend>
          {labels.length ? <div className="label-options">{labels.map((label) => <label className="check-field" key={label.id}><input defaultChecked={item?.labels.some((assigned) => assigned.id === label.id)} name="labelIds" type="checkbox" value={label.id} /><span className="label-chip" style={label.colour ? { "--label-colour": label.colour } as React.CSSProperties : undefined}>{label.name}</span></label>)}</div> : <p className="muted">No reusable labels yet.</p>}
          <Field label="Create and assign a new label"><input name="newLabel" maxLength={100} placeholder="e.g. hardware" /></Field>
        </fieldset>
        <SubmitError message={error} />
        <div className="form-actions"><button className="button button--secondary" onClick={onClose} type="button">Cancel</button><button className="button button--primary" disabled={saving} type="submit">{saving ? "Saving…" : "Save work item"}</button></div>
      </form>
    </Overlay>
  );
}

export function UpdateDialog({ projectId, update, onClose, onSaved }: FormOverlayProps & { projectId: string; update?: ProjectUpdate }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      const content = String(form.get("content") ?? "");
      if (update) await api.reviseUpdate(update, content);
      else await api.createUpdate(projectId, { kind: String(form.get("kind") ?? "note") as "note", content });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the update");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Overlay title={update ? "Revise update" : "Add update"} description={update ? "The previous revision remains available in history." : "Capture progress without replacing the current checkpoint."} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        {!update ? <Field label="Update type"><select name="kind" defaultValue="note">{updateKinds.filter((kind) => kind !== "checkpoint").map((kind) => <option key={kind} value={kind}>{humanise(kind)}</option>)}</select></Field> : null}
        <Field label="What happened?"><textarea autoFocus name="content" rows={8} required maxLength={100000} defaultValue={update ? updateContent(update) : ""} /></Field>
        <SubmitError message={error} />
        <div className="form-actions"><button className="button button--secondary" onClick={onClose} type="button">Cancel</button><button className="button button--primary" disabled={saving} type="submit">{saving ? "Saving…" : update ? "Save revision" : "Add update"}</button></div>
      </form>
    </Overlay>
  );
}
