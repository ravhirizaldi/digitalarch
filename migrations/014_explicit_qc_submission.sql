-- Completing capture prepares a document; only an operator submission starts QC.
ALTER TABLE documents DROP CONSTRAINT documents_workflow_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_workflow_status_check
  CHECK(workflow_status IN ('capturing','operator_preparation','preparing','qc_waiting','qc_in_review','rework','awaiting_approval_l1'));
ALTER TABLE qc_reviews ADD COLUMN submitted_by UUID REFERENCES users(id);
ALTER TABLE qc_reviews ADD COLUMN submitted_at TIMESTAMPTZ;

-- Preserve existing decisions/claims; never attribute legacy automatic submission to a person.
WITH changed AS (
  UPDATE documents d SET workflow_status='operator_preparation',version=d.version+1,updated_at=now()
  FROM archive_batches b WHERE b.id=d.batch_id AND b.status='capture_completed'
    AND d.workflow_status IN ('preparing','qc_waiting')
    AND NOT EXISTS(SELECT 1 FROM qc_reviews r WHERE r.document_id=d.id
      AND (r.claimed_at IS NOT NULL OR r.decided_at IS NOT NULL OR r.outcome IS NOT NULL))
  RETURNING d.id,d.batch_id
)
INSERT INTO audit_logs(action,entity_type,entity_id,batch_id,metadata)
  SELECT 'qc.preparation_restored','document',id,batch_id,
    '{"reason":"Explicit operator submission is now required; no QC pickup or decision existed."}'::jsonb
  FROM changed;

UPDATE qc_reviews r SET submitted_at=r.created_at FROM documents d
  WHERE d.id=r.document_id AND (d.workflow_status<>'operator_preparation' OR r.cycle<d.review_cycle);

CREATE OR REPLACE FUNCTION document_capture_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc documents;
BEGIN
  IF NEW.status='capture_completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT * INTO doc FROM documents WHERE batch_id=NEW.id ORDER BY document_index LIMIT 1 FOR UPDATE;
    IF doc.workflow_status='capturing' THEN
      UPDATE documents SET workflow_status='operator_preparation',version=version+1,
        revision=revision+1,updated_at=now() WHERE id=doc.id;
    ELSIF doc.workflow_status NOT IN ('operator_preparation','rework') THEN
      RAISE EXCEPTION 'Submitted documents cannot complete capture again';
    END IF;
  END IF;
  RETURN NEW;
END $$;
