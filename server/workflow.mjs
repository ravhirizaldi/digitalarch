import { requirePermission } from './auth.mjs';
import { failure } from './errors.mjs';

export function checkVersion(record, version) {
  if (!Number.isSafeInteger(version) || version !== record.version)
    throw failure('conflict', 'This document changed. Reload before continuing.', 409);
}

export async function documentFor(client, batchId, lock = false) {
  return (
    await client.query(
      `SELECT * FROM documents WHERE batch_id=$1 ORDER BY document_index LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
      [batchId],
    )
  ).rows[0];
}

export async function operatorEdit(client, user, batch, metadata = false) {
  requirePermission(user, 'batches:update');
  const doc = await documentFor(client, batch.id, true);
  if (batch.assigned_operator_id !== user.id)
    throw failure('forbidden', 'This batch is assigned to another operator.', 403);
  const states = metadata
    ? ['capturing', 'rework', 'preparing', 'qc_waiting']
    : ['capturing', 'rework'];
  if (!doc || !states.includes(doc.workflow_status))
    throw failure('document_locked', 'The document is locked by QC or has passed QC.', 409);
  return doc;
}

export async function bumpDocument(client, batchId) {
  await client.query(
    'UPDATE documents SET revision=revision+1,version=version+1,updated_at=now() WHERE batch_id=$1',
    [batchId],
  );
  await client.query(
    `UPDATE qc_reviews r SET ordering_reviewed=false,completeness_reviewed=false,
    metadata_reviewed=false WHERE document_id IN (SELECT id FROM documents WHERE batch_id=$1) AND outcome IS NULL`,
    [batchId],
  );
}

export async function noCapture(client, batchId) {
  if (
    (
      await client.query(
        `SELECT 1 FROM scan_sessions WHERE batch_id=$1 AND
    (status='running' OR recovery_pending OR replacement_status='pending')`,
        [batchId],
      )
    ).rowCount
  )
    throw failure(
      'capture_pending',
      'Finish capture, reconciliation and replacement confirmation first.',
      409,
    );
}

export async function independentReviewer(client, user, batch) {
  if (
    batch.created_by === user.id ||
    batch.assigned_operator_id === user.id ||
    (
      await client.query(
        'SELECT 1 FROM scan_sessions WHERE batch_id=$1 AND created_by=$2 LIMIT 1',
        [batch.id, user.id],
      )
    ).rowCount
  )
    throw failure(
      'self_qc',
      'You cannot QC a document you captured, created or currently operate.',
      403,
    );
}

export async function activeReview(client, doc, user) {
  requirePermission(user, 'qc:review');
  const review = (
    await client.query(
      `SELECT *,claim_expires_at>now() AS claim_live FROM qc_reviews
    WHERE document_id=$1 AND cycle=$2 FOR UPDATE`,
      [doc.id, doc.review_cycle],
    )
  ).rows[0];
  if (
    doc.workflow_status !== 'qc_in_review' ||
    !review?.claim_live ||
    review.claimed_by !== user.id
  )
    throw failure(
      'claim_required',
      'Claim this document before editing. Expired claims must be renewed.',
      409,
    );
  await client.query(
    "UPDATE qc_reviews SET claim_expires_at=now()+interval '30 minutes',updated_at=now() WHERE id=$1",
    [review.id],
  );
  return review;
}

export const publicPage = (page) =>
  Object.fromEntries(
    Object.entries(page).filter(
      ([key]) => !['original_storage_key', 'active_storage_key', 'storage_key'].includes(key),
    ),
  );
