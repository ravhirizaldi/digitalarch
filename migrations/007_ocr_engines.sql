-- New jobs only: historical configuration hashes and result labels are immutable.
ALTER TABLE ocr_jobs ADD CONSTRAINT ocr_engine_configuration CHECK (
  NOT (processing_config ? 'engine') OR
  coalesce((processing_config->>'engine'='paddleocr' AND processing_config->>'model'='PP-OCRv6 Small'
   AND processing_config->>'version'='3' AND processing_config->>'psm'='3'
   AND coalesce(processing_config->>'layout','page')='page'),false)
);

CREATE FUNCTION ocr_engine_label() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE configuration JSONB;
BEGIN
  IF TG_TABLE_NAME='ocr_jobs' THEN configuration=NEW.processing_config;
  ELSE SELECT processing_config INTO configuration FROM ocr_jobs WHERE id=NEW.ocr_job_id;
  END IF;
  NEW.engine=CASE WHEN configuration->>'engine'='paddleocr' THEN 'PaddleOCR' ELSE 'Tesseract (NAPS2)' END;
  RETURN NEW;
END $$;
CREATE TRIGGER ocr_job_engine BEFORE INSERT ON ocr_jobs FOR EACH ROW EXECUTE FUNCTION ocr_engine_label();
CREATE TRIGGER ocr_page_engine BEFORE INSERT ON page_ocr_results FOR EACH ROW EXECUTE FUNCTION ocr_engine_label();
