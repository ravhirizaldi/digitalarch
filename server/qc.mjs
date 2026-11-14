import { audit, keys, requirePermission, text, uuid } from './auth.mjs';
import { transaction } from './db.mjs';
import { failure } from './errors.mjs';
import {
  activeReview,
  checkVersion,
  documentFor,
  independentReviewer,
  noCapture,
  operatorEdit,
  bumpDocument,
  publicPage,
} from './workflow.mjs';
import {
  currentOcr,
  editedFields,
  extractDocument,
  fieldsOf,
  metadataOf,
  persistMetadata,
  documentMetadataTypes,
} from './qc-metadata.mjs';

export const findingCategories = [
  'blurred_page',
  'cropped_page',
  'incorrect_orientation',
  'incorrect_order',
  'missing_page',
  'duplicate_page',
  'suspected_blank_page',
  'unreadable_text',
  'ocr_error',
  'metadata_error',
  'incomplete_document',
  'other',
];

export function qualityControl(pool, storage) {
  async function load(client, user, batchId, lock = false) {
    uuid(batchId);
    const batch = (
      await client.query(
        `SELECT b.*,u.display_name AS assigned_operator FROM archive_batches b
      LEFT JOIN users u ON u.id=b.assigned_operator_id WHERE b.id=$1 AND b.deleted_at IS NULL ${lock ? 'FOR UPDATE OF b' : ''}`,
        [batchId],
      )
    ).rows[0];
    if (!batch) throw failure('not_found', 'Batch not found.', 404);
    if (
      !user.permissions.includes('qc:read') &&
      !(user.permissions.includes('batches:read') && batch.assigned_operator_id === user.id)
    )
      throw failure('forbidden', 'You cannot access this document.', 403);
    const doc = await documentFor(client, batchId, lock);
    return { batch, doc };
  }
  async function change(user, batchId, body, operation, qc = true) {
    return transaction(pool, async (client) => {
      const { batch, doc } = await load(client, user, batchId, true);
      checkVersion(doc, body.version);
      let review;
      if (qc) {
        await independentReviewer(client, user, batch);
        review = await activeReview(client, doc, user);
      } else await operatorEdit(client, user, batch, true);
      const result = await operation(client, batch, doc, review);
      await client.query('UPDATE documents SET version=version+1,updated_at=now() WHERE id=$1', [
        doc.id,
      ]);
      await client.query(
        'UPDATE archive_batches SET version=version+1,updated_at=now() WHERE id=$1',
        [batchId],
      );
      return result || { saved: true };
    });
  }
  const api = {
    async queue(
      user,
      {
        filter = 'waiting',
        search = '',
        metadata = '',
        ocr = '',
        sort = 'updated_at',
        direction = 'desc',
        limit = 25,
        offset = 0,
      },
    ) {
      requirePermission(user, 'qc:read');
      if (
        !['all', 'waiting', 'review', 'returned', 'passed', 'ocr_incomplete', 'mine'].includes(
          filter,
        )
      )
        throw failure('invalid_request', 'Invalid QC queue filter.');
      if (search.length > 240) throw failure('invalid_request', 'Search is too long.');
      if (
        ![
          '',
          'pending',
          'not_extracted',
          'needs_review',
          'manually_corrected',
          'verified',
        ].includes(metadata) ||
        ![
          '',
          'not_queued',
          'queued',
          'running',
          'paused',
          'completed',
          'completed_with_errors',
          'failed',
          'cancelled',
        ].includes(ocr)
      )
        throw failure('invalid_request', 'Invalid metadata or OCR filter.');
      const columns = {
        updated_at: 'b.updated_at',
        created_at: 'b.created_at',
        title: 'd.title',
        page_count: 'page_count',
        session_count: 'session_count',
        metadata_status: 'd.metadata_status',
        ocr_status: 'b.ocr_status',
        workflow_status: 'd.workflow_status',
        assigned_operator: 'u.display_name',
      };
      if (!Object.hasOwn(columns, sort) || !['asc', 'desc'].includes(direction))
        throw failure('invalid_request', 'Invalid QC queue sort.');
      const where = `WHERE b.deleted_at IS NULL AND d.review_cycle>0 AND
        CASE $1 WHEN 'all' THEN true WHEN 'waiting' THEN d.workflow_status='qc_waiting' OR (d.workflow_status='qc_in_review' AND r.claim_expires_at<=now())
          WHEN 'review' THEN d.workflow_status='qc_in_review' WHEN 'returned' THEN d.workflow_status='rework'
          WHEN 'passed' THEN d.workflow_status='awaiting_approval_l1'
          WHEN 'mine' THEN r.claimed_by=$2 AND r.outcome IS NULL
          ELSE d.workflow_status='preparing' OR coalesce(b.ocr_status,'')<>'completed' END
        AND ($3='' OR strpos(lower(concat_ws(' ',b.batch_code,d.title,d.document_type,d.archive_number,b.physical_location,u.display_name)),lower($3))>0)
        AND ($4='' OR d.metadata_status=$4)
        AND ($5='' OR coalesce(b.ocr_status,'not_queued')=$5)`;
      const from = `FROM documents d JOIN archive_batches b ON b.id=d.batch_id
        LEFT JOIN users u ON u.id=b.assigned_operator_id
        LEFT JOIN qc_reviews r ON r.document_id=d.id AND r.cycle=d.review_cycle`;
      const args = [filter, user.id, search, metadata, ocr];
      return transaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const rows = (
          await client.query(
            `SELECT d.id AS document_id,d.title,d.document_type,d.metadata_status,d.workflow_status,
         b.id,b.batch_code,b.ocr_status,b.created_at,b.updated_at,u.display_name AS assigned_operator,r.claimed_by,r.claim_expires_at,
        (SELECT count(*)::int FROM pages p WHERE p.batch_id=b.id AND NOT p.is_excluded AND NOT p.replacement_candidate) AS page_count,
        (SELECT count(*)::int FROM scan_sessions s WHERE s.batch_id=b.id) AS session_count
         ${from} ${where} ORDER BY ${columns[sort]} ${direction.toUpperCase()} NULLS LAST,b.id LIMIT $6 OFFSET $7`,
            [...args, limit, offset],
          )
        ).rows;
        const matched = (
          await client.query(
            `SELECT count(*)::int AS total,
        coalesce(sum((SELECT count(*) FROM pages p WHERE p.batch_id=b.id AND NOT p.is_excluded AND NOT p.replacement_candidate)),0)::int AS pages,
        coalesce(sum((SELECT count(*) FROM scan_sessions s WHERE s.batch_id=b.id)),0)::int AS sessions
        ${from} ${where}`,
            args,
          )
        ).rows[0];
        const counts = (
          await client.query(
            `SELECT count(*)::int AS "all",
        count(*) FILTER(WHERE d.workflow_status='qc_waiting' OR (d.workflow_status='qc_in_review' AND r.claim_expires_at<=now()))::int AS waiting,
        count(*) FILTER(WHERE d.workflow_status='qc_in_review')::int AS review,
        count(*) FILTER(WHERE d.workflow_status='rework')::int AS returned,
        count(*) FILTER(WHERE d.workflow_status='awaiting_approval_l1')::int AS passed,
        count(*) FILTER(WHERE d.workflow_status='preparing' OR coalesce(b.ocr_status,'')<>'completed')::int AS ocr_incomplete,
        count(*) FILTER(WHERE r.claimed_by=$1 AND r.outcome IS NULL)::int AS mine
        ${from} WHERE b.deleted_at IS NULL AND d.review_cycle>0`,
            [user.id],
          )
        ).rows[0];
        return { batches: rows, ...matched, counts };
      });
    },
    async get(user, batchId) {
      return transaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { batch, doc } = await load(client, user, batchId);
        const pages = (
          await client.query(
            `SELECT p.*,s.session_number,pr.status AS review_status,pr.image_revision AS reviewed_image_revision,
          r.status AS ocr_status,r.id AS result_id,r.image_revision AS ocr_image_revision
          FROM pages p JOIN scan_sessions s ON s.id=p.scan_session_id
          LEFT JOIN qc_reviews review ON review.document_id=$2 AND review.cycle=$3
          LEFT JOIN qc_page_reviews pr ON pr.review_id=review.id AND pr.page_id=p.id
          LEFT JOIN LATERAL (SELECT r.* FROM page_ocr_results r JOIN ocr_jobs j ON j.id=r.ocr_job_id
            WHERE r.page_id=p.id AND NOT r.is_stale AND r.image_revision=p.image_revision
            ORDER BY j.created_at DESC,j.id DESC LIMIT 1) r ON true
          WHERE p.batch_id=$1 ORDER BY p.display_order,p.capture_order`,
            [batchId, doc.id, doc.review_cycle],
          )
        ).rows.map(publicPage);
        const reviews = (
          await client.query(
            `SELECT r.*,u.display_name AS reviewer FROM qc_reviews r
          LEFT JOIN users u ON u.id=coalesce(r.decided_by,r.claimed_by) WHERE document_id=$1 ORDER BY cycle DESC`,
            [doc.id],
          )
        ).rows;
        const findings = (
          await client.query('SELECT * FROM qc_findings WHERE document_id=$1 ORDER BY created_at', [
            doc.id,
          ])
        ).rows;
        const sessions = (
          await client.query(
            `SELECT id,session_number,status,page_count,replacement_target,replacement_status
          FROM scan_sessions WHERE batch_id=$1 ORDER BY session_number`,
            [batchId],
          )
        ).rows;
        const history = (
          await client.query(
            `SELECT a.action,a.created_at,a.metadata,u.display_name AS actor
          FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE batch_id=$1 ORDER BY a.created_at DESC LIMIT 200`,
            [batchId],
          )
        ).rows;
        return {
          batch,
          document: doc,
          metadata: metadataOf(doc),
          pages,
          reviews,
          findings,
          sessions,
          history,
        };
      });
    },
    async claim(user, batchId, body) {
      keys(body, ['version']);
      requirePermission(user, 'qc:review');
      return transaction(pool, async (client) => {
        const { batch, doc } = await load(client, user, batchId, true);
        checkVersion(doc, body.version);
        await independentReviewer(client, user, batch);
        await noCapture(client, batchId);
        if (!['qc_waiting', 'qc_in_review'].includes(doc.workflow_status))
          throw failure('workflow_locked', 'The document is not ready for QC.', 409);
        const review = (
          await client.query(
            `SELECT *,claim_expires_at>now() AS claim_live FROM qc_reviews
          WHERE document_id=$1 AND cycle=$2 FOR UPDATE`,
            [doc.id, doc.review_cycle],
          )
        ).rows[0];
        if (review.claimed_by && review.claimed_by !== user.id && review.claim_live)
          throw failure('already_claimed', 'Another QC Officer is reviewing this document.', 409);
        await client.query(
          `UPDATE qc_reviews SET claimed_by=$2,claimed_at=now(),claim_expires_at=now()+interval '30 minutes',updated_at=now() WHERE id=$1`,
          [review.id, user.id],
        );
        await client.query(
          "UPDATE documents SET workflow_status='qc_in_review',version=version+1,updated_at=now() WHERE id=$1",
          [doc.id],
        );
        await client.query(
          'UPDATE archive_batches SET version=version+1,updated_at=now() WHERE id=$1',
          [batchId],
        );
        await audit(
          client,
          user,
          'qc.claimed',
          'document',
          doc.id,
          { cycle: doc.review_cycle, previousClaim: review.claimed_by },
          batchId,
        );
        return { claimed: true };
      });
    },
    async release(user, batchId, body, administrative = false) {
      keys(body, administrative ? ['version', 'reason'] : ['version']);
      return transaction(pool, async (client) => {
        const { batch, doc } = await load(client, user, batchId, true);
        checkVersion(doc, body.version);
        if (administrative) {
          requirePermission(user, 'qc:reassign');
          text(body.reason, 1000, 'Reassignment reason');
          if (doc.workflow_status !== 'qc_in_review')
            throw failure('workflow_locked', 'No active review.', 409);
        } else {
          await independentReviewer(client, user, batch);
          await activeReview(client, doc, user);
        }
        await client.query(
          'UPDATE qc_reviews SET claimed_by=NULL,claim_expires_at=NULL,updated_at=now() WHERE document_id=$1 AND cycle=$2',
          [doc.id, doc.review_cycle],
        );
        await client.query(
          "UPDATE documents SET workflow_status='qc_waiting',version=version+1,updated_at=now() WHERE id=$1",
          [doc.id],
        );
        await client.query(
          'UPDATE archive_batches SET version=version+1,updated_at=now() WHERE id=$1',
          [batchId],
        );
        await audit(
          client,
          user,
          administrative ? 'qc.reassigned' : 'qc.released',
          'document',
          doc.id,
          { cycle: doc.review_cycle, reason: body.reason },
          batchId,
        );
        return { released: true };
      });
    },
    async heartbeat(user, batchId, body) {
      keys(body, ['version']);
      return change(user, batchId, body, async () => ({ renewed: true }));
    },
    async metadata(user, batchId, body, extract = false) {
      if (body === undefined) {
        const { doc } = await load(pool, user, batchId);
        return { metadata: metadataOf(doc) };
      }
      await transaction(pool, async (client) => {
        const { batch, doc } = await load(client, user, batchId, true);
        const qc = doc.workflow_status === 'qc_in_review';
        if (qc) {
          await independentReviewer(client, user, batch);
          await activeReview(client, doc, user);
        } else await operatorEdit(client, user, batch, true);
        if (extract) {
          keys(body, ['version']);
          if (body.version !== doc.metadata_version)
            throw failure('conflict', 'Metadata changed. Reload first.', 409);
          if (
            !(await currentOcr(client, batchId, { includeText: false })).some(
              (page) => page.status === 'completed',
            )
          )
            throw failure(
              'metadata_empty',
              'No current completed OCR pages are available to extract.',
              409,
            );
          await extractDocument(client, doc, user);
        } else {
          const fields = editedFields(doc, body, user, qc);
          await persistMetadata(
            client,
            doc,
            fields,
            user,
            qc && fields.every((f) => f.verification === 'verified')
              ? 'metadata.verified'
              : 'metadata.updated',
          );
          await client.query(
            'UPDATE qc_reviews SET metadata_reviewed=false WHERE document_id=$1 AND outcome IS NULL',
            [doc.id],
          );
        }
        await client.query(
          'UPDATE archive_batches SET updated_at=now(),version=version+1 WHERE id=$1',
          [batchId],
        );
      });
      return api.metadata(user, batchId);
    },
    async policy(user, batchId, body) {
      requirePermission(user, 'qc:configure');
      keys(body, ['version', 'requiredMetadata']);
      if (
        !Array.isArray(body.requiredMetadata) ||
        body.requiredMetadata.some((type) => !documentMetadataTypes.includes(type))
      )
        throw failure('invalid_request', 'Choose supported required metadata fields.');
      return transaction(pool, async (client) => {
        const { doc } = await load(client, user, batchId, true);
        checkVersion(doc, body.version);
        if (['qc_in_review', 'awaiting_approval_l1'].includes(doc.workflow_status))
          throw failure('document_locked', 'Policy cannot change during or after QC.', 409);
        await client.query(
          'UPDATE documents SET required_metadata=$2,version=version+1,revision=revision+1 WHERE id=$1',
          [doc.id, [...new Set(body.requiredMetadata)]],
        );
        await audit(
          client,
          user,
          'metadata.policy_updated',
          'document',
          doc.id,
          { requiredTypes: body.requiredMetadata },
          batchId,
        );
        return { saved: true };
      });
    },
    async save(user, batchId, body) {
      keys(body, [
        'version',
        'orderingReviewed',
        'completenessReviewed',
        'metadataReviewed',
        'notes',
        'ocrException',
      ]);
      for (const key of ['orderingReviewed', 'completenessReviewed', 'metadataReviewed'])
        if (typeof body[key] !== 'boolean')
          throw failure('invalid_request', 'Checklist values must be boolean.');
      const notes = text(body.notes, 4000, 'Review notes', true) || '';
      const exception = text(body.ocrException, 2000, 'OCR exception', true);
      return change(user, batchId, body, async (client, batch, doc, review) => {
        await client.query(
          `UPDATE qc_reviews SET ordering_reviewed=$2,completeness_reviewed=$3,metadata_reviewed=$4,
          notes=$5,ocr_exception=$6,updated_at=now() WHERE id=$1`,
          [
            review.id,
            body.orderingReviewed,
            body.completenessReviewed,
            body.metadataReviewed,
            notes,
            exception,
          ],
        );
        await audit(
          client,
          user,
          'qc.saved',
          'document',
          doc.id,
          { cycle: doc.review_cycle, revision: doc.revision },
          batch.id,
        );
      });
    },
    async finding(user, batchId, body) {
      keys(body, [
        'version',
        'id',
        'pageIds',
        'metadataFieldId',
        'category',
        'severity',
        'description',
        'status',
        'resolutionNote',
      ]);
      return change(user, batchId, body, async (client, batch, doc, review) => {
        const ids = body.pageIds || [];
        if (!Array.isArray(ids) || ids.length > 500)
          throw failure('invalid_request', 'Invalid finding page range.');
        ids.forEach(uuid);
        if (
          (
            await client.query('SELECT id FROM pages WHERE batch_id=$1 AND id=ANY($2::uuid[])', [
              batchId,
              ids,
            ])
          ).rowCount !== new Set(ids).size
        )
          throw failure('invalid_request', 'Finding pages must belong to this document.');
        if (body.metadataFieldId && !fieldsOf(doc).some((f) => f.id === body.metadataFieldId))
          throw failure('invalid_request', 'Metadata field not found.');
        if (
          !findingCategories.includes(body.category) ||
          !['minor', 'major', 'critical'].includes(body.severity)
        )
          throw failure('invalid_request', 'Invalid finding category or severity.');
        const description = text(body.description, 2000, 'Finding description');
        const status = body.status || 'open';
        if (!['open', 'in_progress', 'resolved', 'waived'].includes(status))
          throw failure('invalid_request', 'Invalid finding status.');
        const resolved = ['resolved', 'waived'].includes(status);
        const note = text(body.resolutionNote ?? '', 2000, 'Resolution note', !resolved);
        if (body.id) {
          uuid(body.id);
          if (
            !(
              await client.query(
                `UPDATE qc_findings SET page_ids=$3,metadata_field_id=$4,category=$5,severity=$6,description=$7,status=$8,
            resolution_note=$9,resolved_by=$10,resolved_at=CASE WHEN $10::uuid IS NULL THEN NULL ELSE now() END,updated_at=now()
            WHERE id=$1 AND document_id=$2 RETURNING id`,
                [
                  body.id,
                  doc.id,
                  ids,
                  body.metadataFieldId || null,
                  body.category,
                  body.severity,
                  description,
                  status,
                  note,
                  resolved ? user.id : null,
                ],
              )
            ).rowCount
          )
            throw failure('not_found', 'Finding not found.', 404);
        } else
          await client.query(
            `INSERT INTO qc_findings(document_id,review_id,page_ids,metadata_field_id,category,severity,description,status,resolution_note,created_by,resolved_by,resolved_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11::uuid IS NULL THEN NULL ELSE now() END)`,
            [
              doc.id,
              review.id,
              ids,
              body.metadataFieldId || null,
              body.category,
              body.severity,
              description,
              status,
              note,
              user.id,
              resolved ? user.id : null,
            ],
          );
        await audit(
          client,
          user,
          'qc.finding_updated',
          'document',
          doc.id,
          { cycle: doc.review_cycle, category: body.category, status, pageIds: ids },
          batchId,
        );
      });
    },
    async pageReview(user, batchId, body) {
      keys(body, ['version', 'pageIds', 'status']);
      if (
        !Array.isArray(body.pageIds) ||
        !body.pageIds.length ||
        body.pageIds.length > 500 ||
        !['reviewed', 'needs_correction'].includes(body.status)
      )
        throw failure('invalid_request', 'Select pages and a review status.');
      body.pageIds.forEach(uuid);
      return change(user, batchId, body, async (client, batch, doc, review) => {
        const pages = (
          await client.query(
            'SELECT id,image_revision FROM pages WHERE batch_id=$1 AND id=ANY($2::uuid[]) AND NOT replacement_candidate',
            [batchId, body.pageIds],
          )
        ).rows;
        if (pages.length !== new Set(body.pageIds).size)
          throw failure('invalid_request', 'Invalid review pages.');
        for (const page of pages)
          await client.query(
            `INSERT INTO qc_page_reviews(review_id,page_id,status,image_revision,reviewed_by) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(review_id,page_id) DO UPDATE SET status=EXCLUDED.status,image_revision=EXCLUDED.image_revision,reviewed_by=EXCLUDED.reviewed_by,reviewed_at=now()`,
            [review.id, page.id, body.status, page.image_revision, user.id],
          );
        await audit(
          client,
          user,
          'page.reviewed',
          'document',
          doc.id,
          { pageIds: body.pageIds, status: body.status, explicitBulk: pages.length > 1 },
          batchId,
        );
      });
    },
    async pageInfo(user, batchId, pageId) {
      await load(pool, user, batchId);
      uuid(pageId);
      const page = (
        await pool.query('SELECT * FROM pages WHERE batch_id=$1 AND id=$2', [batchId, pageId])
      ).rows[0];
      if (!page) throw failure('not_found', 'Page not found.', 404);
      const results = await currentOcr(pool, batchId, { pageId });
      const revisions = (
        await pool.query(
          `SELECT id,sha256,rotation_degrees,created_by,created_at,metadata FROM page_revisions WHERE page_id=$1 ORDER BY created_at`,
          [pageId],
        )
      ).rows;
      return { page: publicPage(page), ocr: results[0] || null, revisions };
    },
    async revisionImage(user, batchId, pageId, revisionId, size) {
      await load(pool, user, batchId);
      uuid(pageId);
      uuid(revisionId);
      const revision = (
        await pool.query(
          `SELECT r.* FROM page_revisions r JOIN pages p ON p.id=r.page_id
        WHERE r.id=$1 AND r.page_id=$2 AND p.batch_id=$3`,
          [revisionId, pageId, batchId],
        )
      ).rows[0];
      if (!revision) throw failure('not_found', 'Image revision not found.', 404);
      await storage.ocrImage({ storage_key: revision.storage_key, image_sha256: revision.sha256 });
      return {
        file:
          size === 'image'
            ? await storage.open(revision.storage_key)
            : await storage.derivative({ active_storage_key: revision.storage_key }, 'preview'),
        mime: size === 'image' ? 'image/png' : 'image/webp',
      };
    },
    async correctText(user, batchId, body) {
      keys(body, ['version', 'resultId', 'text']);
      uuid(body.resultId);
      if (typeof body.text !== 'string' || body.text.length > 2_000_000)
        throw failure('invalid_request', 'Invalid corrected text.');
      return change(user, batchId, body, async (client, batch, doc) => {
        const result = (
          await client.query(
            `SELECT r.id,r.page_id FROM page_ocr_results r JOIN pages p ON p.id=r.page_id
          WHERE r.id=$1 AND p.batch_id=$2 AND r.status='completed' AND NOT r.is_stale AND r.image_revision=p.image_revision`,
            [body.resultId, batchId],
          )
        ).rows[0];
        if (!result)
          throw failure('stale_ocr', 'Only a current completed OCR result may be corrected.', 409);
        const current = await currentOcr(client, batchId, {
          pageId: result.page_id,
          includeText: false,
        });
        if (current[0]?.result_id !== result.id)
          throw failure('stale_ocr', 'A newer OCR run exists. Reload this page.', 409);
        await client.query(
          'INSERT INTO ocr_text_corrections(result_id,corrected_text,created_by) VALUES($1,$2,$3)',
          [result.id, body.text, user.id],
        );
        await client.query(
          'UPDATE documents SET extraction_key=NULL,revision=revision+1 WHERE id=$1',
          [doc.id],
        );
        await extractDocument(client, { ...doc, extraction_key: null }, user);
        await audit(
          client,
          user,
          'ocr.text_corrected',
          'document',
          doc.id,
          { resultId: result.id },
          batchId,
        );
      });
    },
    async reprocess(user, batchId, body) {
      keys(body, ['version', 'requestId']);
      uuid(body.requestId);
      return change(user, batchId, body, async (client, batch, doc) => {
        await noCapture(client, batchId);
        const job = (
          await client.query('SELECT queue_batch_ocr($1,NULL,NULL,$2) AS id', [
            batchId,
            `qc:${body.requestId}`,
          ])
        ).rows[0].id;
        if (!job)
          throw failure('empty_batch', 'Include at least one page before requesting OCR.', 409);
        await audit(
          client,
          user,
          'ocr.reprocessed',
          'document',
          doc.id,
          { jobId: job, cycle: doc.review_cycle },
          batchId,
        );
        return { jobId: job };
      });
    },
    async pageEdit(user, batchId, body) {
      keys(body, ['version', 'pageId', 'action', 'beforePageId']);
      uuid(body.pageId);
      return change(user, batchId, body, async (client, batch, doc) => {
        await noCapture(client, batchId);
        const page = (
          await client.query(
            'SELECT * FROM pages WHERE id=$1 AND batch_id=$2 AND NOT replacement_candidate',
            [body.pageId, batchId],
          )
        ).rows[0];
        if (!page) throw failure('not_found', 'Page not found.', 404);
        if (body.action === 'reorder') {
          const ids = (
            await client.query(
              'SELECT id FROM pages WHERE batch_id=$1 ORDER BY display_order,capture_order',
              [batchId],
            )
          ).rows
            .map((p) => p.id)
            .filter((id) => id !== page.id);
          const position =
            body.beforePageId == null ? ids.length : ids.indexOf(uuid(body.beforePageId));
          if (position < 0) throw failure('invalid_request', 'Destination page not found.');
          ids.splice(position, 0, page.id);
          await client.query(
            `UPDATE pages p SET display_order=x.n FROM unnest($1::uuid[]) WITH ORDINALITY x(id,n) WHERE p.id=x.id`,
            [ids],
          );
        } else {
          if (
            !['rotate-left', 'rotate-right', 'reset-rotation', 'exclude', 'restore'].includes(
              body.action,
            )
          )
            throw failure('invalid_request', 'Invalid page operation.');
          const rotation =
            body.action === 'reset-rotation'
              ? 0
              : (page.rotation_degrees +
                  (body.action === 'rotate-left' ? 270 : body.action === 'rotate-right' ? 90 : 0)) %
                360;
          const excluded =
            body.action === 'exclude' ? true : body.action === 'restore' ? false : page.is_excluded;
          await client.query(
            'UPDATE pages SET rotation_degrees=$2,is_excluded=$3,updated_at=now() WHERE id=$1',
            [page.id, rotation, excluded],
          );
        }
        await bumpDocument(client, batchId);
        await extractDocument(client, await documentFor(client, batchId), user);
        await audit(
          client,
          user,
          `page.${body.action === 'reorder' ? 'reordered' : body.action === 'exclude' ? 'excluded' : body.action === 'restore' ? 'restored' : 'rotated'}`,
          'page',
          page.id,
          { cycle: doc.review_cycle, beforePageId: body.beforePageId, action: body.action },
          batchId,
        );
      });
    },
    async decision(user, batchId, body, pass) {
      keys(body, ['version', 'reason']);
      requirePermission(user, pass ? 'qc:submit' : 'qc:return');
      const reason = text(body.reason ?? '', 2000, pass ? 'Decision note' : 'Return reason', pass);
      return change(user, batchId, body, async (client, batch, doc, review) => {
        await noCapture(client, batchId);
        const pages = (
          await client.query(
            'SELECT * FROM pages WHERE batch_id=$1 AND NOT is_excluded AND NOT replacement_candidate ORDER BY display_order,capture_order',
            [batchId],
          )
        ).rows;
        if (pass) {
          if (!pages.length)
            throw failure('qc_incomplete', 'At least one included page is required.', 409);
          if (
            (
              await client.query(
                "SELECT 1 FROM ocr_jobs WHERE batch_id=$1 AND status IN ('queued','running','paused') LIMIT 1",
                [batchId],
              )
            ).rowCount
          )
            throw failure(
              'qc_incomplete',
              'Finish or cancel outstanding OCR jobs before passing QC.',
              409,
            );
          if (
            !review.ordering_reviewed ||
            !review.completeness_reviewed ||
            !review.metadata_reviewed
          )
            throw failure(
              'qc_incomplete',
              'Save the ordering, completeness and metadata checklist first.',
              409,
            );
          if (
            (
              await client.query(
                "SELECT 1 FROM qc_findings WHERE document_id=$1 AND severity='critical' AND status NOT IN ('resolved','waived')",
                [doc.id],
              )
            ).rowCount
          )
            throw failure(
              'qc_incomplete',
              'Resolve or explicitly waive critical findings first.',
              409,
            );
          if (
            (
              await client.query(
                `SELECT 1 FROM qc_page_reviews pr JOIN pages p ON p.id=pr.page_id
            WHERE pr.review_id=$1 AND pr.status='needs_correction' AND NOT p.is_excluded`,
                [review.id],
              )
            ).rowCount
          )
            throw failure(
              'qc_incomplete',
              'Pages marked as needing correction must be reviewed again.',
              409,
            );
          const fields = fieldsOf(doc);
          if (
            fields.some((f) => f.verification !== 'verified') ||
            doc.required_metadata.some(
              (type) =>
                !fields.some(
                  (f) => f.type === type && f.value.trim() && f.verification === 'verified',
                ),
            )
          )
            throw failure(
              'qc_incomplete',
              'Verify all metadata fields and supply required policy fields first.',
              409,
            );
          const ocr = await currentOcr(client, batchId, { includeText: false });
          if (ocr.some((p) => p.status !== 'completed') && !review.ocr_exception)
            throw failure(
              'qc_incomplete',
              'Current OCR is incomplete. Resolve it or save an explicit QC exception.',
              409,
            );
          for (const page of pages) {
            await storage.validate(page);
            await storage.ocrImage({
              storage_key: page.active_storage_key,
              image_sha256: page.active_image_sha256,
            });
          }
        }
        const effectiveOcr = await currentOcr(client, batchId, { includeText: false });
        const snapshot = {
          revision: doc.revision,
          metadata: metadataOf(doc),
          pages: pages.map(publicPage),
          findings: (
            await client.query(
              'SELECT * FROM qc_findings WHERE document_id=$1 ORDER BY created_at',
              [doc.id],
            )
          ).rows,
          pageReviews: (
            await client.query('SELECT * FROM qc_page_reviews WHERE review_id=$1', [review.id])
          ).rows,
          ocr: effectiveOcr.map(
            ({ page_id, result_id, image_revision, correction_id, status }) => ({
              page_id,
              result_id,
              image_revision,
              correction_id,
              status,
            }),
          ),
        };
        await client.query(
          `UPDATE qc_reviews SET outcome=$2,decision_reason=$3,decided_by=$4,decided_at=now(),
          reviewed_revision=$5,snapshot=$6,claimed_by=NULL,claim_expires_at=NULL,updated_at=now() WHERE id=$1`,
          [
            review.id,
            pass ? 'passed' : 'returned',
            reason,
            user.id,
            doc.revision,
            JSON.stringify(snapshot),
          ],
        );
        await client.query('UPDATE documents SET workflow_status=$2 WHERE id=$1', [
          doc.id,
          pass ? 'awaiting_approval_l1' : 'rework',
        ]);
        if (!pass)
          await client.query(
            "UPDATE archive_batches SET status='paused',paused_at=now() WHERE id=$1",
            [batchId],
          );
        await audit(
          client,
          user,
          pass ? 'qc.passed' : 'qc.returned',
          'document',
          doc.id,
          { cycle: doc.review_cycle, revision: doc.revision, reason },
          batchId,
        );
      });
    },
    async refresh() {
      const documents = (
        await pool.query(`SELECT d.batch_id FROM documents d JOIN archive_batches b ON b.id=d.batch_id
        WHERE b.status='capture_completed' AND b.deleted_at IS NULL AND d.workflow_status IN ('preparing','qc_waiting','qc_in_review')
        AND EXISTS(SELECT 1 FROM ocr_jobs j WHERE j.batch_id=b.id)`)
      ).rows;
      for (const row of documents)
        await transaction(pool, async (client) => {
          await client.query('SELECT id FROM archive_batches WHERE id=$1 FOR UPDATE', [
            row.batch_id,
          ]);
          const doc = await documentFor(client, row.batch_id, true);
          if (!['preparing', 'qc_waiting', 'qc_in_review'].includes(doc.workflow_status)) return;
          const job = (
            await client.query(
              'SELECT status FROM ocr_jobs WHERE batch_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
              [row.batch_id],
            )
          ).rows[0];
          if (['queued', 'running', 'paused'].includes(job?.status)) return;
          await extractDocument(client, doc);
          if (doc.workflow_status === 'preparing') {
            await client.query(
              "UPDATE documents SET workflow_status='qc_waiting',version=version+1,updated_at=now() WHERE id=$1",
              [doc.id],
            );
            await audit(
              client,
              null,
              'qc.ready',
              'document',
              doc.id,
              { cycle: doc.review_cycle },
              row.batch_id,
            );
          }
        });
    },
  };
  return api;
}
