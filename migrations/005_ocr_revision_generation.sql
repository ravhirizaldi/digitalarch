-- A revision may return to identical bytes; retain a new job snapshot instead of resurrecting stale results.
ALTER TABLE pages ADD COLUMN image_revision INTEGER NOT NULL DEFAULT 1 CHECK(image_revision>0);
ALTER TABLE page_ocr_results ADD COLUMN image_revision INTEGER NOT NULL DEFAULT 1 CHECK(image_revision>0);
CREATE UNIQUE INDEX ocr_one_processing_page ON page_ocr_results(ocr_job_id) WHERE status='processing';
ALTER TABLE ocr_jobs ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION ocr_revision_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checksum TEXT;
BEGIN
  IF NEW.active_storage_key=NEW.original_storage_key THEN checksum:=NEW.sha256;
  ELSE
    SELECT sha256 INTO checksum FROM page_revisions WHERE page_id=NEW.id AND storage_key=NEW.active_storage_key ORDER BY created_at DESC LIMIT 1;
    IF checksum IS NULL THEN RAISE EXCEPTION 'Active image requires a recorded page revision'; END IF;
  END IF;
  NEW.active_image_sha256:=checksum;
  IF TG_OP='INSERT' THEN NEW.image_revision:=1;
  ELSIF ROW(NEW.active_storage_key,NEW.rotation_degrees,NEW.is_excluded) IS DISTINCT FROM ROW(OLD.active_storage_key,OLD.rotation_degrees,OLD.is_excluded)
    THEN NEW.image_revision:=OLD.image_revision+1;
  ELSE NEW.image_revision:=OLD.image_revision;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION queue_batch_ocr(target UUID, languages TEXT DEFAULT 'ind+eng') RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE batch archive_batches; signature TEXT; count_pages INTEGER; job UUID;
BEGIN
  SELECT * INTO batch FROM archive_batches WHERE id=target FOR UPDATE;
  IF batch.status<>'capture_completed' OR batch.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT md5(string_agg(id::text||':'||active_storage_key||':'||active_image_sha256||':'||rotation_degrees::text||':'||image_revision::text,',' ORDER BY capture_order)),count(*)
    INTO signature,count_pages FROM pages WHERE batch_id=target AND NOT is_excluded;
  IF count_pages=0 THEN RETURN NULL; END IF;
  INSERT INTO ocr_jobs(batch_id,manifest_hash,language,total_pages) VALUES(target,signature,languages,count_pages)
    ON CONFLICT(batch_id,manifest_hash,language) DO NOTHING RETURNING id INTO job;
  IF job IS NULL THEN
    SELECT id INTO job FROM ocr_jobs WHERE batch_id=target AND manifest_hash=signature AND language=languages;
    RETURN job;
  END IF;
  INSERT INTO page_ocr_results(page_id,batch_id,ocr_job_id,image_sha256,storage_key,rotation_degrees,language,image_revision)
    SELECT id,batch_id,job,active_image_sha256,active_storage_key,rotation_degrees,languages,image_revision FROM pages WHERE batch_id=target AND NOT is_excluded;
  UPDATE archive_batches SET ocr_status='queued' WHERE id=target;
  INSERT INTO audit_logs(action,entity_type,entity_id,batch_id,metadata)
    VALUES('ocr.queued','ocr_job',job,target,jsonb_build_object('pages',count_pages,'language',languages));
  RETURN job;
END $$;
