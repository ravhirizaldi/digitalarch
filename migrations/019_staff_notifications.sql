INSERT INTO permissions(code) VALUES('notifications:read');
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('operator','qc_officer','approver_l1','approver_l2') AND p.code='notifications:read';

CREATE TABLE staff_notification_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audit_id UUID NOT NULL UNIQUE REFERENCES audit_logs(id),
  batch_id UUID NOT NULL REFERENCES archive_batches(id),
  document_id UUID NOT NULL REFERENCES documents(id),
  review_cycle INTEGER NOT NULL CHECK(review_cycle>=0),
  action TEXT NOT NULL, actor_id UUID REFERENCES users(id), actor_name TEXT NOT NULL,
  title TEXT NOT NULL, batch_code TEXT NOT NULL, reason TEXT,
  decision_id UUID REFERENCES approval_decisions(id),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER staff_notification_events_immutable BEFORE UPDATE OR DELETE ON staff_notification_events
  FOR EACH ROW EXECUTE FUNCTION protect_audit();
CREATE TABLE staff_notification_recipients (
  user_id UUID NOT NULL REFERENCES users(id), event_id BIGINT NOT NULL REFERENCES staff_notification_events(id),
  read_at TIMESTAMPTZ, viewed_at TIMESTAMPTZ,
  PRIMARY KEY(user_id,event_id)
);
CREATE INDEX staff_inbox_unread ON staff_notification_recipients(user_id,event_id DESC) WHERE read_at IS NULL;
CREATE INDEX staff_notification_events_batch ON staff_notification_events(batch_id,id DESC);
CREATE INDEX notification_capture_actors ON scan_sessions(batch_id,created_by);
CREATE INDEX notification_qc_actors ON qc_reviews(document_id,decided_by);
CREATE INDEX notification_workflow_actors ON audit_logs(batch_id,actor_id,action)
  WHERE action IN ('qc.claimed','qc.passed','qc.returned','batch.reassigned');

CREATE FUNCTION staff_has_permission(target UUID, permission TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id
    JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id
    WHERE u.id=target AND u.is_active AND u.deleted_at IS NULL AND p.code=permission)
