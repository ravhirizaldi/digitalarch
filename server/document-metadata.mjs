import { randomUUID } from 'node:crypto';
import { audit, keys, text } from './auth.mjs';
import { transaction } from './db.mjs';
import { failure } from './errors.mjs';
import {
  mergeMetadata,
  metadataTypes,
  normalizeMetadataDate,
  metadataExtractorVersion,
} from './metadata-extract.mjs';

export function documentMetadata(pool, authorize) {
  async function load(client, user, jobId, manage = false) {
    const job = await authorize(user, jobId, manage, client, manage);
    const saved = (
      await client.query('SELECT * FROM document_metadata WHERE ocr_job_id=$1', [jobId])
    ).rows[0];
    const metadata = saved
      ? {
          extractorVersion: saved.extractor_version,
          fields: saved.fields,
          warnings: saved.warnings,
          version: saved.version,
          updatedAt: saved.updated_at,
        }
      : { fields: [], warnings: [], version: 0, updatedAt: null };
    return { job, metadata };
  }
  const checkVersion = (body, metadata) => {
    if (!Number.isSafeInteger(body.version) || body.version < 0)
      throw failure('invalid_request', 'A current metadata version is required.');
    if (body.version !== metadata.version)
      throw failure('conflict', 'Metadata changed. Reload it before saving again.', 409);
  };
  async function persist(client, user, job, metadata, action) {
    const saved = (
      await client.query(
        `INSERT INTO document_metadata(ocr_job_id,extractor_version,fields,warnings,updated_by)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(ocr_job_id) DO UPDATE SET fields=EXCLUDED.fields,warnings=EXCLUDED.warnings,
      extractor_version=EXCLUDED.extractor_version,updated_by=EXCLUDED.updated_by,updated_at=now(),version=document_metadata.version+1 RETURNING version,updated_at`,
        [
          job.id,
          metadata.extractorVersion,
          JSON.stringify(metadata.fields),
          JSON.stringify(metadata.warnings),
          user.id,
        ],
      )
    ).rows[0];
    await audit(
      client,
      user,
      action,
      'ocr_job',
      job.id,
      { fieldCount: metadata.fields.length, version: saved.version },
      job.batch_id,
    );
    return { metadata: { ...metadata, version: saved.version, updatedAt: saved.updated_at } };
  }
  return {
    async get(user, jobId) {
      const { metadata } = await load(pool, user, jobId);
      return { metadata };
    },
    async extract(user, jobId, body) {
      keys(body, ['version']);
      return transaction(pool, async (client) => {
        const { job, metadata } = await load(client, user, jobId, true);
        checkVersion(body, metadata);
        if (['queued', 'running', 'paused'].includes(job.status))
          throw failure(
            'metadata_locked',
            'Finish or cancel this OCR run before extracting all pages.',
            409,
          );
        const pages = (
          await client.query(
            `SELECT * FROM (SELECT r.id AS result_id,r.page_id,r.status,r.is_stale,p.capture_order AS page_number,
          (row_number() OVER(ORDER BY p.capture_order)-1)::int AS page_offset,
          coalesce(r.extracted_text,c.extracted_text) AS extracted_text,
          coalesce(r.structured_result,c.structured_result) AS structured_result
          FROM page_ocr_results r JOIN pages p ON p.id=r.page_id
          LEFT JOIN page_ocr_results c ON c.id=r.reused_result_id
          WHERE r.ocr_job_id=$1) available WHERE status='completed' ORDER BY page_number`,
            [jobId],
          )
        ).rows;
        if (!pages.length)
          throw failure('metadata_empty', 'No completed OCR pages are available to extract.', 409);
        const extracted = mergeMetadata(pages);
        if (pages.some((page) => page.is_stale))
          extracted.warnings.unshift(
            'Some source pages are historical revisions. This metadata describes this OCR run, not necessarily the current batch images.',
          );
        if (pages.length < job.total_pages)
          extracted.warnings.unshift(
            `Only ${pages.length} of ${job.total_pages} pages have completed OCR; metadata may be incomplete.`,
          );
        return persist(client, user, job, extracted, 'metadata.extracted');
      });
    },
    async save(user, jobId, body) {
      keys(body, ['version', 'fields']);
      if (!Array.isArray(body.fields) || body.fields.length > 200)
        throw failure('invalid_request', 'At most 200 metadata fields are allowed.');
      return transaction(pool, async (client) => {
        const { job, metadata } = await load(client, user, jobId, true);
        checkVersion(body, metadata);
        const ids = new Set();
        const fields = body.fields.map((field) => {
          keys(field, ['id', 'type', 'value', 'context']);
          if (!metadataTypes.includes(field.type))
            throw failure('invalid_request', 'Unsupported metadata field type.');
          const existing =
            field.id == null ? null : metadata.fields.find((item) => item.id === field.id);
          if ((field.id != null && !existing) || (existing && ids.has(field.id)))
            throw failure('invalid_request', 'Unknown or duplicate metadata field.');
          const id = existing?.id || randomUUID();
          ids.add(id);
          const value = text(field.value, 2000, 'Metadata value');
          const context = text(field.context, 240, 'Field context', true) || '';
          return {
            ...existing,
            id,
            type: field.type,
            value,
            context,
            normalized: field.type === 'date' ? normalizeMetadataDate(value) : null,
            source: existing?.source || [],
            alternatives: existing?.alternatives || [],
            originalValue: existing?.source?.length
              ? (existing.originalValue ?? existing.value)
              : null,
          };
        });
        return persist(
          client,
          user,
          job,
          {
            ...metadata,
            extractorVersion: metadata.extractorVersion || metadataExtractorVersion,
            fields,
          },
          'metadata.updated',
        );
      });
    },
  };
}
