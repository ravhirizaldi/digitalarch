ALTER TABLE archive_batches ADD COLUMN ocr_status TEXT CHECK (ocr_status IN ('queued','running','paused','completed','completed_with_errors','failed','cancelled'));
ALTER TABLE pages ADD COLUMN active_image_sha256 TEXT;
UPDATE pages SET active_image_sha256=sha256;
ALTER TABLE pages ALTER COLUMN active_image_sha256 SET NOT NULL;
ALTER TABLE pages ADD CONSTRAINT active_image_checksum CHECK (active_image_sha256 ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX pages_identity_batch ON pages(id,batch_id);

CREATE TABLE ocr_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), batch_id UUID NOT NULL REFERENCES archive_batches(id),
  manifest_hash TEXT NOT NULL, language TEXT NOT NULL CHECK (language IN ('ind','eng','ind+eng','eng+ind')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused','completed','completed_with_errors','failed','cancelled')),
  total_pages INTEGER NOT NULL CHECK(total_pages>0), processed_pages INTEGER NOT NULL DEFAULT 0 CHECK(processed_pages>=0),
  failed_pages INTEGER NOT NULL DEFAULT 0 CHECK(failed_pages>=0), attempt_count INTEGER NOT NULL DEFAULT 0,
  engine TEXT NOT NULL DEFAULT 'Tesseract (NAPS2)', engine_version TEXT, engine_config JSONB, config_hash TEXT,
  lease_token UUID, lease_expires_at TIMESTAMPTZ, worker_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error TEXT, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(batch_id,manifest_hash,language), UNIQUE(id,batch_id),
  CHECK(processed_pages+failed_pages<=total_pages),
  CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE INDEX ocr_queue ON ocr_jobs(created_at,id) WHERE status='queued';
CREATE INDEX ocr_stale_claim ON ocr_jobs(lease_expires_at) WHERE lease_token IS NOT NULL;
CREATE INDEX ocr_jobs_batch ON ocr_jobs(batch_id,created_at DESC);

CREATE TABLE page_ocr_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), page_id UUID NOT NULL, batch_id UUID NOT NULL,
  ocr_job_id UUID NOT NULL, image_sha256 TEXT NOT NULL CHECK(image_sha256 ~ '^[a-f0-9]{64}$'),
  storage_key TEXT NOT NULL, rotation_degrees INTEGER NOT NULL CHECK(rotation_degrees IN (0,90,180,270)),
  extracted_text TEXT, structured_result JSONB, language TEXT NOT NULL, engine TEXT NOT NULL DEFAULT 'Tesseract (NAPS2)',
  engine_version TEXT, config_hash TEXT, reused_result_id UUID REFERENCES page_ocr_results(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed','cancelled')),
  is_stale BOOLEAN NOT NULL DEFAULT false, attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ, processing_ms INTEGER,
  error_code TEXT, error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ocr_job_id,page_id),
  FOREIGN KEY(page_id,batch_id) REFERENCES pages(id,batch_id),
  FOREIGN KEY(ocr_job_id,batch_id) REFERENCES ocr_jobs(id,batch_id),
  CHECK(status<>'completed' OR (config_hash IS NOT NULL AND engine_version IS NOT NULL AND processed_at IS NOT NULL))
);
CREATE UNIQUE INDEX ocr_success_identity ON page_ocr_results(page_id,image_sha256,config_hash)
  WHERE status='completed' AND reused_result_id IS NULL;
CREATE INDEX ocr_page_history ON page_ocr_results(page_id,created_at DESC);
CREATE INDEX ocr_pending_pages ON page_ocr_results(ocr_job_id,next_attempt_at) WHERE status='queued';

CREATE FUNCTION queue_batch_ocr(target UUID, languages TEXT DEFAULT 'ind+eng') RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE batch archive_batches; signature TEXT; count_pages INTEGER; job UUID;
BEGIN
  SELECT * INTO batch FROM archive_batches WHERE id=target FOR UPDATE;
  IF batch.status<>'capture_completed' OR batch.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT md5(string_agg(id::text||':'||active_storage_key||':'||active_image_sha256||':'||rotation_degrees::text,',' ORDER BY capture_order)),count(*)
    INTO signature,count_pages FROM pages WHERE batch_id=target AND NOT is_excluded;
  IF count_pages=0 THEN RETURN NULL; END IF;
  INSERT INTO ocr_jobs(batch_id,manifest_hash,language,total_pages) VALUES(target,signature,languages,count_pages)
    ON CONFLICT(batch_id,manifest_hash,language) DO NOTHING RETURNING id INTO job;
  IF job IS NULL THEN
    SELECT id INTO job FROM ocr_jobs WHERE batch_id=target AND manifest_hash=signature AND language=languages;
    RETURN job;
  END IF;
  INSERT INTO page_ocr_results(page_id,batch_id,ocr_job_id,image_sha256,storage_key,rotation_degrees,language)
    SELECT id,batch_id,job,active_image_sha256,active_storage_key,rotation_degrees,languages FROM pages WHERE batch_id=target AND NOT is_excluded;
  UPDATE archive_batches SET ocr_status='queued' WHERE id=target;
  INSERT INTO audit_logs(action,entity_type,entity_id,batch_id,metadata)
    VALUES('ocr.queued','ocr_job',job,target,jsonb_build_object('pages',count_pages,'language',languages));
  RETURN job;
END $$;

CREATE FUNCTION ocr_revision_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checksum TEXT;
BEGIN
  IF NEW.active_storage_key=NEW.original_storage_key THEN checksum:=NEW.sha256;
  ELSE
    SELECT sha256 INTO checksum FROM page_revisions WHERE page_id=NEW.id AND storage_key=NEW.active_storage_key ORDER BY created_at DESC LIMIT 1;
    IF checksum IS NULL THEN RAISE EXCEPTION 'Active image requires a recorded page revision'; END IF;
  END IF;
  NEW.active_image_sha256:=checksum;
  RETURN NEW;
END $$;
CREATE TRIGGER ocr_current_image BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION ocr_revision_integrity();
CREATE FUNCTION ocr_image_replaced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE languages TEXT;
BEGIN
  IF ROW(NEW.active_storage_key,NEW.active_image_sha256,NEW.rotation_degrees,NEW.is_excluded)
      IS DISTINCT FROM ROW(OLD.active_storage_key,OLD.active_image_sha256,OLD.rotation_degrees,OLD.is_excluded) THEN
    UPDATE page_ocr_results SET is_stale=true,updated_at=now() WHERE page_id=NEW.id;
    SELECT language INTO languages FROM ocr_jobs WHERE batch_id=NEW.batch_id ORDER BY created_at DESC,id DESC LIMIT 1;
    PERFORM queue_batch_ocr(NEW.batch_id,coalesce(languages,'ind+eng'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ocr_replacement AFTER UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION ocr_image_replaced();

INSERT INTO permissions(code) VALUES ('ocr:read'),('ocr:manage'),('ocr:read_all'),('ocr:manage_all');
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE
  (r.code='operator' AND p.code IN ('ocr:read','ocr:manage')) OR
  (r.code='system_admin' AND p.code IN ('ocr:read','ocr:manage','ocr:read_all','ocr:manage_all'));
