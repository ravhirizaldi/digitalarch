-- Preserve existing Fast results; new runs explicitly snapshot accuracy settings.
ALTER TABLE ocr_jobs ADD COLUMN processing_config JSONB NOT NULL DEFAULT '{"version":0,"profile":"legacy","quality":"fast","psm":3,"dpi":300,"preprocessing":{}}';
ALTER TABLE ocr_jobs ADD COLUMN request_key TEXT NOT NULL DEFAULT 'capture' CHECK(length(request_key)<=64);
ALTER TABLE ocr_jobs DROP CONSTRAINT ocr_jobs_batch_id_manifest_hash_language_key;
ALTER TABLE ocr_jobs ADD CONSTRAINT ocr_run_identity UNIQUE(batch_id,manifest_hash,language,processing_config,request_key);
ALTER TABLE ocr_jobs ADD CONSTRAINT ocr_processing_configuration CHECK (
  jsonb_typeof(processing_config)='object' AND processing_config->>'profile' IN ('legacy','standard','enhanced','high-accuracy')
  AND processing_config->>'quality' IN ('fast','best') AND processing_config->>'psm' IN ('3','4','6') AND processing_config->>'dpi'='300'
);

DROP FUNCTION queue_batch_ocr(UUID,TEXT);
CREATE FUNCTION queue_batch_ocr(target UUID, languages TEXT DEFAULT 'ind+eng', configuration JSONB DEFAULT
  '{"version":1,"profile":"standard","quality":"best","psm":3,"dpi":300,"preprocessing":{"grayscale":false,"contrast":false,"deskew":false,"denoise":false,"adaptiveThreshold":false}}',
  request TEXT DEFAULT 'capture') RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE batch archive_batches; signature TEXT; count_pages INTEGER; job UUID;
BEGIN
  SELECT * INTO batch FROM archive_batches WHERE id=target FOR UPDATE;
  IF batch.status<>'capture_completed' OR batch.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT md5(string_agg(id::text||':'||active_storage_key||':'||active_image_sha256||':'||rotation_degrees::text||':'||image_revision::text,',' ORDER BY capture_order)),count(*)
    INTO signature,count_pages FROM pages WHERE batch_id=target AND NOT is_excluded;
  IF count_pages=0 THEN RETURN NULL; END IF;
  INSERT INTO ocr_jobs(batch_id,manifest_hash,language,total_pages,processing_config,request_key) VALUES(target,signature,languages,count_pages,configuration,request)
    ON CONFLICT ON CONSTRAINT ocr_run_identity DO NOTHING RETURNING id INTO job;
  IF job IS NULL THEN
    SELECT id INTO job FROM ocr_jobs WHERE batch_id=target AND manifest_hash=signature AND language=languages AND processing_config=configuration AND request_key=request;
    RETURN job;
  END IF;
  INSERT INTO page_ocr_results(page_id,batch_id,ocr_job_id,image_sha256,storage_key,rotation_degrees,language,image_revision)
    SELECT id,batch_id,job,active_image_sha256,active_storage_key,rotation_degrees,languages,image_revision FROM pages WHERE batch_id=target AND NOT is_excluded;
  UPDATE archive_batches SET ocr_status='queued' WHERE id=target;
  INSERT INTO audit_logs(action,entity_type,entity_id,batch_id,metadata)
    VALUES('ocr.queued','ocr_job',job,target,jsonb_build_object('pages',count_pages,'language',languages,'profile',configuration->>'profile','psm',configuration->>'psm'));
  RETURN job;
END $$;

CREATE OR REPLACE FUNCTION ocr_image_replaced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE languages TEXT; configuration JSONB;
BEGIN
  IF ROW(NEW.active_storage_key,NEW.active_image_sha256,NEW.rotation_degrees,NEW.is_excluded)
      IS DISTINCT FROM ROW(OLD.active_storage_key,OLD.active_image_sha256,OLD.rotation_degrees,OLD.is_excluded) THEN
    UPDATE page_ocr_results SET is_stale=true,updated_at=now() WHERE page_id=NEW.id;
    SELECT language,processing_config INTO languages,configuration FROM ocr_jobs WHERE batch_id=NEW.batch_id ORDER BY created_at DESC,id DESC LIMIT 1;
    IF configuration IS NULL THEN PERFORM queue_batch_ocr(NEW.batch_id,coalesce(languages,'ind+eng'));
    ELSE PERFORM queue_batch_ocr(NEW.batch_id,coalesce(languages,'ind+eng'),configuration); END IF;
  END IF;
  RETURN NEW;
END $$;
