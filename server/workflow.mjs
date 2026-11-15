import { audit, requirePermission, text } from './auth.mjs';
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

export const submittedBatch = `EXISTS(SELECT 1 FROM documents submitted_document
  JOIN qc_reviews submitted_review ON submitted_review.document_id=submitted_document.id
    AND submitted_review.cycle=submitted_document.review_cycle
  WHERE submitted_document.batch_id=b.id AND submitted_review.submitted_at IS NOT NULL)`;

export async function requireSubmission(client, user, batch) {
  if (batch.assigned_operator_id === user.id || user.permissions.includes('batches:reassign'))
    return;
  const result = await client.query(
    `SELECT ${submittedBatch} AS submitted FROM archive_batches b WHERE b.id=$1`,
    [batch.id],
  );
  if (!result.rows[0]?.submitted)
    throw failure('not_submitted', 'This document has not been sent to QC.', 403);
}

export async function operatorEdit(client, user, batch) {
  requirePermission(user, 'batches:update');
  const doc = await documentFor(client, batch.id, true);
  if (batch.assigned_operator_id !== user.id)
    throw failure('forbidden', 'This batch is assigned to another operator.', 403);
  const states = ['capturing', 'rework', 'operator_preparation'];
  if (!doc || !states.includes(doc.workflow_status))
    throw failure(
      'document_locked',
      'This document has been sent to QC. Wait for a return before editing.',
      409,
    );
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

export async function setPageLabel(client, user, page, value) {
  const label = text(value, 120, 'Page label', true);
  await client.query('UPDATE pages SET page_label=$2,updated_at=now() WHERE id=$1', [
    page.id,
    label,
  ]);
  await audit(
    client,
    user,
    'page.renamed',
    'page',
    page.id,
    { customLabel: label !== null },
    page.batch_id,
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
        `SELECT 1 FROM audit_logs WHERE batch_id=$1 AND action='batch.reassigned'
      AND (metadata->>'from'=$2 OR metadata->>'to'=$2) LIMIT 1`,
        [batch.id, user.id],
      )
    ).rowCount ||
    (
      await client.query(
        'SELECT 1 FROM scan_sessions WHERE batch_id=$1 AND created_by=$2 LIMIT 1',
        [batch.id, user.id],
      )
    ).rowCount
  )
    throw failure(
      'self_qc',
      'You cannot review a document you captured, created or operated.',
      403,
    );
}

export async function qcOfficer(client, batch, id, lock = false) {
  const officer = (
    await client.query(
      `SELECT u.id,u.display_name,u.username FROM users u WHERE u.id=$1
    AND u.is_active AND u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id
      WHERE ur.user_id=u.id AND p.code='qc:review') ${lock ? 'FOR SHARE OF u' : ''}`,
      [id],
    )
  ).rows[0];
  if (!officer) throw failure('ineligible_officer', 'Choose an active QC officer.', 409);
  await independentReviewer(client, officer, batch);
  if (
    (
      await client.query(
        `SELECT 1 FROM approval_decisions a JOIN qc_reviews r ON r.id=a.qc_review_id
    JOIN documents d ON d.id=r.document_id WHERE d.batch_id=$1 AND a.decided_by=$2
    UNION ALL SELECT 1 FROM publication_withdrawals w JOIN documents d ON d.id=w.document_id
    WHERE d.batch_id=$1 AND w.taken_by=$2 LIMIT 1`,
        [batch.id, id],
      )
    ).rowCount
  )
    throw failure(
      'self_approval',
      'Previous approvers cannot become the QC officer for this document.',
      403,
    );
  return officer;
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
