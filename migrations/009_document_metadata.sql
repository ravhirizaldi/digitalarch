CREATE TABLE document_metadata (
  ocr_job_id UUID PRIMARY KEY REFERENCES ocr_jobs(id),
  extractor_version INTEGER NOT NULL CHECK(extractor_version>0),
  fields JSONB NOT NULL CHECK(jsonb_typeof(fields)='array' AND jsonb_array_length(fields)<=200),
  warnings JSONB NOT NULL CHECK(jsonb_typeof(warnings)='array'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID NOT NULL REFERENCES users(id)
);
