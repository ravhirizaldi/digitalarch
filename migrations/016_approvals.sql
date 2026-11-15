CREATE TABLE approval_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  l2_required BOOLEAN NOT NULL DEFAULT true,
  l1_label TEXT NOT NULL DEFAULT 'Department Supervisor' CHECK(length(btrim(l1_label)) BETWEEN 1 AND 80),
  l2_label TEXT NOT NULL DEFAULT 'Final Records Authority' CHECK(length(btrim(l2_label)) BETWEEN 1 AND 80),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by UUID REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO approval_settings(singleton) VALUES(true);

ALTER TABLE documents DROP CONSTRAINT documents_workflow_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_workflow_status_check CHECK(workflow_status IN
  ('capturing','operator_preparation','preparing','qc_waiting','qc_in_review','rework','awaiting_approval_l1','awaiting_approval_l2','approved','dropped'));
ALTER TABLE documents ADD COLUMN approval_l2_required BOOLEAN;
ALTER TABLE documents ADD COLUMN approval_policy_version INTEGER;
ALTER TABLE documents ADD COLUMN assigned_l2_id UUID REFERENCES users(id);
ALTER TABLE documents ADD COLUMN published_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN published_by UUID REFERENCES users(id);
UPDATE documents SET approval_l2_required=true,approval_policy_version=1 WHERE workflow_status='awaiting_approval_l1';

ALTER TABLE qc_reviews ADD COLUMN assigned_reviewer_id UUID REFERENCES users(id);
ALTER TABLE qc_reviews ADD COLUMN approval_return_reason TEXT;

CREATE TABLE approval_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), qc_review_id UUID NOT NULL REFERENCES qc_reviews(id),
  level INTEGER NOT NULL CHECK(level IN (1,2)),
  decision TEXT NOT NULL CHECK(decision IN ('approved','returned','dropped')),
  decided_by UUID NOT NULL REFERENCES users(id), reason TEXT,
  officer_name TEXT NOT NULL CHECK(length(officer_name) BETWEEN 1 AND 120),
  nominated_l2_id UUID REFERENCES users(id), returned_to UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(qc_review_id,level),
  CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  CHECK(decision='approved' OR reason IS NOT NULL),
  CHECK((decision='returned')=(returned_to IS NOT NULL))
);
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION protect_audit();
CREATE INDEX approvals_actor ON approval_decisions(decided_by,decided_at DESC);
CREATE TABLE approval_notification_reads (
  user_id UUID NOT NULL REFERENCES users(id), decision_id UUID NOT NULL REFERENCES approval_decisions(id),
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,decision_id)
);
CREATE INDEX qc_assigned_reviewer ON qc_reviews(assigned_reviewer_id) WHERE outcome IS NULL;

CREATE OR REPLACE FUNCTION protect_qc_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM archive_batches WHERE id=NEW.batch_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM documents WHERE batch_id=NEW.batch_id AND workflow_status IN
    ('awaiting_approval_l1','awaiting_approval_l2','approved','dropped')) THEN
    RAISE EXCEPTION 'Reviewed document revision is locked';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION queue_batch_ocr(target UUID, languages TEXT DEFAULT NULL,
  configuration JSONB DEFAULT NULL, request TEXT DEFAULT 'capture') RETURNS UUID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM archive_batches WHERE id=target FOR UPDATE;
  IF EXISTS(SELECT 1 FROM documents WHERE batch_id=target AND workflow_status IN
    ('awaiting_approval_l1','awaiting_approval_l2','approved','dropped')) THEN RETURN NULL; END IF;
  RETURN queue_batch_ocr_snapshot(target,languages,configuration,request);
END $$;

CREATE FUNCTION protect_approval_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approval_l2_required IS NOT NULL AND
    ROW(NEW.approval_l2_required,NEW.approval_policy_version) IS DISTINCT FROM
    ROW(OLD.approval_l2_required,OLD.approval_policy_version) THEN
    RAISE EXCEPTION 'Batch approval policy is already fixed';
  END IF;
  IF OLD.workflow_status IN ('awaiting_approval_l1','awaiting_approval_l2','approved','dropped') AND
    ROW(NEW.title,NEW.archive_number,NEW.document_type,NEW.metadata_json,NEW.metadata_version,NEW.metadata_status,
      NEW.required_metadata,NEW.revision,NEW.extraction_key) IS DISTINCT FROM
    ROW(OLD.title,OLD.archive_number,OLD.document_type,OLD.metadata_json,OLD.metadata_version,OLD.metadata_status,
      OLD.required_metadata,OLD.revision,OLD.extraction_key) THEN
    RAISE EXCEPTION 'Reviewed document content is locked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_content_lock BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION protect_approval_content();
CREATE FUNCTION protect_qc_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.outcome IS NOT NULL THEN RAISE EXCEPTION 'QC decisions and snapshots are historical'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qc_decision_lock BEFORE UPDATE OR DELETE ON qc_reviews FOR EACH ROW EXECUTE FUNCTION protect_qc_decision();

INSERT INTO permissions(code) VALUES('documents:read'),('documents:read_all');
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
WHERE (r.code IN ('operator','qc_officer','approver_l1','approver_l2','system_admin') AND p.code='documents:read')
   OR (r.code='system_admin' AND p.code='documents:read_all');
