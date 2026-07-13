export const sqliteAutomationMigration = `
  CREATE TABLE work_queue_automation_policies (
    queue_id TEXT PRIMARY KEY REFERENCES work_queues(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    allowed_kinds_json TEXT NOT NULL DEFAULT '["issue","task"]' CHECK(json_valid(allowed_kinds_json) AND json_type(allowed_kinds_json)='array'),
    max_active_claims INTEGER NOT NULL DEFAULT 1 CHECK(max_active_claims BETWEEN 1 AND 32),
    lease_seconds INTEGER NOT NULL DEFAULT 900 CHECK(lease_seconds BETWEEN 30 AND 5400),
    requires_manual_approval INTEGER NOT NULL DEFAULT 1 CHECK(requires_manual_approval IN (0,1)),
    allow_same_worker_recovery INTEGER NOT NULL DEFAULT 1 CHECK(allow_same_worker_recovery IN (0,1)),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX automation_policies_project ON work_queue_automation_policies(project_id, queue_id);

  CREATE TABLE work_leases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    queue_id TEXT NOT NULL REFERENCES work_queues(id) ON DELETE CASCADE,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL CHECK(length(trim(worker_id)) BETWEEN 1 AND 200),
    token_hash TEXT NOT NULL CHECK(length(token_hash)=64),
    claimed_work_item_version INTEGER NOT NULL CHECK(claimed_work_item_version > 0),
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    release_reason TEXT CHECK(release_reason IS NULL OR release_reason IN ('manual','runner_shutdown','recovery','abandoned','expired')),
    terminal_outcome TEXT CHECK(terminal_outcome IS NULL OR terminal_outcome IN ('resolved','awaiting_approval','retryable','blocked','interrupted')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
  ) STRICT;
  CREATE UNIQUE INDEX work_leases_one_active_item ON work_leases(work_item_id) WHERE released_at IS NULL;
  CREATE INDEX work_leases_queue_active ON work_leases(queue_id, released_at, expires_at);
  CREATE INDEX work_leases_worker ON work_leases(queue_id, worker_id, released_at, expires_at);

  CREATE TABLE automation_attempts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    queue_id TEXT NOT NULL REFERENCES work_queues(id) ON DELETE CASCADE,
    work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    lease_id TEXT NOT NULL UNIQUE REFERENCES work_leases(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    started_at TEXT NOT NULL,
    UNIQUE(work_item_id, ordinal)
  ) STRICT;
  CREATE INDEX automation_attempts_queue_started ON automation_attempts(queue_id, started_at DESC, id DESC);

  CREATE TABLE automation_attempt_observations (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES automation_attempts(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    kind TEXT NOT NULL CHECK(kind IN ('progress','verification','delivery','note')),
    summary TEXT NOT NULL CHECK(length(trim(summary)) BETWEEN 1 AND 20000),
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
    delivery_json TEXT CHECK(delivery_json IS NULL OR json_valid(delivery_json)),
    created_at TEXT NOT NULL,
    UNIQUE(attempt_id, sequence)
  ) STRICT;
  CREATE INDEX automation_observations_attempt ON automation_attempt_observations(attempt_id, sequence);

  CREATE TABLE automation_queue_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    queue_id TEXT NOT NULL REFERENCES work_queues(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX automation_queue_changes_read ON automation_queue_changes(project_id, queue_id, sequence);

  CREATE TRIGGER automation_policy_integrity_insert BEFORE INSERT ON work_queue_automation_policies BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM work_queues q WHERE q.id=NEW.queue_id AND q.project_id=NEW.project_id)
      THEN RAISE(ABORT,'automation policy queue must belong to its project') END;
    SELECT CASE WHEN json_array_length(NEW.allowed_kinds_json) NOT BETWEEN 1 AND 2
      OR EXISTS (SELECT 1 FROM json_each(NEW.allowed_kinds_json) WHERE type<>'text' OR value NOT IN ('issue','task'))
      OR json_array_length(NEW.allowed_kinds_json)<>(SELECT COUNT(DISTINCT value) FROM json_each(NEW.allowed_kinds_json))
      THEN RAISE(ABORT,'automation policy allowed kinds are invalid') END;
  END;
  CREATE TRIGGER automation_policy_integrity_update BEFORE UPDATE ON work_queue_automation_policies BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM work_queues q WHERE q.id=NEW.queue_id AND q.project_id=NEW.project_id)
      THEN RAISE(ABORT,'automation policy queue must belong to its project') END;
    SELECT CASE WHEN json_array_length(NEW.allowed_kinds_json) NOT BETWEEN 1 AND 2
      OR EXISTS (SELECT 1 FROM json_each(NEW.allowed_kinds_json) WHERE type<>'text' OR value NOT IN ('issue','task'))
      OR json_array_length(NEW.allowed_kinds_json)<>(SELECT COUNT(DISTINCT value) FROM json_each(NEW.allowed_kinds_json))
      THEN RAISE(ABORT,'automation policy allowed kinds are invalid') END;
  END;
  CREATE TRIGGER automation_lease_integrity_insert BEFORE INSERT ON work_leases BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM work_queues q WHERE q.id=NEW.queue_id AND q.project_id=NEW.project_id)
      OR NOT EXISTS (SELECT 1 FROM work_items wi WHERE wi.id=NEW.work_item_id AND wi.project_id=NEW.project_id)
      THEN RAISE(ABORT,'automation lease entities must belong to one project') END;
    SELECT CASE WHEN length(NEW.token_hash)<>64 OR NEW.token_hash GLOB '*[^0-9a-f]*'
      THEN RAISE(ABORT,'automation lease token hash must be lowercase hexadecimal') END;
    SELECT CASE WHEN NEW.acquired_at>NEW.heartbeat_at OR NEW.heartbeat_at>NEW.expires_at OR (NEW.released_at IS NOT NULL AND NEW.released_at<NEW.acquired_at)
      OR NOT ((NEW.released_at IS NULL AND NEW.release_reason IS NULL AND NEW.terminal_outcome IS NULL)
        OR (NEW.released_at IS NOT NULL AND NEW.release_reason IS NOT NULL AND NEW.terminal_outcome IS NOT NULL))
      THEN RAISE(ABORT,'automation lease state is inconsistent') END;
  END;
  CREATE TRIGGER automation_lease_integrity_update BEFORE UPDATE ON work_leases BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM work_queues q WHERE q.id=NEW.queue_id AND q.project_id=NEW.project_id)
      OR NOT EXISTS (SELECT 1 FROM work_items wi WHERE wi.id=NEW.work_item_id AND wi.project_id=NEW.project_id)
      THEN RAISE(ABORT,'automation lease entities must belong to one project') END;
    SELECT CASE WHEN length(NEW.token_hash)<>64 OR NEW.token_hash GLOB '*[^0-9a-f]*'
      THEN RAISE(ABORT,'automation lease token hash must be lowercase hexadecimal') END;
    SELECT CASE WHEN NEW.acquired_at>NEW.heartbeat_at OR NEW.heartbeat_at>NEW.expires_at OR (NEW.released_at IS NOT NULL AND NEW.released_at<NEW.acquired_at)
      OR NOT ((NEW.released_at IS NULL AND NEW.release_reason IS NULL AND NEW.terminal_outcome IS NULL)
        OR (NEW.released_at IS NOT NULL AND NEW.release_reason IS NOT NULL AND NEW.terminal_outcome IS NOT NULL))
      THEN RAISE(ABORT,'automation lease state is inconsistent') END;
  END;
  CREATE TRIGGER automation_attempt_integrity_insert BEFORE INSERT ON automation_attempts BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM work_leases l WHERE l.id=NEW.lease_id AND l.project_id=NEW.project_id AND l.queue_id=NEW.queue_id AND l.work_item_id=NEW.work_item_id)
      THEN RAISE(ABORT,'automation attempt must match its lease') END;
  END;
  CREATE TRIGGER automation_attempt_integrity_update BEFORE UPDATE ON automation_attempts BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM work_leases l WHERE l.id=NEW.lease_id AND l.project_id=NEW.project_id AND l.queue_id=NEW.queue_id AND l.work_item_id=NEW.work_item_id)
      THEN RAISE(ABORT,'automation attempt must match its lease') END;
  END;
  CREATE TRIGGER automation_observation_integrity_insert BEFORE INSERT ON automation_attempt_observations BEGIN
    SELECT CASE WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM automation_attempts a JOIN runs r ON r.id=NEW.run_id WHERE a.id=NEW.attempt_id AND r.project_id=a.project_id)
      THEN RAISE(ABORT,'automation observation run must belong to its project') END;
    SELECT CASE WHEN NEW.evidence_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM automation_attempts a JOIN evidence e ON e.id=NEW.evidence_id WHERE a.id=NEW.attempt_id AND e.project_id=a.project_id)
      THEN RAISE(ABORT,'automation observation evidence must belong to its project') END;
  END;
  CREATE TRIGGER automation_observation_integrity_update BEFORE UPDATE ON automation_attempt_observations BEGIN
    SELECT CASE WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM automation_attempts a JOIN runs r ON r.id=NEW.run_id WHERE a.id=NEW.attempt_id AND r.project_id=a.project_id)
      THEN RAISE(ABORT,'automation observation run must belong to its project') END;
    SELECT CASE WHEN NEW.evidence_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM automation_attempts a JOIN evidence e ON e.id=NEW.evidence_id WHERE a.id=NEW.attempt_id AND e.project_id=a.project_id)
      THEN RAISE(ABORT,'automation observation evidence must belong to its project') END;
  END;

  CREATE TRIGGER automation_change_project_state AFTER UPDATE OF state ON projects WHEN OLD.state<>NEW.state BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT NEW.id,id,'project.state_changed','project',NEW.id,NEW.updated_at FROM work_queues WHERE project_id=NEW.id;
  END;
  CREATE TRIGGER automation_change_work_item AFTER UPDATE ON work_items BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT NEW.project_id,queue_id,'work_item.updated','work_item',NEW.id,NEW.updated_at FROM work_queue_items WHERE work_item_id=NEW.id;
  END;
  CREATE TRIGGER automation_change_queue_item_insert AFTER INSERT ON work_queue_items BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT project_id,NEW.queue_id,'queue_item.created','work_item',NEW.work_item_id,NEW.created_at FROM work_queues WHERE id=NEW.queue_id;
  END;
  CREATE TRIGGER automation_change_queue_item_delete AFTER DELETE ON work_queue_items BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT project_id,OLD.queue_id,'queue_item.deleted','work_item',OLD.work_item_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM work_queues WHERE id=OLD.queue_id;
  END;
  CREATE TRIGGER automation_change_relation_insert AFTER INSERT ON work_relations BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT NEW.project_id,wqi.queue_id,'work_relation.created','work_relation',NEW.id,NEW.created_at FROM work_queue_items wqi WHERE wqi.work_item_id IN (NEW.from_work_item_id,NEW.to_work_item_id);
  END;
  CREATE TRIGGER automation_change_relation_delete AFTER DELETE ON work_relations BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT OLD.project_id,wqi.queue_id,'work_relation.deleted','work_relation',OLD.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM work_queue_items wqi WHERE wqi.work_item_id IN (OLD.from_work_item_id,OLD.to_work_item_id);
  END;
  CREATE TRIGGER automation_change_blocker_insert AFTER INSERT ON external_blockers BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT NEW.project_id,q.id,'external_blocker.created','external_blocker',NEW.id,NEW.created_at FROM work_queues q
    WHERE q.project_id=NEW.project_id AND (NEW.work_item_id IS NULL OR EXISTS (SELECT 1 FROM work_queue_items wqi WHERE wqi.queue_id=q.id AND wqi.work_item_id=NEW.work_item_id));
  END;
  CREATE TRIGGER automation_change_blocker_update AFTER UPDATE ON external_blockers BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT NEW.project_id,q.id,'external_blocker.updated','external_blocker',NEW.id,NEW.updated_at FROM work_queues q
    WHERE q.project_id=NEW.project_id AND (NEW.work_item_id IS NULL OR EXISTS (SELECT 1 FROM work_queue_items wqi WHERE wqi.queue_id=q.id AND wqi.work_item_id=NEW.work_item_id));
  END;
  CREATE TRIGGER automation_change_policy_insert AFTER INSERT ON work_queue_automation_policies BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    VALUES (NEW.project_id,NEW.queue_id,'automation_policy.created','automation_policy',NEW.queue_id,NEW.created_at);
  END;
  CREATE TRIGGER automation_change_policy_update AFTER UPDATE ON work_queue_automation_policies BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    VALUES (NEW.project_id,NEW.queue_id,'automation_policy.updated','automation_policy',NEW.queue_id,NEW.updated_at);
  END;
  CREATE TRIGGER automation_change_lease_insert AFTER INSERT ON work_leases BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    VALUES (NEW.project_id,NEW.queue_id,'work_lease.created','work_lease',NEW.id,NEW.acquired_at);
  END;
  CREATE TRIGGER automation_change_lease_update AFTER UPDATE ON work_leases BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    VALUES (NEW.project_id,NEW.queue_id,CASE WHEN NEW.released_at IS NULL THEN 'work_lease.heartbeat' ELSE 'work_lease.released' END,'work_lease',NEW.id,COALESCE(NEW.released_at,NEW.heartbeat_at));
  END;
`
