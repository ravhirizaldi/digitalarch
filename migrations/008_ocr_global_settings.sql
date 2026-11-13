CREATE TABLE ocr_defaults (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  language TEXT NOT NULL CHECK(language IN ('ind','eng','ind+eng','eng+ind')),
  processing_config JSONB NOT NULL CHECK(jsonb_typeof(processing_config)='object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id)
);

INSERT INTO permissions(code) VALUES('settings:read'),('settings:manage');
INSERT INTO role_permissions(role_id,permission_id)
  SELECT r.id,p.id FROM roles r CROSS JOIN permissions p
  WHERE r.code='system_admin' AND p.code IN ('settings:read','settings:manage');

-- Thread budgets are immutable job configuration, not a mutable worker switch.
ALTER TABLE ocr_jobs DROP CONSTRAINT ocr_engine_configuration;
ALTER TABLE ocr_jobs ADD CONSTRAINT ocr_engine_configuration CHECK (
  NOT (processing_config ? 'engine') OR coalesce((
    processing_config->>'engine'='paddleocr' AND processing_config->>'model'='PP-OCRv6 Small'
    AND processing_config->>'psm'='3' AND coalesce(processing_config->>'layout','page')='page'
    AND ((processing_config->>'version'='3' AND NOT (processing_config ? 'cpuThreads'))
      OR (processing_config->>'version'='4' AND processing_config->>'cpuThreads' IN ('1','2','4')))
  ),false)
);

CREATE OR REPLACE FUNCTION queue_batch_ocr(target UUID, languages TEXT DEFAULT NULL,
  configuration JSONB DEFAULT NULL, request TEXT DEFAULT 'capture') RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE batch archive_batches; signature TEXT; count_pages INTEGER; job UUID; defaults ocr_defaults;
BEGIN
  SELECT * INTO batch FROM archive_batches WHERE id=target FOR UPDATE;
  IF batch.status<>'capture_completed' OR batch.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT * INTO defaults FROM ocr_defaults WHERE singleton;
  languages=coalesce(languages,defaults.language,'ind+eng');
  configuration=coalesce(configuration,defaults.processing_config,
    '{"version":1,"profile":"standard","quality":"best","psm":3,"dpi":300,"preprocessing":{"grayscale":false,"contrast":false,"deskew":false,"denoise":false,"adaptiveThreshold":false}}'::jsonb);
  SELECT md5(string_agg(id::text||':'||active_storage_key||':'||active_image_sha256||':'||rotation_degrees::text||':'||image_revision::text,',' ORDER BY capture_order)),count(*)
    INTO signature,count_pages FROM pages WHERE batch_id=target AND NOT is_excluded;
  IF count_pages=0 THEN RETURN NULL; END IF;
  INSERT INTO ocr_jobs(batch_id,manifest_hash,language,total_pages,processing_config,request_key)
    VALUES(target,signature,languages,count_pages,configuration,request)
    ON CONFLICT ON CONSTRAINT ocr_run_identity DO NOTHING RETURNING id INTO job;
  IF job IS NULL THEN
    SELECT id INTO job FROM ocr_jobs WHERE batch_id=target AND manifest_hash=signature AND language=languages AND processing_config=configuration AND request_key=request;
    RETURN job;
  END IF;
  INSERT INTO page_ocr_results(page_id,batch_id,ocr_job_id,image_sha256,storage_key,rotation_degrees,language,image_revision)
    SELECT id,batch_id,job,active_image_sha256,active_storage_key,rotation_degrees,languages,image_revision FROM pages WHERE batch_id=target AND NOT is_excluded;
  UPDATE archive_batches SET ocr_status='queued' WHERE id=target;
  INSERT INTO audit_logs(action,entity_type,entity_id,batch_id,metadata)
    VALUES('ocr.queued','ocr_job',job,target,jsonb_build_object('pages',count_pages,'language',languages,'engine',coalesce(configuration->>'engine','tesseract'),'profile',configuration->>'profile','psm',configuration->>'psm','cpuThreads',configuration->'cpuThreads'));
  RETURN job;
END $$;
