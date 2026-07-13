export const postgresAutomationMigration = `
  CREATE TABLE work_queue_automation_policies (
    queue_id UUID PRIMARY KEY REFERENCES work_queues(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    allowed_kinds_json JSONB NOT NULL DEFAULT '["issue","task"]'::jsonb CHECK(
      jsonb_typeof(allowed_kinds_json)='array' AND jsonb_array_length(allowed_kinds_json) BETWEEN 1 AND 2
      AND allowed_kinds_json <@ '["issue","task"]'::jsonb
      AND (jsonb_array_length(allowed_kinds_json)=1 OR (allowed_kinds_json @> '["issue"]'::jsonb AND allowed_kinds_json @> '["task"]'::jsonb))
    ),
    max_active_claims INTEGER NOT NULL DEFAULT 1 CHECK(max_active_claims BETWEEN 1 AND 32),
    lease_seconds INTEGER NOT NULL DEFAULT 900 CHECK(lease_seconds BETWEEN 30 AND 5400),
    requires_manual_approval BOOLEAN NOT NULL DEFAULT TRUE,
    allow_same_worker_recovery BOOLEAN NOT NULL DEFAULT TRUE,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX automation_policies_project ON work_queue_automation_policies(project_id, queue_id);

  CREATE TABLE work_leases (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    queue_id UUID NOT NULL REFERENCES work_queues(id) ON DELETE CASCADE,
    work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL CHECK(length(trim(worker_id)) BETWEEN 1 AND 200),
    token_hash TEXT NOT NULL CHECK(length(token_hash)=64),
    claimed_work_item_version INTEGER NOT NULL CHECK(claimed_work_item_version > 0),
    acquired_at TIMESTAMPTZ NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    release_reason TEXT CHECK(release_reason IS NULL OR release_reason IN ('manual','runner_shutdown','recovery','abandoned','expired')),
    terminal_outcome TEXT CHECK(terminal_outcome IS NULL OR terminal_outcome IN ('resolved','awaiting_approval','retryable','blocked','interrupted')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
  );
  CREATE UNIQUE INDEX work_leases_one_active_item ON work_leases(work_item_id) WHERE released_at IS NULL;
  CREATE INDEX work_leases_queue_active ON work_leases(queue_id, released_at, expires_at);
  CREATE INDEX work_leases_worker ON work_leases(queue_id, worker_id, released_at, expires_at);
  CREATE INDEX work_leases_project ON work_leases(project_id);

  CREATE TABLE automation_attempts (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    queue_id UUID NOT NULL REFERENCES work_queues(id) ON DELETE CASCADE,
    work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    lease_id UUID NOT NULL UNIQUE REFERENCES work_leases(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    started_at TIMESTAMPTZ NOT NULL,
    UNIQUE(work_item_id, ordinal)
  );
  CREATE INDEX automation_attempts_queue_started ON automation_attempts(queue_id, started_at DESC, id DESC);
  CREATE INDEX automation_attempts_project ON automation_attempts(project_id);

  CREATE TABLE automation_attempt_observations (
    id UUID PRIMARY KEY,
    attempt_id UUID NOT NULL REFERENCES automation_attempts(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    kind TEXT NOT NULL CHECK(kind IN ('progress','verification','delivery','note')),
    summary TEXT NOT NULL CHECK(length(trim(summary)) BETWEEN 1 AND 20000),
    run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
    evidence_id UUID REFERENCES evidence(id) ON DELETE SET NULL,
    delivery_json JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE(attempt_id, sequence)
  );
  CREATE INDEX automation_observations_attempt ON automation_attempt_observations(attempt_id, sequence);
  CREATE INDEX automation_observations_run ON automation_attempt_observations(run_id);
  CREATE INDEX automation_observations_evidence ON automation_attempt_observations(evidence_id);

  CREATE TABLE automation_queue_changes (
    sequence BIGSERIAL PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    queue_id UUID NOT NULL REFERENCES work_queues(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX automation_queue_changes_read ON automation_queue_changes(project_id, queue_id, sequence);
  CREATE INDEX automation_queue_changes_queue ON automation_queue_changes(queue_id);

  CREATE FUNCTION istra_automation_policy_integrity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM work_queues q WHERE q.id=NEW.queue_id AND q.project_id=NEW.project_id) THEN
      RAISE EXCEPTION 'automation policy queue must belong to its project';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_policy_integrity BEFORE INSERT OR UPDATE ON work_queue_automation_policies FOR EACH ROW EXECUTE FUNCTION istra_automation_policy_integrity();

  CREATE FUNCTION istra_automation_lease_integrity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM work_queues q WHERE q.id=NEW.queue_id AND q.project_id=NEW.project_id)
      OR NOT EXISTS (SELECT 1 FROM work_items wi WHERE wi.id=NEW.work_item_id AND wi.project_id=NEW.project_id) THEN
      RAISE EXCEPTION 'automation lease entities must belong to one project';
    END IF;
    IF NEW.token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'automation lease token hash must be lowercase hexadecimal'; END IF;
    IF NEW.acquired_at>NEW.heartbeat_at OR NEW.heartbeat_at>NEW.expires_at OR (NEW.released_at IS NOT NULL AND NEW.released_at<NEW.acquired_at)
      OR NOT ((NEW.released_at IS NULL AND NEW.release_reason IS NULL AND NEW.terminal_outcome IS NULL)
        OR (NEW.released_at IS NOT NULL AND NEW.release_reason IS NOT NULL AND NEW.terminal_outcome IS NOT NULL)) THEN
      RAISE EXCEPTION 'automation lease state is inconsistent';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_lease_integrity BEFORE INSERT OR UPDATE ON work_leases FOR EACH ROW EXECUTE FUNCTION istra_automation_lease_integrity();

  CREATE FUNCTION istra_automation_attempt_integrity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM work_leases l WHERE l.id=NEW.lease_id AND l.project_id=NEW.project_id AND l.queue_id=NEW.queue_id AND l.work_item_id=NEW.work_item_id) THEN
      RAISE EXCEPTION 'automation attempt must match its lease';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_attempt_integrity BEFORE INSERT OR UPDATE ON automation_attempts FOR EACH ROW EXECUTE FUNCTION istra_automation_attempt_integrity();

  CREATE FUNCTION istra_automation_observation_integrity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM automation_attempts a JOIN runs r ON r.id=NEW.run_id WHERE a.id=NEW.attempt_id AND r.project_id=a.project_id) THEN
      RAISE EXCEPTION 'automation observation run must belong to its project';
    END IF;
    IF NEW.evidence_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM automation_attempts a JOIN evidence e ON e.id=NEW.evidence_id WHERE a.id=NEW.attempt_id AND e.project_id=a.project_id) THEN
      RAISE EXCEPTION 'automation observation evidence must belong to its project';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_observation_integrity BEFORE INSERT OR UPDATE ON automation_attempt_observations FOR EACH ROW EXECUTE FUNCTION istra_automation_observation_integrity();

  CREATE FUNCTION istra_automation_project_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.state IS DISTINCT FROM NEW.state THEN
      INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
      SELECT NEW.id,id,'project.state_changed','project',NEW.id,NEW.updated_at FROM work_queues WHERE project_id=NEW.id;
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_change_project_state AFTER UPDATE OF state ON projects FOR EACH ROW EXECUTE FUNCTION istra_automation_project_change();

  CREATE FUNCTION istra_automation_work_item_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT NEW.project_id,queue_id,'work_item.updated','work_item',NEW.id,NEW.updated_at FROM work_queue_items WHERE work_item_id=NEW.id;
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_change_work_item AFTER UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION istra_automation_work_item_change();

  CREATE FUNCTION istra_automation_queue_item_change() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE item work_queue_items%ROWTYPE; BEGIN
    item := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT project_id,item.queue_id,CASE WHEN TG_OP='DELETE' THEN 'queue_item.deleted' ELSE 'queue_item.created' END,'work_item',item.work_item_id,clock_timestamp() FROM work_queues WHERE id=item.queue_id;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END $$;
  CREATE TRIGGER automation_change_queue_item AFTER INSERT OR DELETE ON work_queue_items FOR EACH ROW EXECUTE FUNCTION istra_automation_queue_item_change();

  CREATE FUNCTION istra_automation_relation_change() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE relation work_relations%ROWTYPE; BEGIN
    relation := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT relation.project_id,wqi.queue_id,CASE WHEN TG_OP='DELETE' THEN 'work_relation.deleted' ELSE 'work_relation.created' END,'work_relation',relation.id,clock_timestamp() FROM work_queue_items wqi WHERE wqi.work_item_id IN (relation.from_work_item_id,relation.to_work_item_id);
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END $$;
  CREATE TRIGGER automation_change_relation AFTER INSERT OR DELETE ON work_relations FOR EACH ROW EXECUTE FUNCTION istra_automation_relation_change();

  CREATE FUNCTION istra_automation_blocker_change() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE blocker external_blockers%ROWTYPE; BEGIN
    blocker := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    SELECT blocker.project_id,q.id,'external_blocker.' || lower(TG_OP),'external_blocker',blocker.id,clock_timestamp() FROM work_queues q
    WHERE q.project_id=blocker.project_id AND (blocker.work_item_id IS NULL OR EXISTS (SELECT 1 FROM work_queue_items wqi WHERE wqi.queue_id=q.id AND wqi.work_item_id=blocker.work_item_id));
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END $$;
  CREATE TRIGGER automation_change_blocker AFTER INSERT OR UPDATE OR DELETE ON external_blockers FOR EACH ROW EXECUTE FUNCTION istra_automation_blocker_change();

  CREATE FUNCTION istra_automation_policy_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    VALUES (NEW.project_id,NEW.queue_id,CASE WHEN TG_OP='INSERT' THEN 'automation_policy.created' ELSE 'automation_policy.updated' END,'automation_policy',NEW.queue_id,NEW.updated_at);
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_change_policy AFTER INSERT OR UPDATE ON work_queue_automation_policies FOR EACH ROW EXECUTE FUNCTION istra_automation_policy_change();

  CREATE FUNCTION istra_automation_lease_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO automation_queue_changes(project_id,queue_id,event_type,entity_type,entity_id,created_at)
    VALUES (NEW.project_id,NEW.queue_id,CASE WHEN TG_OP='INSERT' THEN 'work_lease.created' WHEN NEW.released_at IS NULL THEN 'work_lease.heartbeat' ELSE 'work_lease.released' END,'work_lease',NEW.id,COALESCE(NEW.released_at,NEW.heartbeat_at));
    RETURN NEW;
  END $$;
  CREATE TRIGGER automation_change_lease AFTER INSERT OR UPDATE ON work_leases FOR EACH ROW EXECUTE FUNCTION istra_automation_lease_change();
`
