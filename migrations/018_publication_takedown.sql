ALTER TABLE qc_reviews ADD COLUMN carried_from_review_id UUID REFERENCES qc_reviews(id);
ALTER TABLE qc_reviews ADD CONSTRAINT carried_qc_pass CHECK(
  carried_from_review_id IS NULL OR (outcome IS NOT NULL AND outcome='passed' AND carried_from_review_id<>id)
);
CREATE TABLE publication_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL REFERENCES documents(id),
  qc_review_id UUID NOT NULL UNIQUE REFERENCES qc_reviews(id),
  resumed_review_id UUID NOT NULL UNIQUE REFERENCES qc_reviews(id),
  revision INTEGER NOT NULL CHECK(revision>0), prior_published_at TIMESTAMPTZ NOT NULL,
  target TEXT NOT NULL CHECK(target IN ('qc','l1')),
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
  taken_by UUID NOT NULL REFERENCES users(id), officer_name TEXT NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX publication_withdrawals_document ON publication_withdrawals(document_id,taken_at DESC);
CREATE TRIGGER withdrawal_append_only BEFORE UPDATE OR DELETE ON publication_withdrawals
  FOR EACH ROW EXECUTE FUNCTION protect_audit();