$$;
CREATE FUNCTION staff_notification_eligible(candidate_id UUID, batch UUID, stage TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT staff_has_permission(candidate_id,CASE WHEN stage='qc' THEN 'qc:review' ELSE 'approval_l1:approve' END)
    AND NOT EXISTS(SELECT 1 FROM archive_batches b WHERE b.id=batch
      AND (b.created_by=candidate_id OR b.assigned_operator_id=candidate_id))
    AND NOT EXISTS(SELECT 1 FROM scan_sessions s WHERE s.batch_id=batch AND s.created_by=candidate_id)
    AND NOT EXISTS(SELECT 1 FROM audit_logs a WHERE a.batch_id=batch AND a.action='batch.reassigned'
      AND (a.metadata->>'from'=candidate_id::text OR a.metadata->>'to'=candidate_id::text))
    AND (CASE WHEN stage='qc' THEN
      NOT EXISTS(SELECT 1 FROM approval_decisions a JOIN qc_reviews r ON r.id=a.qc_review_id
        JOIN documents d ON d.id=r.document_id WHERE d.batch_id=batch AND a.decided_by=candidate_id)
      AND NOT EXISTS(SELECT 1 FROM publication_withdrawals w JOIN documents d ON d.id=w.document_id
        WHERE d.batch_id=batch AND w.taken_by=candidate_id)
    ELSE
      NOT EXISTS(SELECT 1 FROM qc_reviews r JOIN documents d ON d.id=r.document_id
        WHERE d.batch_id=batch AND (r.decided_by=candidate_id OR r.claimed_by=candidate_id))
      AND NOT EXISTS(SELECT 1 FROM audit_logs a WHERE a.batch_id=batch AND a.actor_id=candidate_id
        AND a.action IN ('qc.claimed','qc.passed','qc.returned'))
      AND NOT EXISTS(SELECT 1 FROM approval_decisions a JOIN qc_reviews r ON r.id=a.qc_review_id
        JOIN documents d ON d.id=r.document_id WHERE d.batch_id=batch AND a.decided_by=candidate_id AND a.level<>1)
      AND NOT EXISTS(SELECT 1 FROM publication_withdrawals w JOIN documents d ON d.id=w.document_id
        WHERE d.batch_id=batch AND w.taken_by=candidate_id)
    END)
$$;

CREATE FUNCTION staff_notification_record(entry audit_logs) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE b archive_batches; d documents; r qc_reviews; event BIGINT; stage TEXT; decision UUID;
BEGIN
  SELECT * INTO b FROM archive_batches WHERE id=entry.batch_id;
  IF b.id IS NULL OR b.deleted_at IS NOT NULL THEN RETURN; END IF;
  SELECT * INTO d FROM documents WHERE batch_id=b.id ORDER BY document_index LIMIT 1;
  IF d.id IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM qc_reviews WHERE document_id=d.id AND cycle=d.review_cycle;
  decision := (entry.metadata->>'decisionId')::uuid;
  stage := CASE
    WHEN entry.action IN ('qc.submitted','qc.resubmitted','qc.released','qc.reassigned','approval.returned') THEN 'qc'
    WHEN entry.action='qc.passed' THEN 'l1'
    WHEN entry.action='approval.taken_down' THEN entry.metadata->>'target'
  END;
  INSERT INTO staff_notification_events(audit_id,batch_id,document_id,review_cycle,action,actor_id,
    actor_name,title,batch_code,reason,decision_id,created_at)
  VALUES(entry.id,b.id,d.id,coalesce((entry.metadata->>'cycle')::integer,d.review_cycle),entry.action,entry.actor_id,
    coalesce((SELECT display_name FROM users WHERE id=entry.actor_id),'System'),
    coalesce(nullif(d.title,''),b.batch_code),b.batch_code,entry.metadata->>'reason',decision,entry.created_at)
  ON CONFLICT(audit_id) DO NOTHING RETURNING id INTO event;
  IF event IS NULL THEN RETURN; END IF;
  INSERT INTO staff_notification_recipients(user_id,event_id)
  SELECT u.id,event FROM users u WHERE staff_has_permission(u.id,'notifications:read') AND (
    -- Historical decision actors are retained; the acting user does not receive their own new event.
    (u.id<>entry.actor_id OR entry.actor_id IS NULL) AND (
      u.id=b.assigned_operator_id
      OR (stage='qc' AND (r.assigned_reviewer_id IS NULL OR r.assigned_reviewer_id=u.id)
        AND staff_notification_eligible(u.id,b.id,'qc'))
      OR (stage='l1' AND staff_notification_eligible(u.id,b.id,'l1'))
      OR (entry.action IN ('approval.l1_approved','approval.l2_reassigned') AND
        u.id=(entry.metadata->>'authorityId')::uuid)
      OR (entry.action='batch.reassigned' AND u.id=(entry.metadata->>'from')::uuid)
      OR (entry.action='approval.l2_reassigned' AND u.id=(entry.metadata->>'previous')::uuid)
      OR (entry.action='qc.reassigned' AND u.id=(entry.metadata->>'previousReviewerId')::uuid)
      OR (entry.action='qc.claimed' AND u.id=(entry.metadata->>'previousClaim')::uuid)
      OR (entry.action IN ('approval.published','approval.returned','approval.dropped','approval.taken_down')
        AND (EXISTS(SELECT 1 FROM qc_reviews q WHERE q.document_id=d.id AND q.decided_by=u.id)
          OR EXISTS(SELECT 1 FROM approval_decisions a JOIN qc_reviews q ON q.id=a.qc_review_id
            WHERE q.document_id=d.id AND a.decided_by=u.id)))
    )
  ) ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION staff_notification_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM staff_notification_record(NEW); RETURN NEW; END $$;
CREATE TRIGGER staff_notification_audit AFTER INSERT ON audit_logs FOR EACH ROW
  WHEN (NEW.action IN ('qc.submitted','qc.resubmitted','qc.claimed','qc.released','qc.reassigned',
    'qc.passed','qc.returned','approval.l1_approved','approval.published','approval.returned',
    'approval.dropped','approval.taken_down','approval.l2_reassigned','batch.reassigned'))
  EXECUTE FUNCTION staff_notification_audit();

-- Preserve existing operator confirmation history, including explicit dismissals; do not replay every old workflow event.
DO $$ DECLARE entry audit_logs; BEGIN
  FOR entry IN SELECT a.* FROM audit_logs a WHERE a.action IN ('approval.l1_approved','approval.published')
    ORDER BY a.created_at,a.id LOOP
    PERFORM staff_notification_record(entry);
  END LOOP;
END $$;
DO $$ DECLARE entry audit_logs; BEGIN
  FOR entry IN SELECT DISTINCT ON (a.batch_id) a.* FROM audit_logs a
    JOIN documents d ON d.batch_id=a.batch_id
    WHERE (d.workflow_status='qc_waiting' AND a.action IN ('qc.submitted','qc.resubmitted','qc.released','qc.reassigned','approval.returned','approval.taken_down'))
      OR (d.workflow_status='qc_in_review' AND a.action='qc.claimed')
      OR (d.workflow_status='rework' AND a.action='qc.returned')
      OR (d.workflow_status='awaiting_approval_l1' AND a.action IN ('qc.passed','approval.taken_down'))
      OR (d.workflow_status='awaiting_approval_l2' AND a.action IN ('approval.l1_approved','approval.l2_reassigned'))
    ORDER BY a.batch_id,a.created_at DESC,a.id DESC LOOP
    PERFORM staff_notification_record(entry);
  END LOOP;
END $$;
UPDATE staff_notification_recipients n SET read_at=old.dismissed_at
  FROM staff_notification_events e,approval_notification_reads old
  WHERE n.event_id=e.id AND old.user_id=n.user_id AND old.decision_id=e.decision_id;

-- NOTIFY is a commit-time wake-up only. Durable rows, not the notification queue, are the source of truth.
CREATE FUNCTION staff_notification_wake() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
  FOR target IN SELECT DISTINCT user_id FROM changed LOOP
    PERFORM pg_notify('digitalarch_staff_notifications',current_database()||':'||current_schema()||':'||target::text);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER staff_notification_insert_wake AFTER INSERT ON staff_notification_recipients
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION staff_notification_wake();
CREATE TRIGGER staff_notification_read_wake AFTER UPDATE ON staff_notification_recipients
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION staff_notification_wake();
