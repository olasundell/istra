export interface Migration {
  version: number
  name: string
  sql: string
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_project_memory',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK(length(trim(title)) > 0),
        description TEXT,
        intent TEXT,
        deadline TEXT,
        completion_criteria TEXT,
        state TEXT NOT NULL CHECK(state IN ('active','paused','dormant','completed')),
        current_focus TEXT,
        next_action TEXT,
        blockers_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(blockers_json)),
        current_checkpoint_id TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL DEFAULT ''
      ) STRICT;

      CREATE TABLE phases (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(length(trim(name)) > 0),
        description TEXT,
        status TEXT NOT NULL CHECK(status IN ('planned','active','completed','abandoned')),
        position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX phases_project_position ON phases(project_id, position, created_at);

      CREATE TABLE work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        phase_id TEXT REFERENCES phases(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK(kind IN ('issue','task','idea','question','risk')),
        title TEXT NOT NULL CHECK(length(trim(title)) > 0),
        description TEXT,
        status TEXT NOT NULL CHECK(status IN ('open','in_progress','blocked','resolved','dropped')),
        priority TEXT CHECK(priority IS NULL OR priority IN ('low','medium','high','critical')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX work_items_project_status ON work_items(project_id, status, updated_at DESC);
      CREATE INDEX work_items_phase ON work_items(phase_id);

      CREATE TRIGGER work_items_phase_project_insert
      BEFORE INSERT ON work_items
      WHEN NEW.phase_id IS NOT NULL
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM phases WHERE id=NEW.phase_id AND project_id=NEW.project_id
        ) THEN RAISE(ABORT, 'work-item phase belongs to another project') END;
      END;
      CREATE TRIGGER work_items_phase_project_update
      BEFORE UPDATE OF phase_id,project_id ON work_items
      WHEN NEW.phase_id IS NOT NULL
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM phases WHERE id=NEW.phase_id AND project_id=NEW.project_id
        ) THEN RAISE(ABORT, 'work-item phase belongs to another project') END;
      END;

      CREATE TABLE labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) > 0),
        colour TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE work_item_labels (
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(work_item_id, label_id)
      ) STRICT;

      CREATE TABLE updates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('note','progress','decision','discovery','checkpoint')),
        current_revision_id TEXT,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX updates_project_created ON updates(project_id, created_at DESC);

      CREATE TABLE update_revisions (
        id TEXT PRIMARY KEY,
        update_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision > 0),
        content TEXT NOT NULL,
        snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
        source TEXT NOT NULL,
        client TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(update_id, revision)
      ) STRICT;
      CREATE INDEX update_revisions_update ON update_revisions(update_id, revision DESC);

      CREATE TABLE activity_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        source TEXT NOT NULL,
        client TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX activity_project_created ON activity_events(project_id, created_at DESC);

      CREATE VIRTUAL TABLE search_index USING fts5(
        entity_type UNINDEXED,
        entity_id UNINDEXED,
        project_id UNINDEXED,
        title,
        body,
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER projects_current_checkpoint_guard
      BEFORE UPDATE OF current_checkpoint_id ON projects
      WHEN NEW.current_checkpoint_id IS NOT NULL
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM updates
          WHERE id = NEW.current_checkpoint_id
            AND project_id = NEW.id
            AND kind = 'checkpoint'
            AND deleted_at IS NULL
        ) THEN RAISE(ABORT, 'invalid current checkpoint') END;
      END;
    `,
  },
  {
    version: 2,
    name: 'hack_project_operational_memory',
    sql: `
      CREATE TABLE requirement_states (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(length(trim(name)) > 0),
        semantic TEXT NOT NULL CHECK(semantic IN ('open','partial','proven','defect')),
        position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
        colour TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, name COLLATE NOCASE)
      ) STRICT;
      CREATE INDEX requirement_states_project_position ON requirement_states(project_id, position, created_at);

      CREATE TABLE requirements (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stable_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('goal','capability','requirement')),
        parent_id TEXT REFERENCES requirements(id) ON DELETE SET NULL,
        title TEXT NOT NULL CHECK(length(trim(title)) > 0),
        description TEXT,
        state_id TEXT NOT NULL REFERENCES requirement_states(id),
        responsible_phase_id TEXT REFERENCES phases(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, stable_key COLLATE NOCASE)
      ) STRICT;
      CREATE INDEX requirements_project_updated ON requirements(project_id, updated_at DESC, id);
      CREATE INDEX requirements_parent ON requirements(parent_id);

      CREATE TABLE requirement_key_aliases (
        requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(requirement_id, alias COLLATE NOCASE),
        UNIQUE(alias COLLATE NOCASE)
      ) STRICT;

      CREATE TABLE acceptance_criteria (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK(length(trim(title)) > 0),
        description TEXT,
        position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0),
        required INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX acceptance_criteria_requirement ON acceptance_criteria(requirement_id, position, id);

      CREATE TABLE requirement_phase_links (
        requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
        phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('responsible','related')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(requirement_id, phase_id)
      ) STRICT;

      CREATE TABLE work_queues (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(length(trim(name)) > 0),
        description TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, name COLLATE NOCASE)
      ) STRICT;
      CREATE TABLE work_queue_items (
        queue_id TEXT NOT NULL REFERENCES work_queues(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        rank TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(queue_id, work_item_id),
        UNIQUE(queue_id, rank)
      ) STRICT;
      CREATE INDEX work_queue_items_order ON work_queue_items(queue_id, rank, work_item_id);

      ALTER TABLE work_items ADD COLUMN stable_key TEXT;
      ALTER TABLE work_items ADD COLUMN parent_id TEXT REFERENCES work_items(id) ON DELETE SET NULL;
      CREATE UNIQUE INDEX work_items_project_stable_key ON work_items(project_id, stable_key COLLATE NOCASE) WHERE stable_key IS NOT NULL;
      CREATE INDEX work_items_parent ON work_items(parent_id);

      CREATE TABLE requirement_work_links (
        requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(requirement_id, work_item_id)
      ) STRICT;
      CREATE TABLE work_phase_links (
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('responsible','related')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(work_item_id, phase_id)
      ) STRICT;

      CREATE TABLE work_relations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        to_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('depends_on','blocks','relates_to')),
        created_at TEXT NOT NULL,
        CHECK(from_work_item_id <> to_work_item_id),
        UNIQUE(from_work_item_id, to_work_item_id, kind)
      ) STRICT;
      CREATE INDEX work_relations_from ON work_relations(from_work_item_id, kind);
      CREATE INDEX work_relations_to ON work_relations(to_work_item_id, kind);

      CREATE TABLE external_blockers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        work_item_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
        content TEXT NOT NULL CHECK(length(trim(content)) > 0),
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX external_blockers_open ON external_blockers(project_id, resolved_at, created_at DESC);

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(trim(name)) > 0),
        canonical_root TEXT NOT NULL UNIQUE,
        remote TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE workspace_aliases (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        alias TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, alias)
      ) STRICT;
      CREATE TABLE project_workspaces (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, workspace_id)
      ) STRICT;
      CREATE TABLE workspace_revisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        branch TEXT,
        "commit" TEXT,
        dirty INTEGER NOT NULL DEFAULT 0 CHECK(dirty IN (0,1)),
        diff_hash TEXT,
        captured_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX workspace_revisions_captured ON workspace_revisions(workspace_id, captured_at DESC, id);

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace_revision_id TEXT REFERENCES workspace_revisions(id) ON DELETE SET NULL,
        command TEXT NOT NULL CHECK(length(trim(command)) > 0),
        working_directory TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        outcome TEXT NOT NULL CHECK(outcome IN ('recorded','verified','failed','interrupted')),
        exit_code INTEGER,
        toolchain_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(toolchain_json)),
        stdout_excerpt TEXT,
        stderr_excerpt TEXT,
        stdout_truncated INTEGER NOT NULL DEFAULT 0 CHECK(stdout_truncated IN (0,1)),
        stderr_truncated INTEGER NOT NULL DEFAULT 0 CHECK(stderr_truncated IN (0,1)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX runs_project_started ON runs(project_id, started_at DESC, id);
      CREATE TABLE test_summaries (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        passed INTEGER NOT NULL CHECK(passed >= 0),
        failed INTEGER NOT NULL CHECK(failed >= 0),
        skipped INTEGER NOT NULL CHECK(skipped >= 0),
        target_count INTEGER NOT NULL CHECK(target_count >= 0),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE artifact_references (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        uri TEXT NOT NULL,
        media_type TEXT,
        byte_count INTEGER CHECK(byte_count IS NULL OR byte_count >= 0),
        digest TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        result TEXT NOT NULL CHECK(result IN ('recorded','verified','failed','interrupted')),
        summary TEXT NOT NULL,
        target_version INTEGER,
        stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)),
        stale_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX evidence_project_created ON evidence(project_id, created_at DESC, id);
      CREATE TABLE evidence_requirement_links (evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE, requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE, PRIMARY KEY(evidence_id, requirement_id)) STRICT;
      CREATE TABLE evidence_work_links (evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, PRIMARY KEY(evidence_id, work_item_id)) STRICT;
      CREATE TABLE evidence_update_links (evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE, update_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE, PRIMARY KEY(evidence_id, update_id)) STRICT;
      CREATE TABLE evidence_checkpoint_links (evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE, checkpoint_id TEXT NOT NULL REFERENCES updates(id) ON DELETE CASCADE, PRIMARY KEY(evidence_id, checkpoint_id)) STRICT;

      CREATE TABLE checkpoint_snapshots (
        id TEXT PRIMARY KEY,
        checkpoint_id TEXT NOT NULL UNIQUE REFERENCES updates(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL DEFAULT 2 CHECK(schema_version = 2),
        captured_at TEXT NOT NULL,
        document_json TEXT NOT NULL CHECK(json_valid(document_json)),
        digest TEXT NOT NULL
      ) STRICT;

      CREATE TABLE idempotency_records (
        client TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(client, idempotency_key)
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: 'allow_explicit_blocking_relations',
    sql: `
      DROP INDEX IF EXISTS work_relations_from;
      DROP INDEX IF EXISTS work_relations_to;
      ALTER TABLE work_relations RENAME TO work_relations_v2;
      CREATE TABLE work_relations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        to_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('depends_on','blocks','relates_to')),
        created_at TEXT NOT NULL,
        CHECK(from_work_item_id <> to_work_item_id),
        UNIQUE(from_work_item_id, to_work_item_id, kind)
      ) STRICT;
      INSERT INTO work_relations(id,project_id,from_work_item_id,to_work_item_id,kind,created_at)
        SELECT id,project_id,from_work_item_id,to_work_item_id,kind,created_at FROM work_relations_v2;
      DROP TABLE work_relations_v2;
      CREATE INDEX work_relations_from ON work_relations(from_work_item_id, kind);
      CREATE INDEX work_relations_to ON work_relations(to_work_item_id, kind);
    `,
  },
  {
    version: 4,
    name: 'operational_persistence_integrity',
    sql: `
      CREATE TABLE evidence_artifact_links (
        evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES artifact_references(id) ON DELETE CASCADE,
        PRIMARY KEY(evidence_id, artifact_id)
      ) STRICT;

      WITH defaults(name,semantic,position,colour) AS (
        VALUES
          ('Missing','open',0,'#7A8594'),
          ('Partial','partial',1,'#C18401'),
          ('Proven','proven',2,'#2D7A4B'),
          ('Defect','defect',3,'#B64D3A')
      )
      INSERT INTO requirement_states(id,project_id,name,semantic,position,colour,created_at,updated_at)
      SELECT
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
        p.id,d.name,d.semantic,d.position,d.colour,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM projects p CROSS JOIN defaults d
      WHERE NOT EXISTS (
        SELECT 1 FROM requirement_states existing
        WHERE existing.project_id=p.id AND existing.name=d.name COLLATE NOCASE
      );

      INSERT INTO work_queues(id,project_id,name,description,created_at,updated_at)
      SELECT
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
        p.id,'Main queue','Default ordered work queue',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM projects p
      WHERE NOT EXISTS (SELECT 1 FROM work_queues q WHERE q.project_id=p.id);

      INSERT OR IGNORE INTO work_queue_items(queue_id,work_item_id,rank,created_at)
      SELECT
        (SELECT q.id FROM work_queues q WHERE q.project_id=wi.project_id ORDER BY q.created_at,q.id LIMIT 1),
        wi.id,
        'legacy:' || wi.created_at || ':' || wi.id,
        wi.created_at
      FROM work_items wi
      WHERE NOT EXISTS (SELECT 1 FROM work_queue_items existing WHERE existing.work_item_id=wi.id);

      INSERT OR IGNORE INTO work_phase_links(work_item_id,phase_id,role,created_at)
      SELECT wi.id,wi.phase_id,'responsible',wi.created_at
      FROM work_items wi
      WHERE wi.phase_id IS NOT NULL;
    `,
  },
]
