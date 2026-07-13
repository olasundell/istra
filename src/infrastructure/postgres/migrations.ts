import { postgresAutomationMigration } from './automation-migration.js'

export interface PostgresMigration {
  version: number
  name: string
  sql: string
}

export const postgresMigrations: PostgresMigration[] = [{
  version: 1,
  name: 'authoritative_ledger',
  sql: `
    CREATE TABLE projects (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL CHECK(length(trim(title)) > 0),
      description TEXT,
      intent TEXT,
      deadline TIMESTAMPTZ,
      completion_criteria TEXT,
      state TEXT NOT NULL CHECK(state IN ('active','paused','dormant','completed')),
      current_focus TEXT,
      next_action TEXT,
      blockers_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(blockers_json) = 'array'),
      current_checkpoint_id UUID,
      archived_at TIMESTAMPTZ,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE phases (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      description TEXT,
      status TEXT NOT NULL CHECK(status IN ('planned','active','completed','abandoned')),
      position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
      archived_at TIMESTAMPTZ,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(id, project_id)
    );
    CREATE INDEX phases_project_position ON phases(project_id, position, created_at);

    CREATE TABLE work_items (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      phase_id UUID,
      stable_key TEXT,
      parent_id UUID,
      kind TEXT NOT NULL CHECK(kind IN ('issue','task','idea','question','risk')),
      title TEXT NOT NULL CHECK(length(trim(title)) > 0),
      description TEXT,
      status TEXT NOT NULL CHECK(status IN ('open','in_progress','blocked','resolved','dropped')),
      priority TEXT CHECK(priority IS NULL OR priority IN ('low','medium','high','critical')),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(id, project_id),
      FOREIGN KEY(phase_id, project_id) REFERENCES phases(id, project_id) ON DELETE SET NULL (phase_id),
      FOREIGN KEY(parent_id, project_id) REFERENCES work_items(id, project_id) ON DELETE SET NULL (parent_id)
    );
    CREATE INDEX work_items_project_status ON work_items(project_id, status, updated_at DESC);
    CREATE INDEX work_items_phase ON work_items(phase_id, project_id);
    CREATE INDEX work_items_parent ON work_items(parent_id, project_id);
    CREATE UNIQUE INDEX work_items_project_stable_key ON work_items(project_id, lower(stable_key)) WHERE stable_key IS NOT NULL;

    CREATE TABLE labels (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      colour TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE UNIQUE INDEX labels_name_nocase ON labels(lower(name));

    CREATE TABLE work_item_labels (
      work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(work_item_id, label_id)
    );
    CREATE INDEX work_item_labels_label ON work_item_labels(label_id);

    CREATE TABLE updates (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('note','progress','decision','discovery','checkpoint')),
      current_revision_id UUID NOT NULL,
      deleted_at TIMESTAMPTZ,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX updates_project_created ON updates(project_id, created_at DESC);

    CREATE TABLE update_revisions (
      id UUID PRIMARY KEY,
      update_id UUID NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision > 0),
      content TEXT NOT NULL,
      snapshot_json JSONB,
      source TEXT NOT NULL,
      client TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE(id, update_id),
      UNIQUE(update_id, revision)
    );
    ALTER TABLE updates ADD CONSTRAINT updates_current_revision_fkey
      FOREIGN KEY(current_revision_id, id) REFERENCES update_revisions(id, update_id)
      DEFERRABLE INITIALLY DEFERRED;
    ALTER TABLE projects ADD CONSTRAINT projects_current_checkpoint_fkey
      FOREIGN KEY(current_checkpoint_id) REFERENCES updates(id)
      DEFERRABLE INITIALLY DEFERRED;
    CREATE INDEX projects_current_checkpoint ON projects(current_checkpoint_id);
    CREATE INDEX updates_current_revision ON updates(current_revision_id, id);
    CREATE INDEX update_revisions_update ON update_revisions(update_id, revision DESC);

    CREATE TABLE activity_events (
      id UUID PRIMARY KEY,
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      payload_json JSONB NOT NULL,
      source TEXT NOT NULL,
      client TEXT,
      actor TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX activity_project_created ON activity_events(project_id, created_at DESC, id DESC);
    CREATE INDEX activity_global_created ON activity_events(created_at DESC, id DESC);
    CREATE INDEX activity_entity_created ON activity_events(entity_type, entity_id, created_at DESC, id DESC);

    CREATE TABLE search_index (
      entity_type TEXT NOT NULL CHECK(entity_type IN ('project','phase','work_item','update','requirement','run','evidence')),
      entity_id UUID NOT NULL,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(body, '')), 'B')
      ) STORED,
      PRIMARY KEY(entity_type, entity_id)
    );
    CREATE INDEX search_index_vector ON search_index USING GIN(search_vector);
    CREATE INDEX search_index_project_type ON search_index(project_id, entity_type);

    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE requirement_states (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      semantic TEXT NOT NULL CHECK(semantic IN ('open','partial','proven','defect')),
      position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
      colour TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(id, project_id)
    );
    CREATE UNIQUE INDEX requirement_states_project_name ON requirement_states(project_id, lower(name));
    CREATE INDEX requirement_states_project_position ON requirement_states(project_id, position, created_at);

    CREATE TABLE requirements (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      stable_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('goal','capability','requirement')),
      parent_id UUID,
      title TEXT NOT NULL CHECK(length(trim(title)) > 0),
      description TEXT,
      state_id UUID NOT NULL,
      responsible_phase_id UUID,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(id, project_id),
      FOREIGN KEY(parent_id, project_id) REFERENCES requirements(id, project_id) ON DELETE SET NULL (parent_id),
      FOREIGN KEY(state_id, project_id) REFERENCES requirement_states(id, project_id),
      FOREIGN KEY(responsible_phase_id, project_id) REFERENCES phases(id, project_id) ON DELETE SET NULL (responsible_phase_id)
    );
    CREATE UNIQUE INDEX requirements_project_stable_key ON requirements(project_id, lower(stable_key));
    CREATE INDEX requirements_project_updated ON requirements(project_id, updated_at DESC, id);
    CREATE INDEX requirements_parent ON requirements(parent_id, project_id);
    CREATE INDEX requirements_state ON requirements(state_id, project_id);
    CREATE INDEX requirements_responsible_phase ON requirements(responsible_phase_id, project_id);

    CREATE TABLE requirement_key_aliases (
      requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(requirement_id, alias)
    );
    CREATE UNIQUE INDEX requirement_key_aliases_alias ON requirement_key_aliases(lower(alias));

    CREATE TABLE acceptance_criteria (
      id UUID PRIMARY KEY,
      requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK(length(trim(title)) > 0),
      description TEXT,
      position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
      required BOOLEAN NOT NULL DEFAULT true,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX acceptance_criteria_requirement ON acceptance_criteria(requirement_id, archived_at, position, id);

    CREATE TABLE requirement_phase_links (
      requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      phase_id UUID NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('responsible','related')),
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(requirement_id, phase_id)
    );
    CREATE INDEX requirement_phase_links_phase ON requirement_phase_links(phase_id);

    CREATE TABLE work_queues (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      description TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE UNIQUE INDEX work_queues_project_name ON work_queues(project_id, lower(name));

    CREATE TABLE work_queue_items (
      queue_id UUID NOT NULL REFERENCES work_queues(id) ON DELETE CASCADE,
      work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      rank TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(queue_id, work_item_id),
      UNIQUE(queue_id, rank)
    );
    CREATE INDEX work_queue_items_order ON work_queue_items(queue_id, rank, work_item_id);
    CREATE INDEX work_queue_items_work_item ON work_queue_items(work_item_id);

    CREATE TABLE requirement_work_links (
      requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(requirement_id, work_item_id)
    );
    CREATE INDEX requirement_work_links_work_item ON requirement_work_links(work_item_id);

    CREATE TABLE work_phase_links (
      work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      phase_id UUID NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('responsible','related')),
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(work_item_id, phase_id)
    );
    CREATE INDEX work_phase_links_phase ON work_phase_links(phase_id);

    CREATE TABLE work_relations (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      from_work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      to_work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('depends_on','blocks','relates_to')),
      created_at TIMESTAMPTZ NOT NULL,
      CHECK(from_work_item_id <> to_work_item_id),
      UNIQUE(from_work_item_id, to_work_item_id, kind)
    );
    CREATE INDEX work_relations_from ON work_relations(from_work_item_id, kind);
    CREATE INDEX work_relations_to ON work_relations(to_work_item_id, kind);
    CREATE INDEX work_relations_project ON work_relations(project_id, created_at, id);

    CREATE TABLE external_blockers (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      work_item_id UUID REFERENCES work_items(id) ON DELETE CASCADE,
      content TEXT NOT NULL CHECK(length(trim(content)) > 0),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX external_blockers_open ON external_blockers(project_id, resolved_at, created_at DESC);
    CREATE INDEX external_blockers_work_item ON external_blockers(work_item_id, resolved_at);

    CREATE TABLE workspaces (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      canonical_root TEXT NOT NULL UNIQUE,
      remote TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE workspace_aliases (
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      alias TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(workspace_id, alias)
    );

    CREATE TABLE project_workspaces (
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(project_id, workspace_id)
    );
    CREATE INDEX project_workspaces_workspace ON project_workspaces(workspace_id);

    CREATE TABLE workspace_revisions (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      branch TEXT,
      "commit" TEXT,
      dirty BOOLEAN NOT NULL DEFAULT false,
      diff_hash TEXT,
      captured_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX workspace_revisions_captured ON workspace_revisions(workspace_id, captured_at DESC, id);

    CREATE TABLE project_secret_names (
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(project_id, name)
    );
    CREATE UNIQUE INDEX project_secret_names_nocase ON project_secret_names(project_id, lower(name));

    CREATE TABLE runs (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workspace_revision_id UUID REFERENCES workspace_revisions(id) ON DELETE SET NULL,
      command TEXT NOT NULL CHECK(length(trim(command)) > 0),
      working_directory TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      duration_ms BIGINT CHECK(duration_ms IS NULL OR duration_ms >= 0),
      outcome TEXT NOT NULL CHECK(outcome IN ('recorded','verified','failed','interrupted')),
      exit_code INTEGER,
      toolchain_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(toolchain_json) = 'object'),
      stdout_excerpt TEXT,
      stderr_excerpt TEXT,
      stdout_truncated BOOLEAN NOT NULL DEFAULT false,
      stderr_truncated BOOLEAN NOT NULL DEFAULT false,
      validation_status TEXT NOT NULL CHECK(validation_status = 'validated'),
      redaction_json JSONB NOT NULL DEFAULT '{"count":0,"fields":[]}'::jsonb CHECK(jsonb_typeof(redaction_json) = 'object'),
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX runs_project_started ON runs(project_id, started_at DESC, id);
    CREATE INDEX runs_workspace_revision ON runs(workspace_revision_id);

    CREATE TABLE test_summaries (
      id UUID PRIMARY KEY,
      run_id UUID NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      passed INTEGER NOT NULL CHECK(passed >= 0),
      failed INTEGER NOT NULL CHECK(failed >= 0),
      skipped INTEGER NOT NULL CHECK(skipped >= 0),
      target_count INTEGER NOT NULL CHECK(target_count >= 0 AND target_count = passed + failed + skipped),
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE artifact_references (
      id UUID PRIMARY KEY,
      run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
      uri TEXT NOT NULL,
      media_type TEXT,
      byte_count BIGINT CHECK(byte_count IS NULL OR byte_count >= 0),
      digest TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX artifact_references_run ON artifact_references(run_id, created_at, id);

    CREATE TABLE evidence (
      id UUID PRIMARY KEY,
      ordinal BIGINT GENERATED BY DEFAULT AS IDENTITY UNIQUE CHECK(ordinal > 0),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
      result TEXT NOT NULL CHECK(result IN ('recorded','verified','failed','interrupted')),
      summary TEXT NOT NULL,
      target_version INTEGER,
      stale BOOLEAN NOT NULL DEFAULT false,
      stale_reason TEXT,
      validation_status TEXT NOT NULL CHECK(validation_status IN ('validated','overridden')),
      redaction_json JSONB NOT NULL DEFAULT '{"count":0,"fields":[]}'::jsonb CHECK(jsonb_typeof(redaction_json) = 'object'),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX evidence_project_created ON evidence(project_id, ordinal DESC);
    CREATE INDEX evidence_run ON evidence(run_id);

    CREATE TABLE evidence_requirement_links (
      evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
      PRIMARY KEY(evidence_id, requirement_id)
    );
    CREATE INDEX evidence_requirement_links_requirement ON evidence_requirement_links(requirement_id);

    CREATE TABLE evidence_criterion_links (
      evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      criterion_id UUID NOT NULL REFERENCES acceptance_criteria(id) ON DELETE CASCADE,
      criterion_version INTEGER NOT NULL CHECK(criterion_version > 0),
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(evidence_id, criterion_id)
    );
    CREATE INDEX evidence_criterion_lookup ON evidence_criterion_links(criterion_id, created_at DESC, evidence_id DESC);

    CREATE TABLE evidence_work_links (
      evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      PRIMARY KEY(evidence_id, work_item_id)
    );
    CREATE INDEX evidence_work_links_work_item ON evidence_work_links(work_item_id);

    CREATE TABLE evidence_update_links (
      evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      update_id UUID NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      PRIMARY KEY(evidence_id, update_id)
    );
    CREATE INDEX evidence_update_links_update ON evidence_update_links(update_id);

    CREATE TABLE evidence_checkpoint_links (
      evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      checkpoint_id UUID NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
      PRIMARY KEY(evidence_id, checkpoint_id)
    );
    CREATE INDEX evidence_checkpoint_links_checkpoint ON evidence_checkpoint_links(checkpoint_id);

    CREATE TABLE evidence_artifact_links (
      evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
      artifact_id UUID NOT NULL REFERENCES artifact_references(id) ON DELETE CASCADE,
      PRIMARY KEY(evidence_id, artifact_id)
    );
    CREATE INDEX evidence_artifact_links_artifact ON evidence_artifact_links(artifact_id);

    CREATE TABLE evidence_overrides (
      evidence_id UUID PRIMARY KEY REFERENCES evidence(id) ON DELETE CASCADE,
      reason TEXT NOT NULL CHECK(length(trim(reason)) >= 20),
      actor TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('ui','import','system')),
      client TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE checkpoint_snapshots (
      id UUID PRIMARY KEY,
      checkpoint_id UUID NOT NULL UNIQUE REFERENCES updates(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL DEFAULT 3 CHECK(schema_version = 3),
      captured_at TIMESTAMPTZ NOT NULL,
      document_json JSONB NOT NULL CHECK(jsonb_typeof(document_json) = 'object'),
      digest TEXT NOT NULL
    );

    CREATE TABLE idempotency_records (
      client TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json JSONB NOT NULL DEFAULT 'null'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(client, idempotency_key)
    );

    CREATE FUNCTION istra_validate_current_checkpoint() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.current_checkpoint_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM updates
        WHERE id = NEW.current_checkpoint_id
          AND project_id = NEW.id
          AND kind = 'checkpoint'
          AND deleted_at IS NULL
      ) THEN
        RAISE EXCEPTION 'invalid current checkpoint' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER projects_current_checkpoint_guard
      AFTER INSERT OR UPDATE OF current_checkpoint_id ON projects
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION istra_validate_current_checkpoint();

    CREATE FUNCTION istra_cleanup_evidence_artifact() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      DELETE FROM artifact_references artifact
      WHERE artifact.id = OLD.artifact_id
        AND artifact.run_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM evidence_artifact_links link
          WHERE link.artifact_id = OLD.artifact_id
        );
      RETURN OLD;
    END;
    $$;
    CREATE TRIGGER cleanup_evidence_artifact
      AFTER DELETE ON evidence_artifact_links
      FOR EACH ROW EXECUTE FUNCTION istra_cleanup_evidence_artifact();

    CREATE FUNCTION istra_cleanup_detached_run_artifact() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.run_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM evidence_artifact_links link WHERE link.artifact_id = NEW.id
      ) THEN
        DELETE FROM artifact_references WHERE id = NEW.id;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER cleanup_run_artifacts
      AFTER UPDATE OF run_id ON artifact_references
      FOR EACH ROW
      WHEN (OLD.run_id IS NOT NULL AND NEW.run_id IS NULL)
      EXECUTE FUNCTION istra_cleanup_detached_run_artifact();
  `,
}, {
  version: 2,
  name: 'global_error_reports',
  sql: `
    CREATE TABLE error_reports (
      id UUID PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('bug','design')),
      component TEXT NOT NULL CHECK(length(trim(component)) > 0 AND length(component) <= 200),
      summary TEXT NOT NULL CHECK(length(trim(summary)) > 0 AND length(summary) <= 500),
      observation TEXT NOT NULL CHECK(length(trim(observation)) > 0 AND length(observation) <= 20000),
      expected_behaviour TEXT CHECK(expected_behaviour IS NULL OR (length(trim(expected_behaviour)) > 0 AND length(expected_behaviour) <= 20000)),
      actual_behaviour TEXT CHECK(actual_behaviour IS NULL OR (length(trim(actual_behaviour)) > 0 AND length(actual_behaviour) <= 20000)),
      reproduction_steps_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(
        jsonb_typeof(reproduction_steps_json) = 'array' AND jsonb_array_length(reproduction_steps_json) <= 20
      ),
      impact TEXT CHECK(impact IS NULL OR (length(trim(impact)) > 0 AND length(impact) <= 20000)),
      project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
      workspace_path TEXT CHECK(workspace_path IS NULL OR (length(trim(workspace_path)) > 0 AND length(workspace_path) <= 4000)),
      status TEXT NOT NULL CHECK(status IN ('open','acknowledged','resolved','dismissed')),
      triage_note TEXT CHECK(triage_note IS NULL OR (length(trim(triage_note)) > 0 AND length(triage_note) <= 20000)),
      source TEXT NOT NULL CHECK(source IN ('ui','mcp','import','system')),
      client TEXT,
      actor TEXT NOT NULL,
      redaction_json JSONB NOT NULL DEFAULT '{"count":0,"fields":[]}'::jsonb CHECK(jsonb_typeof(redaction_json) = 'object'),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX error_reports_status_created ON error_reports(status, created_at DESC, id DESC);
    CREATE INDEX error_reports_component_created ON error_reports(component, created_at DESC, id DESC);
    CREATE INDEX error_reports_project_created ON error_reports(project_id, created_at DESC, id DESC);
  `,
}, {
  version: 3,
  name: 'accent_insensitive_search',
  sql: `
    CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

    CREATE FUNCTION istra_unaccent(input TEXT) RETURNS TEXT
    LANGUAGE SQL
    IMMUTABLE
    PARALLEL SAFE
    STRICT
    AS $$ SELECT public.unaccent('public.unaccent', input) $$;

    DROP INDEX search_index_vector;
    ALTER TABLE search_index DROP COLUMN search_vector;
    ALTER TABLE search_index ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
      setweight(to_tsvector('simple'::regconfig, istra_unaccent(coalesce(title, ''))), 'A') ||
      setweight(to_tsvector('simple'::regconfig, istra_unaccent(coalesce(body, ''))), 'B')
    ) STORED;
    CREATE INDEX search_index_vector ON search_index USING GIN(search_vector);
  `,
}, {
  version: 4,
  name: 'agent_queue_automation',
  sql: postgresAutomationMigration,
}]

export const latestPostgresSchemaVersion = postgresMigrations.at(-1)?.version ?? 0
