import { randomUUID } from 'node:crypto';
import { audit, keys, text } from './auth.mjs';
import { failure } from './errors.mjs';
import { mergeMetadata, metadataTypes, normalizeMetadataDate } from './metadata-extract.mjs';

export const documentMetadataTypes = [...metadataTypes, 'document_type', 'physical_location'];
export const fieldsOf = (doc) => doc.metadata_json?.fields || [];
export const metadataOf = (doc) => ({
  fields: fieldsOf(doc),
  warnings: doc.metadata_json?.warnings || [],
  version: doc.metadata_version,
  updatedAt: doc.updated_at,
  status: doc.metadata_status,
});

export async function persistMetadata(
  client,
  doc,
  fields,
  user,
  action,
  warnings = doc.metadata_json?.warnings || [],
) {
  const version = doc.metadata_version + 1;
  const status =
    fields.length && fields.every((field) => field.verification === 'verified')
      ? 'verified'
      : fields.some((field) => field.origin === 'corrected')
        ? 'manually_corrected'
        : fields.length
          ? 'needs_review'
          : 'not_extracted';
  await client.query(
    `UPDATE documents SET metadata_json=$2,metadata_version=$3,metadata_status=$4,
    title=$5,archive_number=$6,document_type=$7,version=version+1,revision=revision+1,updated_at=now() WHERE id=$1`,
    [
      doc.id,
      JSON.stringify({ fields, warnings }),
      version,
      status,
      fields.find((f) => f.type === 'title')?.value || null,
      fields.find((f) => f.type === 'document_number')?.value || null,
      fields.find((f) => f.type === 'document_type')?.value || null,
    ],
  );
  await client.query(
    `INSERT INTO document_metadata_revisions(document_id,version,fields,actor_id,action)
    VALUES($1,$2,$3,$4,$5)`,
    [doc.id, version, JSON.stringify(fields), user?.id || null, action],
  );
  const location = fields.find((field) => field.type === 'physical_location');
  if (location) {
    if (location.value.length > 240)
      throw failure('invalid_request', 'Physical location must contain at most 240 characters.');
    await client.query('UPDATE archive_batches SET physical_location=$2 WHERE id=$1', [
      doc.batch_id,
      location.value,
    ]);
  }
  await audit(
    client,
    user,
    action,
    'document',
    doc.id,
    { version, fieldCount: fields.length },
    doc.batch_id,
  );
}

export function editedFields(doc, body, user, verifying) {
  keys(body, ['version', 'fields']);
  if (body.version !== doc.metadata_version || !Number.isSafeInteger(body.version))
    throw failure('conflict', 'Metadata changed. Reload before saving.', 409);
  if (!Array.isArray(body.fields) || body.fields.length > 200)
    throw failure('invalid_request', 'At most 200 metadata fields are allowed.');
  const seen = new Set();
  return body.fields.map((field) => {
    keys(field, ['id', 'type', 'value', 'context', 'verification', 'candidateId']);
    if (!documentMetadataTypes.includes(field.type))
      throw failure('invalid_request', 'Unsupported field type.');
    const old = fieldsOf(doc).find((item) => item.id === field.id);
    if (field.id != null && (!old || seen.has(field.id)))
      throw failure('invalid_request', 'Unknown or duplicate field.');
    const id = old?.id || randomUUID();
    seen.add(id);
    const value = text(field.value, 2000, 'Metadata value');
    const context = text(field.context, 240, 'Field context', true) || '';
    const normalized = field.type === 'date' ? normalizeMetadataDate(value) : null;
    if (field.type === 'date' && !normalized)
      throw failure('invalid_request', 'Enter a valid document date.');
    if (field.type === 'identity_number' && /\bNIK\b/i.test(context) && !/^\d{16}$/.test(value))
      throw failure(
        'invalid_request',
        'NIK must contain exactly 16 digits; the original candidate is retained.',
      );
    if (
      field.type === 'tax_number' &&
      /\bNPWP\b/i.test(context) &&
      (!/^[\d.\s-]+$/.test(value) || ![15, 16].includes(value.replace(/\D/g, '').length))
    )
      throw failure(
        'invalid_request',
        'NPWP must contain 15 or 16 digits, with optional printed separators.',
      );
    if (
      field.verification !== undefined &&
      !['verified', 'needs_review'].includes(field.verification)
    )
      throw failure('invalid_request', 'Invalid verification status.');
    if (!verifying && field.verification === 'verified' && old?.verification !== 'verified')
      throw failure('forbidden', 'Only the claiming QC Officer can verify fields.', 403);
    const changed =
      !old || old.value !== value || old.type !== field.type || old.context !== context;
    const candidate = field.candidateId
      ? old?.candidates?.find((c) => c.id === field.candidateId)
      : null;
    if (field.candidateId && (!candidate || candidate.value !== value))
      throw failure('invalid_request', 'Candidate does not match this field.');
    return {
      ...old,
      id,
      type: field.type,
      value,
      context,
      normalized,
      source: candidate?.source || old?.source || [],
      alternatives: old?.alternatives || [],
      selectedCandidateId: candidate?.id || old?.selectedCandidateId,
      sourceStale: candidate ? false : old?.sourceStale,
      originalValue: old?.originalValue ?? (old?.origin === 'machine' ? old.value : null),
      origin: changed ? (old?.source?.length ? 'corrected' : 'manual') : old.origin,
      verification:
        verifying && field.verification !== undefined
          ? field.verification
          : changed
            ? 'needs_review'
            : old.verification,
      editedBy: changed ? user.id : old?.editedBy,
      editedByName: changed ? user.display_name : old?.editedByName,
      editedAt: changed ? new Date().toISOString() : old?.editedAt,
      verifiedBy:
        verifying && field.verification === 'verified' ? user.id : changed ? null : old?.verifiedBy,
      verifiedByName:
        verifying && field.verification === 'verified'
          ? user.display_name
          : changed
            ? null
            : old?.verifiedByName,
      verifiedAt:
        verifying && field.verification === 'verified'
          ? new Date().toISOString()
          : changed
            ? null
            : old?.verifiedAt,
    };
  });
}

