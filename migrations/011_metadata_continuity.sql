-- Adopt the latest saved per-run metadata once; keep those rows as historical snapshots.
ALTER TABLE documents ALTER COLUMN metadata_status SET DEFAULT 'not_extracted';
UPDATE documents SET metadata_status='not_extracted' WHERE metadata_status='pending' AND metadata_json IS NULL;
DO $$
DECLARE legacy RECORD; current_fields JSONB; imported JSONB; combined JSONB; next_version INTEGER;
BEGIN
  FOR legacy IN
    SELECT DISTINCT ON(d.id) d.id,d.batch_id,d.metadata_json,d.metadata_version,m.fields,m.warnings,m.updated_by,m.updated_at
    FROM documents d JOIN ocr_jobs j ON j.batch_id=d.batch_id JOIN document_metadata m ON m.ocr_job_id=j.id
    WHERE d.workflow_status<>'awaiting_approval_l1'
    ORDER BY d.id,j.created_at DESC,j.id DESC
  LOOP
    current_fields=coalesce(legacy.metadata_json->'fields','[]'::jsonb);
    SELECT coalesce(jsonb_agg(f || jsonb_build_object(
      'origin',CASE WHEN jsonb_array_length(coalesce(f->'source','[]'::jsonb))=0 THEN 'manual'
        WHEN f->>'originalValue' IS NOT NULL AND f->>'originalValue'<>f->>'value' THEN 'corrected' ELSE 'machine' END,
      'verification','needs_review','editedBy',legacy.updated_by,'editedAt',legacy.updated_at,
      'extractionMethod','legacy-rules-v1')), '[]'::jsonb) INTO imported FROM jsonb_array_elements(legacy.fields) f;
    -- Current human edits win; legacy human edits replace only machine suggestions for the same field context.
    SELECT coalesce(jsonb_agg(f),'[]'::jsonb) INTO combined FROM jsonb_array_elements(current_fields) f
      WHERE f->>'origin' IN ('manual','corrected') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(imported) i
        WHERE i->>'type'=f->>'type' AND coalesce(i->>'context','')=coalesce(f->>'context',''));
    SELECT combined || coalesce(jsonb_agg(i),'[]'::jsonb) INTO combined FROM jsonb_array_elements(imported) i
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(combined) f
        WHERE f->>'id'=i->>'id' OR (f->>'type'=i->>'type' AND coalesce(f->>'context','')=coalesce(i->>'context','')));
    SELECT coalesce(jsonb_agg(f ORDER BY CASE WHEN f->>'origin' IN ('manual','corrected') THEN 0 ELSE 1 END,n),'[]'::jsonb)
      INTO combined FROM jsonb_array_elements(combined) WITH ORDINALITY x(f,n);
    next_version=legacy.metadata_version+1;
    UPDATE documents SET metadata_json=jsonb_build_object('fields',combined,'warnings',legacy.warnings),
      metadata_version=next_version,metadata_status='needs_review',extraction_key=NULL,
      title=(SELECT f->>'value' FROM jsonb_array_elements(combined) f WHERE f->>'type'='title' LIMIT 1),
      archive_number=(SELECT f->>'value' FROM jsonb_array_elements(combined) f WHERE f->>'type'='document_number' LIMIT 1),
      version=version+1,revision=revision+1,updated_at=now() WHERE id=legacy.id;
    INSERT INTO document_metadata_revisions(document_id,version,fields,actor_id,action)
      VALUES(legacy.id,next_version,combined,legacy.updated_by,'metadata.adopted');
    INSERT INTO audit_logs(action,entity_type,entity_id,batch_id,metadata)
      VALUES('metadata.adopted','document',legacy.id,legacy.batch_id,jsonb_build_object('version',next_version));
  END LOOP;
END $$;
