import { automationQueueChangeRetentionLimit } from '../automation-retention.js'

export const sqliteAutomationRetentionMigration = `
  CREATE TABLE automation_queue_change_retention (
    queue_id TEXT PRIMARY KEY REFERENCES work_queues(id) ON DELETE CASCADE,
    discarded_through_sequence INTEGER NOT NULL CHECK(discarded_through_sequence > 0),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX automation_queue_changes_queue ON automation_queue_changes(queue_id, sequence DESC);

  INSERT INTO automation_queue_change_retention(queue_id,discarded_through_sequence,updated_at)
  SELECT queue_id,MAX(sequence),MAX(created_at)
  FROM (
    SELECT queue_id,sequence,created_at,
      ROW_NUMBER() OVER (PARTITION BY queue_id ORDER BY sequence DESC) AS retention_rank
    FROM automation_queue_changes
  ) ranked
  WHERE retention_rank>${automationQueueChangeRetentionLimit}
  GROUP BY queue_id;

  DELETE FROM automation_queue_changes
  WHERE sequence IN (
    SELECT sequence FROM (
      SELECT sequence,
        ROW_NUMBER() OVER (PARTITION BY queue_id ORDER BY sequence DESC) AS retention_rank
      FROM automation_queue_changes
    ) ranked
    WHERE retention_rank>${automationQueueChangeRetentionLimit}
  );

  CREATE TRIGGER automation_queue_changes_retention AFTER INSERT ON automation_queue_changes
  WHEN (SELECT COUNT(*) FROM automation_queue_changes WHERE queue_id=NEW.queue_id)>${automationQueueChangeRetentionLimit}
  BEGIN
    INSERT OR IGNORE INTO automation_queue_change_retention(queue_id,discarded_through_sequence,updated_at)
    VALUES (NEW.queue_id,1,NEW.created_at);
    UPDATE automation_queue_change_retention
    SET discarded_through_sequence=MAX(discarded_through_sequence,(
      SELECT MAX(sequence) FROM (
        SELECT sequence FROM automation_queue_changes
        WHERE queue_id=NEW.queue_id
        ORDER BY sequence DESC
        LIMIT -1 OFFSET ${automationQueueChangeRetentionLimit}
      ) stale
    )),updated_at=NEW.created_at
    WHERE queue_id=NEW.queue_id;
    DELETE FROM automation_queue_changes
    WHERE sequence IN (
      SELECT sequence FROM automation_queue_changes
      WHERE queue_id=NEW.queue_id
      ORDER BY sequence DESC
      LIMIT -1 OFFSET ${automationQueueChangeRetentionLimit}
    );
  END;

  DROP TRIGGER automation_change_project_state;
  CREATE TRIGGER automation_change_project_state AFTER UPDATE OF state,blockers_json ON projects
  WHEN OLD.state<>NEW.state OR OLD.blockers_json<>NEW.blockers_json BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT NEW.id,id,
      CASE WHEN OLD.state<>NEW.state THEN 'project.state_changed' ELSE 'project.blockers_changed' END,
      'project',NEW.id,NEW.updated_at
    FROM work_queues WHERE project_id=NEW.id;
  END;
`