export async function currentOcr(client, batchId, { pageId = null, includeText = true } = {}) {
  return (
    await client.query(
      `SELECT p.id AS page_id,p.display_order AS page_number,
    (row_number() OVER(ORDER BY p.display_order,p.capture_order)-1)::int AS page_offset,
    r.id AS result_id,r.status,r.is_stale,r.image_revision,r.processed_at,r.engine,r.engine_version,
    r.error_message,j.processing_config,
    ${includeText ? 'coalesce(r.extracted_text,c.extracted_text)' : 'NULL'} AS extracted_text,
    ${includeText ? 'coalesce(r.structured_result,c.structured_result)' : 'NULL'} AS structured_result,
    ${includeText ? 'correction.corrected_text' : 'NULL'} AS corrected_text,correction.id AS correction_id,correction.created_by AS corrected_by,correction.created_at AS corrected_at
    FROM pages p LEFT JOIN LATERAL (SELECT r.* FROM page_ocr_results r JOIN ocr_jobs j ON j.id=r.ocr_job_id
      WHERE r.page_id=p.id AND r.image_revision=p.image_revision AND NOT r.is_stale
      ORDER BY j.created_at DESC,j.id DESC LIMIT 1) r ON true
    LEFT JOIN ocr_jobs j ON j.id=r.ocr_job_id LEFT JOIN page_ocr_results c ON c.id=r.reused_result_id
    LEFT JOIN LATERAL (SELECT correction.* FROM ocr_text_corrections correction
      JOIN page_ocr_results corrected ON corrected.id=correction.result_id
      WHERE corrected.page_id=p.id AND corrected.image_revision=p.image_revision
        AND coalesce(corrected.reused_result_id,corrected.id)=coalesce(r.reused_result_id,r.id)
      ORDER BY correction.created_at DESC,correction.id DESC LIMIT 1) correction ON true
    WHERE p.batch_id=$1 AND NOT p.is_excluded AND NOT p.replacement_candidate AND ($2::uuid IS NULL OR p.id=$2)
    ORDER BY p.display_order,p.capture_order`,
      [batchId, pageId],
    )
  ).rows;
}

export async function extractDocument(client, doc, user = null) {
  const summaries = await currentOcr(client, doc.batch_id, { includeText: false });
  const extractionKey = JSON.stringify(
    summaries.map((p) => [p.page_id, p.page_number, p.result_id, p.status, p.corrected_at]),
  );
  if (extractionKey === doc.extraction_key) return;
  const pages = await currentOcr(client, doc.batch_id);
  const ready = pages.filter((page) => page.status === 'completed');
  const extracted = mergeMetadata(
    ready.map((p) => ({ ...p, extracted_text: p.corrected_text ?? p.extracted_text })),
  );
  const previous = fieldsOf(doc);
  // Refresh suggestions without replacing human values; changed sources need verification again.
  const fields = previous.map((old) => {
    const candidates = extracted.fields.filter((f) => f.type === old.type);
    const sourceStale =
      old.source?.some((s) => !ready.some((p) => p.result_id === s.resultId)) || false;
    return {
      ...old,
      candidates,
      sourceStale,
      verification: sourceStale && !old.sourceStale ? 'needs_review' : old.verification,
    };
  });
  for (const field of extracted.fields) {
    if (!previous.some((old) => old.type === field.type && old.context === field.context))
      fields.push({
        ...field,
        id: randomUUID(),
        origin: 'machine',
        verification: 'needs_review',
        originalValue: field.value,
        extractionMethod: 'rules-v1',
      });
  }
  const warnings = [...extracted.warnings];
  if (fields.length > 200)
    warnings.push(
      'New machine fields exceed the 200-field limit; existing fields were retained. Review candidates before adding more fields.',
    );
  if (ready.length < pages.length)
    warnings.push(
      `${pages.length - ready.length} included pages have missing, failed or pending OCR.`,
    );
  await persistMetadata(client, doc, fields.slice(0, 200), user, 'metadata.extracted', warnings);
  await client.query('UPDATE documents SET extraction_key=$2 WHERE id=$1', [doc.id, extractionKey]);
}
