import { automationQueueChangeRetentionLimit } from '../automation-retention.js'

export const postgresAutomationRetentionMigration = `
  CREATE TABLE automation_queue_change_retention (
    queue_id UUID PRIMARY KEY REFERENCES work_queues(id) ON DELETE CASCADE,
    discarded_through_sequence BIGINT NOT NULL CHECK(discarded_through_sequence > 0),
    updated_at TIMESTAMPTZ NOT NULL
  );

  DROP INDEX automation_queue_changes_queue;
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

  DELETE FROM automation_queue_changes changes
  USING (
    SELECT sequence FROM (
      SELECT sequence,
        ROW_NUMBER() OVER (PARTITION BY queue_id ORDER BY sequence DESC) AS retention_rank
      FROM automation_queue_changes
    ) ranked
    WHERE retention_rank>${automationQueueChangeRetentionLimit}
  ) stale
  WHERE changes.sequence=stale.sequence;

  CREATE FUNCTION istra_automation_change_retention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.queue_id::text,0));
    WITH stale AS (
      SELECT sequence FROM automation_queue_changes
      WHERE queue_id=NEW.queue_id
      ORDER BY sequence DESC
      OFFSET ${automationQueueChangeRetentionLimit - 1}
    ), discarded AS (
      DELETE FROM automation_queue_changes changes
      USING stale
      WHERE changes.sequence=stale.sequence
      RETURNING changes.sequence
    )
    INSERT INTO automation_queue_change_retention(queue_id,discarded_through_sequence,updated_at)
    SELECT NEW.queue_id,MAX(sequence),clock_timestamp() FROM discarded
    HAVING COUNT(*)>0
    ON CONFLICT(queue_id) DO UPDATE SET
      discarded_through_sequence=GREATEST(automation_queue_change_retention.discarded_through_sequence,EXCLUDED.discarded_through_sequence),
      updated_at=EXCLUDED.updated_at;
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_queue_changes_retention
  BEFORE INSERT ON automation_queue_changes
  FOR EACH ROW EXECUTE FUNCTION istra_automation_change_retention();

  CREATE OR REPLACE FUNCTION istra_automation_project_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.state IS DISTINCT FROM NEW.state OR OLD.blockers_json IS DISTINCT FROM NEW.blockers_json THEN
      INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
      SELECT NEW.id,id,
        CASE WHEN OLD.state IS DISTINCT FROM NEW.state THEN 'project.state_changed' ELSE 'project.blockers_changed' END,
        'project',NEW.id,NEW.updated_at
      FROM work_queues WHERE project_id=NEW.id;
    END IF;
    RETURN NEW;
  END $$;
  DROP TRIGGER automation_change_project_state ON projects;
  CREATE TRIGGER automation_change_project_state
  AFTER UPDATE OF state,blockers_json ON projects
  FOR EACH ROW EXECUTE FUNCTION istra_automation_project_change();
`
