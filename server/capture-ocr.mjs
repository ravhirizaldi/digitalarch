import { audit } from './auth.mjs';

// Rework keeps old recognition (including terminal exceptions), independent of new global defaults.
export async function queueCaptureOcr(client, storage, doc, language = null, config = null) {
  const existing = new Set(
    (await client.query('SELECT id FROM ocr_jobs WHERE batch_id=$1', [doc.batch_id])).rows.map(
      (job) => job.id,
    ),
  );
  const id = (
    await client.query('SELECT queue_batch_ocr($1,$2,$3) AS id', [doc.batch_id, language, config])
  ).rows[0].id;
  if (!id || existing.has(id) || doc.workflow_status !== 'rework') return id;
  const reused = await client.query(
    `WITH saved AS (
       SELECT next.id,old.status,old.engine,old.engine_version,old.config_hash,old.processed_at,
         old.error_code,old.error_message,coalesce(old.reused_result_id,old.id) AS source_id
       FROM page_ocr_results next
       JOIN LATERAL (
         SELECT old.* FROM page_ocr_results old JOIN ocr_jobs j ON j.id=old.ocr_job_id
         WHERE old.page_id=next.page_id AND old.ocr_job_id<>next.ocr_job_id
           AND old.image_revision=next.image_revision AND old.image_sha256=next.image_sha256
           AND old.storage_key=next.storage_key AND old.rotation_degrees=next.rotation_degrees
           AND NOT old.is_stale AND old.status IN ('completed','failed','cancelled')
         ORDER BY j.created_at DESC,j.id DESC LIMIT 1
       ) old ON true WHERE next.ocr_job_id=$1
     ) UPDATE page_ocr_results next SET status=CASE WHEN saved.status='completed' THEN 'completed' ELSE 'failed' END,
       engine=saved.engine,engine_version=saved.engine_version,config_hash=saved.config_hash,
       processed_at=coalesce(saved.processed_at,now()),processing_ms=0,reused_result_id=saved.source_id,
       error_code=CASE WHEN saved.status='cancelled' THEN 'previous_cancelled' ELSE saved.error_code END,
       error_message=saved.error_message,updated_at=now()
      FROM saved WHERE next.id=saved.id RETURNING next.storage_key,next.image_sha256`,
    [id],
  );
  for (const page of reused.rows) await storage.ocrImage(page);
  await client.query(
    `WITH counts AS (SELECT count(*) FILTER(WHERE status='completed')::int AS done,
       count(*) FILTER(WHERE status='failed')::int AS failed,
       count(*) FILTER(WHERE status='queued')::int AS pending FROM page_ocr_results WHERE ocr_job_id=$1)
     UPDATE ocr_jobs SET processed_pages=counts.done,failed_pages=counts.failed,
       status=CASE WHEN counts.pending>0 THEN 'queued' WHEN counts.failed>0 THEN 'completed_with_errors' ELSE 'completed' END,
       completed_at=CASE WHEN counts.pending=0 THEN now() END FROM counts WHERE id=$1`,
    [id],
  );
  await client.query(
    'UPDATE archive_batches SET ocr_status=(SELECT status FROM ocr_jobs WHERE id=$2) WHERE id=$1',
    [doc.batch_id, id],
  );
  await audit(client, null, 'ocr.reused', 'ocr_job', id, { pages: reused.rowCount }, doc.batch_id);
  return id;
}
