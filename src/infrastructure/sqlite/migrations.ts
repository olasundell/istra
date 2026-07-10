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
]
