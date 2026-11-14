-- Capture status remains separate from the document's review/approval lifecycle.
ALTER TABLE documents ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'capturing'
  CHECK(workflow_status IN ('capturing','preparing','qc_waiting','qc_in_review','rework','awaiting_approval_l1'));
ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE documents ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 0 CHECK(metadata_version>=0);
ALTER TABLE documents ADD COLUMN extraction_key TEXT;
ALTER TABLE documents ADD COLUMN required_metadata TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN review_cycle INTEGER NOT NULL DEFAULT 0 CHECK(review_cycle>=0);
CREATE INDEX documents_workflow ON documents(workflow_status,updated_at);

CREATE TABLE qc_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL REFERENCES documents(id),
  cycle INTEGER NOT NULL CHECK(cycle>0), outcome TEXT CHECK(outcome IN ('returned','passed')),
  claimed_by UUID REFERENCES users(id), claimed_at TIMESTAMPTZ, claim_expires_at TIMESTAMPTZ,
  ordering_reviewed BOOLEAN NOT NULL DEFAULT false, completeness_reviewed BOOLEAN NOT NULL DEFAULT false,
  metadata_reviewed BOOLEAN NOT NULL DEFAULT false, ocr_exception TEXT,
  notes TEXT NOT NULL DEFAULT '', decision_reason TEXT, decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ, reviewed_revision INTEGER, snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id,cycle), CHECK((claimed_by IS NULL)=(claim_expires_at IS NULL))
);
CREATE TABLE qc_page_reviews (
  review_id UUID NOT NULL REFERENCES qc_reviews(id), page_id UUID NOT NULL REFERENCES pages(id),
  status TEXT NOT NULL CHECK(status IN ('reviewed','needs_correction')),
  image_revision INTEGER NOT NULL, reviewed_by UUID NOT NULL REFERENCES users(id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(review_id,page_id)
);
CREATE TABLE qc_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL REFERENCES documents(id),
  review_id UUID NOT NULL REFERENCES qc_reviews(id), page_ids UUID[] NOT NULL DEFAULT '{}', metadata_field_id TEXT,
  category TEXT NOT NULL CHECK(category IN ('blurred_page','cropped_page','incorrect_orientation','incorrect_order','missing_page','duplicate_page','suspected_blank_page','unreadable_text','ocr_error','metadata_error','incomplete_document','other')),
  severity TEXT NOT NULL CHECK(severity IN ('minor','major','critical')),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','waived')),
  resolution_note TEXT, created_by UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by UUID REFERENCES users(id), resolved_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX findings_document ON qc_findings(document_id,status);
CREATE TABLE document_metadata_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL REFERENCES documents(id),
  version INTEGER NOT NULL, fields JSONB NOT NULL, actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(document_id,version)
);
CREATE TABLE ocr_text_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), result_id UUID NOT NULL REFERENCES page_ocr_results(id),
  corrected_text TEXT NOT NULL CHECK(length(corrected_text)<=2000000),
  created_by UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ocr_corrections_result ON ocr_text_corrections(result_id,created_at DESC);
ALTER TABLE scan_sessions ADD COLUMN insertion_anchor UUID REFERENCES pages(id);
ALTER TABLE scan_sessions ADD COLUMN insertion_side TEXT CHECK(insertion_side IN ('before','after'));
ALTER TABLE scan_sessions ADD COLUMN replacement_target UUID REFERENCES pages(id);
ALTER TABLE scan_sessions ADD COLUMN replacement_status TEXT CHECK(replacement_status IN ('pending','confirmed','cancelled'));
ALTER TABLE scan_sessions ADD COLUMN display_order_base INTEGER NOT NULL DEFAULT 0 CHECK(display_order_base>=0);
UPDATE scan_sessions SET display_order_base=capture_order_base;
ALTER TABLE pages ADD COLUMN replacement_candidate BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pages ADD COLUMN replaced_by_page_id UUID REFERENCES pages(id);

CREATE FUNCTION document_capture_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc documents;
BEGIN
  IF NEW.status='capture_completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT * INTO doc FROM documents WHERE batch_id=NEW.id ORDER BY document_index LIMIT 1 FOR UPDATE;
    UPDATE documents SET workflow_status='preparing', review_cycle=review_cycle+1,
      revision=revision+1,version=version+1,updated_at=now() WHERE id=doc.id;
    INSERT INTO qc_reviews(document_id,cycle) VALUES(doc.id,doc.review_cycle+1);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_review_transition AFTER UPDATE OF status ON archive_batches
  FOR EACH ROW EXECUTE FUNCTION document_capture_transition();
UPDATE documents d SET workflow_status='preparing',review_cycle=1
  FROM archive_batches b WHERE b.id=d.batch_id AND b.status='capture_completed' AND b.deleted_at IS NULL;
INSERT INTO qc_reviews(document_id,cycle) SELECT id,1 FROM documents WHERE review_cycle=1;

CREATE TRIGGER metadata_revisions_append_only BEFORE UPDATE OR DELETE ON document_metadata_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_audit();
CREATE TRIGGER ocr_corrections_append_only BEFORE UPDATE OR DELETE ON ocr_text_corrections
  FOR EACH ROW EXECUTE FUNCTION protect_audit();
INSERT INTO permissions(code) VALUES('qc:reassign'),('qc:configure');
INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
  WHERE (r.code='qc_officer' AND p.code IN ('batches:read_all','ocr:read','ocr:read_all'))
     OR (r.code='system_admin' AND p.code IN ('qc:read','qc:reassign','qc:configure'));

ALTER FUNCTION queue_batch_ocr(UUID,TEXT,JSONB,TEXT) RENAME TO queue_batch_ocr_snapshot;
CREATE FUNCTION queue_batch_ocr(target UUID, languages TEXT DEFAULT NULL,
  configuration JSONB DEFAULT NULL, request TEXT DEFAULT 'capture') RETURNS UUID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM archive_batches WHERE id=target FOR UPDATE;
  IF EXISTS(SELECT 1 FROM documents WHERE batch_id=target AND workflow_status='awaiting_approval_l1') THEN
    RETURN NULL;
  END IF;
  RETURN queue_batch_ocr_snapshot(target,languages,configuration,request);
END $$;

CREATE FUNCTION protect_qc_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM archive_batches WHERE id=NEW.batch_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM documents WHERE batch_id=NEW.batch_id AND workflow_status='awaiting_approval_l1') THEN
    RAISE EXCEPTION 'QC-passed document revision is locked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qc_page_lock BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION protect_qc_revision();
